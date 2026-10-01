# Phase 11: JuiceFS and checkpoints

[Roadmap](../roadmap.md) · Previous: [Phase 10](phase-10-secrets-broker.md) · Next: [Phase 12](phase-12-live-console.md)

## Requirement

- **Multi-machine storage:** agent state and shared folders live on storage that works across machines, so units on different hosts (phase 15) can use the same agent state and shared spaces.
- **Checkpoints:** an agent's state can be checkpointed automatically and restored to a previous point.

## Design

### `JuiceFsStorage`, a second `AgentStorage` backend

- **What JuiceFS is:** a POSIX file system on S3-compatible storage (S3, R2, MinIO), with Redis, Postgres or SQLite holding metadata. It supports appends, renames and locks, which Pi's JSONL and SQLite need.
- **Mounting:** each host mounts the file system once, at `/mnt/cognisphere`. `mounts()` returns only that agent's folders and its granted shared spaces, so containers need no FUSE privileges, and access follows which folders are mounted.
- **Capabilities:** `{ checkpoints: true, multiHost: true }`.

### Checkpoints

**Config:**

```json
"checkpoints": { "afterEveryBatch": true, "everyHours": 6, "keep": { "recent": 20, "daily": 14 } }
```

- **Timing:** checkpoints are taken only when the unit is **idle**, between batches. The agent host signals idle to the coordinator, which calls `storage.checkpoint()`.
- **JuiceFS:** uses `juicefs clone`, an instant copy-on-write copy of the agent's state folder, so a checkpoint takes about a second even after every batch.
- **Contents:** `assets/` (except `base`), `workspace/`, `plugin-data/`, `deps/`, `sessions/`.
- **Excluded:** `.runtime/` (the message queue and events). Rolling the queue back would re-run finished work or drop newer messages.
- **Restore:** stop the unit, restore, start it again. Afterwards the files and conversation history are from the checkpoint, the queue is current, and the console clearly states that **external actions (messages sent, emails, payments) are not undone**.
- **Unsupported storage:** if the agent's storage backend can't checkpoint, the `checkpoints` setting is rejected at validation with a clear message.
- **Console:** a checkpoint list per agent, with time, label and size, plus a **restore** button with that warning.

### Moving an agent to JuiceFS

`cognisphere storage migrate <agent> --to juicefs` stops the unit, copies its state and switches the backend in config. The source is kept until the operator removes it.

## Done when

- An agent on JuiceFS runs normally, and the same state is visible from a second host.
- After every batch a checkpoint exists. Restoring one brings back earlier workspace files and session history, while the queue keeps newer messages.
- Retention keeps the configured number of recent and daily checkpoints.
- A shared space on JuiceFS works between agents on two hosts.
- Docs: core.md (storage backends, checkpoints), agents.md (`checkpoints`), cli.md (`storage migrate`), shipped README (setup, costs, what restore does and doesn't undo).

## Open questions

1. Which metadata engine should the first deployments use: Redis (fast; needs persistence turned on), Postgres (durable), or SQLite (single host only)?
2. Remote short-lived sandboxes (phase 15) can't use host mounts. Should they mount JuiceFS themselves, which needs a separate volume per agent so credentials stay scoped? Or should they sync state in and out?
