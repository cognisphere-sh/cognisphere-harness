# CogniSphere — Distribution & Deployment Design

Status: **mostly implemented.** The repository restructure into a
`packages/{harness,web}` pnpm workspace (§3), the `cognisphere` CLI (§10), the
publishing config (§7, §11), and the upgrade/deploy skills (§9) are built. What
remains external: actually publishing to the registry (needs a token) and the
plugin `compatibleHarness` manifest (the CLI honors it where present, but no
builtin plugin declares one yet).

This doc is the contract for how CogniSphere is packaged, installed, deployed,
and upgraded. It supersedes the copy-the-codebase-per-deployment workflow.

## Table of contents

1. [Problem & key insight](#1-problem--key-insight)
2. [The harness is an npm project](#2-the-harness-is-an-npm-project)
3. [Repository structure](#3-repository-structure)
4. [Agents & the base template](#4-agents--the-base-template)
5. [Plugins: core vs. catalog](#5-plugins-core-vs-catalog)
6. [Versioning model](#6-versioning-model)
7. [Distribution & the private registry](#7-distribution--the-private-registry)
8. [Multi-harness deployment](#8-multi-harness-deployment)
9. [Updates & the upgrade skill](#9-updates--the-upgrade-skill)
10. [CLI surface](#10-cli-surface)
11. [Open decisions](#11-open-decisions)

---

## 1. Problem & key insight

Today a new deployment **copies the entire harness codebase** into a new folder
(e.g. `builder-recruit/buildRecruitAgent/` holds a code copy plus the
`buildRecruit/` data dir). That makes installs heavy, deployments drift, and
updates a manual merge.

**The copy was never necessary.** The code is already decoupled from the data:

- **Code** resolves all its own resources relatively (builtin plugins, the base
  template, the web build), so the package is self-contained and relocatable.
- **Data** is addressed entirely by two env vars: `COGNISPHERE_ROOT_DIR`
  (default `~/.cognisphere`) and `COGNISPHERE_ID` (default `default`). A harness
  lives at `<rootDir>/<id>/`.

So the whole design reduces to: **install the code once as a versioned
dependency, point many data dirs at it.**

## 2. The harness is an npm project

A harness is a small **pnpm project that depends on `cognisphere`** — exactly
how an app depends on a framework (you don't copy Next.js into your repo, you
`pnpm add next`).

```
~/.cognisphere/buildRecruit/          ← the harness = a git-tracked pnpm project
├── package.json   → { "dependencies": { "@cognisphere-sh/cognisphere-harness": "0.3.0" } }
├── pnpm-lock.yaml → pins the exact version
├── node_modules/  → gitignored, reproducible from the lockfile
├── harness.json   → { "version": "0.3.0", "timezone": "America/Toronto" }
├── .secrets/      → gitignored (secrets.json, models.json, users.json, session-key)
├── agents/        → forked from base-agent, edited freely, git-tracked
└── plugins/       → forked from the catalog, git-tracked
```

Why pnpm: its content-addressed store hard-links shared dependencies across
every harness on the machine, so N harnesses on the same version cost ~one copy
on disk while keeping fully independent `node_modules` and lockfiles. That gives
per-harness version isolation **and** low disk cost.

**What this kills:** the code copy. `node_modules/@cognisphere-sh/cognisphere-harness` is
*managed* (installed from the registry, pinned by the lockfile), not vendored.

**Packaging requirement:** the published package must ship the prebuilt web
bundle (`packages/web/dist`), the core plugins, and the base template. The
runtime's relative resolution then works unchanged from inside `node_modules`.

## 3. Repository structure

The monorepo is a **pnpm workspace** with two packages — the publishable
backend (`harness`) and the UI (`web`):

```
packages/
├── harness/                  ← @cognisphere-sh/cognisphere-harness (publishable backend)
│   ├── package.json
│   ├── bin/cognisphere.mjs   ← CLI entry shim (the published `cognisphere` bin)
│   ├── scripts/prepack.mjs   ← bundles web dist + CHANGELOG into the package at publish
│   └── src/                  ← all TypeScript source + the shipped runtime assets
│       ├── core/             ← agent-runner engine + the process entrypoint
│       │   ├── agent-manager.ts  runner.ts  queue.ts  rpc.ts
│       │   ├── plugin-registry.ts  secrets.ts  models-store.ts  models-catalog.ts
│       │   ├── config.ts  types.ts  logger.ts  oauth-logins.ts
│       │   └── main.ts       ← process entrypoint + HTTP route wiring
│       ├── api/              ← HTTP route handlers (/api, /admin, /webhook)
│       ├── cli/              ← the `cognisphere` CLI (init, agent, plugin, dev, up, upgrade)
│       ├── plugins/          ← admin, scheduler (core) + telegram, gws (catalog)
│       └── base-agent/       ← the single base template every agent forks from
└── web/                      ← cognisphere-web (Vite/React UI → builds to dist)
pnpm-workspace.yaml
```

- **`harness`** is the entire backend, published as one artifact. All source
  lives under `src/`; `bin/` and `scripts/` (the entry shim and the publish-time
  bundler) stay at the package root. `src/core/` is the agent-runner engine
  (documented in [`server.md`](./server.md)) plus `main.ts`, the process
  entrypoint that wires up the HTTP server; `src/api/` holds the route handlers
  (documented in [`api.md`](./api.md)). The dependency direction `api → core`
  (never the reverse) is a convention enforced by lint, not a package boundary —
  there is no current consumer of the engine without the HTTP server, so a
  separate `core` package would be premature.
- **`web`** is an independent Vite/React project; the backend serves its built
  output when present (`packages/web/dist`) and proxies to it in dev.

If a headless-engine consumer ever materializes, promoting `harness/src/core/`
to its own package is a contained move.

## 4. Agents & the base template

- Every agent forks from **one** base template, shipped at
  `packages/harness/src/base-agent/`. `cognisphere agent new <name>` copies it into the
  harness's `agents/<id>/`.
- The forked copy is **owned by the harness** — git-tracked and edited freely
  (prompts, workspace, plugins).
- Because all agents descend from the same template generation,
  **agent version == harness version**. There is no separate per-agent version
  stamp; `harness.json.version` records which base-template generation every
  agent descends from. The upgrade skill (§9) applies base-template breaking
  changes uniformly on top of the user's edits, with the git diff as the safety
  net.

## 5. Plugins: core vs. catalog

Two kinds of plugins, distinguished by whether the user is meant to fork them:

| Kind | Plugins | Distribution | Editable |
|---|---|---|---|
| **Core** | `admin`, `scheduler` | bundled in the package, resolved from `node_modules` | no — forking is a footgun |
| **Catalog** | `telegram`, `gws`, future adapters | **forkable copies** | yes — copied into the harness |

- The **catalog** lives at `packages/harness/src/plugins/` in the monorepo. `cognisphere
  plugin add <id>` copies a plugin folder into `<harness>/plugins/<id>/`
  (git-tracked, forkable) — the same fork model as the base template.
- **Override** is already supported by the runtime: user plugins under
  `<harness>/plugins/` shadow builtins on id collision. "Override a builtin" and
  "install a catalog plugin" are the same mechanism.
- **Enable/select is per-agent** (via `agent.json`), matching CogniSphere's
  native multi-agent shape — agent A gets Telegram, agent B doesn't.
- Each plugin carries a manifest declaring harness compatibility:

  ```json
  { "id": "telegram", "version": "1.2.0", "compatibleHarness": ">=0.3.0 <0.5.0" }
  ```

  The CLI validates `compatibleHarness` against `harness.json.version` at
  `plugin add` time; the upgrade skill re-checks every forked plugin at upgrade
  time and flags incompatible ones.

## 6. Versioning model

- **`package.json`** (in the harness) is the source of truth for the installed
  code version, pinned exactly by the lockfile.
- **`harness.json.version`** mirrors it as the **data/migration** version — what
  the running server and the upgrade skill read without resolving
  `node_modules`.
- The upgrade skill's job is to make `harness.json.version` catch up to the
  installed `package.json` version after a dependency bump.
- Agents and forked plugins inherit the harness version (§4, §5).

## 7. Distribution & the private registry

CogniSphere is published to a **private npm registry** under a scope
(`@cognisphere-sh/cognisphere-harness`). Recommended: **GitHub Packages** — a real registry
with proper semver resolution and near-zero setup.

Setup:

1. Scope the package and add to its `package.json`:
   ```json
   "publishConfig": { "registry": "https://npm.pkg.github.com" }
   ```
2. Publisher and consumer each add an `.npmrc`:
   ```
   @cognisphere-sh:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```
   (`read:packages` to install, `write:packages` to publish.)
3. `pnpm publish` / `pnpm add @cognisphere-sh/cognisphere-harness@0.3.0`.

**Zero-infra fallback** — depend on a git tag, no registry at all:

```jsonc
"dependencies": {
  "@cognisphere-sh/cognisphere-harness": "git+ssh://git@github.com/cognisphere-sh/cognisphere-harness.git#v0.3.0"
}
```

(requires shipping the prebuilt web bundle in the repo or a `prepare` build
hook; loses `@latest` resolution). Move to self-hosted **Verdaccio** only once
there are many consumers or a need to cache public deps.

## 8. Multi-harness deployment

One install, many data dirs, one process each:

```
@cognisphere-sh/cognisphere-harness (installed per harness via pnpm)
        │  reads COGNISPHERE_ROOT_DIR / COGNISPHERE_ID
        ▼
~/.cognisphere/buildRecruit/   ← own port, own systemd unit
~/.cognisphere/carguy/         ← own port, own systemd unit
```

A systemd **template** unit `cognisphere@.service` parameterizes on the harness
id, so adding a harness is `systemctl enable --now cognisphere@carguy`. Each
harness gets its own port behind the reverse proxy (Caddy).

Note: because one harness already hosts **many agents**, a new product is often
a new *agent*, not a new *harness*. Reach for a new harness only when you need
isolation (separate secrets, separate version, separate public URL).

## 9. Updates & the upgrade skill

Upgrades are **two-phase**:

1. **Code:** `pnpm add @cognisphere-sh/cognisphere-harness@<target>` — bumps `node_modules`
   and the lockfile.
2. **Data:** the upgrade skill walks the harness dir and patches
   prompts/plugins/`agent.json`/secrets to match the new version, then writes
   the new version into `harness.json`.

**Single changelog source.** Breaking changes are recorded in one
[`CHANGELOG.md`](../CHANGELOG.md) at the repo root, one section per version, with
a fixed machine-readable **Breaking changes** block the skill keys on:

```
## 0.4.0
### Breaking changes
- agent.json: `model` → `modelId`              [affects: agents/*/agent.json]
- base template: 0-base_prompt.md adds <tools> [affects: forked agents]
- secrets.json: keys move under providers.*     [affects: .secrets/]
```

**The skill** (`cognisphere upgrade`, a coding-agent skill):

1. Reads `harness.json.version` (current) and the installed package version
   (target).
2. Collects every `CHANGELOG.md` section in `(current, target]`.
3. Proposes a concrete diff against the harness dir.
4. **Waits for user approval**, then applies it and bumps
   `harness.json.version`.

Safety: the harness dir is a git repo, so the migration is a reviewable diff
with trivial rollback; the version stamps on agents (§4) and plugins (§5) scope
exactly which forked artifacts each breaking change touches.

## 10. CLI surface

The `cognisphere` bin is the connective tissue for install, scaffold, run, and
upgrade:

| Command | Purpose |
|---|---|
| `cognisphere init <id>` | scaffold a harness data dir at `./<id>` (cwd-relative; `--root <dir>` to override, e.g. `~/.cognisphere` for the systemd layout) — `harness.json`, `.secrets/` with a generated session-key, `package.json`, `.npmrc`, `.gitignore`, git repo, empty `agents/`/`plugins/` |
| `cognisphere agent new <name>` | fork `base-agent` into `agents/<name>/` + write a starter `agent.json` |
| `cognisphere plugin add <id>` | fork a catalog plugin into `plugins/<id>/` (refuses core plugins; honors `compatibleHarness` when declared) |
| `cognisphere dev` | backend under `tsx --watch` **plus** the Vite dev server (HMR) when the web package is present (the monorepo); flags `--port <n>` (backend), `--web-port <n>` (Vite), `--no-web` (backend only). Vite proxies `/api`/`/admin`/`/webhook` to the backend. |
| `cognisphere serve` | run the backend once (no watch) — the production entry the systemd unit execs; `--port <n>`, `--headless` (mount no web UI — API/webhook/admin only, for backend-only hosts). The backend otherwise serves the bundled UI (`dist-web/`), so production needs no separate web process. |
| `cognisphere up` / `logs` / `status` | manage the `cognisphere@<id>` systemd **user** service |
| `cognisphere upgrade` | drive the two-phase upgrade: show the changelog window, `--to <v>` bumps the dep, `--set-version <v>` stamps `harness.json` (§9) |

The CLI derives `COGNISPHERE_ROOT_DIR`/`COGNISPHERE_ID` from the harness dir (the
cwd) for `dev`/`serve`, so no env wiring is needed. The bin is a small JS shim
(`bin/cognisphere.mjs`) that registers the `tsx` loader and runs the TS CLI, so
`npx @cognisphere-sh/cognisphere-harness init` works without a build step.

## 11. Open decisions

- **Publishing — done.** `packages/harness` is publishable: `publishConfig`
  (GitHub Packages, §7), a `files` allowlist, the `cognisphere` `bin`, and a
  `prepack` step (`scripts/prepack.mjs`) that bundles the prebuilt web UI into
  `dist-web/` and copies the root `CHANGELOG.md` into the package. `pnpm pack`
  validates the artifact. What's left is running `pnpm publish` with a
  `write:packages` token — an operator step, not a code change.
- **Plugin distribution.** Catalog plugins are forkable copies (decided). Stable
  first-party plugins could additionally ship as npm packages later.
- **Registry choice.** GitHub Packages recommended (§7); git+ssh tags as the
  zero-infra interim.
- **Dev `.env` location.** `dotenv` loads `.env` from the process cwd; with
  `pnpm --filter … dev` the cwd is `packages/harness`, so a dev `.env` belongs
  there (or pass env inline). Production env comes from the service manager, not
  a repo `.env`.

> **Done in this iteration:** the monorepo is now a pnpm workspace
> (`packages/{harness,web}`); `node-linker=hoisted` keeps a flat `node_modules`
> so existing configs resolve transitive deps. `pnpm check` runs typecheck +
> lint across both packages.
