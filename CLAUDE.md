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

**After every change, run `npm run check` and resolve every error and warning.**

- A task is not complete while `npm run typecheck`, `npm run typecheck:web`, `npm run lint`, or `npm run lint:web` reports anything. The single entrypoint is `npm run check` (root) — it runs all four.
- Warnings count. Fix them, or if intentional, suppress with a targeted `// eslint-disable-next-line <rule>` plus a one-line reason.
- Don't silently expand a pre-existing breakage. If the check was already failing before your change, fix it or call it out.
- Auto-fix first (`npm run lint:fix`, `npm run lint:web:fix`), then hand-fix what remains.

## 6. Keep the Docs in Sync

**Project docs are part of the surface area. Update them with the code.**

- [`docs/server.md`](docs/server.md) — agent-runner subsystem: process model, on-disk layout, components (`agent-manager`, `runner`, `queue`, `rpc`, `plugin-registry`, `secrets`, `models-store`, `models-catalog`, `types`, `config`, `logger`), key flows, design decisions.
- [`docs/api.md`](docs/api.md) — HTTP surface: auth model, every route under `/healthz`, `/api/*`, `/admin/*`, `/webhook/*`, request/response shapes, error codes, conventions.

**When to update which doc:**

- Touching `apps/server/src/agent-manager.ts`, `runner.ts`, `queue.ts`, `rpc.ts`, `plugin-registry.ts`, `secrets.ts`, `models-*.ts`, `types.ts`, `config.ts`, `logger.ts`, or built-in plugin runtime contracts → update `docs/server.md`.
- Touching anything under `apps/server/src/api/` or `apps/server/src/main.ts`'s route wiring → update `docs/api.md`.
- Changes that span both (e.g. a new lifecycle method exposed via a new HTTP route) → update both.
- On-disk layout changes (file names, secrets shape, models.json shape, agent dir structure) → update `docs/server.md` §3 and the relevant section in `docs/api.md` if it's reachable over HTTP.

If the change is large enough to need a new section, add one. If a section becomes wrong, fix it in the same diff — stale docs are worse than missing docs.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
