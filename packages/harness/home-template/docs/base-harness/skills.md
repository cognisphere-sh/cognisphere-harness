# CogniSphere skills

Skills shipped with the harness, installed by `cognisphere init` into
`.claude/skills/` and `.agents/skills/` at the home root (for coding agents
working in the home, e.g. Claude Code) and into the developer agent's own
`skills/agent/` dir (so the running agent loads them natively).

## `cognisphere-upgrade`

Migrates this harness data dir after a version bump of
`@cognisphere-sh/cognisphere-harness`. Two-phase: `pnpm`/the CLI bumps the
code; the skill reads the breaking-change window from the package
`CHANGELOG.md`, proposes a diff against `harness/` (agents, plugins, config),
applies it after approval, and stamps `harness.json.version`. It also
refreshes `docs/base-harness/CHANGELOG.md`. Invoke when asked to "upgrade the
harness".

## `create-plugin`

Authors a new user-space plugin in `harness/plugins/<id>/` — scaffolds the
`index.ts` (manifest + `start`/`stop`) and seed tree (system-prompt fragment,
CLI scripts), enables it on an agent, and verifies it loads. Invoke when
asked to "create a plugin".
