# Phase 7: events and handlers

[Roadmap](../roadmap.md) · Previous: [Phase 6](phase-06-agent-host-split.md) · Next: [Phase 8](phase-08-storage-interface.md)

## Requirement

The agent, not the platform, decides what an incoming event means:

- **Scheduled scripts:** the coordinator only says "it's time" on a schedule the agent registered. The agent's script decides what to do, such as checking Gmail or a web page. It can post messages to any thread, or to another agent, or do nothing.
- **Routing:** the agent's script decides which thread an incoming Telegram update or message joins. A script may also hand the decision to a routing agent.
- **Polling integrations:** an integration like Gmail ships instructions and a default polling script, but no active schedule. The agent asks the user how often to check and registers the schedule itself. It can also override the script.
- **No silent loss:** a failing script never loses an event. Failed events are retried, then shown to the operator.

## Design

### Two tables in the unit

```text
outbox (coordinator) ──▶ events (unit) ──handler──▶ message queue (unit) ──▶ Pi
                                           └──▶ nothing ("sink", logged)
```

| Table | Holds | States |
|---|---|---|
| `events` | Raw triggers: `message`, `telegram.update`, `timer`, `relay` | `new → done`; `new → failed → dead` after N attempts |
| message queue | Thread messages, as today | Unchanged |

Both tables are in `.runtime/queue.db`.

- **Order:** events are handled one at a time, in arrival order.
- **Concurrency with Pi:** handlers can run while a Pi turn is active, because they only add messages.

### Handlers belong to the agent

Handlers are configured in `agent.json → handlers`, a selection field like `prompts` and `skills`. Defaults come from each capability's `defaults.handlers`. The agent changes them the same way it changes prompts: it writes a new script in `assets/`, points the handler at it through the `assets` CLI, and the script gets its `assets.json` entry (what, why, and which base handler it replaces).

```json
"handlers": {
  "message":           "builtin:thread-strategy",
  "telegram.update":   "base/capabilities/telegram/handlers/route",
  "timer:gmail-check": "base/capabilities/gws/scripts/check-gmail",
  "timer:*":           "builtin:wake-thread",
  "relay":             "builtin:relay"
}
```

**Matching:** an exact key (`timer:gmail-check`) wins over a type wildcard (`timer:*`), which wins over a bare type (`timer`). An event with no match goes to `builtin:thread-strategy`.

**Builtins:**

| Builtin | Does |
|---|---|
| `builtin:thread-strategy` | Today's routing, using `threadIdStrategy`, which stays as this builtin's setting |
| `builtin:wake-thread` | Today's reminder behavior: the timer's message goes to the thread that set it |
| `builtin:relay` | Sends a reply through this agent's channel for another agent (see below) |
| `builtin:drop` | Ignore the event |

**Script handlers:**

- **How they run:** as a child process in the unit, with the workspace as the working folder. The event arrives as JSON on stdin. The environment holds the unit token. There is a timeout (default 60 s; can be set per handler). No model is involved.
- **Adding messages:** `enqueue --thread <t> [--key <k>] [--silent] [--no-steer] "<text>"` adds to this agent's queue through the agent host's local socket. `agent-msg send --to <agent> --thread <t> --key <k>` messages another agent.
- **Duplicates:** the default key is `<eventId>:<n>`, so re-running a handler can't post twice.
- **Exit status:** exit 0 means `done`. A non-zero exit or a timeout means retry, up to `maxAttempts`. After that the event is `dead`, and the console shows it with **retry** and **discard** buttons.

### Scheduler

- **Ownership:** the agent owns its schedules, and the coordinator stores and fires them, because something must be awake when the unit isn't.
- **Registering:** `schedule add --id <id> (--cron "<expr>" [--tz <tz>] | --at <time>) [--payload '<json>']`, plus `schedule list` and `schedule remove`. These are coordinator calls authenticated with the unit token.
- **Firing:** a schedule fires as outbox event `timer {scheduleId, payload, firedAt}` with the duplicate key `scheduleId:firedAt`.
- **Migration:** existing reminders in `state/schedules.json` move into coordinator storage, and the scheduler plugin's timers move into the coordinator.

### Telegram and Gmail as events

- **Telegram:** the coordinator receives updates for each bot and turns each one into a `telegram.update` event for the bot's agent.
  - The default handler reproduces today's behavior: the thread comes from the strategy, and the unit-side hook downloads attachments.
  - An agent may replace it with its own routing script.
- **Gmail:**
  - The `gws` capability ships `check-gmail`, which uses a cursor in `plugin-data/gws/`, applies filters and posts matching mail to threads.
  - It also ships a skill telling the agent to ask the user how often to check, then run `schedule add --id gmail-check …`.
  - The coordinator's built-in GWS poller is turned off for each agent that switches. It is removed once every agent has switched, so two pollers never run together.

### Routing agents, forwards and replies

- **Routing agents:** a routing agent is just a handler script that calls `agent-msg send` to an LLM agent's thread. That agent then sends the message on with `agent-msg send`.
- **Loop guard:** forwarded messages carry a hop count. Above 3, the message goes to the dead-letter list.
- **Replies after a forward (relay through the owning agent):** the forwarded message carries `via: {agent, capability, channel}`.
  1. The handling agent replies with `agent-msg send --to <owner> --relay "<text>"`.
  2. This arrives at the owner as a `relay` event.
  3. `builtin:relay` sends the text through the owner's capability, for example `telegram send` to that chat, **without a model turn**.

## Done when

- **Scheduled script:** a schedule that prints nothing does nothing. One that runs `enqueue` wakes the right thread exactly once, even if the handler is retried.
- **Routing script:** a Telegram routing script puts each user in a group into their own thread.
- **Gmail:** an agent registers `gmail-check`, gets the same notifications as the old poller, and gets no duplicates while switching over.
- **Failure handling:** a handler that always fails ends up in the dead-letter list in the console after `maxAttempts`, and **retry** works.
- **Relay:** a forwarded message answered by another agent reaches the Telegram user through the owner's bot, with no model turn at the owner.
- **Docs:**
  - core.md (events, handlers, dead letters);
  - plugins.md (scheduler, Telegram, GWS);
  - agents.md (`handlers` in `agent.json`; `enqueue`, `schedule`);
  - shipped README.

## Open questions

1. **Missed fires:** should fires missed while the coordinator was down be skipped (suggested) or run once at startup?
2. **Default Gmail schedule:** should a capability's *suggested* schedule be something the operator can enable when adding the capability, as a no-setup option? Or does the agent always ask the user first?
3. **Silent messages from handlers:** should `enqueue --silent` (logged for the agent's awareness without waking it) be allowed?
