# Changelog

All notable changes to CogniSphere are recorded here, one section per version.

This file is the single source the **upgrade skill** reads to migrate a harness
from its current version to a target version. Each release that requires changes
to a harness's on-disk artifacts MUST include a `### Breaking changes` block
whose entries follow the form:

```
- <what changed>   [affects: <path glob in the harness dir>]
```

The skill collects every section in `(current, target]`, proposes a diff against
the harness directory, and applies it after user approval. See
[`docs/distribution-and-deployment.md`](docs/distribution-and-deployment.md) §9.

The format is based on [Keep a Changelog](https://keepachangelog.com/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0]

### Added

- **`cognisphere` CLI** (`packages/harness/src/cli/`, bin shim `bin/cognisphere.mjs`):
  `init`, `agent new`, `plugin add`, `dev`, `serve`, `up`/`logs`/`status`
  (systemd user services), and `upgrade`. `dev` runs the backend (watch) and,
  in the monorepo, the Vite dev server (HMR) together (`--port`/`--web-port`/
  `--no-web`); `serve` takes `--port` and `--headless` (mount no web UI —
  backend-only deploy, via `COGNISPHERE_HEADLESS`). See
  [`docs/distribution-and-deployment.md`](docs/distribution-and-deployment.md) §10.
- **Publishable package.** `@cognisphere-sh/cognisphere-harness` ships a `bin`, a
  `files` allowlist, `publishConfig` (GitHub Packages), and a `prepack` step that
  bundles the built web UI (`dist-web/`) and the root `CHANGELOG.md` into the
  package. `tsx` is now a runtime dependency.
- **`harness.json.version`** — the data/migration version stamp, written by
  `cognisphere init` and surfaced over `GET /api/harness`. Additive and optional;
  existing harnesses read it as `""`.
- **Upgrade & deploy skills** (`.claude/skills/cognisphere-{upgrade,deploy}/`).

### Changed

- Repository restructured into a pnpm workspace with two packages:
  `packages/harness` (`@cognisphere-sh/cognisphere-harness` — backend; all
  TypeScript source under `src/` (`core/`, `api/`, `cli/`, `plugins/`,
  `base-agent/`), with `bin/` + `scripts/` at the package root) and
  `packages/web` (the React UI). Tooling moved to pnpm; `pnpm check` runs
  typecheck + lint across both packages. No on-disk harness artifacts are
  affected — this is a source-layout change only.

## [0.1.0]

- Initial version.
