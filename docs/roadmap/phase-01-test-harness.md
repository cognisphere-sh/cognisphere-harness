# Phase 1: test harness

[Roadmap](../roadmap.md) · Previous: [Phase 0](phase-00-pi-upgrade.md) · Next: [Phase 2](phase-02-reliable-intake.md)

## Requirement

Before we change the runner, queue or launch path, we need an automated way to prove they still behave. Today `pnpm check` only type-checks and lints. Nothing tests retries, steering, delivery receipts or reloads (core known issue #16).

## Design

- **Fake Pi.** A tiny Node script that speaks the same RPC JSON lines `pi --mode rpc` speaks. The runner starts it through a test-only command override. A scenario file drives it: accept the prompt, emit a delivery receipt, stream a reply, crash, hang, and so on.
- **Tests** use `node:test` (built in, no new dependency) and run against a temporary harness root. Each test builds one `AgentRunner` with a real SQLite queue.
- **`pnpm test`** is added next to `pnpm check`. CLAUDE.md later requires both.

## Scenarios to cover first

| Scenario | Expectation |
|---|---|
| One message, one reply | The row reaches `done`, and `pi_entry_id` is set from the receipt. |
| Message arrives mid-turn | It steers into the active batch (or queues, if `doNotSteer`). |
| Pi crashes after receiving input | The row is retried, and the continuation nudge is used instead of a resend. |
| Pi crashes before the receipt | The row is resent. |
| Attempts exhausted | The row is `failed`, and other rows are unaffected. |
| Two threads, `maxConcurrentSlots: 1` | They run one after another. |
| Stop / restart mid-turn | Documents current behavior, including known issue #5. The test becomes the regression check when #5 is fixed. |

## Done when

- `pnpm test` runs these scenarios in a few seconds with no network or real model.
- A deliberately broken receipt handler makes at least one test fail.

## Open questions

1. Where does the command override live: a `PI_BIN` environment variable, or a runner option used only by tests?
2. Should one real-Pi smoke test (behind an environment flag, with a real model key) also exist for release checks?

## Out of scope

Web UI tests, and plugin-specific tests (added in the phase that changes each plugin).
