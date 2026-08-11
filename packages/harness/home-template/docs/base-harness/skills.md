# CogniSphere skills

## Skills as procedural memory

An agent's step-by-step procedures — SOPs, runbooks, multi-step workflows —
live as **skills** under `agents/<id>/skills/agent/<slug>/`, one directory
per procedure with a `SKILL.md`. They do not belong in `system_prompts/`
(identity and behaviour only) or in `knowledge/` (reference facts only).

A skill is self-contained: helper scripts the procedure invokes live inside
the skill directory (`<slug>/scripts/`), and supporting artifacts —
templates, examples, reference files — in `<slug>/artifacts/`. `SKILL.md`
references both by skill-relative path, so the whole procedure moves,
versions, and gets reviewed as one directory.
pi loads every skill at spawn and injects its name, description, and file
location into the system prompt, so the agent discovers procedures by
description and reads the full `SKILL.md` only when a task matches.

**Every skill is versioned:**

- `SKILL.md` frontmatter carries `metadata.version` (semver), **and the
  description text states the version** (e.g. `… (v1.2.0)`) — the
  description is the only metadata injected into the prompt, so that's
  where the agent sees it.
- Each skill directory keeps a `CHANGELOG.md` — one entry per version,
  newest first: what changed and why.
- On every update, bump the version in both places and add the changelog
  entry. Corrections = patch, changed/added steps = minor, incompatible
  rewrite = major.

The base prompt tells agents to compare the advertised version against the
copy they last read and re-read `SKILL.md` when it moved — so a version
bump is what makes a procedure change actually reach a long-running agent.

## Shipped skills

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
refreshes the harness-owned scaffold files from the installed package —
`scripts/`, `config.example`, `docs/base-harness/`, `.claude/skills/` —
leaving user-owned files (`app/`, `docs/harness/`, `docs/app/`, `CLAUDE.md`,
`config`) alone. Invoke when asked to "upgrade the harness".

## `create-plugin`

Authors a new user-space plugin in `harness/plugins/<id>/` — scaffolds the
`index.ts` (manifest + `start`/`stop`) and seed tree (system-prompt fragment,
CLI scripts), enables it on an agent, and verifies it loads. Invoke when
asked to "create a plugin".

## `create-skill`

Authors or updates a versioned agent skill in
`harness/agents/<id>/skills/agent/<slug>/` — scaffolds the `SKILL.md`
(version in description + `metadata.version`), the per-skill `CHANGELOG.md`,
and the `scripts/`/`artifacts/` layout, and drives the migration of
procedures out of prompt files and `knowledge/SOPs/` into skills. Invoke
when asked to "create a skill", "turn this SOP into a skill", or "update a
skill".
