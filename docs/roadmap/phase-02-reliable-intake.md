# Phase 2: reliable intake

[Roadmap](../roadmap.md) · Previous: [Phase 1](phase-01-test-harness.md) · Next: [Phase 3](phase-03-agent-layout-and-assets.md)

## Requirement

- **Stopped or restarting agents:** a message sent to an agent that is stopped, restarting or reloading its settings must be saved, not dropped. Today `notify()` throws while the runner is down and the plugin context swallows the error (core known issue #1). GWS works around this with a 5-second delay.
- **Duplicates:** the same external event (a Telegram update, a Gmail message) delivered twice must create only one queue row.
- **Thread IDs:** thread IDs that would break folder layout (`/`, `..`) must be rejected before they are saved (core known issue #18).
- **Acknowledgements:** a plugin must advance its cursor or acknowledge the source only after the row is saved.

## Design

The per-agent SQLite queue is already durable. The only problem is that intake goes through the live runner. The fix:

1. **The queue DB opens with the agent, not the runner.** `notify()` inserts the row whenever the agent's folder exists, whether the runner is running, stopped or failed. The runner claims queued rows when it starts. (The old plan's separate ingress service is not needed.)
2. **`notify()` returns a receipt.** The type changes from `void` to `Promise<{ rowId, duplicate }>`. Plugins `await` it before acknowledging the source (Telegram offset, GWS history ID). If it throws, they don't acknowledge.
3. **Duplicates:** add an optional `sourceKey` to the notify payload (for example `telegram:<update_id>`) with a `UNIQUE(source_key)` index. A repeat insert returns the existing row with `duplicate: true`. Payload conflicts aren't checked: the first one wins.
4. **Thread IDs:** validate with the existing `isSafeId` rule inside `notify()`, then remove the separate route-level checks.
5. **Status:** the console already shows queued rows. A stopped agent's queued count becomes visible, which confirms the fix works.

## How this carries forward

Phase 6 moves the message queue into a separate agent unit. The "save even when stopped" guarantee then belongs to the coordinator's per-agent **outbox**, and `sourceKey` deduplication is reused by the unit's events table and by the handler `enqueue --key` option (phase 7). The work done here is not thrown away: the receipt-returning `notify()`, the `sourceKey` index and thread-ID validation all keep their meaning.

## Simplifications vs. old plan 1.4

- No outbox, no ingress service, and no "publication readiness" states. The queue insert is the durable acceptance.
- No payload digests for detecting changed content in duplicates. They can be added if a source ever reuses IDs.
- File attachments keep today's path. Plugins download to a temporary file and `rename()` it into place. A rename is atomic, so no workspace lock is needed.

## Done when

- A test: stop the agent, notify, start the agent, and the row runs.
- A test: notify the same `sourceKey` twice, and exactly one row exists.
- Telegram and GWS pass a `sourceKey` and await the receipt. The GWS 5-second workaround is removed.
- `POST /admin/:id/send` with the thread ID `../x` is rejected with 400.
- Docs updated: core.md (intake, known issues #1 and #18 marked Fixed), plugins.md (the `notify` contract), shipped README (plugin authoring).

## Open questions

1. Should rows be accepted for an agent that is disabled or deleted? Suggestion: reject when the agent folder doesn't exist; accept otherwise.
2. `notify()` becoming async is a breaking change for forked plugins in `harness/plugins/`. Should the old `void` signature be kept working, fire-and-forget with a warning, for one release?
