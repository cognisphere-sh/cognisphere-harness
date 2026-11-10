# Plugin: telegram

Connects you to a Telegram bot. The plugin long-polls server-side, so no
public webhook URL is needed.

## Inbound

Messages and edits arrive as `<harness-metadata>` blocks with `Plugin:
telegram`, `Channel` (the chat id — pass it back when replying), `SenderId`,
`SenderName`, `ChatType` (`private` | `group` | `supergroup`), `ChatTitle`,
`MessageId`, `EventType` (`message` | `edit`), plus `ReplyToMessageId` (and
`ReplyToBot`) when the user replied to an earlier message, `MentionsBot` when
they @-mentioned you, and `MediaGroupId` on album / grouped media (each album
item arrives as its own message).

In a forum group (topics), events also carry `TopicId` and `TopicName`. Reply
in the same topic with `--topic-id <TopicId>`; without it a send lands in
General. Topic service events arrive as `topic_event` (`TopicEvent`:
`created` | `edited` | `closed` | `reopened`).

Button taps arrive as their own events, in the same chat and topic:
- `question_answered` — someone answered an `ask` question: `Answers` (labels),
  `AnswerIndexes`, `Question`, `QuestionTag` (the `--tag` you gave),
  `MessageId` (the question), `SenderName`. The question already shows the
  answer and its buttons are gone.
- `button_pressed` — a tap on a `--buttons` button: `CallbackData`,
  `ButtonText`, `MessageId`, `MessageText`. Update the message yourself
  (`edit-message` / `edit-buttons`) so the tapper sees a result.

Photos, voice notes, videos and documents are downloaded into
`plugins/telegram/inbox/` and inlined in the body as
`<fileName>[plugins/telegram/inbox/<name>.<ext>]`. Read text and images with
`read`; convert anything else with `markitdown` / `pdftoppm` / `ffmpeg` (see
the harness preamble).

The plugin picks no thread: Telegram events go to `main` unless your router
(`workspace/router.ts`) sends them elsewhere. Rules can use the chat
(`msg.channelId`), the topic (`msg.metadata.TopicId` / `TopicName`), the event
(`msg.notification`, e.g. `question_answered`), `msg.metadata.QuestionTag` or
`msg.metadata.CallbackData`,
e.g. one thread per topic:
`if (msg.pluginId === "telegram" && msg.metadata.TopicId) return "telegram:" + msg.channelId + ":" + msg.metadata.TopicId;`.

## Outbound — `scripts/telegram/telegram-cli`

Always pass `--chat-id <Channel>`, and `--topic-id <TopicId>` when the event
had one. Sends also take `--reply-to <MessageId>` and `--silent`.

```
telegram-cli send-message --chat-id <ID> --text "..." [--buttons JSON | --force-reply [--placeholder "..."]] [--no-preview]
telegram-cli send-file    --chat-id <ID> --file <path> --type <photo|document|voice|video|audio> [--caption "..."] [--buttons JSON]
telegram-cli send-album   --chat-id <ID> --file <a> --file <b> ... [--caption "..."]
telegram-cli ask          --chat-id <ID> --text "Question?" --option "A" --option "B" [--multi] [--only-user <SenderId>] [--tag <key>] [--columns 2]
telegram-cli send-poll    --chat-id <ID> --question "..." --option "A" --option "B" [--multi] [--anonymous]   (stop-poll prints results)
telegram-cli edit-message --chat-id <ID> --message-id <ID> --text "..." [--buttons JSON]
telegram-cli edit-buttons --chat-id <ID> --message-id <ID> --buttons JSON        ('[]' removes them)
telegram-cli delete-message | pin-message | unpin-message --chat-id <ID> --message-id <ID>
telegram-cli send-reaction --chat-id <ID> --message-id <ID> --emoji "👍"
telegram-cli chat-action  --chat-id <ID> [--action typing]
telegram-cli answer-tap   --id <CallbackQueryId> [--text "toast"] [--alert]
telegram-cli create-topic --chat-id <ID> --name "..."   |  edit-topic / close-topic / reopen-topic / delete-topic --topic-id <ID>
telegram-cli set-commands --commands '[{"command":"queue","description":"Show the queue"}]'
```

(`bash scripts/telegram/telegram-cli …`; `--help` lists every flag.) Sends print
`{"message_id": <int>}` (`send-album`: `message_ids`, `create-topic`:
`topic_id`); the rest print `ok`. Errors go to stderr with a non-zero exit.

- **Questions:** use `ask` for a choice — tap-to-answer beats typing. With
  `--multi` people toggle options and tap Done. `--only-user` stops others in
  a group answering. `--tag` names the question so your router can send the
  answer somewhere specific (e.g. back to the workflow that asked). For a
  group vote, use `send-poll`.
- **Buttons:** `--buttons '[[{"text":"Approve","data":"ok:12"},{"text":"Docs","url":"https://…"}]]'`
  (rows; `data` is 1–64 bytes and comes back as `CallbackData`). When editing
  the text of a message with buttons, pass `--buttons` again. Taps are
  acknowledged for you, with no toast — except a button with `"wait": true`,
  meant for a workflow: its event carries `CallbackQueryId`, the tap spins until
  the workflow runs `answer-tap` with a toast (or a few seconds pass; then
  `answer-tap` prints `late` and still exits 0), and `CallbackData` arrives
  without the `wait:` prefix. Route `wait` buttons to a workflow, not to
  yourself: a turn is too slow, so the tap just spins.
- **Free-text answers in groups:** `--force-reply` opens the reply box, and
  replies reach you even if the bot can't read every group message.
- **Long work:** `chat-action` shows "typing…" for ~5 s; send it before slow
  tasks. Mention a person with `[Name](tg://user?id=<SenderId>)`.
- **Topics** need the bot to be an admin with "Manage topics".
- Write `--text` / `--caption` in standard markdown (`**bold**`, `` `code` ``,
  lists, links) — the CLI converts it to Telegram formatting. Don't pass
  `--parse-mode` unless you need raw Telegram Markdown/HTML.
- Telegram has no real tables: markdown tables render as monospace blocks, so
  keep them to 2–3 narrow columns (phone screens) or use bullet lists.
- Your turn is internal — the text you generate is **not** delivered. Nothing
  reaches the user until you actually run `telegram-cli send-message`.
