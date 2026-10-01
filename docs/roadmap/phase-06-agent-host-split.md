# Phase 6: agent host split

[Roadmap](../roadmap.md) · Previous: [Phase 5](phase-05-subagents.md) · Next: [Phase 7](phase-07-events-and-handlers.md)

## Requirement

- **One process per agent:** each agent runs in its own process (later its own container), holding its queue, its runner and its Pi. The harness becomes a **coordinator**: it receives things from the outside world, keeps them safe until the agent takes them, relays messages between agents, runs the console and API, and starts and stops agent units.
- **Fault isolation:** a crash or busy loop in one agent can't take down the others or the API.
- **Remote-ready:** everything works the same whether the unit is a local process or, later, a container elsewhere. The unit talks to the coordinator only over one authenticated connection.

## Design

### Who does what

| Coordinator (`cognisphere serve`) | Agent unit (`cognisphere agent-host <id>`) |
|---|---|
| Console and REST API, auth | Message queue (`.runtime/queue.db`), batching, steering, retries, delivery receipts |
| Starting, stopping and restarting units; health | Runner and Pi (`pi --mode rpc` as a local child) |
| Per-agent **outbox** of events waiting for the unit | Turning events into queue messages (builtin routing in this phase; phase 7 adds handlers) |
| Receivers: Telegram polling and webhooks, GWS polling, scheduler timers, OAuth callbacks, public `/webhook/*` | Capability code that runs in the unit (for example, downloading Telegram attachments) |
| Agent-to-agent relay (`agent-msg send`) | Assembling the system prompt from the selection in `agent.json`, plus the model check and fallback |
| Models and secrets store | Answering console requests for its files, sessions and queue |

### The unit connection

- **Starting a unit:** the coordinator starts each unit with a fresh **unit token** (`COGNISPHERE_UNIT_TOKEN`). It keeps only the token's hash, in memory, and revokes it when the unit stops.
- **Connecting:** the unit opens **one outbound WebSocket**, `/units/v1/connect`, authenticated with `Authorization: Bearer <unit token>`. Units only connect out, so later remote hosts behind NAT work unchanged.

| Direction | Frame | Purpose |
|---|---|---|
| coordinator → unit | `event {id, type, payload}` | Next outbox item (`message`, `telegram.update`, `timer`, …) |
| unit → coordinator | `ack {id}` | The event is stored in the unit; the coordinator deletes it from the outbox |
| coordinator → unit | `request {id, method, params}` | Console reads and actions: list or read files, read sessions, list the queue, abort a thread, set a thread's model |
| unit → coordinator | `response {id, result/error}` | Answer to a request |
| unit → coordinator | `status {...}` | Running batch, queue counts and errors, for the console |
| both | `ping` / `pong` | Health; three missed pings mean the unit is unhealthy |

**Outbox:** a coordinator SQLite table `outbox(agent_id, id, type, payload, created_at)`.

- Events are delivered in order and resent after a reconnect until acknowledged.
- The unit ignores an event ID it has already stored, so a resend can't create a duplicate.
- This is where phase 2's "save even when the agent is down" guarantee lives from now on.

**Calls from agent scripts:** `agent-msg send`, `delegate` and later `schedule` are HTTP calls to the coordinator (`/units/v1/…`), authenticated with the unit token from the environment.

- **Sender identity:** the coordinator takes the sender from the token, so a message can't claim to come from another agent.
- **Fewer shared secrets:** this removes `COGNISPHERE_WEBHOOK_SECRET` from agent environments.

### Splitting plugins

Each plugin's `index.ts` becomes its **coordinator part**: receivers, OAuth and HTTP routes.

- **Delivering events:** `ctx.notify()` now writes to that agent's outbox instead of calling a runner.
- **Webhooks needing agent files:** a plugin webhook that needs the agent's files (for example the artifacts plugin serving a file) is forwarded to the unit as a `request`.
- **Unit-side code:** code that must touch agent files moves into the capability as a small **unit-side hook** the agent host runs when the event arrives. For example, Telegram's hook downloads attachments into `plugin-data/telegram/`.

### Unit lifecycle

- **Starting units:** the coordinator spawns one `agent-host` process per enabled agent. These run as processes labeled `[no sandbox]`; Docker arrives in phase 9.
- **Crashes:** restart with backoff (1 s, 5 s, 30 s, then capped), shown in the console.
- **Coordinator restart:** in process mode, units are children of the coordinator and restart with it. Their queue is on disk, and the outbox resends anything that wasn't acknowledged.
- **Secrets:** until phase 10, the unit receives the agent's secrets as environment variables, as Pi does today. The coordinator part receives the secrets its receivers need, such as the Telegram bot token.

### Pi launch fixes (inside the agent host)

- **Turn deadline:** `turnTimeoutMinutes` aborts a hung turn (core known issue #7).
- **Process-group cleanup:** Pi runs in its own process group, and the whole group is killed at batch end and on abort, so no leftover browser or dev server keeps writing.
- **Environment allowlist:** Pi gets an explicit set of variables instead of a copy of the coordinator's environment (core known issue #9).
- **RPC stays:** keep `pi --mode rpc` with today's explicit flags and the delivery-receipt extension. No SDK host (see below).
- **Receipts saved in the session (prototype):** the receipts extension writes `pi.appendEntry({entryId, eventIds})` instead of `ctx.ui.setStatus`. RPC reports it as `entry_appended`, and the receipt is kept in Pi's session file outside the model's context, so recovery can rebuild row-to-entry links from the file.

### RPC vs SDK

Evaluated against Pi 0.99.2 (source and docs) on 2026-10-01. **Decision: keep RPC.**

| Criterion | RPC (Pi as a child of the agent host) | SDK (Pi inside the agent host) | Edge |
|---|---|---|---|
| Controlling which resources load | `--no-extensions` (also turns off built-ins), `--no-skills` plus `--skill`, `--system-prompt`, `--tools`, `--no-context-files` | Custom `ResourceLoader`, inline extensions, `customTools` | Even |
| Linking rows to saved entries | Needs our receipts extension | Same check in-process. The message-to-entry map is private, so there's no API either way. | Slight SDK |
| Steer, abort, settle | `steer`, `follow_up`, `abort`, `agent_settled`, plus input dispositions | The same methods | Even |
| A hung or crashed turn | Killing the process group removes Pi, its tools and anything they started. The agent host never blocks, so the turn deadline can be enforced. | A stuck tool, an extension leak or a busy loop stalls the agent host, its handlers and its coordinator heartbeat. `dispose()` only stops cooperatively. | **RPC** |
| Coupling to Pi versions | A documented JSON protocol that grows by adding fields. The binary version is pinned per image. | Our code compiles against Pi's internal classes, which had breaking changes in 0.86, 0.87 and 0.99 | **RPC** |
| Startup cost | About 0.5 s per batch (0.84.4, measured) | About 0.4 s import once, then almost nothing per batch | SDK; small next to model latency |
| Credentials and proxy | `models.json` `baseUrl` and headers, environment variables | The same, plus in-memory auth | Even |

**What would change the decision:**

- Pi deprecates RPC.
- `pi-server`/`pi-protocol` becomes stable. It keeps Pi in a separate worker process too, so it could replace RPC as the link between the agent host and Pi.
- Startup cost matters for short-lived sandboxes. A warm RPC process (`switch_session`, `set_model`) is the first fix there.

See [Pi modules](../pi-modules.md) and [future plans](../future/pi-native-runtime.md).

## Done when

**Tests (phase 1 harness, extended with the WebSocket):**

- an event sent while the unit is down is delivered after it starts;
- after a reconnect, there are no duplicate queue rows;
- a unit crash during a turn causes a restart and a retry;
- a console file read on a unit works;
- a forged sender on `agent-msg send` is impossible.

**Behavior:**

- Telegram, GWS, the scheduler, agent messaging, artifacts and the console all work with agents in separate processes.
- Killing one agent's unit doesn't affect the others or the console.

**Docs:**

- HLD (coordinator and unit boundary);
- core.md (unit protocol, outbox, lifecycle);
- plugins.md (coordinator part and unit-side hooks);
- api.md (the `/units/v1` routes);
- cli.md (`agent-host`);
- shipped README.

## Open questions

1. **WebSocket or HTTP long-polling** for the unit connection? WebSocket is suggested, because it's one bidirectional channel that carries events, requests and status.
2. **Units outliving the coordinator:** should process-mode units keep running when the coordinator restarts (detached processes that reconnect), or restart with it? Restarting is simpler. Containers in phase 9 survive either way.
3. **Console reads on the same machine:** should the console read files directly as an optimization, or always go through the unit (one code path, remote-ready)? Always through the unit is suggested.
