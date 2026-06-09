# pi-harness v2 — Server (implemented)

This doc describes the server's **agent-runner subsystem** as it exists
today: how an agent boots, how it routes inbound notifications, how it
runs a `pi --mode rpc` child per batch, and how every supporting
component (queue, RPC client, secrets, models, plugin registry, agent
manager) fits in. Companion docs:

- [`hld.md`](./hld.md) — long-term design spec (the contract; some sections
  describe behavior not yet built).
- [`v0-deferred.md`](./v0-deferred.md) — what v0 explicitly cut from the
  HLD, with manual workflows in place of the in-product authoring loop.

The HTTP/web-UI surface (`/api/*`, `/admin/*`, `/webhook/*`) is **out of
scope** for this document. It lives in `apps/server/src/api/` and
`apps/server/src/main.ts`; refer to those files directly. Webhook
dispatch is mentioned here only where it shapes plugin behavior (plugins
receive raw `IncomingMessage`/`ServerResponse` from the harness).

If you're new and want to read code: start in `apps/server/src/main.ts`,
follow the imports outward.

---

## Table of contents

1. [Overview](#1-overview)
2. [Process model](#2-process-model)
3. [On-disk layout](#3-on-disk-layout)
4. [Components](#4-components)
5. [Key flows](#5-key-flows)
6. [Design decisions](#6-design-decisions)
7. [Operational notes](#7-operational-notes)
8. [Limitations and future work](#8-limitations-and-future-work)

---

## 1. Overview

pi-harness is a multi-agent orchestration server. One Node process owns
many independent agents. Each agent:

- Has a stable identity (`AgentId`) and a persistent on-disk home.
- Reaches the outside world only through **plugins** (telegram,
  scheduler, admin, …).
- Runs one **`pi --mode rpc`** child process per batch of inbound
  messages, with a fresh context window each spawn but a continued
  session via `--continue` against a per-thread session directory.
- Serializes work per-thread via a per-agent SQLite queue with a small
  worker pool. Concurrent batches across threads are allowed up to
  `maxConcurrentSlots`.

Plugins are TypeScript modules that live in-process in the parent server.
They listen on the harness's `/webhook/*` surface (or run cron-style, or
poll an external service), call `ctx.notify()` to push events to their
bound agent, and ship CLI scripts the agent runs through its `bash` tool
to take outbound actions.

Agents themselves are created on disk: the operator writes `agent.json`,
populates `system_prompts/` and `workspace/`, optionally installs plugins
under `plugins/<id>/`, and either restarts the server or uses the agents
API to load the new directory. Plugin configs and provider/model
selection are edited through the web UI but persist as plain JSON on
disk, so the runner sees the same artifacts whichever path created them.

---

## 2. Process model

```
┌──────────────────────────────────────────────────────────┐
│  Node process (apps/server/src/main.ts)                  │
│                                                          │
│  HTTP listener (Hono on /api, /admin, /healthz;          │
│  raw dispatch on /webhook/<agentId>/<pluginId>/*)        │
│                            │                             │
│                            ▼                             │
│  ┌────────────────────────────────────────────────┐      │
│  │  AgentManager                                  │      │
│  │  ├── SecretsStore                              │      │
│  │  ├── ModelsStore                               │      │
│  │  ├── PluginRegistry                            │      │
│  │  └── agents: Map<id, AgentInstance>            │      │
│  │      ├── agentJson, state, error               │      │
│  │      ├── plugins: Map<id, PluginEntry>         │      │
│  │      ├── runner: AgentRunner                   │      │
│  │      │   ├── workers (Promise[])               │      │
│  │      │   └── active: Map<threadId, ActiveBatch>│      │
│  │      ├── db: AgentDb (SQLite WAL queue)        │      │
│  │      └── staleReason (pending soft-reload)     │      │
│  └────────────────────────────────────────────────┘      │
│                            │                             │
│                            ▼ spawn                       │
│            ┌────────────────────────────────┐            │
│            │  pi --mode rpc child           │            │
│            │  (one per active batch)        │            │
│            │  ↳ JSON-RPC over stdio          │            │
│            └────────────────────────────────┘            │
└──────────────────────────────────────────────────────────┘
```

- **Single Node process** holds the registry, all agents' queues, all
  plugin instances, and the HTTP server.
- **Children**: one `pi` subprocess per actively-streaming batch per
  agent. They live for the duration of the batch and exit. Tools (`read`,
  `bash`, `edit`, …) execute inside the child against the agent's cwd.
- **No cross-process coordination**: there's no IPC between agents and no
  shared queue.

---

## 3. On-disk layout

`<rootDir>` is `$PIHARNESS_ROOT_DIR` (defaults to `~/.piharness`).
`<harnessId>` is `$PIHARNESS_ID` (defaults to `default`). The harness home
is `<rootDir>/<harnessId>`.

```
<rootDir>/<harnessId>/
├── harness.json                  ← harness-wide settings ({ timezone })
├── .secrets/                     ← sensitive files; 0600. Keep out of VCS.
│   ├── secrets.json                  plaintext, agent + plugin secret buckets
│   ├── models.json                   per-provider credentials + enabled models
│   ├── users.json                    plaintext login credentials
│   └── session-key                   32-byte HMAC key for signed session cookies
├── plugins/                      ← (optional) user-space plugins; user
│   └── <plugin-id>/index.ts          plugins shadow built-ins on id collision
└── agents/
    └── <agent-id>/
        ├── agent.json
        ├── bootstrap/
        │   ├── bootstrap.sh
        │   └── requirements.txt
        ├── .venv/                ← created by bootstrap.sh; auto-activated
        ├── .vertex-sa.json       ← written at start when provider=google-vertex
        ├── system_prompts/
        │   ├── 0-base_prompt.md  ← copied from template, vars baked at create
        │   ├── 1-agent.md        ← persona, hand-written
        │   └── N-<plugin>.md     ← plugin seeds (when installed)
        ├── workspace/            ← agent's scratch space
        │   ├── index.md
        │   ├── knowledge/
        │   ├── memory/
        │   └── <ThreadId>/...
        ├── sessions/
        │   ├── .events.db        ← SQLite WAL: single `events` lifecycle table
        │   └── <ThreadId>/<sid>.jsonl
        ├── plugins/<plugin-id>/
        │   ├── config.json       ← validated against manifest.configSchema
        │   ├── state/            ← plugin-private
        │   └── inbox/            ← plugin-private (file attachments etc.)
        ├── skills/<scope>/<skill>/SKILL.md
        ├── extensions/harness-bridge.ts   ← seeded; reports entry ids (§4.7)
        ├── extensions/<scope>/{index.ts,package.json,...}
        ├── scripts/<plugin>/<cli>
        └── assets/               ← agent-authored static assets
```

Conventions worth knowing:

- `<scope>` under `skills/`, `extensions/`, `scripts/` is either `agent/`
  (operator/agent-authored) or `<plugin-id>/` (seeded by a plugin install).
- `system_prompts/*.md` is concatenated lex-sorted to form the system
  prompt sent to pi.
- `sessions/<ThreadId>/` contains exactly one canonical `<sessionId>.jsonl`
  per thread. The harness owns the filename — `sessionId` is a UUID
  generated on the thread's first batch and persisted in `.events.db`'s
  `threads` table — and passes the full path to pi via `--session`. Pi
  creates the file on its first append and writes the SessionHeader and
  every entry; the harness only reads the file (post-batch, to capture
  per-row pi entry ids).
- `.vertex-sa.json` is materialized on agent start when the provider is
  `google-vertex` (the operator pastes the SA blob into Models settings;
  the runner writes it to disk at 0600 so pi's GCP libraries can read
  it via `GOOGLE_APPLICATION_CREDENTIALS`). Removed on agent stop.
- OAuth subscription tokens (Claude Pro/Max, OpenAI Codex) live
  *outside* this tree, in pi's own `~/.pi/agent/auth.json`
  (0600, file-locked; path follows `PI_CODING_AGENT_DIR` if set).
  Written by the server's login flow via pi-coding-agent's
  `AuthStorage`, read and auto-refreshed by every spawned pi child —
  see §4.5.1.

---

## 4. Components

### 4.1 Config — `config.ts`

Env-driven for host/port/paths; harness-wide settings live in a file.
Loaded once at boot:

| Env var | Default | Used as |
|---|---|---|
| `PIHARNESS_ROOT_DIR` | `~/.piharness` | base path; multiple harnesses can share |
| `PIHARNESS_ID` | `default` | `<rootDir>/<harnessId>` is the harness home |
| `PORT` | `7331` | HTTP listen port |
| `BIND_HOST` | `127.0.0.1` | bind address |
| `SERVER_BASE_URL` | `http://${BIND_HOST}:${PORT}` | used to build `PI_WEBHOOK_BASE` |

Timezone is read from `<harnessRoot>/harness.json` (shape:
`{ "timezone": "<IANA>" }`; defaults to `UTC` if the file is missing or
malformed). It feeds the `<harness-metadata>` block on every spawned
batch and the scheduler plugin's cron timer. Edits land through
`PUT /api/harness`, which writes the file, mutates `cfg.timezone` in
place, and reloads every agent.

Path helpers: `harnessRoot`, `harnessJsonFile`, `agentsRoot`, `agentDir`,
`userPluginsRoot`. `.env` files in cwd are loaded via `dotenv`.

### 4.2 Logger — `logger.ts`

`pino` with `pino-pretty` formatting in TTY mode. `rootLogger()` and
`childLogger(scope)`. Every component logs with structured fields
(`scope`, `agentId`, `threadId`, …); `level: 50` lines are errors worth
paging on.

### 4.3 PluginRegistry — `plugin-registry.ts`

Scans two roots and dynamic-imports each plugin's `index.ts`:

1. Built-in: `apps/server/plugins/<id>/`
2. User-space: `<harnessRoot>/plugins/<id>/` (takes precedence on
   collision, so an operator can override a built-in)

The default export must be a class with a `manifest` property and a
`start(ctx)` / `stop()` pair. The registry holds `Map<pluginId, { ctor,
manifest, source, scope }>`. Use `rescan()` to add newly-dropped
user-space plugins without re-importing the ones already loaded
(modules cached by Node).

A plugin manifest declares two JSON Schemas:

- `configSchema` — validated and defaulted against
  `<agent>/plugins/<pid>/config.json` on every plugin start.
- `secretsSchema` — only keys listed in `required` block plugin start
  when unset. Keys in `properties` but absent from `required` are
  optional: surfaced in the settings UI, exported to env when set, but
  their absence is non-fatal.

### 4.4 SecretsStore — `secrets.ts`

Backing file: `<harnessRoot>/.secrets/secrets.json`. Bucketed layout:

```json
{
  "<agentId>": {
    "agent":      { "<KEY>": "<value>", ... },
    "<pluginId>": { "<KEY>": "<value>", ... }
  }
}
```

- The bucket name **`agent`** (constant `AGENT_BUCKET`) is reserved for
  keys declared in `agent.json.secretsSchema` — agent-level env that
  isn't owned by any single plugin (e.g. a TTS API key consumed directly
  by user scripts). Other bucket names are plugin ids.
- **Auto-create**: on first read, if the file is missing, the store
  writes a documented placeholder (with `_format` / `_usage` / `_example`
  keys) and chmod 0600s it.
- **Filtering**: top-level keys starting with `_` are ignored so
  placeholder docs don't masquerade as agents.
- **Cache**: read once, cached in-memory. `invalidate()` drops the
  cache; the next `resolve*` re-reads from disk. The web UI's secrets
  PUT route calls `invalidate()` and reloads the affected agents so the
  pi runtime sees fresh values without a server bounce.
- **API**:
  - `resolve(agentId, bucketId, declaredKeys[]) → { KEY: value, ... }`
    — looks up declared keys for one bucket. Used by `agent-manager` to
    feed `PluginInstanceContext.secrets` (bucket = plugin id) and for
    agent-level checks (bucket = `agent`).
  - `resolveAll(agentId) → { KEY: value, ... }` — flattens every bucket
    under one agent into a bare-key map for `pi` env. **Throws on
    collision** across buckets, so an operator who accidentally puts the
    same key in two buckets sees the conflict instead of one bucket
    silently winning.

Encryption is deferred — see §8.

### 4.5 ModelsStore + ModelsCatalog — `models-store.ts`, `models-catalog.ts`

Per-provider credentials and the operator-curated allowlist of model
ids that agents may select.

- **Catalog** (`models-catalog.ts`): static. Mirrors
  `@earendil-works/pi-coding-agent`'s provider surface. Each entry has
  `id`, `displayName`, a `credentials: CredField[]` list (the form
  fields the operator must populate), a curated `models: string[]`
  shortlist, optional `notes`, and an optional `oauth: true` flag for
  providers with subscription OAuth support (the id must match an
  entry in pi-ai's OAuth registry — currently `anthropic` and
  `openai-codex`). The `CredField.envVar` is what gets injected into
  the pi child's env at spawn.
- **Store** (`models-store.ts`): read-through (never cached) against
  `<harnessRoot>/.secrets/models.json`. Shape on disk:

  ```json
  {
    "providers": {
      "<providerId>": {
        "credentials": { "<key>": "<plaintext>", ... },
        "enabledModels": ["<modelId>", ...]
      }
    }
  }
  ```

  `getProvider(id)` returns the operator's stored config; `save(cfg)`
  rewrites the whole object at 0600.

Agent-level provider validation lives in `agent-manager.ts`
(`resolveAndValidateProvider`). At start it:

1. Looks up `agentJson.model.provider` in the catalog. Unknown
   provider → empty env, pi falls back to ambient (lets the operator
   experiment with out-of-catalog providers).
2. Requires the provider to be configured in `models.json` if a
   `model.id` is specified. A subscription-OAuth connection (tokens in
   pi's auth.json) counts as configured.
3. Refuses to start if the chosen model id isn't in the provider's
   `enabledModels` allowlist.
4. Refuses to start if any required `CredField` is empty — unless the
   provider is OAuth-connected, which substitutes for credentials
   (nothing extra is injected; the pi child resolves auth.json itself).
5. For `google-vertex`'s `serviceAccountKey` (a paste-blob JSON), writes
   the value to `<agentDir>/.vertex-sa.json` at 0600 and points
   `GOOGLE_APPLICATION_CREDENTIALS` at the path. Removed on agent stop.

The map returned merges with the secrets snapshot before going to the
pi child env; if a secret key collides with a provider env var, the
agent start fails (so an operator can't accidentally shadow a managed
credential).

### 4.5.1 OAuthLoginManager — `oauth-logins.ts`

Server-driven OAuth login flows for subscription providers (catalog
entries with `oauth: true`), exposed over `/api/models/oauth/*` (see
`docs/api.md` §7.1). Reuses pi-coding-agent's `AuthStorage` — the same
machinery behind pi's `/login` command.

**Storage decision:** tokens persist to pi's own
`<piAgentDir>/auth.json` (default `~/.pi/agent/auth.json`, 0600,
file-locked), never to models.json:

- Refresh tokens rotate on every refresh. Spawned pi children already
  refresh + persist under a file lock; a competing copy in models.json
  would go stale after the first child-side refresh and brick the
  login.
- Access tokens expire mid-session. Env-injected keys can't be updated
  on a live child, but pi re-resolves auth.json itself, so
  long-running agents survive expiry transparently.

Spawned children inherit the server's env (`runner.ts:spawnPi`), so
they read the same auth.json with zero changes to credential
injection. pi's credential priority is auth.json (api_key, then OAuth)
**before** env vars — so a connected OAuth subscription takes
precedence over an `ANTHROPIC_API_KEY` from models.json.

**Flow:** `start(providerId)` runs `AuthStorage.login()` in the
background with pi-ai's `OAuthLoginCallbacks` and resolves once the
flow surfaces its first interaction. The callbacks map onto the
polled status (`/api/models/oauth/:provider/status`) like so:

- `onAuth` → `url` + `instructions`. The browser opens the URL; either
  the provider's localhost callback server (fixed port, e.g. 53692 for
  Anthropic, 1455 for Codex) completes the flow — works when the
  harness runs on the operator's machine — or the operator pastes the
  final redirect URL back (`submitInput(kind: "text")`, wired to
  `onManualCodeInput` / `onPrompt`).
- `onSelect` → `select` (e.g. Codex: browser vs device-code login),
  answered via `submitInput(kind: "select")` with an option id;
  cancel resolves it with `undefined` (the provider treats that as a
  user cancel).
- `onDeviceCode` → `deviceCode` (`userCode` + `verificationUri`); the
  operator enters the code in a browser while pi-ai polls the token
  endpoint (abortable via the entry's `AbortController`). This is the
  path of choice when the harness is hosted remotely — no localhost
  callback involved.
- `onPrompt` → `prompt` (free-text question), answered via
  `submitInput(kind: "text")`.

One pending login per provider (the callback port is fixed); `start`
cancels any prior pending flow. On success/logout the models router
reloads running agents using the provider, same as `PUT /api/models`.

### 4.6 AgentDb — `queue.ts`

Per-agent SQLite WAL at `<agent>/sessions/.events.db`. Two tables:

- `events` — every event ever produced by `notify()`. Columns:
  `(id, ts, updated_at, plugin_id, channel_id, thread_id, is_silent,
  text, metadata, status, priority, attempts, error, pi_session_id,
  pi_entry_id)`. The last two link the row to a position in pi's
  session JSONL (file = `<threadDir>/<pi_session_id>.jsonl`, entry
  = `pi_entry_id`). `pi_entry_id` is written **in real time** during the
  batch (via `setRowEntryId`, fed by the harness-bridge extension — see
  §4.7/§4.8), so it is populated as soon as the row's user message is
  delivered, even on rows whose batch later fails or is still in-flight.
  It doubles as the **retry-mode marker**: a re-queued row that already
  carries one was delivered, so it is retried in *continue* mode (a nudge,
  not a resend) — there is no separate `retry_mode` column.
  Multiple rows in the same batch share a single `pi_entry_id`
  (concatenated prompt → one user message); each live-steer row gets
  its own. New columns are added idempotently via `ALTER TABLE` on
  open (`PRAGMA table_info` guard), so existing dev DBs survive the
  upgrade with `NULL` in the new columns.
- `threads(thread_id PRIMARY KEY, pi_session_id, created_at,
  model_provider, model_id, thinking_level)` — the canonical pi session
  id per thread, plus an optional per-thread model override. Populated on
  the thread's first batch (runner generates a UUID via `randomUUID()`
  and inserts here); re-read on every subsequent spawn so pi gets the
  same `--session` path. On agent start,
  `agent-manager.backfillThreadSessions` scans `<sessions>/<threadId>/`
  for any pre-existing `.jsonl` and seeds the table with the
  most-recently-modified one (matches what `--continue` used to pick),
  so threads from before this change keep continuity. The three
  `model_*` columns are added idempotently via `ALTER TABLE` on open and
  are `NULL` by default, meaning "inherit the agent's `agent.json`
  model"; when set (via the UI), they let one thread run a different
  model — including a different provider — than the rest of the agent's
  threads (see `spawnPi` below).

`status` advances through the lifecycle: `queued` → `in_flight` →
`done` (success), or back to `queued` on retry, or to `failed` (out
of attempts), or to `cancelled` (user abort, plugin-driven cancel,
runner stop). Rows persist after completion so the UI can render
history. The pre-v2 split into `messages`, `dead_letter`, and an
append-only `events` audit log is dropped at schema init
(`DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS dead_letter;
DROP TABLE IF EXISTS events;` runs before the new `CREATE`). Existing
dev DBs lose their old rows on the next boot — acceptable for v0.

Load-bearing methods:

- `getThreadSessionId(threadId) → string | null`,
  `setThreadSessionId(threadId, sessionId)` — read/write the
  `threads` mapping. Setter is `INSERT OR IGNORE` so the binding for a
  thread is fixed once written; the runner checks for an existing id
  before generating a new one.
- `getThreadModel(threadId) → {provider, modelId, thinkingLevel} | null`,
  `setThreadModel(threadId, provider, modelId, thinkingLevel)`,
  `clearThreadModel(threadId)` — read/write the per-thread model
  override. The setters `UPDATE` in place (returning `false` if no
  `threads` row exists yet, i.e. the thread hasn't bound a session), so
  an override can only be set on a thread that has already run a batch.
  `getThreadModel` returns `null` unless both `model_provider` and
  `model_id` are set.
- `enqueue(args) → id` — inserts a row with `status='queued'`.
- `peekHighestPriorityThread(exclude: Set<string>) → threadId | null` —
  the worker calls this with the active threads excluded so two workers
  never claim the same thread. Filters `status='queued' AND is_silent=0`
  (silent rows never wake a worker on their own; they ride along with
  the next non-silent batch).
- `dequeueBatch(threadId, continueOnly = false) → BatchMessage[]` — pulls
  `status='queued'` rows for one thread and flips them to
  `status='in_flight'` in a single transaction. With `continueOnly`, claims
  only *continue* rows (`pi_entry_id IS NOT NULL` — already delivered on a
  prior batch). The runner calls this first: if continue rows exist they form
  their own prompt (a continuation nudge), isolated from all other work, and
  the remaining resend + fresh rows are steered in afterwards. A plain call
  claims everything still queued (resend + fresh), which the runner
  concatenates into one prompt. Each `BatchMessage` carries a derived
  `retryMode` (`pi_entry_id` set → `"continue"`, else `attempts > 0` →
  `"resend"`, else fresh).
- `setRowEntryId(rowId, sessionId, entryId)` — bind one row to its pi session
  entry, called by the runner in real time as the harness-bridge extension
  reports each user-message entry id. This is what makes `pi_entry_id`
  available before exit and on failed rows.
- `markBatchDone(ids[], sessionId)` — sets `status='done'` and writes
  `pi_session_id` via `COALESCE`. Per-row `pi_entry_id`s are no longer passed
  here (written live via `setRowEntryId`). Rows stay in place.
- `markBatchCancelled(ids[], sessionId)` — terminal cancellation for
  user abort, plugin-driven cancel, runner stop. Records `sessionId`
  via COALESCE.
- `markBatchFailed(ids[], err, maxAttempts, sessionId) → { retrying[], dead[] }` —
  bumps attempts; rows past the cap get `status='failed'`, otherwise
  bounce back to `status='queued'` with `error` populated. `sessionId`
  is recorded via COALESCE so the partially-completed pi session is
  still discoverable from the row. Whether the requeued row then retries as
  continue or resend is decided entirely by its `pi_entry_id` at the next
  `dequeueBatch` — this method takes no mode argument.
- `sweepInFlight(maxAttempts)` — at runner start, every row still
  `status='in_flight'` (from a previous crash) is routed through
  `markBatchFailed`. Crash-mid-batch counts as one attempt. Because
  `pi_entry_id` is persisted live, a swept row that was already delivered
  still retries as continue.
- `requeueFailed(id) → id | null`, `removeFailed(id)` — operator-facing
  controls on failed rows. Requeue preserves the row id and its
  `pi_entry_id` (just resets status/attempts/error) — so a delivered row
  requeues as continue, not a duplicate resend. Discard hard-deletes.
- `deleteThread(threadId) → { events }` — hard-delete every `events` row
  for a thread and its `threads` row, in one transaction. The HTTP
  layer that calls this also `rm -r`'s the on-disk session directory,
  and refuses if `Runner.isThreadActive(threadId)` so the runner can't
  race with file deletion.
- `listEvents(opts)` / `countEvents(opts)` — filter/sort/paginated read
  used by the UI's Events tab. `sortBy` is whitelist-validated.

WAL mode + a single writer (the worker pool) means concurrent reads
don't block writes. The DB is opened lazily at first `startAgent` and
kept open across stop/start cycles — only `shutdown()` closes it.

### 4.7 PiRpcClient — `rpc.ts`

JSON-RPC 2.0-style frames over the `pi` child's stdin/stdout,
newline-delimited.

- Manual `\n` split on stdout (not Node's `readline`). Reason:
  `readline` treats U+2028 / U+2029 as line terminators. JSON allows
  those characters inside string values, so a JSON-RPC frame containing
  such a string would split incorrectly. `JSON.stringify` never emits
  raw `\n` outside strings, so a plain `\n` split is safe.
- Methods: `sendPrompt` (request/response), `sendSteer` (fire-and-forget
  inject), `sendAbort`, `onAgentEnd`, `onUserMessageStart`, `onHarnessEntry`,
  `waitExit`, `kill`, `endStdin`, `stderrSnapshot`.
- The whole pi event stream is read off stdout (rpc-mode forwards every
  agent event there). Three of them are surfaced to the runner:
  - `onAgentEnd(messages)` — fires once when pi's loop ends, carrying the
    run's messages so the runner can judge completion from the **shape** of
    the final message (assistant + `stopReason: "stop"` ⇒ complete) with no
    JSONL read.
  - `onUserMessageStart()` — fires on each `message_start` with role `user`
    (the prompt and each steer); the runner counts these in dispatch order to
    know which rows reached the model.
  - `onHarnessEntry({index, entryId})` — the harness-bridge extension (§4.8)
    reports each user-message session entry id over the fire-and-forget
    `setStatus` channel keyed `"pi-harness"`; the client parses it out of the
    `extension_ui_request` stream and the runner writes it via `setRowEntryId`.
- Stderr is mirrored to the structured logger and kept in a rolling
  16 KiB buffer; `stderrSnapshot()` returns the tail and is included in
  the failure event when a batch crashes.
- Auto-cancels `extension_ui_request` dialog methods. Pi sometimes
  prompts the user via these (select/confirm/input/editor); the harness
  has no human, so it replies `cancelled: true` and lets the agent
  continue. Without this, a pi extension that pops a dialog would hang
  the batch indefinitely. `setStatus` requests keyed `"pi-harness"` are
  intercepted for `onHarnessEntry` instead of being treated as UI.
- Pending RPC promises are rejected if the child exits or errors before
  responding.

### 4.8 AgentRunner — `runner.ts`

One worker pool per agent. Constructed fresh on every (re)start. Owns
nothing it doesn't get passed:

```ts
export interface RunnerOpts {
  rootDir: string;
  harnessId: string;
  agentId: string;
  agentJson: AgentJson;
  db: AgentDb;
  serverBaseUrl: string;
  timezone: string;
  envSecrets?: Record<string, string>; // provider env + flattened secrets
  log: Logger;
}
```

Public API: `start()`, `stop()`, `notify(payload)`, `abort(threadId)`,
`pauseDequeue()`, `wake()`, `activeCount` (getter), and a
`batch-completed` event. `wake()` is for HTTP paths that flip a row to
`queued` directly in the DB (requeue, force status) — they must call it
or idle workers will sit in `waitForWork()` until something else
signals.

Worker loop per slot (`maxSlots = max(1, agentJson.maxConcurrentSlots ??
1)`):

1. If `dequeuePaused` (set by a pending stale-swap; see §4.9), idle until
   signalled.
2. `peekHighestPriorityThread(exclude=active.keys())` — returns a thread
   id with pending non-silent rows that no other worker is processing.
3. `dequeueBatch(threadId, continueOnly=true)` first. If it returns rows, this
   is a **continue batch** (the prompt is just the nudge); otherwise
   `dequeueBatch(threadId)` claims the remaining resend + fresh rows for a
   normal concatenated prompt. Continue rows are never mixed with other work.
4. Spawn `pi --mode rpc` (see §4.8.1). The seeded harness-bridge agent
   extension (`<agentDir>/extensions/harness-bridge.ts`) loads with it and
   streams user-message entry ids back live.
5. Assemble the prompt. On a continue batch it is a single
   `buildContinuationNudge` (`Continuation: true`) — the continue rows are not
   re-rendered (their text is already in pi's history). Otherwise each resend
   and fresh row renders its `<harness-metadata>` + text (resend rows carry
   `Retry: true` via `attempts > 0`), joined with `\n\n`.
6. `rpc.sendPrompt(promptText)`. Phase becomes `streaming`. On a continue
   batch, `drainQueuedAsSteers` then claims the thread's remaining resend +
   fresh rows and injects them as **one combined steer** (a single
   user-message entry carrying all of them) so they ride this batch.
7. `Promise.race(agentEnded, rpc.waitExit())` — guards against pi
   crashing before emitting `agent_end`.
8. Throughout the batch, `onUserMessageStart` counts deliveries in dispatch
   order and `onHarnessEntry` writes each delivered row's `pi_entry_id` via
   `setRowEntryId` (so the link exists even if the batch later fails). User
   entry 0 maps to the prompt rows (`promptRowIds` — empty on a continue
   batch); entry i≥1 maps to the i-th steer's row *group* (`steerGroups[i-1]`
   — one row for a live `notify` steer, the whole drained set for the combined
   steer). Continue rows keep the entry id they were given on a prior batch.
9. On clean end (`agent_end` received): close stdin, await pi's exit (5s
   SIGKILL guard), then `finalizeBatch`. Completion is judged purely from the
   **shape** of the `agent_end` messages (`endOfTurn`): complete iff the last
   message is an assistant with `stopReason: "stop"`. Rows are split by
   delivery: any row whose user message never arrived → `markBatchFailed`
   `[not_delivered]` (retries as resend); delivered rows → `markBatchDone`
   when the turn completed, else `markBatchFailed` with the turn's tag
   (`[agent_error]` for `stopReason: "error"`, otherwise `[incomplete]` —
   e.g. the loop stopped on a `toolResult`). Delivered-but-failed rows already
   carry their `pi_entry_id`, so they retry as continue. With no `agent_end`
   at all, the batch is a `[crash]` and all delivered rows fail likewise.
10. On `abort(threadId)`: the runner sets `active.cancelled = true` and
    sends an `abort` frame to pi, which responds by emitting `agent_end`
    cleanly. The race resolves successfully, but the post-race check on
    `active.cancelled` throws into the catch branch, which calls
    `markBatchCancelled(ids, sessionId)` — terminal status `cancelled`,
    no retry, all rows (initial batch + delivered steers) included.
11. After every batch: emit `batch-completed` so the AgentManager can
    fire a deferred stale-swap if one is pending.

`<harness-metadata>` is built by `buildHarnessMetadata` in `runner.ts`:
a fenced block with `Timestamp`, `Plugin`, `Channel`, optional
`IsSilent` / `Retry`, then pascal-cased keys from `payload.metadata`
(reserved keys `Timestamp` / `Plugin` / `Channel` / `IsSilent` /
`Retry` / `Continuation` are filtered to prevent clobbering). The
`Retry: true` line appears when `attempts > 0`, signalling to the agent
that the prior attempt may have completed partial work. A separate
`buildContinuationNudge` emits a slim block tagged `Continuation: true`
(no plugin/channel — the originals are in history) for continue-mode
retries; see §5.3.

#### 4.8.1 `spawnPi(threadId, sessionDir, log)`

Builds argv:

```
pi --mode rpc
   --session <agentDir>/sessions/<threadId>/<sessionId>.jsonl
   --provider <thread override provider ?? agentJson.model.provider>
   --model    <thread override modelId   ?? agentJson.model.id>
   --thinking <thread override thinking ?? agentJson.model.thinkingLevel ?? "medium">
   --tools read,bash,edit,write,grep,find,ls
   --system-prompt "<assembled system prompt>"
   --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files
   --skill <agentDir>/skills            ← single dir; pi recurses for SKILL.md
   --extension <agentDir>/extensions/<X> ← per first-level entry, only
                                            when entrypoint resolvable
```

The **harness-bridge** extension (which reports user-message entry ids back
over the RPC stream — see §4.7) is **not** special-cased here: it ships as an
ordinary seeded agent extension at `<agentDir>/extensions/harness-bridge.ts`
and is picked up by the same `<agentDir>/extensions/` loop as any other
agent extension. The canonical copy lives at
`apps/server/agents/templates/base/extensions/harness-bridge.ts` and is copied
into each agent's `extensions/` dir at create time (like `0-base_prompt.md`);
an agent missing it simply loses real-time entry capture (the runner falls
back to its own `message_start` delivery count — §4.8). `--no-extensions` only
disables pi's auto-discovery; explicit `--extension` paths still load.

`--session <path>` instead of `--session-dir … --continue`: the harness
generates the `sessionId` (UUID) on the thread's first batch, persists it
in `.events.db`'s `threads` table, and passes the absolute file path on
every spawn. Pi's `SessionManager.open(path)` tolerates a non-existent
file (`loadEntriesFromFile` returns `[]`) and creates it on first append,
so the harness never has to materialize the file or know pi's
SessionHeader format. `--continue` is dropped because the explicit path
makes "continue" implicit; `--session-dir` is dropped because pi derives
the directory from `resolve(path, "..")`. This swap eliminates the
ambiguity where `--continue` picked the most-recently-modified `.jsonl`,
which broke under fork / `new_session` / extension-driven session swaps.

The `--no-*` flags suppress pi's default discovery so we control exactly
what's loaded. The `--skill` / `--extension` asymmetry is per pi:
`loadSkillsFromDir` recurses on subdirs looking for `SKILL.md`;
`loadExtension` does *not* — it expects `index.ts` / `index.js` /
`package.json` directly at the path. So one `--skill <skills-root>`
covers everything, but extensions need one `--extension` per first-level
child of `extensions/`. The runner also verifies each entrypoint exists
before passing it; pi crashes the whole run on a missing module.

Env handed to pi:

- All of `process.env`.
- If `<agentDir>/.venv/bin` exists: prepend it to `PATH`, set
  `VIRTUAL_ENV=<agentDir>/.venv`, delete `PYTHONHOME`.
- `PI_AGENT_ID = agentId`.
- `PI_WEBHOOK_BASE = ${serverBaseUrl}/webhook/${agentId}`.
- `PI_SUBAGENT_PROVIDER` / `PI_SUBAGENT_MODEL` / `PI_SUBAGENT_THINKING` —
  the agent's sub-agent model (`agentJson.subagentModel ?? agentJson.model`).
  The `scripts/agent/subagent` wrapper turns these into
  `--provider`/`--model`/`--thinking` on the `pi -p` children the agent
  spawns, so sub-agents run on the configured model instead of pi's global
  `settings.json` default. If `subagentModel` names a provider other than the
  agent default, that provider's credentials are also injected (so the
  sub-agent can authenticate); the agent default provider's key is already
  present via `envSecrets`.
- All `envSecrets` (provider env from `models.json` ⨁ every secret
  under this agent flattened to bare keys, with collisions caught at
  AgentManager construction time — see §4.9).
- If the thread's model override (see §3 `threads`) names a *different*
  provider than the agent default, that provider's credentials are
  resolved on demand (`agent-manager.resolveProviderEnv`, reading the
  live `ModelsStore`) and overlaid onto the env — `envSecrets` only
  carries the agent's default-provider key. Same-provider overrides need
  no extra credentials. Resolution happens per spawn, so an override
  change (or a newly-added provider key) takes effect on the next batch
  with no agent reload.

cwd is `<agentDir>`, so all relative paths in the system prompt
(`scripts/...`, `workspace/...`, `sessions/...`) resolve correctly.

#### 4.8.2 `notify(payload)` — auto steer-or-enqueue

Always enqueues to the durable queue first and appends a `notify` event.
Then:

- Computes `threadId` via `agentJson.threadIdStrategy` (unless the
  caller supplies `threadIdOverride`):
  `single` → `"default"`, `plugin` → `<pluginId>`, `plugin_channel` →
  `<pluginId>:<channelId>`.
- Checks if there's an active streaming batch on the same thread.
- If yes **and** `doNotSteer !== true`: builds `<harness-metadata>` +
  text, calls `rpc.sendSteer` against the live child, pushes a single-row
  group onto `active.steerGroups` (so it gets marked done with the batch).
- Else: `signalAll()` to wake an idle worker.

This means callers (admin plugin, scheduler, telegram, …) never need to
ask "is this a new prompt or a steer?". They call `notify()`; the
runner decides. There is no operator-only steer endpoint — admin is
just another plugin calling `ctx.notify()`.

`steerGroups` is an ordered array of row-id groups (not a flat `Set`) so the
live `pi_entry_id` capture can map each steer to the user-message entry pi
appended for it (stdin is serial → pi appends in dispatch order, so the i-th
steer is the (i+1)-th user message). Each group is the set of rows sharing
one steer entry: a live `notify` steer pushes a single-row group; the
continue batch's drained resend+fresh rows push one multi-row group (they go
out as a single combined steer → one entry). Steers push their group *before*
dispatching; if the write throws, the group is removed and those rows stay
pending (picked up next batch). If the batch later fails, the groups are
folded into the delivery split along with the prompt rows — a steer that
never landed retries as resend; one that landed but the turn was cut off
retries as continue. Either way attempts accrue and the row eventually
reaches the DLQ.

Silent (`isSilent: true`) and `doNotSteer: true` notifications never
wake a worker on their own — they wait for the next non-silent batch
on the same thread (or for an explicit caller-driven trigger). This is
how scheduler late-firings should land in the *next* prompt without
yanking the current one.

#### 4.8.3 `pauseDequeue()` and the stale-swap protocol

`pauseDequeue()` is a soft-stop signal: workers stop dequeuing new
threads but currently-active batches keep running (and steers to them
still land). It's used by the AgentManager when a config/secrets/models
edit lands while batches are active — see §4.9 for the swap protocol.

The flag is one-way per runner instance: it is never reset on the
same runner. Instead, once the active batches drain, the AgentManager
swaps in a fresh runner constructed with the new env snapshot.

#### 4.8.4 System prompt assembly per spawn

`assembleSystemPrompt(agentDir, threadId)`:

1. `readdirSync(<agentDir>/system_prompts).filter(d.endsWith(".md")).sort()`.
2. `readFileSync` each, trim trailing whitespace.
3. Join with `\n\n-----\n\n-----\n\n`.
4. Append `\n\n-----\n\n-----\n\nThreadId: <id>\nThreadSessions: sessions/<id>/\n`.

Agent-fixed `{{vars}}` (`AgentId`, `AgentName`, `AgentDir`, `Tools`,
`Timezone`) are baked at agent-create time via `sed` (see
`v0-deferred.md` §3.1). The only `{{var}}` left literal in the body is
`{{ThreadId}}`; the appended `ThreadId: <id>` block resolves it for the
model.

### 4.9 AgentManager — `agent-manager.ts`

The boot orchestrator and agent lookup. Tracks every agent as an
`AgentInstance` regardless of state — failed agents stay listed so the
UI / operator can see their error and fix them in place. States are
`running` / `stopped` / `failed`; plugin states are the same enum.

#### 4.9.1 Lifecycle methods

| Method | Effect |
|---|---|
| `boot()` | Scan `<root>/agents/*` and `loadAgent(id)` each one. Missing root → no agents. |
| `loadAgent(id)` (private) | Insert an `AgentInstance` shell, then call `startAgent`. Even if start fails, the shell stays in the map so the agent is visible. |
| `manualStart(id)` | `stopped`/`failed` → `running` / `failed`. Throws if already running. |
| `manualStop(id)` | `running` → `stopped`. Aborts active batches (sends abort to live pi children). |
| `restartAgent(id)` | Stop (if running) → re-read disk → start. Picks up agent.json / secrets / models edits. |
| `reloadAgent(id)` | **Soft reload.** Invalidate the secrets cache; if the agent is running and has active batches, mark it stale + `pauseDequeue()` and wait for natural drain before swapping the runner. Zero-interruption — no `Retry: true` events. |
| `reloadPlugin(id, pid)` | Bounce a single plugin in place. Invalidate secrets cache, stop the plugin instance (5s timeout), re-run `startPluginInstance`. The runner is not touched; the agent stays `running`. |
| `shutdown()` | Stop every running agent, close every db. Called on SIGINT/SIGTERM. |

Concurrent `start`/`stop`/`restart` for the same agent is serialized
by a small `transitions: Map<id, "starting" | "stopping">` lock; a
second call while one is in flight throws `LifecycleError("transition
in progress", "conflict")`.

#### 4.9.2 `startAgent(inst)` — the start path

1. **Validate the agent spec.** Read `agent.json`. If
   `agentJson.secretsSchema` is set, resolve the declared keys from the
   `agent` bucket and refuse to start if any are missing.
2. **Validate the provider.** Run `resolveAndValidateProvider` (see
   §4.5): catalog lookup, configured-provider check, enabled-model
   check, required-credential check, Vertex SA materialization. Returns
   `providerEnv` to merge into the pi child's env.
3. **Snapshot env secrets.** Call `secrets.resolveAll(agentId)`. This
   throws if any key collides across buckets. Read non-secret env from
   `agentJson.config` and validate it against `agentJson.configSchema`
   via ajv (`useDefaults: true` fills in declared defaults in place).
   The two fields are tied: declaring one without the other throws.
   Empty strings are skipped from the env (treated as unset). Check
   that no key shadows `providerEnv` or `resolvedSecrets` (collisions
   throw). Merge into
   `envSecrets = { ...providerEnv, ...resolvedSecrets, ...agentConfigEnv }`.
4. **Open the events db.** Lazy — created on first start, reused across
   stop/start cycles.
5. **Construct a fresh `AgentRunner`** with the envSecrets snapshot.
   Attach a `batch-completed` listener: if a stale-swap is pending and
   the runner's `activeCount` hits 0, fire `performStaleSwap`.
6. **Start each installed plugin** by scanning `plugins/` and calling
   `startPluginInstance(inst, pid)` for each. Per-plugin failures are
   caught and recorded as `PluginEntry{state:"failed", error}` — they
   don't sink the agent.
7. **Start the runner.** Mark the agent `running` and log a single
   `agent started` line with running/failed plugin lists.

Errors in steps 1–3 fail the whole agent: `state="failed"`, `error`
populated, no runner constructed.

#### 4.9.3 `startPluginInstance(inst, pluginId)`

1. Look up `pid` in the registry; throw if unknown (caller catches and
   records a failed `PluginEntry`).
2. Read `<plugin>/config.json` (or `{}` if missing), validate against
   `manifest.configSchema` via ajv (`useDefaults: true` fills in
   defaults in place), throw on schema failure.
3. Resolve the plugin's declared secret keys from its bucket. Throw if
   any key listed in `secretsSchema.required` is missing; keys declared
   in `properties` but absent from `required` are optional.
4. mkdir `state/` and `inbox/` under the plugin dir.
5. Construct the plugin via `new entry.ctor()`. Build a
   `PluginInstanceContext`:
   ```ts
   {
     agentId, agentDir, stateDir, inboxDir,
     config, secrets,
     timezone: cfg.timezone,
     log: childLogger(`plugin:${agentId}:${pid}`),
     httpBaseUrl: <serverBaseUrl>/webhook/<agentId>/<pid>
                  (only if the plugin defines handleHttpRequest),
     notify: (name, payload) => runner.notify({
       ...payload,
       pluginId: pid,
       metadata: { ...payload.metadata, _notification: name },
     }),
   }
   ```
6. `await pluginInstance.start(ctx)`. On success, store a running
   `PluginEntry`. On thrown error, the caller in `startAgent` /
   `reloadPlugin` records a failed entry.

#### 4.9.4 `reloadAgent` and the stale-swap protocol

The challenge: an operator edits `secrets.json` (or
`<plugin>/config.json`, or `models.json`) while batches are in flight.
We want the next batch to use the new values, but we don't want to
abort the in-flight ones — that would surface as `Retry: true` events
to the agent and may corrupt partially-done work.

The protocol:

1. `reloadAgent(id)` invalidates the secrets cache so the next
   `resolveAll` re-reads disk.
2. If the agent isn't running, return — the next `manualStart` will
   pick up the changes naturally.
3. If `staleReason` is already set, return — a swap is already pending.
4. Otherwise set `staleReason = "config or secrets edit"` and call
   `runner.pauseDequeue()`. Workers stop dequeuing new threads;
   existing active batches keep running and still accept steers.
5. If `runner.activeCount === 0` *right now*, fire `performStaleSwap`
   synchronously. Otherwise, the listener attached at runner-construct
   time (`runner.on("batch-completed", …)`) will fire it once the last
   batch drains.
6. `performStaleSwap` clears `staleReason` synchronously up-front (so a
   concurrent `batch-completed` doesn't double-fire), then calls
   `restartAgent(id)` which stops the old runner and starts a fresh
   one with re-read env. The plugins are also stop/started so they see
   fresh config too.

A `manualStop` mid-protocol overrides the pending swap by clearing
`staleReason` before the listener can fire.

Plugin-only edits use `reloadPlugin(id, pid)` instead — it bounces one
plugin without touching the runner or other plugins.

### 4.10 Types — `types.ts`

The shared type surface every component imports from. Notable shapes:

- `AgentJson` — what `agent.json` deserializes to. `model: { provider,
  id, thinkingLevel? }`, `threadIdStrategy`, `maxConcurrentSlots?`,
  `maxAttempts?`, `runtime? = "subprocess"`, optional `secretsSchema`
  for agent-level secrets, optional `configSchema` declaring the shape
  of `config` (validated with ajv `useDefaults` at start; per-property
  `type` should be `"string"` since env values are strings), and
  optional `config: Record<string, string>` for non-secret env vars
  exposed to the pi runtime (merged into env on start; collisions with
  secrets/provider env throw). `config` and `configSchema` are tied —
  setting one without the other fails the start so values can't drift
  off contract.
- `AGENT_TOOLS` — frozen list of the 7 built-in pi tools (`read`,
  `bash`, `edit`, `write`, `grep`, `find`, `ls`).
- `NotifyPayload` — what plugins pass to `ctx.notify()`. `text`,
  `channelId`, optional `metadata`, `threadIdOverride`, `doNotSteer`,
  `isSilent`, `priority`.
- `Plugin` / `PluginManifest` / `PluginInstanceContext` — the plugin
  contract.
- `BatchMessage` / `QueuedRow` — the queue row shape from JS and SQL
  sides.
- `CredField` / `ProviderCatalogEntry` / `ProviderConfig` /
  `ModelsConfig` — provider config types shared by the catalog, store,
  and AgentManager.

---

## 5. Key flows

### 5.1 Inbound notification → response

1. Plugin (e.g. `telegram`) receives an external event (webhook hit or
   poll result).
2. Plugin calls `ctx.notify("message_received", { text, channelId, ... })`.
3. The context wraps the payload with `metadata._notification = name`
   and `pluginId`, then calls `runner.notify(...)`.
4. Runner enqueues the row, appends a `notify` event, and decides
   steer-or-wake (see §4.8.2).
5. A worker picks up the batch via `peekHighestPriorityThread` /
   `dequeueBatch`, spawns pi with the assembled prompt and env, and
   awaits `agent_end`.
6. Pi may use tools (incl. running plugin CLI scripts via `bash`)
   during the run. Eventually emits `agent_end`. Worker closes stdin,
   awaits exit (5s SIGKILL guard), marks the batch (and any in-flight
   steers) done, appends `batch_end` event with `status: "done"` and
   the session file path.

### 5.2 Steer auto-detection

Same as 5.1 step 4, except an active streaming batch exists on the
same `threadId` and `payload.doNotSteer !== true`. The runner *also*
calls `rpc.sendSteer` against the live child. The row id is added to
`active.steerGroups` (as a single-row group) and merged into the "done"
set on batch completion.
If the batch fails, the steer ids ride along into `markBatchFailed` so
their attempts get bumped (rows that have been steered into N
consecutive failing batches eventually reach `status='failed'` instead
of looping forever).

### 5.3 Crash recovery

`runner.start` calls `db.sweepInFlight(maxAttempts)`:

- For every row with `status='in_flight'`: treat it as a failed attempt
  (delegate to `markBatchFailed`). Bump `attempts`, flip back to
  `status='queued'` — now eligible for re-claim.
- If `attempts >= maxAttempts`: row goes to `status='failed'`.

Boot then proceeds normally; the worker loop picks up retried rows on
its next `peekHighestPriorityThread`. How each row re-dispatches is
decided by its `pi_entry_id` (written live during the original batch):
a row that was delivered retries in **continue** mode (a single
`Continuation: true` nudge, no resend — its text is already in pi's
history), while an undelivered row retries in **resend** mode, carrying
`Retry: true`. Because `pi_entry_id` is persisted as messages are
delivered, this classification survives a full server crash.

**Completion** is judged from the shape of pi's `agent_end` frame, not a
JSONL read. `endOfTurn(messages)` returns complete only when the last
message is an assistant with `stopReason: "stop"`. Every other shape is
incomplete and routes the *delivered* rows through `markBatchFailed`
(→ continue):

- **No `agent_end` at all** (the child died) — detected by
  `Promise.race(agentEnded, rpc.waitExit())`; tagged `[crash]` with the
  stderr tail.
- **Model/API error** — pi catches it, sets the final assistant
  `stopReason: "error"`, and still emits `agent_end`; tagged
  `[agent_error]` with the `errorMessage` carried on the frame.
- **Cut off mid-step** — e.g. the loop stopped after a tool turn on a
  context cap, so the last message is a `toolResult` (or an assistant
  with `toolUse`/`length`); tagged `[incomplete]`. This is the case that
  previously required a human to type "continue"; the nudge now does it.

Separately, any row whose user message never reached the model (its
delivery index never arrived) is tagged `[not_delivered]` and retries as
resend — even when the rest of the batch completed.

Error tags make the category recoverable without re-parsing pi state:
`[crash]`, `[agent_error]`, `[incomplete]`, `[not_delivered]`, and
`[runner_error]` (an unexpected harness-side exception, e.g. spawn
failure).

### 5.4 Boot sequence

1. `loadConfig()` reads env, builds `ServerConfig`.
2. `PluginRegistry.scan()` — built-in plugins, then user-space (with
   override).
3. `new AgentManager(cfg, registry)` — constructs `SecretsStore` and
   `ModelsStore` against `<harnessRoot>/{secrets,models}.json`.
4. `am.boot()` — scans `<root>/agents/`. For each id, `loadAgent(id)`:
   - Insert `AgentInstance` shell.
   - `startAgent`: parse `agent.json`, validate agent-level secrets,
     resolve provider env (Vertex SA materialization if applicable),
     snapshot envSecrets (collision-checked), open AgentDb,
     construct AgentRunner, start each plugin, start the runner.
5. `main.ts` mounts the HTTP routes (`/api/*`, `/admin/*`, `/healthz`,
   `/webhook/*`) and listens on `cfg.port`. The HTTP surface is
   documented separately.

A `SIGINT`/`SIGTERM` triggers `am.shutdown()` → stop every running
agent (which stops every plugin via timeout-guarded
`Promise.race(instance.stop(), 5s)`, then stops the runner, then
cleans up provider artifacts), close all DBs, `process.exit(0)`.

### 5.5 Soft reload (`reloadAgent`)

Triggered when an operator edits secrets, plugin config, or
provider/model settings while the agent is running.

1. Caller invokes `am.reloadAgent(id)` (typically from a PUT route on
   the settings API).
2. `SecretsStore.invalidate()` drops the cache.
3. If the agent is `running` and not already stale: set `staleReason`,
   call `runner.pauseDequeue()`. Workers go idle on the next loop
   iteration.
4. Currently-active batches continue. Plugins keep receiving webhook
   traffic and calling `notify`; new rows queue up but won't be
   dequeued. Steers to the active batches still land (and ride along
   to completion).
5. As each active batch finishes, `runner.emit("batch-completed")`
   fires. The listener attached in step 5 of `startAgent` checks
   `staleReason` and `runner.activeCount`. When the count hits 0, it
   fires `performStaleSwap`.
6. The swap calls `restartAgent(id)` — stop the old runner (it's
   already empty), stop all plugins, then start a fresh runner with
   the re-resolved envSecrets, and re-start every plugin so it sees
   fresh config too.
7. The next worker dequeue picks up everything that piled up during
   the pause, now in the new env.

No `Retry: true` events are emitted — the in-flight batches finished
cleanly under the old config, and the queued rows go through fresh
under the new config.

### 5.6 Plugin script → in-process plugin loopback

Pattern for a plugin CLI script the agent runs via `bash`:

```bash
# scripts/<plugin>/<plugin>-cli
curl -sS -X POST "$PI_WEBHOOK_BASE/<plugin>/internal/<verb>" \
     -H 'content-type: application/json' \
     -d "$(jq -n --arg t "$1" '{text:$t}')"
```

The plugin handles `/internal/<verb>` in its `handleHttpRequest`. The
secret stays in the plugin (parent-process), even though the CLI
script runs inside pi. Alternatively, since secrets are also exposed
to pi as env vars (see §6.10), a script can `curl` an external service
with `$TELEGRAM_BOT_TOKEN` directly. Either works.

---

## 6. Design decisions

### 6.1 Subprocess runtime, JSON-RPC frames

**Decision**: spawn a `pi --mode rpc` child per batch.

**Why**: pi-coding-agent has a stable RPC API. Embedding pi as a
library would couple us to its internal types and lifecycle; subprocess
is a narrow, versioned interface.

**Cost**: ~100ms spawn per batch. Tolerable; it's also the unit of
fault isolation. A pi crash takes down one batch, not the server.

### 6.2 SQLite WAL, one DB per agent

**Decision**: per-agent `<agent>/sessions/.events.db`, WAL mode, single
writer (the worker pool).

**Why**: durable across crashes; simple to reason about; cheap to back
up; concurrent reads (event tailing for ops) don't block. Per-agent
files keep blast radius small — corruption hurts one agent.

**Cost**: not multi-host. v0 is single-process; if we go multi-host
later, swap in Postgres or NATS at this layer.

### 6.3 Manual `\n` split for JSON-RPC

**Decision**: don't use `readline`.

**Why**: `readline` treats U+2028 and U+2029 as line terminators. JSON
allows them inside string values, so a JSON-RPC frame with such a
string would be split incorrectly. `JSON.stringify` never emits raw
`\n` outside string values, so plain `\n` split is safe.

### 6.4 Concatenated batch into one prompt

**Decision**: when a worker dequeues N messages, concatenate them with
`<harness-metadata>` + text (joined by `\n\n`) and send as one
`prompt` frame.

**Why**: cheaper than one prompt per message; the model sees the full
batch as a single conversational turn and can frame its response
holistically.

**Cost**: with a very busy thread, the batch can grow large. Bound by
arrival rate × time-since-last-batch and capped pragmatically by
`maxConcurrentSlots × thread bucketing`.

### 6.5 Steer auto-detection inside `notify()`

**Decision**: every plugin (including admin) calls
`ctx.notify(name, payload)`. The runner figures out whether to enqueue
or steer based on per-thread state.

**Why**: callers shouldn't have to ask "is the agent currently
streaming?" — the runner already knows. Eliminates a duplicate code
path. The admin plugin is just one more plugin calling `notify`; it
has no special steer privileges.

### 6.6 Plugins run in the parent process

**Decision**: plugin code runs in-process; pi children only see plugin
*scripts* (CLIs the agent runs via `bash`).

**Why**: plugin code is trusted; agent code is not. Plugin holds
secrets, owns its state, integrates with external services. Keeping it
in-process keeps state management trivial (just JS).

**Cost**: a misbehaving plugin (memory leak, infinite loop) takes the
whole server with it. v0 accepts this; the plugin set is small and
audited.

### 6.7 Failed agents stay listed

**Decision**: when `startAgent` throws (bad `agent.json`, missing
secrets, unconfigured provider, unenabled model, missing credential),
the `AgentInstance` is left in the manager's map with
`state="failed"` and `error` populated. Same for plugins inside an
otherwise-running agent.

**Why**: the operator needs to *see* what's wrong to fix it. A silent
omission leaves the UI showing "no agents" when the operator knows
they have a dir on disk. Surface the error inline.

**Cost**: a corrupt agent dir keeps consuming an id; can't be cleared
without `manualStop` + fix + `manualStart`.

### 6.8 System prompt mostly baked at create-time

**Decision**: agent-fixed `{{vars}}` (`AgentId`, `AgentName`,
`AgentDir`, `Tools`, `Timezone`) are baked into
`system_prompts/0-base_prompt.md` via `sed` at agent creation. The
runner only reads + concatenates files and appends `ThreadId` /
`ThreadSessions` at the end. No regex substitution at runtime.

**Why**: the things that change per-spawn are exactly two values
(`ThreadId`, `ThreadSessions`); paying for a templating engine to
substitute them is overkill, and the model maps `{{ThreadId}}`
references in the body to the appended block on its own.

**Cost**: editing `agent.json` (e.g. renaming the agent) doesn't
auto-propagate to the prompt. Operator re-runs the `sed` step. v0
accepts this; if it bites, a `pi-harness rebake` script is a few
lines.

### 6.9 `--skill` once, `--extension` per first-level entry

**Decision**: `--skill <agentDir>/skills` (one path), `--extension
<agentDir>/extensions/<entry>` per first-level child of `extensions/`.

**Why**: pi's `loadSkillsFromDir` recurses on subdirs looking for
`SKILL.md` (so one path suffices). Pi's `loadExtension` does *not*
recurse — it expects `index.ts` / `index.js` / `package.json` at the
path itself. Asymmetric loaders → asymmetric runner code, with a
comment explaining why. Entrypoints are pre-checked because pi crashes
the whole run on a missing extension module.

### 6.10 Tools fixed at all 7

**Decision**: every agent runs with `read,bash,edit,write,grep,find,ls`.
No `tools` field on `agent.json`.

**Why**: there's no useful subset. Removing a tool just makes the
agent work harder via `bash` workarounds. Keeping the set fixed lets
us bake the tool descriptions into the system prompt template without
per-agent divergence.

### 6.11 Secrets in a single JSON file, bucketed, plaintext

**Decision**: `<harnessRoot>/.secrets/secrets.json`, plain JSON, 0600 perms.
Buckets under each agent: `agent` (reserved, for keys declared in
`agent.json.secretsSchema`) plus one per plugin id.

**Why**: one file is easy to back up, edit, version-control (in
private), or sync. Env vars don't survive process boundaries cleanly
and become unwieldy with many keys. Bucketing keeps ownership clear
(this key belongs to plugin X) and lets `resolve` scope the view a
plugin gets to its own bucket. Encryption is a separate concern that
can be bolted on as a transparent layer later (KMS, age, etc.)
without changing the API.

**Cost**: plaintext on disk. The operator's filesystem ACLs and disk
encryption are the protection in v0.

### 6.12 Secrets exposed as env to the pi runtime

**Decision**: at spawn time, the runner injects every secret under the
agent (flattened to bare keys across all buckets) into the pi child's
env, alongside provider env vars, `PI_AGENT_ID`, and
`PI_WEBHOOK_BASE`. Collisions across buckets, or between a secret
bucket and the provider env, throw at agent start.

**Why**: plugin CLI scripts the agent runs (`bash scripts/<plugin>/...`)
need to authenticate to external services. Two options:
(a) every plugin script does an authenticated loopback to the
in-process plugin, which forwards; or (b) the script reads the secret
from env directly. Option (b) is simpler — fewer moving parts, scripts
can use SDKs that read `OPENAI_API_KEY` or `GITHUB_TOKEN` as-is. The
strict collision check ensures keys don't silently shadow each other.

**Cost**: secrets are visible to anything the agent runs (bash
history, error logs, transcripts). The operator accepts this. If a
specific plugin holds a secret too sensitive for env exposure, that
plugin can decline to declare it as a secret here and route through
its own loopback URL (option (a) is still available).

### 6.13 Per-agent venv at `<agentDir>/.venv`

**Decision**: convention-driven (no `agent.json` field). The
operator's `bootstrap.sh` creates `<agentDir>/.venv`; the runner
activates it on every spawn if present.

**Why**: agents will install Python deps; they shouldn't pollute the
system Python or share deps across agents. `<agentDir>/.venv` is the
pyenv-style ergonomic default.

**Cost**: one venv per agent. Disk usage adds up; some deps
(markitdown, pyaudio, …) are heavy. Acceptable for v0.

### 6.14 Bootstrap is operator's job, not loader's

**Decision**: copying the `bootstrap/` template into a new agent dir
and running `bootstrap.sh` is part of the *creation* recipe (in
`v0-deferred.md` §3.1), not part of `agent-manager.loadAgent(id)`.

**Why**: clean creation/load separation. Creation = materialize
template. Load = read state and start runners. Earlier the loader did
the bootstrap; reverted because (a) it muddied the boundary, (b) first
boot blocked on `pip install` for ~30-60s before `agent loaded` fired.
When the deferred privileged-CRUD path comes back, the bootstrap call
goes there too — alongside the seed-copy / template-render machinery
already enumerated in `v0-deferred.md` §2.

### 6.15 Soft reload via runner swap, not in-place mutation

**Decision**: when secrets / config / models change, build a brand new
`AgentRunner` and plugin instances against the new env, then swap.
The runner is treated as immutable per env snapshot.

**Why**: `envSecrets` is snapshotted at runner construct time and
flows into every `pi` spawn. Mutating it on a live runner would mean
half the in-flight batches saw old env, half saw new — silent
inconsistency. Building a fresh runner makes the cutover atomic per
batch: every batch sees exactly one env snapshot, end-to-end.

**Cost**: a stop/start pair per reload, and a brief drain window
during which new threads queue but don't dequeue. The
`pauseDequeue` + `batch-completed` listener pair shapes this into
zero-interruption: no in-flight batch is aborted; no `Retry: true`
events are emitted. The trade is operational simplicity.

### 6.16 Provider env materialization for Vertex

**Decision**: `google-vertex`'s `serviceAccountKey` field is a paste-
blob JSON; at agent start the runner writes it to
`<agentDir>/.vertex-sa.json` at 0600 and points
`GOOGLE_APPLICATION_CREDENTIALS` at the path. Removed on agent stop.

**Why**: GCP's libraries expect a file path, not a literal JSON blob.
Materializing per-agent (instead of one shared file) keeps blast
radius small if an agent gets compromised.

**Cost**: a small file with secrets on disk. Same plaintext trade-off
as §6.11. Cleanup on stop is best-effort and logs (not throws) on
failure so the agent can still come down cleanly.

---

## 7. Operational notes

### 7.1 Spinning up a new agent

See `v0-deferred.md` §3.1 for the manual recipe. Short version:

```bash
ROOT=~/.piharness/default        # or wherever PIHARNESS_ROOT_DIR points
ID=dr-renu   NAME="Dr Renu"
mkdir -p "$ROOT/agents/$ID"/{system_prompts,workspace,sessions,plugins}
# write agent.json, sed-bake 0-base_prompt.md, write 1-agent.md, copy
# workspace/index.md and bootstrap/, run bootstrap.sh.
# Restart server (or call the agents API to load the new dir).
```

### 7.2 Editing secrets manually

```bash
$EDITOR ~/.piharness/default/.secrets/secrets.json
# {
#   "dr-renu": {
#     "agent":    { "ELEVENLABS_API_KEY": "..." },
#     "telegram": { "TELEGRAM_BOT_TOKEN": "..." },
#     "gmail":    { "GMAIL_OAUTH_TOKEN": "..." }
#   }
# }
```

The web UI's secrets PUT route writes here, invalidates the cache, and
calls `reloadAgent` so the change reaches the pi runtime without a
restart. If you edit the file by hand, restart the affected agent (or
the server) to pick up the change. Keys are exposed both to plugins
(as `PluginInstanceContext.secrets`, only the declared ones from the
plugin's own bucket) and to pi (as bare-key env vars, every bucket
under the agent flattened — see §6.12).

### 7.3 Editing models / provider config manually

```bash
$EDITOR ~/.piharness/default/.secrets/models.json
# {
#   "providers": {
#     "anthropic": {
#       "credentials": { "apiKey": "sk-ant-..." },
#       "enabledModels": ["claude-sonnet-4-5"]
#     }
#   }
# }
```

Same reload semantics as secrets: web UI PUT triggers
`reloadAgent`; hand edits need a manual restart.

### 7.4 Refreshing Python deps for an agent

```bash
$EDITOR ~/.piharness/default/agents/$ID/bootstrap/requirements.txt
bash   ~/.piharness/default/agents/$ID/bootstrap/bootstrap.sh
# pip handles "Requirement already satisfied" — script is idempotent.
# No server restart needed; the next pi spawn picks up the venv state.
```

### 7.5 Logs and observability

- **Process logs**: structured JSON via pino on stdout. Use
  `pino-pretty` (auto-applied in TTY mode) or pipe to `jq`. Key
  scopes: `agent-manager`, `agent:<id>` (the runner), `plugin:<id>:<pid>`,
  `plugin-registry`, `webhook`.
- **Per-agent event lifecycle**: `<agent>/sessions/.events.db` table
  `events` (one row per event, status reflects current state). Tail via:

  ```bash
  sqlite3 ~/.piharness/default/agents/$ID/sessions/.events.db \
    "SELECT id, ts, updated_at, status, plugin_id, thread_id, attempts \
     FROM events ORDER BY updated_at DESC LIMIT 20;"
  ```

  Filter on `status` for queue / DLQ-style inspection: `status='queued'`
  for backlog, `status='in_flight'` for running, `status='failed'` for
  dead-letter, etc. The web UI's Events tab reads this table.
- **Per-thread session JSONLs**: `<agent>/sessions/<ThreadId>/<sid>.jsonl`.
  Each session captures the model's full turn-by-turn including tool
  calls. Use `jq -c .` to read.

---

## 8. Limitations and future work

### 8.1 Known limitations (v0)

- **No agent CRUD over the runtime API** — agents are created on disk
  (manually or by future tooling). See `v0-deferred.md`.
- **No plugin install/uninstall over the runtime API** — manual on
  disk. (The web UI can edit configs and toggle secrets on already-
  installed plugins.)
- **Plaintext secrets and models config at rest**.
- **Single-process** — one Node owns everything; not horizontally
  scalable.
- **Sequential boot** — `loadAgent(id)` runs per agent; no parallelism.
  Many agents → slow boot.
- **No hot-reload of plugin code** — the registry caches the imported
  module per id. To replace a plugin's source, restart the server (or
  drop it under user-space with a *new* id).
- **Default `maxConcurrentSlots: 1`** — one batch in flight per agent.
  Operator can raise it per-agent in `agent.json`.

### 8.2 Explicitly deferred

Tracked in `v0-deferred.md` with re-introduction plans:

- Admin agent + privileged `platform` plugin (CRUD over loopback).
- Sub-agents (`pi -p` delegation; HLD §6.2, §7).
- Prompt-template loading from `prompts/<plugin-or-agent>/`.
- In-memory secret overrides (`SecretsStore.setOverride`).
- Encryption of secrets at rest.
- `agent.json.privileged` flag and `PrivilegedPluginContext`.

### 8.3 Plausible future work

- **Background bootstrap.** Don't block agent load on `pip install`;
  let the runner come up immediately and provision the venv async.
- **Multi-process / multi-host runners.** The queue is already SQLite;
  swap in Postgres or a job-queue (BullMQ, etc.) and let multiple Node
  workers claim batches. Per-agent locking via the queue's
  `in_flight` flag is already there.
- **Per-plugin secret scoping in env.** Currently the bag is flat
  (collision-checked but not namespaced). Could prefix with
  `<PLUGINID>_` for isolation; trade-off is plugin scripts need to
  know their prefix.
- **Structured agent_status streaming.** SSE/websocket from the runner
  exposing `notify`, `batch_start`, `batch_end`, plus pi's
  per-tool-call events. Useful for UIs without polling the events
  table.
- **Cross-agent event bus.** Today an agent reaches another agent
  only via shared filesystem (`workspace/knowledge/`). A pub/sub bus
  would let agents emit and subscribe to events typed by the platform.

---

## Appendix: file map

Agent-runner subsystem (HTTP API surface omitted — see
`apps/server/src/api/` directly).

| File | LOC | Role |
|---|---|---|
| `apps/server/src/main.ts` | 133 | boot, HTTP server, signal handling |
| `apps/server/src/config.ts` | 42 | env-driven config + path helpers |
| `apps/server/src/logger.ts` | 26 | pino setup |
| `apps/server/src/types.ts` | 201 | shared types (`AgentJson`, `Plugin`, provider types, …) |
| `apps/server/src/plugin-registry.ts` | 114 | dual-root plugin discovery |
| `apps/server/src/secrets.ts` | 159 | bucketed JSON-file secret store |
| `apps/server/src/models-store.ts` | 91 | read-through models.json |
| `apps/server/src/models-catalog.ts` | 490 | static provider catalog |
| `apps/server/src/oauth-logins.ts` | 170 | subscription OAuth login flows → pi's auth.json |
| `apps/server/src/queue.ts` | 395 | per-agent SQLite queue + DLQ + event log |
| `apps/server/src/rpc.ts` | 213 | JSON-RPC client to pi children |
| `apps/server/src/runner.ts` | 578 | per-agent worker pool + spawn + steer + stale-pause |
| `apps/server/src/agent-manager.ts` | 769 | boot + lifecycle + reload + provider validation |
| **subtotal (agent-runner)** | **~3 200** | |

Built-in plugins live in `apps/server/plugins/<id>/`: `admin`,
`scheduler`, `telegram`, `gws`, `gmail` (stub).
