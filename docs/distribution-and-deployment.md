# CogniSphere — Distribution & Deployment Design

Status: **mostly implemented.** The repository restructure into a
`packages/{harness,web}` pnpm workspace (§3), the `cognisphere` CLI (§10), the
publishing config (§7, §11), the app-home scaffold with its AWS deploy scripts
(§2, §8), and the upgrade skill (§9) are built. What remains external: the
plugin `compatibleHarness` manifest (the CLI honors it where present, but no
builtin plugin declares one yet).

This doc is the contract for how CogniSphere is packaged, installed, deployed,
and upgraded. It supersedes the copy-the-codebase-per-deployment workflow.

## Table of contents

1. [Problem & key insight](#1-problem--key-insight)
2. [The app home](#2-the-app-home)
3. [Repository structure](#3-repository-structure)
4. [Agents & the base template](#4-agents--the-base-template)
5. [Plugins: core vs. catalog](#5-plugins-core-vs-catalog)
6. [Versioning model](#6-versioning-model)
7. [Distribution & the private registry](#7-distribution--the-private-registry)
8. [Deployment (AWS)](#8-deployment-aws)
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

## 2. The app home

A deployment is an **app home**: one git-tracked pnpm workspace holding the
agent harness and the product's user-facing app side by side. `cognisphere
init <name>` scaffolds it:

```
<name>/                        ← the app home = a git repo + pnpm workspace
├── package.json               → private umbrella (no deps of its own)
├── pnpm-workspace.yaml        → members: harness, app (+ allowBuilds for native deps)
├── pnpm-lock.yaml             → pins the exact versions
├── .npmrc                     → @cognisphere-sh scope → GitHub Packages (no token — see §7)
├── config.example             → deploy params; cp to `config` (gitignored) and edit
├── scripts/                   → lifecycle scripts + per-platform provisioning (§8)
│   └── aws/                      (setup.sh + config.example; cp to `config` there)
├── .claude/skills/            → agent skills (upgrade, create-plugin), copied in by init
├── .agents/skills/               (same set — for non-Claude coding agents)
├── app/                       ← the user-facing app (placeholder README until you
│                                 add one; a Next.js app is the convention)
└── harness/                   ← the harness data dir — a workspace member that
    ├── package.json              depends on @cognisphere-sh/cognisphere-harness
    ├── harness.json            → { "version": "0.3.0", "timezone": "UTC" }
    ├── .secrets/               → gitignored (secrets.json, models.json, users.json, session-key)
    ├── agents/                 → forked from base-agent, edited freely, git-tracked
    └── plugins/                → forked from the catalog, git-tracked
```

The harness depends on the package **exactly how an app depends on a
framework** (you don't copy Next.js into your repo, you `pnpm add next`) —
`node_modules/@cognisphere-sh/cognisphere-harness` is *managed* (installed from
the registry, pinned by the lockfile), not vendored. Why pnpm: its
content-addressed store hard-links shared dependencies across every home on
the machine, keeping fully independent lockfiles at low disk cost.

The `app/` member is yours: any web app with `build`/`start` scripts that
honors `PORT` and reaches the harness at `HARNESS_URL` (see the scaffolded
`app/README.md` for the exact contract). The deploy scripts run the harness
alone until `app/package.json` exists.

**Packaging requirement:** the published package must ship the prebuilt web
bundle (`packages/web/dist`), the core plugins, the base template, and the
app-home template (`home-template/` at the package root — the deploy scripts
and config examples `init` copies out). The runtime's relative resolution then
works unchanged from inside `node_modules`.

## 3. Repository structure

The monorepo is a **pnpm workspace** with two packages — the publishable
backend (`harness`) and the UI (`web`):

```
packages/
├── harness/                  ← @cognisphere-sh/cognisphere-harness (publishable backend)
│   ├── package.json
│   ├── bin/cognisphere.mjs   ← CLI entry shim (the published `cognisphere` bin)
│   ├── scripts/prepack.mjs   ← bundles web dist + CHANGELOG into the package at publish
│   ├── home-template/        ← the app-home template `init` scaffolds from
│   │                            (scripts/, config.example, app/)
│   └── src/                  ← all TypeScript source + the shipped runtime assets
│       ├── core/             ← agent-runner engine + the process entrypoint
│       │   ├── agent-manager.ts  runner.ts  queue.ts  rpc.ts
│       │   ├── plugin-registry.ts  secrets.ts  models-store.ts  models-catalog.ts
│       │   ├── config.ts  types.ts  logger.ts  oauth-logins.ts
│       │   └── main.ts       ← process entrypoint + HTTP route wiring
│       ├── api/              ← HTTP route handlers (/api, /admin, /webhook)
│       ├── cli/              ← the `cognisphere` CLI (init, agent, plugin, dev, serve, upgrade)
│       ├── plugins/          ← admin, scheduler (core) + telegram, gws (catalog)
│       └── base-agent/       ← the single base template every agent forks from
└── web/                      ← cognisphere-web (Vite/React UI → builds to dist)
pnpm-workspace.yaml
```

- **`harness`** is the entire backend, published as one artifact. All source
  lives under `src/`; `bin/`, `scripts/`, and `home-template/` (the entry shim,
  the publish-time bundler, and the verbatim scaffold assets — data, not code)
  stay at the package root. `src/core/` is the agent-runner engine
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
2. The scope mapping lives in the app home's committed `.npmrc`:
   ```
   @cognisphere-sh:registry=https://npm.pkg.github.com
   ```
   The auth line lives in the **user's** `~/.npmrc` (pnpm refuses to expand
   env-var credentials from a committed project `.npmrc`):
   ```
   //npm.pkg.github.com/:_authToken=${COGNISPHERE_NPM_TOKEN}
   ```
   `COGNISPHERE_NPM_TOKEN` is a GitHub token (`read:packages` to install,
   `write:packages` to publish) — one env-var name everywhere, locally and on
   the box. On a deployed box, `scripts/setup-server.sh` writes the line for
   the run user, sourcing the token from `config` (`COGNISPHERE_NPM_TOKEN`)
   or the `gh` CLI.
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

## 8. Deployment (AWS)

Deployment target: **one EC2 box per app home**, driven entirely by the
scaffolded `scripts/` (AWS is the only supported target for now; GWS and
similar providers come later). The runtime shape on the box:

```
browser ──https──> nginx ──┬─ $DOMAIN         → app (next start, :$APP_PORT)
                           └─ $CONSOLE_DOMAIN → harness console (cognisphere serve, :$HARNESS_PORT)
app ── /api,/webhook ──> 127.0.0.1:$HARNESS_PORT   # proxied same-origin by the app
```

Two systemd units — `<name>-harness.service` (WorkingDirectory `harness/`,
`pnpm exec cognisphere serve`) and `<name>-app.service` (WorkingDirectory
`app/`, `pnpm start`; only when `app/` exists) — behind one nginx with Let's
Encrypt certs for both hostnames. The harness binds localhost only; nginx is
the sole public entry. AWS specifics: EC2 + Elastic IP + an instance IAM role
scoped to the backup bucket (no static keys on the box), S3 for backups.

The scripts — lifecycle sourced from the root `config`, provisioning from the
platform dir's own `scripts/<platform>/config`:

| Script | Where it runs | What it does |
|---|---|---|
| `scripts/aws/setup.sh` | locally (admin AWS creds) | one-time provision: S3 bucket, key pair, IAM role + instance profile, security group, EC2 (latest Ubuntu via SSM), Elastic IP, `~/.ssh/config` entry; then remote-bootstraps `gh` + Claude Code and clones the repo. Re-runnable — resources are found by name and reused. |
| `scripts/setup-server.sh` | on the box, as root, once | apt deps (nginx, sqlite3, agent runtime libs, certbot), Node + pnpm, the GitHub Packages token into the run user's `~/.npmrc`, secrets, build, per-agent bootstrap, systemd units, nginx + HTTPS, backup cron. Re-runnable. |
| `scripts/server.sh` | on the box | day-to-day: `start\|stop\|restart\|status\|logs\|build\|harness\|dev\|secrets`. `secrets` materializes `config` into `harness/.secrets/users.json` + `app/.env.local`; `start`/`restart` run secrets + build first, so the whole deploy loop is `git pull && sudo ./scripts/server.sh restart`. |
| `scripts/build.sh` | on the box (or locally) | `pnpm install --frozen-lockfile` + the app build (when `app/` exists). |
| `scripts/aws/backup.sh` | cron (written by setup-server) | zips the whole home to S3 with consistent SQLite snapshots, prunes to `BACKUP_KEEP`. Reads the root `config` (the `BACKUP_*` keys), not `scripts/aws/config`. |

**Future platforms.** The platform seam is *platform-specific vs. lifecycle*.
Platform-specific scripts live in their own directory — today `scripts/aws/`
is the only one: `setup.sh` (provisioning, driven by `scripts/<platform>/config`
copied from the `config.example` beside it) and `backup.sh` (the S3 backup
target). The lifecycle scripts at `scripts/` top level (`setup-server.sh`,
`server.sh`, `build.sh`) are platform-neutral — they assume nothing beyond an
Ubuntu box with systemd + nginx, however it was rented. Adding GWS or another
provider = adding a `scripts/<platform>/` dir (its own `setup.sh` and, if it
brings a different backup store, its own `backup.sh` — `setup-server.sh`'s
cron block points at the platform's backup script); if platforms ever carry
heavy assets, an `init --platform` flag can copy only the chosen one.

Note: because one harness already hosts **many agents**, a new product is often
a new *agent*, not a new *app home*. Reach for a new home only when you need
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

Safety: the app home is a git repo, so the migration is a reviewable diff
with trivial rollback; the version stamps on agents (§4) and plugins (§5) scope
exactly which forked artifacts each breaking change touches.

## 10. CLI surface

The `cognisphere` bin is the connective tissue for install, scaffold, run, and
upgrade:

| Command | Purpose |
|---|---|
| `cognisphere init <name>` | scaffold an **app home** at `./<name>` (cwd-relative; `--root <dir>` to override) — workspace root (`package.json`, `pnpm-workspace.yaml`, scope-only `.npmrc`, `.gitignore`), `scripts/` + `config.example` (§8), the `app/` placeholder, the `harness/` data dir (`harness.json`, `.secrets/` with a generated session-key, `package.json`, empty `agents/`/`plugins/`), the agent skills into `.claude/skills/`+`.agents/skills/`, git repo |
| `cognisphere agent new <name>` | fork `base-agent` into `agents/<name>/` + write a starter `agent.json` |
| `cognisphere plugin add <id>` | fork a catalog plugin into `plugins/<id>/` (refuses core plugins; honors `compatibleHarness` when declared) |
| `cognisphere dev` | backend under `tsx --watch` **plus** the Vite dev server (HMR) when the web package is present (the monorepo); flags `--port <n>` (backend), `--web-port <n>` (Vite), `--no-web` (backend only). Vite proxies `/api`/`/admin`/`/webhook` to the backend. |
| `cognisphere serve` | run the backend once (no watch) — the production entry the `<name>-harness` systemd unit execs; `--port <n>`, `--headless` (mount no web UI — API/webhook/admin only, for backend-only hosts). The backend otherwise serves the bundled UI (`dist-web/`), so production needs no separate web process. |
| `cognisphere upgrade` | drive the two-phase upgrade: show the changelog window, `--to <v>` bumps the dep, `--set-version <v>` stamps `harness.json` (§9) |

Running under systemd/nginx on a host is the deploy scripts' job (§8), not the
CLI's.

The CLI derives `COGNISPHERE_ROOT_DIR`/`COGNISPHERE_ID` from the harness dir —
the cwd, or `./harness` when run from the app home — so no env wiring is
needed. The bin is a small JS shim
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
