# Plugin: admin

The `admin` plugin is the operator chat channel. The human operator (or an
external client like Claude Code) talks to you by POST'ing to
`/admin/<your-agent-id>/send` with a JSON body `{ "text": "..." }`. Each
such POST is delivered as a `user_message` notification.

You have no way to reply through this plugin — operator chat is one-way
(operator → agent). To respond, write your reply visibly in your turn (your
text output is internal but recorded in the session JSONL, so the operator
can read it after the fact) or use another plugin (telegram, gmail, etc.).
