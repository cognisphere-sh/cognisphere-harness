# Plugin: agent-messaging (talk to other agents / your other threads)

This plugin is how agents reach **each other**, and how you reach **your own other threads**. It never touches customers — it's internal only.

## Event you receive
- **`agent_message`** — another agent (or you, from a different thread) sent you an internal note. The text begins `[AGENT MESSAGE] from <agent> (their thread <threadId>)`. Treat it as a teammate's instruction/handoff, **not** a customer message — never forward it to a customer. Act on it per your SOP. (If it arrives `silent`, it's FYI context only — don't act, just absorb it.)
- **Replying:** the header tells you the sender's agent id and the thread they sent from — respond straight back to that agent on that thread with the send command below (`--to-agent <their agent> --thread-id <their thread>`).

## Sending
`bash scripts/agent-msg/send --to-agent <agent> --thread-id <threadId> --message "…" --from-agent <your agentId> --from-thread-id <your current threadId> [--subject "…"] [--silent]`

- The note lands on **`<agent>`'s thread `<threadId>`** and wakes that agent there. All of `--to-agent`, `--thread-id`, `--message`, `--from-agent`, `--from-thread-id` are required.
- `--from-agent`/`--from-thread-id` are **your** agent id and the thread you're on right now — they let the receiver reply directly back to you on this thread. Always pass them accurately.
- `--silent` → deliver for awareness only (no action prompted on the other side).

### Where messages go (thread routing)
- **To one of your own other threads** (same agent, different thread) → `--to-agent <yourself> --thread-id <otherThread>`.
- **To reach Chris or Bhoumik from a non-admin thread** → message your own `admin` thread: `--to-agent <yourself> --thread-id admin`. Only the `admin` thread talks to them (over Telegram); it relays your question and sends their answer back to your thread with this same plugin. Include everything the admin thread needs to relay: what you're asking, the supplier/context, and your ThreadId (via `--from-thread-id`).
- **If you ARE the admin thread** and an `[AGENT MESSAGE]` asks for Chris/Bhoumik: forward the question over Telegram (`scripts/telegram/telegram-cli send-message`), and when the human answers, pass the response back to the requesting thread (`--to-agent <yourself> --thread-id <their thread>`).
- **If you ARE the admin thread and Chris asks you to reply to a certain email**: don't reply from the admin thread — redirect the request to the email's own thread (`--to-agent <yourself> --thread-id <emailThreadId>`, found via `workspace/index.md`) with exactly what Chris wants said; that thread sends the reply (it has the email context) and reports what it sent back to the admin thread with this same plugin, so Chris can be told.

Only target a thread that already exists — a brand-new id would start an empty session with no context.
