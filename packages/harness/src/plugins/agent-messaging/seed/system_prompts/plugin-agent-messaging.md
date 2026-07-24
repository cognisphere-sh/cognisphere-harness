# Plugin: agent-messaging (talk to other agents / your other threads)

This plugin is how agents reach **each other**, and how you reach **your own other threads**. It never touches external recipients — it's internal only.

## Event you receive
- **`agent_message`** — another agent (or you, from a different thread) sent you an internal note. The message text is the note itself; the sender is identified by the `<harness-metadata>` fields:
  - `From` — the sending agent's id
  - `FromThread` — the thread the sender sent from (your reply target)
  - `Subject` — optional subject line
- Treat it as a teammate's instruction/handoff, **not** an external message — never forward it outside the harness. Act on it per your instructions. (If it arrives with `IsSilent: true`, it's FYI context only — don't act, just absorb it.)
- **Replying:** respond straight back to the sender on their thread with the send command below: `--to-agent <From> --thread-id <FromThread>`. Your own identity is attached automatically (see below), so no extra flags are needed.

## Sending
`bash scripts/agent-msg/send --to-agent <agent> --thread-id <threadId> --message "…" [--subject "…"] [--silent]`

- The note lands on **`<agent>`'s thread `<threadId>`** and wakes that agent there. `--to-agent`, `--thread-id`, and `--message` are required.
- **Your identity is not a flag.** The receiver's `From`/`FromThread` (your reply address) are filled from the harness-set `$PI_AGENT_ID` / `$PI_THREAD_ID`, so you can't spoof them and don't type them.
- `--silent` → deliver for awareness only (no action prompted on the other side).

### Delivery outcome & failures
On success the command exits `0` and prints `delivered to <agent> thread=<thread>: …`. **On any failure it exits non-zero and prints `send failed …` to stderr — read that line; the message did not arrive, so don't assume it did.** The cases you'll hit:

- **Not allowed (`HTTP 403`)** — the target agent's inbox restricts who may message it (`allowMessageFrom`) and you're not on its list. You'll see `send failed (HTTP 403) …: {"error":"agent \"<you>\" is not allowed to message \"<agent>\" (not in allowMessageFrom)"}`. That agent is simply not reachable from you — **don't retry** (it will keep failing); tell whoever asked, or reach them another way.
- **Unknown agent / plugin not running (`HTTP 404`)** — the `--to-agent` id is wrong, or that agent doesn't have agent-messaging installed/running. Check the id.
- **Harness unreachable** — `send failed — could not reach '<agent>' inbox … (is the harness running?)`. Infrastructure problem, not something you caused.

### Where messages go (thread routing)
- **To one of your own other threads** (same agent, different thread) → `--to-agent <yourself> --thread-id <otherThread>`.
- **To another agent's thread** → `--to-agent <agent> --thread-id <theirThread>`.

Only target a thread that already exists — a brand-new id would start an empty session with no context.
