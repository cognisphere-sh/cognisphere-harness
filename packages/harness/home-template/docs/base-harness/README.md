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
    ├── agents/<id>/           ← one dir per agent (incl. the developer agent `nova`)
    └── plugins/<id>/          ← forked catalog plugins (shadow built-ins)
```

## CLI

Run from the app home or `harness/` (`pnpm exec cognisphere …`):

| Command | Purpose |
|---|---|
| `cognisphere agent new <name> [--dev]` | fork the base template into `agents/<name>/` (`--dev`: developer-agent persona + cognisphere skills) |
| `cognisphere plugin add <id>` | fork a catalog plugin into `plugins/<id>/` |
| `cognisphere dev` | run locally with hot reload (+ web console) |
| `cognisphere serve` | run once — the production entrypoint |
| `cognisphere upgrade` | show/drive the version upgrade (see skills.md) |

The web console (default `http://127.0.0.1:3142`) manages agents, threads,
plugin config, secrets, and model providers. Login users live in
`.secrets/users.json`.

## Anatomy of an agent

`harness/agents/<id>/`:

- `agent.json` — `name`, `description?` (one-line role blurb shown to other
  agents in the harness roster), `model: {provider, id, thinkingLevel?}`,
  `threadIdStrategy` (`single` | `plugin` | `plugin_channel`),
  `maxConcurrentSlots?`, `devAgent?` (marks the developer agent), optional
  `secretsSchema`/`configSchema`/`config`.
- `system_prompts/*.md` — concatenated in lexical order into the system
  prompt. Each file has an owner:
  - `0-*` — **harness-owned**: replaced by the shipped seed on every upgrade;
    don't edit them (`0.1-agent-directory.md` excepted — regenerated only
    when missing, edits survive).
  - `plugin-<id>.md` — **plugin-owned**: reseeded from the installed plugin
    on every agent start; edits are silently overwritten — don't edit them.
    Need different plugin behaviour? Fork the plugin instead.
  - `1-agent.md` — **yours**: the agent's identity, persona, and behaviour —
    and nothing procedural. Step-by-step procedures (SOPs, runbooks) are
    versioned skills under `skills/agent/` (see skills.md), so they stay
    discoverable and the agent notices when they change.

  If a deployment genuinely must override a harness- or plugin-owned prompt
  file, document the override (what and why) in `docs/harness/` — an
  undocumented divergence is treated as drift and reverted on the next
  upgrade or restart.
- `workspace/` — the agent's durable notes; `knowledge/` for cross-thread
  reference docs.
- `sessions/<threadId>/` — conversation history (JSONL), the assembled
  `.system-prompt.md` handed to pi on each spawn, + `.events.db`
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

- **Core** (`admin`, `scheduler`, `agent-messaging`) — bundled, auto-installed
  on every agent, not forkable.
- **Catalog** (`telegram`, `gws`, …) — forked into
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

Every home ships with a developer agent — always named `nova` (the id is
frozen and reserved; no other agent may use it) — whose job is to own and modify
this home's code (agents, user-space plugins, the app). The core
**agent-messaging** plugin lets the harness's other agents hand it code, doc
and software-install requests directly; human-facing channels (e.g. telegram)
are opt-in per deployment. It keeps
`docs/harness/` and `docs/app/` up to
date after every change. The cognisphere skills (`cognisphere-upgrade`,
`create-plugin`, `create-skill`) are installed in its own `skills/agent/` dir, so it can
drive harness upgrades and author plugins directly. To bring it up: set a
model provider. Other agents are instructed to pass code-change and install
requests to it rather than modify the platform themselves.

Who may message the developer agent (or any agent) is set per-inbox, not
per-sender: each agent's `agent-messaging` config has `allowMessageFrom`
(default `["*"]` — every in-harness agent). Restrict it to a list of sender
ids to cut everyone else off; a rejected sender gets a `not allowed` error.

## Upgrading

Upgrades are two-phase: bump the dependency, then migrate the data dir —
driven by the `cognisphere-upgrade` skill using [`CHANGELOG.md`](CHANGELOG.md)
(the full harness changelog, refreshed here on every upgrade). Read it to see
what each version changed.

## Deployment

See the scaffolded `scripts/` (`setup-server.sh`, `server.sh`, plus
`scripts/aws/` / `scripts/contabo/` provisioning) and `config.example`.
Day-to-day deploy loop on the box: `git pull && sudo ./scripts/server.sh restart`.

Those scripts are harness-owned (refreshed on upgrade) — never edit them.
App-specific deploy customization (extra secrets/env materialization, extra
provisioning, extra config params) lives in the deployment-owned hooks under
`scripts/app/`, which the harness-owned scripts source when present. See
`scripts/app/README.md` for the hook contract.
