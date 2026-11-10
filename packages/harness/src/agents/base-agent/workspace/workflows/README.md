# Workflows

A workflow is a static script that runs instead of a Pi turn. The router
(`workspace/router.ts`) sends a message to it by returning the thread id
`workflow:<name>`. Each workflow is a folder:

```
workflows/<name>/
  workflow.json     {"description": "What it does and when to route to it.", "script": "run.sh"}
  run.sh            the script (executable: chmod +x)
```

The folder name is the workflow's name. `description` and `script` are
required; a folder missing either, or whose script isn't executable, is skipped.

Messages to a workflow are queued like any thread's, and the script runs once
per message, one at a time, from the agent folder. Workflows have their own
workers, so a script starts at once even while the agent is busy in a turn
(fast enough to answer a Telegram button tap); it may run while the agent
edits files, so don't share files with the agent without care.

- **stdin:** the message as JSON: `id`, `notification`, `pluginId`,
  `channelId`, `threadId`, `text`, `metadata`, `isSilent`, `attempts`.
- **env:** the same as a Pi turn (`.venv`, secrets, `PI_AGENT_ID`,
  `HARNESS_BASE_URL`), with `PI_THREAD_ID=workflow:<name>`.
- **result:** exit 0 marks the message done. Anything else (or running past
  10 minutes, or being interrupted by a stop or crash) marks it **failed,
  with no retry**. For an ordinary failure the harness only logs it and shows
  it in the console's events; telling the agent is the script's job (below).
  When the harness itself kills the script (timeout, stop, crash), the
  script's handler can't run, so the harness posts a `workflow_killed`
  notice to `main` instead. `attempts` > 0 on stdin means an operator
  requeued it after an earlier run failed part-way.
- **To invoke the agent:** `scripts/agent-msg/send --to-agent "$PI_AGENT_ID" --thread-id <thread> --message "…"`.
  The agent's reply to `workflow:<name>` arrives as a new message
  (`notification: "agent_message"`), so don't wait for it in the script.

## Best practice: catch errors and tell the agent

The agent babysits its workflows, but only hears about a failure if the
script tells it. Wrap the work in try/catch and send the agent what it needs
to act, with agent-messaging, to `main` (or any thread you choose):

```python
#!/usr/bin/env python3
import json, os, subprocess, sys, traceback

msg = json.load(sys.stdin)

def tell_agent(text, thread="main"):
    subprocess.run(["scripts/agent-msg/send", "--to-agent", os.environ["PI_AGENT_ID"],
                    "--thread-id", thread, "--subject", "workflow invoices", "--message", text])

try:
    ...  # the workflow
except Exception:
    tell_agent(f"invoices failed on event {msg['id']} ({msg['text'][:200]!r}):\n{traceback.format_exc()}")
    sys.exit(1)  # marks the event failed in the console
```

In a shell script, use `bash` with
`trap 'scripts/agent-msg/send --to-agent "$PI_AGENT_ID" --thread-id main --message "…failed at line $LINENO"; exit 1' ERR`.
A timeout, stop or crash kills the script before its handler runs; the
harness reports those to `main` itself.

Messages a workflow sends carry `FromThread: workflow:<name>`, so an agent
reply to them runs the workflow again. To redo the work after a fix, the agent
sends it to `workflow:<name>` (or the operator requeues the failed event in
the console).

Output goes to the harness log. A run ends when the script's stdout and stderr
close, so don't leave a child running in the background: it holds the worker
until it exits or the 10-minute timeout kills it. Edits to workflows and the
router apply within a few seconds.
