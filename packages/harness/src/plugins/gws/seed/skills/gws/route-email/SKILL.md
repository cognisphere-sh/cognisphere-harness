---
name: route-email
description: Make inbound email land in a harness thread you choose, using `scripts/gws/routes`. Covers the default thread id (`<Subject>[<gmailThreadId>]`), the three match patterns (--gmail-thread-id, --from, --subject) and which to prefer, the send-then-route recipe that brings a reply back to the thread you sent from, listing and removing rules, and when a rule takes effect. Use when you email someone from a thread and want their answer back in it, when parking a sender or subject in a dedicated thread, or when asked why a reply opened a new thread. (v1.0.1)
metadata:
  author: cognisphere
  version: "1.0.1"
---

# Route inbound email to a thread

Provided by the `gws` plugin.

By default an email's harness `ThreadId` is `<Subject>[<gmailThreadId>]`,
frozen at the Gmail thread's first message so a later `Re: …` still routes to
the same place. A routing rule overrides that and delivers matching mail to a
`ThreadId` you name instead. Rules live in `plugins/gws/state/routes.json` and
are managed only through:

```
scripts/gws/routes add --name N --thread-id ID [--gmail-thread-id RE] [--from RE] [--subject RE]
scripts/gws/routes list
scripts/gws/routes remove --name N
```

## Which pattern to match on

- `--gmail-thread-id` — the raw Gmail thread id: an inbound notification's
  `Channel`, or the `threadId` printed by `gws gmail +send` / `+reply`.
  Anchored case-insensitive regex, so a plain id is an exact match.
  **Prefer this.** A reply always stays in the Gmail thread of the message it
  answers, so it captures exactly the follow-ups to one mail and nothing else.
- `--from` — matched against the newest message's `From` header. Unanchored,
  case-insensitive: a plain string is a substring match.
- `--subject` — matched against the thread's subject (frozen at its first
  message). Same regex rules as `--from`.

At least one is required; when several are given **all** must match. The first
matching rule in the file wins, and `--name` is the rule's key — adding with an
existing name replaces it.

## The common case: keep a reply in this thread

You email someone from the thread you're in, and want their answer to come
back here rather than open a new one. Capture the sent message's Gmail thread
id and route on it:

```bash
tid="$(gws gmail +send --to alice@example.com --subject "Q3 quote" --body "…" | jq -r .threadId)"
# nothing captured? look the sent message up instead:
#   gws gmail users messages list --params '{"userId":"me","q":"in:sent newer_than:1h"}'
scripts/gws/routes add --name alice-q3 --thread-id "<this thread's ThreadId>" \
  --gmail-thread-id "$tid"
```

`<this thread's ThreadId>` is the `ThreadId` from the metadata block of the
message you're answering.

Cast a wider net — any mail from Alice about that subject, not just replies to
this one — with the header patterns:

```bash
scripts/gws/routes add --name alice-q3 --thread-id "<this thread's ThreadId>" \
  --from alice@example.com --subject 'Q3 quote'
```

## Clean up

```bash
scripts/gws/routes list
scripts/gws/routes remove --name alice-q3
```

Remove a rule once the exchange is done. A left-behind `--from` rule keeps
pulling that sender's unrelated mail into a thread where it makes no sense.

## What a rule does not do

- It changes *where* an email is delivered, never *whether*. Delivery is
  decided by your gws settings (`scripts/gws/settings`); a rule cannot rescue
  mail those filters drop.
- Rules take effect within one poll interval, not instantly.
- A rule with a bad regex, or with no pattern at all, is skipped with a warning
  in the plugin log rather than applied — check `routes list` if a rule seems
  to do nothing.
