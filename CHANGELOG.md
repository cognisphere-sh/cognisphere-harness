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

## [0.5.0]

### Added

- **Agent directory**: each agent now carries an `agent.json.description`
  (one-line role blurb). On start the harness seeds
  `system_prompts/0.3-agent-directory.md` — a roster of the *other* agents
  (id + description, how to message them) — if the file is absent, so operator
  edits survive. Single-agent harnesses skip it until a second agent exists.
- **`PI_THREAD_ID`** is exported to the pi child's env (alongside
  `PI_AGENT_ID`), so seeded scripts know the current thread without being told.

### Changed

- **agent-messaging identity is env-sourced, not caller-supplied.** The seeded
  `agent-msg/send` CLI now fills `from_agent`/`from_thread_id` from
  `$PI_AGENT_ID`/`$PI_THREAD_ID` — the `--from-agent`/`--from-thread-id` flags
  are gone. Agents can no longer typo or spoof their own reply address.
- **agent-messaging inbox now authenticates.** `POST /webhook/<agent>/agent-messaging/api/send`
  requires the shared `COGNISPHERE_WEBHOOK_SECRET` (generated at boot unless
  pinned via env; inherited by every agent's env) as an `X-Webhook-Secret`
  header (`401` otherwise). Sender authorisation moved to a per-inbox
  `allowMessageFrom` plugin config (default `["*"]`; a sender not listed gets
  `403`), replacing the `PluginInstanceContext.allowsMessageFrom` method.

### Breaking changes

- `agent.json.devAgentAccess` removed. It is now ignored; the `0.2-dev-agent.md`
  hand-off fragment is included for **every** agent, and messaging permission
  to the developer agent is governed solely by the dev agent's
  `allowMessageFrom`. Agents previously set to `devAgentAccess: false` will now
  see the dev-agent fragment and (unless restricted via `allowMessageFrom`) be
  able to message the developer agent. Remove the dead field; to restrict the
  dev inbox, set `allowMessageFrom` on its `agent-messaging` config.   [affects: agents/*/agent.json, agents/*/plugins/agent-messaging/config.json]
- Add a `description` to each `agent.json` so the agent-directory roster reads
  well (optional but recommended; absent ⇒ the agent is listed id-only).   [affects: agents/*/agent.json]

## [0.4.4]

### Added

- **Developer agent**: `packages/harness/src/dev-agent/` is a persona
  overlay on the base template. `cognisphere agent new <name> --dev` forks the
  base + overlay, installs the cognisphere skills (`cognisphere-upgrade`,
  `create-plugin`) into the agent's own `skills/agent/`, and enables the
  telegram plugin (the dev agent's only channel); `cognisphere init`
  pre-creates the developer agent in every home (`--dev-agent <name>`,
  default `dory`). The chosen name is baked at create time into the
  `{{DevAgentId}}`/`{{DevAgentName}}` placeholders of `0.2-dev-agent.md`
  (every fork) and `1-dev-agent.md` (the dev fork). The developer agent
  owns and modifies the home's code (agents, user plugins, the app — never
  the installed harness library) and keeps `docs/harness/` + `docs/app/`
  current.
- **Plugin-driven thread reset**: `PluginInstanceContext.resetThread(channelId)`
  deletes the thread's queue rows, session binding, and session files (refusing
  while a batch is in-flight), so the next message starts a fresh pi session.
  The telegram plugin intercepts a `/reset` message (never delivered to the
  agent) and calls it, replying with a confirmation.
- **App-home docs + guidelines**: `home-template/` now ships `CLAUDE.md`
  (init copies it to `AGENT.md` too) and a `docs/` tree —
  `docs/base-harness/` (shipped user reference for the harness library +
  `skills.md`; init copies the package `CHANGELOG.md` in; refreshed by the
  upgrade skill), `docs/harness/` and `docs/app/` (deployment-owned, updated
  by the developer agent after every code change).
- Base template: new `system_prompts/0.2-dev-agent.md` fragment — a
  **Platform code changes** section telling every non-developer agent to pass
  code-change requests to `dory`.
- **Per-agent developer-agent access**: `agent.json.devAgentAccess` (default
  true). When false, the `0.2-dev-agent.md` fragment is omitted from the
  agent's system prompt and the developer agent's agent-messaging inbox
  rejects that agent's messages (403). `agent new --dev` stamps
  `devAgent: true` so the agent-messaging plugin knows which inbox to guard.

### Changed

- Web build fix: dropped stale `manualChunks` entries (`framer-motion`,
  `remark-breaks`) left behind after those deps were removed — they broke
  `vite build` (and therefore `prepack`) under current Rollup.
- Internal refactors, no intended behavior change: provider-credential
  handling extracted to `src/api/credentials.ts`; the AWS/Contabo setup
  scripts now share `scripts/lib/remote-bootstrap.sh`; assorted CLI, logger,
  and web-console cleanups.

### Breaking changes

- base template: new system_prompts/0.2-dev-agent.md fragment (route code-change requests to the developer agent; omitted when agent.json devAgentAccess=false) — copy it into each agent and replace the `{{DevAgentId}}`/`{{DevAgentName}}` placeholders with the dev agent's id/name [affects: agents/*]
- app home: new CLAUDE.md + AGENT.md + docs/{base-harness,harness,app}/ — copy from the package's home-template/, then copy the package CHANGELOG.md to docs/base-harness/CHANGELOG.md [affects: <home root>]
- app home: create the developer agent with `cognisphere agent new <name> --dev` (conventional name: dory), then set secrets.json → <name>.telegram.TELEGRAM_BOT_TOKEN and a model provider [affects: agents/]

## [0.4.3]

### Changed

- **pi upgraded to 0.81.1** (`@earendil-works/pi-ai` +
  `@earendil-works/pi-coding-agent`, from 0.80.6). pi 0.80.8 removed the
  `AuthStorage` export the harness used for OAuth subscription login; the
  harness now drives login/logout through pi-coding-agent's `ModelRuntime`
  (one shared lazy instance) and reads stored credentials via
  `readStoredCredential`. Behavior parity: same routes, same polled
  status shapes, tokens still in pi's own `<piAgentDir>/auth.json`.
  Internally the login interaction moved to pi-ai's `AuthInteraction`
  (`prompt`/`notify`): select cancellation now rejects the prompt, and
  per-prompt abort signals (manual-code paste raced against the callback
  server) clear the pending waiter state.

## [0.4.2]

### Added

- **Contabo deploy target**: `scripts/contabo/setup.sh` + `config.example`
  (`cntb`-driven provision: object storage + backup bucket, SSH-key secret,
  Cloud VPS, `~/.ssh/config` entry, `ufw` in the remote bootstrap since
  Contabo has no security groups). Re-runnable; the first run places a paid
  monthly order. Prints the four `BACKUP_*` values for the root `config`.
- `scripts/aws/backup.sh` now works against any S3-compatible store: new
  `BACKUP_S3_ENDPOINT` / `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` keys
  in the root `config.example` (blank = AWS CLI chain / IAM role, as before).

### Changed

- `scripts/server.sh start` is now the same as `restart` (secrets + build +
  `systemctl restart`, which also starts stopped units) — previously `start`
  on a running server was a silent no-op.
- `scripts/setup-server.sh` retires units/nginx site/backup cron left behind
  by a previous `APP_NAME` (matched by `WorkingDirectory`) before writing the
  new ones, so renaming the app can't leave two instances fighting over the
  ports.
- The `[0.4.0]` section below gained a breaking-change entry documenting the
  session-cwd migration gap (pi session JSONLs store the absolute harness
  path) and its rewrite recipe.

### Breaking changes

- The scaffolded lifecycle scripts changed (`server.sh`, `setup-server.sh`,
  `aws/backup.sh`, root `config.example`). Existing app homes keep their
  copies; re-copy `scripts/` and graft the new `BACKUP_S3_*` keys into
  `config` to pick up the fixes.   [affects: the app home's scripts/ + config.example (not the harness data dir)]

## [0.4.1]

### Changed

- The `Timestamp` field in every `<harness-metadata>` block now includes the
  day of week (e.g. `Fri 2026-04-17 14:30:05 IST`), for both incoming
  messages and continuation nudges. Base main-agent prompt example updated.

### Breaking changes

- Seeded base main-agent prompt changed (`Timestamp` example now shows the
  weekday). Existing agents keep their provisioned copies; re-copy or graft
  from the new seed.   [affects: agents/*/system_prompts/0.1-main-agent.md]

## [0.4.0]

### Changed

- **`cognisphere init <name>` now scaffolds an app home**, not a bare harness
  data dir: a pnpm workspace with the harness data dir at `harness/`, a
  user-facing app placeholder at `app/`, lifecycle scripts under `scripts/`
  (`setup-server.sh`, `server.sh`, `build.sh`), per-platform provisioning +
  backup under `scripts/<platform>/` (`scripts/aws/setup.sh`,
  `scripts/aws/backup.sh`, `scripts/aws/config.example`), and
  `config.example` at the root. AWS is
  the only supported deploy target for now (GWS and similar later). The agent
  skills are copied into the home root's `.claude/skills/` + `.agents/skills/`
  (not into `harness/`).
- The CLI accepts either the harness data dir or the app home as cwd
  (`./harness` is resolved automatically).
- The scaffolded `.npmrc` no longer embeds the `_authToken` line — pnpm
  refuses env-var credentials from a committed project `.npmrc`; the token
  belongs in the user's `~/.npmrc` (`scripts/setup-server.sh` writes it on a
  deployed box).

### Removed

- **`cognisphere up` / `logs` / `status`** (the `cognisphere@<id>` systemd
  user service). Deployment is the scaffolded `scripts/` now:
  `sudo ./scripts/setup-server.sh` once, then
  `git pull && sudo ./scripts/server.sh restart`.
- The `cognisphere-deploy` agent skill (superseded by the scaffolded deploy
  scripts).

### Breaking changes

- Existing harness data dirs keep working as-is (the runtime layout is
  unchanged), but deployments that used `cognisphere up` must move to the
  scripted model: create a new app home with `cognisphere init`, move the old
  harness dir's contents into its `harness/`, then `cp config.example config`,
  edit, and run `sudo ./scripts/setup-server.sh`. Remove the old
  `cognisphere@<id>` systemd user unit.   [affects: the whole harness dir]
- **Moving/renaming the harness dir breaks resumption of existing pi
  sessions.** Every pi session JSONL records the absolute working directory
  it was created in (`"cwd": …` in its header line); on resume pi validates
  that path and exits 1 if it no longer exists (`Stored session working
  directory does not exist`), so every pre-migration thread fails on its next
  message while new threads work fine. After moving the old harness contents
  to the new path, rewrite the stored cwd in place (stop the harness first):

  ```
  grep -rl '"cwd":"<OLD_HARNESS_PATH>' harness/agents/*/sessions/ \
    | xargs sed -i 's#<OLD_HARNESS_PATH>#<NEW_HARNESS_PATH>#g'
  ```

  where the paths are the absolute old/new locations of the harness data dir
  (e.g. `/home/ubuntu/myapp/lps-harness` → `/home/ubuntu/myapp/harness`).   [affects: agents/*/sessions/**/*.jsonl]

## [0.3.16]

### Added

- Every `<harness-metadata>` block now carries a `ThreadId` common field
  (after `Channel`), so agents can pass the routing id to plugin CLIs
  (`--thread-id`) without guessing it. `ThreadId` joined the reserved
  metadata keys — plugin-contributed values under that key are dropped.
- Base main-agent prompt documents `ThreadId`: what it is, that it equals
  `{{ThreadId}}`, and that it is distinct from plugin-side ids (Telegram
  chat id, Gmail thread id).

### Changed

- **agent-messaging: `POST …/api/send` now rejects requests missing
  `from_agent` or `from_thread_id` (400).** The seeded `agent-msg/send` CLI
  already required both, so only direct HTTP callers are affected.
- agent-messaging: the `[AGENT MESSAGE] from …` header prepended to the
  delivered text is gone — the text is now the sender's message verbatim.
  Sender identity travels only in metadata (`From`, `FromThread`, optional
  `Subject`); the redundant `EventType`, `to`, and `thread` metadata keys
  were dropped. The seed prompt documents the metadata fields and the
  reply recipe.
- telegram: dropped the redundant `ChatId` metadata key (always identical
  to the common `Channel` field). Seed prompt now points at `Channel`.
- gws: dropped the redundant `GmailThreadId` (identical to `Channel`) and
  `ReceivedAtUtc` (same instant as `ReceivedAt`) metadata keys. Seed
  prompt updated accordingly, including its stale `ThreadId` bullet.
- `create-plugin` agent skill: new "Event & metadata conventions" section
  (reserved/common fields, PascalCase rendering, when to emit `EventType`,
  identity-in-metadata vs content-in-text, seed-prompt sync rule) and a
  pnpm ≥ 10 `allowBuilds`/`better-sqlite3` gotcha.

### Breaking changes

- Seeded base main-agent prompt changed (`ThreadId` documented in the
  message-metadata section). Existing agents keep their provisioned
  copies; re-copy or graft from the new seed.   [affects: agents/*/system_prompts/0.1-main-agent.md]

## [0.3.15]

### Added

- New `create-plugin` agent skill: guides authoring a user-scope plugin in a
  harness's `plugins/<id>/` (contract, seed layout, per-agent enable/config,
  secrets, verification), with a tested hello-plugin template.
- The package now bundles the harness-facing agent skills
  (`cognisphere-deploy`, `cognisphere-upgrade`, `create-plugin`) under
  `skills/` (prepack), and `cognisphere init` copies them into the new
  harness dir's `.claude/skills/` and `.agents/skills/` so agents working
  inside the harness discover them.

### Breaking changes

- Existing harness dirs predate the bundled agent skills; copy them in: `cp -R node_modules/@cognisphere-sh/cognisphere-harness/skills/. .claude/skills/ && cp -R node_modules/@cognisphere-sh/cognisphere-harness/skills/. .agents/skills/`   [affects: .claude/skills/]

## [0.3.14]

### Fixed

- gws and telegram seed prompts moved from `seed/system_prompt.md` (copied
  to the agent dir root, where `assembleSystemPrompt` never reads) to
  `seed/system_prompts/plugin-<id>.md` — the layout every other plugin uses.
  Until now, neither plugin's system-prompt fragment was ever included in
  the agent's assembled prompt. The fragments load automatically on next
  agent start (seeds are re-copied every start).
- gws helper files (`format-email.ts`, `format-email-lib.mjs`,
  `format-email-lib.d.mts`) moved from loose `seed/scripts/` into the
  namespaced `seed/scripts/gws/`; the seeded `scripts/gws/format-email` CLI
  now imports the lib from its own directory.

### Breaking changes

- gws/telegram seed prompt renamed `system_prompt.md` → `system_prompts/plugin-<id>.md`; delete the stale, never-read `system_prompt.md` at the agent dir root   [affects: agents/*/system_prompt.md]
- gws helper lib namespaced under `scripts/gws/`; delete the stale loose copies `format-email.ts`, `format-email-lib.mjs`, `format-email-lib.d.mts` directly under `scripts/`   [affects: agents/*/scripts/format-email*]

## [0.3.13]

### Added

- New seeded pi extension `extensions/bash-guard.ts`: every agent `bash`
  command now runs under `set -u`, so a `$...` inside double quotes (e.g.
  `--text "costs $100"`, where bash silently expanded `$1` to nothing and
  sent "costs 00") fails loudly with an `unbound variable` error instead of
  silently corrupting CLI arguments. On that error, a quoting hint is
  appended to the tool result so the agent self-corrects. Agents can opt
  out per-command with `set +u`.

### Changed

- Base system prompt: bash tool guidelines now tell agents to single-quote
  literal text arguments (or use a file / quoted heredoc `<<'EOF'`), and
  document that commands run under `set -u`.

### Breaking changes

- New seeded file `extensions/bash-guard.ts`. Copy it from the new seed
  into existing agents.   [affects: agents/*/extensions/*]
- Bash tool guidelines section of the seeded base system prompt changed
  (single-quoting rule, `set -u` note). Graft into existing agents'
  `system_prompt.md`.   [affects: agents/*/system_prompt.md]

## [0.3.12]

### Changed

- `telegram/telegram-cli`: `send-message`, `edit-message`, and `send-file`
  captions now auto-convert standard markdown (`**bold**`, `*italic*`,
  `` `code` ``, ``` blocks, links, headers, bullets) to Telegram HTML when
  no `--parse-mode` is passed; markdown tables render as column-aligned
  monospace `<pre>` blocks (Telegram has no table markup). If Telegram
  rejects the generated HTML, the message is automatically resent as plain
  text, so formatting can never drop a message. Explicit `--parse-mode`
  keeps the previous raw behavior.
- Telegram seed prompt: agents are told to write plain markdown and not
  pass `--parse-mode`; removed the stale `--parse-mode Markdown` example.

### Breaking changes

- Seeded `scripts/telegram/telegram-cli` changed (markdown→HTML
  auto-formatting). Existing agents keep their provisioned copies; re-copy
  from the new seed to pick it up.   [affects: agents/*/scripts/telegram/*]
- Telegram section of seeded system prompts changed (markdown guidance,
  removed `--parse-mode Markdown` example). Graft into existing agents'
  `system_prompt.md`.   [affects: agents/*/system_prompt.md]

## [0.3.11]

### Changed

- Every seeded script now answers `-h`/`--help`: base-agent
  `scripts/agent/{subagent,agent-browser,ddgs,markitdown}` and plugin seeds
  `scheduler/scheduler-cli` (also bare `help`), `telegram/telegram-cli`
  (also bare `help`), and `agent-msg/send`. The three thin wrappers print a
  wrapper note (what they resolve, env knobs) and then forward to the
  underlying CLI's own help; `--help` exits 0 even when the underlying
  binary isn't installed yet. `session-reader` and `gws/format-email`
  already had `--help` and are unchanged.
- Fixed: `scheduler-cli --help` (or any invocation from outside the agent
  dir) no longer aborts before printing — the state-file init ran before
  command parsing and `set -e` killed the script when
  `plugins/scheduler/state/` didn't exist.

### Breaking changes

- Seeded scripts under `scripts/` changed (`--help` support). Existing
  agents keep their provisioned copies; graft the edits or re-copy from the
  new seeds to pick them up.   [affects: agents/*/scripts/*]

## [0.3.10]

### Added

- Optional per-provider `modelOverrides` in `.secrets/models.json`
  (`{ "<modelId>": { "contextWindow"?, "maxTokens"? } }`), layered over
  pi-ai's built-in catalog and used for context-window reporting
  (`lastContext.contextWindow` in the threads-list and usage endpoints —
  an override wins over the registry). Accepted and returned by
  `PUT/GET /api/models` (`null` per model deletes the entry). Existing
  configs without the field are unchanged.

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
