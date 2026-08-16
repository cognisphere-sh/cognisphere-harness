---
name: publish-harness
description: Publish a new version of the @cognisphere-sh/cognisphere-harness library to GitHub Packages. Covers the bump, the CHANGELOG section (including the shipped-artifact rule for agent/plugin seeds and deploy-time wiring), preflight, tag and release. Use when asked to "publish the harness", "release a new version", "cut a release", "bump and publish" or "ship the library" — and whenever merged changes need to reach existing homes, since agent/plugin seeds, home-template and .claude/skills only travel to a home through a published version. (v1.1.0)
metadata:
  author: cognisphere
  version: "1.1.0"
  argument-hint: <new-version e.g. 0.3.0>
---

# Publish the CogniSphere harness

Publishes `@cognisphere-sh/cognisphere-harness` (the backend library, in
`packages/harness/`) to **GitHub Packages**. Paths below are relative to the
**repo root**.

The actual `pnpm publish` runs **in CI** (`.github/workflows/publish.yml`),
triggered when you publish a **GitHub Release**. You never publish from your
laptop. The flow is: bump → write CHANGELOG → **preflight** (this skill's
driver) → commit → tag → `gh release create` → CI publishes.

## Run (agent path): preflight first

The driver runs every gate CI runs — version/CHANGELOG/tag consistency,
`pnpm check`, and `pnpm pack` (which exercises `prepack`: builds the web UI into
`dist-web/` and bundles `CHANGELOG.md`) — **locally, without touching the
registry**. It reads files and deletes its own tarball; it never bumps the
version for you.

```bash
node .claude/skills/publish-harness/preflight.mjs
```

Green run ends with `PREFLIGHT PASSED` and prints the exact tag + release
commands. A red run lists `✗` items to fix. The web build is real (~2s, Vite,
2394 modules) — expect a wall of build output.

## Procedure

### 1. Bump the version

Edit `packages/harness/package.json` `"version"` to the new SemVer (e.g.
`0.3.0`). The git tag will be `v<version>`; CI publishes whatever version the
manifest carries.

### 2. Write the CHANGELOG section

Add `## [<version>]` at the top of the version list in `CHANGELOG.md` (repo
root). If the release changes a harness's on-disk artifacts, include a
`### Breaking changes` block — the **upgrade skill** parses it
(`- <what changed>   [affects: <path glob>]`). See the file's own header.

**Shipped-artifact rule** — diff since the last release
(`git diff --name-only $(git describe --tags --abbrev=0)`) and reflect every
hit in the section:

- `packages/harness/src/agents/**` or `packages/harness/src/plugins/*/seed/**`
  (files forked into agent dirs at create time) → each change needs a
  `### Breaking changes` entry with an `[affects:]` glob — that's the only way
  the upgrade skill reaches existing forks. **Preflight fails without the
  block.** A *brand-new* plugin has no existing forks to migrate, but preflight
  can't tell one from a changed seed: still write the block, and make the entry
  say how to opt in (e.g. `- New \`artifacts\` plugin — enable per agent
  [affects: agents/*/plugins/artifacts/]`), so an operator reading the upgrade
  sees the new capability rather than a no-op.
- Deploy-time wiring (`home-template/scripts/server.sh`,
  `home-template/config.example`) → note the new `config` keys under
  `### Changed`; the upgrade skill refreshes both files wholesale, but an
  operator has to add the keys to their own `config` for anything to happen.
- `packages/harness/home-template/**` or `.claude/skills/**` → note under
  `### Changed`; the upgrade skill refreshes these wholesale from the
  installed package, so the note is for the operator reviewing the upgrade
  diff, not machine-parsed.

### 3. Preflight

```bash
node .claude/skills/publish-harness/preflight.mjs
```

Fix every `✗` until it says `PREFLIGHT PASSED`.

### 4. Commit, tag, release

The preflight prints these with the version filled in:

```bash
git add packages/harness/package.json CHANGELOG.md
git commit -m "release: <version>"
git push
git tag v<version> && git push origin v<version>
gh release create v<version> --title "v<version>" --notes-from-tag
```

Publishing the release fires the `release: published` event → CI runs
`pnpm install`, `pnpm check`, appends the registry token to `.npmrc`, then
`pnpm --filter @cognisphere-sh/cognisphere-harness publish --no-git-checks`.

### 5. Confirm

Watch the run: `gh run watch` (or `gh run list --workflow=publish.yml`). Green
= published.

## Gotchas

- **`pnpm pack --filter` writes the `.tgz` to the cwd (repo root), NOT
  `packages/harness/`.** `cd packages/harness && pnpm pack` writes it to the
  package dir instead. The driver handles the `--filter` case and cleans up.
- **CI's token only has `packages: write` for the repo's own owner.** The scope
  is `@cognisphere-sh`, so the repo must live under the `cognisphere-sh` org for
  the automatic `GITHUB_TOKEN` to publish. Elsewhere → swap in an org PAT with
  `write:packages` (see the workflow's header comment).
- **`prepack` builds the sibling `web` package.** If `cognisphere-web` won't
  build, `pnpm pack`/`publish` fails before anything is published — preflight
  catches this locally.
- **Committed `.npmrc` omits the auth token on purpose.** Don't commit a token.
  Local publish needs `npm config set //npm.pkg.github.com/:_authToken <token>`;
  CI appends it from `GITHUB_TOKEN` at runtime.
- **No `dist/` — the package ships TS `src/` and runs via `tsx`.** Don't look
  for a compiled-JS build step; there isn't one. `files` is `bin, src, dist-web,
  CHANGELOG.md`.
- **`harness.json.version` is a separate concern.** That's the per-deployment
  *data* version the **upgrade skill** bumps after consumers `pnpm add` the new
  release. Publishing doesn't touch it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `✗ CHANGELOG.md has no "## [X]" section` | Add the section (step 2). |
| `✗ git tag vX already exists` | That version was already released — bump higher. |
| `✗ pnpm check failed` | Typecheck/lint errors — `pnpm -r run lint:fix`, then hand-fix. |
| `✗ tarball missing dist-web/` | `cognisphere-web` build failed — run `pnpm --filter cognisphere-web build` to see why. |
| CI `403 Forbidden` on publish | Token lacks `write:packages` for `@cognisphere-sh`, or repo isn't under the org (see Gotchas). |
| CI `409 Conflict` / version exists | That version is already on the registry — bump and re-release. |

## Verify checklist

- [ ] `packages/harness/package.json` version bumped
- [ ] `CHANGELOG.md` has the matching `## [<version>]` section
- [ ] `node .claude/skills/publish-harness/preflight.mjs` → `PREFLIGHT PASSED`
- [ ] tag pushed + `gh release create` published
- [ ] `gh run watch` green
