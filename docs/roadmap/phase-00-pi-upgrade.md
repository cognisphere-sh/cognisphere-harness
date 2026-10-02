# Phase 0: Pi 0.99 upgrade

[Roadmap](../roadmap.md) · Next: [Phase 1](phase-01-test-harness.md)

## Requirement

Move the harness from Pi **0.84.4** to **0.99.2** before building anything else on top of Pi, and fix the places where the harness doesn't use Pi the way Pi is designed to be used.

- **Why now:** we are nine releases behind (0.85.0 to 0.99.2), and Pi ships breaking SDK and extension changes almost weekly. Every later phase builds on Pi's RPC mode, session files and extension hooks. Re-checking them once, now, is cheaper than discovering differences in the middle of a refactor.
- **Why more than a version bump:** the review found three places where the harness works around Pi instead of using it:
  - The runner treats `agent_end` as the end of a batch and closes Pi's input there. Pi shuts down on that, so Pi's own retries, context-overflow recovery and late steers never run. This was already true on 0.84.4. Every Pi retry fix since then (backoff cap, retry race fixes) only helps us once we wait for `agent_settled`.
  - Delivery receipts travel over `ctx.ui.setStatus`, a UI call we misuse as a pipe. Pi 0.99 has a documented channel for this: `pi.appendEntry()`, reported as `entry_appended`.
  - The runner starts the *global* `pi` installed by bootstrap, while the types come from `node_modules`. They drift: the dev machine runs 0.85.1 against a 0.84.4 pin.
- **Decision context:** the harness keeps Pi's RPC mode rather than the SDK. The reasons are recorded in [phase 6](phase-06-agent-host-split.md#rpc-vs-sdk). The new Pi packages are explained in [Pi modules](../pi-modules.md).

## Findings from the review

Checked against the Pi source at v0.99.2 plus the unreleased commits after it.

- `pnpm check` passes against an exact 0.99.2 pin with **no code changes**.
- Pi's own RPC docs (`docs/rpc.md`, `docs/json.md`) say: `agent_end` ends one low-level run, and retries, overflow recovery, compaction, steering or follow-up work can still follow. `agent_end` carries `willRetry`. `agent_settled` means nothing else will run. Closing stdin makes Pi shut down at once.
- **Input dispositions** (`started`, `queued`, `handled` on `prompt`/`steer`/`follow_up` responses): `handled` means an extension `input` handler swallowed the message. A handled message is **never written to the session file**, so it never produces a receipt. Without a disposition check, the runner would resend it until it is dead-lettered.
- **No Pi hook gives the entry id of a user input.** Extensions see `message_end` *before* Pi saves the entry. The new `turn_end.messageEntryId` and `toolResultEntryIds` cover assistant and tool entries only. `entry_appended` fires only for extension entries, boundary entries and context edits. The RPC `id` is only for matching responses. So the `EventId` in `<harness-metadata>` plus an entry scan stays the way to link a queue row to its entry.
- **Session files now store the prompt:** since 0.86, the first request saves the system prompt and tools as a `role: "system"` message entry, and later prompt changes are saved as patches. Sessions written by 0.84 get the prompt as a later system message on their first 0.99 request. The console's `flattenSession` skips unknown roles, so nothing breaks.
- **Sign in with ChatGPT** (new on the `openai` provider) throws "requires a device ID" unless `login()` gets `{ getDeviceId }`. Pi's own `/login` passes `settingsManager.getOrCreateDeviceId()`; our `oauth-logins.ts` passes nothing.
- **The console's model shortlists are stale.** IDs missing from the 0.99.2 catalog:

  | Provider | Missing IDs |
  |---|---|
  | `anthropic` | `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022` |
  | `openai-codex` | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2` |
  | `google` | `gemini-2.0-flash` |
  | `deepseek` | `deepseek-chat`, `deepseek-reasoner` |
  | `groq` | `moonshotai/kimi-k2-instruct` |
  | `cerebras` | `llama3.3-70b`, `llama-4-scout-17b-16e-instruct` |
  | `xai` | `grok-4`, `grok-3`, `grok-3-mini` |
  | `zai` | `glm-4.6`, `glm-4.5` |
  | `fireworks` | `accounts/fireworks/models/deepseek-v3`, `accounts/fireworks/models/qwen3-coder-480b-a35b-instruct` |
  | `kimi-coding` | `kimi-k2-coding` |
  | `minimax` | `minimax-m2` |

  New models (Claude Opus 5.5, Sonnet 5.5, GPT-6 Sol/Luna/Astra, GPT-6.1 Sol, Grok 4.7) aren't listed.
- Pi has required Node `>=22.19.0` since 0.84.4. The harness `engines` field still says `>=20.12`.

## What changes

| Place | Today | After |
|---|---|---|
| `packages/harness/package.json` | `pi-coding-agent` and `pi-ai` at `^0.84.4`; `engines.node` `>=20.12` | Both pinned to exactly `0.99.2`; `engines.node` `>=22.19.0` |
| Pi binary (`core/runner.ts` `spawnPi`) | `spawn("pi", …)` finds the global binary on `PATH` | Spawns the `pi` bin of the `@earendil-works/pi-coding-agent` dependency with `process.execPath`. **One pin**: `package.json`. |
| `base-agent/bootstrap/bootstrap.sh` | Step 3 installs a global `pi` at `PI_VERSION` (0.84.4) | Step 3 and `PI_VERSION` removed. Nothing else uses the global `pi`. |
| Batch completion (`core/runner.ts`, `core/rpc.ts`) | Finish on `agent_end`, then close stdin | Finish on `agent_settled` (see [batch completion](#batch-completion)) |
| Delivery receipts (`core/pi-delivery-receipts.ts`, `core/rpc.ts`) | `ctx.ui.setStatus(STATUS_KEY, json)`, intercepted as `extension_ui_request` | `pi.appendEntry("cognisphere.delivery", { entryId, eventIds })`, read from the `entry_appended` event (see [receipts](#delivery-receipts)) |
| Input dispositions (`core/rpc.ts`, `core/runner.ts`) | Prompt reply checked only for `success`; steer reply ignored | Read `disposition` on both. `handled` rows are marked done without a receipt. |
| `core/oauth-logins.ts`, `core/models-catalog.ts` | Codex sign-in only; stale shortlists | Sign in with ChatGPT on `openai`, Codex labelled "(legacy)", and shortlists refreshed to IDs that exist in 0.99.2 |
| `CLAUDE.md` §7 "Pi version" | Pin in two places | Pin in one place (`package.json`) |
| Pi's config folder (`core/main.ts`, `core/config.ts`) | The run user's global `~/.pi/agent`, shared with other harnesses and the operator's own `pi`. A harness sync deleted hand-written overrides there during this phase's testing. | `harness/.secrets/pi/` per harness (`PI_CODING_AGENT_DIR`). Sign-ins are connected again once (not copied: shared rotating refresh tokens sign each other out). |
| Project trust (`core/runner.ts`) | An agent folder's `.pi/` settings, extensions and prompts load if Pi trusts it | `--no-approve` on every spawn: never loaded |

### Batch completion

Decided: finish a batch on `agent_settled`, not `agent_end`.

- The runner keeps the **last** `agent_end.messages` it saw, and gives its verdict with `endOfTurn()` on those messages when `agent_settled` arrives. A retried run replaces the earlier `agent_end`, so a run that succeeds on retry counts as complete.
- Pi exiting before `agent_settled` is still a crash (`[crash] pi exited without agent_settled`).
- The batch stays in `streaming` until `agent_settled`, so steers that arrive between `agent_end` and settle are fed into the same Pi process instead of being resent in a new batch.
- Abort is unchanged: the runner sends `abort` and closes stdin.
- **Retries, decided:** keep both layers at their defaults. Pi retries transient provider errors in-process (`retry.maxRetries` 3, backoff capped by `retry.maxAgentDelayMs` at 60 s). The queue retries the batch (`maxAttempts`, default 3) only after Pi gives up, crashes, or a row wasn't delivered. Worst case is about 12 model attempts per message, and each queue retry comes only after minutes of failure.
- With this change, these 0.85 to 0.99 fixes start to apply to us:
  - capped retry backoff;
  - fixed cancellation and retry races;
  - overflow recovery that drops abandoned attempts from future context;
  - `abort` cancelling a running compaction.

### Delivery receipts

Decided: move receipts to `pi.appendEntry` now, pulled forward from phase 6.

- How it works: the extension still finds `EventId`s in saved user entries by scanning on `message_start`, `turn_start`, `turn_end` and `agent_end`. For each new user entry it calls `pi.appendEntry("cognisphere.delivery", { entryId, eventIds })`. Pi saves a `custom` entry, which is kept out of the model's context, and emits `{"type":"entry_appended","entry":{…}}` on stdout. `PiRpcClient` routes entries with that `customType` to `onDeliveryReceipt`.
- **Seeding:** on `session_start`, the extension marks every user entry already in the file as reported. Otherwise each new Pi process would append a duplicate receipt for every earlier message. The runner ignores rows outside its batch anyway.
- **Gain:** receipts become a documented event, and they are saved in the session file. After a harness crash, a row-to-entry link can be rebuilt from the file instead of being lost. The rebuild itself is phase 2's or phase 6's job.
- **Cost:** one small custom line per user message in the session file.
- **Dispositions:**
  - `started` and `queued`: wait for a receipt, as today.
  - `handled`: mark the frame's rows done, with no receipt expected.

  Nothing returns `handled` today, but the first capability that adds an `input` handler would otherwise send its messages round in a resend loop.

### Breaking changes checked

| Pi change | Where it touches us | Result |
|---|---|---|
| `SessionEntry` gained `context_edit`; `SessionManager` is the authority for provider context (0.87) | `pi-delivery-receipts.ts` reads entries | Unaffected: it only reads `type === "message"` with `role === "user"`. |
| System prompt and tools saved as `role: "system"` message entries (0.86) | Receipts, `web/src/lib/session.ts`, `api/agents.ts` usage readers | Unaffected: all of them filter by role. Phase 13 decides whether search indexes system entries. |
| `context` handlers no longer see system messages; Pi restores prompt and tools (0.87) | `context-meta.ts` appends usage to the last message (it doesn't filter). Pi passes a clone. | Unaffected. Verify usage lines in one live turn. |
| `before_agent_start` `systemPrompt` saved in the transcript (0.86) | Neither extension returns `systemPrompt`; both return `message` or nothing | Unaffected |
| `TurnEndEvent` boundary fields, `AgentBeforeSettleEvent`, deferred runs from `agent_settled` (0.87) | Receipts sweep on `turn_end`; `context-meta` resets on `agent_settled` | Unaffected: handlers return nothing and request no runs. Type-checks. |
| `user_bash` fails closed (0.86) | Not used (`bash-guard` uses `tool_call`) | Nothing |
| `--no-extensions` also disables built-in MCP, codemode, tool-search and llama.cpp (0.99) | Our launch flags | Good for us: none of them load. |
| Invalid `--mode` fails (0.87.1); `--provider` without `--model` fails (unreleased after 0.99.2) | `runner.ts` passes valid `--mode rpc` and always both | Nothing |
| OpenAI Codex renamed "OpenAI Codex (legacy)"; Sign in with ChatGPT on `openai` (0.99) | `oauth-logins.ts`, `models-catalog.ts` | Needs the device-ID fix (see findings) |
| `models.json` legacy `models` form now replaces chat, image and classifier models (0.99) | `pi-models-sync.ts` writes only `modelOverrides` | Unaffected |
| Session file format | Still version 3 | Resume a 0.84.4 session in the checklist |

## What the upgrade makes possible later

| Pi feature (version) | What it gives us | Phase |
|---|---|---|
| Delivery receipts saved in the session file (adopted here) | Recovery rebuilds row-to-entry links from the file | [2](phase-02-reliable-intake.md), [6](phase-06-agent-host-split.md) |
| Prompt and tool changes saved in the transcript (0.86) | When an agent changes its prompt selection between batches, the change survives resume and keeps prompt caches warm | [3](phase-03-agent-layout-and-assets.md), [4](phase-04-core-prompt-and-capabilities.md) |
| `turn_end` and `agent_before_settle` returning `continue: true` (0.87) | Enforce rules like "update `notes.md` before ending a turn" with a hook instead of prompt text | [4](phase-04-core-prompt-and-capabilities.md) |
| Append-only context edits, such as `appendContextEdit(entryId, null)` (0.87) | Drop stale metadata or bulky tool output from future context without rewriting history. A cleaner `context-meta`. | [4](phase-04-core-prompt-and-capabilities.md) |
| Per-model compaction budgets; prompt-cache warming (0.86) | Cost control per role | [5](phase-05-subagents.md) |
| Virtual models (0.99, experimental) | Another way to route cost besides sub-agents. Evaluate before building custom routing. | [5](phase-05-subagents.md) |
| Built-in MCP, codemode and tool search (0.99) | Candidate capabilities. MCP OAuth tokens live in Pi's auth storage, which conflicts with keeping secrets outside the unit, so they wait for the broker. | [4](phase-04-core-prompt-and-capabilities.md), [10](phase-10-secrets-broker.md) |
| `ctx.modelRegistry.stream()` (0.86); classifier models (0.99) | Cheap model calls inside an extension, such as classifying an event in a handler | [7](phase-07-events-and-handlers.md) |
| Anthropic workload identity federation (0.99.2) | Fits the model proxy, where no long-lived key is needed | [10](phase-10-secrets-broker.md) |
| pi-durable submissions (experimental) | `queued → placed{entry} → done{answer} \| unanswered{reason}`, deduplicated by `requestId`. This is the same lifecycle as our queue rows plus receipts. Keep our row states mappable to it. | [Future](../future/pi-native-runtime.md) |

### Not adopted

- **Switching to the SDK.** See [phase 6](phase-06-agent-host-split.md#rpc-vs-sdk).
- **The experimental packages** (`pi-durable`, `pi-server`, `pi-protocol`, `pi-client`, `chord`). See [future plans](../future/pi-native-runtime.md).
- **Install telemetry and the pi.dev catalog refresh** stay at Pi's defaults (both were on in 0.84.4 too). Revisit with phase 10's egress proxy.

## Verification

Decided: a **manual checklist** rather than a committed smoke script. Phase 1 turns these scenarios into automated tests with a fake Pi. Record the results in the roadmap's Status cell.

1. `pnpm check` passes.
2. The runner starts the bundled `pi`: the log shows its path and version, and nothing on `PATH` is used.
3. Against a real model:
   - a prompt produces a `cognisphere.delivery` custom entry in the session file and marks its row `done`;
   - a second message steered mid-turn gets its own receipt and lands in the same batch;
   - a message steered just as the last turn ends still lands in the same Pi process (batch closes on `agent_settled`);
   - a second Pi process on the same thread adds no duplicate receipt entries;
   - abort mid-turn marks rows `cancelled`;
   - a session file written by 0.84.4 resumes and the model sees the current prompt;
   - a thread model override on a second provider works;
   - a forced provider error (bad base URL in a model override) is retried by Pi, then by the queue.
4. Extensions:
   - `bash-guard` blocks a guarded command;
   - `context-meta` adds checkpoint and usage lines;
   - `skill-update-notice` fires once.
5. Console: Anthropic, Codex (legacy) and ChatGPT sign-ins complete. Every shortlisted model resolves (`getBuiltinModel`).
6. Re-measure Pi spawn-to-ready time (about 0.5 s on 0.84.4).

## Done when

- `package.json` pins exactly 0.99.2, the runner spawns the bundled `pi`, bootstrap no longer installs Pi, and `pnpm check` passes.
- Batches finish on `agent_settled`. Receipts arrive as `entry_appended`, and `handled` dispositions mark rows done.
- Sign in with ChatGPT works from the console, and the shortlists contain only IDs present in 0.99.2.
- The checklist above is done and recorded.
- Docs updated:
  - `CLAUDE.md` §7 (one pin);
  - core.md: Pi start, completion on `agent_settled`, receipts, dispositions, the session-file system entries, and "the runner starts the `pi` command from `PATH`";
  - agents.md: extension behavior and the bootstrap steps;
  - [Pi modules](../pi-modules.md);
  - `home-template/scripts/setup-server.sh` PATH comments;
  - `CHANGELOG.md`;
  - the shipped README: the bootstrap/`PI_VERSION` line and the new sign-in providers.

## Open questions

All settled:

1. **Version pin:** exact `0.99.2`.
2. **Tests first?** No. Phase 0 goes first and is verified with a manual checklist. No committed smoke script.
3. **ChatGPT sign-in:** show it now, with the device-ID fix.
4. **Pi binary:** spawn the bundled `pi` from the dependency. One pin.
5. **Batch completion:** wait for `agent_settled` in this phase.
6. **Retries:** keep Pi's and the queue's retries, both at their defaults.
7. **Receipts:** move to `pi.appendEntry` and `entry_appended` in this phase. Adopt dispositions so `handled` input is marked done.
8. **Model shortlists:** refresh to 0.99.2.
