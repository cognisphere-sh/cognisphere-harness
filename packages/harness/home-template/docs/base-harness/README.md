# CogniSphere harness — user reference

> **Owned upstream.** This directory documents the installed
> `@cognisphere-sh/cognisphere-harness` library from a *user's* perspective —
> how to run it, configure it, and build on it. It ships with the harness
> package and is refreshed on upgrades. Do not edit it here; deployment-specific
> documentation belongs in `../harness/` and `../app/`.

CogniSphere is a multi-agent orchestration server. One Node process hosts many
independent agents. Each agent:

- lives in its own directory under `harness/agents/<id>/` (prompts, workspace,
  sessions, plugins — all on disk, all git-trackable);
- reaches the outside world **only through plugins** (telegram, scheduler,
  admin, gws, agent-messaging, …);
- runs an LLM child process (`pi`) per batch of inbound messages, with
  durable per-thread queues and sessions.

The harness library itself lives in `node_modules` — **you never edit its
code**. Everything you own is data: agent dirs, forked plugins, secrets,
config.

## The app home

```
<app-home>/                    ← git repo + pnpm workspace (this repo)
├── CLAUDE.md / AGENT.md       ← engineering guidelines for coding agents
├── docs/                      ← project docs (this tree)
├── config.example             ← deploy params; cp to `config` (gitignored)
├── scripts/                   ← lifecycle + per-platform deploy scripts
├── .claude/skills/            ← cognisphere skills (see skills.md)
├── app/                       ← your user-facing app (see app/README.md)
└── harness/                   ← the harness data dir
    ├── harness.json           ← { version, timezone }
    ├── .secrets/              ← secrets.json, models.json, users.json (gitignored)
    ├── agents/<id>/           ← one dir per agent (incl. the developer agent, default `dory`)
    └── plugins/<id>/          ← forked catalog plugins (shadow built-ins)
```

## CLI

Run from the app home or `harness/` (`pnpm exec cognisphere …`):

| Command | Purpose |
|---|---|
| `cognisphere agent new <name> [--dev]` | fork the base template into `agents/<name>/` (`--dev`: developer-agent persona + cognisphere skills + telegram) |
| `cognisphere plugin add <id>` | fork a catalog plugin into `plugins/<id>/` |
| `cognisphere dev` | run locally with hot reload (+ web console) |
| `cognisphere serve` | run once — the production entrypoint |
| `cognisphere upgrade` | show/drive the version upgrade (see skills.md) |

The web console (default `http://127.0.0.1:7331`) manages agents, threads,
plugin config, secrets, and model providers. Login users live in
`.secrets/users.json`.

## Anatomy of an agent

`harness/agents/<id>/`:

- `agent.json` — `name`, `model: {provider, id, thinkingLevel?}`,
  `threadIdStrategy` (`single` | `plugin` | `plugin_channel`),
  `maxConcurrentSlots?`, `devAgent?` (marks the developer agent),
  `devAgentAccess?` (default true — see below), optional
  `secretsSchema`/`configSchema`/`config`.
- `system_prompts/*.md` — concatenated in lexical order into the system
  prompt. `0-*` files come from the base template; write the persona in
  `1-<something>.md`.
- `workspace/` — the agent's durable notes; `knowledge/` for cross-thread
  reference docs.
- `sessions/<threadId>/` — conversation history (JSONL) + `.events.db`
  (message queue / event log — inspect with `sqlite3`).
- `plugins/<id>/` — an empty dir installs that plugin for this agent;
  `config.json` inside it holds the plugin's per-agent config.
- `scripts/`, `skills/`, `extensions/` — CLIs and skills available to the
  agent (`agent/` scope is yours; `<plugin-id>/` scopes are seeded by
  plugins and overwritten on every start).
- `bootstrap/bootstrap.sh` — runs on every agent start; provisions the
  agent's `.venv` and system deps.

A **thread** is one conversation. `threadIdStrategy` controls how inbound
messages map to threads (one global thread, one per plugin, or one per
plugin+channel).

## Plugins

- **Core** (`admin`, `scheduler`) — bundled, auto-installed on every agent,
  not forkable.
- **Catalog** (`telegram`, `gws`, `agent-messaging`, …) — forked into
  `harness/plugins/<id>/` by `cognisphere plugin add`, then enabled per agent
  by creating `agents/<agent>/plugins/<id>/`. Forked copies are yours to edit
  and shadow the bundled ones.
- Custom plugins: use the `create-plugin` skill (see skills.md).

The **telegram** plugin long-polls a bot; set
`secrets.json → <agent>.telegram.TELEGRAM_BOT_TOKEN`. Sending `/reset` to the
bot wipes that conversation's context (the thread's queue rows and session
files) — the next message starts fresh.

## Secrets and models

Both under `harness/.secrets/` (0600, gitignored, editable via the console):

- `secrets.json` — per-agent buckets: `agent` (agent-level env) plus one per
  plugin id. All keys are injected into the agent's environment.
- `models.json` — per-provider credentials + the allowlist of enabled model
  ids. Subscription OAuth logins (Claude Pro/Max, Codex) are connected from
  the console's Models page instead of pasting keys.

Hand edits need an agent restart; console edits hot-reload.

## The developer agent

Every home ships with a developer agent (default id `dory`; chosen at
`cognisphere init` via `--dev-agent <name>`) whose job is to own and modify
this home's code (agents, user-space plugins, the app). It is reachable
exclusively via Telegram and keeps `docs/harness/` and `docs/app/` up to
date after every change. The cognisphere skills (`cognisphere-upgrade`,
`create-plugin`) are installed in its own `skills/agent/` dir, so it can
drive harness upgrades and author plugins directly. To bring it up: set its
telegram bot token and a model provider. Other agents are instructed to pass code-change
requests to it rather than modify the platform themselves.

Per-agent opt-out: set `"devAgentAccess": false` in an agent's `agent.json`
to (a) drop the developer-agent section from that agent's system prompt (it
won't know the developer agent exists) and (b) have its agent-messaging inbox reject
that agent's messages. Default is true.

## Upgrading

Upgrades are two-phase: bump the dependency, then migrate the data dir —
driven by the `cognisphere-upgrade` skill using [`CHANGELOG.md`](CHANGELOG.md)
(the full harness changelog, refreshed here on every upgrade). Read it to see
what each version changed.

## Deployment

See the scaffolded `scripts/` (`setup-server.sh`, `server.sh`, plus
`scripts/aws/` / `scripts/contabo/` provisioning) and `config.example`.
Day-to-day deploy loop on the box: `git pull && sudo ./scripts/server.sh restart`.
