# Phase 13: session search

[Roadmap](../roadmap.md) · Previous: [Phase 12](phase-12-live-console.md) · Next: [Phase 14](phase-14-agent-self-review.md)

## Requirement

- **Operators** can search an agent's past conversations and jump to the matching message.
- **Agents** can search their own past conversations ("what did we decide about X last month?"). This is cheap long-term recall with no memory system.
- **Read-only:** Pi's session files are never modified.

## Design

- **In the unit:** the agent host answers a `search` request by streaming through `sessions/**/*.jsonl` line by line, using `readline` with no new dependency.
  - It matches user and assistant text, case-insensitively. It skips `role: "system"` entries, where Pi 0.86+ stores the system prompt (in full on the first request, then as patches), unless open question 3 decides otherwise.
  - It returns `{threadId, sessionFile, entryId, timestamp, role, snippet}` and stops at `limit`.
  - It skips an incomplete last line, which happens while Pi is still writing.
- **API and console:** `GET /api/agents/:id/search?q=&thread=&limit=` is forwarded to the unit. The console gets a search box, and clicking a result opens the thread at that entry.
- **Agent side:** a `session-history` capability script, `search-sessions "<query>"`, prints the top matches with thread and date.

**Dropped from the old plan:** fingerprints, watermarks and stable pagination. An index (for example SQLite FTS) is added only if a scan measurably takes more than about 1 s.

## Done when

- A known phrase returns the right thread and entry, and the console opens it.
- An agent answers a question about an earlier thread using `search-sessions`.
- Search never writes to `sessions/`, and 100 MB of sessions returns results within an agreed time.
- Docs: api.md, web.md, agents.md, shipped README.

## Open questions

1. Can sub-agents search all threads, or only their own?
2. Should tool calls and their output be included in the search?
3. Should the stored system prompt (role "system" entries) be searchable, for example to find when an instruction changed?
