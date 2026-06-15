# CogniSphere — High-Level Design

> **v0 implementation status:** the admin agent bootstrap and the privileged
> `platform` plugin (see §1 goal #3, §9.2, §9.5, §11.1, §11.4–§11.6) are
> **not implemented** in v0. v0 ships the runner + queue + plugin contract +
> generic `admin` plugin only; agents are created manually on disk. See
> [`docs/v0-deferred.md`](v0-deferred.md) for the gap and the manual workflow
> v0 expects in its place. The contracts in this doc are intact and remain
> the spec for the re-introduction.

A multi-agent platform managed by a privileged **admin agent**. Each agent is
a self-contained directory of prompts, skills, scripts, plugin state, and a
workspace; pi (the LLM agent runtime) is spawned per batch as a subprocess;
plugins are server-side gateways that turn external events (Telegram
messages, cron fires, operator chat) into notifications for the agent. The
operator interacts with the platform by chatting with the admin agent from a
terminal (Claude Code is fine); the admin agent has scripts that CRUD other
agents and install plugins.

This document is the single source of truth for the contracts. Code that
diverges from this doc is wrong.

---

## 1. Goals and non-goals

### Goals

- Many agents on one server. CRUD'd by the admin/super agent — no operator
  UI required in v1.
- Each agent's directory is self-contained for **content** (prompts, skills,
  scripts, configs, sessions, workspace, memory). Tar the dir → backup.
- Plugins ship with the platform as built-ins; the admin agent can also
  author new ones at runtime into a user-space plugin root. Both kinds are
  installed into agents by the admin agent, which configures
  secrets/config and toggles which notifications fire.
- Operator talks to the admin agent over a single internal HTTP endpoint
  (Claude Code in a terminal calls it). External webhooks for plugins land
  on the same server.
- Built-in plugins on day 1: `admin` (operator chat), `platform` (privileged
  CRUD — only on the admin agent), `scheduler` (cron), `telegram`, `gmail`.

### Non-goals (v1)

- Operator UI (file explorer, chat view, plugin settings forms). Designed
  for in the file layout but not built.
- Permission control over what the agent can read/edit. Deferred to docker.
- Docker isolation around pi. Designed for, not implemented.
- Per-agent Node process isolation. Single process for all agents.
- Encrypted secrets at rest. Plain `.env` + admin-agent-set in-memory
  override.
- Custom thread-id strategy via JSON. Three built-in strategies only.
- Hot-reload of edited plugin source. Server restart picks up changes.

---

## 2. Top-level architecture

```
┌─ Node server process ──────────────────────────────────────────────┐
│  HTTP server (single port)                                         │
│   ├── /webhook/<agentId>/<pluginId>/...   plugin webhooks (external)
│   ├── /admin/<agentId>/send                operator → agent (internal)
│   └── /admin/<agentId>/abort | /steer      operator controls (internal)
│                                                                    │
│  PluginRegistry — scans built-in + user-space plugin roots         │
│                                                                    │
│  AgentManager                                                      │
│    ├── Agent admin (privileged: platform plugin)                   │
│    ├── Agent A1                                                    │
│    │     ├── AgentRunner (queue + workers + spawn pi)              │
│    │     ├── PluginInstance: telegram                              │
│    │     └── PluginInstance: admin                                 │
│    ├── Agent A2                                                    │
│    └── ...                                                         │
│                                                                    │
│  EventLog (SQLite — one row per notify, one row per batch)         │
└────────────────────────────────────────────────────────────────────┘
                          │
                          ▼ per batch
                  spawn `pi --mode rpc`
                  cwd = agent dir
                  short-lived (dies on agent_end)
```

One Node process. In-process plugin actors. One pi child per batch. No daemon
beyond the server. No file watcher (no UI to broadcast to).

---

## 3. On-disk layout

### 3.1 Agent directory (= pi cwd)

```
<rootDir>/<harnessId>/agents/<agentId>/
  agent.json                          # declarative config
  system_prompts/
    0-harness.md                      # static template w/ {{vars}} (see §6.5)
    1-agent.md                        # editable persona
    2-<plugin>.md                     # added on plugin install; next-free slot
  skills/agent/<name>/SKILL.md        # agent-authored skills
  skills/<plugin-id>/<name>/SKILL.md  # plugin-installed skills
  scripts/agent/<name>                # agent-authored scripts
  scripts/<plugin-id>/<name>          # plugin-installed scripts
  prompts/agent/<name>.md             # agent-authored slash templates
  prompts/<plugin-id>/<name>.md       # plugin-installed slash templates
  extensions/agent/<name>.ts          # agent-authored pi extensions
  extensions/<plugin-id>/<name>.ts    # plugin-installed extensions
  subagents/agent/<name>.md           # agent-authored sub-agents
  subagents/<plugin-id>/<name>.md     # plugin-installed sub-agents
  assets/                             # arbitrary reference files
  workspace/                          # agent's general scratch (rw)
    index.md                          # agent-maintained index of files
    memory/                           # agent's persistent memories
  plugins/<plugin-id>/
    config.json                       # plugin config
    notifications.json                # { enabled: ["fire", ...] }
    state/                            # plugin-private runtime state
    inbox/                            # plugin-deposited files for the agent
  sessions/<threadId>/
    <sessionId>.jsonl                 # main thread session(s) (SDK-rolled)
    subagents/<slug>/<task>/<sid>.jsonl  # nested sub-agent sessions
  sessions/.events.db                  # SQLite WAL: queue + event log
```

Notes:

- **cwd of pi = the agent directory.** All relative paths resolve from here.
- Each resource family (`skills/`, `scripts/`, `prompts/`, `extensions/`,
  `subagents/`) has two namespaces: `agent/` for agent-authored content, and
  `<plugin-id>/` for content seeded by a plugin install. The split is
  organizational only — both are discovered by pi's recursive walk.
- `system_prompts/` files are concatenated in lex order to form the final
  system prompt. `0-harness.md` is the harness preamble (see §6.5);
  `1-agent.md` is the persona. Plugins claim the next free `N` on install.
- `workspace/` is the agent's scratch area: notes, drafts, downloaded
  context, intermediates. `workspace/index.md` is the agent's own running
  index across the workspace; `workspace/memory/` holds persistent memories
  (the agent decides the structure).
- `sessions/<threadId>/` is a directory: zero or more rolled session JSONL
  files for the thread, plus a `subagents/<slug>/<task>/` subtree for
  sub-agent sessions invoked from this thread.
- Scripts are invoked by full relative path
  (e.g. `bash scripts/scheduler/scheduler-cli list`). No PATH manipulation.

### 3.2 Server source layout

```
apps/server/
  src/
    main.ts                  # boot
    runner.ts                # AgentRunner (queue + workers + spawn pi)
    rpc.ts                   # pi --mode rpc client (~100 LOC)
    plugin-registry.ts       # discover built-in + user-space plugins
    agent-manager.ts         # CRUD for agents (called from privileged plugin)
    api/
      webhook.ts             # routes /webhook/<agentId>/<pluginId>/...
      admin.ts               # routes /admin/<agentId>/{send,abort,steer}
    secrets.ts               # .env + in-memory override
    event-log.ts             # event-log schema + append helpers
    sysprompt.ts             # builds final --system-prompt text (variables)
  plugins/                   # built-in registry root, auto-discovered
    admin/    {index.ts, seed/}
    platform/ {index.ts, seed/}    # privileged CRUD plugin (admin agent only)
    scheduler/{index.ts, src/, seed/}
    telegram/ {index.ts, src/, seed/}
    gmail/    {index.ts, src/, seed/}
  agents/
    templates/
      base/                  # base template for new agents (see §3.3)
```

Server-side plugin folder shape:

```
apps/server/plugins/<plugin-id>/
  index.ts                   # default-exports a class implementing Plugin
  src/...                    # gateway helpers (cron runner, bot client, etc.)
  seed/                      # files copied into the agent on install
    system_prompt.md
    skills/<plugin-id>/SKILL.md
    scripts/<plugin-id>/<name>
    prompts/<plugin-id>/<name>.md
    extensions/<plugin-id>/<name>.ts
    subagents/<plugin-id>/<name>.md
```

The seed/ directory mirrors the target subpaths under the agent dir 1:1, so
install is a recursive copy. The seed `system_prompt.md` is renamed to
`<N>-<plugin-id>.md` where N is the next free slot.

### 3.3 Base agent template

Every new agent is created from a minimal template:

```
apps/server/agents/templates/base/
  agent.json.template               # {{name}}, {{model.provider}}, {{model.id}}, ...
  system_prompts/
    0-harness.md                    # the harness preamble — static, has {{vars}}
    1-agent.md.template             # minimal persona starter
  workspace/
    index.md                        # placeholder index
```

`0-harness.md` ships as part of the template (not generated). It contains
the harness preamble, parameterized with `{{AgentId}}`, `{{ThreadId}}`, `{{AgentDir}}`,
`{{Workspace}}`, `{{Sessions}}`, `{{PluginIds}}`, `{{Tools}}`, etc. The
runner does variable substitution on the file's content per batch when
building `--system-prompt` (no on-disk rewrite — see §6.5). The user can
edit `0-harness.md` to customize the preamble; it stays portable because
the variables resolve at use time.

Everything else is generated by the create flow (§11.7):

- Empty resource subdirs (`skills/agent/`, `scripts/agent/`,
  `prompts/agent/`, `extensions/agent/`, `subagents/agent/`, `assets/`,
  `plugins/`, `sessions/`).
- `plugins/admin/` and the admin plugin's seeded files — installed by
  auto-running the admin-plugin install (§11.4) immediately after the
  skeleton is laid down.

The template stays minimal on purpose: the platform doesn't know the
agent's domain, so baking in skills or prompts would force every agent
to ship with files the operator has to delete. Domain content arrives via
plugin installs or hand-authored files placed under `<resource>/agent/`.

Future: multiple selectable templates under `agents/templates/<name>/`
(e.g., `support`, `coder`). v1 ships only `base`.

### 3.4 User-space plugins

A second plugin-source root for plugins **authored at runtime** by the admin
agent (see §9.5 and §11.x):

```
<rootDir>/<harnessId>/plugins/<plugin-id>/
  index.ts
  src/...
  seed/...
```

Same shape as built-in plugins. Optional — the directory may not exist on a
fresh install. The registry scans both roots (built-in first, user-space
second) and merges into one map; user-space wins on id collision so the
admin agent can override a built-in if needed. See §5.4.

---

## 4. agent.json

```json
{
  "name": "Dr Renu",
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5",
    "thinkingLevel": "medium"
  },
  "threadIdStrategy": { "type": "plugin_channel" },
  "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "maxConcurrentSlots": 1,
  "maxAttempts": 3,
  "runtime": "subprocess"
}
```

| Field                   | Type     | Notes                                             |
| ----------------------- | -------- | ------------------------------------------------- |
| `name`                  | string   | display name in UI                                |
| `model.provider`        | enum     | `anthropic` \| `openai` \| `google` \| ...        |
| `model.id`              | string   | model id passed to `pi --model`                   |
| `model.thinkingLevel`   | enum     | `off` \| `minimal` \| `low` \| `medium` \| `high` |
| `threadIdStrategy.type` | enum     | `single` \| `plugin` \| `plugin_channel`          |
| `tools`                 | string[] | passed to `pi --tools`; defaults below            |
| `maxConcurrentSlots`    | int      | drain-worker count, default 1                     |
| `maxAttempts`           | int      | retry cap before dead-letter, default 3           |
| `runtime`               | enum     | `subprocess` \| `docker` (docker is vNext)        |

**No `plugins[]` field.** Source of truth for installed plugins is the
presence of `plugins/<id>/` directories.

Default `tools`: `["read","bash","edit","write","grep","find","ls"]`.

`threadIdStrategy` semantics:

| Strategy                       | Thread id                          |
| ------------------------------ | ---------------------------------- |
| `{ "type": "single" }`         | `"default"`                        |
| `{ "type": "plugin" }`         | `ctx.pluginId`                     |
| `{ "type": "plugin_channel" }` | `${ctx.pluginId}:${ctx.channelId}` |

Custom strategies are not supported in v1.

---

## 5. Plugin contract

### 5.1 Server-side plugin code

```ts
// apps/server/plugins/<plugin-id>/index.ts

export default class TelegramPlugin implements Plugin {
  manifest: PluginManifest = {
    displayName: "Telegram",
    description: "Send and receive Telegram messages.",
    notifications: [
      { name: "message_received", description: "User sent a message in chat." },
      { name: "edited",           description: "User edited a previous message." },
    ],
    configSchema: { /* JSON Schema */ },
    secretsSchema: { /* JSON Schema */ },
  };

  async start(ctx: PluginInstanceContext): Promise<void> { ... }
  async stop(): Promise<void> { ... }
  async handleHttpRequest?(req, res): Promise<void> { ... }   // optional
}
```

```ts
export interface Plugin {
  manifest: PluginManifest;
  start(ctx: PluginInstanceContext): Promise<void>;
  stop(): Promise<void>;
  handleHttpRequest?(
    req: IncomingMessage,
    res: ServerResponse,
  ): void | Promise<void>;
}

export interface PluginManifest {
  displayName: string;
  description?: string;
  notifications: { name: string; description: string }[];
  configSchema: JSONSchema;
  secretsSchema: JSONSchema;
}

export interface PluginInstanceContext {
  // dirs (absolute)
  agentDir: string; // the cwd of pi
  stateDir: string; // <agent>/plugins/<plugin>/state/
  inboxDir: string; // <agent>/plugins/<plugin>/inbox/

  // configuration
  config: unknown; // shape per manifest.configSchema
  secrets: Record<string, string>;

  // outbound
  notify(name: string, payload: NotifyPayload): void; // gated by notifications.json
  httpBaseUrl?: string; // present iff handleHttpRequest is defined

  log: Logger;
}

export interface NotifyPayload {
  text: string;
  channelId: string; // used by threadIdStrategy
  metadata?: Record<string, unknown>;
  threadIdOverride?: string;
  doNotSteer?: boolean;
  isSilent?: boolean;
  priority?: number; // default 0
}
```

Plugin code never imports the harness or the runner. It receives a context
and calls `ctx.notify(...)`. The harness owns routing and queueing.

`ctx.notify(name, payload)` is gated by `<agent>/plugins/<id>/notifications.json`
— if `name` is not in `enabled`, the call is a no-op (no error). The plugin
author always emits unconditionally; the gate is platform-owned.

### 5.2 Identity

- **Plugin type id** = the directory name under `apps/server/plugins/<id>/`.
- **Plugin instance id** = the directory name under `<agent>/plugins/<id>/`.
- For v1 these are equal: each agent installs each plugin type at most once.
- Neither id appears as a field on the interfaces — paths are identity.

### 5.3 Install / uninstall

Both are invoked by the **admin agent** through its privileged plugin
context (§9.5). There are no operator-facing HTTP endpoints for install or
uninstall.

**Install** (`platform.installPlugin(agentId, pluginId, config, secrets)`):

1. Look up `<plugin-id>` in the registry. Throw if missing.
2. Recursively copy the plugin's `seed/` into the agent directory.
   `seed/system_prompt.md` is renamed to `<N>-<plugin-id>.md` where
   `N = max(existing N) + 1`, with slots 0 and 1 reserved.
3. Create `<agent>/plugins/<id>/{config.json, notifications.json, state/,
inbox/}` from the manifest's `configSchema` defaults; all notifications
   enabled by default.
4. Construct a `PluginInstanceContext` and call `plugin.start(ctx)`.

**Uninstall** (`platform.uninstallPlugin(agentId, pluginId)`):

1. Call `plugin.stop()`.
2. Remove `<agent>/plugins/<id>/`.
3. **Seeded files in `system_prompts/`, `skills/`, `scripts/`, `prompts/`,
   `extensions/`, `subagents/` are not removed.** The admin agent (or
   operator) deletes them manually if desired.

### 5.4 PluginRegistry

```ts
class PluginRegistry {
  constructor(private scanRoots: string[]);
  scan(): Promise<void>;          // initial load — dynamic-import every <root>/<id>/index.ts
  rescan(): Promise<void>;        // re-scan after admin agent authors a new plugin
  list(): PluginManifest[];
  get(id: string): { ctor: new () => Plugin; sourceDir: string };
}
```

- `scanRoots` is an ordered array. v1 default:
  `[ "<repo>/apps/server/plugins", "<rootDir>/<harnessId>/plugins" ]`.
- The first root holds **built-in** plugins shipped with the platform; the
  second holds **custom** plugins authored at runtime by the admin agent.
- Both roots scanned at boot. Plugins from later roots override earlier
  ones on id collision (so a custom plugin can override a built-in).
- `rescan()` is invoked by the admin agent's `platform.rescanPlugins()`
  after writing a new plugin folder under the user-space root. v1
  implements add-only rescan: existing in-memory plugin entries are not
  reloaded (server restart picks up edits to existing plugins).

### 5.5 Multi-instance routing (multiple agents installing the same plugin)

Each agent that installs a given plugin type gets its **own object** —
constructed fresh from the registry's `ctor`, with its own
`PluginInstanceContext`. There is no sharing of state, secrets, or the
`notify` callback across instances.

Concrete example: three agents A1/A2/A3 each install `telegram` with three
different bot tokens.

```ts
// Boot, per agent:
const TelegramCtor = registry.get("telegram").ctor;
const instance = new TelegramCtor();
const ctx = {
  agentDir: paths.agent("A1"),
  stateDir: paths.pluginState("A1", "telegram"),
  inboxDir: paths.pluginInbox("A1", "telegram"),
  config: readJson(paths.pluginRoot("A1", "telegram") + "/config.json"),
  secrets: resolveSecrets("A1", "telegram"), // BOT_TOKEN=T1
  notify: (name, p) => runners["A1"].notify({ pluginId: "telegram", ...p }),
  httpBaseUrl: `${serverBaseUrl}/webhook/A1/telegram`,
  log: log.child("plugin:A1:telegram"),
};
await instance.start(ctx);
// (repeat for A2 with T2 → /webhook/A2/telegram, A3 with T3 → /webhook/A3/telegram)
```

**Inbound disambiguation.** The plugin's `start()` registers its specific
`ctx.httpBaseUrl` with the external service (Telegram's `setWebhook(token,
url)`). The external service then calls the right URL per-bot; the agentId
is encoded in the path. The HTTP router parses
`/webhook/<agentId>/<pluginId>/<rest>`, looks up `instances[agentId][pluginId]`,
strips the prefix, and calls `handleHttpRequest`. Each agent's instance is
the only thing that ever sees its own bot's events.

**Outbound disambiguation.** Pi gets two env vars per batch:

```
PI_AGENT_ID=A1
PI_WEBHOOK_BASE=<serverBaseUrl>/webhook/A1
```

Scripts in `scripts/<plugin>/` append `<plugin>/<route>` to construct their
loopback URL — e.g., the Telegram script POSTs to
`${PI_WEBHOOK_BASE}/telegram/internal/send`. The script's own
location implies the `<plugin>` segment; agentId is already baked into the
base URL.

**Polling plugins** (gmail) have nothing inbound from external services —
each instance's polling loop runs in `start()`, hits the API with its own
credentials, and routes results through its own `notify`. Multi-instance is
trivially correct because each instance is just a separate timer + closure.

**Operator source** (admin plugin) — the admin plugin's `notify` is
invoked from `POST /admin/<agentId>/send`. The path's `<agentId>` selects
which agent's admin instance handles it.

---

## 6. AgentRunner

One class combining the `AgentRunner` and `AgentRuntime` responsibilities
into a single ~250-line implementation.

### 6.1 Public API

```ts
class AgentRunner extends EventEmitter {
  constructor(opts: {
    rootDir: string;
    harnessId: string;
    agentId: string;
    agentJson: AgentJson;
    log: Logger;
  });

  start(): Promise<void>;
  stop(): Promise<void>;

  // plugin → runner
  notify(payload: NotifyPayload & { pluginId: string }): void;

  // operator / runtime control
  abort(threadId: string): boolean;
  steer(threadId: string, text: string): boolean;

  // Events emitted (consumed by event-log + future operator UI):
  //   "batch_start"      { threadId, batchId }
  //   "agent_event"      { threadId, batchId, event: AgentSessionEvent }   (raw pi event)
  //   "batch_end"        { threadId, batchId, ok: boolean, error?: string }
}
```

The runner derives its own paths from `(rootDir, harnessId, agentId)` —
`<rootDir>/<harnessId>/agents/<agentId>/{,sessions/,plugins/<id>/...}`. No
shared `HarnessPaths` class; the four or five paths the runner needs are
inline `path.join` calls.

### 6.2 Queue (SQLite, WAL, better-sqlite3)

`<agent>/sessions/.events.db` schema:

```sql
CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  enqueued_at  INTEGER NOT NULL,                  -- unix ms
  plugin_id    TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  thread_id    TEXT NOT NULL,                     -- resolved by threadIdStrategy
  text         TEXT NOT NULL,
  metadata     TEXT,                              -- JSON
  priority     INTEGER NOT NULL DEFAULT 0,
  is_silent    INTEGER NOT NULL DEFAULT 0,        -- 0/1
  in_flight    INTEGER NOT NULL DEFAULT 0,        -- 0/1
  attempts     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE dead_letter (... same shape + last_error TEXT, dead_at INTEGER);

CREATE INDEX idx_pending ON messages(thread_id, in_flight, priority DESC, id);
```

Operations:

- `enqueue(row)` — insert; one row per `notify()`.
- `peekHighestPriorityThread()` — return a `thread_id` with at least one
  pending non-silent row that no worker currently owns. Returns null if
  none.
- `dequeueBatch(threadId)` — atomic: select all pending rows for `thread_id`
  ordered by `(priority DESC, id)`, mark `in_flight=1`. Includes silent rows
  if any are pending in the same thread.
- `markBatchDone(ids)` — DELETE.
- `markBatchFailed(ids, errStr)` — increment `attempts`, return rows whose
  attempts ≥ maxAttempts to `dead_letter`, the rest reset to `in_flight=0`.
- `sweepInFlight()` — at startup, set `in_flight=0` for any leftover rows.

### 6.3 Worker fleet

Fixed pool of `maxConcurrentSlots` workers (default 1). In-memory
`activeBatches: Map<threadId, ActiveBatch>` enforces the per-thread
exclusion invariant (presence in map = owned). Each worker loop:

```
1. claim threadId via peekHighestPriorityThread (skip threadIds in activeBatches)
2. if none → wait on a notify-or-shutdown condition variable
3. dequeueBatch(threadId) → batch
4. activeBatches.set(threadId, { batch, phase: "spawning" })
5. spawn pi (see 6.4)
6. write `prompt` frame for each message in the batch (concatenate or queue;
   see 6.4.1)
7. phase = "streaming"; pump events to runner.emit("agent_event", ...) until
   `agent_end`
8. phase = "completing"; close stdin; await child exit (5s SIGKILL fallback)
9. on success: markBatchDone(ids); emit batch_end ok
   on fail: markBatchFailed(ids, err); emit batch_end ok=false
10. activeBatches.delete(threadId)
11. goto 1
```

### 6.4 Spawning pi

```ts
private spawnPi(threadId: string): ChildProcessWithoutNullStreams {
  const agentDir   = join(this.rootDir, this.harnessId, "agents", this.agentId);
  const sessionDir = join(agentDir, "sessions", threadId);
  const args = [
    "--mode", "rpc",
    "--session-dir", sessionDir,
    "--provider",    this.agentJson.model.provider,
    "--model",       this.agentJson.model.id,
    "--tools",       this.agentJson.tools.join(","),
    "--system-prompt", this.buildSystemPrompt(threadId),   // see 6.5
  ];
  const opts = {
    cwd: agentDir,
    env: {
      ...process.env,
      PI_AGENT_ID:       this.agentId,
      PI_THREAD_ID:      threadId,
      PI_WEBHOOK_BASE:   `${this.serverBaseUrl}/webhook/${this.agentId}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  };
  if (this.agentJson.runtime === "subprocess") {
    return spawn("pi", args, opts);
  }
  // docker — vNext
  return spawn("docker", ["exec", "-i", this.containerId, "pi", ...args], { ...opts, cwd: undefined });
}
```

`PI_WEBHOOK_BASE` is the per-agent webhook base URL. Plugin-installed
scripts append `<plugin-id>/<route>` to it for HTTP loopback to their
plugin's `handleHttpRequest`. Example: `telegram-cli send` POSTs to
`${PI_WEBHOOK_BASE}/telegram/internal/send`. The script's own location
(`scripts/telegram/...`) implies the plugin segment; the agentId is baked
into the base URL. This is the cross-language IPC seam — scripts can be
bash, Python, Node, anything that can `curl`.

#### 6.4.1 Multi-message batches — concatenation

A batch may contain N messages (priority-ordered). They are concatenated
into a single `prompt` frame, each prepended with its own
`<harness-metadata>` block, separator `\n\n`:

```ts
const promptText = batch
  .map((m) => `${buildHarnessMetadata(m)}\n${m.text}`)
  .join("\n\n");
```

One block per inbound message, single `prompt` to pi. Concatenation (over
prompt + N-1 steers) keeps the entire incoming batch in one user-message
boundary, simplifies the JSONL trail, and avoids racing with pi's internal
turn boundaries.

```
<harness-metadata>
Timestamp: 2026-05-05 14:30:05 IST
Plugin: telegram
Channel: 12345
ThreadId: telegram:12345
[IsSilent: true]
<PascalCased keys from metadata>
</harness-metadata>

<original text>
```

### 6.5 System prompt assembly

The final `--system-prompt` text is built per batch by concatenating the
content of every `<agent>/system_prompts/*.md` file in lex order, then
resolving `{{variable}}` placeholders. **No file is rewritten on disk.**

```
1. Read all <agent>/system_prompts/*.md files in lex order
2. Concatenate with "\n\n" separator
3. Resolve {{variables}} (see table below)
4. Pass the final string via `pi --system-prompt`
```

**Variable namespace** — available in any `system_prompts/*.md` file:

| Variable             | Resolves to                                     |
| -------------------- | ----------------------------------------------- |
| `{{AgentId}}`        | the agent's id (dir name)                       |
| `{{AgentName}}`      | `agent.json.name`                               |
| `{{ThreadId}}`       | the current batch's thread id                   |
| `{{AgentDir}}`       | absolute path to the agent dir (= cwd)          |
| `{{Workspace}}`      | absolute path to `<agent>/workspace/`           |
| `{{Sessions}}`       | absolute path to `<agent>/sessions/`            |
| `{{ThreadSessions}}` | absolute path to `<agent>/sessions/<threadId>/` |
| `{{PluginIds}}`      | comma-separated list of installed plugin ids    |
| `{{Tools}}`          | comma-separated list of `agent.json.tools`      |
| `{{Provider}}`       | `agent.json.model.provider`                     |
| `{{Model}}`          | `agent.json.model.id`                           |
| `{{ServerBaseUrl}}`  | the server's external base URL                  |
| `{{Timezone}}`       | the harness timezone                            |

Unresolved `{{Foo}}` references (e.g., a typo) are left in place verbatim
and logged at warn level so the operator can see the typo by reading the
log or grepping the rendered prompt.

**`0-harness.md` content.** Ships with the base template (§3.3) with
Identity, Tools, Workspace, Threads, Plugins, Sub-agents,
Communication-model, and Guidelines sections —
parameterized with the variables above. The operator (or admin agent) can
edit it; nothing in the runner depends on its specific content. The
runner's only contract is variable substitution — what the file says is up
to the user.

**Why no on-disk rewrite.** ThreadId varies per batch and per worker. If
two workers wrote `0-harness.md` simultaneously, they'd race; the file
contents at any moment wouldn't reflect either thread reliably. Variable
substitution in memory is race-free, simpler, and lets the agent treat the
file as static when reading from disk (`read("system_prompts/0-harness.md")`
shows the unresolved template, which is also the more useful view —
showing the structure, not one batch's substituted snapshot).

### 6.6 Steer / abort semantics

- **Steer**: while `phase === "streaming"`, `notify()` for the same
  `threadId` (with `doNotSteer` unset) writes a `steer` frame to the live
  pi child _and_ enqueues the row. On batch success the steer rows are
  deleted alongside the batch; on failure they remain pending and replay
  with the next attempt. If the steer write throws, the row is kept pending
  (not lost).
- **Abort**: `runner.abort(threadId)` writes an `abort` RPC frame, closes
  stdin, waits 2s, escalates to SIGTERM then SIGKILL. The batch's rows are
  marked done (treated as user-cancelled), not retried.

### 6.7 Silent messages

`isSilent: true` rows are persisted but cannot solo-fire a batch:
`peekHighestPriorityThread` filters out threads whose pending rows are
all silent. When a non-silent message in the same thread fires a batch,
parked silent rows ride along (by priority/enqueue order).

---

## 7. RPC client (pi --mode rpc)

A small wrapper (~100 LOC) around the child process. JSONL framing, LF only.

```ts
class PiRpcClient {
  constructor(private child: ChildProcess);

  prompt(text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;     // close stdin, await exit, SIGKILL after 5s

  events(): AsyncIterable<AgentSessionEvent>;   // streamed from stdout
}
```

Implementation notes:

- Read with a manual `\n` splitter; do not use Node `readline` (it splits on
  `U+2028` / `U+2029` which are valid inside JSON strings).
- Correlate command responses by `id`.
- Forward all events 1:1; the runner does not interpret events except for
  detecting `agent_end` to terminate the batch.

---

## 8. Server HTTP API

Single port. Configurable via env (`PORT`, default 7331). Two route families
only — there is no operator REST surface for CRUD or files.

### 8.1 Operator → admin agent (internal)

Used by the operator (Claude Code in a terminal, curl, etc.) to talk to the
admin agent. Loopback-only by default; binding host configurable via env.

```
POST  /admin/<agentId>/send       { text, channelId?, threadId? } → 200
POST  /admin/<agentId>/abort      { threadId } → 200
POST  /admin/<agentId>/steer      { threadId, text } → 200
```

- `send` calls the admin plugin's `notify("user_message", payload)`. If
  `threadId` is present in the body, it becomes `context.threadIdOverride`
  on the notify so the message routes into a specific thread (e.g., to
  continue a conversation that started under a different plugin); otherwise
  the agent's `threadIdStrategy` resolves it from `(plugin, channelId)`.
  `channelId` defaults to `"operator"`.
- `abort` and `steer` proxy to `runner.abort(threadId)` and
  `runner.steer(threadId, text)` respectively.

`<agentId>` does not have to be `admin` — these routes work for any agent.
Typical use: operator sends to `admin`, the admin agent's scripts may then
relay or fan out internally.

### 8.2 External plugin webhooks

Single route family for inbound external traffic (Telegram, Gmail push,
generic webhooks):

```
ANY  /webhook/<agentId>/<pluginId>/<rest>
```

The HTTP handler (`apps/server/src/api/webhook.ts`, ~10 lines) parses
`agentId` and `pluginId` from the path, looks up
`instances[agentId][pluginId]` in memory, rewrites `req.url` to `/<rest>`,
and calls `plugin.handleHttpRequest(req, res)`. 404 if either id is
unknown or the plugin has no `handleHttpRequest`. 500 on handler throws.

The URL **is** the routing mechanism — there is no separate webhook file or
configuration. `ctx.httpBaseUrl` (set to
`<serverBaseUrl>/webhook/<agentId>/<pluginId>` during `plugin.start(ctx)`)
is the canonical URL each plugin instance registers with its external
service.

### 8.3 No WebSocket / no file API

There is no operator UI in v1, so neither WebSocket subscriptions nor a
file CRUD API exist. Agent state is on disk; the admin agent reads/writes
it directly via its own pi tools. When a UI is added later, a WebSocket
endpoint and `/api/agents/.../files` REST surface will be added — but
neither is in v1's contract.

---

## 9. Built-in plugins

### 9.1 admin (auto-installed on every agent)

Exposes one notification: `user_message`. The operator's `POST
/admin/<agentId>/send` (§8.1) calls `adminPlugin.notify("user_message",
{ text, channelId, threadIdOverride? })`. `channelId` defaults to
`"operator"`; `threadId` from the request becomes `threadIdOverride` so
the operator can address an existing thread.

This is the same flow Telegram and Gmail take — the operator chat is just
another plugin source.

### 9.2 platform (auto-installed only on privileged agents)

Privileged plugin that exposes platform-management tools to the admin
agent. **Not installed on regular agents.** The agent is privileged when
its `agent.json` has `"privileged": true`; the platform plugin is
auto-installed during agent creation in that case.

Receives an extended `PluginInstanceContext` (the `PrivilegedPluginContext`
in §9.5) with direct references to `agentManager` and `pluginRegistry`.
Seeds scripts under `scripts/platform/`:

- `create-agent`, `delete-agent`, `list-agents`, `read-agent`
- `install-plugin`, `uninstall-plugin`, `set-plugin-config`,
  `set-plugin-secrets`, `enable-notification`, `disable-notification`
- `write-plugin` (drop a plugin source folder under user-space root),
  `rescan-plugins`, `list-plugins`
- `tail-events`, `read-session`

Each script is a small Node CLI that calls back into its own plugin
instance over HTTP loopback (`${PI_WEBHOOK_BASE}/platform/internal/<verb>`),
which routes to the privileged context's helpers. No HTTP authentication —
the loopback URL is reachable only from inside the agent's own pi process
(which is running with the operator's permission).

Notifications declared: none. The platform plugin is one-way (admin agent
calls into it, no events emitted).

### 9.3 scheduler

Port of `temp/templates/plugins/scheduler`:

- `start()` watches `<stateDir>/schedules.json`, registers `croner` timers.
- On fire: `ctx.notify("schedule_fire", { text, channelId: scheduleName,
threadIdOverride: schedule.threadId, doNotSteer: true, metadata: {...} })`.
- Script `scripts/scheduler/scheduler-cli` reads/writes
  `plugins/scheduler/state/schedules.json` (relative to cwd).
- Seed system prompt documents the script to the agent.

Notifications declared: `schedule_fire`.

### 9.4 telegram

- Webhook plugin; defines `handleHttpRequest`.
- `start()` calls Telegram's `setWebhook` with `ctx.httpBaseUrl`
  (= `<serverBaseUrl>/webhook/<agentId>/telegram`).
- Inbound message → `ctx.notify("message_received", { text, channelId: chatId })`.
- Inbound file/photo → save to `<inboxDir>/<file>`; `text` includes
  `<fileName>[<agent-relative-path>]` (e.g. `plugins/telegram/inbox/voice_42.ogg`)
  so the agent — which runs with cwd=agentDir — can read it directly.
- Outbound: agent calls `scripts/telegram/telegram-cli send --chat <id> --text "..."`.
  The script POSTs to `${PI_WEBHOOK_BASE}/telegram/internal/send`.
  Plugin's `handleHttpRequest` routes `/internal/send` to its outbound code.

Notifications declared: `message_received`, `edited`.

### 9.5 PrivilegedPluginContext (used only by `platform`)

```ts
interface PrivilegedPluginContext extends PluginInstanceContext {
  agentManager: {
    create(spec: AgentCreateSpec): Promise<AgentSummary>;
    delete(id: string): Promise<void>;
    list(): AgentSummary[];
    get(id: string): AgentSummary | undefined;
    install(
      agentId: string,
      pluginId: string,
      config: unknown,
      secrets: Record<string, string>,
    ): Promise<void>;
    uninstall(agentId: string, pluginId: string): Promise<void>;
    setPluginConfig(
      agentId: string,
      pluginId: string,
      config: unknown,
    ): Promise<void>;
    setPluginSecrets(
      agentId: string,
      pluginId: string,
      secrets: Record<string, string>,
    ): Promise<void>;
    setNotificationEnabled(
      agentId: string,
      pluginId: string,
      name: string,
      enabled: boolean,
    ): Promise<void>;
  };
  pluginRegistry: {
    list(): PluginManifest[];
    writePluginSource(id: string, files: Record<string, string>): Promise<void>;
    rescan(): Promise<void>;
  };
  eventLog: {
    tail(agentId?: string, sinceMs?: number, limit?: number): EventLogRow[];
  };
}
```

Only the platform plugin's `start(ctx)` receives this shape. The runtime
gates the cast: building the context for a non-privileged agent strips the
extras even if some other plugin tries to import the type.

### 9.6 gmail

- Polling plugin (no inbound webhook).
- `start()` schedules an IMAP/Gmail-API poll every N seconds.
- New message → `ctx.notify("email_received", { text, channelId: threadId, metadata: {...} })`.
- Attachments saved to `<inboxDir>/`.
- Outbound: `scripts/gmail/gmail-cli send ...` loops back same as telegram.

Notifications declared: `email_received`.

---

## 10. Operator workflow

There is no operator UI in v1. The operator is a human in a terminal,
typically using Claude Code as the chat client. Two interfaces matter:

### 10.1 Talking to the admin agent

The operator's primary interface. `curl` (or any HTTP client) hits
`POST /admin/admin/send` with `{ text }` to send a message:

```bash
curl -X POST http://localhost:7331/admin/admin/send \
  -H 'content-type: application/json' \
  -d '{"text": "create a new agent named support, claude-sonnet-4-5, plugin_channel"}'
```

Claude Code can run this directly. The admin agent processes the message
through its normal pi runner cycle, decides what scripts to call (e.g.,
`scripts/platform/create-agent`), and the platform plugin's privileged
context executes the action. Streamed output goes to the event log
(§13.1); the operator polls the latest events or reads the agent's
session JSONL for full execution detail.

### 10.2 Inspecting state

Everything is on disk, so `cat`, `ls`, and `grep` work:

- `agent.json`, `system_prompts/`, `skills/agent/...` — read directly.
- `<agent>/sessions/<threadId>/<sessionId>.jsonl` — full conversation
  trace, parseable with `jq`.
- `<agent>/sessions/.events.db` — open with `sqlite3` for queue and event
  log inspection.

### 10.3 Editing files

Agent-authored files (`skills/agent/`, `prompts/agent/`, etc.) are
edited by either:

- The admin agent at the operator's request (preferred — keeps history
  in the admin agent's session).
- The operator directly via `$EDITOR` or Claude Code's edit tool.

Edits are picked up on the **next** batch; there is no mid-batch reload
and no file watcher.

### 10.4 Future UI

A separate web UI (file explorer + chat view + plugin settings forms) is
planned but out of v1 scope. It will be a thin layer over the existing
data model — adding REST endpoints for files/sessions and a WebSocket for
live events — without changing any of the core contracts in this doc.

---

## 11. Lifecycle sequences

### 11.1 Server boot

```
1. Load .env
2. Parse config: rootDir (default ~/.cognisphere), harnessId (default "default"),
   port, serverBaseUrl, timezone
3. PluginRegistry.scan() — dynamic-import:
   - apps/server/plugins/<id>/index.ts        (built-in)
   - <rootDir>/<harnessId>/plugins/<id>/index.ts  (user-space; may not exist)
4. AgentManager.scanAgents()
   - If no agent dir for "admin" exists → bootstrap it (run §11.7 with
     name="admin", privileged=true; auto-installs admin + platform plugins)
   - For each <rootDir>/<harnessId>/agents/<agentId>/:
     - Read agent.json
     - Construct AgentRunner; sweepInFlight() on its events.db
     - For each plugins/<pluginId>/ dir:
       - Look up pluginId in registry; construct PluginInstanceContext
         (or PrivilegedPluginContext if agent.json.privileged === true)
       - plugin.start(ctx)
     - runner.start()
5. Bind HTTP server on PORT
```

### 11.2 Notify → batch

```
plugin.notify(name, payload)
  → check notifications.json: name enabled? if no, drop silently
  → eventLog.append({ event: "notify", agent, plugin, name, channelId, status: "queued" })
  → resolve threadId via threadIdStrategy (or use threadIdOverride)
  → queue.enqueue({ ..., thread_id })
  → wakeWorker()

worker:
  → peekHighestPriorityThread() → threadId
  → dequeueBatch(threadId) → rows
  → activeBatches.set(threadId, { batch, phase: "spawning" })
  → eventLog.update(rows → status: "in_flight", batchId, sessionFile)
  → spawnPi(threadId)
  → write a single `prompt` frame: rows concatenated, each prepended with
    its own <harness-metadata> block (§6.4.1)
  → phase = "streaming"; forward pi events to runner.emit("agent_event", ...)
  → on agent_end: closeStdin, awaitExit
  → markBatchDone(ids); eventLog.update(rows → status: "done")
  → activeBatches.delete(threadId)
```

### 11.3 Operator → admin agent

```
POST /admin/admin/send { text, threadId?, channelId? }
  → adminPlugin.notify("user_message", {
       text,
       channelId:        body.channelId ?? "operator",
       threadIdOverride: body.threadId,           // when present
     })
  → (same flow as 11.2)
```

The admin agent's pi process processes the message. If the operator asked
to create an agent or install a plugin, the admin agent's prompt + skills
guide it to call its `scripts/platform/...` scripts; those scripts hit the
loopback URL of the platform plugin, which uses its privileged context to
do the actual work.

### 11.4 Plugin install (called from privileged context)

```
agentManager.install(agentId, pluginId, config, secrets)
  → registry.get(pluginId) → { ctor, sourceDir }
  → mkdir -p <agent>/plugins/<pluginId>/{state, inbox}
  → write <agent>/plugins/<pluginId>/config.json
    (validated against manifest.configSchema; merged with defaults)
  → write <agent>/plugins/<pluginId>/notifications.json
    (all notifications enabled by default)
  → recursively copy <sourceDir>/seed/ into <agent>/, with:
    - seed/system_prompt.md → <agent>/system_prompts/<N>-<pluginId>.md
      where N = next free slot (≥ 2)
    - other files preserved at their relative paths
    - existing target paths cause an error (operator must resolve)
  → store secrets in in-memory map keyed by (agentId, pluginId)
  → construct PluginInstanceContext; plugin.start(ctx)
  → eventLog.append({ event: "plugin_install", agent, plugin, status: "ok" })
```

### 11.5 Plugin uninstall (called from privileged context)

```
agentManager.uninstall(agentId, pluginId)
  → instance.stop()
  → remove <agent>/plugins/<pluginId>/
  → drop in-memory secrets for (agentId, pluginId)
  → seeded files in skills/, scripts/, prompts/, system_prompts/ left alone
  → eventLog.append({ event: "plugin_uninstall", agent, plugin, status: "ok" })
```

### 11.6 Agent creation (called from privileged context)

```
agentManager.create({ name, model, threadIdStrategy, privileged?, ... })

  → derive agentId from name (slug; append -2/-3/... on collision)
  → validate agentId is unused
  → mkdir <rootDir>/<harnessId>/agents/<agentId>/

  → render apps/server/agents/templates/base/agent.json.template
    with form values + defaults
    (tools, maxConcurrentSlots=1, maxAttempts=3, runtime="subprocess",
     privileged ?? false)
    → write <agent>/agent.json

  → copy templates/base/system_prompts/0-harness.md verbatim
    → <agent>/system_prompts/0-harness.md
  → render templates/base/system_prompts/1-agent.md.template
    → <agent>/system_prompts/1-agent.md
  → copy templates/base/workspace/index.md verbatim

  → mkdir empty subdirs:
    skills/agent/ scripts/agent/ prompts/agent/ extensions/agent/
    subagents/agent/ assets/ plugins/ sessions/ workspace/memory/

  → auto-install the admin plugin (§11.4)
  → if privileged: also auto-install the platform plugin (§11.4)

  → construct AgentRunner; runner.start()

  → eventLog.append({ event: "agent_create", agent, status: "ok" })
```

Failure handling: any step after the initial `mkdir` throws → the agent
dir is removed (rollback). The auto admin/platform installs are part of
the same transaction.

---

## 12. Secrets

Two sources, in priority order:

1. **In-memory override** — set by the admin agent via
   `platform.setPluginSecrets(...)`, scoped by `(agentId, pluginId)`.
   Lost on server restart.
2. **`.env` at server root** — keyed
   `AGENT__<agentId>__PLUGIN__<pluginId>__<KEY>` (uppercased; non-alpha
   chars become `_`). Read once at boot.

Plugin's `ctx.secrets` is the merge of (2) overlaid by (1). The admin
agent can `getSecretStatus(agentId, pluginId)` to see "set / not set" per
key from `secretsSchema`; the actual values are never returned over any
API.

No encryption, no on-disk per-agent secrets file.

---

## 13. Logging and event log

### 13.1 Free-form logging

Single root logger configured via env `LOG_LEVEL` (`debug` | `info` |
`warn` | `error` | `silent`, default `info`). Each agent runner and plugin
instance gets a child logger with scope `agent:<id>` /
`plugin:<agentId>:<pluginId>`. Output goes to stderr.

### 13.2 Event log (structured, durable)

Every notify and every batch state-change is appended to a structured event
log in the agent's `sessions/.events.db` (same SQLite file as the queue):

```sql
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,         -- unix ms
  event           TEXT NOT NULL,            -- notify | batch_start | batch_end |
                                            -- plugin_install | plugin_uninstall |
                                            -- agent_create | agent_delete | error
  agent_id        TEXT NOT NULL,
  plugin_id       TEXT,                     -- source plugin (when applicable)
  notification    TEXT,                     -- notification name (notify only)
  channel_id      TEXT,
  thread_id       TEXT,
  batch_id        TEXT,
  status          TEXT NOT NULL,            -- queued | in_flight | done | failed | dead | ok
  message_queue_id INTEGER,                 -- → messages.id (notify only)
  session_file    TEXT,                     -- absolute path to the JSONL file
                                            -- where this batch's execution lives
  message_index   INTEGER,                  -- index of the user message inside JSONL
  log             TEXT,                     -- short human-readable summary
  error           TEXT
);
CREATE INDEX idx_events_ts        ON events(ts);
CREATE INDEX idx_events_thread    ON events(thread_id, ts);
CREATE INDEX idx_events_status    ON events(status, ts);
```

`session_file` + `message_index` is the "hyperlink" — given those two
values, a future UI can deep-link directly to the assistant turn that
processed this event. Today the operator opens the JSONL with `jq` at the
given index. The platform plugin's `tail-events` script renders the most
recent rows; long-term a UI surfaces the same data with click-through.

The event log is append-only; rows are never deleted (if it grows too
large, run a manual `VACUUM` + `DELETE WHERE ts < ?`).

---

## 14. Error handling boundaries

| Layer                                                  | Failure mode        | Behavior                                                                                   |
| ------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------ |
| `plugin.start()` throws                                | startup error       | Log, mark plugin "failed", emit `error` event, do not retry.                               |
| `plugin.notify()` callback (the harness's impl) throws | bug                 | Log; never propagate to plugin code.                                                       |
| `handleHttpRequest` throws                             | request error       | Caught at server; 500 to client.                                                           |
| pi spawn fails                                         |                     | Mark batch failed, retry per `maxAttempts`.                                                |
| pi exits non-zero before agent_end                     |                     | Same as above.                                                                             |
| pi never emits agent_end                               |                     | After 30 min (configurable) hard-kill, mark failed.                                        |
| SQLite write fails                                     |                     | Crash the process. Indicates disk problem; let supervisor restart.                         |
| `platform.*` throws                                    | privileged op error | Surfaces as the loopback HTTP response → admin agent sees it as a tool error and re-plans. |

---

## 15. Future work (out of scope for v1)

| Item                                    | Sketch                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator UI                             | Web app: file explorer + chat view + plugin settings forms. Adds REST endpoints for files/sessions and a WebSocket for live runner events. Keeps every contract in this doc unchanged. |
| Docker isolation                        | One container per agent, mount agent dir at `/agent`, `docker exec` for each pi batch. Plugins stay on host. Container lifecycle managed by `DockerSupervisor`.                        |
| Permission control                      | When docker is added: container's root mount is read-only; only `workspace/` and `sessions/` are rw. v1's "everything is rw" stays via a switch.                                       |
| Per-agent Node process                  | Extract `AgentSupervisor` that spawns one Node child per agent over a unix socket. Server proxies webhook + admin requests to the right child.                                         |
| Multi-instance plugins                  | `<agent>/plugins/telegram@home/`, `telegram@work/` — instance id = directory basename. Manifest already supports it (no id fields).                                                    |
| Custom thread-id strategy               | `<agent>/threadId.ts` exporting `(ctx) => string`, agent.json strategy `{ "type": "custom" }`. jiti-loaded.                                                                            |
| Encrypted secrets                       | OS keychain integration (`keytar`); fallback to age-encrypted file.                                                                                                                    |
| Hot-edit of existing user-space plugins | Today rescan is add-only; an upgrade stops instances → clears jiti cache for the changed path → reloads → restarts instances.                                                          |
| Process-isolated user-space plugins     | When the in-process model bites: run each user-space plugin in a Node worker thread or child process. Built-in plugins keep in-process.                                                |
| Pre-flight type check on plugin write   | `platform.writePluginSource` runs files through `esbuild` / `tsc --noEmit` before `rescan` accepts them. v1 trusts the admin agent to write valid TS.                                  |

---

## 16. Out-of-doc references

- pi RPC protocol: `temp/pi-mono/packages/coding-agent/docs/rpc.md`
- pi event types: `temp/pi-mono/packages/coding-agent/docs/json.md`
- Scheduler plugin reference: `temp/templates/plugins/scheduler/`
- Sample agent skeleton: `temp/sample_agent/`
