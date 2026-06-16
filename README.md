<div align="center">

<img src="assets/logo-wordmark.png" alt="CogniSphere" width="680">

**Minimal · Self-improving · Persistent** — a harness for fleets of autonomous LLM agents that work the way a human operator does.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node-%E2%89%A520-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Hono](https://img.shields.io/badge/Hono-E36002?style=for-the-badge&logo=hono&logoColor=white)](https://hono.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Status: v0](https://img.shields.io/badge/status-v0%20preview-blue?style=for-the-badge)](docs/v0-deferred.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=for-the-badge)](#contributing)

</div>

> ### 🌌 The idea behind the name
> A **Dyson Sphere** is a megastructure that envelops a star to harvest its raw
> energy. **CogniSphere** is the same idea, pointed at *intelligence*: a thin
> structure that envelops powerful **LLMs** to harvest their raw reasoning — and
> channels that output into fleets of autonomous, persistent agents.
>
> The LLM stays external and is never reinvented. CogniSphere is the shell around
> it — the collectors, the wiring, the distribution grid that turns raw model
> intelligence into useful work.

CogniSphere is built on three ideas:

- **🪶 Minimal.** The core is **~20 files / ~3.8K LOC** of fundamentals — filesystem, SQLite, subprocess, HTTP. No orchestration framework, no DI container, no magic. You can read the whole thing in an afternoon and change it with confidence.
- **🧠 Self-improving.** Agents reflect on their own work, *dream* to consolidate short-term experience into long-term memory, and author their own skills — so an agent is sharper next week than it is today.
- **♾️ Persistent.** Identity, memory, sessions, and queued work all live on disk and survive restarts. Agents are long-lived workers, not stateless request handlers.

### Agents that work the way an operator does

CogniSphere treats an agent less like a chatbot and more like a **digital operator** —
a persistent worker with its own identity, memory, and toolset who shows up across many
conversations and gets real work done.

In CogniSphere, **every plugin is an app** — Telegram, Gmail, a calendar, a scheduler,
operator chat. Through the apps it's connected to, each agent:

- **Lives in its apps.** It receives **notifications** from the apps it's wired into, acts on them, and reaches back out through those same apps to interact with the outside world.
- **Multi-tasks.** It handles many independent conversations (threads) at once — serializing work where it must, running in parallel where it can — like a person juggling several chats and inboxes.
- **Collaborates with its team.** Agents coordinate with one another through the very same apps they use to talk to people, so a fleet behaves like a team of coworkers rather than a set of isolated bots.
- **Reflects.** It reviews its own runs — what worked, what went wrong — and turns those mistakes and learnings into better future behavior.
- **Dreams.** On its own schedule it revisits recent activity and consolidates short-term experience into durable long-term memory — the way sleep turns a day's events into lasting knowledge.
- **Improves over time.** Reflection, memory, and self-authored skills compound into an agent that gets better the longer it runs.

> Reflection, dream-based memory consolidation, and autonomous self-improvement are
> central to CogniSphere's design. See [Status & roadmap](#status--roadmap) for exactly
> what ships in v0 today versus what's on the way.

**Under the hood,** CogniSphere is a multi-agent orchestration server: one Node process
owns many independent agents, each a self-contained directory of prompts, skills, scripts,
app state, and a workspace. For every batch of inbound notifications, the harness spawns a
short-lived [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) subprocess
to run the LLM loop (the model at the core), then gets out of the way.

---

## Why CogniSphere

CogniSphere optimizes for the properties that are **nearly impossible to retrofit**
onto an agent platform — simplicity, fleet operability, and clean source/thread
routing — and deliberately leaves intelligence features (auto-compaction,
self-evolution) as additive modules you can grow into.

| Differentiator | What it means |
|---|---|
| 🪶 **Minimal & legible** | ~20 server files, ~3.8K LOC. No framework. The LLM loop is delegated to the external `pi` binary, so the harness stays a thin orchestration shell. |
| 🧩 **One plugin contract** | Implement a single TypeScript interface (`start` / `stop` / `handleHttpRequest` + `ctx.notify`), drop a folder under `plugins/<id>/`, and it's dynamically imported. Adding an event source is *one file*. |
| 📁 **File-resident state** | Every agent is a directory. `tar` it and you have a backup. No hidden global state, no external store required. |
| 🚀 **Multi-agent is the native shape** | Many agents live in-memory in one process, each isolated on disk under `agents/<id>/`. Add an agent = drop an `agent.json` + restart (or hit the agents API). Scale out = run more servers with a different `COGNISPHERE_ROOT_DIR`. |
| 🧵 **Declarative session routing** | Per-agent `threadIdStrategy` (`single`, `plugin`, or `plugin_channel`) keys conversations to source/thread. A unified SQLite events table tracks every notification with `thread_id`, `status`, and `priority` — fully durable across restarts. |
| 🔁 **Resumable sub-agents** | Sub-agents are `pi` subprocesses; reuse the same `--session-dir` and a child resumes its prior session across many parent batches. Persistence by convention, not a heavyweight subsystem. |
| ⚡ **Per-thread queueing** | A per-agent SQLite WAL queue with a small worker pool serializes work per thread while allowing concurrent batches across threads up to `maxConcurrentSlots`. |

> CogniSphere is the foundation; you grow it into your own platform.

---

## Architecture

```
┌─ Node server process ──────────────────────────────────────────────┐
│  HTTP server (single port — Hono)                                  │
│   ├── /webhook/<agentId>/<pluginId>/...   plugin webhooks (external)│
│   ├── /admin/<agentId>/send                operator → agent         │
│   ├── /admin/<agentId>/abort | /steer      operator controls        │
│   └── /api/* , /healthz , SPA shell                                 │
│                                                                    │
│  PluginRegistry — scans built-in + user-space plugin roots         │
│                                                                    │
│  AgentManager                                                      │
│    ├── Agent admin (privileged: platform plugin)                   │
│    ├── Agent A1                                                    │
│    │     ├── AgentRunner (queue + workers + spawn pi)              │
│    │     ├── PluginInstance: telegram                              │
│    │     └── PluginInstance: admin                                 │
│    └── Agent A2 …                                                  │
│                                                                    │
│  EventLog (SQLite — one row per notify, one row per batch)         │
└────────────────────────────────────────────────────────────────────┘
                          │
                          ▼ per batch
                  spawn `pi --mode rpc`   (cwd = agent dir, short-lived)
```

One Node process. In-process plugin actors. One `pi` child per batch. No daemon
beyond the server. Tools (`read`, `bash`, `edit`, …) execute inside the child
against the agent's working directory.

→ Deep dive: [`docs/server.md`](docs/server.md) (implemented subsystem) ·
[`docs/hld.md`](docs/hld.md) (full design contract) ·
[`docs/event-flow-visualization.html`](docs/event-flow-visualization.html) (event/notification lifecycle).

---

## Built-in plugins (apps)

**A plugin is an app** — an agent's window onto the outside world. Each is a
TypeScript module that lives in-process: it turns external events into agent
**notifications** (`ctx.notify`) and ships CLI scripts the agent runs via its
`bash` tool to act back out — sending a message, replying to an email,
collaborating with a teammate.

| Plugin | Purpose |
|---|---|
| `admin` | Operator ↔ agent chat over the internal `/admin/<agentId>/send` endpoint. |
| `scheduler` | Cron-style timers that wake an agent on a schedule. |
| `telegram` | Inbound Telegram messages → notifications; outbound replies via CLI. |
| `gws` | Google Workspace / Gmail integration (polling + actions). |

Authoring a new source is a single file implementing the `Plugin` interface in
[`packages/harness/core/types.ts`](packages/harness/core/types.ts). Drop it under
`plugins/<id>/` (user-space plugins shadow built-ins on id collision) and it's
dynamically imported on boot.

---

## Quick start

**Prerequisites:** Node ≥ 20 and pnpm.

```bash
# 1. Clone
git clone https://github.com/t0r0id/CogniSphere.git
cd CogniSphere

# 2. Install all workspace deps (harness + web)
pnpm install

# 3. (optional) build the web UI — without it the server serves a JSON status page
pnpm run build:web

# 4. Run the server
pnpm run dev     # tsx watch (hot reload)
# or
pnpm start       # one-shot
```

The server listens on `http://127.0.0.1:7331` by default.

### Configuration

Set via environment (a `.env` file in the repo root is loaded automatically):

| Variable | Default | Purpose |
|---|---|---|
| `COGNISPHERE_ROOT_DIR` | `~/.cognisphere` | Base data path; multiple harnesses can share it. |
| `COGNISPHERE_ID` | `default` | `<rootDir>/<harnessId>` is the harness home. |
| `PORT` | `7331` | HTTP listen port. |
| `BIND_HOST` | `127.0.0.1` | Listen interface. |
| `SERVER_BASE_URL` | `http://<host>:<port>` | Base URL used to build plugin webhook URLs. |

Sensitive files (`secrets.json`, `models.json`, `users.json`, `session-key`)
live under `<rootDir>/<harnessId>/.secrets/` (mode `0600`, keep out of VCS).

### Creating an agent (v0 manual workflow)

```bash
ROOT=~/.cognisphere/default
ID=dr-renu   NAME="Dr Renu"
mkdir -p "$ROOT/agents/$ID"/{system_prompts,workspace,sessions,plugins}
# write agent.json, the system prompts (system_prompts/), and workspace/index.md,
# install plugins under plugins/<id>/, then restart the server (or call the agents API).
```

Full recipe: [`docs/v0-deferred.md`](docs/v0-deferred.md) §3.1 and
[`docs/server.md`](docs/server.md) §7.

---

## HTTP API

A single Node `http.Server` exposes three surfaces:

- **`/api/*`** — agents, filesystem, secrets, models, harness settings (cookie-auth gated).
- **`/admin/<agentId>/*`** — operator chat / abort / steer (cookie-auth gated).
- **`/webhook/<agentId>/<pluginId>/*`** — external plugin webhooks (raw req/res, no harness auth).

Full route reference, request/response shapes, and the auth model:
[`docs/api.md`](docs/api.md).

---

## Project layout

```
cognisphere-harness/
├── apps/
│   ├── server/                 # the harness (Node + Hono + SQLite)
│   │   ├── src/
│   │   │   ├── main.ts         # boot + route wiring
│   │   │   ├── agent-manager.ts# owns all agents
│   │   │   ├── runner.ts       # queue + workers + spawn pi
│   │   │   ├── queue.ts        # per-agent SQLite WAL queue
│   │   │   ├── rpc.ts          # pi --mode rpc client
│   │   │   ├── plugin-registry.ts
│   │   │   └── api/            # HTTP routes
│   │   ├── plugins/            # built-in plugins: admin, scheduler, telegram, gws
│   │   └── agents/templates/   # base agent template (system prompts, extensions)
│   └── web/                    # React + Vite + shadcn/ui operator console
├── docs/                       # design & reference (see below)
└── package.json
```

---

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/hld.md`](docs/hld.md) | High-level design — the contract for all subsystems. |
| [`docs/server.md`](docs/server.md) | Implemented agent-runner subsystem: process model, on-disk layout, components, flows. |
| [`docs/api.md`](docs/api.md) | HTTP surface: auth model, every route, request/response shapes. |
| [`docs/v0-deferred.md`](docs/v0-deferred.md) | What v0 cut from the HLD, with manual workflows in place. |
| [`docs/improvement-design.md`](docs/improvement-design.md) | Roadmap for self-evolution and memory features. |
| [`docs/cognisphere-vs-hermes.html`](docs/cognisphere-vs-hermes.html) | Scored comparison vs `hermes-agent`. |
| [`docs/event-flow-visualization.html`](docs/event-flow-visualization.html) | Event & notification lifecycle, visualized. |

---

## Status & roadmap

CogniSphere is at **v0**. Shipping today: the runner, per-agent queue, plugin
contract, the four built-in plugins, and the operator web console. Agents are
created manually on disk.

Designed but **deferred** (see [`docs/v0-deferred.md`](docs/v0-deferred.md)):

- The privileged **admin agent** + `platform` plugin that CRUDs other agents/skills (the autonomous "self-evolving" loop).
- **Automatic memory compaction** (token-budget summarization).
- Docker isolation and per-agent process isolation.

The framework already has the bones for self-evolution — agents can author
`skills/agent/`, `scripts/agent/`, and `extensions/agent/` on disk — the
autonomous curation loop is what's deferred.

---

## Contributing

After any change, run the full check (typecheck + lint for both packages):

```bash
pnpm check
```

Resolve every error **and** warning before opening a PR, and keep the docs in
sync — see [`CLAUDE.md`](CLAUDE.md) for the contributor guidelines (which docs to
update for which changes, the simplicity/surgical-changes bias, etc.).

---

## Credits

CogniSphere builds on the [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
coding-agent runtime for the per-batch LLM loop.
