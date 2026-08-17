---
name: search-email
description: Find mail in the mailbox and file it, with `scripts/gws/email search|labels|label`. Covers Gmail query syntax (sender, subject, dates, attachments, labels, negation, OR), narrowing a search that returns too much, checking whether something you sent went out, applying and creating labels, archiving, marking read/unread, doing it per-thread, and the standing Gmail filters that change what wakes you. Use when asked "did X ever email about…", "find that invoice", "what's still unanswered", "file/archive/label these", or whenever you need mail that never arrived as a notification. (v1.0.1)
metadata:
  author: cognisphere
  version: "1.0.1"
---

# Search and file email

Provided by the `gws` plugin. You are woken only for the newest message of
each thread your gws settings let through — everything else in the mailbox is
reachable only by searching for it.

```bash
bash scripts/gws/email search 'from:alice@x.com newer_than:30d'   # id, subject, from, date, snippet
bash scripts/gws/email read <id>                                   # then open the ones that matter
```

`search` lists the 10 most recent hits (`--max N` for more), oldest first, so
the newest is at the bottom. It is a *finder*, not a reader: decide from the
subject and snippet which ids are worth a `read`.

## 1. Write the query

The query is ordinary Gmail search syntax — the same string you'd type into
Gmail's box. The operators that carry most of the weight:

| Operator | Finds |
|---|---|
| `from:alice@x.com` `to:me` `cc:bob@x.com` | by participant |
| `subject:invoice` | words in the subject |
| `"exact phrase"` | that phrase anywhere in the mail |
| `newer_than:7d` `older_than:1y` | relative age (`d`, `m`, `y`) |
| `after:2026/01/31` `before:2026/03/01` | absolute dates |
| `has:attachment` `filename:pdf` `larger:5M` | attachments |
| `is:unread` `is:starred` `is:important` | state |
| `label:invoices` `in:inbox` `in:sent` `in:anywhere` | location (`in:anywhere` also searches spam/trash) |
| `-from:noreply@x.com` | negation — drop a sender from the results |
| `{a b}` or `from:a OR from:b` | either term |

Terms are ANDed, so add operators to narrow rather than re-running a vague
search. A query returning hundreds of hits is a query that needs another term
— usually a date bound.

Two searches worth knowing by heart:

```bash
bash scripts/gws/email search 'in:sent newer_than:1d'          # did my reply actually go out?
bash scripts/gws/email search 'is:unread in:inbox' --max 30    # what's sitting unhandled
```

## 2. File what you found

```bash
bash scripts/gws/email labels                                   # the label names that exist
bash scripts/gws/email label <id> --add Invoices --archive --read
bash scripts/gws/email label <id> --add Invoices --create       # make the label if it's new
bash scripts/gws/email label <threadId> --thread --add Invoices # the whole thread
```

- `--add` / `--remove` take label **names**, repeatable; unknown names fail
  unless you pass `--create`, so a typo can't quietly spawn a junk label.
- `--archive` removes `INBOX`, `--read`/`--unread` remove/add `UNREAD`.
- `--thread` applies the same change to every message of the thread — the
  right form for "file this conversation away".

**Filing changes what reaches you.** The plugin polls `is:unread in:inbox`, so
marking something read or archiving it means you will not be woken by it
again. That's exactly what you want for mail you have finished with, and
exactly wrong for mail you meant to come back to — leave that unread. Never
bulk-archive a search you haven't actually read.

## 3. Standing filters (Gmail's own rules)

A recurring "don't bother me with these" belongs in a Gmail filter rather than
in repeated labelling. There's no helper for it — use the raw API:

```bash
gws gmail users settings filters list --params '{"userId":"me"}'
gws gmail users settings filters create --params '{"userId":"me"}' \
  --json '{"criteria":{"from":"noreply@x.com"},"action":{"removeLabelIds":["INBOX"]}}'
```

A filter that skips the inbox or auto-reads a sender **permanently stops that
sender from waking you**. Only create one when the user has asked for that,
say plainly what it will silence, and check `filters list` before adding a
near-duplicate.

## Failure modes

- `no matches for: <query>` — usually an over-narrow query, not an empty
  mailbox. Drop the most speculative term (often the date bound) and retry;
  add `in:anywhere` if it may be archived, spammed or trashed.
- `no label 'X'` — run `email labels`; label names are matched
  case-insensitively but must otherwise be exact. `--create` makes a new one.
- Hits you can't explain — Gmail matches the body too. Quote a phrase or add
  `subject:` to constrain where the term is allowed to match.
- A `gws` auth error — the plugin's credentials expired; report it rather than
  retrying in a loop.
