# Roadmap

This is the only delivery and status tracker. Each phase has its own file in [roadmap/](roadmap/) with the requirement in plain language, the design, open questions and "done when" checks. The [high-level design](high-level-design.md) and the layer documents in [low-level/](low-level/) describe what is built today. Update them when a phase lands, and record the evidence (the commit or PR, and what was verified) in the phase's **Status** cell below.

**Current status:** every phase is planned. The phases are still under review, so expect them to change before implementation starts.

## What we are building

1. **Clear agent files.** Shipped defaults are read-only. Everything the agent creates or changes lives in its own folders. A config file decides which prompts and skills the agent and each of its sub-agents get.
2. **Small, composable agents.** The base prompt is split into a short core prompt plus **capabilities** (skills, scripts and their dependencies), so each agent gets only what it needs.
3. **Sub-agents.** Specialist roles of one agent, each with its own model, prompts and skills, working on the same files.
4. **One container per agent.** Each agent runs as a unit containing its queue, event handlers, Pi and capability code. The harness becomes a coordinator.
5. **Agent-owned event handling.** The coordinator only says *something happened* (a timer, a Telegram update, a message). The agent's own scripts decide what it means and which thread it goes to.
6. **Agents never hold real credentials.** The coordinator injects them on the way out.
7. **Storage behind an interface.** Local disk first, JuiceFS next. Checkpoints and shared folders work wherever the backend supports them.
8. **Later:** a live console, session search, agent self-review, remote hosts and short-lived sandboxes (e2b, Vercel).

## Target architecture

```text
Coordinator (always on, trusted, runs no agent code)
  API + console · agent lifecycle · per-agent outbox · timers (agent-registered schedules)
  receivers (Telegram webhook/poll, OAuth callbacks, public webhooks) · agent-to-agent relay
  connections + secrets · egress proxy (phase 10)
        ▲  one outbound WebSocket per unit, authenticated by the unit token
        ▼
Agent unit (process now → one container per agent → later remote or short-lived)
  agent host: events → handlers → message queue → Pi (RPC child) → delivery receipts
  /agent/assets/{base (read-only), prompts, skills, scripts, assets.json}
  /agent/workspace  /agent/plugin-data/<id>  /agent/deps  /agent/sessions  /shared/<space>
        ▼
AgentStorage: local disk → JuiceFS (checkpoints, multiple hosts)
```

| Term | Meaning |
|---|---|
| **Coordinator** | Today's harness server, made smaller. It never runs agent code or agent-written scripts. |
| **Agent unit** | One agent's runtime: the agent host process and the Pi it starts. A process in phases 6–8, and a container from phase 9. |
| **Unit token** | The credential a unit uses to prove "I am agent X" to the coordinator. Scoped to one agent and expires when the unit stops. |
| **Event** | A raw trigger delivered to a unit, such as `timer`, `telegram.update` or `message`. Stored in the unit's **events** table until a handler processes it. |
| **Message queue** | Today's per-thread queue. Thread messages that Pi processes with batching, steering, retries and receipts. |
| **Handler** | A builtin, or an agent-owned script, that turns an event into zero or more queue messages. |
| **Capability** | A bundle of prompts, skills (with their scripts), dependencies and default handlers. Its dependencies go into the agent's single Python and Node environment. A plugin is a capability plus a coordinator part. |
| **Definition / state** | Definition is `agent.json`, owned by the operator, and is copied when an agent is cloned. State is `assets/`, `workspace/`, `plugin-data/`, `deps/` and `sessions/`, which are created during the agent's life and can be checkpointed. |

## Decisions so far

| Topic | Decision |
|---|---|
| Sandbox boundary | One container per agent, running its capability code and Pi. The coordinator only coordinates. Short-lived sandboxes stay possible later, because every trigger already comes from the coordinator. |
| Agent files | One `assets/` folder for reading and editing. `assets/base/` is read-only. Agent files use new names (no shadowing). `agent.json` selects and orders prompts and skills for the main role and each sub-agent. `assets.json` records what each agent-made asset is for, why it exists, and which base file it replaces. Changes require `allowAssetChanges` and go through the harness, which may only change selection fields. |
| Upgrades of changed assets | Handled by the coding agent using `assets.json` and base diffs. No automatic merge. |
| Package installs | pip, npm and similar go into persistent `deps/`. No root by default. `sandbox.root: true` gives a container root so apt works during a session. |
| Queue location | Inside the agent unit. The coordinator keeps only an outbox of events the unit hasn't acknowledged yet. |
| Event model | coordinator outbox → unit **events** → handler → **message queue**. Handlers are agent-owned and configured in assets. |
| Polling (Gmail etc.) | A capability ships instructions plus a default polling script. The agent registers when to run it. |
| Replies after a forward | Relayed through the agent that owns the channel. |
| Storage | An `AgentStorage` interface. Local disk first, JuiceFS next. Checkpoints only where the backend supports them, and never including the message queue. |
| Extending agents | **Pi extensions first.** Agent-side features such as memory, a skill selector, context trimming and notes enforcement are built as Pi extensions packaged in capabilities. The runner, queue or coordinator change only when an extension can't reach what the feature needs. |
| Auth backend (Composio, Nango, built-in) | **Deferred.** Phase 10 defines the broker interface. The backend is chosen later. |

## Phases

Each phase depends only on earlier phases and leaves the system working.

| # | Phase | Delivers | Status |
|---|---|---|---|
| 0 | [Pi 0.99 upgrade](roadmap/phase-00-pi-upgrade.md) | Move to Pi 0.99.2 with one pin (bundled `pi`), finish batches on `agent_settled`, receipts via `appendEntry`, ChatGPT sign-in and a refreshed model list. | **Implemented, not yet committed** (branch `phase-0-pi-upgrade`). `pnpm check` passes. Checked against a real model on a scratch home (OpenAI Codex `gpt-5.5`, OpenRouter override):<br>• bundled `pi` 0.99.2 runs; receipts saved as `cognisphere.delivery` entries, with no duplicates on respawn;<br>• a mid-turn steer lands in the same batch; abort marks the row `cancelled`;<br>• a 0.84.4 session resumes with history; a thread override on a second provider works;<br>• a network failure gives 4 Pi attempts × 3 queue batches, then `[agent_error]`;<br>• bash-guard and skill-update-notice (fires once) work;<br>• ChatGPT sign-in reaches the authorize URL; every shortlist ID resolves;<br>• spawn-to-ready 503 ms → 140 ms.<br>Fixed in this phase: context-meta never showed its `Model`/`ContextUsage` lines (on 0.84.4 too); they now reach the model and aren't saved.<br>Open: finish the Anthropic and ChatGPT sign-ins in a browser. |
| 1 | [Test harness](roadmap/phase-01-test-harness.md) | Automated tests for the queue and runner, using a fake Pi process. | Planned |
| 2 | [Reliable intake](roadmap/phase-02-reliable-intake.md) | No lost messages while an agent is stopped. Duplicates ignored. Thread IDs validated. | Planned |
| 3 | [Agent layout and assets](roadmap/phase-03-agent-layout-and-assets.md) | State folders, a read-only base, prompt and skill selection in `agent.json`, `assets.json` explanations, and migration of existing agents. | Planned |
| 4 | [Core prompt and capabilities](roadmap/phase-04-core-prompt-and-capabilities.md) | The base prompt split into core plus capabilities. `agent.json` selects capabilities and Pi tools. | Planned |
| 5 | [Sub-agents](roadmap/phase-05-subagents.md) | Roles with their own model and assets. Delegation through task threads, with results returned to the parent. | Planned |
| 6 | [Agent host split](roadmap/phase-06-agent-host-split.md) | One process per agent, the coordinator/unit protocol, and plugins split into a coordinator part and a capability. | Planned |
| 7 | [Events and handlers](roadmap/phase-07-events-and-handlers.md) | The events table, agent-owned handlers, scheduled scripts, routing scripts, Telegram and Gmail as events. | Planned |
| 8 | [Storage interface](roadmap/phase-08-storage-interface.md) | `AgentStorage` on local disk, cloning an agent without its state, and shared folders. | Planned |
| 9 | [Docker per agent](roadmap/phase-09-docker-per-agent.md) | Layered images, one container per agent, a root flag, and persistent `deps/`. | Planned |
| 10 | [Secrets broker](roadmap/phase-10-secrets-broker.md) | Connections and grants in the coordinator, placeholder secrets, an egress proxy and a model proxy. | Planned |
| 11 | [JuiceFS and checkpoints](roadmap/phase-11-juicefs-and-checkpoints.md) | A multi-host storage backend, checkpoint config, and restore. | Planned |
| 12 | [Live console](roadmap/phase-12-live-console.md) | Replies stream into the console (SSE). | Planned |
| 13 | [Session search](roadmap/phase-13-session-search.md) | Operators and agents search past conversations. | Planned |
| 14 | [Agent self-review](roadmap/phase-14-agent-self-review.md) | Scheduled improvement reports. Changes go through assets and `assets.json`. | Planned |
| 15 | [Other runtimes](roadmap/phase-15-other-runtimes.md) *(future)* | Units on remote hosts and short-lived sandboxes. | Planned |

```mermaid
flowchart LR
    P0[0 Pi upgrade] --> P1[1 Tests] --> P2[2 Intake] --> P3[3 Layout + assets] --> P4[4 Capabilities] --> P5[5 Sub-agents]
    P5 --> P6[6 Agent host split] --> P7[7 Events] --> P8[8 Storage] --> P9[9 Docker] --> P10[10 Secrets]
    P10 --> P11[11 JuiceFS + checkpoints] --> P12[12 Console] --> P13[13 Search] --> P14[14 Self-review] --> P15[15 Other runtimes]
```

Phases 12–14 barely depend on each other or on phases 9–11, so they can move earlier if needed.

## Dropped or deferred from the previous plans

| Old idea | v2 decision |
|---|---|
| `base/releases/<rev>/` + `agent-managed/` + namespaced IDs + `resources.json` | `assets/` with a read-only `base/`, plus explicit path lists in `agent.json` |
| Shadowing overrides with the same ID | Dropped. Agent files get new names, and the config swaps the path. |
| `AgentSandboxManager`, sandbox store, fences, generations, writer gate | Dropped. One unit per agent, one active turn per unit, and a fixed container name. |
| Custom SDK host protocol | Dropped. The agent host runs `pi --mode rpc` as a local child, as today ([evaluation](roadmap/phase-06-agent-host-split.md#rpc-vs-sdk)). |
| OpenBao, KMS or envelope encryption | Deferred. Secrets stay in the coordinator and are never mounted into units. |
| Immutable script publication, `AutomationPrincipal` | Dropped. Handler scripts run inside the agent's own unit with its own authority. |
| Editable daemons | Dropped. Long-running receivers are coordinator code. Agent logic runs as handlers. |
| Durable SSE event log | Simplified to in-memory streaming. Reconnecting refetches over REST. |
| Search index | Deferred until scanning is measurably too slow. |
| Per-turn "no snapshots" rule | Reversed. Checkpoints are configurable where storage supports them. |
| Approved-application pipeline for self-review | Dropped. Changes go through assets, the log and git. |

## Future plans (not scheduled)

Ideas that wait on outside work live in [future/](future/). They become phases here when they are picked up.

- [Pi-native agent runtime](future/pi-native-runtime.md): use Pi's experimental `pi-durable`, `pi-protocol`/`pi-server` and `chord` directly, once they're stable. [Pi modules](pi-modules.md) explains each package.

## Open questions for the whole roadmap

1. Which Docker platform comes first: Linux, macOS Docker Desktop, or both?
