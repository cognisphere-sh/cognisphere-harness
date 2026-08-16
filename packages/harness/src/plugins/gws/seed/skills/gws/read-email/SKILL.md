---
name: read-email
description: Read the actual content of a Gmail message or thread with `scripts/gws/email` — email notifications carry only a two-line preview. Covers reading a full body, dropping quoted reply history, skimming a long thread before fetching, pulling an older message or one you were only Cc'd on, downloading and converting attachments, and finding mail the poller never delivered. Use whenever an email notification arrives and its preview isn't enough to answer, when asked "what did X say", "check the thread", "what's in the attachment", or before replying to anything non-trivial. Finding mail in the first place is the `search-email` skill. (v1.1.0)
metadata:
  author: cognisphere
  version: "1.1.0"
---

# Read an email

Provided by the `gws` plugin. An `email_received` notification gives you the
header block, the **first two lines** of the message's own text, and the names
of its attachments. Everything else is one command away.

The two ids you need are in the notification's metadata: `MessageId` (this
email) and `Channel` (the Gmail thread it belongs to).

## 1. Read the message

```bash
bash scripts/gws/email read <MessageId>
```

Prints `Subject/From/To/TimeStamp/MessageId`, the body, and the attachment
names. Options that matter:

- `--strip-quotes` — most clients paste the whole prior conversation below a
  reply. This drops it and prints only what the sender actually wrote. Use it
  when you already have the thread's history; omit it when you don't and want
  the quoted copy.
- `--attachments` — download the files into `plugins/gws/inbox/<MessageId>/`
  and print each as `<fileName>[<path>]`.
- `--no-header` — body only.

**Read the message before acting on it.** Two lines are enough to decide *that*
an email matters, almost never enough to decide *what to do*. Never reply,
schedule, promise or file anything based on the preview alone.

## 2. Read the thread

```bash
bash scripts/gws/email thread <Channel>                      # skim: id, from, date, snippet
bash scripts/gws/email thread <Channel> --full --strip-quotes  # every message's own text
```

Skim first on a long thread, then `read` the two or three messages that matter
— `--full` on a 40-message thread is a lot of context for little gain. Both
forms are how you reach messages that never woke you: older messages, and
messages where you were only on `Cc`/`Bcc` (those are skipped by the poller
entirely, so the thread listing is the only place you'll see them).

## 3. Attachments

`--attachments` writes each file under `plugins/gws/inbox/<MessageId>/`. Read
text and images with the `read` tool; convert anything else first
(`markitdown` for pdf/docx/xlsx, `pdftoppm` for a page image, `ffmpeg` for
audio/video) — see the harness preamble for conversion guidance.

Attachments are fetched only when you ask, so a mailbox full of large files
costs nothing until one is actually relevant.

## 4. Mail the poller never delivered

You are only woken for the newest message of a thread with your address in
`To`. Anything else — an older thread, a sender you were never on `To` with,
your own sent mail — you have to go and find:

```bash
bash scripts/gws/email search 'from:alice@x.com newer_than:7d'
```

Each hit's id is a `MessageId` for `email read`. The query syntax, narrowing a
search that returns too much, and filing what you find are the `search-email`
skill.

## Failure modes

- `email: read needs an id` — pass the `MessageId` from the notification.
- Empty or `(no plain-text body)` — the message was HTML-only and stripped to
  nothing (often a marketing mail). Check the attachments and the snippet in
  `email thread <Channel>` before concluding it's empty.
- `--strip-quotes` printed almost nothing — the sender wrote almost nothing
  above the quoted history. Re-run without the flag to see what they replied
  to.
- A `gws` auth error — the plugin's credentials expired; report it, don't
  retry in a loop.
