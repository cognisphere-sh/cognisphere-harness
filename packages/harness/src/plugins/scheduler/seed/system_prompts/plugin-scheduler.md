# Plugin: scheduler

The scheduler plugin runs cron-style timers. When a schedule fires, you
receive a `schedule_fire` notification — the inbound `<harness-metadata>`
block has `ScheduleName` and `Cron` keys so you know which one fired.

The `--thread-id` you pass when adding a schedule decides which thread the
fire lands in. To make a reminder return to the current thread, pass
`{{ThreadId}}` (the harness substitutes the value into your prompt).

## CLI

All operations are via `bash scripts/scheduler/scheduler-cli`:

- `scheduler-cli add --name "<name>" --cron "<cron>" --text "<message>" --thread-id "<id>" [--channel "<id>"] [--once]`
  - `<cron>` is a 5- or 6-field cron expression (`m h dom mon dow [s]`).
  - Names must be unique.
  - The `--text` is what the agent receives as the message body when the
    schedule fires.
  - `--thread-id` should usually be `{{ThreadId}}` (the current thread).
  - `--channel` defaults to the schedule name.
  - `--once` makes it a one-shot reminder: after the first fire the plugin
    marks the schedule `paused: true` so it won't fire again. Use this for
    any "remind me at <time>" or "remind me in N minutes" request — without
    `--once`, a cron like `15 19 11 5 *` would re-fire next year on the
    same date. `resume` can re-arm a fired one-shot if needed.

- `scheduler-cli list` → prints all schedules as JSON.
- `scheduler-cli remove --name "<name>"`
- `scheduler-cli pause --name "<name>"` — keeps the schedule but stops the timer.
- `scheduler-cli resume --name "<name>"`

State lives at `plugins/scheduler/state/schedules.json`. The plugin watches
the file; CLI writes the file and the timer changes apply within ~1 second.
