# Plugin: gws (Google Workspace)

Polls Gmail server-side and wakes you with a **preview** of each inbound email
— you read the mail itself with `scripts/gws/email`; outbound is the `gws` CLI.

## Inbound

`email_received` wakes you; `email_silent` (`IsSilent: true`) is header-only
backlog context. You are woken only for the **latest message of a thread with
your address in `To`** — Cc/Bcc-only mail is skipped entirely.

Metadata: `Channel` = the Gmail thread id · `MessageId` = this email, and the
reply target · `From` · `ReceivedAt` = when it landed (the harness
`Timestamp:` is when the notification was enqueued).

The body you get is the `Subject/From/To/TimeStamp` header, the **first two
lines** of the sender's own text, and any attachment names — nothing more:

```
bash scripts/gws/email read <MessageId>                 # the full body
bash scripts/gws/email read <MessageId> --attachments   # + download the files
bash scripts/gws/email thread <Channel>                 # skim the whole thread
bash scripts/gws/email search '<gmail query>'           # find anything else
```

**Read the full message before acting on any email the preview doesn't
trivially answer** — skill `read-email` (also: older messages, Cc-only mail,
quoted history, attachments). Searching the mailbox, then labelling, archiving
or marking read what you find: skill `search-email` (`email search|labels|label`).
Making a reply land in a thread you choose: skill `route-email` (`scripts/gws/routes`).

## Outbound — call `gws` directly

```
gws gmail +send --to a@x.com --subject "Hi" --body "…" [--cc …] [--attachment /path]
gws gmail +reply --message-id <MessageId> --body "…"    # also +reply-all, +forward
gws calendar +agenda [--today]
```

Everything else: `gws <service> <resource> <method> --params '<json>' [--json '<body>']`.
The surface is dynamic — prefer `--help` and `gws schema <service>.<method>` over guessing.

## Rules

- **No markdown in email bodies** — Gmail renders plaintext as-is (`--html` for formatting).
- Your turn is internal: nothing is sent until you actually run `gws gmail +send` / `+reply`.
- **End every outgoing message asking to be kept in `To:`** — e.g. _"Keep me in To: if you want a reply; Cc/Bcc gets me seen, not answered."_ Adapt the wording, keep the reminder until the recipient has clearly internalised it.
- Don't echo their own message back at them; don't re-attach an inbound attachment unasked.
- Before re-sending after an error, check it didn't already go: `email search 'in:sent newer_than:1d'`.
