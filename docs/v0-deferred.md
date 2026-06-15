# v0 — deferred: admin agent + privileged platform

The HLD describes an **admin agent** auto-bootstrapped at first boot, holding
a privileged **`platform`** plugin that gives the agent CRUD authority over
every other agent and every plugin instance. v0 ships **without** that
machinery. Agents are created manually on disk; the server only loads what
it finds. This doc records the pieces that were intentionally cut so they
can be brought back in a later phase, plus the manual flows v0 expects in
their place.

---

## 1. What v0 keeps

- `AgentRunner`, queue, event log, RPC, system-prompt assembly, sysprompt
  variable substitution.
- `PluginRegistry` (built-in + user-space scan roots).
- `PluginInstanceContext`, `validateAndDefault`, `checkRequiredSecrets`.
- The `admin` plugin (generic operator-chat channel — POSTs to
  `/admin/<agentId>/send` deliver a `user_message` notification). Any
  manually-created agent can install it.
- `/admin/<agentId>/{send,abort}` and `/webhook/<agentId>/<pluginId>/<rest>`
  HTTP routes.
- Built-in plugins: `admin`, `scheduler`, `telegram` (stub), `gmail` (stub).

## 2. What v0 drops

| Piece | What it was |
|---|---|
| Admin-agent bootstrap | First-boot creation of an agent at `<root>/agents/admin/` with `privileged: true`, auto-installing `admin` + `platform`. |
| `platform` plugin | Privileged plugin exposing CRUD (create/delete agents, install/uninstall plugins, write user-space plugin source, rescan, set secrets, set config, enable/disable notifications, tail events) over `/internal/<verb>` loopback. |
| `PrivilegedPluginContext` | Extension of `PluginInstanceContext` carrying direct `agentManager` + `pluginRegistry` references. Granted only to `platform` on a privileged agent. |
| `agent.json.privileged` | Boolean field. Source of truth for whether a context gets the extras. |
| `AgentManager` CRUD methods | `create()`, `delete()`, `installPlugin()`, `uninstallPlugin()`, `setPluginConfig()`, `setPluginSecrets()`, `setNotificationEnabled()`, `writePluginSource()`. |
| `SecretsStore.setOverride/clearOverride` | In-memory secret overrides settable from a privileged context. |
| Seed-copy and template-render machinery | `copySeedInto`, `nextSysPromptSlot`, `renderTemplate` helpers, the `agent.json.template` and `1-agent.md.template` files. |
| Prompt-templates wiring | The runner no longer passes `--prompt-template` for `<agent>/prompts/<plugin-id>/` or `<agent>/prompts/agent/`. The `prompts/` resource family in HLD §6.2 is unimplemented in v0. |
| Sub-agents | The harness preamble's "Sub-agents" section, the `<agent>/subagents/` resource family, and the `${subAgentSessionDir(...)}` session layout (HLD §6.2, §7) are unimplemented in v0. Agents do not delegate to nested `pi` processes. |

The HLD's §1 (goal #3 about admin authoring), §9.2 (`platform`), §9.5
(`PrivilegedPluginContext`), §11.1 (admin bootstrap branch), §11.4 (install
flow), §11.5 (uninstall flow), §11.6 (create flow) all describe behavior
that is **not implemented in v0**. The contracts they define are what the
re-introduction should target.

## 3. v0 manual workflow

### 3.1 Create an agent

```bash
ROOT=~/.cognisphere/default                      # or wherever COGNISPHERE_ROOT_DIR points
ID=dr-renu                                     # agent id (= dir name)
NAME="Dr Renu"

mkdir -p "$ROOT/agents/$ID"/{system_prompts,workspace/memory,sessions,assets,plugins}
mkdir -p "$ROOT/agents/$ID"/{skills,scripts,extensions}/agent

# 1. agent.json   (tools are fixed at all 7 — not configurable)
cat > "$ROOT/agents/$ID/agent.json" <<EOF
{
  "name": "$NAME",
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5",
    "thinkingLevel": "medium"
  },
  "threadIdStrategy": { "type": "plugin_channel" },
  "maxConcurrentSlots": 1,
  "maxAttempts": 3,
  "runtime": "subprocess"
}
EOF

# 2. base prompt — copy and bake agent-fixed vars
#    ({{ThreadId}} stays literal; the runner appends ThreadId / ThreadSessions
#     at the end of the assembled prompt at spawn time.)
TZ_VAL="UTC"
sed -e "s|{{AgentId}}|$ID|g" \
    -e "s|{{AgentName}}|$NAME|g" \
    -e "s|{{AgentDir}}|$ROOT/agents/$ID|g" \
    -e "s|{{Timezone}}|$TZ_VAL|g" \
    apps/server/agents/templates/base/system_prompts/0-base_prompt.md \
    > "$ROOT/agents/$ID/system_prompts/0-base_prompt.md"

# 3. persona — write your own
cat > "$ROOT/agents/$ID/system_prompts/1-agent.md" <<EOF
# Agent: $NAME

(persona / domain instructions here)
EOF

# 4. workspace index — copy
cp apps/server/agents/templates/base/workspace/index.md \
   "$ROOT/agents/$ID/workspace/index.md"

# 4b. harness-bridge extension — copy so the runner can capture pi session
#     entry ids in real time (used by smart retry / continue-vs-resend). The
#     agent still runs without it, but loses real-time entry linking and a
#     delivered-but-failed row can't be told apart for a continue retry.
mkdir -p "$ROOT/agents/$ID/extensions"
cp apps/server/agents/templates/base/extensions/harness-bridge.ts \
   "$ROOT/agents/$ID/extensions/harness-bridge.ts"

# 5. bootstrap dir — copy from template, then run to provision .venv,
#    install ffmpeg/pdftoppm/markitdown/ddgs. The runner auto-activates
#    .venv at spawn time; bootstrap is the operator's responsibility (same
#    as system_prompts/, workspace/, etc.). Edit
#    "$ROOT/agents/$ID/bootstrap/requirements.txt" first if you want extra
#    Python deps. To refresh deps later: edit requirements.txt and re-run
#    bootstrap.sh (idempotent), or delete .venv and re-run.
cp -r apps/server/agents/templates/base/bootstrap \
   "$ROOT/agents/$ID/bootstrap"
bash "$ROOT/agents/$ID/bootstrap/bootstrap.sh"
```

Restart the server. Boot scans `<root>/agents/`, finds `dr-renu`, loads it.
`/healthz` will report `agents: 1`.

### 3.2 Install a plugin (on an agent)

```bash
PID=admin                                       # or scheduler, telegram, ...
SRC=apps/server/plugins/$PID                    # built-in source
DST=$ROOT/agents/$ID

# state + inbox + config + notifications
mkdir -p "$DST/plugins/$PID"/{state,inbox}
echo '{}' > "$DST/plugins/$PID/config.json"
# enabled: every notification declared by the manifest. For v0, easiest is to
# enable everything by reading the manifest from the server's logs at boot,
# or hand-pick:
echo '{"enabled":["user_message"]}' > "$DST/plugins/$PID/notifications.json"

# copy seed/ — recursive, with system_prompt.md → <N>-<pluginId>.md
SEED=$SRC/seed
if [ -d "$SEED" ]; then
  # system_prompt.md gets the next free N (≥ 2)
  N=$(ls "$DST/system_prompts" | grep -oE '^[0-9]+' | sort -n | tail -1)
  N=$((${N:-1} + 1))
  [ -f "$SEED/system_prompt.md" ] && cp "$SEED/system_prompt.md" \
    "$DST/system_prompts/$N-$PID.md"
  # everything else mirrors paths
  rsync -a --exclude system_prompt.md "$SEED/" "$DST/"
fi
```

Set secrets by editing `<rootDir>/<harnessId>/secrets.json` (auto-created
on first boot with a placeholder). Under each agent, every entry is a
**bucket**: the reserved bucket id `agent` holds agent-level secrets
(declared in `agent.json.secretsSchema`), other ids are plugin ids whose
keys are declared in each plugin's manifest:

```json
{
  "dr-renu": {
    "agent":    { "ELEVENLABS_API_KEY": "sk-..." },
    "telegram": { "TELEGRAM_BOT_TOKEN": "123:ABC..." },
    "gmail":    { "GMAIL_OAUTH_TOKEN": "ya29...." }
  }
}
```

Every bucket flattens into the agent's pi-runtime env on every spawn
(bare keys, last-writer-wins on collision), so plugin scripts and agent
CLIs read the same `$ELEVENLABS_API_KEY` / `$TELEGRAM_BOT_TOKEN` from
env. Top-level keys starting with `_` are ignored — used for inline docs
in the auto-created placeholder. Plaintext on disk for v0 (encryption
deferred). Restart the server after editing for changes to take effect.

To declare agent-level secrets, add a `secretsSchema` to `agent.json`.
Non-secret env vars (model ids, voice ids, feature flags) go in a
`config` map alongside it — they're flattened into the pi runtime env
the same way, but don't live in `secrets.json`:

```json
{
  "name": "Dr Renu",
  "model": { ... },
  "threadIdStrategy": { ... },
  "secretsSchema": {
    "type": "object",
    "properties": {
      "ELEVENLABS_API_KEY": { "type": "string", "description": "TTS/STT key" }
    }
  },
  "config": {
    "ELEVENLABS_VOICE_ID":  "v-...",
    "ELEVENLABS_TTS_MODEL": "eleven_multilingual_v2"
  }
}
```

Missing secrets in any bucket — `agent` or a plugin id — flow through
the same `checkRequiredSecrets` boundary: they log an error and the
affected scope is degraded (the plugin doesn't start; the agent's pi
child runs with those env vars unset), but the agent itself still loads
so the operator can fix them via Settings.

**Runtime env exposure.** Each agent's resolved secrets are flattened (bare
keys, last-writer-wins on collision) and exported into the pi child's env
on every spawn, alongside `PI_AGENT_ID` and `PI_WEBHOOK_BASE`. So plugin
CLI scripts the agent runs via `bash` can read e.g. `$TELEGRAM_BOT_TOKEN`
directly. Trade-off: secrets become visible to anything the agent does
(bash history, error logs, transcripts) — accepted in v0 in exchange for
ergonomic plugin scripts. Plugin authors should namespace their declared
keys (`TELEGRAM_*`, `GMAIL_*`, …) to avoid cross-plugin collisions.

### 3.3 Uninstall a plugin

Stop the server. Remove `<agent>/plugins/<id>/` and the corresponding
`system_prompts/<N>-<id>.md`. Restart.

### 3.4 Talk to an agent

Once the `admin` plugin is installed:
```bash
curl -X POST http://127.0.0.1:7331/admin/dr-renu/send \
  -H 'content-type: application/json' \
  -d '{"text":"hello"}'
```

Inspect events:
```bash
sqlite3 "$ROOT/agents/dr-renu/sessions/.events.db" \
  "SELECT id, ts, updated_at, status, plugin_id, thread_id FROM events ORDER BY updated_at DESC LIMIT 20;"
```

Inspect the conversation:
```bash
ls "$ROOT/agents/dr-renu/sessions/admin:operator/"
jq -c . "$ROOT/agents/dr-renu/sessions/admin:operator/<sessionId>.jsonl"
```

## 4. What the re-introduction looks like

Whoever brings the privileged path back should:

1. Restore `AgentJson.privileged` and `PrivilegedPluginContext` (HLD §9.5
   contract is intact in `docs/hld.md` — that's the spec).
2. Restore `AgentManager.{create, delete, installPlugin, uninstallPlugin,
   setPluginConfig, setPluginSecrets, setNotificationEnabled,
   writePluginSource}` and the seed-copy / template-render helpers
   (`copySeedInto`, `nextSysPromptSlot`, `renderTemplate`). These are pure
   filesystem operations on `<agent>/plugins/<id>/` plus a call to
   `startPluginInstance`.
3. Restore `SecretsStore.setOverride / clearOverride`.
4. Restore the `platform` plugin under `apps/server/plugins/platform/` —
   manifest, `handleHttpRequest` dispatcher for `/internal/<verb>`, seed
   scripts under `seed/scripts/platform/*` (each one a small bash CLI that
   `curl`s its loopback URL).
5. In `AgentManager.boot()`, restore the "if no admin dir, bootstrap one
   with `privileged: true` and auto-install admin + platform" branch.
6. In `AgentManager.startPluginInstance()`, restore the privileged-extras
   assignment when `pluginId === "platform" && agentJson.privileged`.

Everything else in the HLD already covers the behavior; the cuts are
mechanical and additive.

## 5. Why deferred

- v0 needs a working agent runner more than it needs an in-product
  authoring loop. Building agents by hand is fine for the first few.
- Deferring lets the privileged-context shape settle as we use the runner
  in anger. The current sketch (`agentManager` + `pluginRegistry` directly
  on the context) is simple but bypasses any audit/permission boundary;
  before it ships, we want a chance to consider whether to gate it.
- The `platform` plugin's verb surface was 13 endpoints — small enough to
  rebuild from the HLD when the priorities line up.

## 6. Out-of-doc references

- `docs/hld.md` — the long-term design contract. Treat anything in §9.2,
  §9.5, §11.1 (admin bootstrap), §11.4–§11.6, and §15 (future work) as the
  spec for what to build when the privileged path returns.
- Git diff between this doc's commit and its parent shows the exact code
  removed.
