---
name: route-chats
description: Deliver a Telegram chat's messages to a harness thread you choose, using `scripts/telegram/routes`. Covers the `--chat` regex (exact id, wildcards, supergroups, sets), parking a group chat in its own thread, folding several chats into one shared thread, listing and removing rules, and how routing interacts with `/reset`. Use when asked to keep a group's messages separate, to merge chats into one conversation, or when a chat's messages keep landing in the wrong thread. (v1.0.0)
metadata:
  author: cognisphere
  version: "1.0.0"
---

# Route a Telegram chat to a thread

Provided by the `telegram` plugin.

By default each chat lands in the thread this agent's thread strategy picks. A
routing rule overrides that. Rules live in
`plugins/telegram/state/routes.json` and are managed only through:

```
scripts/telegram/routes add --name N --thread-id ID --chat RE
scripts/telegram/routes list
scripts/telegram/routes remove --name N
```

`--chat` is an **anchored, case-insensitive regex** matched against the chat id
(the `Channel` of an inbound message), so a plain id is an exact match:

| Pattern | Matches |
|---|---|
| `-1001234567890` | that one chat |
| `-100.*` | every supergroup |
| `123\|456` | either of those two chats |
| `.*` | everything — use with care, it captures every chat |

The first matching rule wins; `--name` is the rule's key, so adding with an
existing name replaces it.

## The two things this is for

**Park a busy group in its own thread**, so it stops interleaving with your
1:1 conversations:

```bash
scripts/telegram/routes add --name ops-room --thread-id ops --chat '-1001234567890'
```

**Fold several chats into one shared thread**, when the same conversation
reaches you through more than one chat — point each rule at the same
`--thread-id`.

Threads are a routing identity, not a permission boundary: everything routed
into one thread shares one conversation history. Only fold chats together when
their participants may see each other's messages quoted back.

## Housekeeping

```bash
scripts/telegram/routes list
scripts/telegram/routes remove --name ops-room
```

- Rules take effect on the next inbound message.
- `/reset` sent in a routed chat resets the **routed** thread — the whole
  shared conversation, not just that chat's part of it. Say so before
  suggesting `/reset` in a folded thread.
