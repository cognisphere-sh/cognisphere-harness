import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Plugin,
  PluginInstanceContext,
  PluginManifest,
} from "../../src/types.js";

/**
 * STUB. Manifest + lifecycle + webhook handler shell only — the actual
 * Telegram bot client and `setWebhook` call are deferred (need a real
 * bot token to test). The plugin still:
 *   - declares its schemas, so install/config validates correctly
 *   - exposes `handleHttpRequest`, so the server registers the webhook URL
 *   - emits a `message_received` notification when something POSTs
 *
 * To finish: wire ctx.secrets.TELEGRAM_BOT_TOKEN to a Telegram client,
 * call setWebhook(ctx.httpBaseUrl) in start(), parse Update objects in
 * handleHttpRequest, save photos/files to ctx.inboxDir, and add an
 * `/internal/send` route plus a scripts/telegram/telegram-cli script.
 */
export default class TelegramPlugin implements Plugin {
  manifest: PluginManifest = {
    displayName: "Telegram (stub)",
    description: "Telegram messaging — stub. See index.ts for what to finish.",
    notifications: [
      { name: "message_received", description: "User sent a message in chat." },
      { name: "edited", description: "User edited a previous message." },
    ],
    configSchema: {
      type: "object",
      properties: {
        defaultChatId: { type: "string" },
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

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    if (!ctx.secrets.TELEGRAM_BOT_TOKEN) {
      ctx.log.warn("TELEGRAM_BOT_TOKEN not set; webhook will only echo");
    }
    ctx.log.info({ httpBase: ctx.httpBaseUrl }, "telegram stub started");
  }

  async stop(): Promise<void> {
    this.ctx = undefined;
  }

  async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.ctx) {
      res.writeHead(503).end("not started");
      return;
    }
    if (req.url === "/internal/send") {
      res.writeHead(501).end("send not implemented (stub)");
      return;
    }
    // Treat everything else as an inbound Update.
    let body = "";
    for await (const c of req) body += (c as Buffer).toString("utf8");
    this.ctx.log.info({ snippet: body.slice(0, 200) }, "telegram inbound");
    try {
      const upd = JSON.parse(body || "{}") as {
        message?: { text?: string; chat?: { id?: number } };
      };
      const text = upd.message?.text;
      const chatId = upd.message?.chat?.id;
      if (text && chatId !== undefined) {
        this.ctx.notify("message_received", {
          text,
          channelId: String(chatId),
        });
      }
    } catch {
      /* ignore malformed bodies */
    }
    res.writeHead(200).end();
  }
}
