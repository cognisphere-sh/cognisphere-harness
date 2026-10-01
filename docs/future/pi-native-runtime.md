# Future plan: a Pi-native agent runtime

**Status:** not scheduled. This folder holds ideas that depend on outside work maturing. The [roadmap](../roadmap.md) is still the only delivery tracker; an idea here becomes a roadmap phase when it is picked up.

**Depends on:** Pi's experimental packages becoming stable. See [Pi modules](../pi-modules.md).

## The idea in plain language

Pi is building, as experimental packages, much of what the roadmap builds ourselves:

- a crash-safe agent engine with queued input, subagents and tasks (`pi-durable`);
- a protocol for talking to sessions running in other processes (`pi-protocol`, `pi-client`, `pi-server`);
- a framework for plugins whose parts run in different processes (`chord`).

When these stabilize, CogniSphere could use them directly instead of maintaining its own versions. That would mean less code, and behavior that matches Pi upstream.

## What could be replaced

### 1. The inside of an agent unit → `pi-durable`

| Ours (roadmap) | `pi-durable` equivalent |
|---|---|
| Message queue rows, batching, `attempts` | Submissions in each conversation's `pi.inbox`, plus generation retry settings and task checkpoints |
| `sourceKey` duplicate detection ([phase 2](../roadmap/phase-02-reliable-intake.md)) | `requestId` on `submit()` |
| Steering vs queueing, `doNotSteer` | `whenBusy: "steer"`, follow-up, or `"reject"` |
| Delivery receipts (`EventId` metadata plus the receipts extension) | Not needed. A submission's placement and answer are committed state. |
| Crash recovery: resend vs nudge | `harness.resume()` continues unfinished tasks, and tools that aren't safe to replay get an "interrupted" result |
| Thread | Conversation |
| Sub-agents with a `tasks` table and result posting ([phase 5](../roadmap/phase-05-subagents.md)) | Conversations owned by a task, a subagent tool, background reporter tasks, and abort that propagates to children |
| Prompt and skill selection per role ([phases 3](../roadmap/phase-03-agent-layout-and-assets.md)–[5](../roadmap/phase-05-subagents.md)) | Extensions and system prompt sections selected per conversation with `configure()` (model, extensions, tools, instructions, cwd) |
| Capabilities ([phase 4](../roadmap/phase-04-core-prompt-and-capabilities.md)) | Extensions in a registry (tools, sections, hooks, tasks) |
| Event handlers ([phase 7](../roadmap/phase-07-events-and-handlers.md)) | Custom durable tasks, or writes plus hooks |
| Turn deadline, abort | `abort()` per conversation, propagating to owned work |
| Live console stream ([phase 12](../roadmap/phase-12-live-console.md)) | `viewState()` / `watch()` / `watchEvents()`, which can be resumed by design |
| Cost display | The `pi.usage` document |

**Gaps to close before switching:**

- **Not production-ready:** it's experimental, with "API changes without notice".
- **Different storage format:** durable storage (SQLite/JSONL) isn't the coding agent's JSONL session format. Existing sessions would need a one-way import, and `session-reader`, search ([phase 13](../roadmap/phase-13-session-search.md)) and the console's session view would change.
- **Fewer built-in tools:** only `read`, `write`, `edit` and `bash`, with no `grep`/`find`/`ls` and no image reads yet. Skills, prompt templates and context files come from the coding agent and must be wired in as extensions. Pi's own experimental durable coding agent already does this for its system prompt sections.
- **A different extension API:** our extensions (`bash-guard`, `context-meta`, `skill-update-notice`, receipts) would need rewriting.
- **Isolation moves:** the engine runs inside the agent host process, as with the SDK. Isolating tools would depend on its per-call `env` (a subprocess or container per tool call) rather than on killing a Pi child process. Crash-safe storage makes restarting the host cheaper, which partly offsets this.
- **Single owner:** one process owns a storage, with no cross-process locking. This fits one unit per agent, but the coordinator must never open a unit's storage.

### 2. The coordinator-to-unit link → `pi-protocol` / `pi-client` / `pi-server`

| Ours ([phase 6](../roadmap/phase-06-agent-host-split.md)) | Pi equivalent |
|---|---|
| One outbound WebSocket per unit, with event, request and status frames | Framed CBOR over any byte transport; requests and subscriptions routed per server and session |
| Unit token | **Missing.** Peer authentication isn't implemented, so we would add it at the transport, for example by wrapping a WebSocket or TLS connection. |
| Console reads through the unit | Attaching to a session, then Chord service calls and subscriptions with state shared live |
| Rejecting stale frames after a reconnect | Built in: the attachment ID fences calls |

**Gaps:** only a Unix-socket transport ships, so we would write a network one. The protocol has no compatibility promise. Server and worker lifecycle are left to the application, which matches our coordinator anyway.

### 3. Plugin split → `chord` facets

Our plugin split, with a coordinator part and a capability that runs in the unit, maps directly onto Chord: one plugin, several facets, each loaded in its own process, communicating through typed services. Console views could subscribe to state shared live from units instead of polling.

### 4. Smaller pieces we could adopt earlier

- **`pi-codemode`** and **`pi-mcp`** as capabilities. They are stable now, and the MCP credential question waits for [phase 10](../roadmap/phase-10-secrets-broker.md).
- **`pi-telemetry`** interfaces for tracing turns, handlers and proxy calls, with our own exporter.
- **`streamProxy()`** from `pi-agent-core` as a reference design for the [phase 10](../roadmap/phase-10-secrets-broker.md) model proxy.

## When to pick this up

Revisit whenever Pi releases a version where any of these hold:

1. `pi-durable` or `pi-protocol` drops its experimental label, or keeps its API stable for several releases.
2. The `pi` CLI itself moves onto `pi-durable` (today this is only a source prototype in `coding-agent/src/experimental/durable`).
3. `pi-server` gains peer authentication and a network transport.

## How to adopt it safely

1. **Keep the unit's internals private.** [Phase 6](../roadmap/phase-06-agent-host-split.md)'s coordinator-to-unit protocol exposes events, requests and status, never Pi internals. A unit could then switch engines (coding-agent RPC or `pi-durable`) without the coordinator, console or other units noticing.
2. **Match semantics now:**
   - `sourceKey` behaves like `requestId`;
   - sub-agent tasks are owned by a parent and abort with it;
   - handlers record committed results.
   Then a later mapping is mechanical.
3. **Spike:** run one agent unit on `pi-durable` behind the same unit protocol. Compare crash recovery, delegation, cost and code size against the RPC unit.
4. **Migrate per agent,** with a one-way session import and the per-agent `runtime` switch as the rollback, the same pattern as [phase 9](../roadmap/phase-09-docker-per-agent.md).

## Open questions

1. When this is picked up, should coding-agent JSONL sessions be imported into durable storage, or kept read-only for history, with new threads starting in durable storage?
2. Would we keep coding-agent extensions anywhere (for example for operators' own `pi` use), or move everything to durable extensions?
