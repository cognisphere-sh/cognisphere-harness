# CogniSphere — HTTP API

This doc describes the server's HTTP surface as it exists today. The
agent-runner subsystem (lifecycle, queues, RPC) is documented separately
in [`server.md`](./server.md); this doc covers only what's reachable over
HTTP and how routes are gated.

If you're new and want to read code: start in `packages/harness/src/core/main.ts`,
follow `packages/harness/src/api/*.ts`.

---

## Table of contents

1. [Mount points and auth model](#1-mount-points-and-auth-model)
2. [Public routes](#2-public-routes)
3. [Auth routes — `/api/auth/*`](#3-auth-routes--apiauth)
4. [Agents — `/api/agents/*`](#4-agents--apiagents)
5. [Filesystem — `/api/agents/:id/fs/*`](#5-filesystem--apiagentsidfs)
6. [Secrets — `/api/secrets`](#6-secrets--apisecrets)
7. [Models — `/api/models`](#7-models--apimodels)
8. [Harness — `/api/harness`](#8-harness--apiharness)
9. [Admin chat — `/admin/*`](#9-admin-chat--admin)
10. [Plugin webhooks — `/webhook/*`](#10-plugin-webhooks--webhook)
11. [Conventions](#11-conventions)

---

## 1. Mount points and auth model

Everything is served by a single Node `http.Server`. Routes split into
three surfaces:

- **Hono routes** mounted in `main.ts`: `/healthz`, `/api/*`, `/admin/*`,
  and the static SPA shell (when `packages/web/dist` exists).
- **Raw `IncomingMessage`/`ServerResponse` dispatch** for
  `/webhook/<agentId>/<pluginId>/*`. The plugin's `handleHttpRequest`
  expects raw req/res; the harness splices a `request` listener onto
  the underlying `http.Server` that intercepts the prefix, strips it,
  and delegates to the plugin. Hono runs only when no `/webhook/`
  match.
- **The SPA** (only when `packages/web/dist` is present): `/`, `/login`,
  `/settings`, `/settings/*`, `/agents/*` are served as `index.html`
  so the client-side router can pick up.

**Auth gating** (set up in `main.ts:42–60`):

| Surface | Auth? |
|---|---|
| `/healthz` | Public |
| `/api/auth/*` | Public (login itself can't require auth) |
| `/api/*` (other) | `requireAuth` middleware — 401 on bad cookie |
| `/admin/*` | `requireAuth` middleware — 401 on bad cookie |
| `/webhook/*` | None — external services (Telegram, Gmail push, …) hit this surface with their own signature schemes if at all |
| Static SPA pages | None — the page shell is public; the SPA itself calls `/api/*` and gets 401 → redirected to `/login` |

`requireAuth` reads the `pi_sid` cookie, validates the HMAC-signed
session payload, and sets `c.var.user = username` on success. Failures
return `{ "error": "unauthenticated" }` with HTTP 401.

---

## 2. Public routes

### `GET /healthz`

Liveness probe. Always 200.

```json
{ "ok": true, "agents": 3 }
```

`agents` is the count of loaded `AgentInstance`s — includes
running, stopped, and failed agents. Use it to verify the server is up,
not to gauge agent health (use `/api/agents` for that).

---

## 3. Auth routes — `/api/auth/*`

Implemented in `packages/harness/src/api/auth.ts`. File-backed user store at
`<harnessRoot>/.secrets/users.json`:

```json
{ "users": [{ "username": "admin", "password": "changeme" }] }
```

Plaintext passwords, same trade-off as `secrets.json`. On startup
(`ensureCredentials` in `auth.ts`, called from `main.ts` before the server
binds), if this file is missing, empty, or still holds the default
`admin / changeme`, the operator is prompted on the terminal for a username
and password (password input is echo-muted) and the file is written from
those values. When stdin is not a TTY (e.g. under systemd) the prompt is
skipped and the legacy `admin / changeme` placeholder is created instead —
change it before exposing the server. Sessions are stateless signed cookies; the 32-byte HMAC key
lives at `<harnessRoot>/.secrets/session-key` and is generated on first boot.
Deleting that file invalidates every issued cookie.

### `POST /api/auth/login`

```json
{ "username": "admin", "password": "changeme" }
```

Responses:

- `200 { "ok": true, "username": "admin" }` — sets `pi_sid` cookie
  (`httpOnly`, `sameSite=Lax`, 7-day `maxAge`).
- `400 { "error": "username and password required" }`.
- `401 { "error": "invalid credentials" }`.

Password comparison is timing-safe.

### `POST /api/auth/logout`

Clears the `pi_sid` cookie. Always `200 { "ok": true }`. No server-side
revocation — the cookie is just deleted; existing copies of the same
token elsewhere are still valid until they expire (or until
`session-key` is rotated).

### `GET /api/auth/me`

Always 200. Returns `{ "user": "<username>" }` for an authenticated
session, otherwise `{ "user": null }`. Useful for the SPA to decide
between rendering the login form and the app shell.

---

## 4. Agents — `/api/agents/*`

Implemented in `packages/harness/src/api/agents.ts`. All routes require auth.

`agents.list()` / `am.get()` / runtime DB methods are the data source;
mutations route through `AgentManager` lifecycle calls described in
[`server.md` §4.9](./server.md#49-agentmanager--agent-managerts).

### `GET /api/agents`

```json
{ "agents": [ AgentSummary, ... ] }
```

`AgentSummary` = `{ id, name, installedPlugins, state, error,
runningPlugins, failedPlugins }`. `state` ∈ `running | stopped |
failed`. `installedPlugins` enumerates every dir under
`<agentDir>/plugins/`, including ones that failed to start (so the UI
can show a row to fix). `runningPlugins` / `failedPlugins` are
partitions of that list.

### `GET /api/agents/:id`

```json
{
  "id": "...",
  "name": "...",
  "agentJson": { ... },
  "installedPlugins": [...],
  "state": "running",
  "error": null,
  "changedAt": 1731000000000
}
```

`agentJson` is the parsed `agent.json` (may be `null` when the agent
failed to load due to a parse error — `error` will say why).
`changedAt` is the last lifecycle transition timestamp.

404 if the id is unknown.

### `GET /api/agents/:id/plugins`

```json
{ "plugins": [
  {
    "pluginId": "telegram",
    "manifest": PluginManifest | null,
    "config":   unknown,
    "state":    "running" | "stopped" | "failed",
    "error":    string | null,
    "changedAt": 1731...
  }
]}
```

Iterates every entry in `inst.plugins`, including failed ones. `config`
falls back to reading `<plugin>/config.json` directly when the plugin
entry's cached config is null (so the UI can still render the form
for a plugin that failed during start). `manifest` is null only if the
plugin id is no longer in the registry (e.g. its source dir was deleted
without restarting).

### Lifecycle

| Method | Path | Effect |
|---|---|---|
| POST | `/api/agents/:id/start`   | `am.manualStart(id)`. From `stopped` or `failed` → `running` / `failed`. 409 if already running. |
| POST | `/api/agents/:id/stop`    | `am.manualStop(id)`. Aborts active batches. 409 if not running. |
| POST | `/api/agents/:id/restart` | `am.restartAgent(id)`. Stop (if running) → start. Full re-read of agent.json + plugin configs + secrets. |

Response shape (all three):

```json
{ "ok": true, "state": "running", "error": null }
```

`LifecycleError` codes map to HTTP status:

| `LifecycleError.code` | HTTP | Meaning |
|---|---|---|
| `not_found` | 404 | Unknown agent id |
| `conflict`  | 409 | Already in the requested state, or a transition is already in flight |

Any other error → `500 { "error": <message> }`.

### Editing config (auto-reload, no restart)

| Method | Path | Effect |
|---|---|---|
| PUT | `/api/agents/:id/config` | Write `agent.json`, then `am.reloadAgent(id)` |
| PUT | `/api/agents/:id/plugins/:pluginId/config` | Write `<plugin>/config.json`, then `am.reloadPlugin(id, pid)` |

Both expect `{ "config": <json> }` and validate that `config` is a
plain object (not array, not null). The write is unconditional;
validation against the plugin manifest's `configSchema` happens at
reload time. If the new config fails validation, the plugin moves to
`state="failed"` with `error` populated — the file write succeeded; the
runtime rejection is surfaced in the next `/api/agents/:id/plugins`
response.

`reloadAgent` uses the soft-swap protocol (see [`server.md`
§5.5](./server.md#55-soft-reload-reloadagent)) — zero interruption to
in-flight batches. `reloadPlugin` bounces the single plugin in place
without touching the runner.

Response:

```json
{ "ok": true, "restartRequired": false, "state": "running", "error": null }
```

`restartRequired` is always `false`; the field exists for forward-
compatibility with future settings that *would* need a full restart.

### Sessions browse

| Method | Path | Effect |
|---|---|---|
| GET | `/api/agents/:id/sessions` | List threads under `<agent>/sessions/` and their `.jsonl` files, newest-first. |
| GET | `/api/agents/:id/sessions/:threadId/:sessionId` | Read the JSONL file as an array of parsed entries. |
| GET | `/api/agents/:id/sessions/:threadId/usage` | Per-(agent, model) token + cost totals for the thread. Aggregates every assistant message in every `*.jsonl` under `<agent>/sessions/<threadId>/` (main agent) and `<agent>/sessions/<threadId>/subagents/*/` (one entry per sub-agent dir). |
| PUT | `/api/agents/:id/sessions/:threadId/model` | Set or clear the thread's model override. Takes effect on the next batch (no agent reload). |
| DELETE | `/api/agents/:id/sessions/:threadId` | Permanently remove a thread — drops every `events` row for the thread, its `threads` row, and the on-disk `<agent>/sessions/<threadId>/` directory (all sessions). Returns `409` if a batch is in-flight; abort it first. |

Session list response:

```json
{ "threads": [
  {
    "threadId": "telegram:42",
    "activeSessionId": "01HX...",
    "sessions": [
      { "sessionId": "01HX...", "modified": 1731..., "size": 12345 },
      ...
    ],
    "lastContext": {
      "tokens": 12345,
      "contextWindow": 200000,
      "model": "anthropic/claude-sonnet-4-6"
    },
    "totalCost": 0.4231,
    "modelOverride": {
      "provider": "openai",
      "modelId": "gpt-5",
      "thinkingLevel": "high"
    }
  }
]}
```

`lastContext` is a tail-read (last ~128 KiB) of the active session's
jsonl: the most-recent non-aborted assistant message's context tokens
(`usage.totalTokens` or the input/output/cacheRead/cacheWrite sum) and
the model's context window from pi-ai's registry. `null` when no
assistant message exists yet (or it's older than the tail window);
`contextWindow` is `null` for model ids not in the registry. A
`modelOverrides.<modelId>.contextWindow` entry in
`.secrets/models.json` takes precedence over the registry (see
[§7](#7-models--apimodels)).

`totalCost` is the sum of `usage.cost.total` across every assistant
message in every session file in the thread (main agent + every
sub-agent dir under `subagents/`). Per-file totals are cached by
`(path, mtimeMs)` so unchanged jsonls aren't re-parsed on each 5s
poll. `0` when no assistant messages have landed yet, **`null` while
the per-file cache is warming** for that thread — the threads list
only reads from the cache on the hot path; cold entries trigger a
background warm-up (single setImmediate per thread) and the next
poll returns the real number. This keeps page-open fast on agents
with hundreds of session files.

Per-session response:

```json
{ "threadId": "...", "sessionId": "...", "entries": [ <jsonl row>, ... ] }
```

Malformed JSONL lines are silently skipped. `threadId` and `sessionId`
must each be a single path segment (no `/`, `\`, NUL, leading `.`, or
length > 256) so they can't escape the agent's `sessions/` directory;
otherwise any character — including spaces, parens, brackets, and
unicode — is allowed, since harness-created thread ids reflect external
inputs like email subjects.

Delete response:

```json
{ "ok": true, "threadId": "...", "events": 17, "removedDir": true }
```

`events` is the number of `events` rows deleted; `removedDir` is `false`
if the on-disk directory did not exist (e.g. a thread that only ever had
queued events and was deleted before its first batch ran).

`modelOverride` is the thread's per-thread model override, or `null` when
the thread inherits the agent's `agent.json` model. When set, the runner
uses this provider/model/thinking for the thread's next batch — including
a provider different from the agent default (cross-provider), whose
credentials are injected at spawn time.

Set-model request:

```json
{ "provider": "openai", "modelId": "gpt-5", "thinkingLevel": "high" }
```

`thinkingLevel` is optional (`off|minimal|low|medium|high|xhigh`; omit or
`null` to inherit the agent's thinking level). Sending `provider: null` or
`modelId: null` **clears** the override (the thread reverts to the agent
default). Validation: `provider` must be a configured catalog provider and
`modelId` must be in that provider's `enabledModels` (else `400`). Returns
`409` if the thread has no `threads` row yet (no session bound — send a
message first). Response: `{ "ok": true }`. The override is stored on the
`threads` row and read live by the runner, so no agent reload occurs.

Usage response:

```json
{
  "threadId": "...",
  "main": {
    "agent": "main",
    "models": [
      {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "input": 1234, "output": 567,
        "cacheRead": 8910, "cacheWrite": 11,
        "cost": {
          "input": 0.0037, "output": 0.0085,
          "cacheRead": 0.0027, "cacheWrite": 0.00004,
          "total": 0.01494
        }
      }
    ],
    "lastContext": {
      "tokens": 12345,
      "contextWindow": 200000,
      "model": "anthropic/claude-sonnet-4-6"
    }
  },
  "subagents": [
    { "agent": "<subAgentId>", "models": [ ... ], "lastContext": { ... } }
  ]
}
```

One row per distinct `<provider>/<model>` — a `model_change` mid-session
yields multiple rows. Sub-agents are discovered by scanning
`<agent>/sessions/<threadId>/subagents/*/`; the directory name is used
as the `agent` label. Tokens and costs come from the `usage` block
`pi-ai` writes onto each assistant message; messages without a `usage`
block (e.g. errored before the API returned) are skipped silently.
`lastContext` tracks the highest-timestamp non-aborted assistant
message seen across that agent's session files (same shape as the
threads-list field).

### Events stream

The agent's queue, dead-letter, and audit log are unified into one
`events` table (one row per logical event). The UI's Events tab reads
it through these endpoints.

| Method | Path | Effect |
|---|---|---|
| GET    | `/api/agents/:id/events` | List events with filter / sort / pagination |
| POST   | `/api/agents/:id/events/:rowId/requeue` | Reset a `status=failed` row back to `queued` (attempts=0, error cleared) |
| POST   | `/api/agents/:id/events/:rowId/status` | Force a non-in-flight row to a new status (`queued`, `done`, `failed`, `cancelled`) |
| DELETE | `/api/agents/:id/events/:rowId` | Permanently drop a non-in-flight row |

#### `GET /api/agents/:id/events`

Query params (all optional):

| Param | Value | Default |
|---|---|---|
| `status` | comma-separated subset of `queued,in_flight,done,failed,cancelled` | (no filter) |
| `plugin` | exact `pluginId` match | (no filter) |
| `search` | substring match against `text` (case-sensitive `LIKE`) | (no filter) |
| `isSilent` | `true` (silent only) or `false` (non-silent only); omit for both | (no filter) |
| `tsFrom`, `tsTo` | epoch ms, filter on row `ts` | (no filter) |
| `updatedFrom`, `updatedTo` | epoch ms, filter on row `updated_at` | (no filter) |
| `sortBy` | one of `ts`, `updated_at`, `status`, `plugin_id`, `thread_id` | `updated_at` |
| `sortDir` | `asc` or `desc` | `desc` |
| `limit` | int, clamped to [1, 1000] | `200` |
| `offset` | int, ≥ 0 | `0` |

Response:

```json
{
  "events": [
    {
      "id": 17,
      "ts": 1731000000000,
      "updatedAt": 1731000004210,
      "pluginId": "telegram",
      "channelId": "chat-42",
      "threadId": "telegram:chat-42",
      "isSilent": false,
      "text": "user message body",
      "metadata": { "_notification": "message" },
      "status": "done",
      "priority": 0,
      "attempts": 0,
      "error": null,
      "piSessionId": "8f2c4f1e-…",
      "piEntryId":   "a1b9d2e7-…"
    }
  ],
  "total": 1234
}
```

`piSessionId` and `piEntryId` link the row to a position in pi's session
JSONL: `<agentDir>/sessions/<threadId>/<piSessionId>.jsonl`, with
`piEntryId` pointing at the user-message entry inside that file.
`piEntryId` is written **in real time** as the message is delivered to the
model (via a harness-owned pi extension), so it is populated while the row
is still `in_flight` and on rows whose batch later failed — it is `null`
only for a row that never reached the model. Multiple rows in the same
prompt share a single `piEntryId` (the runner concatenates queued events
into one prompt); each row added via live steer gets its own. A set
`piEntryId` also marks the row as already-delivered: if it is later
requeued, the runner retries it in *continue* mode (a short nudge) rather
than resending the original text.

`total` is the count after filters are applied (before paging) so the
UI can render a pager.

Requeue returns `{ ok: true, id: <rowId> }` — the row id is preserved
(no new row is created). It 404s if the target row does not exist or is
not in `status=failed`. `piEntryId` is preserved, so a row that was
delivered before it dead-lettered requeues in *continue* mode rather than
resending its text.

Status-set takes `{ "status": "queued" | "done" | "failed" | "cancelled" }`
and returns `{ ok: true, status }`. Setting `queued` resets `attempts`
and clears `error` (same effect as requeue), and likewise preserves
`piEntryId`. `in_flight` cannot be set from the UI — it belongs to the
runner.

Delete returns `{ ok: true }`. Both delete and status-set 409 when the
target row is currently `in_flight` (abort the batch first), 404 when
the row does not exist. 503 when the agent has no `AgentDb` open (only
possible briefly during shutdown).

---

## 5. Filesystem — `/api/agents/:id/fs/*`

Implemented in `packages/harness/src/api/files.ts`. Used by the web UI's
file editor to browse the agent's directory and edit files in place.

Every route validates that the resolved absolute path is contained
within the agent's directory (`resolveSafe`); requests with `..`
segments or absolute path values return 400 `"path escapes agent
dir"`.

`path` is always relative to the agent dir; `""` and `.` mean the
root.

### `GET /api/agents/:id/fs/tree?path=`

One-level directory listing. Hidden files (`.`-prefixed) are excluded.

```json
{
  "path": ".",
  "entries": [
    { "name": "workspace", "path": "workspace", "isDir": true,  "size": 0,   "modified": 1731... },
    { "name": "agent.json","path": "agent.json","isDir": false, "size": 412, "modified": 1731... }
  ]
}
```

Directories sort before files; alpha within each group.

### `GET /api/agents/:id/fs/file?path=`

Read a text file. Returns:

```json
{ "path": "...", "content": "<utf8 text>", "size": 412, "modified": 1731... }
```

Errors:

- `404` — no such file.
- `400` — not a file (i.e. a directory).
- `413` — file larger than 4 MiB. Refusing prevents the UI from trying
  to load megabyte blobs into an editor.
- `415` — file looks binary (any null byte or control char outside
  `\t\r\n` in the first 1 KiB). Use `/raw` to download instead.

### `PUT /api/agents/:id/fs/file?path=`

```json
{ "content": "<utf8 text>" }
```

Creates parent dirs as needed. Always writes utf-8. Returns:

```json
{ "path": "...", "size": 412, "modified": 1731... }
```

No content-type validation — the UI is trusted. There is **no
plugin/runner notification** after this write; if the file is part of
plugin config or agent.json, the caller is responsible for hitting
the appropriate PUT endpoint that triggers `reloadAgent` /
`reloadPlugin`. Editing `workspace/`, `system_prompts/`, and other
free-form files is fine and doesn't require any reload.

### `GET /api/agents/:id/fs/raw?path=&download=1`

Serves the file as raw bytes with a guessed mime type and a
`content-disposition` header. `?download=1` switches to `attachment`
disposition; otherwise `inline`. Used by the chat UI to display
inline images / attachments produced by the agent.

Errors return empty bodies with status codes only (404, 400) to
keep the response shape clean for `<img>` and download flows.

### `POST /api/agents/:id/fs/upload?dir=<rel>`

Multipart upload. Form field name is `file`. `dir` defaults to
`uploads`. Filename is sanitized to `[A-Za-z0-9._-]+`. Returns:

```json
{ "path": "uploads/photo.jpg", "size": 12345, "name": "photo.jpg" }
```

### `POST /api/agents/:id/fs/mkdir?path=<rel>`

Recursive mkdir. Returns `{ "path": "<rel>" }`.

---

## 6. Secrets — `/api/secrets`

Implemented in `packages/harness/src/api/secrets.ts`. Both routes require
auth.

The wire and on-disk shapes are identical (bucketed under each agent;
see [`server.md` §4.4](./server.md#44-secretsstore--secretsts)). The
reserved bucket id `agent` (`AGENT_BUCKET`) holds keys declared in
`agent.json.secretsSchema`; other ids are plugin ids.

### `GET /api/secrets`

```json
{
  "secrets": { "<agentId>": { "<bucketId>": { "<KEY>": "********" } } },
  "schemas": { "<agentId>": { "<bucketId>": JsonSchema } },
  "agentBucket": "agent",
  "mask": "********",
  "path": "/.../secrets.json"
}
```

- Every value is masked to `********` if it's set, `""` if empty.
- `schemas` includes the agent-level schema (under `agentBucket`) when
  `agent.json.secretsSchema` is set, and one entry per installed
  plugin (including failed ones, so the operator can populate secrets
  to fix a startup failure).
- Agents are surfaced even if they have no entries on disk yet
  (empty bucket map).
- The top-level `_format` / `_usage` / `_example` doc keys in the
  file are filtered out of the response.

### `PUT /api/secrets`

```json
{
  "secrets": {
    "<agentId>": {
      "<bucketId>": {
        "KEY_TO_SET":   "new-value",
        "KEY_TO_KEEP":  "********",
        "KEY_TO_CLEAR": null
      }
    }
  }
}
```

Semantics:

- Plain string → set/overwrite.
- `null` → delete.
- The mask sentinel `"********"` → leave existing untouched (used by
  the UI for round-tripping: it shows masked values, sends them back
  unchanged unless the operator edited them).

The write merges into the existing file, preserves the doc-header
(`_*` keys), and writes at 0600.

After saving, the route calls `am.reloadAgent(aid)` for every agent
named in the body. `reloadAgent` invalidates the secrets cache and
swaps in a fresh runner once active batches drain (see [`server.md`
§5.5](./server.md#55-soft-reload-reloadagent)). Response:

```json
{ "ok": true, "restartRequired": false, "restarted": ["dr-renu"] }
```

`restarted` lists the agents that successfully transitioned (or
remained) running after the reload. Per-agent reload errors are
logged but don't fail the save — the file write already succeeded.

---

## 7. Models — `/api/models`

Implemented in `packages/harness/src/api/models.ts`. Reads/writes the global
`<harnessRoot>/.secrets/models.json`. All routes require auth.

The provider catalog (id, displayName, `CredField[]`, default model
list, optional notes, optional `oauth` flag) is fixed in
`models-catalog.ts`. Only the per-provider `credentials`,
`enabledModels`, and optional `modelOverrides` (per-model
`contextWindow`/`maxTokens` layered over pi-ai's built-in catalog,
used for context-window reporting) are persisted to models.json;
OAuth subscription tokens
are persisted to pi's own `<piAgentDir>/auth.json` (see
[§7.1](#71-oauth-subscription-login--apimodelsoauth)).

### `GET /api/models`

```json
{
  "providers": [
    {
      "id": "anthropic",
      "displayName": "Anthropic",
      "credentials": [ CredField, ... ],
      "credentialValues": { "apiKey": "********" },
      "configured": true,
      "catalogModels": ["claude-sonnet-4-5", "claude-opus-4-7", ...],
      "enabledModels": ["claude-sonnet-4-5"],
      "modelOverrides": { "claude-sonnet-4-5": { "contextWindow": 1000000 } },
      "notes": "...",
      "oauth": { "supported": true, "connected": false }
    },
    ...
  ],
  "path": "/.../models.json",
  "mask": "********"
}
```

Per-field rules in `credentialValues`:

- Empty / unset → `""`.
- `secret: true` field with a value → `"********"`.
- Non-secret field with a value → the plaintext value (so the UI can
  show region selectors etc.).

`oauth` is present only for providers with subscription OAuth support
(catalog `oauth: true`); `connected` reflects whether OAuth credentials
exist in pi's auth.json.

`configured` is true iff every `required` credential is populated, or
subscription OAuth is connected. Providers with an empty `credentials`
schema (OAuth-only, e.g. `openai-codex`) are configured iff connected.

### `PUT /api/models`

```json
{
  "providers": {
    "anthropic": {
      "credentials": { "apiKey": "sk-ant-..." },
      "enabledModels": ["claude-sonnet-4-5"],
      "modelOverrides": {
        "claude-sonnet-4-5": { "contextWindow": 1000000 }
      }
    }
  }
}
```

Same null / mask / string sentinel semantics as
[`/api/secrets`](#6-secrets--apisecrets) for the `credentials` map.

Filters:

- Providers not in the catalog are silently ignored (preserves the
  store's read-only model for stale entries — won't let the client
  resurrect a deleted catalog id).
- Credential keys not declared on the provider's `CredField[]` are
  ignored.
- `enabledModels` entries must be non-empty strings; non-strings are
  dropped.
- `modelOverrides` merges per model: `null` for a model deletes its
  entry; an object replaces it wholesale. Values must be finite
  positive numbers (`contextWindow`, `maxTokens`) — anything else is
  dropped by the store's normalize on save.

After saving, the route reloads every running agent whose
`agentJson.model.provider` matches one of the touched providers
(again via `reloadAgent`). Response:

```json
{ "ok": true, "restartRequired": false, "restarted": ["dr-renu"] }
```

### 7.1 OAuth subscription login — `/api/models/oauth/*`

Browser-driven sign-in for subscription providers (Anthropic Claude
Pro/Max, OpenAI Codex). The server drives pi-ai's OAuth flow via
pi-coding-agent's `ModelRuntime`; tokens land in pi's own
`<piAgentDir>/auth.json` (default `~/.pi/agent/auth.json`), never in
models.json. See `docs/server.md` §oauth-logins for the design
rationale. All routes require auth. `:provider` must be a catalog entry
with `oauth: true`, else 404.

#### `POST /api/models/oauth/:provider/login`

Starts (or restarts — any pending flow for the provider is cancelled
first) a login flow. Resolves once the flow surfaces its first
interaction:

```json
{ "state": "pending", "url": "https://claude.ai/oauth/authorize?...", "instructions": "..." }
```

The pending shape can carry any of (all optional, provider/step
dependent):

- `url` + `instructions` — authorize URL to open in a new tab. If the
  harness server runs on the same machine as the browser, the
  provider's localhost callback server (fixed port, e.g. 53692 for
  Anthropic, 1455 for Codex) completes the flow automatically.
  Otherwise the operator pastes the final redirect URL via the `input`
  route.
- `select` — `{ message, options: [{ id, label }] }`, an outstanding
  choice (e.g. Codex: "Browser login" vs "Device code login"). Answer
  via `input` with `kind: "select"`. Device-code login is the right
  pick when the harness is hosted remotely — no localhost callback
  involved.
- `deviceCode` — `{ userCode, verificationUri }`, shown to the
  operator who enters the code at the verification URL; the server
  polls until authorized. No input needed.
- `prompt` — `{ message, placeholder? }`, an outstanding free-text
  question. Answer via `input` with `kind: "text"`.

#### `POST /api/models/oauth/:provider/input`

```json
{ "value": "<redirect URL, code, or select option id>", "kind": "text" | "select" }
```

Feeds operator input into the pending flow. `kind` defaults to
`"text"` (redirect-URL paste / prompt answer); `"select"` answers an
outstanding `select` with an option id. 400 if `value` is missing,
409 if no pending login is awaiting that kind of input.

#### `GET /api/models/oauth/:provider/status`

Poll while a flow is pending:

```json
{ "state": "idle" | "pending" | "success" | "error", "url": "...", "instructions": "...", "select": {...}, "deviceCode": {...}, "prompt": {...}, "message": "<error only>" }
```

`success`/`error` are the last terminal outcome, cleared on the next
`login`. On success the server has already persisted the tokens and
reloaded running agents using the provider.

#### `POST /api/models/oauth/:provider/cancel`

Aborts a pending flow (no-op if none). `{ "ok": true }`.

#### `DELETE /api/models/oauth/:provider`

Sign out: cancels any pending flow, removes the provider's tokens from
pi's auth.json, reloads running agents using the provider.

```json
{ "ok": true, "restarted": ["dr-renu"] }
```

---

## 8. Harness — `/api/harness`

Implemented in `packages/harness/src/api/harness.ts`. Reads/writes the
harness-wide settings file at `<harnessRoot>/harness.json`. Both routes
require auth.

The file has two keys: `timezone` (IANA string) and `version` (the
data/migration version, written by `cognisphere init` and bumped by the
upgrade skill). `timezone` feeds the `<harness-metadata>` block on every
spawned batch and the scheduler plugin's cron timer; `version` is read-only
over this API (only `timezone` is editable here).

### `GET /api/harness`

```json
{ "timezone": "Asia/Kolkata", "version": "0.3.0", "path": "/.../harness.json" }
```

`timezone` defaults to `UTC` if the file is missing or malformed; `version`
is `""` when the file predates versioning.

### `PUT /api/harness`

```json
{ "timezone": "America/Los_Angeles" }
```

The route validates the string against `Intl.DateTimeFormat` (rejects
unknown IANA ids with 400), writes the file (**preserving** the `version`
stamp), mutates `cfg.timezone` in place, and calls `reloadAgent` on every
loaded agent so the new value reaches running runners and plugin contexts
without a server bounce.
Response:

```json
{ "ok": true, "timezone": "America/Los_Angeles", "restarted": ["dr-renu"] }
```

---

## 9. Admin chat — `/admin/*`

Implemented in `packages/harness/src/api/admin.ts`. Both routes require
auth. Predates the `/api` namespace; the SPA's chat view still calls
these.

### `POST /admin/:agentId/send`

```json
{ "text": "hello", "channelId": "operator", "threadId": "admin:operator" }
```

`channelId` and `threadId` are optional. The admin plugin's
`deliver()` ends up calling `ctx.notify("user_message", { text,
channelId, threadIdOverride })`, which goes through
`runner.notify()` — so it's enqueue-or-steer just like any other
plugin notification. No special operator privileges.

Errors:

- `404` — unknown agent.
- `400` — missing/empty `text`.
- `500` — admin plugin not installed on this agent.
- `503` — admin plugin installed but not currently running (agent is
  stopped/failed).

Success: `{ "ok": true }`.

### `POST /admin/:agentId/abort`

```json
{ "threadId": "admin:operator" }
```

Calls `runner.abort(threadId)` — sends an `abort` RPC frame to the
live `pi` child for that thread and marks the batch cancelled (no
retry). Returns `{ ok: true|false }` where `ok` is whether there was
actually an active batch to abort.

Errors:

- `404` — unknown agent.
- `400` — missing `threadId`.
- `503` — agent not running.

---

## 10. Plugin webhooks — `/webhook/*`

Implemented in `packages/harness/src/api/webhook.ts`. **Not** gated by auth
— this surface receives unauthenticated external traffic.

URL shape: `/webhook/<agentId>/<pluginId>/<rest>`. The harness:

1. Strips the prefix.
2. Looks up the agent and the plugin.
3. Rewrites `req.url` to `<rest>?<query>` (the plugin sees a clean
   relative path, not the full webhook path).
4. Awaits `plugin.handleHttpRequest(req, res)`.

The plugin gets the raw Node `IncomingMessage` and `ServerResponse` —
no Hono wrapping. This is intentional: existing plugin ecosystems
(Telegram, GitHub, etc.) speak HTTP at this level and we don't want
to re-implement headers/streaming concerns. The plugin owns
authentication (signature verification, secret-in-URL, allowed IPs,
…) if the upstream service supplies one.

Responses (the dispatcher's, before the plugin runs):

- `404 missing agentId/pluginId` — URL had too few segments.
- `404 unknown agent: <id>` — agent not in the manager.
- `404 unknown plugin or no http handler: <pid>` — plugin not
  installed, not running, or doesn't implement `handleHttpRequest`.

If the plugin handler throws, the harness logs the error and replies
500 (if headers weren't sent) or just ends the response.

Plugins access the loopback URL via `PluginInstanceContext.httpBaseUrl`
(set only when the plugin declares `handleHttpRequest`). The agent's
pi child sees the prefix as the env var `PI_WEBHOOK_BASE` and is
expected to hit `${PI_WEBHOOK_BASE}/<pluginId>/<rest>` from `bash` /
plugin CLI scripts. See [`server.md` §5.6](./server.md#56-plugin-script--in-process-plugin-loopback).

---

## 11. Conventions

### JSON only

Every Hono route reads and writes JSON. Wrong content-type ⇒ the
`c.req.json()` parser swallows the error and routes see `{}`; most
handlers respond `400` with a hint.

### Error shape

`{ "error": "<message>" }` with an HTTP status code. Routes that take
side-effects also include the post-action state where useful
(`state`, `error`, `restarted`).

### Mask sentinel

`"********"` is the in-band sentinel for "leave this value alone" on
secret PUTs (`/api/secrets`, `/api/models`). `null` means "delete".
Anything else is taken as the new value. This is the only way a GET
followed by an unchanged PUT can round-trip — masked values are never
exposed in GET responses, so the client has nothing to send back.

### IDs and paths

- Agent ids are directory names under `<rootDir>/<harnessId>/agents/`.
  The server doesn't validate the character set on creation (creation
  happens out-of-band in v0), but every route that takes an `:id`
  param falls through to `am.get(id)` which is a Map lookup.
- Filesystem `path` query params are validated against the agent dir
  (`resolveSafe`).
- `threadId` / `sessionId` in session-browse routes must be a single
  path segment: no `/`, `\`, NUL, leading `.`, length ≤ 256.

### Auto-reload on settings PUTs

These mutations trigger an auto-reload of affected agents instead of
requiring a manual restart:

| Endpoint | Reload |
|---|---|
| `PUT /api/agents/:id/config` | `reloadAgent(id)` (soft swap) |
| `PUT /api/agents/:id/plugins/:pid/config` | `reloadPlugin(id, pid)` (plugin bounce only) |
| `PUT /api/secrets` | `reloadAgent(aid)` for every agent named in the body |
| `PUT /api/models` | `reloadAgent(aid)` for every running agent whose `model.provider` matches a touched provider |
| OAuth login success / `DELETE /api/models/oauth/:provider` | same per-provider reload as `PUT /api/models` |
| `PUT /api/harness` | `reloadAgent(aid)` for every loaded agent (timezone is captured at runner construction and in plugin contexts) |

`reloadAgent` waits for active batches to drain before swapping (zero
interruption); `reloadPlugin` stops/starts the one plugin in place
(the runner keeps running). The `restartRequired: false` field in the
response is a forward-compat signal for settings that *would* need a
hard restart.
