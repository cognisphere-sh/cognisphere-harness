# Phase 4: core prompt and capabilities

[Roadmap](../roadmap.md) · Previous: [Phase 3](phase-03-agent-layout-and-assets.md) · Next: [Phase 5](phase-05-subagents.md)

## Requirement

- **Smaller agents:** each agent gets only the abilities it needs. A research agent doesn't need Telegram instructions, and a support bot doesn't need the browser.
- **Split the base prompt:** today's 412-line base prompt becomes a short always-on core plus atomic, selectable abilities.
- **Packaging:** an ability brings its own instructions, scripts and dependencies, so selecting it is all that's needed, and later (phase 9) its dependencies are installed in the agent's image.

## Two rules

1. **Tools aren't skills.** File reading and editing are Pi built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). They are chosen per agent (and per sub-agent) with Pi's `--tools`, through `agent.json → tools`.
2. **Always-on rules belong in the core prompt; occasional procedures become skills.** Pi loads skills lazily: only each skill's name and description sit in the system prompt, and the model reads the body when it decides to. Anything that must hold on every turn can't depend on the model choosing to read it.

## Capability package

```text
base/capabilities/<id>/
  capability.json      { description, defaults: { prompts: [...], skills: [...], handlers: {...} },
                         dependencies: { apt: [...], python: "requirements.txt", node: "package.json" } }
  prompts/             short always-on fragments (optional; most capabilities need none)
  skills/<name>/       SKILL.md + scripts/
  extensions/          Pi extensions (loaded with --extension when the capability is enabled)
```

**A plugin is a capability with a coordinator part.** Today's plugin `seed/` folders become capability folders. Their `index.ts` (listeners, OAuth) is the coordinator part, which phase 6 makes explicit.

**`agent.json`:**

```json
"tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
"capabilities": ["notes", "memory", "task-threads", "web-search", "telegram", "gws"]
```

- **Enabling a capability:** the harness appends its default prompts, skills and handlers to the selection in `agent.json`.
- **Disabling:** removes those entries.
- **Assets that need a capability:** `agent.json` may select a `base/capabilities/<id>/…` path only when `<id>` is enabled.
- **Dependencies:** while agents run as processes (phases 4–8), they are provided by today's `bootstrap.sh`. From phase 9 they go into the agent image.

## Proposed split of today's base prompt

| Current section | New home |
|---|---|
| Agent identity; threads; message metadata (including `EventId`); communication model ("your text output is internal; reply through plugins"); short layout summary; how to use skills | `base/prompts/core.md`, always on, target about 80 lines |
| Tools (a copy of Pi's tool schemas) | Deleted (Pi already sends the schemas). The bash quoting and `set -u` rules move into `core.md`. |
| Task threads: delegating, and working as a task thread | Capability `task-threads` (skill) |
| Workspace notes, daily notes | Capability `notes` (skill), plus a one-line always-on rule in its prompt: "update `threads/<id>/notes.md` before ending a turn" |
| Knowledge, memory | Capability `memory` (skill), plus a one-line always-on rule |
| Sessions (`session-reader`) | Capability `session-history` (skill + script) |
| File attachments | Capability `attachments` (skill) |
| Web search and fetching (`ddgs`, `markitdown`) | Capability `web-search` (skill + scripts + Python dependencies) |
| Browser tasks (`agent-browser`) | Capability `browser` (skill + script + Chromium/Playwright dependencies) |
| App home, platform code changes | Capability `platform` (skill: "ask nova") |
| Plugin prompts (`plugin-telegram.md` …) | `base/capabilities/<plugin>/prompts/usage.md`, and their skills as they are today |
| Extensions (`bash-guard`, `context-meta`, `skill-update-notice`) | Candidates to become capability extensions, following the extensions-first rule (open question 2). The delivery-receipt extension stays harness-owned and always loaded. **Known bug to fix in the rework:** `context-meta` never adds its Model/ContextUsage lines, on 0.84.4 and 0.99.2 alike. Its `context` handler only appends to a `user` or `toolResult` message, but the last message is always its own checkpoint (role `custom`). Found during phase 0. |

**Default capability set for new agents:** `notes`, `memory`, `task-threads`, `web-search`, `attachments`. Today's agents keep their behavior through migration: every current section stays enabled.

## Done when

- `core.md` alone produces a working agent that replies through a plugin and records notes.
- Each capability can be enabled and disabled from `agent.json`, and the selection in `agent.json` follows.
- An agent with only `notes` and `telegram` has a system prompt under an agreed size, and its skill list shows only those skills.
- Migrated agents get all capabilities that match their current prompt, and their behavior is unchanged in a manual test conversation.
- Docs: agents.md (capabilities, tools), plugins.md (plugin = capability + coordinator part), shipped README (capability list).

## Open questions

1. Is the default capability set for new agents right?
2. Should Pi extensions (`bash-guard`, `context-meta`, `skill-update-notice`) become selectable capabilities too, or stay always-on harness parts?
3. Should a capability be able to require another (for example, `gws` needs `attachments`), or should we keep it flat and validate only?
