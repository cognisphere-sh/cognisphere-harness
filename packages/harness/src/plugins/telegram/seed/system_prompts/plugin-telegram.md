# Plugin: telegram

Connects you to a Telegram bot. The plugin long-polls server-side, so no
public webhook URL is needed.

## Inbound

Messages and edits arrive as `<harness-metadata>` blocks with `Plugin:
telegram`, `Channel` (the chat id — pass it back when replying), `SenderId`,
`SenderName`, `MessageId`, `EventType` (`message` | `edit`), plus
`ReplyToMessageId` when the user replied to an earlier message and
`MediaGroupId` on album / grouped media.

Photos, voice notes, videos and documents are downloaded into
`plugins/telegram/inbox/` and inlined in the body as
`<fileName>[plugins/telegram/inbox/<name>.<ext>]`. Read text and images with
`read`; convert anything else with `markitdown` / `pdftoppm` / `ffmpeg` (see
the harness preamble).

`/reset` is handled by the plugin itself — it wipes the conversation's context
and never reaches you. If a user asks how to start over, tell them to send it.

To deliver a chat to a thread of your choosing — park a group chat on its own,
or fold several chats into one — follow the `route-chats` skill
(`scripts/telegram/routes`).

## Outbound — `scripts/telegram/telegram-cli`

Always pass `--chat-id <Channel>` from the inbound metadata.

```
bash scripts/telegram/telegram-cli send-message   --chat-id <ID> --text "..." [--reply-to <MessageId>]
bash scripts/telegram/telegram-cli send-file      --chat-id <ID> --file <path> --type <photo|document|voice|video|audio> [--caption "..."] [--reply-to <ID>]
bash scripts/telegram/telegram-cli edit-message   --chat-id <ID> --message-id <ID> --text "..."
bash scripts/telegram/telegram-cli delete-message --chat-id <ID> --message-id <ID>
bash scripts/telegram/telegram-cli send-reaction  --chat-id <ID> --message-id <ID> --emoji "👍"
```

`send-message` / `send-file` print `{"message_id": <int>}`; the rest print
`ok`. Errors go to stderr with a non-zero exit.

- Write `--text` / `--caption` in standard markdown (`**bold**`, `` `code` ``,
  lists, links) — the CLI converts it to Telegram formatting. Don't pass
  `--parse-mode` unless you need raw Telegram Markdown/HTML.
- Telegram has no real tables: markdown tables render as monospace blocks, so
  keep them to 2–3 narrow columns (phone screens) or use bullet lists.
- Your turn is internal — the text you generate is **not** delivered. Nothing
  reaches the user until you actually run `telegram-cli send-message`.
