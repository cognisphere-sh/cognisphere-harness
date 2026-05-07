# pi-harness v2 — Server (implemented)

This document describes the server as it exists today: what's built, why
it's built that way, and where it's headed. Companion docs:

- [`hld.md`](./hld.md) — long-term design spec (the contract; some sections
  describe behavior that isn't built yet).
- [`v0-deferred.md`](./v0-deferred.md) — what the implementation explicitly
  cut from the HLD, with the manual workflows v0 expects in place of the
  in-product authoring loop, and a re-introduction plan.

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
- Reaches the outside world only through **plugins** (telegram, gmail,
  scheduler, admin, …).
- Runs one **`pi --mode rpc`** child process per batch of inbound messages,
  with a fresh context window each spawn but a continued session via
  `--continue` against a per-thread session directory.
- Serializes work per-thread via a per-agent SQLite queue with a small
  worker pool. Concurrent batches across threads are allowed up to
  `maxConcurrentSlots`.

Plugins are TypeScript modules that live in-process in the parent server.
They listen on the harness's HTTP `/webhook/*` surface (or run cron-style,
or whatever they want), call `ctx.notify()` to push events to their bound
agent, and ship CLI scripts that the agent runs through its `bash` tool to
take outbound actions.

Agent creation is **manual on disk** in v0 — the operator writes
`agent.json`, drops template files into the agent dir, and restarts. The
admin agent + privileged `platform` plugin that would automate this
(CRUD-over-HTTP) are deferred; see `v0-deferred.md`.

---

## 2. Process model

```
┌──────────────────────────────────────────────────────────┐
│  Node process (apps/server/src/main.ts)                  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │  Hono /admin │  │ raw /webhook │  │ /healthz     │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                 │                 │            │
│         ▼                 ▼                 ▼            │
│  ┌────────────────────────────────────────────────┐      │
│  │  AgentManager                                  │      │
│  │  ├── SecretsStore                              │      │
│  │  ├── PluginRegistry                            │      │
│  │  └── agents: Map<id, AgentInstance>            │      │
│  │      ├── plugins: Map<id, PluginEntry>         │      │
│  │      ├── runner: AgentRunner                   │      │
│  │      │   ├── workers (Promise[])               │      │
│  │      │   └── active: Map<threadId, ActiveBatch>│      │
│  │      └── db: AgentDb (SQLite WAL queue)        │      │
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
├── secrets.json                  ← plaintext, plugin secrets keyed by agent+plugin
├── plugins/                      ← (optional) user-space plugins, take
│   └── <plugin-id>/index.ts          precedence over built-ins on collision
└── agents/
    └── <agent-id>/
        ├── agent.json
        ├── bootstrap/
        │   ├── bootstrap.sh
        │   └── requirements.txt
        ├── .venv/                ← created by bootstrap.sh; auto-activated
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
        │   ├── .queue.db         ← SQLite WAL: messages + dead_letter + events
        │   └── <ThreadId>/<sid>.jsonl
        ├── plugins/<plugin-id>/
        │   ├── config.json       ← validated against manifest.configSchema
        │   ├── notifications.json
        │   ├── state/            ← plugin-private
        │   └── inbox/            ← plugin-private (file attachments etc.)
        ├── skills/<scope>/<skill>/SKILL.md
        ├── extensions/<scope>/{index.ts,package.json,...}
        ├── scripts/<plugin>/<cli>
        └── assets/               ← agent-authored static assets
```

Conventions worth knowing:

- `<scope>` under `skills/`, `extensions/`, `scripts/` is either `agent/`
  (operator/agent-authored) or `<plugin-id>/` (seeded by a plugin install).
- `system_prompts/*.md` is concatenated lex-sorted to form the system
  prompt sent to pi.
- `sessions/<ThreadId>/` is owned by pi (`--session-dir`); the harness
  doesn't write JSONLs there.

---

## 4. Components

### 4.1 Config — `config.ts`

Env-driven, no config file. Loaded once at boot:

| Env var | Default | Used as |
|---|---|---|
| `PIHARNESS_ROOT_DIR` | `~/.piharness` | base path; multiple harnesses can share |
| `PIHARNESS_ID` | `default` | `<rootDir>/<harnessId>` is the harness home |
| `PORT` | `7331` | HTTP listen port |
| `BIND_HOST` | `127.0.0.1` | bind address |
| `SERVER_BASE_URL` | `http://${BIND_HOST}:${PORT}` | used to build `PI_WEBHOOK_BASE` |
| `TZ` | `UTC` | timezone for `<harness-metadata>` timestamps |

Path helpers: `harnessRoot`, `agentsRoot`, `agentDir`, `userPluginsRoot`.
`.env` files in cwd are loaded via `dotenv`.

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
manifest, source }>`. Use `rescan()` to refresh after the operator drops
a new plugin in user-space.

### 4.4 SecretsStore — `secrets.ts`

Backing file: `<harnessRoot>/secrets.json`. Format:

```json
{
  "<agentId>": {
    "<pluginId>": { "<KEY>": "<value>", ... },
    "<pluginId>": { ... }
  },
  "<agentId>": { ... }
}
```

- **Auto-create**: on first read, if the file is missing, the store
  writes a placeholder with `_format` / `_usage` / `_example` keys
  documenting the structure, then reads it. Permissions are set to
  `0600`.
- **Filtering**: top-level keys starting with `_` are filtered out (so
  the placeholder docs don't masquerade as agent ids). Plugin-id sub-keys
  are *not* filtered — `agentId._misc.SOMETHING` works as an escape
  hatch for "agent-level secrets that aren't tied to a specific plugin".
- **Cache**: read once, cached in-memory. Restart the server to pick up
  edits.
- **API**:
  - `resolve(agentId, pluginId, declaredKeys) → { KEY: value, ... }` —
    looks up only the declared keys for one plugin instance. Used by
    `agent-manager.startPluginInstance` to feed
    `PluginInstanceContext.secrets`.
  - `resolveAll(agentId) → { KEY: value, ... }` — flattens every bucket
    under one agent into a bare-key map. Used by `agent-manager` to
    snapshot env-secrets for the runner. Last-writer-wins on collisions
    across plugins; plugin authors should namespace key names
    (`TELEGRAM_*`, `GMAIL_*`).

Encryption is deferred — see §8.

### 4.5 Validation — `validation.ts`

`ajv` with `useDefaults: true`, `coerceTypes: false`, `allErrors: true`,
`strict: false`.

- `validateAndDefault(schema, config, ctx)` — validates a plugin's
  `config.json` against `manifest.configSchema`; ajv's `useDefaults`
  fills in default values in place. Throws on validation failure with a
  combined error string.
- `checkRequiredSecrets(manifest, resolved, ctx)` — every key declared
  under `secretsSchema.properties` is treated as required. The schema's
  `required` array is **ignored**; the v0 contract is "all declared
  secrets are mandatory". Plugin manifests don't need to set `required`.

### 4.6 AgentDb — `queue.ts`

Per-agent SQLite WAL at `<agent>/sessions/.queue.db`. Three tables:

- `messages` — `(id, enqueued_at, plugin_id, channel_id, thread_id, text,
  metadata, priority, is_silent, in_flight, attempts)`
- `dead_letter` — rows that exceeded `maxAttempts`
- `events` — append-only audit log of `notify` / `batch_start` /
  `batch_end` events

Methods (only the load-bearing ones):

- `enqueue(...) → id`
- `peekHighestPriorityThread(exclude: Set<string>) → threadId | null` —
  the worker calls this with the active threads excluded so two workers
  never claim the same thread.
- `dequeueBatch(threadId) → BatchMessage[]` — pulls all queued rows for
  one thread, marks them `in_flight=1`. The batch the worker processes.
- `markBatchDone(ids[])` / `markBatchFailed(ids[], err, maxAttempts) →
  { retrying[], dead[] }`
- `sweepInFlight(maxAttempts)` — at runner start, bumps any rows still
  flagged `in_flight=1` (from a previous crash); pushes them to
  `dead_letter` if attempts exceed the cap.
- `appendEvent(...)` / `tailEvents(limit)`

WAL mode + a single writer (the worker pool) means concurrent reads (e.g.
event tailing for ops) don't block.

### 4.7 PiRpcClient — `rpc.ts`

JSON-RPC 2.0 framed over the `pi` child's stdin/stdout, newline-delimited.

- Manual `\n` split on stdout (not Node's `readline`). Reason:
  `readline` treats U+2028 / U+2029 as line terminators. JSON allows those
  characters inside string values, so a JSON-RPC frame containing such a
  string would split incorrectly. `JSON.stringify` never emits raw `\n`
  outside strings, so a plain `\n` split is safe.
- Methods: `sendPrompt`, `sendSteer`, `sendAbort`, `onAgentEnd`,
  `waitExit`, `kill`, `endStdin`, `stderrSnapshot`.
- Auto-cancels `extension_ui_request` dialog methods (pi sometimes
  prompts the user; the harness has no human, so we say "no").

### 4.8 AgentRunner — `runner.ts`

One worker pool per agent. Owns nothing it doesn't get passed:

```ts
export interface RunnerOpts {
  rootDir: string;
  harnessId: string;
  agentId: string;
  agentJson: AgentJson;
  db: AgentDb;
  serverBaseUrl: string;
  timezone: string;
  envSecrets?: Record<string, string>; // bare-key bag for pi child env
  log: Logger;
}
```

Public API: `start()`, `stop()`, `notify(payload)`, `abort(threadId)`.

Worker loop per slot (`maxSlots = max(1, agentJson.maxConcurrentSlots ?? 1)`):

1. `peekHighestPriorityThread(exclude=active.keys())` — returns a thread
   id with pending rows that no other worker is processing.
2. `dequeueBatch(threadId)` — claims the rows.
3. Spawn `pi --mode rpc` (see §4.8.1).
4. Concatenate batch messages: each message gets a `<harness-metadata>`
   prefix, then the message text; messages joined with `\n\n`.
5. `rpc.sendPrompt(promptText)`. Phase becomes `streaming`.
6. `Promise.race(agentEnded, rpc.waitExit())` — guards against pi
   crashing before emitting `agent_end`.
7. On clean end: `markBatchDone([...ids, ...steerIds])`, append
   `batch_end` event with status `done`.
8. On crash: `markBatchFailed(ids, errMsg, maxAttempts)` — bumps
   attempts, dead-letters past the cap.

#### 4.8.1 `spawnPi(threadId, sessionDir, log)`

Builds argv:

```
pi --mode rpc --continue
   --session-dir <agentDir>/sessions/<threadId>
   --provider <agentJson.model.provider>
   --model    <agentJson.model.id>
   --thinking <agentJson.model.thinkingLevel ?? "medium">
   --tools read,bash,edit,write,grep,find,ls
   --system-prompt "<assembled system prompt>"
   --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files
   --skill <agentDir>/skills            ← single dir; pi recurses for SKILL.md
   --extension <agentDir>/extensions/<X> ← per first-level entry
```

The `--no-*` flags suppress pi's default discovery so we control exactly
what's loaded. The `--skill` / `--extension` asymmetry is per pi:
`loadSkillsFromDir` recurses on subdirs looking for `SKILL.md`;
`loadExtension` does *not* — it expects `index.ts` / `index.js` /
`package.json` directly at the path. So one `--skill <skills-root>`
covers everything, but extensions need one `--extension` per first-level
child of `extensions/`.

Env handed to pi:

- All of `process.env`.
- If `<agentDir>/.venv/bin` exists: prepend it to `PATH`, set
  `VIRTUAL_ENV=<agentDir>/.venv`, delete `PYTHONHOME`.
- `PI_AGENT_ID = agentId`.
- `PI_WEBHOOK_BASE = ${serverBaseUrl}/webhook/${agentId}`.
- All `envSecrets` (the snapshot of every secret under this agent,
  flattened to bare keys).

cwd is `<agentDir>`, so all relative paths in the system prompt
(`scripts/...`, `workspace/...`, `sessions/...`) resolve correctly.

#### 4.8.2 `notify(payload)` — auto steer-or-enqueue

Always enqueues to the durable queue first. Then:

- Computes `threadId` via `agentJson.threadIdStrategy`:
  `single` → `"default"`, `plugin` → `<pluginId>`, `plugin_channel` →
  `<pluginId>:<channelId>`.
- Checks if there's an active streaming batch on the same thread.
- If yes, **and** the message is not silent **and** `doNotSteer !== true`:
  builds `<harness-metadata>` + text, calls `rpc.sendSteer` against the
  live child, adds the row id to `active.steerIds` (so it gets marked
  done with the batch).
- Else: `signalAll()` to wake an idle worker.

This means callers (admin plugin, scheduler, telegram, …) never need to
ask "is this a new prompt or a steer?". They call `notify()`; the runner
decides. There is **no** operator-only steer endpoint — admin uses the
same `notify` path via `admin.deliver()` → `ctx.notify()`.

#### 4.8.3 System prompt assembly per spawn

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

The boot orchestrator and agent lookup.

```ts
boot(): scan <root>/agents/ → load(id) for each
load(id):
  1. read agent.json
  2. mkdir <agent>/sessions, open AgentDb
  3. construct AgentRunner (snapshot envSecrets via secrets.resolveAll(id))
  4. for each <agent>/plugins/<pid>/: startPluginInstance(inst, pid)
  5. inst.runner.start()
shutdown(): plugin.stop(), runner.stop(), db.close() per agent
```

`startPluginInstance(inst, pid)`:

1. Look up `pid` in registry; throw if unknown.
2. `validateAndDefault(manifest.configSchema, raw, ctx)` —
   defaults filled in.
3. Default `notifications.enabled` to every name in `manifest.notifications`
   if `notifications.json` is absent.
4. `secrets.resolve(agentId, pid, declaredKeys)` →
   `checkRequiredSecrets` — fails the plugin start if any declared key
   is missing.
5. mkdir `state/` + `inbox/`.
6. Build `PluginInstanceContext`:
   ```ts
   {
     agentId, agentDir, stateDir, inboxDir,
     config, secrets,
     notify: (name, payload) => { gate via notifications.enabled, runner.notify({...payload, pluginId}) },
     httpBaseUrl: <serverBaseUrl>/webhook/<agentId>/<pid>  (only if plugin has handleHttpRequest),
     log: childLogger(`plugin:${agentId}:${pid}`),
   }
   ```
7. `await pluginInstance.start(ctx)`. Stash in `inst.plugins`.
8. If `pid === "admin"`, also stash on `inst.adminPlugin` (for
   `/admin/<id>/send`).

Plugin start failures are logged but don't fail the agent load — the
agent comes up with a subset of its plugins. Same for missing secrets.

Bootstrap (copying `bootstrap/` and running `bootstrap.sh`) is **not**
part of `load`. That's the operator's job at agent-create time, alongside
copying `system_prompts/` and `workspace/`. Boot stays purely "read state
and start runners" — see §6.14.

### 4.10 HTTP API — `api/admin.ts`, `api/webhook.ts`, `main.ts`

Two surfaces, served by the same Node `http.Server`:

- **Hono** for `/admin/*` and `/healthz`.
- **Raw `IncomingMessage`/`ServerResponse`** for `/webhook/*`. Plugins'
  `handleHttpRequest` takes raw req/res because the existing plugin
  ecosystem (telegram, gmail, …) expects them; Hono's wrapped Request/
  Response would require reimplementation. `main.ts` splices a raw
  `request` listener onto the `http.Server` that intercepts
  `/webhook/<agentId>/<pluginId>/*`, strips the prefix, and delegates to
  the plugin. Hono runs only when no `/webhook/` match.

Routes:

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/healthz` | liveness; returns `{ ok, agents }` |
| `POST` | `/admin/<id>/send`  | admin plugin delivers a `user_message` notification |
| `POST` | `/admin/<id>/abort` | runner.abort(threadId) — kills the live pi for that thread |
| `*`    | `/webhook/<agentId>/<pluginId>/<rest>` | plugin's `handleHttpRequest` with rewritten URL |

There is no `/admin/<id>/steer`. See §6.5.

---

## 5. Key flows

### 5.1 Inbound notification → response

1. Plugin (e.g. `telegram`) receives an external event via its webhook
   handler.
2. Plugin calls `ctx.notify("message_received", { text, channelId, ... })`.
3. `notify` checks `notifications.enabled`; skip if off.
4. Calls `runner.notify({ pluginId, ...payload })`.
5. Runner enqueues, appends a `notify` event, decides steer-or-wake (see
   §4.8.2).
6. A worker picks up the batch, spawns pi, sends the concatenated
   prompt. Pi processes, may use tools (incl. running plugin CLI scripts
   via `bash`), eventually emits `agent_end`.
7. Worker marks batch done. Pi exits.

### 5.2 Steer auto-detection

Same as 5.1 step 5, except:

- An active streaming batch exists on the same `threadId`.
- `payload.isSilent !== true` and `payload.doNotSteer !== true`.

Then `runner.notify` *also* calls `rpc.sendSteer` against the live child.
The row is added to `active.steerIds` and merged into the "done" set on
batch completion. Bookkeeping stays correct even if the batch fails (the
steer ids ride along into `markBatchFailed`).

Silent and "do not steer" notifications always wait for the next batch —
e.g. scheduler late-firings should land in the next prompt, not yank the
current one.

### 5.3 Crash recovery

`runner.start` calls `db.sweepInFlight(maxAttempts)`:

- For every row with `in_flight=1`: bump `attempts`, reset
  `in_flight=0`. Now eligible for re-claim.
- If `attempts > maxAttempts`: move to `dead_letter`.

Boot then proceeds normally; the worker loop picks up retried rows on
its next `peekHighestPriorityThread`. The `events` table records the
sweep counts.

The `pi` child crashing mid-batch (no `agent_end`) is detected by the
`Promise.race(agentEnded, rpc.waitExit())` — if `waitExit` resolves
first, the worker throws `pi exited without agent_end. stderr: ...`,
which goes through `markBatchFailed`. Same retry loop.

### 5.4 Boot sequence

1. `loadConfig()` reads env, builds `ServerConfig`.
2. `PluginRegistry.scan()` — built-in plugins, then user-space (with
   override).
3. `new AgentManager(cfg, registry)` — constructs `SecretsStore` against
   `<harnessRoot>/secrets.json`.
4. `am.boot()` — scans `<root>/agents/`. For each id:
   - `load(id)` reads `agent.json`, opens `AgentDb`, snapshots
     `envSecrets`, constructs `AgentRunner`, starts each plugin (which
     reads `<plugin>/config.json`, validates, resolves secrets), starts
     the runner.
5. `main.ts` mounts Hono routes (`/admin/*`, `/healthz`), splices the
   raw `/webhook/*` handler onto the underlying `http.Server`, listens
   on `cfg.port`.

A `SIGINT`/`SIGTERM` triggers `am.shutdown()` → close all plugins,
runners, DBs, then `process.exit(0)`.

### 5.5 Plugin script → in-process plugin loopback

Pattern for a plugin CLI script the agent runs via `bash`:

```bash
# scripts/<plugin>/<plugin>-cli
curl -sS -X POST "$PI_WEBHOOK_BASE/<plugin>/internal/<verb>" \
     -H 'content-type: application/json' \
     -d "$(jq -n --arg t "$1" '{text:$t}')"
```

The plugin handles `/internal/<verb>` in its `handleHttpRequest`. The
secret stays in the plugin (parent-process), even though the CLI script
runs inside pi. Alternatively, since secrets are now also exposed to pi
as env vars (see §6.12), a script can just `curl` directly to an
external service with `$TELEGRAM_BOT_TOKEN`. Either works.

---

## 6. Design decisions

### 6.1 Subprocess runtime, JSON-RPC frames

**Decision**: spawn a `pi --mode rpc` child per batch.

**Why**: pi-coding-agent has a stable RPC API. Embedding pi as a library
would couple us to its internal types and lifecycle; subprocess is a
narrow, versioned interface.

**Cost**: ~100ms spawn per batch. Tolerable; it's also the unit of
fault isolation. A pi crash takes down one batch, not the server.

### 6.2 SQLite WAL, one DB per agent

**Decision**: per-agent `<agent>/sessions/.queue.db`, WAL mode, single
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

### 6.5 Steer auto-detection inside `notify()`, no admin steer endpoint

**Decision**: every plugin (including admin) calls
`ctx.notify(name, payload)`. The runner figures out whether to enqueue
or steer based on per-thread state.

**Why**: callers shouldn't have to ask "is the agent currently
streaming?" — the runner already knows. Eliminates a duplicate code
path. The admin plugin's `/admin/<id>/send` is identical in shape to
any other plugin's notification.

**Cost**: there's no operator escape hatch to force a steer that
bypasses `notifications.enabled` or other policy. We don't think we
need one.

### 6.6 Plugins run in the parent process

**Decision**: plugin code runs in-process; pi children only see plugin
*scripts* (CLIs the agent runs via `bash`).

**Why**: plugin code is trusted; agent code is not. Plugin holds
secrets, owns its state, integrates with external services. Keeping it
in-process keeps state management trivial (just JS).

**Cost**: a misbehaving plugin (memory leak, infinite loop) takes the
whole server with it. v0 accepts this; the plugin set is small and
audited.

### 6.7 Creation = manual on disk for v0

**Decision**: agents are created by the operator running `mkdir`,
`sed`, `cp`, `bash bootstrap.sh`. The privileged `platform` plugin and
admin-agent bootstrap that would automate this are deferred.

**Why**: ship a working runner first. The privileged path is 13+ HTTP
verbs, a separate context shape, and a bootstrap branch — large enough
to want a stable lower layer first.

**Cost**: docs/v0-deferred.md is the recipe; readers have to follow
it. There's no UI yet.

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
comment explaining why.

### 6.10 Tools fixed at all 7

**Decision**: every agent runs with `read,bash,edit,write,grep,find,ls`.
No `tools` field on `agent.json`.

**Why**: there's no useful subset. Removing a tool just makes the agent
work harder via `bash` workarounds. Keeping the set fixed lets us bake
the tool descriptions into the system prompt template without per-agent
divergence.

### 6.11 Secrets in a single JSON file, plaintext

**Decision**: `<harnessRoot>/secrets.json`, plain JSON, 0600 perms.

**Why**: one file is easy to back up, edit, version-control (in
private), or sync. Env vars don't survive process boundaries cleanly
and become unwieldy with many keys. Encryption is a separate concern
that can be bolted on as a transparent layer later (KMS, age, etc.)
without changing the API.

**Cost**: plaintext on disk. The operator's filesystem ACLs and disk
encryption are the protection in v0.

### 6.12 Secrets exposed as env to the pi runtime

**Decision**: at spawn time, the runner injects every secret under the
agent (as bare keys) into the pi child's env, alongside `PI_AGENT_ID`
and `PI_WEBHOOK_BASE`.

**Why**: plugin CLI scripts the agent runs (`bash scripts/<plugin>/...`)
need to authenticate to external services. Two options:
(a) every plugin script does an authenticated loopback to the
in-process plugin, which forwards; or (b) the script reads the secret
from env directly. Option (b) is simpler — fewer moving parts, scripts
can use SDKs that read `OPENAI_API_KEY` or `GITHUB_TOKEN` as-is.

**Cost**: secrets are visible to anything the agent runs (bash history,
error logs, transcripts). The operator accepts this trade-off. If a
specific plugin holds a secret too sensitive for env exposure, that
plugin can decline to declare it as a secret here and route through its
own loopback URL (option (a) is still available).

### 6.13 Per-agent venv at `<agentDir>/.venv`

**Decision**: convention-driven (no `agent.json` field). The operator's
`bootstrap.sh` creates `<agentDir>/.venv`; the runner activates it on
every spawn if present.

**Why**: agents will install Python deps; they shouldn't pollute the
system Python or share deps across agents. `<agentDir>/.venv` is the
pyenv-style ergonomic default.

**Cost**: one venv per agent. Disk usage adds up; some deps (markitdown,
pyaudio, …) are heavy. Acceptable for v0.

### 6.14 Bootstrap is operator's job, not loader's

**Decision**: copying the `bootstrap/` template into a new agent dir
and running `bootstrap.sh` is part of the *creation* recipe (in
`v0-deferred.md` §3.1), not part of `agent-manager.load(id)`.

**Why**: clean creation/load separation. Creation = materialize
template. Load = read state and start runners. Earlier the loader did
the bootstrap; reverted because (a) it muddied the boundary, (b) first
boot blocked on `pip install` for ~30-60s before `agent loaded` fired.
When the deferred privileged-CRUD path comes back, the bootstrap call
goes there too — alongside the seed-copy / template-render machinery
already enumerated in `v0-deferred.md` §2.

---

## 7. Operational notes

### 7.1 Spinning up a new agent

See `v0-deferred.md` §3.1. Summary:

```bash
ROOT=~/.piharness   ID=dr-renu   NAME="Dr Renu"
mkdir -p "$ROOT/default/agents/$ID"/{system_prompts,workspace,sessions,plugins}
# write agent.json, sed-bake 0-base_prompt.md, write 1-agent.md, copy
# workspace/index.md and bootstrap/, run bootstrap.sh.
# Restart server.
```

### 7.2 Editing secrets

```bash
$EDITOR ~/.piharness/default/secrets.json
# {
#   "dr-renu": {
#     "telegram": { "TELEGRAM_BOT_TOKEN": "..." },
#     "gmail":    { "GMAIL_OAUTH_TOKEN": "..." }
#   }
# }
```

Restart the server. Keys are exposed both to plugins (as
`PluginInstanceContext.secrets`, only the declared ones) and to pi
(as bare-key env vars, all of them under the agent).

### 7.3 Refreshing Python deps for an agent

```bash
$EDITOR ~/.piharness/default/agents/$ID/bootstrap/requirements.txt
bash ~/.piharness/default/agents/$ID/bootstrap/bootstrap.sh
# pip handles "Requirement already satisfied" — script is idempotent.
# No server restart needed; the next pi spawn picks up the venv state.
```

### 7.4 Logs and observability

- **Process logs**: structured JSON via pino on stdout. Use
  `pino-pretty` (auto-applied in TTY mode) or pipe to `jq`.
- **Per-agent event log**: `<agent>/sessions/.queue.db` table `events`.
  Tail via:

  ```bash
  sqlite3 ~/.piharness/default/agents/$ID/sessions/.queue.db \
    "SELECT id, ts, event, status, log FROM events ORDER BY id DESC LIMIT 20;"
  ```

  Includes one row per `notify`, `batch_start`, `batch_end`.
- **Per-thread session JSONLs**: `<agent>/sessions/<ThreadId>/<sid>.jsonl`.
  Each session captures the model's full turn-by-turn including tool
  calls. Use `jq -c .` to read.

### 7.5 Talking to an agent (admin)

```bash
# install the admin plugin first (mkdir <agent>/plugins/admin/{state,inbox},
# write config.json, write notifications.json), restart.

curl -X POST http://127.0.0.1:7331/admin/dr-renu/send \
  -H 'content-type: application/json' \
  -d '{"text":"hello"}'

# abort the live batch on a thread:
curl -X POST http://127.0.0.1:7331/admin/dr-renu/abort \
  -H 'content-type: application/json' \
  -d '{"threadId":"admin:operator"}'
```

### 7.6 Healthchecks

```bash
curl http://127.0.0.1:7331/healthz
# → { "ok": true, "agents": <count> }
```

---

## 8. Limitations and future work

### 8.1 Known limitations (v0)

- **No agent CRUD over HTTP** — manual on disk. See `v0-deferred.md`.
- **No plugin install/uninstall over HTTP** — manual on disk.
- **Plaintext secrets at rest**.
- **Single-process** — one Node owns everything; not horizontally
  scalable.
- **Sequential boot** — `load(id)` runs per agent; no parallelism. Many
  agents → slow boot.
- **No hot-reload** of `secrets.json` or plugin configs. Restart picks
  up changes.
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
- **Hot-reload secrets.** File-watcher on `secrets.json`; on change,
  invalidate the SecretsStore cache and refresh `envSecrets` for live
  runners. Tricky because the runner snapshots at construct time —
  would need a callback.
- **Multi-process / multi-host runners.** The queue is already SQLite;
  swap in Postgres or a job-queue (BullMQ, etc.) and let multiple Node
  workers claim batches. Per-agent locking via the queue's `in_flight`
  flag is already there.
- **Per-plugin secret scoping in env.** Currently the bag is flat
  (last-writer-wins on collision). Could prefix with `<PLUGINID>_` for
  isolation; trade-off is plugin scripts need to know their prefix.
- **Structured agent_status streaming.** SSE/websocket from the runner
  exposing `notify`, `batch_start`, `batch_end`, plus pi's per-tool-call
  events. Useful for UIs without polling the events table.
- **Live config edits.** Hono route to PATCH `<agent>/plugins/<id>/config.json`
  with re-validation and plugin restart. Same shape for
  `notifications.json`.
- **Cross-agent event bus.** Today an agent reaches another agent only
  via shared filesystem (`workspace/knowledge/`). A pub/sub bus would
  let agents emit and subscribe to events typed by the platform.

---

## Appendix: file map

| File | LOC | Role |
|---|---|---|
| `apps/server/src/main.ts` | 84 | boot, HTTP server, signal handling |
| `apps/server/src/config.ts` | 42 | env-driven config + path helpers |
| `apps/server/src/logger.ts` | 26 | pino setup |
| `apps/server/src/types.ts` | 122 | shared types (`AgentJson`, `Plugin`, `JsonSchema`, …) |
| `apps/server/src/plugin-registry.ts` | 114 | dual-root plugin discovery |
| `apps/server/src/secrets.ts` | 115 | JSON-file-backed secret store |
| `apps/server/src/validation.ts` | 54 | ajv config validation + secrets check |
| `apps/server/src/queue.ts` | 326 | per-agent SQLite queue + event log |
| `apps/server/src/rpc.ts` | 213 | JSON-RPC client to pi children |
| `apps/server/src/runner.ts` | 543 | per-agent worker pool + spawn |
| `apps/server/src/agent-manager.ts` | 245 | boot + per-agent lifecycle |
| `apps/server/src/api/admin.ts` | 52 | `/admin/<id>/{send,abort}` |
| `apps/server/src/api/webhook.ts` | 61 | raw `/webhook/<agentId>/<pluginId>/*` dispatcher |
| **total** | **~2 000** | |

Built-in plugins live in `apps/server/plugins/<id>/`: `admin`,
`scheduler`, `telegram` (stub), `gmail` (stub).
