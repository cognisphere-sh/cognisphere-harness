# Phase 12: live console

[Roadmap](../roadmap.md) · Previous: [Phase 11](phase-11-juicefs-and-checkpoints.md) · Next: [Phase 13](phase-13-session-search.md)

## Requirement

In the web console, replies appear as they're written, and status changes show up at once. Today the console polls. A dropped connection never loses or duplicates anything, because saved history stays the source of truth.

## Design

- **From the unit:** the agent host forwards Pi RPC events (text deltas, tool start and end, saved-entry receipts) and queue state changes to the coordinator over the phase 6 WebSocket, as `stream` frames. They're held in memory only. Skip `role: "system"` messages, which Pi 0.99 includes in `agent_end.messages` and in session history, so the system prompt never appears as a chat bubble.
- **Endpoint:** `GET /api/agents/:id/threads/:threadId/stream` uses Server-Sent Events, with today's cookie or bearer auth. It sends `row`, `delta`, `tool`, `entry` and `ping` events.
- **In the web client:**
  - Deltas build a temporary bubble.
  - On `entry`, the client refetches history over REST, which replaces the temporary bubble.
  - On reconnect, it refetches once. There is no replay log.
  - If the stream is unavailable, it polls as today.
- **Slow clients:** a client that falls behind a fixed buffer is disconnected and refetches.

**Dropped from the old plan:** the durable event log, cursors and `Last-Event-ID` replay, and audience scoping for product users. Product-app streaming is a separate later decision.

## Done when

- Text streams during a turn, and the final message appears exactly once.
- Killing and restoring the connection mid-turn shows correct history with no duplicates.
- With the stream disabled, polling still works.
- Docs: api.md, web.md.

## Open questions

1. Should there be one stream per thread (simplest), or one per agent page?
2. Does the frontend app (`app/`) need streaming for its users in this phase?
