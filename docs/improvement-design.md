# pi-harness_v2 — Improvement Design

Design notes for five subsystems, grounded in the current code and informed by hermes-agent.
Status: **design / options** — not yet implemented. Each section ends with concrete file-level changes.

File-path anchors used throughout:
- Runner / spawn / retry: `apps/server/src/runner.ts`
- Queue + schema: `apps/server/src/queue.ts`
- Agent lifecycle + plugin seeding: `apps/server/src/agent-manager.ts`
- Plugin contract: `apps/server/src/types.ts`, `apps/server/src/plugin-registry.ts`
- pi RPC bridge: `apps/server/src/rpc.ts`
- pi coding agent (the spawned binary): `temp/pi/packages/coding-agent/`

---

## 0. How the current data path actually works (anchor)

One trace, because every design below hooks into it:

```
plugin.start() ── ctx.notify(event,payload) ──► runner.notify()
   └─ INSERT events row (status=queued, thread_id via threadIdStrategy)
        └─ worker loop: dequeueBatch(threadId)  ── N queued rows → 1 prompt
             └─ resolve canonical sessionId for thread (threads table, immutable)
                  └─ spawnPi():  pi --mode rpc
                       --session <agentDir>/sessions/<threadId>/<sessionId>.jsonl
                       --system-prompt <assembled>  --tools read,bash,edit,...
                       --skill <agentDir>/skills  --extension <each agentDir/extensions/*>
                       --no-extensions --no-skills(?)  ← auto-discovery off; explicit paths on
                       └─ rpc.sendPrompt(promptText)
                            └─ race(agent_end, pi exit)
                                 ├─ agent_end first  → markBatchDone(ids, sessionId, entryIds)
                                 └─ pi exits first   → "[crash]" → markBatchFailed → retry/queue
```

Key invariants to remember:
- **The session file is stable per thread.** A retry re-opens the *same* JSONL, so pi sees all prior turns. `--continue` is not needed; the explicit path makes continuation implicit.
- **A batch = many rows → one user message.** `pi_entry_id`/`pi_session_id` are written back per row so you can link a queue row to its place in the JSONL.
- **Completion signal = the `agent_end` RPC frame.** Exit without `agent_end` = crash. `markBatchDone` additionally reads the last assistant entry and fails the batch if `stopReason === "error"`.

---

## 1. Memory management — options

### Current state
There is no memory subsystem. Each agent owns a `workspace/` (and `workspace/memory/`) directory it edits with the `write`/`edit` tools. That's durable and shared across threads, but: the agent must remember to read it, there's no recall-on-demand, no scoping by source/user, and nothing is injected automatically.

### What hermes does (for reference)
A `MemoryProvider` interface with a strict call schedule in the agent loop:
- `prefetch(query) -> str` **before** each LLM call → injected as a `<memory-context>` block.
- `sync_turn(user, assistant)` **after** each turn (non-blocking, backgrounded).
- `queue_prefetch(query)` post-turn to warm the next turn's recall.
- Lifecycle hooks: `on_session_switch`, `on_pre_compress`, `on_memory_write`, `on_session_end`.
- Pluggable backends (builtin markdown file, honcho, mem0, supermemory…), each choosing its own scope key (per-user vs per-session).

The crucial design lesson: **memory is two separate operations on a schedule — recall (read, pre-turn) and capture (write, post-turn) — and both must be cheap/async so they never block the turn.**

### Your three realistic options

| Option | What it is | Effort | Best when |
|---|---|---|---|
| **A. Markdown memory (Claude-Code style)** | `workspace/memory/*.md` files with a `MEMORY.md` index; recall = inject the index + relevant files; capture = a `remember` tool the agent calls | Low | You want legible, git-diffable, debuggable memory and full agent control |
| **B. SQLite + FTS5 memory** | A `memory` table per agent in the existing `.events.db` (or a sibling db); recall = FTS query on the user message; capture = auto-extract facts post-turn | Medium | You want automatic recall keyed by relevance/source/thread without the agent thinking about it |
| **C. External provider** | Wrap mem0 / honcho behind one interface | Medium-High (network, keys, cost) | You specifically want dialectic user-modeling and are OK with a dependency |

**Recommendation: A now, with the interface shaped so B/C drop in later.** Markdown matches pi's file-resident philosophy, is trivial to inspect, and the meta-agent in §3 can reorganize it. Add the SQLite layer (B) only once you feel recall friction.

### Where memory plugs into pi (this is the elegant part)

pi exposes the exact two hook points hermes uses, as **extension events** (`temp/pi/.../extensions/types.ts`):
- `pi.on("context", handler)` — fires **before the provider request**, lets you *inject* messages → this is `prefetch`.
- `pi.on("agent_end", handler)` — fires when a turn's agent loop ends, with the full message list → this is `sync_turn`.

So memory is a **pi extension**, not harness plumbing. It lives at `<agent>/extensions/memory/index.ts` and reads/writes `<agent>/workspace/memory/`.

### Sketch — markdown memory extension

```ts
// <agent>/extensions/memory/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MEM_DIR = join(process.cwd(), "workspace", "memory"); // pi cwd == agentDir
const INDEX = join(MEM_DIR, "MEMORY.md");

export default function (pi: ExtensionAPI) {
  // RECALL: inject the index (+ optionally fuzzy-matched files) before each provider call.
  pi.on("context", (event, _ctx) => {
    if (!existsSync(INDEX)) return;
    const index = readFileSync(INDEX, "utf8");
    // cheap: always inject the index; the agent pulls full files via `read` if needed
    return {
      messages: [
        ...event.messages,
        { role: "user", content: `<memory>\n${index}\n</memory>` },
      ],
    };
  });

  // CAPTURE: register a `remember` tool so the agent writes durable facts deliberately.
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Persist a durable fact/preference to long-term memory.",
    parameters: /* Type.Object({ slug, summary, body }) */ undefined as any,
    async execute(_id, p: any) {
      writeFileSync(join(MEM_DIR, `${p.slug}.md`), p.body);
      appendIndexLine(p.slug, p.summary); // maintain MEMORY.md
      return { content: [{ type: "text", text: `remembered: ${p.slug}` }] };
    },
  });
}
```

> Why a tool for capture instead of auto-extraction at first: deliberate writes keep memory high-signal and let the §3 meta-agent curate them. Auto-extraction (option B's `sync_turn`) can be added later as a second `agent_end` handler.

### Scoping by source/thread
Because the extension runs inside a per-thread pi process, `ctx` already knows the thread. For **shared** memory keep one `workspace/memory/`. For **per-thread** memory, namespace files under `workspace/memory/<threadId>/`. Cross-source identity (the "same human on Telegram + Gmail" case) is solved by keying memory on a stable user id you put into `payload.metadata` at `notify()` time and surface to the extension via the system prompt.

---

## 2. Session compaction as a customizable extension

### The good news
You do **not** need to port hermes's 2,000-line compressor. pi has **native compaction** (`temp/pi/.../core/compaction/compaction.ts`) that already runs by default:

```ts
DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }
```

and a **first-class extension hook** to fully customize it:

```ts
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;
  // preparation = { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary? }
  // return a custom CompactionResult, or return nothing to fall back to default,
  // or honor signal.aborted to cancel.
  return {
    compaction: {
      summary,                         // your structured summary
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { /* anything */ },
    },
  };
});
```

There's a ready example at `temp/pi/.../examples/extensions/custom-compaction.ts` that summarizes with a cheaper model (Gemini Flash) — exactly the pattern you want.

### Design: per-agent compaction extension, hermes-flavored

Drop `<agent>/extensions/compaction/index.ts`. It hooks `session_before_compact` and reimplements hermes's **structured summary** (the high-value part), using a cheap model:

1. **Prune tool output first** (cheap, no LLM): replace large `messagesToSummarize` tool results with one-line stubs (`[bash] npm test → exit 0, 47 lines`), dedupe identical results. This alone often drops 40-60% of tokens.
2. **Summarize the middle** with a small model into hermes's template — the sections that matter: `Active Task`, `Completed Actions`, `Active State`, `Blocked`, `Resolved Questions`, `Pending User Asks`, `Remaining Work`. (The "Active Task must survive" rule is the single most important line — it's what makes resume work.)
3. **Iterative update**: if `preparation.previousSummary` exists, prompt the model to *update* it (preserve + append), not re-summarize from scratch.
4. **Redact** secrets (`[REDACTED]`) before returning.

pi handles head/tail protection and the token threshold for you (`reserveTokens`/`keepRecentTokens`), so you skip hermes's entire boundary-walking phase.

### Making it customizable per agent
Two knobs, both clean:

- **The summary behavior** is just the extension file — edit `<agent>/extensions/compaction/index.ts` (or symlink a shared one). This is the "each agent has an extensions dir, here I can have a compaction extension" model you described — it already works.
- **The thresholds** (`reserveTokens`, `keepRecentTokens`, `enabled`) need to reach pi. Today the runner never sets them. Add an `agent.json` block and either:
  - pass them via RPC after spawn (`{type:"set_auto_compaction", enabled}` exists; for token budgets, prefer the next option), or
  - have the compaction extension read its own `<agent>/extensions/compaction/config.json` at load — **recommended**, keeps it self-contained and avoids touching the runner.

```jsonc
// agent.json (new, optional)
"compaction": { "enabled": true, "model": "google/gemini-2.0-flash", "keepRecentTokens": 20000 }
```

### Runner change required
Confirm the runner does **not** disable the hook. It currently passes `--no-extensions` (disables *auto-discovery*) but then explicitly passes `--extension <path>` for each dir under `<agent>/extensions/`, so an extension placed there **does** load. No runner change needed for compaction itself — only if you want to plumb thresholds via CLI (you don't, per above).

---

## 3. A self-improvement meta-agent ("the dreamer")

This is the most ambitious piece and the one where hermes's **curator** is the blueprint — but your framing is better suited to pi-harness because pi-harness is natively multi-agent. Instead of an in-process background thread (hermes), make the dreamer **its own agent** that the scheduler wakes, with filesystem access to a target agent's `sessions/` and `workspace/`.

### Architecture

```
scheduler plugin ──(cron: nightly / on idle)──► notify the "dreamer" agent
   dreamer agent (its own agent dir, own model)
     tools: read, bash, edit, write, grep, find, ls   (already pi built-ins)
     mounted view: read access to <target-agent>/sessions/, /workspace/, /skills/, /scripts/
     │
     ├─ 1. INGEST: parse target's sessions/*.jsonl since last run
     ├─ 2. ANALYZE: detect repeated tool sequences, recurring errors, dead skills,
     │              prompt friction, token-heavy patterns
     ├─ 3. PROPOSE: write a dream-report.md (findings + diffs)
     └─ 4. APPLY (gated): edit system_prompts/, scripts/, skills/, workspace/memory/;
                          archive dead skills; update docs
```

### What to steal from the curator, concretely

**a) The usage sidecar.** Maintain `<target-agent>/skills/.usage.json` exactly like hermes: per-skill `{ use_count, view_count, patch_count, last_activity_at, state, pinned, agent_created }`. You can populate `use_count` for free by grepping sessions JSONL for skill invocations (no runtime hook needed). The dreamer reads this to decide what's dead.

**b) The state machine** (pure, no LLM, runs first): `active → stale (30d idle) → archived (90d idle)`; reactivate on use; **never delete**, only move to `skills/.archive/`; **never touch pinned**. This is ~40 lines of deterministic code and prevents the LLM from doing anything destructive on the bulk of skills.

**c) The LLM review pass with the "umbrella" philosophy.** hermes's prompt is worth copying near-verbatim — its thesis is that *a library of class-level skills beats hundreds of narrow one-session skills*. The dreamer should consolidate `prefix-cluster` skills into umbrellas, demote narrow content to `references/`, and flag too-narrow names. Bound it: "if you end with <N changes you stopped too early."

**d) Dry-run by default.** hermes ships a `CURATOR_DRY_RUN_BANNER` that produces the same report but mutates nothing. Make the dreamer's first pass on any agent a dry run that emits `dream-report.md`; require a flag (or a human approval via the admin plugin) to flip to apply. This is your safety valve.

**e) Scheduling gates.** `interval_hours` (default weekly), `min_idle_hours` (don't run while the target is mid-task — check the target's queue for in-flight rows), and a persisted `.dream_state` with `last_run_at` + summary.

### Going beyond curator (your extra asks)
The curator only manages *skills*. You want prompts, scripts, docs, workspace, and error-avoidance too. Extend the analysis stage with these detectors, all computable from sessions JSONL:

- **Repeated step sequences** → propose a new skill or script that collapses them (reduce tokens + mistakes).
- **Recurring errors / tool failures** (`grep` for `isError:true`, error stop reasons) → propose a guardrail line in `system_prompts/` or a wrapper script.
- **High-token turns** → propose tighter prompts or a compaction tweak.
- **Workspace entropy** → reorganize `workspace/`, prune stale notes, rebuild `index.md`/`MEMORY.md`.
- **Doc drift** → update `system_prompts/` and skill `SKILL.md`s to match what the agent actually does.

### Why an agent, not a thread
Because it's just another pi-harness agent, you get for free: its own model (use a cheap one), its own session history (so *its* improvements are themselves auditable and dream-able), isolation, and you can run **one dreamer per target** or **one dreamer for the fleet**. It's the cleanest expression of "self-evolving" on this stack.

### Minimal first version
Don't build all detectors at once. v1 = scheduler → dreamer → (1) maintain `.usage.json` from sessions, (2) run the deterministic state machine, (3) write `dream-report.md` with the curator-style LLM pass in **dry-run**. Ship that, read its reports for a week, then enable apply + add detectors.

---

## 4. Cleaner deployment / folder layout

### Why it feels confusing today
There are three "homes" and one of them duplicates:

```
pi-harness_v2/                      ← the CODE (repo)
  apps/server/plugins/<id>/         ← plugin SOURCE (built-in) + seed/
PIHARNESS_ROOT_DIR (~/.piharness)/  ← the DATA root
  <harnessId>/                      ← "harness dir"  (default)
    .secrets/                       ← secrets, models, users
    plugins/<id>/                   ← user-space plugin SOURCE (optional)
    agents/<agentId>/
      agent.json, system_prompts/, workspace/, sessions/, skills/, scripts/, extensions/
      plugins/<id>/                 ← per-agent: config.json, state/, inbox/   (runtime state — fine)
      skills/<id>/, scripts/<id>/, system_prompts/N-<id>.md, extensions/<id>/  ← COPIED from plugin seed/ (the duplication)
```

The duplication is **plugin `seed/` files `rsync`-copied into every agent** on install (so the pi subprocess, which only reads its cwd, can see them). That copy is the smell you noticed.

### The fix: contribute by reference, not by copy
pi's `--skill <path>`, `--extension <path>` accept **arbitrary absolute paths**, and `--system-prompt` takes assembled text. So the runner can point pi at the plugin's *source* seed dirs directly and **assemble** plugin system-prompt fragments at spawn time. Nothing needs to be copied into the agent.

Change `spawnPi()` arg assembly to gather, for each *enabled* plugin on the agent:
- `--skill <pluginSrc>/seed/skills/<id>` (and the agent's own `skills/`)
- `--extension <pluginSrc>/seed/extensions/<id>/...`
- concat `<pluginSrc>/seed/system_prompt.md` into the assembled system prompt

Then the agent dir holds **only what is genuinely per-agent and mutable**:

```
agents/<agentId>/
  agent.json
  system_prompts/        ← agent-authored only (plugin prompts injected at spawn)
  workspace/             ← scratch + memory/
  sessions/              ← .events.db + <threadId>/<sessionId>.jsonl
  skills/agent/          ← agent-authored skills only
  scripts/agent/         ← agent-authored scripts only
  extensions/agent/      ← agent-authored extensions only (compaction/, memory/ live here or symlinked)
  plugins/<id>/          ← config.json, state/, inbox/   (instance state — stays)
```

Result: enabling/disabling a plugin is a config flip, not a file sync; upgrading a plugin updates one source dir, not N copies; an agent dir is small and obviously "just this agent."

### Naming, to kill the "pi-harness vs harness" confusion
- Call the data root explicitly: set `PIHARNESS_ROOT_DIR=~/.piharness` and refer to `<harnessId>` as the **deployment** (it *is* a named deployment: its own secrets, agents, timezone). Document "one harnessId = one isolated deployment."
- In docs and the UI, use **deployment → agents → (plugins as capabilities)**. Drop "harness dir" from user-facing language.

### Migration note
This is a behavioral change to `spawnPi()` + the install flow, and it's backward-compatible: keep reading already-copied seed files if present, but stop copying on new installs. Provide a one-shot `prune-seed-copies` script that removes copied seed files once the by-reference path is live. **This touches the spawn path — do it behind a flag and test against one agent first.**

---

## 5. Smart retries

### Current behavior (the problem, precisely)
`queue.ts::markBatchFailed`: on failure, `attempts++`; if `< maxAttempts` set row back to `status='queued'`, else `'failed'`. On the next dequeue the worker re-sends the **original `text`** (with a `Retry: true` metadata flag prepended). But the per-thread session JSONL already contains the half-finished work — so the agent receives the *whole task again* as a fresh turn on top of a session that already did half of it. Wasteful and error-prone.

Also:
- Failed rows accumulate as `status='failed'` forever (your "remove rows with error").
- Crash detection exists (`exit without agent_end → "[crash]"`, swept on restart via `sweepInFlight`), but **"pi exited cleanly yet the task wasn't actually done"** is not detected.

### Design

**5.1 Continuation instead of replay.** When `attempts > 0` (a retry), don't re-send the original prompt. Inspect the session first, then choose the prompt:

```ts
// in processBatch, before building promptText
const prior = inspectSession(sessionFile); // { userTurns, lastAssistant, lastStopReason, looksComplete }
let promptText: string;
if (batch.every(m => m.attempts > 0) && prior.userTurns > preBatchUserCount) {
  // the original ask is already in the session and work began → nudge, don't replay
  promptText = CONTINUE_NUDGE; // see below
} else {
  promptText = batch.map(m => `${buildHarnessMetadata(m, tz)}\n${m.text}`).join("\n\n");
}
```

```
CONTINUE_NUDGE =
  "<harness-metadata>Retry: true</harness-metadata>\n" +
  "Your previous run on this task was interrupted before signaling completion. " +
  "Do NOT restart from scratch. Review what you already did in this session, " +
  "verify the current state, and continue from where you left off until the task is done.";
```

Because the session file is stable, the nudge lands in full context. This is the single highest-value change in this section.

**5.2 Completion validation ("was it actually finished?").** You already read the last assistant entry in `markBatchDone`. Harden it into a small validator run on every clean `agent_end`:

- **Hard signals (cheap):** `stopReason === "error"` → not done (already handled). Last assistant message empty, or ends with an unresolved tool_call, or `agent_end` arrived but the final entry is a tool_result with `isError:true` → not done.
- **Soft signal (optional, costs a call):** a tiny "done?" check — either a convention (agent must end with a `DONE:`/`BLOCKED:` line you grep for) or a one-shot cheap-model judge over the last assistant message + original ask. Prefer the **convention** first (free, deterministic); add the judge only if needed.

If validation says "not done," route the batch through the same retry path as a crash (so 5.1's continuation kicks in) rather than marking it done.

**5.3 Detecting silent kills.** `exit without agent_end` is already `[crash]`. Add: capture last-N stderr (already done via `stderrSnapshot()`), and on restart `sweepInFlight` already re-queues `in_flight` rows. Add a **per-event "last assistant message" surface** so you can eyeball it: store the last assistant text snippet on the row.

```sql
ALTER TABLE events ADD COLUMN last_assistant TEXT;   -- snippet of final assistant entry
ALTER TABLE events ADD COLUMN completion TEXT;        -- 'agent_end' | 'crash' | 'incomplete' | 'error'
```

Write these in `markBatchDone`/`markBatchFailed` from the session inspection. Now the UI can show, per event, *how* the run ended and *what pi last said* — exactly your "validate if the pi process was closed after task was finished."

**5.4 Error-row hygiene ("remove rows with error").** Two complementary moves:
- **Don't let errored content pollute the next batch:** since continuation (5.1) relies on the session, not the queue text, retried rows shouldn't be re-concatenated as fresh asks. After a successful continuation, mark the original rows `done` (they're satisfied by the resumed session), not re-queued.
- **Prune terminal rows:** add `pruneEvents({ status: ['failed','done'], olderThanDays })` and either run it from the scheduler or expose a UI action. Keep `failed` rows for a grace window (debugging) then archive/delete. Don't auto-delete `failed` instantly — you'll want them while tuning.

**5.5 Backoff.** Today retries are immediate. Add simple backoff: on requeue, set a `not_before = now + base*2^attempts` column and have `dequeueBatch` skip rows whose `not_before` is in the future. Prevents a hard-failing task from hot-looping the model.

### Retry decision table

| Situation | Detect | Action |
|---|---|---|
| Clean `agent_end`, validator OK | `completion='agent_end'`, convention/judge pass | `markBatchDone` |
| Clean `agent_end`, validator fails | last msg empty / `DONE:` absent / trailing error | treat as incomplete → continuation retry |
| Exit without `agent_end` | race won by `waitExit` | `[crash]` → continuation retry |
| `stopReason='error'` | read final entry | `[error]` → retry (replay if no progress, else continue) |
| Max attempts hit | `attempts >= maxAttempts` | `failed` + record `last_assistant` for inspection |
| Stuck `in_flight` after restart | `sweepInFlight` | re-queue as continuation |

---

## Cross-cutting: what to take from hermes, and what to leave

| Take | Leave |
|---|---|
| MemoryProvider's **two-phase schedule** (prefetch pre-turn, sync post-turn) | hermes's 8 backends + honcho dialectic machinery |
| Compaction's **structured summary template** + tool-output pruning + iterative-update | hermes's head/tail boundary walker (pi does this) |
| Curator's **usage sidecar, state machine, dry-run, umbrella prompt** | hermes's in-process threading model (use a scheduled agent instead) |
| Cron's lesson that scheduled work needs explicit context | hermes's *separate* ephemeral cron session (in pi, feed an existing thread) |
| Continuation-by-stable-session on retry | hermes's synchronous delegate model |

## Suggested build order

1. **§5.1 continuation retry** — small, isolated, highest immediate value; no schema churn beyond optional columns.
2. **§5.3/5.4 completion columns + error hygiene** — makes failures legible; unblocks tuning everything else.
3. **§2 compaction extension** — self-contained, per-agent, uses native pi hook.
4. **§1 markdown memory extension** — self-contained, same extension mechanism.
5. **§4 by-reference plugin layout** — behavioral change to spawn; do behind a flag after the above are stable.
6. **§3 dreamer meta-agent** — build on top once memory + usage data + clean layout exist; start dry-run only.

Each of 1–4 is independently shippable and reversible. 5 and 6 are the larger bets — sequence them last.
