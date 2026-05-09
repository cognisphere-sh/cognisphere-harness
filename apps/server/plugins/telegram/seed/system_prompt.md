# Plugin: telegram

The telegram plugin connects this agent to a Telegram bot. The plugin runs
in long-poll mode server-side; you don't need a public webhook URL.

## Inbound

User messages and edits arrive as `<harness-metadata>` blocks with:

- `Plugin: telegram`
- `Channel: <chatId>` (same as `ChatId` below — use this when replying)
- `ChatId`, `SenderId`, `SenderName`, `MessageId`, `EventType` (`message` | `edit`)
- `ReplyToMessageId` — present when the user replied to an earlier message
- `MediaGroupId` — present on album / grouped media
- `Attachments` — comma-separated absolute paths to downloaded media files

When the user sends a photo, voice note, video, document, etc., the plugin
downloads it into `plugins/telegram/inbox/` and inlines its absolute path
in the message body as `fileName[/abs/path]`. Read the path directly with
`read` (for text/image) or convert with `markitdown` / `pdftoppm` /
`ffmpeg` (see the harness preamble for conversion guidelines).

## Outbound — `scripts/telegram/telegram-cli`

The CLI reads `TELEGRAM_BOT_TOKEN` from env (injected by the harness from
`secrets.json`) and calls the Telegram Bot API directly. Always pass
`--chat-id <ChatId>` from the inbound metadata.

```
bash scripts/telegram/telegram-cli send-message   --chat-id <ID> --text "..."
bash scripts/telegram/telegram-cli send-message   --chat-id <ID> --text "..." --reply-to <MessageId>
bash scripts/telegram/telegram-cli send-message   --chat-id <ID> --text "*hi*" --parse-mode Markdown
bash scripts/telegram/telegram-cli send-file      --chat-id <ID> --file <path> --type <photo|document|voice|video|audio> [--caption "..."] [--reply-to <ID>]
bash scripts/telegram/telegram-cli edit-message   --chat-id <ID> --message-id <ID> --text "..."
bash scripts/telegram/telegram-cli delete-message --chat-id <ID> --message-id <ID>
bash scripts/telegram/telegram-cli send-reaction  --chat-id <ID> --message-id <ID> --emoji "👍"
```

`send-message` and `send-file` print `{"message_id": <int>}` on success;
the others print `ok`. Errors go to stderr and exit non-zero.

The text generated in your turn is **not** sent to the user — your turn is
internal. Always invoke `telegram-cli send-message` to actually deliver a
reply.
