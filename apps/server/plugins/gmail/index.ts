import type {
  Plugin,
  PluginInstanceContext,
  PluginManifest,
} from "../../src/types.js";

/**
 * STUB. Manifest + lifecycle only — actual IMAP/Gmail-API polling deferred.
 *
 * To finish: schedule a poll loop in start() that hits Gmail with the
 * GMAIL_OAUTH_TOKEN, emits `email_received` per new thread, saves
 * attachments to ctx.inboxDir, and adds a scripts/gmail/gmail-cli for
 * outbound send.
 */
export default class GmailPlugin implements Plugin {
  manifest: PluginManifest = {
    displayName: "Gmail (stub)",
    description: "Gmail polling — stub. See index.ts for what to finish.",
    configSchema: {
      type: "object",
      properties: {
        pollIntervalSec: { type: "number", minimum: 30, default: 120 },
        labelFilter: { type: "string" },
      },
      additionalProperties: false,
    },
    secretsSchema: {
      type: "object",
      properties: {
        GMAIL_OAUTH_TOKEN: { type: "string" },
      },
      additionalProperties: false,
    },
  };

  private ctx?: PluginInstanceContext;

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    if (!ctx.secrets.GMAIL_OAUTH_TOKEN) {
      ctx.log.warn("GMAIL_OAUTH_TOKEN not set; gmail stub will not poll");
    }
    ctx.log.info("gmail stub started (no-op)");
  }

  async stop(): Promise<void> {
    this.ctx = undefined;
  }
}
