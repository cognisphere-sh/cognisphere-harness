# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Resolve All Lint & Type Errors Before Declaring Done

**After every change, run `pnpm check` and resolve every error and warning.**

- This is a pnpm workspace (`packages/harness`, `packages/web`). The single entrypoint is `pnpm check` (root) — it runs `pnpm -r run check`, i.e. typecheck + lint for both packages. A task is not complete while it reports anything.
- Warnings count. Fix them, or if intentional, suppress with a targeted `// eslint-disable-next-line <rule>` plus a one-line reason.
- Don't silently expand a pre-existing breakage. If the check was already failing before your change, fix it or call it out.
- Auto-fix first (`pnpm -r run lint:fix`), then hand-fix what remains.

## 6. Keep the Docs in Sync

**Project docs are part of the surface area. Update them with the code.**

- [High-level design](docs/high-level-design.md) owns system boundaries, layer interactions, and cross-cutting design choices.
- [Core low-level design](docs/low-level/core.md) owns lifecycle, queue/routing, execution, recovery, stores, and server configuration.
- [Plugins low-level design](docs/low-level/plugins.md) owns plugin contracts, discovery, seeds, listeners/actions, and failure behavior.
- [Agents low-level design](docs/low-level/agents.md) owns agent templates, configuration, file layout, prompts, skills, scripts, and Pi extensions.
- [API low-level design](docs/low-level/api.md) owns auth, route wiring, request/response/error contracts, settings reload behavior, and filesystem/session access.
- [CLI low-level design](docs/low-level/cli.md) owns scaffolding, process supervision, packaging, app-home deployment scripts, and upgrades.
- [Web low-level design](docs/low-level/web.md) owns console routes, query/mutation state, chat rendering, files/settings, and API integration.
- [Roadmap](docs/roadmap.md) is the sole delivery/status index. Each phase has its own file under `docs/roadmap/` (requirement, design, open questions, done-when checks); proposed interfaces remain labeled planned until implemented.
- [Future plans](docs/future/) holds unscheduled ideas that wait on outside work; an idea moves into the roadmap when picked up. It is not a status tracker.
- [Pi modules](docs/pi-modules.md) explains the Pi monorepo packages and which ones the harness uses; refresh it when the pinned Pi version changes.
- [Shipped app-home reference](packages/harness/home-template/docs/base-harness/) is user-facing documentation copied into every app home. This repository owns that reference; homes treat their copies as read-only.

Update the owning layer document when behavior changes, and every affected layer when a change crosses contracts. Update the high-level design when boundaries or major dependencies change. A layout change updates agents, core persistence, and API/CLI sections where applicable. User-visible CLI, plugin, secrets/model, template, or agent behavior also requires updating the shipped app-home reference.

Keep one authoritative explanation per concern. Do not add competing system/server/deployment guides or a root roadmap alias. Record implementation evidence and remaining limitations in `docs/roadmap.md`; keep detailed designs and validation scenarios in the corresponding phase file under `docs/roadmap/`. Fix stale local links when moving or replacing documents.

## 7. Building Roadmap Phases

**Work one phase at a time, in order, from its phase file.**

- Before coding, read `docs/roadmap.md` (target architecture, decisions, terms) and the phase file. Each phase file has the requirement, design, open questions and done-when checks.
- **Open questions are undecided.** Ask the user to settle the ones that affect your work before implementing. Don't pick silently, and record each answer in the phase file.
- Phases build on earlier ones and must leave the system working. Don't start phase N+1's work inside phase N. If a later phase's design blocks you, raise it.
- "Done when" is the acceptance test. When a phase lands:
  - set its **Status** cell in `docs/roadmap.md` with evidence (commit or PR, what was verified);
  - rewrite the affected layer docs and the HLD from "planned" to "current";
  - update the shipped app-home reference for user-visible changes.
- Once phase 1 adds `pnpm test`, run it together with `pnpm check` after every change.

**Decisions to respect** (reasons in `docs/roadmap.md` and the phase files; change them only with the user):

- **Coordinator and units:** the coordinator runs no agent code. Each agent is one unit: a process now, one container per agent later. A unit runs one active turn at a time and owns its message queue. The coordinator talks to units only through the unit protocol (phase 6) and never reads unit files directly.
- **Pi runs in RPC mode,** not the SDK, as a child process inside the unit ([evaluation](docs/roadmap/phase-06-agent-host-split.md#rpc-vs-sdk)). Launch it with explicit resources (`--no-extensions`, `--no-skills` plus one `--skill` per skill, `--system-prompt`, `--tools`, `--no-context-files`), never with discovery.
- **Agent files:** `assets/base/` is read-only. Agent-made assets get new names (no shadowing). `agent.json` selects and orders prompts, skills and handlers for each role. `assets.json` records what, why and what each asset replaces. Agents change the selection only through the harness, which may change only the selection fields.
- **Triggers:** every trigger enters through the coordinator as an event. Agent-owned handlers turn events into queue messages.
- **Secrets:** from phase 10, no real credential enters a unit. Units get placeholders, and the coordinator's egress proxy injects the real values.
- **Storage:** all agent state goes through `AgentStorage`. Don't hard-code agent paths outside it.
- **Experimental Pi packages:** don't add `pi-durable`, `pi-protocol`, `pi-client`, `pi-server` or `chord` to shipped code without a roadmap phase. See `docs/future/`.

**Pi extensions first.** Build new agent-side features as Pi extensions (TypeScript modules loaded with `--extension`), packaged as capabilities so each agent opts in. Examples: memory, a skill selector, context trimming, notes enforcement, tool guards, delivery receipts. Extensions can:

- hook `context`, `context_with_system`, `before_agent_start`, `turn_end`, `agent_before_settle`, `tool_call` and `tool_result`;
- register tools;
- persist data with `pi.appendEntry()`;
- edit the model's context with append-only context edits.

They run inside the unit, work in RPC mode and upgrade along with Pi. Change the runner, queue or coordinator only when the feature needs something an extension can't reach: other threads, the message queue, coordinator state, secrets or lifecycle. Then say why in the phase file. Keep extensions small, and type-check them against the pinned Pi version. Their behavior is documented in [agents](docs/low-level/agents.md).

**Pi version.** Pin Pi to one exact version in the `packages/harness/package.json` dependencies (`pi-coding-agent` and `pi-ai`). The runner spawns that package's bundled `pi`, so there is no global binary to keep in sync. When upgrading:

1. read Pi's `CHANGELOG.md` breaking changes since the pinned version;
2. re-run the phase 0 verification checklist and the tests, and re-check the model shortlists in `core/models-catalog.ts`;
3. refresh [Pi modules](docs/pi-modules.md).

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
