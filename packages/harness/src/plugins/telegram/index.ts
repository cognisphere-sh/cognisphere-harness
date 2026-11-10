import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import type {
  Plugin,
  PluginInstanceContext,
  PluginManifest,
} from "../../core/types.js";

/**
 * Telegram messaging — long-poll transport, Bot API over `fetch` (no SDK).
 *
 * - `start()` kicks off a getUpdates loop. Inbound messages and edits emit
 *   `message_received` / `edited` notifications, with attachment files
 *   downloaded into `<inboxDir>/`. Forum-topic service messages emit
 *   `topic_event`; button taps emit `question_answered` (questions sent with
 *   `telegram-cli ask`) or `button_pressed` (any other inline button).
 * - Outbound is via the seeded `scripts/telegram/telegram-cli` Node script,
 *   which reads `TELEGRAM_BOT_TOKEN` from env and calls the Bot API directly
 *   — no plugin loopback required.
 *
 * Questions (`ask`) keep their state in the message itself: each button's
 * `callback_data` is `ask:s:<i>` (single choice), `ask:m:<i>` (toggle) or
 * `ask:d` (done), optionally suffixed `@<userId>` (only that user may answer)
 * and `#<tag>` (echoed as `QuestionTag`, for the router), and a toggled
 * option's label starts with `✅ `. The plugin answers the tap
 * at once, edits the keyboard, and on the final answer strips the keyboard,
 * appends the answer to the question and emits one event. The CLI builds the
 * same format; keep the two in sync.
 *
 * Any other tap is answered at once without a toast, except a button whose
 * data starts with `wait:` (`"wait": true` in the CLI): its event carries
 * `CallbackQueryId`, and the plugin waits `tapWaitMs` for a workflow to answer
 * it with `telegram-cli answer-tap` before answering silently itself.
 *
 * Threading: the plugin picks no thread. The agent's router
 * (`workspace/router.ts`) decides, e.g. by chat id (`msg.channelId`) or forum
 * topic (`msg.metadata.TopicId`); without a rule, messages go to `main`.
 *
 * Webhook mode is intentionally not supported in v0; polling avoids the
 * public-URL / TLS / verification fuss that webhook mode demands.
 */

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type?: string;
  title?: string;
}
interface TgButton {
  text: string;
  callback_data?: string;
  url?: string;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  /** Absent, or with `date: 0`, when the message is too old to access. */
  message?: TgMessage;
  data?: string;
}
interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}
interface TgFileMeta {
  file_id: string;
  file_size?: number;
  mime_type?: string;
}
interface TgDocument extends TgFileMeta {
  file_name?: string;
}
interface TgVoice extends TgFileMeta {
  duration: number;
}
interface TgAudio extends TgFileMeta {
  duration: number;
}
interface TgVideo extends TgFileMeta {
  duration: number;
}
interface TgVideoNote extends TgFileMeta {
  duration: number;
}
interface TgSticker extends TgFileMeta {
  is_animated?: boolean;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: unknown[];
  /** Set on topic messages (and on reply chains in plain supergroups, which
   *  `is_topic_message` tells apart). */
  message_thread_id?: number;
  is_topic_message?: boolean;
  /** In a topic, a message that isn't a reply carries the topic's creation
   *  message here. */
  reply_to_message?: TgMessage;
  reply_markup?: { inline_keyboard?: TgButton[][] };
  forum_topic_created?: { name: string };
  forum_topic_edited?: { name?: string };
  forum_topic_closed?: object;
  forum_topic_reopened?: object;
  media_group_id?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  voice?: TgVoice;
  audio?: TgAudio;
  video?: TgVideo;
  video_note?: TgVideoNote;
  sticker?: TgSticker;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TelegramConfig {
  /** Long-poll timeout (seconds) passed to getUpdates. Default 25. */
  pollTimeoutSec?: number;
  /** Restrict to these chat ids; messages from other chats are ignored. Empty = allow all. */
  allowedChatIds?: string[];
  /** How long a `wait:` button tap waits for `answer-tap` (ms). Default 5000. */
  tapWaitMs?: number;
}

/** Base URL of the Bot API; overridable for tests. */
const API_URL = process.env.TELEGRAM_API_URL ?? "https://api.telegram.org";
/** Prefix of a toggled option in a multi-choice question. */
const SELECTED = "✅ ";
/** Answered questions remembered to ignore a second tap (bounded). */
const MAX_REMEMBERED = 500;

/** Prefix of a button whose tap a workflow answers (`answer-tap`). */
const WAIT = "wait:";

/** `ask:s:3`, `ask:m:3`, `ask:d`, each optionally `@<userId>` then `#<tag>`. */
function parseAsk(data: string | undefined) {
  const m = /^ask:(?:(s|m):(\d+)|(d))(?:@(\d+))?(?:#([\w.:-]{1,32}))?$/.exec(data ?? "");
  if (!m) return null;
  return {
    kind: (m[1] ?? m[3]) as "s" | "m" | "d",
    index: m[2] === undefined ? -1 : Number(m[2]),
    onlyUser: m[4] === undefined ? undefined : Number(m[4]),
    tag: m[5],
  };
}

const MIME_EXT: Record<string, string> = {
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

export default class TelegramPlugin implements Plugin {
  manifest: PluginManifest = {
    displayName: "Telegram",
    description:
      "Telegram messaging via long-poll. Sends through scripts/telegram/telegram-cli (env-driven).",
    configSchema: {
      type: "object",
      properties: {
        pollTimeoutSec: { type: "integer", default: 25, minimum: 1, maximum: 600 },
        allowedChatIds: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Restrict bot to these chat ids. Empty = allow all.",
        },
        tapWaitMs: {
          type: "integer",
          default: 5000,
          minimum: 0,
          maximum: 15000,
          description:
            "How long a tap on a wait button waits for a workflow's answer-tap before it is answered silently.",
        },
      },
      additionalProperties: false,
    },
    secretsSchema: {
      type: "object",
      properties: {
        TELEGRAM_BOT_TOKEN: { type: "string" },
      },
      additionalProperties: false,
    },
  };

  private ctx?: PluginInstanceContext;
  private token = "";
  private offset = 0;
  private running = false;
  private pollTimeout = 25;
  private allowed: Set<string> | null = null;
  private inFlight: AbortController | null = null;
  private bot: { id: number; username?: string } = { id: 0 };
  /** Forum topic names by `<chatId>:<topicId>`, kept in `state/topics.json`. */
  private topics: Record<string, string> = {};
  /** Keyboards this plugin last set, by `<chatId>:<messageId>`, so fast
   *  toggles build on each other rather than on a stale callback snapshot. */
  private keyboards = new Map<string, TgButton[][]>();
  /** Questions already answered, by `<chatId>:<messageId>`. */
  private answered = new Set<string>();
  private tapWaitMs = 5000;
  /** Silent answers pending for `wait:` taps, cleared on stop. */
  private tapTimers = new Set<NodeJS.Timeout>();

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    this.token = ctx.secrets.TELEGRAM_BOT_TOKEN ?? "";
    if (!this.token) {
      ctx.log.warn("TELEGRAM_BOT_TOKEN not set; telegram plugin disabled");
      return;
    }
    const cfg = (ctx.config as TelegramConfig | undefined) ?? {};
    this.pollTimeout = cfg.pollTimeoutSec ?? 25;
    this.tapWaitMs = cfg.tapWaitMs ?? 5000;
    if (cfg.allowedChatIds && cfg.allowedChatIds.length > 0) {
      this.allowed = new Set(cfg.allowedChatIds.map(String));
    }

    // Drop any pending updates from a previous run to avoid replay.
    try {
      const me = await this.api<{ id: number; username?: string }>("getMe", {});
      this.bot = me;
      ctx.log.info({ bot: me.username, id: me.id }, "telegram authenticated");
    } catch (err) {
      ctx.log.error({ err }, "telegram getMe failed; check TELEGRAM_BOT_TOKEN");
      return;
    }

    try {
      this.topics = JSON.parse(await readFile(this.topicsFile(), "utf8")) as Record<string, string>;
    } catch {
      this.topics = {};
    }

    this.running = true;
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.inFlight?.abort();
    this.inFlight = null;
    for (const t of this.tapTimers) clearTimeout(t);
    this.tapTimers.clear();
    this.ctx = undefined;
  }

  // ── poll loop ────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    if (!this.ctx) return;
    const log = this.ctx.log;
    while (this.running) {
      try {
        const ac = new AbortController();
        this.inFlight = ac;
        const updates = await this.api<TgUpdate[]>(
          "getUpdates",
          {
            offset: this.offset,
            timeout: this.pollTimeout,
            allowed_updates: ["message", "edited_message", "callback_query"],
          },
          { signal: ac.signal, timeoutMs: (this.pollTimeout + 5) * 1000 },
        );
        this.inFlight = null;
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          try {
            await this.handleUpdate(u);
          } catch (err) {
            log.error({ err, update: u.update_id }, "update handler crashed");
          }
        }
      } catch (err) {
        this.inFlight = null;
        if (!this.running) return;
        log.warn({ err: (err as Error).message }, "poll error; backing off 5s");
        await sleep(5000);
      }
    }
  }

  private async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const msg = u.message ?? u.edited_message;
    if (!msg) return;
    const isEdit = u.edited_message !== undefined;
    const chatId = String(msg.chat.id);
    if (this.allowed && !this.allowed.has(chatId)) return;
    if (!this.ctx) return;

    this.learnTopic(msg);
    const topicEvent = msg.forum_topic_created
      ? "created"
      : msg.forum_topic_edited
        ? "edited"
        : msg.forum_topic_closed
          ? "closed"
          : msg.forum_topic_reopened
            ? "reopened"
            : undefined;
    if (topicEvent) {
      const meta = this.context(msg, msg.from);
      this.ctx.notify("topic_event", {
        text: `[${meta.SenderName} ${topicEvent} the topic "${meta.TopicName ?? meta.TopicId}"]`,
        channelId: chatId,
        metadata: { ...meta, MessageId: msg.message_id, TopicEvent: topicEvent },
      });
      return;
    }

    const attachments = await this.downloadAttachments(msg);
    const baseText = msg.text ?? msg.caption ?? "";
    const text =
      attachments.length > 0
        ? `${baseText}${baseText ? "\n\n" : ""}${attachments
          .map((p) => `${basename(p)}[${p}]`)
          .join("\n")}`
        : baseText;

    // In a topic, a message that isn't a reply points at the topic's
    // creation message; that isn't a reply the agent cares about.
    const r = msg.reply_to_message;
    const reply =
      r && !r.forum_topic_created && !(msg.is_topic_message && r.message_id === msg.message_thread_id)
        ? r
        : undefined;
    const mention = this.bot.username ? `@${this.bot.username.toLowerCase()}` : undefined;

    this.ctx.notify(isEdit ? "edited" : "message_received", {
      text,
      channelId: chatId,
      metadata: {
        ...this.context(msg, msg.from),
        MessageId: msg.message_id,
        EventType: isEdit ? "edit" : "message",
        ReplyToMessageId: reply?.message_id,
        ReplyToBot: reply?.from?.id === this.bot.id || undefined,
        MentionsBot: (mention !== undefined && baseText.toLowerCase().includes(mention)) || undefined,
        MediaGroupId: msg.media_group_id,
        Attachments: attachments.length > 0 ? attachments : undefined,
      },
    });
  }

  /** Who and where: the metadata every event carries, so a router rule by
   *  chat or topic catches messages and button taps alike. */
  private context(m: TgMessage, from: TgUser | undefined) {
    const topicId = topicOf(m);
    return {
      SenderId: from?.id,
      SenderName: senderName(from),
      SenderUsername: from?.username,
      ChatType: m.chat.type,
      ChatTitle: m.chat.title,
      TopicId: topicId,
      TopicName: topicId === undefined ? undefined : this.topics[`${m.chat.id}:${topicId}`],
    };
  }

  // ── forum topics ─────────────────────────────────────────────────────

  private topicsFile(): string {
    return join(this.ctx!.stateDir, "topics.json");
  }

  /** Remember topic names from creation/edit messages, so every event in a
   *  topic can carry `TopicName`. */
  private learnTopic(m: TgMessage): void {
    const topicId = topicOf(m);
    if (topicId === undefined) return;
    const root = m.reply_to_message?.message_id === topicId ? m.reply_to_message : undefined;
    const name = m.forum_topic_created?.name ?? m.forum_topic_edited?.name ?? root?.forum_topic_created?.name;
    const key = `${m.chat.id}:${topicId}`;
    if (!name || this.topics[key] === name || !this.ctx) return;
    // A rename seen on a reply to the creation message is the old name.
    if (!m.forum_topic_created && !m.forum_topic_edited && this.topics[key]) return;
    this.topics[key] = name;
    const log = this.ctx.log;
    writeFile(this.topicsFile(), JSON.stringify(this.topics, null, 2)).catch((err: unknown) =>
      log.warn({ err }, "could not save telegram topic names"),
    );
  }

  // ── buttons ──────────────────────────────────────────────────────────

  private async handleCallback(q: TgCallbackQuery): Promise<void> {
    const m = q.message;
    // A message older than Telegram keeps accessible has `date: 0`.
    if (!m || !m.date || !this.ctx || (this.allowed && !this.allowed.has(String(m.chat.id)))) {
      await this.answer(q.id);
      return;
    }
    const chatId = String(m.chat.id);
    const key = `${chatId}:${m.message_id}`;
    const ask = parseAsk(q.data);
    const where = { ...this.context(m, q.from), MessageId: m.message_id };

    if (!ask) {
      const held = q.data?.startsWith(WAIT) === true;
      if (held) {
        // A workflow answers with its own toast; answer silently if it doesn't.
        const t = setTimeout(() => {
          this.tapTimers.delete(t);
          void this.answer(q.id);
        }, this.tapWaitMs);
        this.tapTimers.add(t);
      } else {
        await this.answer(q.id);
      }
      const button = (m.reply_markup?.inline_keyboard ?? []).flat().find((b) => b.callback_data === q.data);
      this.ctx.notify("button_pressed", {
        text: `[${where.SenderName} pressed "${button?.text ?? q.data}" on message ${m.message_id}]`,
        channelId: chatId,
        metadata: {
          ...where,
          CallbackData: held ? q.data!.slice(WAIT.length) : q.data,
          CallbackQueryId: held ? q.id : undefined,
          ButtonText: button?.text,
          MessageText: snippet(m.text ?? m.caption),
        },
      });
      return;
    }

    if (ask.onlyUser !== undefined && ask.onlyUser !== q.from.id) {
      await this.answer(q.id, "This question is for someone else.", true);
      return;
    }
    if (this.answered.has(key)) {
      await this.answer(q.id, "Already answered.");
      return;
    }
    const keyboard = this.keyboards.get(key) ?? m.reply_markup?.inline_keyboard ?? [];

    if (ask.kind === "m") {
      const next = keyboard.map((row) =>
        row.map((b) => {
          if (b.callback_data !== q.data) return b;
          const on = b.text.startsWith(SELECTED);
          return { ...b, text: on ? b.text.slice(SELECTED.length) : SELECTED + b.text };
        }),
      );
      remember(this.keyboards, key, next);
      await this.answer(q.id);
      await this.api("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: m.message_id,
        reply_markup: { inline_keyboard: next },
      }).catch((err: unknown) => this.ctx?.log.warn({ err }, "telegram toggle edit failed"));
      return;
    }

    const options = keyboard
      .flat()
      .map((b) => ({ b, a: parseAsk(b.callback_data) }))
      .filter((x) => x.a && x.a.kind !== "d");
    const chosen =
      ask.kind === "s"
        ? options.filter((x) => x.a!.index === ask.index)
        : options.filter((x) => x.b.text.startsWith(SELECTED));
    if (chosen.length === 0) {
      await this.answer(q.id, ask.kind === "d" ? "Pick at least one option first." : undefined);
      return;
    }
    const answers = chosen.map((x) =>
      x.b.text.startsWith(SELECTED) ? x.b.text.slice(SELECTED.length) : x.b.text,
    );
    remember(this.answered, key);
    this.keyboards.delete(key);
    await this.answer(q.id, `✅ ${answers.join(", ")}`);
    await this.closeQuestion(m, `✅ ${where.SenderName}: ${answers.join(", ")}`);
    this.ctx.notify("question_answered", {
      text: `[${where.SenderName} answered "${snippet(m.text ?? m.caption)}": ${answers.join(", ")}]`,
      channelId: chatId,
      metadata: {
        ...where,
        Question: snippet(m.text ?? m.caption),
        Answers: answers,
        AnswerIndexes: chosen.map((x) => x.a!.index),
        QuestionTag: ask.tag,
      },
    });
  }

  /** Remove a question's buttons and append the answer, keeping its
   *  formatting (the appended text comes after every entity). */
  private async closeQuestion(m: TgMessage, line: string): Promise<void> {
    const base = { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [] } };
    try {
      await this.api("editMessageText", { ...base, text: `${m.text ?? ""}\n\n${line}`, entities: m.entities });
    } catch (err) {
      this.ctx?.log.warn({ err }, "telegram question edit failed; removing buttons only");
      await this.api("editMessageReplyMarkup", base).catch(() => undefined);
    }
  }

  /** Stop the tap's spinner (optionally with a toast). Telegram rejects late
   *  or repeated answers; that's harmless. */
  private async answer(id: string, text?: string, alert = false): Promise<void> {
    await this.api("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text: text.slice(0, 200), show_alert: alert } : {}),
    }).catch((err: unknown) => this.ctx?.log.debug({ err }, "telegram answerCallbackQuery failed"));
  }

  // ── attachments ──────────────────────────────────────────────────────

  private async downloadAttachments(msg: TgMessage): Promise<string[]> {
    const jobs: Array<Promise<string | null>> = [];
    if (msg.voice) jobs.push(this.dl(msg.voice.file_id, `voice_${msg.message_id}`, msg.voice.mime_type));
    if (msg.audio) jobs.push(this.dl(msg.audio.file_id, `audio_${msg.message_id}`, msg.audio.mime_type));
    if (msg.video) jobs.push(this.dl(msg.video.file_id, `video_${msg.message_id}`, msg.video.mime_type));
    if (msg.video_note) jobs.push(this.dl(msg.video_note.file_id, `videonote_${msg.message_id}`));
    if (msg.document) {
      const name = msg.document.file_name ?? `document_${msg.message_id}`;
      jobs.push(this.dl(msg.document.file_id, name, msg.document.mime_type));
    }
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1]!;
      jobs.push(this.dl(largest.file_id, `photo_${msg.message_id}`, "image/jpeg"));
    }
    if (msg.sticker) {
      const mime = msg.sticker.is_animated ? "application/x-tgsticker" : "image/webp";
      jobs.push(this.dl(msg.sticker.file_id, `sticker_${msg.message_id}`, mime));
    }
    const out: string[] = [];
    for (const r of await Promise.all(jobs)) if (r) out.push(r);
    return out;
  }

  private async dl(
    fileId: string,
    baseName: string,
    mimeType?: string,
  ): Promise<string | null> {
    if (!this.ctx) return null;
    try {
      const file = await this.api<{ file_path?: string }>("getFile", { file_id: fileId });
      if (!file.file_path) return null;
      const ext = extname(file.file_path) || (mimeType ? MIME_EXT[mimeType] ?? "" : "");
      const filename = baseName.includes(".") ? baseName : `${baseName}${ext}`;
      const localPath = join(this.ctx.inboxDir, filename);
      const url = `${API_URL}/file/bot${this.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(localPath, buf);
      // Return path relative to agentDir so chat shows just the filename
      // (linkified) and the agent — which runs with cwd=agentDir — can read
      // it directly.
      return relative(this.ctx.agentDir, localPath);
    } catch (err) {
      this.ctx.log.error({ err, fileId }, "telegram file download failed");
      return null;
    }
  }

  // ── bot api wrapper ──────────────────────────────────────────────────

  private async api<T>(
    method: string,
    body: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    const url = `${API_URL}/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) {
      throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
    }
    return json.result as T;
  }
}

function senderName(u?: TgUser): string {
  if (!u) return "unknown";
  const parts = [u.first_name, u.last_name].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : `user ${u.id}`;
}

/** The forum topic a message is in, if any. `message_thread_id` alone also
 *  marks a reply chain in a plain supergroup, so it needs `is_topic_message`
 *  (or a topic service message, whose own id is the topic's). */
function topicOf(m: TgMessage): number | undefined {
  if (m.forum_topic_created) return m.message_thread_id ?? m.message_id;
  const service = m.forum_topic_edited ?? m.forum_topic_closed ?? m.forum_topic_reopened;
  return m.is_topic_message || service ? m.message_thread_id : undefined;
}

/** The first line of a message, cut to 200 characters, for event text. */
function snippet(s: string | undefined): string {
  const line = (s ?? "").split("\n")[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** Add to a bounded Map/Set, dropping the oldest entry when full. */
function remember<K, V>(c: Map<K, V> | Set<K>, key: K, value?: V): void {
  c.delete(key);
  if (c instanceof Map) c.set(key, value as V);
  else c.add(key);
  if (c.size > MAX_REMEMBERED) c.delete(c.keys().next().value as K);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
