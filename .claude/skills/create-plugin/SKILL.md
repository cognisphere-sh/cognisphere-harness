---
name: create-plugin
description: Author a new CogniSphere plugin in a harness's plugins/ directory — scaffold the index.ts + seed, enable it on an agent, and verify it loads and starts. Use when asked to "create a plugin", "author a new plugin", "add a custom plugin", or "write a plugin for the harness".
metadata:
  author: cognisphere
  version: "1.0.0"
  argument-hint: <plugin-id>
---

# Create a CogniSphere plugin

Plugins live at `<harnessDir>/plugins/<id>/` (user scope — shadows a bundled
plugin of the same id). The registry scans that dir at server boot, imports
`index.ts` via tsx, and instantiates the default-export class. Paths below are
relative to the **harness data dir** (the dir with `harness.json`).

A tested template lives in this skill dir under `template/` — copy it and
rename. Every command below was run and verified.

## 1. The contract (duck-typed — do NOT import from the harness package)

`plugins/<id>/index.ts` default-exports a class matching `Plugin` in
`packages/harness/src/core/types.ts` (installed:
`node_modules/@cognisphere-sh/cognisphere-harness/src/core/types.ts`):

```ts
export default class MyPlugin {
  manifest = {
    displayName: "My Plugin",
    description: "…",
    configSchema:  { type: "object", properties: { /* ajv, useDefaults */ }, additionalProperties: false },
    secretsSchema: { type: "object", properties: { MY_KEY: { type: "string" } }, required: [] },
  };
  async start(ctx): Promise<void> { /* poll, subscribe, ctx.notify(...) */ }
  async stop(): Promise<void> { /* clear timers, close sockets */ }
  // optional: handleHttpRequest(req, res) — served at /webhook/<agent>/<id>/*
}
```

Production plugins duck-type this (see `template/index.ts`); they don't import
harness types, so the plugin has no build step and no dependencies.

`ctx` (PluginInstanceContext): `agentId`, `agentDir`, `stateDir`
(`agents/<a>/plugins/<id>/state/`), `inboxDir` (`…/inbox/`), `config`
(validated, defaults filled), `secrets` (resolved key→value), `timezone`,
`notify(name, payload)`, `httpBaseUrl`, `log`.

`notify` payload needs at least `{ text, channelId }`; optional `metadata`,
`threadIdOverride`, `isSilent`, `doNotSteer`, `priority`. It enqueues an event
and wakes the agent (or steers a live run).

## 2. Seed — prompt fragment + agent-facing CLIs

The `seed/` tree is recursively copied into the agent dir on **every agent
start**, so it must mirror the agent layout **exactly**:

```
plugins/<id>/seed/
├── system_prompts/plugin-<id>.md   ← concatenated into the agent's system prompt (lex order)
└── scripts/<id>/<your-cli>         ← exec bit re-asserted after copy
```

Anything placed elsewhere (e.g. a root `system_prompt.md`) is copied but
**never read** — the prompt assembler only reads `system_prompts/*.md`.
Namespace scripts under `scripts/<id>/` to avoid collisions. Seed files are
plugin-owned: overwritten on every start, so never hand-edit the copies in the
agent dir.

## 3. Scaffold

```bash
cp -R .claude/skills/create-plugin/template plugins/<id>
mv plugins/<id>/seed/system_prompts/plugin-hello.md plugins/<id>/seed/system_prompts/plugin-<id>.md
mv plugins/<id>/seed/scripts/hello plugins/<id>/seed/scripts/<id>
# then edit index.ts: rename the class, write your manifest/start/stop
```

## 4. Enable on an agent

A plugin runs on an agent iff `agents/<agent>/plugins/<id>/` exists (core
plugins `admin`/`scheduler` always run):

```bash
mkdir -p agents/<agent>/plugins/<id>
```

Optional per-agent config (validated against `configSchema`, ajv fills
defaults):

```bash
echo '{"intervalSec": 60}' > agents/<agent>/plugins/<id>/config.json
```

Secrets go in `.secrets/secrets.json` under the plugin's bucket — keys must be
declared in `secretsSchema` (a missing `required` secret fails the plugin, not
the agent):

```json
{ "<agent>": { "<id>": { "MY_KEY": "value" } } }
```

## 5. Run and verify

```bash
cognisphere serve --port 7445 --headless   # or `cognisphere dev` (hot reload)
```

Watch the log for `"plugin loaded"` with `"scope":"user"` and your id — a
load failure (bad export, missing manifest) logs `failed to load plugin` and
the plugin is skipped. Then start the agent and confirm the plugin started:

```bash
curl -s -c /tmp/c.txt -X POST http://127.0.0.1:7445/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"changeme"}'
curl -s -b /tmp/c.txt -X POST http://127.0.0.1:7445/api/agents/<agent>/start
```

Success log: `agent started` with `"runningPlugins":[…,"<id>"]`. Also confirm
the seed landed: `ls agents/<agent>/system_prompts/plugin-<id>.md`.

Config/secret edits need an agent restart to take effect:
`curl -s -b /tmp/c.txt -X POST http://127.0.0.1:7445/api/agents/<agent>/restart`.

## Gotchas

- **Agent start fails with `provider <p> is not configured in Models
  settings`** before any plugin runs. For plugin-only testing a dummy key is
  enough: `PUT /api/models` with
  `{"providers":{"anthropic":{"credentials":{"apiKey":"sk-ant-dummy"},"enabledModels":["claude-sonnet-4-6"]}}}`.
- **Login is `POST /api/auth/login`** (sets a cookie), not `/api/login`. On a
  fresh harness booted without a TTY, credentials default to
  `admin`/`changeme` (a warning is logged).
- **A plugin failure doesn't sink the agent** — it's recorded as a failed
  PluginEntry. Check `GET /api/agents/<agent>` → `plugins[].error`.
- **`seed/system_prompt.md` at the seed root is silently dead** — only
  `seed/system_prompts/*.md` reaches the model. This exact bug shipped in two
  builtin plugins once; mirror the layout.
- **Plugin discovery is boot-time only.** A new `plugins/<id>/` dir needs a
  server restart (`cognisphere dev` watches harness *code*, not new plugin
  dirs — touch a watched file or bounce it).

## Reference

- Full lifecycle + on-disk layout: `docs/server.md` §4.9.3 and §5 (in this
  repo, or bundled with the installed package).
- Builtin plugins are the best examples: `telegram` (long-poll + CLI),
  `gws` (poller + shared lib in seed), `scheduler` (cron + CLI),
  `admin` (HTTP loopback). Installed:
  `node_modules/@cognisphere-sh/cognisphere-harness/src/plugins/`.
