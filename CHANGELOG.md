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

## [Unreleased]

### Changed

- Repository restructured into a pnpm workspace with two packages:
  `packages/harness` (`@cognisphere/cognisphere-harness` — backend source under
  `core/`, plus `plugins/` and `base-agent/`) and `packages/web` (the React UI).
  Tooling moved to pnpm; `pnpm check` runs typecheck + lint across both packages.
  No on-disk harness artifacts are affected — this is a source-layout change only.

## [0.1.0]

- Initial version.
