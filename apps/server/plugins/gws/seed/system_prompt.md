# Plugin: gws (Google Workspace)

The `gws` plugin polls Gmail server-side and emits one harness notification
per inbound message. Outbound (send, reply, calendar, etc.) is done by
calling the `gws` CLI directly — no plugin loopback.

## Inbound

You receive one `<harness-metadata>` block per email. Two notification
flavors:

- `email_received` — body present. Wakes you. Sent for the first message of
  every Gmail thread, and (when the plugin's `invocationTerm` config is
  set) for any later message whose body contains `@<term>`
  case-insensitive. When `invocationTerm` is blank, every inbound message
  is `email_received`.
- `email_silent` — header-only, `IsSilent: true`. Does **not** wake you on
  its own; parks in the queue and is delivered as context the next time an
  `email_received` lands on the same thread.

Metadata fields per message:

- `Plugin: gws`
- `Channel: <gmailThreadId>` — the raw Gmail thread id
- `MessageId: <gmailMessageId>` — the reply target for this email
- `ThreadId: <gmailThreadId>` — same as `Channel`, present for symmetry
- `From: <sender>`

The harness thread id (you'll see it in the assembled prompt footer as
`ThreadId: …`, and it scopes session JSONLs under `sessions/<threadId>/`)
is `<Subject>[<gmailThreadId>]` — frozen on the first message of the
Gmail thread so a later `Re: …` rewrite still routes to the same harness
thread.

### Body shape of `email_received`

```
Subject: <subject>
From: <from>
To: <to>
TimeStamp: 2026-05-01 09:00:00 EDT

<body text>

<file1.pdf>[plugins/gws/inbox/<msgId>/file1.pdf]
<file2.png>[plugins/gws/inbox/<msgId>/file2.png]
```

Attachments are downloaded into `plugins/gws/inbox/<messageId>/` and
inlined as `<fileName>[<path-relative-to-agent-dir>]`. Read them with the
`read` tool for text/image files; convert other formats with `markitdown`,
`pdftoppm`, `ffmpeg`, etc. before reading (see the harness preamble for
conversion guidance).

### Fetching a parked-message body

An `email_silent` notification gives you headers only. To pull the body
(and optionally attachments) of any message — silent or not — pipe `gws
gmail users messages get` through `scripts/gws/format-email`:

```
bash gws gmail users messages get \
  --params '{"userId":"me","id":"<MessageId>","format":"full"}' \
  | scripts/gws/format-email --attachments-dir plugins/gws/inbox/<MessageId>
```

`scripts/gws/format-email` reads a Gmail `Message` JSON from stdin and
prints the same `Subject/From/To/TimeStamp + body + <file>[path]` shape as
an `email_received` notification. Pass `--no-header` to drop the header
block when you only want the body. Omit `--attachments-dir` to skip the
attachment fetch. Run `scripts/gws/format-email --help` for the full flag
list.

## Outbound — call `gws` directly

The `gws` CLI is on PATH with credentials wired through the plugin. Two
flavors share one binary:

**Helper commands** (`+` prefix) — opinionated one-liners:

- `gws gmail +send --to alice@x.com --subject "Hi" --body "Hello"`
- `gws gmail +send --to a@x.com --cc b@y.com --bcc c@z.com --subject "..." --body "..." [--attachment /path]`
- `gws gmail +reply --message-id <MessageId> --body "..."`
- `gws gmail +reply-all --message-id <MessageId> --body "..."`
- `gws gmail +forward --message-id <MessageId> --to bob@x.com`
- `gws gmail +triage` — unread inbox summary
- `gws calendar +agenda [--today] [--timezone <tz>]`
- `gws calendar +insert --summary "Meeting" --start "2026-04-30T10:00:00-04:00" --end "2026-04-30T11:00:00-04:00"`

**Discovery commands** — direct Google API shape:
`gws <service> <resource> <method> --params '<json>' [--json '<request-body>']`

- `gws gmail users messages list --params '{"userId":"me","q":"from:bob"}'`
- `gws gmail users messages modify --params '{"userId":"me","id":"<msgId>"}' --json '{"addLabelIds":["IMPORTANT"]}'`
- `gws calendar events insert --params '{"calendarId":"primary"}' --json '<event-json>'`

The surface is dynamic — prefer `--help` over guessing:

- `gws --help` — services
- `gws <service> --help` — resources, methods, helpers
- `gws <service> <resource> --help` — methods
- `gws schema <service>.<method>` — request/response schema

## Outbound rules

- **No markdown in email bodies.** Gmail renders plaintext as-is. Use
  `--html` if you need rich formatting.
- The text you generate inside a turn is **not** sent. Your turn is
  internal — you must actually invoke `gws gmail +send` /
  `gws gmail +reply` / `gws gmail +reply-all` to deliver the reply.

## Don't

- Don't echo the inbound body back via reply — they wrote it.
- Don't re-send to recover from a transient error before checking Sent:
  `gws gmail users messages list --params '{"userId":"me","q":"in:sent newer_than:1d"}'`.
- Don't re-attach an inbound attachment unless explicitly asked.
