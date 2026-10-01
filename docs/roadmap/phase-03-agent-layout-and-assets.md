# Phase 3: agent layout and assets

[Roadmap](../roadmap.md) · Previous: [Phase 2](phase-02-reliable-intake.md) · Next: [Phase 4](phase-04-core-prompt-and-capabilities.md)

## Requirement

- **Separate shipped from agent-made:** shipped defaults (prompts, skills, scripts) are read-only to the agent. What the agent creates during its life is kept separately and never overwritten by an upgrade.
- **One place to read and edit:** the agent reads and edits all its prompts, skills and scripts in one folder, with no separate "read path" and "edit path".
- **`agent.json` decides what is used:** which prompt files make up the system prompt (and in what order), and which skills are passed to Pi, for the main agent and for each sub-agent.
- **Changing a default:** the agent writes a new file and points `agent.json` at it.
- **`assets.json` explains every agent-made asset:** what it is for, why it exists, and which base file it replaces, if any. The coding agent uses it during upgrades to decide whether each change is still needed.
- **Definition vs. state:** an agent has a definition (copied when cloning) and state (created during its life, never copied with a clone, and checkpointable later).

**Today:** shipped files are copied into `system_prompts/`, `skills/` and `scripts/`, and re-copied on every plugin start. Every `system_prompts/*.md` file is concatenated in sorted order. Edits to plugin files are silently overwritten.

## Design

### Layout

```text
agents/<id>/
  agent.json                definition: model, capabilities, tools, prompt/skill selection per role, sandbox flags
  plugins/<pid>/config.json definition: per-plugin operator config (unchanged for now)
  assets/                   state: the ONE place for prompts, skills, scripts
    base/                   reserved, managed by the harness, READ-ONLY (see below)
    prompts/ skills/ scripts/   agent-created files (new names, never shadowing base)
    assets.json             what/why for every agent-created asset, and what it replaces
  workspace/                state: notes, files, knowledge (today's workspace/ + knowledge/)
  plugin-data/<pid>/        state: plugin files (attachments, cursors, schedules)
  deps/                     state: pip/npm installs the agent makes (used from phase 9; created now)
  sessions/                 state: Pi session files
  .runtime/queue.db         message queue (moved out of sessions/; never checkpointed)
```

**`assets/base/` is read-only.**

- **Contents:** the harness builds one base folder per harness version: `<harnessRoot>/.base/<version>/`, with the base template plus every capability's files. It is built from the package and from deployment forks in `harness/plugins/`, and made read-only (`chmod -R a-w`).
- **Process mode:** `assets/base` is a symlink to that folder, recreated at each agent start.
- **Docker (phase 9):** the agent host points it at the image's base folder.
- **Paths:** the agent sees the same path either way. `base` is a reserved name inside `assets/` and is gitignored.

### Selection in `agent.json`

```json
{
  "model": { "provider": "anthropic", "id": "main-model" },
  "allowAssetChanges": true,
  "prompts": [
    "base/prompts/core.md",
    "prompts/communication.md",
    "base/capabilities/telegram/prompts/usage.md",
    "prompts/persona.md"
  ],
  "skills": [
    "base/capabilities/web-search/skills/web-search",
    "skills/invoice-cleanup"
  ],
  "subagents": {}
}
```

- **Main role:** top-level `prompts` and `skills`. Sub-agents get their own `prompts` and `skills` inside `subagents.<name>` (phase 5).
- **Prompt order:** the system prompt is the listed files concatenated **in array order**.
- **Skills:** each listed folder is passed to Pi as `--skill <dir>` and must contain a `SKILL.md`.
- **Scripts:** a skill's scripts live inside its folder (`skills/<name>/scripts/`), so selecting a skill brings its scripts along. Standalone agent scripts in `assets/scripts/` are on `PATH`.
- **Paths:** all paths are relative to `assets/` and must stay inside it. `base/…` paths can be used but not edited.

### `assets.json`: the explanation of every agent-made asset

```json
{
  "prompts/communication.md": {
    "what": "Replies are short and in the user's language",
    "why": "Most users write in Hindi and dislike long answers",
    "replaces": "base/prompts/communication.md",
    "baseVersion": "0.9.2",
    "updated": "2026-10-01"
  },
  "skills/invoice-cleanup": {
    "what": "Cleans supplier invoice CSVs before import",
    "why": "The same cleanup was done by hand in 6 threads",
    "updated": "2026-09-20"
  }
}
```

- **One entry per asset:** every file or skill folder under `assets/prompts`, `assets/skills` and `assets/scripts` has an entry.
- **Replacements:** `replaces` and `baseVersion` are set only when the asset stands in for a base file.
- **Missing entries:** an asset with no entry still works, but the console flags it as "undocumented".
- **Deleted assets:** an entry whose asset no longer exists is flagged as stale.

### Changing a default

To replace `base/prompts/communication.md`, the agent:

1. copies it to `prompts/communication.md` and edits it;
2. swaps the path in `agent.json` (main role or a sub-agent);
3. adds the `assets.json` entry.

The `assets` CLI performs all three in one step:

- `assets replace base/prompts/communication.md --what "…" --why "…"`
- `assets add-prompt <file> [--after <path>] [--role <name>]`
- `assets add-skill <dir> [--role <name>]`
- `assets remove <path>`

**Who may change what:** `agent.json` mixes operator-only fields (model, capabilities, tools, sandbox flags, grants) with the selection fields the agent may change (`prompts`, `skills`, and from phase 7 `handlers`).

- **Making the change:** the agent never writes `agent.json` directly. The `assets` CLI asks the harness, which checks `allowAssetChanges`, changes **only selection fields**, validates the result and writes the file.
  - Phases 3–5 use a harness HTTP route.
  - From phase 6 it's a coordinator call authenticated with the unit token.
- **Enforcement:** in Docker (phase 9) `agent.json` is mounted read-only, so the harness route is the only way. In process mode this is a convention, because there's no sandbox yet.
- **When `allowAssetChanges` is false:** the route refuses changes, and `assets/` is read-only for the agent. The operator can still edit both.
- **Default:** true for `nova`, false for new agents (open question 1).

### Validation and safety

Validation runs whenever `agent.json` changes and at each batch start:

- every path exists and stays inside `assets/`;
- every skill folder has a `SKILL.md`;
- `base/capabilities/<id>/…` paths are only allowed when that capability is enabled (phase 4; before that, when the plugin is enabled).

**If validation fails at batch start** (for example because a referenced file was deleted): the harness uses the **last valid selection** (`.runtime/selection.last-good.json`), logs the error and shows it in the console. A bad edit never takes the agent down. Changes made through the `assets` CLI are validated before they're saved, so they can't fail this way.

**When edits take effect:** prompt changes apply from the next batch. Skill files are read live by Pi.

### Upgrades

The base folder for the new version is built next to the old one. `cognisphere assets report <agent>` lists:

- base files selected in `agent.json` whose content changed;
- each `assets.json` entry whose `replaces` file changed since its `baseVersion`, with a diff of the base change;
- new base prompts and skills that the default selection includes but this agent doesn't.

The upgrade skill (coding agent) reads the report together with each entry's `what` and `why`. For each one it keeps, edits or drops the replacement, then updates `agent.json` and the entry's `baseVersion`/`updated`. Nothing is merged automatically.

### Default selection and new agents

Each capability declares default prompts and skills (phase 4). Until then, the base template does. `cognisphere agent new` writes the core prompt plus those defaults into `agent.json`, and creates `assets/prompts/persona.md` with its `assets.json` entry.

### Migrating existing agents

`cognisphere agent migrate-layout <id>` is a dry run by default. `--apply` requires a clean git tree, so git is the backup and the rollback.

| Today | Becomes |
|---|---|
| `system_prompts/0-*`, `plugin-<id>.md` unchanged from shipped | Removed. `agent.json` selects `base/…`. |
| Same files, but edited locally | `assets/prompts/<name>.md`, selected in place of the base file, with an `assets.json` entry: `why: "migrated local edit"`, `replaces`, `baseVersion` |
| `system_prompts/1-agent.md` | `assets/prompts/persona.md` |
| `skills/<plugin>/…`, `scripts/<plugin>/…` | Same rule: unchanged → base selection; edited → `assets/skills/…` plus an entry |
| `skills/agent/…`, `scripts/agent/…` | `assets/skills/…`, `assets/scripts/…`, plus entries (`why: "migrated"`) |
| `workspace/`, `knowledge/` | `workspace/` (with `knowledge/` as a subfolder) |
| Plugin state folders | `plugin-data/<pid>/` |
| `sessions/.events.db` | `.runtime/queue.db` |

"Unchanged" means the file's hash matches the shipped file in the installed version or a recent previous version. The prompt **order** is preserved by writing the old lexical order into `agent.json`. A phase 1 test checks that the assembled system prompt is byte-identical before and after migration.

## Done when

- A new agent has the layout above. `assets/base` is read-only (writing to it fails).
- `assets replace` changes the next batch's system prompt, updates `agent.json`, and writes the `assets.json` entry.
- With `allowAssetChanges: false`, the CLI is refused.
- Deleting a selected file keeps the agent running on the last valid selection, and the console shows the error.
- Undocumented and stale assets are flagged in the console.
- `assets report` lists changed base files and affected replacements after a simulated upgrade.
- Migrating `nova` and one other real agent produces an identical system prompt, with local edits preserved and documented.
- Plugin seed copying is removed.
- Docs: agents.md (layout, selection, `assets.json`), plugins.md (no seed copying), core.md (queue path), api.md (the selection route), cli.md (`assets`, `migrate-layout`), shipped README "Anatomy of an agent".

## Open questions

1. What should the `allowAssetChanges` default be for new agents: false (safer, operator-curated) or true (agents can improve themselves)?
2. Should operator edits made by hand also require `assets.json` entries? The suggestion is yes, so upgrade decisions see every change regardless of who made it. The console editor could prompt for what and why.
3. Should plugin config move from `plugins/<pid>/config.json` into `agent.json` with the phase 4 capability list, or stay where it is?
4. How many previous shipped versions should the migration compare hashes against?

## Out of scope

Splitting the base prompt (phase 4), sub-agent fields (phase 5), handlers (phase 7), installs into `deps/` (phase 9).
