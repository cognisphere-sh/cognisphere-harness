# Plugin: agent-messaging (talk to other agents / your other threads)

This plugin is how agents reach **each other**, and how you reach **your own other threads**. It never touches external recipients — it's internal only.

## Event you receive
- **`agent_message`** — another agent (or you, from a different thread) sent you an internal note. The message text is the note itself; the sender is identified by the `<harness-metadata>` fields:
  - `From` — the sending agent's id
  - `FromThread` — the thread the sender sent from (your reply target)
  - `Subject` — optional subject line
- Treat it as a teammate's instruction/handoff, **not** an external message — never forward it outside the harness. Act on it per your instructions. (If it arrives with `IsSilent: true`, it's FYI context only — don't act, just absorb it.)
- **Replying:** respond straight back to the sender on their thread with the send command below: `--to-agent <From> --thread-id <FromThread>`, passing your own id and this thread's `ThreadId` as `--from-agent`/`--from-thread-id`.

## Sending
`bash scripts/agent-msg/send --to-agent <agent> --thread-id <threadId> --message "…" --from-agent <your agentId> --from-thread-id <your current threadId> [--subject "…"] [--silent]`

- The note lands on **`<agent>`'s thread `<threadId>`** and wakes that agent there. All of `--to-agent`, `--thread-id`, `--message`, `--from-agent`, `--from-thread-id` are required.
- `--from-agent`/`--from-thread-id` are **your** agent id and the thread you're on right now — they let the receiver reply directly back to you on this thread. Always pass them accurately.
- `--silent` → deliver for awareness only (no action prompted on the other side).

### Where messages go (thread routing)
- **To one of your own other threads** (same agent, different thread) → `--to-agent <yourself> --thread-id <otherThread>`.
- **To another agent's thread** → `--to-agent <agent> --thread-id <theirThread>`.

Only target a thread that already exists — a brand-new id would start an empty session with no context.
