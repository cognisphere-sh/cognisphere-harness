# cognisphere-upgrade — changelog

## 1.3.0

- `app/artifacts-routes/` joins the harness-owned scaffold refresh: it is the
  one exception to "never refresh anything under `app/`", because it is
  reference code for the `artifacts` plugin's public/protected routes.
- New step 4b-i: after refreshing that template, diff the home's *copies* of it
  (`app/lib/artifacts.ts`, `app/app/{public,private}/artifacts/`) against it and
  report the drift instead of overwriting — the copies are user-owned (they
  carry the home's real `signedIn()`), and a stale copy of a security-relevant
  route is how a private artifact becomes readable.

## 1.2.0

- Scaffold-refresh ownership: inside `scripts/app/` only `README.md` is
  harness-owned; the deployment's hook scripts (`secrets.sh`, `server.sh`,
  `setup-server.sh`, `aws-setup.sh`, `contabo-setup.sh`) and
  `config.example` are user-owned and survive the copy. Deployment
  customizations found edited into harness-owned scripts should be offered
  a move into a `scripts/app/` hook during re-apply.

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
