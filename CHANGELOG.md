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

## [0.3.9]

### Changed

- Base-agent template prompts: per-thread notes move to
  `workspace/threads/<ThreadId>/` (bare ThreadId as dir name), new
  `workspace/daily_notes/YYYY-MM-DD.md` convention, cross-thread knowledge
  relocated from `workspace/knowledge/` to agent-root `knowledge/`, and
  `session-reader` documented as directly executable (invoking it via `bash`
  fails — it's a Node script).

### Breaking changes

- Base template `system_prompts/0-base_prompt.md` and `0.1-main-agent.md`
  changed (workspace layout + knowledge dir + session-reader invocation).
  Existing agents keep their forked copies; graft the edits if you want the
  new conventions.   [affects: agents/*/system_prompts/*]

## [0.3.8]

### Added

- New built-in `agent-messaging` plugin (opt-in): inter-/intra-agent messaging.
  Each enabled agent gets an HTTP inbox at
  `/webhook/<agent>/agent-messaging/api/send` and a seeded
  `scripts/agent-msg/send` CLI; a received note wakes the target agent on the
  target thread (`silent` delivers for awareness only).

### Changed

- Upgraded `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` from
  `^0.78.0` to `^0.80.6` (switched the static catalog read to
  `getBuiltinModel` from `@earendil-works/pi-ai/providers/all`).
- Plugin seed provisioning now re-asserts `chmod 755` on every file under the
  agent's `scripts/` after copying a plugin's `seed/` tree. Seeds land after
  `bootstrap.sh`'s exec-bit repair pass, so a seeded script that lost its exec
  bit would otherwise stay broken until the next restart.

## [0.3.6]

### Changed

- gws plugin: `requireAgentInTo: false` now delivers messages the agent isn't
  addressed to (Cc/Bcc/none) **in full and wakes the agent**, instead of the
  previous header-only silent delivery. Backlog mode is unaffected.

## [0.3.5]

### Fixed

- Agents were missing tools at runtime because the per-agent bootstrap silently
  failed to install its dependencies. `bootstrap.sh` now:
  - re-asserts `+x` on every shebang script under `scripts/` (a dropped exec bit
    otherwise surfaces as a bare "Permission denied" mid-task);
  - prechecks `ensurepip` and recreates an incomplete `.venv` (Ubuntu 26.04 /
    Python 3.14 ships without `python3-venv`, so `python -m venv` left a
    pip-less venv and `markitdown`/`ddgs` never installed);
  - points the npm global prefix at `~/.npm-global` so `npm install -g` of `pi`
    and `agent-browser` doesn't `EACCES` when bootstrap runs as the non-root app
    user, and downloads the Chrome build `agent-browser` drives.
- `bootstrap/requirements.txt`: pin `markitdown` to the document/audio backends
  (`[pdf,docx,pptx,xlsx,xls,outlook,audio-transcription]`) instead of `[all]`,
  which is uninstallable on Python 3.14 (it hard-pins `youtube-transcript-api`).
- `scripts/agent/agent-browser`: default `AGENT_BROWSER_ARGS=--no-sandbox`
  (overridable) so Chrome starts on hosts where unprivileged user namespaces are
  restricted (Ubuntu 23.10+ AppArmor default, containers, VMs).

### Breaking changes

- Bootstrap rewritten for reliable dependency install (exec-bit repair, venv
  ensurepip precheck + recreate, user-writable npm prefix, agent-browser Chrome
  download). [affects: agents/*/bootstrap/bootstrap.sh]
- `markitdown` extras pinned instead of `[all]` for Python 3.14 compatibility.
  [affects: agents/*/bootstrap/requirements.txt]
- `agent-browser` wrapper defaults to `--no-sandbox`.
  [affects: agents/*/scripts/agent/agent-browser]

## [0.3.4]

### Added

- gws plugin: new `requireAgentInTo` config flag (default `true`, the previous
  behavior). When `false`, the latest message of a matching thread is delivered
  even when the agent's address is not in its `To` header — silently (no wake)
  unless the agent is in `To`. Ignored in backlog mode.
- gws seeded CLI `scripts/gws/format-email`: new `--strip-quotes` flag drops
  quoted reply history from a body (most clients quote the whole conversation
  below each reply), printing only the message's own text.
- gws seeded CLI: new `--list` mode accepts a Gmail *Thread* JSON (from
  `gws gmail users threads get`, `format: "metadata"` suffices) and prints
  per-message metadata (id, from, date, snippet) so agents can skim a thread
  cheaply and then fetch only the messages they need. The seeded
  `system_prompt.md` documents the explore-then-fetch workflow.

### Changed

- gws plugin: the ingestion filter no longer re-checks the `UNREAD` label on a
  thread's latest message — unread filtering is delegated entirely to the
  configured `gmailQuery` (default `is:unread in:inbox`).
- gws plugin: Gmail message decoding (body extraction, quote stripping,
  attachment fetch, timestamp formatting) is deduplicated into a single shared
  module, `seed/scripts/format-email-lib.mjs`, imported by both the plugin
  runtime and the seeded `scripts/gws/format-email` CLI (which previously
  carried its own copy of the logic).

### Fixed

- gws seeded CLI: the documented `--timezone` flag was parsed but never used —
  the header block now includes the `TimeStamp:` line, matching the shape of
  `email_received` notifications as documented.

## [0.3.3]

### Fixed

- Sub-agents could receive a single task brief as dozens of phantom one-word
  messages. The `subagent` wrapper passed the brief as a positional argv entry,
  and `pi -p` treats every positional as a separate user turn. A literal
  unescaped quote inside the brief (e.g. a pasted email body like
  `Message: "Hi Chris, ..."`) let the shell word-split the single intended arg
  into many argv entries, each replayed as its own message. The wrapper now
  routes the brief to `pi` on **stdin** (`pi -p` reads its prompt from stdin
  when no positional message is given), so quoting inside the brief can no
  longer fan out into phantom turns. Flags still pass through argv verbatim and
  the caller interface is unchanged (`subagent "<brief>" --flags`).

### Changed

- Base prompt now tells agents to keep `workspace/` for what must persist:
  write intermediate/throwaway files under `/tmp` (or delete them), and don't
  copy plugin inbox input files into `workspace/` unless they genuinely need to
  outlive the inbox.

### Breaking changes

- `subagent` wrapper now passes the task brief to `pi` on stdin instead of as a
  positional argument. [affects: agents/*/scripts/agent/subagent]
- Base prompt adds workspace-hygiene guidance (intermediate files to `/tmp`;
  don't copy inbox inputs into `workspace/` unless persisting).
  [affects: agents/*/system_prompts/0-base_prompt.md]

## [0.3.2]

### Fixed

- Sub-agents lost their system prompt on resume (`-c`/`--continue`). The
  `subagent` wrapper skipped re-injecting the base + sub-agent-role prompt on
  continue, assuming pi had persisted it — but pi never writes the system
  prompt to the session JSONL, so resumed sub-agents fell back to pi's default
  identity. The wrapper now concatenates `0-base_prompt.md` +
  `sub-agent-prompt.md` into a single `--system-prompt` value (replace, not
  `--append-system-prompt`, so pi's default doesn't leak in) and sets it on
  every call including `-c`. The task-specific brief now goes in the **message**
  (positional arg) instead of `--system-prompt`, so it lives in session history
  and survives re-invocation. The main-agent prompt was updated to match.

### Breaking changes

- `subagent` wrapper rewrites system-prompt handling: concatenates base +
  sub-agent role into one `--system-prompt`, set on every call (incl. `-c`).
  [affects: agents/*/scripts/agent/subagent]
- Main-agent prompt now instructs putting the sub-agent task brief in the
  message, never passing `--system-prompt`.
  [affects: agents/*/system_prompts/0.1-main-agent.md]

## [0.3.1]

### Added

- On first start the server prompts for an admin username/password when
  `.secrets/users.json` is missing or still holds the `admin/changeme`
  placeholder and stdin is a TTY, writing the file `0600`. Under systemd (no
  TTY) it logs a warning and falls back to the placeholder so boot still
  succeeds. (`ensureCredentials` in `api/auth.ts`, wired in `core/main.ts`.)

## [0.3.0]

### Changed

- **Base-agent system prompt split into three role-scoped parts** to remove the
  duplication that arose when sub-agents were handed a hand-copied harness
  prompt:
  - `0-base_prompt.md` is now the **shared base** — the operating manual (tools,
    files, workspace, sessions, web, browser) common to every agent. It no
    longer carries agent identity or main-agent-only framing.
  - `0.1-main-agent.md` (new) holds the **main-agent-only** role: threads,
    plugins, message metadata, the communication model, and the guide on how to
    spawn sub-agents (merged in from the old `0.1-subagents.md`).
  - `scripts/agent/sub-agent-prompt.md` (new) holds the **sub-agent-only** role
    ("stdout is your return value", include all relevant info, ask when the
    brief is ambiguous, stay scoped). It lives outside `system_prompts/` so it
    never leaks into the main agent's concatenated prompt.
- The `scripts/agent/subagent` wrapper now appends the base prompt + sub-agent
  prompt to every fresh sub-agent via `--append-system-prompt` (skipped on
  `-c`/`--continue`). Sub-agents get the same harness context as the main agent
  on top of the parent's task brief, so the parent's `--system-prompt` only
  needs to carry the task-specific brief.
- Agent identity (`AgentId`, `AgentName`) moved out of the base prompt into the
  hand-written `1-agent.md` persona. The only remaining sed-baked `{{var}}`
  (`Timezone`) is now baked into `0.1-main-agent.md`.

### Breaking changes

- Base prompt repurposed and identity removed: `0-base_prompt.md` is now the
  shared base context only; agent identity moves to the `1-agent.md` persona.
  [affects: agents/*/system_prompts/0-base_prompt.md, agents/*/system_prompts/1-agent.md]
- New main-agent-only prompt; `0.1-subagents.md` removed (its content merged in).
  [affects: agents/*/system_prompts/0.1-main-agent.md, agents/*/system_prompts/0.1-subagents.md]
- New sub-agent-only role prompt, appended to sub-agents by the wrapper.
  [affects: agents/*/scripts/agent/sub-agent-prompt.md]
- `subagent` wrapper updated to append the base + sub-agent prompts on fresh spawns.
  [affects: agents/*/scripts/agent/subagent]

## [0.2.1]

### Fixed

- Core plugins (`admin`, `scheduler`) are now always started on every agent,
  unioned with any user-installed plugins — previously a freshly scaffolded
  agent loaded no plugins at all (the operator-chat `admin` channel included),
  since the base-agent template ships no `plugins/` dir. Single source of truth
  is `CORE_PLUGIN_IDS` in `core/plugin-registry.ts`.
- `bootstrap.sh` now runs automatically on every agent start (`runBootstrap`
  in `startAgent`, before the runner spawns) — provisions system deps + the
  per-agent `.venv` so the runner can activate it. Idempotent, awaited, and
  failure-tolerant (logged, never sinks the agent); no-op when the agent ships
  no `bootstrap/bootstrap.sh`. Cost: first boot blocks on `pip install`.
- Plugin `seed/` provisioning: on plugin start, a plugin's `seed/` tree is
  recursively copied into the agent dir (mirrors the agent layout —
  `system_prompts/plugin-<id>.md`, `scripts/<id>/…`), so the agent actually
  receives each plugin's system-prompt fragment and helper CLIs (e.g. the
  scheduler's `scheduler-cli`). Previously the seed content was never copied,
  so those prompts/scripts never reached the agent.
- `cognisphere init` now pre-approves `better-sqlite3` in the scaffolded
  `package.json` (`pnpm.onlyBuiltDependencies`), so `pnpm install` builds its
  native addon instead of silently skipping it (which crashed agent boot with
  "Could not locate the bindings file").

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
