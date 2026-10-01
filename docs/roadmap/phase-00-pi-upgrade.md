# Phase 0: Pi 0.99 upgrade

[Roadmap](../roadmap.md) · Next: [Phase 1](phase-01-test-harness.md)

## Requirement

Move the harness from Pi **0.84.4** to the current **0.99.x** (0.99.2 at the time of writing) before building anything else on top of Pi.

- **Why now:** we are seven releases behind, and Pi ships breaking SDK and extension changes almost weekly. Every later phase builds on Pi's RPC mode, session files and extension hooks. Re-checking them once, now, is cheaper than discovering differences in the middle of a refactor.
- **Fixes we need:**
  - `abort` now cancels a running compaction;
  - `steer` and `follow_up` now pass through extension input handlers;
  - several cancellation and retry races are fixed;
  - retry backoff is capped (`retry.maxAgentDelayMs`, 60 s by default).
- **Decision context:** the harness keeps Pi's RPC mode rather than the SDK. The reasons are recorded in [phase 6](phase-06-agent-host-split.md#rpc-vs-sdk). The new Pi packages are explained in [Pi modules](../pi-modules.md).

## What changes

| Place | Today | After |
|---|---|---|
| `packages/harness/package.json` | `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` at `^0.84.4` | Both pinned to the exact 0.99.x version |
| `base-agent/bootstrap/bootstrap.sh` | `PI_VERSION` defaults to `0.84.4` (the global `pi` binary agents run) | The same 0.99.x version, so the binary and the types match |
| Shipped README | Mentions the pinned version through `PI_VERSION` | Unchanged text; the upgrade note goes in `CHANGELOG.md` |

### Breaking changes to re-check

These are the breaking changes between 0.84.4 and 0.99.2 that touch code we own.

| Pi change | Where it touches us | What to verify |
|---|---|---|
| `SessionEntry` gained `context_edit`; `SessionManager` is now the authority for provider context (0.87) | `core/pi-delivery-receipts.ts` reads entries | Receipts still find user entries. The check only looks at `type === "message"`, so it should be unaffected. |
| `context` handlers that filter messages no longer drop the prompt and tools; new `context_with_system` (0.87) | `extensions/context-meta.ts` returns filtered `messages` | Metadata trimming still works, and tools and the system prompt are still sent |
| `before_agent_start` system prompt changes are now stored in the transcript (0.86) | `context-meta.ts`, `skill-update-notice.ts` | Notices appear once, and resumed sessions don't repeat them |
| `TurnEndEvent` fields and the new `AgentBeforeSettleEvent` (0.87) | Extensions using `turn_start`, `agent_settled` | Type-check, then one live turn |
| `user_bash` fails closed (0.86) | Not used (`bash-guard` uses `tool_call`) | Nothing; confirm by search |
| `--no-extensions` now also disables the built-in MCP, codemode, tool-search and llama.cpp extensions (0.99) | Our launch flags | Good for us. Confirm that none of them load. |
| `--provider` without `--model` and an invalid `--mode` now fail (0.87, unreleased) | `runner.ts` always passes both | Nothing |
| OpenAI Codex renamed "OpenAI Codex (legacy)"; Sign in with ChatGPT added to the `openai` provider (0.99) | `core/oauth-logins.ts`, `api/models.ts`, `core/models-catalog.ts` | The console's Models page lists and signs in both. The existing Codex sign-in keeps working. |
| `models.json` legacy `models` form now replaces chat, image and classifier models (0.99) | `core/pi-models-sync.ts` writes Pi's `models.json` | Enabled models still resolve |
| Session file format | Still version 3, migrated on load | A session file written by 0.84.4 resumes under 0.99 |

## What the upgrade makes possible

### Adopt in this phase (small, low risk)

- **Input dispositions:** `prompt`, `steer` and `follow_up` responses now say `started`, `queued` or `handled`. The runner can stop guessing whether a steer joined the active run, and can mark `handled` input as done without waiting for a settle that will never come.
- **Session files created on the first user message:** Pi no longer leaves empty session files when it exits early. Startup thread-link backfill (core.md, startup step 3) then sees fewer orphan files. Verify and note it in core.md.
- **Faster startup:** Pi now uses Node's compile cache. Re-measure spawn-to-ready, which was about 0.5 s on 0.84.4.

### Use in later phases

| Pi feature (version) | What it gives us | Phase |
|---|---|---|
| `pi.appendEntry()` reported as `entry_appended` over RPC | Delivery receipts saved in Pi's own session file and kept out of the model's context. Recovery can rebuild row-to-entry links from the file instead of losing them with the process. | [6](phase-06-agent-host-split.md) |
| Prompt and tool changes stored in the transcript (0.86) | When an agent changes its prompt selection between batches, the change survives resume and keeps prompt caches warm | [3](phase-03-agent-layout-and-assets.md), [4](phase-04-core-prompt-and-capabilities.md) |
| Hooks that can act at turn end: `turn_end` and `agent_before_settle` returning `continue: true` (0.87) | Enforce always-on rules like "update `notes.md` before ending a turn" with a hook instead of prompt text | [4](phase-04-core-prompt-and-capabilities.md) |
| Edits to the model's context that don't rewrite history, such as `appendContextEdit(entryId, null)` (0.87) | Drop stale metadata blocks or bulky tool output from future context without rewriting history. A cleaner `context-meta`. | [4](phase-04-core-prompt-and-capabilities.md) |
| Per-model compaction budgets; prompt-cache warming (0.86) | Cost control per role: a cheap sub-agent model gets its own budgets | [5](phase-05-subagents.md) |
| Virtual models: extensions pick the physical model per request (0.99, experimental) | Another way to do cost routing besides sub-agents. Evaluate before building custom routing. | [5](phase-05-subagents.md) |
| Built-in MCP, codemode and tool search (0.99) | Candidate capabilities: MCP servers as a capability, codemode for running many tool calls inside one script. MCP OAuth tokens live in Pi's own auth storage, which conflicts with keeping secrets outside the unit, so they wait for the broker. | [4](phase-04-core-prompt-and-capabilities.md), [10](phase-10-secrets-broker.md) |
| `ctx.modelRegistry.stream()` for extensions (0.86); classifier models (0.99) | Cheap model calls inside an extension, for example classifying an event inside a handler | [7](phase-07-events-and-handlers.md) |
| ChatGPT subscription sign-in; Meta Muse sign-in; Anthropic workload identity federation (0.86–0.99) | More providers in the console. Workload identity is a fit for the model proxy, where no long-lived key is needed. | 0 (console), [10](phase-10-secrets-broker.md) |

### Not adopted

- **Switching to the SDK.** See [phase 6](phase-06-agent-host-split.md#rpc-vs-sdk).
- **The experimental packages** (`pi-durable`, `pi-server`, `pi-protocol`, `pi-client`, `chord`). See [future plans](../future/pi-native-runtime.md).

## Verification

Phase 1's automated tests come after this phase, so verification here is a type-check plus a **real-Pi smoke script**. The script is kept in the repo (for example `packages/harness/scripts/pi-smoke.ts`), and phase 1 reuses its scenarios.

1. `pnpm check` passes with the new types.
2. The smoke script, against a real model:
   - sends a prompt and gets a receipt with `entryId` and `eventIds`;
   - steers a second message mid-turn and gets a receipt for it;
   - aborts mid-turn;
   - resumes a session file written by 0.84.4;
   - runs a thread model override on a second provider.
3. Manually:
   - `bash-guard` blocks a guarded command;
   - `context-meta` trims metadata;
   - `skill-update-notice` fires once;
   - Anthropic and ChatGPT sign-ins work from the console.
4. Re-measure Pi spawn-to-ready time.

## Done when

- Both version pins are on the same exact 0.99.x, and `pnpm check` passes.
- The smoke script passes, and the manual checks above are done.
- The runner uses input dispositions for `steer`, `follow_up` and `prompt`.
- Docs:
  - core.md (Pi start arguments if they changed, dispositions, the session-file note);
  - agents.md (extension behavior notes);
  - `CHANGELOG.md` (upgrade entry);
  - the shipped README, if any user-visible behavior changes (new sign-in providers).

## Open questions

1. Pin the exact version (suggested, because Pi moves fast and bootstrap pins the global binary exactly anyway), or use `^0.99`?
2. Should phase 1 (the test harness) come first, so the upgrade is checked by automated tests rather than a smoke script? The smoke script is the compromise.
3. Should the console show the new ChatGPT sign-in now, or hide it until phase 10's model proxy?
