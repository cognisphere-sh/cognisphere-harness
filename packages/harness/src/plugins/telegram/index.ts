import { writeFile } from "node:fs/promises";
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
 *   downloaded into `<inboxDir>/`.
 * - Outbound is via the seeded `scripts/telegram/telegram-cli` Node script,
 *   which reads `TELEGRAM_BOT_TOKEN` from env and calls the Bot API directly
 *   — no plugin loopback required.
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
  reply_to_message?: { message_id: number };
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
}

interface TelegramConfig {
  /** Long-poll timeout (seconds) passed to getUpdates. Default 25. */
  pollTimeoutSec?: number;
  /** Restrict to these chat ids; messages from other chats are ignored. Empty = allow all. */
  allowedChatIds?: string[];
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

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    this.token = ctx.secrets.TELEGRAM_BOT_TOKEN ?? "";
    if (!this.token) {
      ctx.log.warn("TELEGRAM_BOT_TOKEN not set; telegram plugin disabled");
      return;
    }
    const cfg = (ctx.config as TelegramConfig | undefined) ?? {};
    this.pollTimeout = cfg.pollTimeoutSec ?? 25;
    if (cfg.allowedChatIds && cfg.allowedChatIds.length > 0) {
      this.allowed = new Set(cfg.allowedChatIds.map(String));
    }

    // Drop any pending updates from a previous run to avoid replay.
    try {
      const me = await this.api<{ id: number; username?: string }>("getMe", {});
      ctx.log.info({ bot: me.username, id: me.id }, "telegram authenticated");
    } catch (err) {
      ctx.log.error({ err }, "telegram getMe failed; check TELEGRAM_BOT_TOKEN");
      return;
    }

    this.running = true;
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.inFlight?.abort();
    this.inFlight = null;
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
            allowed_updates: ["message", "edited_message"],
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
    const msg = u.message ?? u.edited_message;
    if (!msg) return;
    const isEdit = u.edited_message !== undefined;
    const chatId = String(msg.chat.id);
    if (this.allowed && !this.allowed.has(chatId)) return;
    if (!this.ctx) return;

    // `/reset` is handled by the plugin, never delivered to the agent: wipe
    // the thread's context so the next message starts a fresh session.
    if (!isEdit && /^\/reset(@\w+)?$/.test((msg.text ?? "").trim())) {
      let reply: string;
      try {
        this.ctx.resetThread(chatId);
        reply = "Context reset — starting fresh.";
      } catch (err) {
        reply = `Reset failed: ${(err as Error).message}`;
      }
      await this.api("sendMessage", { chat_id: chatId, text: reply });
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

    this.ctx.notify(isEdit ? "edited" : "message_received", {
      text,
      channelId: chatId,
      metadata: {
        SenderId: msg.from?.id,
        SenderName: senderName(msg.from),
        MessageId: msg.message_id,
        EventType: isEdit ? "edit" : "message",
        ReplyToMessageId: msg.reply_to_message?.message_id,
        MediaGroupId: msg.media_group_id,
        Attachments: attachments.length > 0 ? attachments : undefined,
      },
    });
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
      const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
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
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
