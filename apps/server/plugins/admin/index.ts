import type {
  Plugin,
  PluginInstanceContext,
  PluginManifest,
} from "../../src/types.js";

/**
 * Built-in plugin auto-installed on every agent. Exposes a single
 * notification, `user_message`, that the operator's POST /admin/<agentId>/send
 * fires. No external state, no webhooks, no scripts (the agent talks back
 * by writing inline — the response visible via the agent's session JSONL).
 */
export default class AdminPlugin implements Plugin {
  manifest: PluginManifest = {
    displayName: "Admin (operator chat)",
    description:
      "Operator → agent channel. POST to /admin/<agentId>/send to deliver a user_message.",
    notifications: [
      { name: "user_message", description: "Operator sent a message." },
    ],
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    secretsSchema: { type: "object", properties: {}, additionalProperties: false },
  };

  private ctx?: PluginInstanceContext;

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    ctx.log.info("admin plugin started");
  }

  async stop(): Promise<void> {
    this.ctx = undefined;
  }

  /**
   * Called by the admin HTTP handler. Validates that the plugin is started,
   * then forwards through the gated `notify`.
   */
  deliver(args: {
    text: string;
    channelId?: string;
    threadIdOverride?: string;
  }): void {
    if (!this.ctx) throw new Error("admin plugin not started");
    this.ctx.notify("user_message", {
      text: args.text,
      channelId: args.channelId ?? "operator",
      threadIdOverride: args.threadIdOverride,
    });
  }
}
