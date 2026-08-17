# Plugin: gws (Google Workspace)

Polls Gmail server-side and wakes you with a **preview** of each inbound email
— you read the mail itself with `scripts/gws/email`; outbound is the `gws` CLI.

## Inbound

`email_received` wakes you; `email_silent` (`IsSilent: true`) is header-only
context. By default you are woken for the **latest message of every unread
inbox thread**, routed to its own thread — your settings (below) decide what
actually reaches you, and when.

Metadata: `Channel` = the Gmail thread id · `MessageId` = this email, and the
reply target · `From` · `ReceivedAt`. The body you get is the header, the
**first two lines** of the sender's own text, and attachment names — no more:

```
bash scripts/gws/email read <MessageId>                 # the full body
bash scripts/gws/email read <MessageId> --attachments   # + download the files
bash scripts/gws/email thread <Channel>                 # skim the whole thread
bash scripts/gws/email search '<gmail query>'           # find anything else
```

**Read the full message before acting on any email the preview doesn't
trivially answer** — skill `read-email`. Searching/labelling/archiving: skill
`search-email`. Landing replies in a thread you choose: skill `route-email`.

## Settings — you own your notifications

`bash scripts/gws/settings show|set|reset` (state: `plugins/gws/state/settings.json`).
Keys: `pollIntervalSec` (default 900; `-1` silences email entirely — no
polling, no notifications, mailbox left unread, search when *you* want),
`gmailQuery` (`is:unread in:inbox`), `allowedSenders` (`*`),
`requireAgentInTo` (false). Changes apply within one poll; a `gws_settings`
message with the effective settings arrives each harness start — re-assert yours then.

## Outbound — call `gws` directly

```
gws gmail +send --to a@x.com --subject "Hi" --body "…" [--cc …] [--attachment /path]
gws gmail +reply --message-id <MessageId> --body "…"    # also +reply-all, +forward
gws calendar +agenda [--today]
```

Everything else: `gws <service> <resource> <method> --params '<json>' [--json '<body>']`
— prefer `--help` and `gws schema <service>.<method>` over guessing.

- **No markdown in email bodies** — Gmail renders plaintext as-is (`--html` for formatting).
- Nothing is sent until you actually run `gws gmail +send` / `+reply`; before re-sending after an error, check `email search 'in:sent newer_than:1d'`.
- Don't echo their message back; don't re-attach an inbound attachment unasked.
