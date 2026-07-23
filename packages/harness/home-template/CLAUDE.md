# CLAUDE.md

Engineering guidelines for this app home. They apply to any coding agent
working here — Claude Code, the resident developer agent, or a human.
(`AGENT.md` is an identical copy for tools that read that name.)

**Tradeoff:** These guidelines bias toward caution over speed. For trivial
tasks, use judgment.

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

Strong success criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.

## 5. Verify Before Declaring Done

- Run the checks this workspace has: the app's own lint/typecheck/build
  scripts (`app/package.json`), and for harness-side changes a server
  restart that comes up clean (agents `running`, no `failed` plugins).
- A task is not complete while any of these report errors.

## 6. Boundaries

- **Never modify `node_modules/@cognisphere-sh/cognisphere-harness`** — the
  harness library is an installed, versioned dependency. Change requests that
  need new harness capability go upstream; version bumps go through the
  `cognisphere-upgrade` skill (`.claude/skills/`).
- **Never commit `.secrets/`** or session data (both gitignored — keep it
  that way). Never print secret values.

## 7. Keep the Docs in Sync

**`docs/` is part of the surface area. Update it with the code — after every
code change, in the same piece of work.**

- [`docs/harness/`](docs/harness/) — this deployment's harness: each agent
  (purpose, prompts, plugins, secrets) and each user-space plugin. Update on
  any change under `harness/`.
- [`docs/app/`](docs/app/) — the user-facing app: structure, routes, how it
  talks to the harness. Update on any change under `app/`.
- [`docs/base-harness/`](docs/base-harness/) — reference docs for the
  installed harness library (usage, CLI, changelog, skills). **Read-only
  here** — owned upstream, refreshed by the upgrade skill. Do not edit.

If a change is large enough to need a new section, add one. If a section
becomes wrong, fix it in the same diff — stale docs are worse than missing
docs.
