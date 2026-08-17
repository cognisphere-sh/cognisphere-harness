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

## [0.9.0]

### Added

- **The agent owns her gws notification settings.** New agent-writable overlay
  `plugins/gws/state/settings.json`, managed by the seeded
  `scripts/gws/settings` CLI (`show|set|reset`) and re-read by the plugin on
  every poll tick — the same live-reload pattern as `routes.json`, so a change
  applies within one poll. Per-key precedence: `settings.json` →
  operator `config.json` → defaults. Overridable keys: `pollIntervalSec`,
  `gmailQuery`, `allowedSenders`, `requireAgentInTo` (`firstOfThreadOnly`
  stays operator-only).
- **Passive mailbox.** `pollIntervalSec: -1` disables polling entirely: no
  notifications, nothing marked read — the agent reads mail only when she
  chooses to search. While passive the loop still re-reads settings every
  60s, so setting a real interval again resumes within a minute (pending
  unread arrives on the next poll).
- **Settings announced on start.** Each plugin start posts one `gws_settings`
  message on the plugin's `main` channel — mailbox address, effective
  settings, routing-rule count, and how to change them — so the agent can
  re-assert her preferences after every harness restart.

### Changed

- **gws defaults: notify on all unread inbox, poll every 15 minutes.**
  `pollIntervalSec` 60 → 900 and `requireAgentInTo` true → false — by default
  the latest message of *every* unread inbox thread now wakes the agent,
  routed to its per-thread id as before; Cc/Bcc-only mail is skipped only
  when `requireAgentInTo` is switched back on. Operators who want the old
  behavior set both keys explicitly in `plugins/gws/config.json`.

### Breaking changes

- New seeded `scripts/gws/settings` — the settings overlay's CLI. Plugin seeds
  re-copy on the next agent start, so restarting each agent installs it
  [affects: agents/*/scripts/gws/]
- `system_prompts/plugin-gws.md` rewritten (still 50 lines): new inbound
  default, the Settings section, and the "ask to be kept in `To:`" outbound
  rule dropped (it existed only for the old `requireAgentInTo: true` default);
  it re-seeds on the next agent start
  [affects: agents/*/system_prompts/plugin-gws.md]
- gws skills `read-email` (1.1.1), `search-email` (1.0.1), `route-email`
  (1.0.1): wording that hardcoded the old you-in-`To` delivery rule now points
  at the agent-owned settings; they re-seed on the next agent start
  [affects: agents/*/skills/gws/]
- The default flip means an existing `plugins/gws/config.json` that never set
  `pollIntervalSec` / `requireAgentInTo` changes behavior on upgrade — set
  them explicitly to keep the old 60s / To-only behavior
  [affects: agents/*/plugins/gws/config.json]

## [0.8.25]

### Changed

- **The web UI's thread list renders task threads as a tree.** A thread spawned
  as a task (`<parent>-§-[TASK]-§-<slug>`) now nests under its parent to any
  depth, so a task thread that itself spawns tasks shows up where it belongs
  instead of as a top-level row. Each child is labeled by its task slug, rows
  indent per level with a collapse chevron, and search keeps the matching
  subtree. Replaces the flat two-level "tasks (n)" dropdown. Web-only — no
  harness artifacts change.

## [0.8.24]

### Added

- **`scheduler-cli list` takes filters.** `--thread-id ID` narrows to the
  schedules bound to one thread, `--active`/`--paused` split by state, and
  `--from WHEN [--to WHEN]` keeps only the schedules that *fire* inside a
  window, adding a `fires` array of the occurrences to each. `WHEN` is ISO
  (`2026-08-17T09:00:00Z`) or bare (`2026-08-17`, `2026-08-17 09:00`); bare
  means wall clock in the harness timezone, read from `harness.json`. Defaults
  are `--from` now and `--to` +7 days, the window is capped at 366 days, and
  `--max N` (default 50) caps the fires listed per schedule. Bare `list` is
  unchanged. Until now an agent asking "what have I got scheduled this week?"
  had to read every schedule and evaluate the crons in its head.
- **`scripts/scheduler/cron-fires`** — the fire-time evaluator behind
  `--from`/`--to`, seeded alongside `scheduler-cli`. jq cannot evaluate cron and
  `croner` is not resolvable from an agent dir (no `node_modules` of its own),
  so it is a dependency-free minute scan: timezone-aware via
  `Intl.formatToParts`, 5- and 6-field expressions, names/ranges/steps/lists,
  and the cron dom+dow OR convention. Unparseable crons come back with an
  `error` field and over-long fire lists with `"truncated": true`, so nothing
  is dropped silently. `node scripts/scheduler/cron-fires --self-check` runs
  its assertions.

### Breaking changes

- New `scripts/scheduler/cron-fires` — `scheduler-cli list --from/--to` needs
  it and exits non-zero without it. Plugin seeds re-copy on the next agent
  start, so restarting each agent installs it
  [affects: agents/*/scripts/scheduler/]
- `scripts/scheduler/scheduler-cli` gained the `list` flags; it re-seeds on the
  next agent start   [affects: agents/*/scripts/scheduler/scheduler-cli]
- `system_prompts/plugin-scheduler.md` documents the new `list` flags (34 → 41
  lines, still inside the 50-line budget); it re-seeds on the next agent start
  [affects: agents/*/system_prompts/plugin-scheduler.md]

## [0.8.23]

### Changed

- gws prompt fragment: the inbound section no longer explains *why* outbound
  mail must ask to be kept in `To:` — the rule itself is unchanged under
  **Rules**, and saying it twice spent two lines of a 50-line budget on one
  instruction.

### Breaking changes

- `system_prompts/plugin-gws.md` reworded; it re-seeds on the next agent start,
  so restarting the gws agents is all that is required
  [affects: agents/*/system_prompts/plugin-gws.md]

## [0.8.22]

### Added

- **`scripts/gws/email`** — the agent-facing Gmail CLI, seeded with the `gws`
  plugin. `email read <messageId>` (full body, `--strip-quotes`,
  `--attachments` → `plugins/gws/inbox/<messageId>/`), `email thread <threadId>`
  (skim id/from/date/snippet, or `--full` for every body), `email search
  '<gmail query>' [--max N]` (hits listed with subject/from/date/snippet — the
  raw API returns bare ids), `email labels`, and `email label <id> --add NAME
  --remove NAME --archive --read|--unread [--create] [--thread]`, which
  resolves label names to Gmail's opaque label ids and refuses an unknown name
  unless `--create`. It replaces the stdin-only `scripts/gws/format-email`.
- **Plugin-shipped skills for `gws` and `telegram`**, seeded under
  `skills/<plugin-id>/<slug>/` like the `artifacts` plugin's: `read-email`
  (full bodies, quoted history, thread skimming, attachments), `search-email`
  (Gmail query syntax, filing with labels/archive/read, and the standing
  `settings.filters` rules), `route-email` (thread-routing rules) and
  `route-chats` (Telegram chat routing).

### Changed

- **gws notifications are a preview, not the mail.** An `email_received` body
  is now the `Subject/From/To/TimeStamp` header, the **first two lines** of the
  sender's own text (quoted reply history stripped first), and the *names* of
  any attachments. Attachments are no longer downloaded at poll time — the
  agent fetches what it needs with `scripts/gws/email`, so a mailbox of long
  quoted-history threads stops spending context on mail nobody reads.
- **Plugin prompt fragments are capped at 50 lines**, with every step-by-step
  procedure moved into a plugin-owned skill: `plugin-gws.md` 204 → 50 lines,
  `plugin-telegram.md` 75 → 48. A fragment costs every turn of every thread; a
  skill costs one description line until an agent needs it.
- `docs/server.md`, `docs/base-harness/skills.md` and the `create-plugin` skill
  (v1.3.0) document the 50-line budget and what belongs in a fragment
  (identity, event shape, always-on rules) versus a skill. Both scaffold trees
  are refreshed wholesale by the upgrade skill.

### Breaking changes

- `scripts/gws/format-email` is replaced by `scripts/gws/email`. Plugin seeds
  are overwritten on every agent start but never pruned, so the stale script
  has to be deleted by hand   [affects: agents/*/scripts/gws/format-email]
- Email notifications no longer carry the full body: any agent instruction or
  knowledge note that assumes one — or that pipes `gws gmail users messages get
  … | format-email` — must be reworded to call `scripts/gws/email read
  <MessageId>`   [affects: agents/*/system_prompts/1-*.md]
- The gws/telegram prompt fragments, the new `email` CLI and the four new
  skills re-seed themselves on the next agent start; restarting the affected
  agents is all that is required   [affects: agents/*/skills/gws/]

## [0.8.21]

### Added

- **`artifacts` plugin** — agents publish self-contained static HTML (reports,
  summaries, dashboards) and share a link on the app's own domain. Each
  artifact carries a **public/private flag** that decides which of its two URLs
  works: `<app>/public/artifacts/<slug>` for anyone, or
  `<app>/private/artifacts/<slug>` behind the app's own login. **No URL carries
  a token.** The plugin serves `public/<slug>` openly and `private/<slug>`,
  `private/<slug>/meta`, `private/<slug>/share` only to callers presenting the
  `ARTIFACTS_APP_SECRET` — which is what keeps private artifacts unreachable
  from the open `/webhook/*` surface. Config: `appBaseUrl` (required). Catalog
  scope, so it runs only on agents that opt in.
- **Artifact HTML is sandboxed and responsive by construction.** Every response
  carries `Content-Security-Policy: sandbox` without `allow-same-origin` (agent
  HTML on the app's origin can never touch its cookies or storage), plus
  `Referrer-Policy: no-referrer`, `nosniff`, and an injected
  `<meta name="viewport">` when the author omitted one.
- **`app/artifacts-routes/`** in the home template — drop-in Next.js routes for
  the two paths above: a pass-through public route, and a protected page that
  renders the artifact in a sandboxed iframe under the app's own public/private
  toggle (the toggle is app chrome because a sandboxed page has an opaque
  origin and could never authenticate). Includes `lib/artifacts.ts` with a
  fail-closed `signedIn()` for the home to replace.
- **The `artifacts` seed ships a skill** — `publish-artifact` (authoring rules
  for one self-contained, mobile-and-desktop-readable file; the starter
  template; publishing, sharing, updating, taking down). First use of
  `seed/skills/<plugin-id>/<slug>/`, now documented in `create-plugin`.

### Changed

- **Deploy-time wiring for `artifacts`.** New `config` keys `ARTIFACTS_AGENT`
  and `ARTIFACTS_SESSION_COOKIE` (both blank = feature off). When the agent is
  set, `scripts/server.sh secrets` generates `ARTIFACTS_APP_SECRET` once and
  writes it to **both** `harness/.secrets/secrets.json` and `app/.env.local`,
  creates `agents/<agent>/plugins/artifacts/config.json` with
  `appBaseUrl: https://$DOMAIN`, and thereby enables the plugin on that agent.
  Existing homes get the refreshed `server.sh` + `config.example` from the
  upgrade, but must add the keys to their own `config` for anything to happen.
- **`cognisphere-upgrade` 1.3.0** — `app/artifacts-routes/` joins the
  harness-owned scaffold refresh (the one exception to "never refresh under
  `app/`"), plus a new step 4b-i that diffs the home's *copies* of those routes
  and reports drift instead of overwriting them.
- **`create-plugin` 1.2.0** — documents shipping a skill inside a plugin seed
  (`seed/skills/<id>/<slug>/`), and its description now says when a plugin is
  the right answer.
- **`create-skill` 1.2.0**, **`publish-harness` 1.1.0** — descriptions gained
  situational triggers; `publish-harness` also covers the new-plugin case of
  the shipped-artifact rule and deploy-time wiring notes.
- Docs: `docs/api.md` §10 (artifact routes + header contract),
  `docs/server.md` (plugin list, plugin-shipped skills),
  `docs/distribution-and-deployment.md` §5 (deploy-time wiring),
  `docs/base-harness/README.md`, `app/README.md`.

### Breaking changes

- New `artifacts` plugin — opt in per agent by creating the dir; it needs
  `config.json` with `appBaseUrl` and the `ARTIFACTS_APP_SECRET` secret, or set
  `ARTIFACTS_AGENT` in `config` and let `scripts/server.sh secrets` write all
  three   [affects: agents/*/plugins/artifacts/]
- Agents with the plugin enabled gain the seeded `scripts/artifacts/artifact`
  CLI, the `plugin-artifacts.md` prompt fragment and the `publish-artifact`
  skill on next start; all three are plugin-owned and must not be hand-edited
  in the agent dir   [affects: agents/*/scripts/artifacts/, agents/*/system_prompts/plugin-artifacts.md, agents/*/skills/artifacts/]

## [0.8.20]

### Changed

- **Memory is episodic; procedural guidance lives elsewhere.** The base
  prompt's **Memory** section now states that `knowledge/memory.md` holds
  events and facts only — a rule about *how to behave* belongs in
  `system_prompts/1-agent.md` when it holds globally, or in the skill for the
  procedure it governs when it only applies there. The seeded
  `knowledge/memory.md` header carries the same rule.
- **`1-*` prompt files are the agent's to edit, with admin approval.**
  Previously the base prompt routed every prompt change through the developer
  agent (`nova`). Now only `0-*` and `plugin-<id>.md` files do; `1-*` files
  the agent edits itself once the relevant admin has approved the change.

### Breaking changes

- Memory section rewritten (episodic-only) and prompt-ownership rules changed
  (`1-*` = self-edit with admin approval, not a `nova` request)   [affects: agents/*/system_prompts/0-base_prompt.md]
- `knowledge/memory.md` header gained a "what belongs here" block — episodic
  events and facts only, procedural rules go to `1-agent.md` or a skill   [affects: agents/*/knowledge/memory.md]

## [0.8.19]

### Added

- **Chat pagination.** `GET /api/agents/:id/sessions/:threadId/:sessionId`
  takes an optional `?limit=N` that returns only the newest N jsonl entries.
  The file is tail-seeked — read backwards in 256 KiB chunks until N lines
  are in hand — so opening a long-running thread costs the same as a short
  one. The response gains `hasMore` (older rows exist above the window);
  without `limit` the whole file is read and `hasMore` is `false`.
- **"Load 100 more" in the web chat.** Threads open at the newest 100
  entries and page backwards on demand, preserving scroll position. The
  window resets on thread/session switch, and a deep link
  (`?thread=&session=&entry=`) drops the limit so the targeted entry is
  always in range. The Raw JSONL tab shares the query and therefore shows
  the same window.

## [0.8.18]

### Changed

- **Base prompt: reorganised, and workspace/memory layout reworked.**
  `0-base_prompt.md` is reordered to follow the agent's actual reading path
  (Cwd → System prompts → Plugins → Skills → Threads → Message metadata →
  Communication model → Task threads → Workspace → Sessions → …), and the
  `# Guidelines` grab-bag is gone — its content folded into **Workspace**
  (persist immediately, daily notes) and **Communication model** (be
  proactive).
- **New on-disk layout for notes, knowledge and memory:**

  ```
  workspace/
    index.md
    threads/<ThreadId>/{notes.md, files/, tasks/<task-slug>/notes.md}
    daily_notes/YYYY-MM-DD.md
  knowledge/
    index.md, memory.md, files/
  ```

  - Task-thread notes moved from `workspace/taskThreads/<ThreadId>/tasks.md`
    to `workspace/threads/<ThreadId>/tasks/<task-slug>/notes.md`; the parent
    tracks its task threads in its own `notes.md → ## Tasks` section.
  - Each thread dir gains a `files/` dir for files belonging to that thread.
  - `workspace/memory/` is **removed**. Memory now lives in the cross-thread
    `knowledge/` dir as a single `knowledge/memory.md`, with `knowledge/index.md`
    indexing `knowledge/files/` (reference docs and long-term documents).
- **Memory is one grep-able file.** `knowledge/memory.md` holds sections
  separated by `-----$-----$-----$-----`, each with `name`, `lastUpdated`
  (`YYYY-MM-DD HH:MM:SS`) and a `description` covering what to remember, why,
  where it came from, the reasoning, and how long it stays relevant. The agent
  greps for the sections it needs and edits them in place instead of reading
  the whole file.
- **Notes have a fixed shape.** Every `notes.md` (thread or task) is current
  state, not a log: `## Context`, `## Tasks`, `## Decisions`, `## ToDos`,
  `## Notes`, `## References` — every entry timestamped `YYYY-MM-DD HH:MM:SS`,
  updated in place, with stale entries deleted.
- **Daily notes** now explicitly capture observations and learnings alongside
  the situation/task/result summary.
- Base-agent seeds updated to match: new `knowledge/index.md` and
  `knowledge/memory.md`, refreshed `workspace/index.md`.
- Docs updated: `docs/server.md` §3 on-disk tree and the shipped
  `docs/base-harness/README.md` agent-anatomy list.

### Breaking changes

Existing harnesses must migrate their agents' on-disk files to the new layout —
the prompt no longer describes the old paths, so anything left behind is
invisible to the agent. Per agent dir:

- `0-base_prompt.md` reordered; `# Guidelines` removed; Workspace/Task-threads
  sections rewritten for the new layout. Replace each fork's copy with the new
  seed (harness-owned).   [affects: agents/*/system_prompts/0-base_prompt.md]
- Move `workspace/memory/**` into a single `knowledge/memory.md`, one section
  per memory in the new `name` / `lastUpdated` / `description` format,
  separated by `-----$-----$-----$-----`; delete `workspace/memory/`.   [affects: agents/*/workspace/memory/**]
- Move `workspace/taskThreads/<ThreadId>/tasks.md` content into the parent
  thread's `workspace/threads/<ThreadId>/notes.md` under `## Tasks`, and any
  per-task notes to `workspace/threads/<ThreadId>/tasks/<task-slug>/notes.md`;
  delete `workspace/taskThreads/`.   [affects: agents/*/workspace/taskThreads/**]
- Rewrite each `workspace/threads/<ThreadId>/notes.md` into the fixed sections
  (`## Context`, `## Tasks`, `## Decisions`, `## ToDos`, `## Notes`,
  `## References`) with timestamped entries; drop `summary.md` by folding it
  into `## Context`.   [affects: agents/*/workspace/threads/**]
- Seed `knowledge/index.md` and `knowledge/memory.md` if absent, and move
  existing cross-thread reference docs under `knowledge/files/`.   [affects: agents/*/knowledge/**]
- Refresh `workspace/index.md` from the new seed (its `## Memory` section is
  gone; knowledge is indexed in `knowledge/index.md`).   [affects: agents/*/workspace/index.md]

## [0.8.17]

### Changed

- **Base prompt: aggressive task-thread delegation is now a rule.** The
  Task threads section opens with "You must delegate aggressively" and a
  "should a task thread do this?" default-yes framing, and the Guidelines
  checklist gained a matching bullet (bulk reads, broad searches, research,
  and self-contained multi-step work belong in task threads).
- **Web UI fixes.** Tool-call card arguments no longer overflow the card
  (long unbroken tokens now wrap), and empty thinking segments are no
  longer rendered as collapsible blocks.

### Breaking changes

- `0-base_prompt.md`'s Task threads and Guidelines sections now mandate
  aggressive delegation to task threads. Replace each fork's copy with the
  new seed (harness-owned).   [affects: agents/*/system_prompts/0-base_prompt.md]

## [0.8.16]

### Changed

- **Skill-update notices now fire on every unseen version change, reverts
  included.** 0.8.15's dedupe was keyed per (skill, new version), so a
  revert back to the version the agent had originally read stayed silent
  (1.2 → 1.3 → 1.2 sent only the 1.3 notice), leaving the agent believing
  the withdrawn version was current. `skill-update-notice.ts` now tracks a
  single "aware" version per skill — the later of the agent's own
  read/edit/write and the last notice sent — and fires whenever the file's
  current version differs from it, upgrades and reverts alike. Sending a
  notice marks that version as seen, so nothing re-fires while the file
  stays put. 0.8.15 sessions replay into the new model unchanged (read +
  sent entries replay chronologically, latest wins). The notice text now
  reads "changed after you last read it or were notified".
- The base prompt's `SystemMessage` bullet and the shipped
  `docs/base-harness/skills.md` describe the new upgrade-and-revert
  semantics (upgrade refreshes the doc wholesale).

### Breaking changes

- `skill-update-notice.ts` notification semantics changed (fires on any
  unseen version change, reverts included) — replace each fork's copy with
  the shipped version.   [affects: agents/*/extensions/skill-update-notice.ts]
- `0-base_prompt.md`'s `SystemMessage` bullet was reworded for the new
  semantics. Replace each fork's copy with the new seed
  (harness-owned).   [affects: agents/*/system_prompts/0-base_prompt.md]

## [0.8.15]

### Changed

- **Skill-update notices close the prompt-vs-read recency gap.**
  `<available_skills>` is rebuilt at every spawn, so it always advertises
  the current skill version — but it sits at position 0 of the context,
  before any `SKILL.md` read in history; agents reasoned by context order,
  trusted the (later) read, and concluded the prompt was stale instead of
  re-reading the updated skill. Two-part fix: the base prompt's Skills
  section now explains the recency inversion (the prompt is regenerated
  per spawn, so on a mismatch the *file* changed after the read) and what
  to do (act per the skill's `CHANGELOG.md`, or re-read `SKILL.md`); and a
  new seeded pi extension `skill-update-notice.ts` records the frontmatter
  version of every `SKILL.md` the agent reads (or edits/writes) as custom
  session entries, and when the file's current version no longer matches,
  injects a one-time-per-(skill, version) standalone `<harness-metadata>`
  notice — `SystemMessage: Skill "<name>" changed after you last read it
  (vX -> vY)` plus the newest changelog entry — checked at
  `before_agent_start` (spawn-gap bumps, lands before the batch's first
  LLM call) and each `turn_start` (mid-run bumps, next steer seam). State
  replays from session entries, so the once-per-version dedupe survives
  the fresh-pi-per-batch process model. The base prompt's Message metadata
  section documents the new `SystemMessage` field: a notice from the
  harness itself, to be acted on as platform instructions.
- **context-meta checkpoints are now indexed and pre-call.** One
  standalone checkpoint message before *every* LLM call, after all of that
  call's inputs are in place: `Checkpoint: <n>` (monotonic per-call
  counter, seeded across process respawns from session replay) +
  `CheckpointTokens: +<delta>` (context growth since the previous
  checkpoint: the previous response, provider-reported and exact, plus the
  new input after it — tool results / incoming message — estimated at
  chars/4 and ~1200 tokens per image). Every checkpoint re-anchors on
  provider-reported usage, so estimation error is bounded to one step and
  spans sum accurately. Checkpoints are emitted only when the next call is
  provably imminent (`before_agent_start` return for a run's first call;
  the last expected toolResult's `message_end` as a steer mid-run), which
  deletes the old deferred/`agent_settled` flush machinery and its
  empty-LLM-loop hazard. `CheckpointTokens: reset` now marks any
  unknowable delta (compaction, unknown fill). The ephemeral per-call
  `Model`/`ContextUsage` injection is unchanged.
- **Daily notes: one entry per thread per day.** The base prompt's
  end-of-task daily-note rule now says to extend the day's existing entry
  for the ThreadId instead of appending a second one.
- Shipped `docs/base-harness/skills.md` documents the recency rule and the
  skill-update notice mechanism (upgrade refreshes it wholesale).

### Breaking changes

- New seeded agent extension `skill-update-notice.ts` — copy the shipped
  file into each existing agent's `extensions/` dir.   [affects: agents/*/extensions/skill-update-notice.ts]
- `context-meta.ts` was rewritten (per-call indexed checkpoints) — replace
  each fork's copy with the shipped version.   [affects: agents/*/extensions/context-meta.ts]
- `0-base_prompt.md` gained the skills recency guidance, the
  `SystemMessage` metadata field, the rewritten Checkpoint-messages
  bullet, and the one-entry-per-thread daily-notes rule. Replace each
  fork's copy with the new seed (harness-owned).   [affects: agents/*/system_prompts/0-base_prompt.md]

## [0.8.14]

### Changed

- **End-of-task daily-note summaries** — the base prompt's Guidelines now
  require agents to append a brief summary to
  `workspace/daily_notes/YYYY-MM-DD.md` at the end of each task, tagged with
  the ThreadId: a few sentences covering the situation, the task, what was
  done, the result, and any learnings — brief prose, no headed sections.

### Breaking changes

- `0-base_prompt.md` Guidelines gained the end-of-task daily-notes summary
  rule   [affects: agents/*/system_prompts/0-base_prompt.md]

## [0.8.13]

### Changed

- **`create-skill` installed in every agent** — `agent new` now installs the
  shipped `create-skill` skill into every agent's own `skills/agent/` dir
  (previously dev-agent only; the dev agent still gets the full set). The
  base prompt's "Maintaining skills" section now states the rule explicitly:
  every piece of procedural memory must land as a skill — create a new one
  or update an existing one — following the installed `create-skill` skill.
- **Skill description spec** — a skill's description must carry four parts:
  summary, what's included (the procedures/topics/scripts/artifacts covered,
  so an agent can spot a partially relevant skill), when to use it, and the
  version; `metadata` carries `author` + `version`. Taught in the base
  prompt, the shipped `docs/base-harness/skills.md`, and `create-skill`
  (bumped to v1.1.0).

### Breaking changes

- `0-base_prompt.md`'s "Maintaining skills" section was rewritten: procedural
  memory must always land as a new or updated skill (via the installed
  `create-skill` skill), and skill descriptions must carry summary +
  what's-included + when-to-use + version. Replace each fork's copy with the
  new base file (harness-owned).   [affects: agents/*/system_prompts/0-base_prompt.md]
- Every agent now carries the `create-skill` skill. Copy the shipped
  `create-skill` skill directory into each existing agent's
  `skills/agent/create-skill/`.   [affects: agents/*/skills/agent/create-skill/**]

## [0.8.12]

### Changed

- **Deployment-owned deploy hooks (`scripts/app/`)** — the scaffolded deploy
  scripts are harness-owned and refreshed on upgrade, so app-specific deploy
  logic no longer gets edited into them. Each script now sources an optional
  deployment-owned hook: `server.sh` `gen_secrets` → `scripts/app/secrets.sh`
  (after the stock secrets), `server.sh` → `scripts/app/server.sh` (after every
  stock action except `harness`/`dev`/`logs`, same positional args — app
  lifecycle work), `setup-server.sh` → `scripts/app/setup-server.sh`
  (end, as root), `aws/setup.sh` → `scripts/app/aws-setup.sh` and
  `contabo/setup.sh` → `scripts/app/contabo-setup.sh` (end of provisioning).
  Hooks are sourced with the deploy `config` + the caller's resolved vars in
  scope. Extra deploy params go in the deployment-owned root `config`,
  documented in a deployment-owned `scripts/app/config.example` (the root
  `config.example` stays harness-owned). Only `scripts/app/README.md` (the
  contract) ships with the template. `cognisphere-upgrade` bumped to v1.2.0
  to teach the scaffold refresh this ownership split.

- **pi upgraded to 0.84.1** (`@earendil-works/pi-ai` +
  `@earendil-works/pi-coding-agent`, from 0.81.1). No harness code
  changes were required: the RPC event contract the harness consumes
  (`agent_start`, `agent_end`, `message_start`, extension `setStatus`
  reports), the session JSONL format (`CURRENT_SESSION_VERSION` still
  3), the `pi --mode rpc` flag set, and the `ExtensionAPI` /
  `ModelRuntime` surfaces the harness uses are all unchanged or
  additive. pi 0.84.0's `message_update` breaking change (deltas only,
  no cumulative `message`) does not affect us — the harness never reads
  `message_update`. `ModelRuntime.reloadConfig()` was removed upstream;
  the harness never called it.
- `core/models-catalog.ts`: refreshed the mirrored `KnownProvider` union
  to pi-ai 0.84.1 (adds `baseten`, `qwen-token-plan-individual`, and the
  `ant-ling` / `radius` / `nvidia` / `zai-coding-cn` / `qwen-token-plan`
  / `qwen-token-plan-cn` ids that had drifted in since 0.81.1). Catalog
  entries themselves are unchanged — new providers stay unlisted in the
  Models page until an entry is added.
- **System-prompt file ownership is now an explicit contract**, taught in
  the base prompt (new "System prompts" section) and documented in
  `docs/server.md` §3 and the shipped `docs/base-harness/README.md`:
  `0-*` files are harness-owned (replaced by the seed on upgrade;
  `0.1-agent-directory.md` excepted), `plugin-<id>.md` is plugin-owned
  (reseeded on every agent start — edits are clobbered), and `1-agent.md`
  is deployment-owned: identity/persona/behaviour only. Any deliberate
  override of a harness- or plugin-owned prompt file must be documented in
  the home's `docs/harness/`; undocumented divergence is drift.
- **Skills are the agent's procedural memory, and are versioned.** The base
  prompt's new "Skills" section tells agents to keep every step-by-step
  procedure (SOP, runbook) as a skill — never inlined in prompt files,
  `knowledge/`, or workspace notes — with the version stated in the skill's
  description (the only metadata pi injects into the prompt) and in
  `SKILL.md`'s `metadata.version`, plus a per-skill `CHANGELOG.md`. Skills
  are self-contained — helper scripts in the skill's `scripts/`, supporting
  files in `artifacts/`, referenced by skill-relative paths. Agents
  re-read a skill whose advertised version differs from the copy they last
  read, so version bumps propagate procedure changes to long-running
  agents, and task-thread briefs name the skill (and version) to follow
  instead of restating its steps. Shipped skills (`cognisphere-upgrade` v1.1.0, `create-plugin`
  v1.1.0) follow the convention; the `cognisphere-upgrade` skill now also
  migrates procedural content out of prompts/SOPs into versioned skills
  when an upgrade window touches an agent's prompts.
- **New shipped skill `create-skill` (v1.0.0)** — the authoring/updating
  procedure for versioned agent skills: scaffold `SKILL.md` + per-skill
  `CHANGELOG.md` + `scripts/`/`artifacts/`, semver bump rules, SOP
  migration, and pi's frontmatter constraints. Installed like the other
  cognisphere skills — into the home's `.claude/skills/` + `.agents/skills/`
  by `init`, and into the developer agent's own `skills/agent/` — so the
  dev agent carries the skill-authoring procedure as a skill itself.
  Existing homes pick it up via the upgrade's scaffold refresh; existing
  dev agents by copying it into `agents/nova/skills/agent/create-skill/`.
- `cognisphere agent new` seeds a starter `system_prompts/1-agent.md`
  (persona skeleton) so every agent dir carries the same prompt layout.

### Breaking changes

- The developer-agent persona file was renamed for layout consistency:
  `system_prompts/1-dev-agent.md` → `system_prompts/1-agent.md`. Rename the
  fork's file (contents unchanged).   [affects: agents/nova/system_prompts/*]
- `0-base_prompt.md` gained the "Skills" and "System prompts" sections and
  moved procedures out of `knowledge/SOPs/`. Replace each fork's copy with
  the new seed (local edits in a `0-*` file move to `1-agent.md`).   [affects: agents/*/system_prompts/0-base_prompt.md]
- Procedural memory must live in versioned skills: for every agent, re-read
  its `system_prompts/*.md` and `knowledge/` (incl. `knowledge/SOPs/`) and
  migrate each step-by-step procedure into
  `skills/agent/<slug>/SKILL.md` (version in description +
  `metadata.version`, per-skill `CHANGELOG.md`, helper scripts in the
  skill's `scripts/`, supporting files in `artifacts/`), updating
  `1-agent.md` to reference the skill instead of restating it.   [affects: agents/*]

## [0.8.11]

### Changed

- **Model overrides in `.secrets/models.json` now configure pi itself.**
  New `core/pi-models-sync.ts` mirrors the store's `modelOverrides` into
  pi's own models.json (`~/.pi/agent/models.json`, or
  `$PI_CODING_AGENT_DIR/models.json`) at server boot, on every agent
  start, and after `PUT /api/models` — so spawned pi children resolve the
  overridden `contextWindow`/`maxTokens` natively (model registry,
  in-context ContextUsage telemetry, and pi's compaction thresholds).
  Ownership: for providers present in the harness store, the
  `modelOverrides` key of pi's models.json is harness-owned (replaced
  wholesale, removed when the store has none); all other fields and
  providers in that file are preserved, and a corrupt file is skipped,
  never clobbered.
- **Pi-as-configured is now the single source of truth for context
  windows.** The API's reporting (`lastContext` in `/api/agents/usage`
  and the threads list) resolves context windows via pi models.json
  (`modelOverrides`, then custom model entries) with pi-ai's built-in
  catalog as fallback, instead of consulting `.secrets/models.json`
  directly — the dashboard and the agent's in-context telemetry can no
  longer disagree, and hand-written custom providers in pi's models.json
  now report correct context windows too.

## [0.8.10]

### Changed

- **`extensions/context-meta.ts`: turn-ending checkpoints now land right
  after the final response.** Instead of deferring to the next inbound
  message (which placed the checkpoint after the next user message), the
  deferred emit fires on `agent_settled` — the agent is idle there, so
  `sendMessage` appends the checkpoint directly to the session without
  triggering a turn or an LLM call. Tool-use responses keep the immediate
  steer emit (checkpoint after that response's tool results). Inbound-flush
  and seed-time catch-up remain as fallbacks.

### Breaking changes

- Seeded file `extensions/context-meta.ts` changed (turn-ending checkpoint
  placement via agent_settled). Copy it from the new seed into existing
  agents.   [affects: agents/*/extensions/*]

## [0.8.9]

### Fixed

- **`extensions/context-meta.ts`: infinite invocation loop after
  turn-ending responses (0.8.8 regression — upgrade off 0.8.8
  immediately).** A checkpoint message queued via `sendMessage` lands in
  pi's pending-message queue, and the agent loop keeps running while any
  pending message exists — so a checkpoint emitted right after a response
  with no tool calls kept provoking empty LLM calls forever, one paid call
  per cycle. Checkpoints are now sent immediately only when the response
  has tool calls (the loop continues anyway); for a turn-ending response
  the emit is deferred to the next inbound message, with the existing
  seed-time catch-up covering process exit. Per-step granularity and the
  gapless trail are unchanged.

### Breaking changes

- Seeded file `extensions/context-meta.ts` changed (checkpoint emission no
  longer extends the agent loop). Copy it from the new seed into existing
  agents.   [affects: agents/*/extensions/*]

## [0.8.8]

### Changed

- **`extensions/context-meta.ts`: checkpoints are now standalone messages
  instead of stamps on neighboring messages.** After each assistant
  response the extension injects a custom message
  (`customType: "context-meta.checkpoint"`) carrying
  `CheckpointTokens: +<n>` and a self-describing `Covers:` line, delivered
  at the first provider-legal seam (after the response's tool calls,
  before the next LLM call). Standalone messages are prune-safe: a future
  context cleaner can remove a span and its checkpoint by identity,
  instead of stranding a stamp fused into a kept message that describes
  deleted content. A checkpoint covers everything up through the nearest
  assistant response above it; seeding emits a catch-up checkpoint on
  spawn if the previous batch exited with one still queued, keeping the
  trail gapless across batches. User messages and tool results are no
  longer stamped.
- Base system prompt: `CheckpointTokens` moved out of the incoming-message
  metadata fields into the telemetry section — documents the standalone
  checkpoint messages, their coverage rule, and that they are informational
  only (never act on or reply to them).

### Breaking changes

- Seeded file `extensions/context-meta.ts` changed (standalone checkpoint
  messages replace per-message stamps). Copy it from the new seed into
  existing agents.   [affects: agents/*/extensions/*]
- Message-metadata section of the seeded base system prompt changed
  (checkpoint messages documented as standalone telemetry, FYI-only; field
  removed from the block example). Graft into existing agents'
  prompts.   [affects: agents/*/system_prompts/0-base_prompt.md]

## [0.8.7]

### Changed

- **`extensions/context-meta.ts`: checkpoint stamps now span batch
  boundaries.** On spawn the extension replays the stamping state machine
  over the persisted session instead of only seeding a baseline, so a
  batch that ended on an assistant response leaves its pending checkpoint
  recoverable — the next batch's first message carries it (the previous
  batch's final step). Only a thread's very first message has no
  `CheckpointTokens` stamp.

### Breaking changes

- Seeded file `extensions/context-meta.ts` changed (cross-batch checkpoint
  seeding). Copy it from the new seed into existing agents.   [affects: agents/*/extensions/*]

## [0.8.6]

### Added

- **New seeded pi extension `extensions/context-meta.ts`: context-window
  telemetry for the agent.** Two signals:
  - `CheckpointTokens: +<n>` — persistent per-step stamps. After each
    assistant response, the first following user message / tool result is
    stamped with the exact context growth of the completed step, computed
    from consecutive provider-reported usage totals (no estimation).
    Deltas are per-step, never cumulative, so the trail stays truthful
    across compaction; a compaction stamps `CheckpointTokens: reset`.
    Summing a span of stamps tells the agent what pruning that span would
    free. Seeded from the session JSONL on spawn, so deltas stay exact
    across batch boundaries.
  - `Model:` + `ContextUsage: <tokens>/<context window>` — ephemeral,
    injected into each LLM call's last outgoing message via the `context`
    hook; never persisted, so exactly one fresh copy exists per call.

### Changed

- Base system prompt: `<harness-metadata>` docs gain the `CheckpointTokens`
  field and a note on the latest-message `Model`/`ContextUsage` telemetry,
  with guidance to delegate/wrap up under context pressure.

### Breaking changes

- New seeded file `extensions/context-meta.ts`. Copy it from the new seed
  into existing agents.   [affects: agents/*/extensions/*]
- Message-metadata section of the seeded base system prompt changed
  (`CheckpointTokens` field, `Model`/`ContextUsage` telemetry note). Graft
  into existing agents' prompts.   [affects: agents/*/system_prompts/0-base_prompt.md]

## [0.8.5]

### Changed

- **Task-thread ids are now `<ThreadId>-§-[TASK]-§-<task-slug>`** (parent
  thread id, literal `[TASK]` marker, kebab-case task slug, joined by
  `-§-`) instead of the ambiguous `<ThreadId>-<task-slug>`. Prompts and
  the session-reader help teach the new form; thread ids remain opaque to
  the queue/runner, so no data migration — existing old-format task
  threads keep working, they just render as ordinary threads in the UI.
- **The admin web UI groups task threads under their parent thread.** The
  thread list no longer shows task threads as top-level rows; each parent
  gets a `tasks (N)` dropdown listing them by task slug (select/delete),
  the mobile picker indents them under the parent, and search matches a
  parent by its task threads. Task threads with a missing parent fall
  back to the top-level list.

### Breaking changes

- Task-thread delegation section rewritten for the new
  `<ThreadId>-§-[TASK]-§-<task-slug>` id format.   [affects: agents/*/system_prompts/0-base_prompt.md]
- Task-thread spawn note updated to the new id format.   [affects: agents/*/system_prompts/plugin-agent-messaging.md]
- `--help` text: task-thread session dir example updated to the new id
  format.   [affects: agents/*/scripts/agent/session-reader]

## [0.8.4]

### Changed

- **The upgrade skill's scaffold refresh now audits local edits first and
  guarantees they survive.** Step 4 is audit → copy → re-apply: diff every
  scaffold area against the installed package before copying, use the home's
  git history to separate local edits from upstream changes, list every
  local edit in the summary, then re-apply them on top of the fresh copies —
  so the approval diff shows upstream changes plus intact local edits. A
  local edit is dropped only with explicit operator approval; when a
  difference can't be classified, the skill stops and asks.

## [0.8.3]

### Changed

- **The upgrade skill now refreshes every harness-owned scaffold file on
  upgrade** — `scripts/`, `config.example`, `docs/base-harness/`, and
  `.claude/skills/` are re-copied wholesale from the installed package as
  part of the reviewed migration diff, so scaffold fixes reach existing
  homes even when a release didn't list them as breaking changes. User-owned
  files (`app/`, `docs/harness/`, `docs/app/`, `CLAUDE.md`, `config`, and
  the harness data dir) are never touched by the refresh.
- **The publish preflight gates shipped-artifact changes.** Changes since the
  last release to files forked into agent dirs (`src/agents/**`,
  `src/plugins/*/seed/**`) fail preflight unless the version's CHANGELOG
  section carries a `### Breaking changes` block; changed scaffold/skill
  files are listed as a reminder to note them under `### Changed`.
- Shipped docs updated to match (`docs/base-harness/skills.md`).

## [0.8.2]

### Fixed

- **The runner now exports `HARNESS_BASE_URL` (= `serverBaseUrl`) to every
  agent process.** The seeded `agent-msg/send` reads
  `${HARNESS_BASE_URL:-http://127.0.0.1:3142}`, but nothing ever set the
  variable — the runner didn't export it and the deploy scripts only define
  `HARNESS_PORT`, which the script never reads. So on any non-default port
  (`PORT` / `cognisphere serve --port`), agent-messaging silently posted to
  the wrong origin. The fallback in the seed is unchanged and now only
  covers running the script outside a runner-spawned process.

## [0.8.1]

### Fixed

- **Base prompt no longer tells agents to pass `-o json` to ddgs.** That flag
  doesn't print to stdout — it writes the results to a file in the cwd (e.g.
  `text_<query>_<timestamp>.json`), so piping to `jq` got empty input and
  agent dirs silently accumulated result files. The prompt now says to read
  the default stdout table directly and warns against `-o json`/`-o csv`.
- **Plugin requests route to `nova`, not the operator.** The communication
  model section still said to ask the operator (via the admin plugin) to
  install or write missing plugins, contradicting 0.8.0's ownership model
  (§Platform code changes). It now forwards those requests to the developer
  agent via agent-messaging, keeping the operator for what genuinely needs
  them (secrets, harness restarts).
- **`session-reader --help` documented a session layout 0.8.0 deleted.** The
  `sessions/<ThreadId>/subagents/<subAgentId>/` path example is now
  `sessions/<ThreadId>-<task-slug>/` — task-thread sessions are ordinary
  threads.
- **Wrapper headers (`agent-browser`, `ddgs`, `markitdown`) no longer cite the
  removed `pi -p` sub-agent CLI** as their reason to exist. The wrappers stay
  (the PATH/venv rationale holds); the header comments and `--help` text now
  state it without referencing sub-agents.

### Breaking changes

- Base prompt corrections (ddgs output flags, plugin-request routing) —
  replace the fork's copy with the new seed, re-applying any local
  edits.   [affects: agents/*/system_prompts/0-base_prompt.md]
- session-reader help updated for the task-thread session layout —
  re-seed.   [affects: agents/*/scripts/agent/session-reader]
- Wrapper rationale comments dropped the `pi -p` reference — re-seed (no
  behavior change).   [affects: agents/*/scripts/agent/agent-browser, agents/*/scripts/agent/ddgs, agents/*/scripts/agent/markitdown]

## [0.8.0]

### Changed

- **Sub-agents are now task threads.** The `pi -p` sub-agent CLI is gone;
  delegation runs through the core agent-messaging plugin instead. An agent
  spawns a task by messaging **itself** on a new thread id
  `<parentThreadId>-<task-slug>`; the task thread runs with the full agent
  prompt in its own context window and **must report back** to the parent
  thread (named explicitly in the brief) via `scripts/agent-msg/send` when
  done. Delegation is asynchronous — the parent ends its turn and is woken by
  the report; follow-ups and status checks are messages to the same task
  thread. Task-thread status is declared **in the brief**, never inferred from
  the sender (self-messages also arrive for other reasons).
- **One agent prompt.** `0-base_prompt.md` and `0.1-main-agent.md` merged into
  a single `0-base_prompt.md` covering identity, tools, workspace, threads,
  plugins, communication, task threads, app home, and the dev-agent hand-off.
  Ownership is now explicit: each agent owns its own agent dir (scripts,
  skills, workspace, knowledge); platform code **and software installs** go to
  the developer agent.
- **agent-messaging is a core plugin** (`CORE_PLUGIN_IDS`) — auto-installed
  and seeded on every agent alongside admin and scheduler; `cognisphere
  plugin add agent-messaging` is refused. Messaging a thread id that doesn't
  exist yet starts a fresh thread (that's how task threads spawn).
- **The developer agent is always `nova`.** `cognisphere init` creates it
  under that fixed id (`--dev-agent` flag removed), `agent new` refuses the
  name for any other agent, and the prompt templates reference `nova`
  literally — the `{{DevAgentId}}`/`{{DevAgentName}}` baking (and the
  `bakeDevAgentName`/`findDevAgentId` CLI machinery) is gone. Telegram is no
  longer auto-enabled on it; human channels are opt-in (other agents reach it
  via agent-messaging).
- **Web console:** agent messages are hyperlinked — an incoming
  `agent_message` links to the sender's thread (`From`/`FromThread`), and an
  `agent-msg/send` tool call links to the destination agent thread
  (`$PI_AGENT_ID` resolves to the current agent). Thread-only deep links
  (`?thread=`) now work without a session id.
- Base template and dev overlay moved to `src/agents/base-agent/` and
  `src/agents/nova/` inside the package (was `src/base-agent/`,
  `src/dev-agent/`). No harness-side effect; `files` already ships `src/`.

### Removed

- `subagentModel` from `agent.json` and the `PI_SUBAGENT_PROVIDER` /
  `PI_SUBAGENT_MODEL` / `PI_SUBAGENT_THINKING` env vars — task threads run on
  the agent's own model (per-thread overrides still apply).
- The `subagents` array from `GET /api/agents/:id/sessions/:threadId/usage`
  (and the legacy `sessions/<threadId>/subagents/*/` scanning behind it). The
  response is now `{ threadId, main }`; task-thread usage shows up as
  ordinary threads.

### Breaking changes

- Sub-agent CLI removed — delete the seeded wrapper and role prompt from every
  agent fork.   [affects: agents/*/scripts/agent/subagent]
- Sub-agent role prompt removed with it.   [affects: agents/*/scripts/agent/sub-agent-prompt.md]
- `0.1-main-agent.md` merged into `0-base_prompt.md` — replace the fork's
  `0-base_prompt.md` with the new seed (re-apply any local edits) and delete
  `0.1-main-agent.md`.   [affects: agents/*/system_prompts/]
- Agent-directory roster renamed — rename the file to
  `0.1-agent-directory.md` (contents unchanged; the manager only regenerates
  the new name when absent, so an un-renamed copy would duplicate the
  roster).   [affects: agents/*/system_prompts/0.3-agent-directory.md]
- `subagentModel` no longer read — remove the key where present.   [affects: agents/*/agent.json]
- agent-messaging became a core plugin — the per-agent enable dir is
  redundant (remove), and a forked copy now shadows the bundled core plugin
  (remove unless the fork is intentional).   [affects: agents/*/plugins/agent-messaging, plugins/agent-messaging]
- Developer agent id frozen to `nova` — rename the existing dev agent's dir
  (the one whose `agent.json` has `devAgent: true`, e.g. `dory`) to `nova`,
  and update any references to the old id (other agents' roster fragments,
  `allowMessageFrom` lists, workspace notes). New prompt seeds address the
  dev agent as `nova` literally.   [affects: agents/*]

## [0.7.2]

### Fixed

- **`spawn E2BIG` on every batch once `system_prompts/` crossed 128 KiB.** The
  runner passed the whole assembled system prompt as a single `--system-prompt`
  argv value. Linux caps **one** argv/env string at `MAX_ARG_STRLEN` = 131 072
  bytes — a per-string limit, independent of the ~2 MB `ARG_MAX` total — so a
  prompt tree that grew past 128 KiB killed `spawn("pi", …)` outright. Because
  `assembleSystemPrompt` hands every thread the same files, this took *all* of
  an agent's threads down at once, with `E2BIG` and no partial failure to
  narrow it down.

  The runner now writes the assembled prompt to
  `sessions/<threadId>/.system-prompt.md` (rewritten on every spawn) and passes
  **that path** to `--system-prompt`. pi's `resolvePromptInput` already reads a
  flag value as a file when it names an existing path, so this needs no pi-side
  change, and files have no length ceiling. An env var would not have worked —
  same per-string cap.

  `scripts/agent/subagent` had the identical exposure (it concatenated
  `0-base_prompt.md` + `sub-agent-prompt.md` into one `--system-prompt` string,
  so sub-agents were on course to fail the same way at the same threshold). It
  now passes the two files as paths — `--system-prompt <base>
  --append-system-prompt <role>` — which pi composes as
  `<system-prompt>\n\n<append>`, byte-identical to the concatenation it
  replaces.

### Changed

- **The developer agent now gets the `agent-messaging` plugin by default**, on
  top of telegram. It owns the home's platform code and every other agent's
  prompt tells it to route code and doc changes there — but until now nothing
  gave those agents a way to actually send it one; the request had to go
  through a human on Telegram. `cognisphere init` and
  `cognisphere agent new <name> --dev` both enable it. The inbox default is
  unchanged (`allowMessageFrom: ["*"]`, i.e. any in-harness agent).

### Breaking changes

- Existing developer agents don't have the `agent-messaging` plugin enabled;
  create the (empty) plugin dir to install the bundled copy with its default
  config.   [affects: agents/*/plugins/agent-messaging/]
- `scripts/agent/subagent` passes the sub-agent system prompt as two file
  paths instead of one concatenated string (operator edits survive — merge
  rather than overwrite).   [affects: agents/*/scripts/agent/subagent]

## [0.7.1]

### Added

- **gws routing on the Gmail thread id** — `scripts/gws/routes add` takes a
  new `--gmail-thread-id RE` (rule field `gmailThreadId`), matched as an
  **anchored**, case-insensitive regex against the raw Gmail thread id — a
  plain id is an exact match, `a|b` a set. This is the precise way to park
  replies: a reply always stays in the Gmail thread of the message it
  answers, so routing on that id captures the follow-ups to one mail and
  nothing else, where `--from`/`--subject` also catch unrelated mail. A rule
  still needs at least one of `--from` / `--subject` / `--gmail-thread-id`,
  and when several are given all must match; first matching rule wins.

### Breaking changes

*(Nothing breaks — rules without `gmailThreadId` behave exactly as before.)*

- `scripts/gws/routes` gained the `--gmail-thread-id` flag, and
  `system_prompts/plugin-gws.md`'s "Routing rules" section documents it
  (operator edits survive — merge rather than overwrite).   [affects: agents/*/scripts/gws/routes, agents/*/system_prompts/plugin-gws.md]

## [0.7.0]

### Added

- **Telegram thread-routing rules** — `plugins/telegram/state/routes.json`,
  managed by the seeded `scripts/telegram/routes` CLI (`add | list |
  remove`), mirrors the gws routing added in 0.6.0. A rule maps a chat id to
  a thread id of the agent's choosing, overriding the agent's
  `threadIdStrategy`: `routes add --name ops --thread-id ops-room --chat
  '-100.*'`. `--chat` is an **anchored**, case-insensitive regex matched
  against the chat id — a plain id is an exact match, `.*` is a wildcard,
  `123|456` a set. First matching rule wins; the plugin re-reads the file on
  every batch of updates, so a new rule takes effect immediately. `/reset`
  in a routed chat resets the routed thread.

### Changed

- **`PluginInstanceContext.resetThread` takes an optional second argument**
  — `resetThread(channelId, threadIdOverride?)`. Plugins that route a
  channel to a custom thread pass the same override they gave `notify`, so
  the reset hits the thread the messages actually landed in. Omitted → the
  previous `threadIdStrategy` mapping, unchanged.

### Breaking changes

*(Nothing breaks — the routing CLI is a new on-disk artifact an existing
home syncs to adopt; agents without `routes.json` behave exactly as before.)*

- New seeded script `scripts/telegram/routes` and a "Routing rules" section
  in `system_prompts/plugin-telegram.md` (operator edits survive — merge
  rather than overwrite).   [affects: agents/*/scripts/telegram/routes, agents/*/system_prompts/plugin-telegram.md]

## [0.6.2]

### Changed

- **Base agent knows about the app home.** `0.1-main-agent.md` gained a
  `# The app home` section pointing every agent at the repo above its agent
  dir: `../../../app/` (the user-facing frontend users see in a browser),
  `../../../docs/` (`base-harness/` platform reference, `harness/` this
  deployment's agents/plugins, `app/` the frontend), plus `harness/` and
  `scripts/`. The `# Platform code changes` hand-off now covers the app and
  the docs explicitly — read freely, route every change to the developer
  agent, report stale docs there.
- **Developer agent's `agent.json.description`** (what the agent-directory
  roster shows other agents) now names the frontend app and the docs duty:
  "…owns and modifies this deployment's platform code — agent
  prompts/scripts, forked plugins, the user-facing frontend app, deploy
  scripts — and keeps docs/harness + docs/app current."

### Breaking changes

*(Nothing breaks — both are on-disk artifacts an existing home must sync to
adopt; old copies keep working untouched.)*

- `system_prompts/0.1-main-agent.md` gained the app-home + docs sections
  (operator edits survive — merge rather than overwrite; `{{DevAgentId}}` /
  `{{DevAgentName}}` are baked at fork time, so substitute the dev agent's
  actual id when hand-merging).   [affects: agents/*/system_prompts/0.1-main-agent.md]
- The developer agent's `agent.json.description` is only written at
  `agent new --dev` time; existing homes keep the old one-liner until
  edited.   [affects: agents/*/agent.json]

## [0.6.1]

### Changed

- **Default HTTP port is now `3142`** (was `7331`) — `PORT` / `cognisphere
  serve --port` still override it. Updated everywhere the old default was
  baked in: `config.ts`, the CLI's `DEFAULT_PORT`, the web dev-server proxy
  target, the scaffold's `HARNESS_PORT` default, the seeded `agent-msg/send`
  fallback base URL, and the docs.

### Breaking changes

- Existing homes pin `HARNESS_PORT=7331` in their `config`, so they keep
  serving on 7331 — but the re-seeded `scripts/agent-msg/send` now falls back
  to `127.0.0.1:3142`, which breaks agent-to-agent messaging. Either set
  `HARNESS_PORT=3142` in `config` (then re-run `scripts/setup-server.sh` to
  regenerate the systemd unit + nginx vhost, and restart), or keep 7331 and
  export `HARNESS_BASE_URL=http://127.0.0.1:7331` into the harness
  environment.   [affects: config, scripts/setup-server.sh]

## [0.6.0]

### Added

- **gws thread routing.** The `gws` plugin now reads routing rules from
  `plugins/gws/state/routes.json` on every poll; the first rule whose
  `from` / `subject` patterns match an inbound thread replaces the default
  harness thread id (`<Subject>[<gmailThreadId>]`) with the rule's own
  `threadId`. Patterns are case-insensitive, unanchored regexes, so a plain
  string is a substring match. Lets an agent mail someone from a thread and
  have the reply land back in that same thread instead of opening a new one.
- **`scripts/gws/routes` CLI** (seeded with the plugin): `add|list|remove`,
  atomic writes, rules take effect within one poll interval. A rule with
  neither `--from` nor `--subject` is rejected — it would capture every
  inbound email. Documented in the plugin's system prompt; existing homes
  pick both up automatically (the gws seed is re-copied on plugin start).

## [0.5.1]

### Added

- **Per-unit restart.** `scripts/server.sh` `start`/`stop`/`restart` now take an
  optional `app`|`harness` target to bounce a single systemd unit; omit it for
  both (the deploy loop is unchanged). `restart app` builds and restarts only
  the app unit — applying an app-only change without touching the harness.
- **Developer agent ships app changes itself.** The dev-agent prompt now tells
  it to apply `app/` changes live via `sudo ./scripts/server.sh restart app`
  (its own session survives, since the app is a separate unit), and to leave
  harness restarts to the operator — restarting the harness would kill its own
  turn mid-run; the interrupted turn is requeued and swept back in on boot.

### Breaking changes

*(No behavior breaks — both entries are on-disk artifacts an existing home must
sync to adopt the feature; old copies keep working untouched.)*

- `scripts/server.sh` gained the optional `app`|`harness` restart target.   [affects: scripts/server.sh]
- The developer agent's `1-dev-agent.md` prompt gained the app-restart
  instructions (operator edits survive — re-seed or merge if customised).   [affects: agents/*/system_prompts/1-dev-agent.md]

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
