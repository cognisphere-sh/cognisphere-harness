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
- [Core roadmap](docs/roadmap.md) is the sole delivery/status index. Each item links its own low-level plan under `docs/plans/`; proposed interfaces remain labeled planned until implemented.
- [Shipped app-home reference](packages/harness/home-template/docs/base-harness/) is user-facing documentation copied into every app home. This repository owns that reference; homes treat their copies as read-only.

Update the owning layer document when behavior changes, and every affected layer when a change crosses contracts. Update the high-level design when boundaries or major dependencies change. A layout change updates agents, core persistence, and API/CLI sections where applicable. User-visible CLI, plugin, secrets/model, template, or agent behavior also requires updating the shipped app-home reference.

Keep one authoritative explanation per concern. Do not add competing system/server/deployment guides or a root roadmap alias. Record implementation evidence and remaining limitations in `docs/roadmap.md`; keep detailed algorithms and validation scenarios in the corresponding plan. Fix stale local links when moving or replacing documents.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
