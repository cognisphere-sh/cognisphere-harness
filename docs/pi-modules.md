# Pi modules

**What this is:** a guide to the packages in the Pi monorepo (`earendil-works/pi`): what each one does, how they fit together, and which ones CogniSphere uses.

**Snapshot:** Pi **0.99.2** (commit `e792ba131`, 2026-09-30). The harness pins exactly 0.99.2 in `packages/harness/package.json` ([phase 0](roadmap/phase-00-pi-upgrade.md)) and runs that package's own `pi` binary.

Pi changes quickly. For the version you're running, the package READMEs and `pi --help` are authoritative.

## The map

```text
                       ┌──────────────────────────── stable (what we use) ─────────────────────────────┐
                       │  pi-ai  ──▶  pi-agent-core  ──▶  pi-coding-agent (CLI · RPC · SDK · extensions)  │
                       │                                   ├─ built-in extensions: pi-mcp, pi-codemode    │
                       │                                   └─ pi-tui (terminal UI)                        │
                       └──────────────────────────────────────────────────────────────────────────────────┘
                       ┌──────────────────────────── experimental (new) ───────────────────────────────┐
                       │  chord ──▶ pi-durable (durable harness: conversations, tasks, subagents)        │
                       │  pi-agent-core Session/SessionRepo ──▶ pi-session-backend-sqlite-node           │
                       │  pi-protocol ──▶ pi-client  ◀──wire──▶  pi-server ──▶ session worker            │
                       └──────────────────────────────────────────────────────────────────────────────────┘
                         pi-telemetry (contracts) · evals (Pi's own behavior tests)
```

| Package (npm) | Status | One-line purpose | CogniSphere today |
|---|---|---|---|
| `@earendil-works/pi-ai` | Stable | One LLM API across providers: model catalog, auth resolution, streaming, tools, cost | Imported for OAuth helpers (`oauth-logins.ts`) |
| `@earendil-works/pi-agent-core` | Stable core; new `Session`/harness interfaces experimental | The agent loop (`Agent`, `agentLoop`) with tools, steering and events. Now also session repositories and an agent-harness interface. | Indirectly, through the coding agent |
| `@earendil-works/pi-coding-agent` | Stable (with an `experimental/` folder) | The `pi` CLI: built-in coding tools, sessions as JSONL, skills, extensions, RPC and SDK modes | **Yes.** Every batch runs the package's bundled `pi --mode rpc`. We also use its types and credential helpers. |
| `@earendil-works/pi-tui` | Stable | Terminal UI library for interactive `pi` | No |
| `@earendil-works/pi-mcp` | Stable | A small Model Context Protocol client (stdio, Streamable HTTP) | No (built into the CLI since 0.99; we disable it with `--no-extensions`) |
| `@earendil-works/pi-codemode` | Stable | Runs model-written JavaScript in a QuickJS sandbox that can only call injected tools | No (same as above) |
| `@earendil-works/chord` | Experimental | Framework for building an app from plugins whose parts ("facets") run in different processes, with typed services, state shared live with remote viewers, and cancellation contexts | No |
| `@earendil-works/pi-durable` | Experimental ("API changes without notice") | A crash-safe agent harness: conversations, tasks, subagents and queued input all committed to storage | No; see [future plans](future/pi-native-runtime.md) |
| `@earendil-works/pi-session-backend-sqlite-node` | Experimental | A SQLite store for `pi-agent-core` sessions (`node:sqlite`) | No |
| `@earendil-works/pi-protocol` | Experimental (version 8, no compatibility promise) | Message format for remote Pi sessions: framed CBOR envelopes, handshake, routing | No |
| `@earendil-works/pi-client` | Experimental | Client for that protocol over any byte transport (a Unix socket is included) | No |
| `@earendil-works/pi-server` | Experimental | Server for that protocol: routes clients to sessions running in worker processes | No |
| `@earendil-works/pi-telemetry` | Stable contracts | Telemetry interfaces and typed schemas, independent of any vendor; no exporter included | No |
| `evals` (private) | Internal | Pi's own behavior tests (vitest-evals, with or without docs, in Docker) | No |

## Stable packages

### `pi-ai`: model access

- **Providers:** one `stream()` / `complete()` API (plus `streamSimple`) across providers. The catalog lists only models that can call tools; image and classifier models have their own catalogs.
- **Auth resolution order:** stored credential, then OAuth, then environment variables, then runtime keys. Request headers can be transformed, and a credential store can be plugged in.
- **Also covers:** streaming tool calls with partial JSON, thinking levels, abort and continue, image generation (0.99), classification (0.99).
- **Use for us:** the model proxy in [phase 10](roadmap/phase-10-secrets-broker.md) could reuse it on the coordinator side. Its auth resolution and `baseUrl`/header overrides are what make placeholder credentials workable.

### `pi-agent-core`: the agent loop

- **`Agent` class:** holds state (system prompt, model, messages) and runs prompt → model → tools → model until done.
- **Events:** `agent_start`, `turn_start/end`, `message_start/update/end`, `tool_execution_*`, `agent_end`.
- **Tool execution:** runs tools in parallel by default.
- **Queued input:** steering ("after the current tool round") and follow-up ("after this run").
- **`streamProxy()`:** routes model calls through a backend URL with an auth token. It was designed for browsers, and is the same pattern as our model proxy.
- **Low-level API:** `agentLoop` / `agentLoopContinue`.
- **New (experimental):**
  - `Session` / `SessionRepo` interfaces (sessions with branches, forks and an in-memory repo) and an `AgentHarness` interface. These are what the durable and server packages build on.
  - SQLite storage lives in `pi-session-backend-sqlite-node`, so the core keeps no native dependencies.

### `pi-coding-agent`: the `pi` CLI

The product we run. It adds to `pi-agent-core`:

- **Tools:** built-ins `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. `--tools` chooses them, and `--no-builtin-tools` drops them.
- **Sessions:** JSONL files in a tree (format version 3, migrated on load). Branching, compaction, and context edits that don't rewrite history (0.87).
- **Resources:** skills, prompt templates, context files (`AGENTS.md`), themes, and a project-trust prompt.
- **Extensions:**
  - TypeScript modules that hook events (`tool_call`, `context`, `before_agent_start`, `turn_end`, `agent_before_settle`, …);
  - they can register tools, commands and virtual models;
  - they can append entries (`pi.appendEntry`) or send messages.
- **Built-in extensions (0.99):** `builtin:mcp`, `builtin:codemode`, `builtin:tool-search`, `builtin:llama.cpp`. `--no-extensions` turns all of them off.
- **Modes:**
  - **interactive** (TUI);
  - **print** / **json** (single run);
  - **rpc**: long-lived, JSON lines on stdin/stdout, with commands `prompt`, `steer`, `follow_up`, `abort`, `get_entries`, `set_model`, `switch_session`, … and events including `agent_settled` and `entry_appended`;
  - **SDK**: `createAgentSession()` in-process, with an explicit `ResourceLoader`, `SessionManager`, `ModelRuntime` and settings.
- **`src/experimental/`:** source-only, not published. It holds a coordinator, server and session-worker prototype on `pi-server`/`pi-protocol`, a "micro" and a "mini" client, and a **durable coding agent** that runs the coding agent on `pi-durable`, with SQLite sessions, subagents and a task-graph panel.

### `pi-mcp`, `pi-codemode`, `pi-tui`, `pi-telemetry`

- **`pi-mcp`:** a standalone MCP client with no dependency on the official SDK. `toLlmContent()` adapts MCP results for models.
- **`pi-codemode`:** a QuickJS/WebAssembly sandbox where a script can only call injected tools. Nested tool calls stay out of the model's context; only the script's output returns.
- **`pi-tui`:** the terminal UI library. Not relevant to a headless harness.
- **`pi-telemetry`:** `TelemetryContext` / `TelemetrySpan` interfaces passed explicitly, plus an in-memory reference implementation. Exporters (OpenTelemetry, Sentry) are left to the application.

## Experimental packages

### `chord`: application composition

A general-purpose framework that doesn't depend on Pi. The pieces:

- **Plugins** are split into **facets**: parts bundled and loaded separately in different processes, such as a worker, a terminal UI or a web UI.
- **Services** are typed tokens with one provider, or one provider per key. They can be local, or exposed to other processes.
- **Replicated state:** the provider publishes atomic changes, and local and remote consumers receive immutable snapshots plus changes. Consumers become unready on disconnect until they resync.
- **Delta tracking:** compact change batches over plain JSON.
- **Context:** Go-style cancellation and per-call values, such as permissions or telemetry.
- **Remote boundary:** Chord defines the service call and subscription format but leaves the transport to the application. `pi-protocol` is one such transport.

**Why it matters to us:** our [phase 6](roadmap/phase-06-agent-host-split.md) plugin split (a coordinator part plus a capability that runs in the unit) is exactly what Chord facets are for.

### `pi-durable`: a crash-safe agent harness

Everything is committed to storage before anything is shown. If the process dies, reopening the storage continues the work.

| Concept | Meaning |
|---|---|
| Harness | One open storage plus the scheduler. All changes go through one sequence of atomic commits. |
| Conversation | A transcript of immutable entries (`pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, custom kinds) |
| Document | Typed JSON stored next to the transcript: `pi.agent` (model, extensions, tools, instructions, cwd per conversation), `pi.live`, `pi.inbox` (queued input), `pi.usage` |
| Task | A stored state machine that saves a checkpoint at every step. `pi.generation` calls the model and owns one `pi.tool` task per tool call. |
| Submission | Input or an entry handed to a conversation. `requestId` makes retries idempotent, and `wait()` reports done or unanswered. |
| Busy handling | `whenBusy`: `steer` (after the current tool round), follow-up (after the run), or `reject` |
| Extension | A named bundle of tools, system prompt sections, hooks (`beforeTool`, `beforeRequest`, `onYield`, …), wrappers and tasks, installed in a registry |
| Subagents | A conversation **owned by a task**. Aborting the parent aborts the child. Background tasks survive the parent's abort, and a reporter task posts results back as follow-ups. |
| Child tasks and task graph | Tasks own tasks, wait (`allSettled` / `failFast`), and abort bottom-up. `taskGraph()` shows every live task. |
| Tool replay | A tool interrupted by a crash reruns only if it's marked `replay: "safe"`. Otherwise the model gets an "interrupted" result. |
| Watching | `viewState()` / `watch()` (Chord state with per-commit changes); `watchEvents()` gives coding-agent-style events. Partial output is committed at most every 100 ms. |
| Storage | Memory, SQLite (WAL) or JSONL. **One process owns a storage at a time**, with no locking across processes. |
| Environment | An `env` callback builds the execution environment for each tool call, such as a folder or a container per conversation. |

Its built-in tools are `read`, `write`, `edit` and `bash`. Images aren't supported yet. It has its own extension API and storage format, not the coding agent's extensions or JSONL sessions.

### `pi-protocol`, `pi-client`, `pi-server`: remote sessions

- **Protocol (version 8):**
  - **Framing:** each frame is a four-byte length followed by one CBOR item, with a handshake that names the logical `serverId`.
  - **Routing:** requests target the server or a session (`{serverId, sessionId, attachmentId}`). The attachment ID makes stale frames fail after a reconnect.
  - **Payloads:** opaque strict-JSON Chord service calls.
- **Client:** works over any ordered byte transport (a Unix socket is included). It never replays requests on its own.
- **Server:**
  - routes each client to a session running in a **worker process**;
  - several clients (attachments) can view one session;
  - the live `Session` and harness objects never cross the process boundary.
- **Not provided yet:** peer authentication. Lifecycle management is deliberately outside the protocol.

### `pi-session-backend-sqlite-node`

- **Layout:** one SQLite file per session, with branches and forks.
- **Single writer:** the host must guarantee one writer per session. There is no cross-process lease or lock.
- **Search:** a separate projection, not built in.

## What this means for CogniSphere

- **Now:** keep `pi-coding-agent` in RPC mode inside each agent unit ([decision](roadmap/phase-06-agent-host-split.md#rpc-vs-sdk)) and upgrade to 0.99.x ([phase 0](roadmap/phase-00-pi-upgrade.md)).
- **Later:** `pi-durable` overlaps our message queue, delegation and crash recovery. `pi-protocol`/`pi-server` overlap the coordinator-to-unit link. `chord` matches our plugin split. Using them directly is in [future plans](future/pi-native-runtime.md), waiting until they're stable.
