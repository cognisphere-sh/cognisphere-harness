# Phase 1: test harness

[Roadmap](../roadmap.md) · Previous: [Phase 0](phase-00-pi-upgrade.md) · Next: [Phase 2](phase-02-reliable-intake.md)

## Requirement

Before we change the runner, queue or launch path, we need an automated way to prove they still behave. Today `pnpm check` only type-checks and lints. Nothing tests retries, steering, delivery receipts or reloads (core known issue #16).

## Design

Two kinds of test, both run by `pnpm test`.

### Fake-Pi tests (always run, offline)

- **Fake Pi** (`packages/harness/test/fake-pi.ts`) is a small Node script that speaks the same RPC JSON lines as `pi --mode rpc`:
  - it reads `prompt`, `steer` and `abort` frames;
  - it writes responses with dispositions, plus `agent_end`, `agent_settled` and `entry_appended`;
  - it saves user and assistant entries to the `--session` file, like Pi.

  It follows a per-test **script** instead of calling a model. The script says when to save input, how the turn ends (`stop`, `error`, Pi retry), whether to crash, hang or exit early, and how to answer steers. Each spawn of the same test can follow a different script, so retries can be tested.
- **Real receipts extension:** the fake loads `core/pi-delivery-receipts.ts` and drives it through a small stand-in extension API (`on`, `appendEntry`, `sessionManager.getEntries`). EventId parsing, the duplicate guard on respawn and the `entry_appended` path are therefore tested for real.
- **How the runner reaches it:** a test-only runner option `piCommand?: string[]`. It's the command the runner starts, with Pi's arguments appended; by default it's the bundled `pi`. There is no environment variable for it, so operators can't run another Pi by accident (phase 0's one-pin rule).
- **Assertions:** each test builds one `AgentRunner` with a real SQLite queue in a temporary harness root, then checks row status, attempts, error tags and `pi_entry_id`. It also checks what the fake received (it logs every frame) and the session file.

### Real-Pi tests (opt-in)

- `packages/harness/test/real-pi.test.ts` runs the same runner against the bundled `pi` and a real model:
  - one message gets a receipt and is `done`;
  - a mid-turn steer lands in the same batch;
  - abort marks the row `cancelled`.
- **Configuration:** `PI_TEST_PROVIDER`, `PI_TEST_MODEL` and `PI_TEST_API_KEY`.
  - Missing values are read from `packages/harness/.env.test` (gitignored, 0600).
  - If still missing and `pnpm test` runs in a terminal, it asks for them (the key isn't echoed) and saves the answers to `.env.test`.
  - If they're left blank, or there's no terminal (CI), the LLM tests are skipped and the rest still run.
- The key is passed to Pi as the provider's environment variable from the model catalog. Pi's config folder is a temporary directory, so `~/.pi/agent` and any harness's `.secrets/pi/` are never touched.

### Running

- `pnpm test` (root) runs `packages/harness/scripts/test.mjs`. It loads or asks for the real-Pi settings, then runs `node --import tsx --test test/*.test.ts`. The tests use `node:test` (built in, no new dependency).
- Test files are type-checked and linted by `pnpm check`. CLAUDE.md requires both commands after every change.

## Scenarios

| Scenario | Expectation |
|---|---|
| One message, one reply | The row is `done`, and `pi_entry_id` comes from the receipt. |
| Message arrives mid-turn | It steers into the active batch. A `doNotSteer` message waits for the next batch. |
| Pi crashes after saving the input | The row is retried as a continuation nudge (`Continuation: true`), not a resend. |
| Pi crashes before saving the input | The row is resent (`Retry: true`). |
| Attempts exhausted | The row is `failed`, and other rows are unaffected. |
| Two threads, `maxConcurrentSlots: 1` | They run one after another. |
| Stop mid-turn | Documents today's behavior: the attempt counts (core known issue #5). The test becomes the regression check when #5 is fixed. |
| Pi retries an error itself (phase 0) | `agent_end` with `willRetry`, then success, then `agent_settled` → `done`. |
| Pi exits after `agent_end` but before `agent_settled` | Failed as `[crash]`. |
| Extension `handled` a prompt or steer (phase 0) | Those rows are `done` without a receipt. |
| Second Pi process on the same session | No duplicate receipts for entries already in the file. |

## Done when

- `pnpm test` runs the fake-Pi scenarios in a few seconds with no network or real model.
- With a provider, model and key configured, the real-Pi tests pass. Without them they are skipped, not failed.
- A deliberately broken receipt handler makes at least one test fail.
- CLAUDE.md's "run `pnpm test` with `pnpm check`" rule applies.

## Implementation summary

| Piece | Where |
|---|---|
| Test-only runner option `piCommand` | `src/core/runner.ts` |
| Fake Pi: scripted steps, per-thread scripts, frame log, real receipts extension through a stand-in API | `test/fake-pi.ts` |
| Test rig: temporary harness root, real SQLite queue, wait helpers | `test/helpers.ts` |
| 14 fake-Pi scenarios (the table above, plus abort) | `test/runner.test.ts` |
| 3 real-Pi tests: receipt and `done`, mid-turn steer, abort | `test/real-pi.test.ts` |
| `pnpm test`: settings from env, `.env.test` or a terminal prompt, then `node --import tsx --test` | `scripts/test.mjs`, root and package `package.json` |
| Tests type-checked and linted by `pnpm check` | `tsconfig.json`, `eslint.config.js` |

**Verified:**
- `pnpm test` passes 14 fake-Pi scenarios in about 3 s; without settings or a terminal, the 3 real-Pi tests are skipped and nothing is written.
- With OpenRouter `google/gemini-3.5-flash-lite`, all 17 tests pass, and `~/.pi/agent` is unchanged (real Pi uses a temporary config folder).
- Deliberate breakages each caught:

  | Breakage | Tests failing |
  |---|---|
  | The runner ignores receipts | 12 |
  | The extension's duplicate guard removed | The duplicate-receipt test |
  | `handled` treated as normal input | Both handled tests |
  | Batches finish on `agent_end` again | The Pi-retry and exit-before-settle tests |

**Not verified here:** the terminal prompt and saving `.env.test`, which needs an interactive terminal.

### Execution log

1. **Plan review.** This file predated phase 0, so its scenarios still ended batches at `agent_end` and missed Pi's own retries, `handled` input and `entry_appended` receipts. Those scenarios were added before any code was written.
2. **Decisions.** The user settled the [open questions](#open-questions): a `piCommand` runner option, the real receipts extension inside the fake, and opt-in real-Pi tests whose settings are asked for once and saved to a gitignored file. The planning session kept out of the files listed below.
3. **Implementation.** In order: the runner option, the fake Pi, the test rig, the scenario tests, the real-Pi tests, `pnpm test`, then wiring tests into `pnpm check`.
4. **First run:** all 14 scenarios passed in about 2.4 s.
5. **Proving the tests catch bugs.** Each deliberate breakage was applied, run, and reverted:
   - The first breakage hung the run instead of failing, because the stop test had no `finally` and left a runner and a fake Pi alive. Fixed: every test cleans up in `finally`, and `pnpm test` adds a per-test timeout and a forced exit.
   - Finishing batches on `agent_end` at first slipped past the Pi-retry test, because the fake sent both `agent_end` events back to back. A 200 ms pause now stands in for Pi's retry backoff, so the test catches it.
6. **Real-Pi run:** with OpenRouter `google/gemini-3.5-flash-lite` given only as environment variables, so nothing was saved, all 17 tests passed. `~/.pi/agent` was unchanged.
7. **Docs:**
   - `CLAUDE.md` now requires `pnpm check` and `pnpm test`;
   - core.md marks known issue #16 fixed and explains how to run the tests;
   - the HLD's "how do I test" answer is updated;
   - the roadmap marks this phase done.

### Changes by file

| File | Change |
|---|---|
| `packages/harness/src/core/runner.ts` | `RunnerOpts.piCommand?: string[]` (test-only): the command started instead of the bundled `pi`, with Pi's arguments appended. No runtime behavior change otherwise. |
| `packages/harness/test/fake-pi.ts` (new, 187 lines) | Fake `pi --mode rpc`. Steps: `ack`, `save`, `end`, `settle`, `waitSteers`, `sleep`, `exit`, `hang`. Supports per-thread scripts and per-spawn runs, writes Pi-format session entries, and logs frames with start/end markers. Loads the real receipts extension through a stand-in API. Runs with Node's built-in type stripping. |
| `packages/harness/test/helpers.ts` (new) | `rig()`: temporary harness root, one agent, real `AgentDb`, a runner on the fake (or real) Pi, plus `send`, `row`, `waitFor`, `waitAllSettled`, `log` and `sessionEntries` helpers |
| `packages/harness/test/runner.test.ts` (new) | 14 fake-Pi scenarios |
| `packages/harness/test/real-pi.test.ts` (new) | 3 real-Pi tests. The provider's key is passed through its catalog environment variable, and Pi's config folder is temporary. Skipped with a reason when settings are missing. |
| `packages/harness/scripts/test.mjs` (new) | Loads `PI_TEST_*` from the environment or `.env.test`, or asks once in a terminal (hidden key) and saves to `.env.test` (0600). Then runs `node --import tsx --test --test-timeout=200000 --test-force-exit test/*.test.ts`. |
| `package.json` (root), `packages/harness/package.json` | `test` scripts; package `check` lints `test/` too |
| `packages/harness/tsconfig.json`, `eslint.config.js` | `test/**/*.ts` type-checked and linted |
| `.gitignore` | `.env.test` |
| `CLAUDE.md`, `docs/low-level/core.md`, `docs/high-level-design.md`, `docs/roadmap.md`, this file | Test rule, known issue #16 fixed, how to run tests, status, this summary |

## Open questions

All settled:

1. **Command override:** a test-only runner option (`piCommand`), not a `PI_BIN` environment variable.
2. **Real-Pi tests:** yes. Provider, model and key come from `PI_TEST_*` variables or `.env.test`, are asked for in a terminal and saved; otherwise the LLM tests are skipped.
3. **Receipts in the fake:** run the real receipts extension through a stand-in extension API.

## Out of scope

Web UI tests, and plugin-specific tests (added in the phase that changes each plugin).
