# cognisphere-upgrade — changelog

## 1.1.0

- New step: when the upgrade window touches an agent's prompts, re-read its
  `system_prompts/` and `knowledge/SOPs/` and migrate procedural content
  into versioned skills (`skills/agent/<slug>/SKILL.md` + per-skill
  `CHANGELOG.md`, helper scripts in the skill's `scripts/`, supporting
  files in `artifacts/`), updating `1-agent.md` to reference the skill.
- Documents the prompt-file ownership contract (harness-owned `0-*`,
  plugin-owned `plugin-<id>.md`, deployment-owned `1-agent.md`) and the
  rule that overrides of owned files must be documented in `docs/harness/`.

## 1.0.0

- Initial version: two-phase upgrade driver (CHANGELOG breaking-change
  window → surgical data-dir edits → scaffold refresh → version stamp).
