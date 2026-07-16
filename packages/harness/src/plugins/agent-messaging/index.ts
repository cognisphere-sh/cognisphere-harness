import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Plugin,
  PluginInstanceContext,
  PluginManifest,
} from "../../core/types.js";

/**
 * agent-messaging — inter- and intra-agent messaging.
 *
 * Lets one agent drop a message onto another agent's thread (INTER-agent, e.g.
 * agent A → agent B's thread) or onto a different thread of its own
 * (INTRA-agent, e.g. thread A → thread B of the same agent). Each enabled
 * agent gets:
 *   - an HTTP inbox at  /webhook/<agent>/agent-messaging/api/send  (this handler)
 *   - the seeded `scripts/agent-msg/send` CLI, which POSTs to the TARGET
 *     agent's inbox above.
 *
 * Why HTTP and not a shared bus: a plugin's `ctx.notify` only wakes its OWN
 * agent. So to reach agent X we POST to X's webhook; X's own plugin instance
 * receives it and notifies X on the target thread. Same path serves the
 * intra-agent case — the sender just POSTs to its own agent's webhook with a
 * different thread id.
 *
 * Delivery: `ctx.notify(..., threadIdOverride = target thread)` lands the
 * message on that exact thread. By default it STEERS (the receiving agent
 * acts on it); `silent` logs it for awareness without prompting action.
 *
 * ponytail: routing is just (target agent, target thread) — one event kind,
 *   one CLI, no separate message bus. To go live this contract is unchanged;
 *   only the transport (an internal queue vs. localhost HTTP) would move.
 */
export default class AgentMessagingPlugin implements Plugin {
  manifest: PluginManifest = {
    displayName: "Agent Messaging",
    description:
      "Inter-/intra-agent messaging. Receives agent-to-agent notes at /webhook/<agent>/agent-messaging/api/send and wakes the target agent on the target thread.",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    secretsSchema: { type: "object", properties: {}, additionalProperties: false },
  };

  private ctx?: PluginInstanceContext;

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    ctx.log.info(
      "agent-messaging started — inbox at /webhook/" + ctx.agentId + "/agent-messaging/api/send",
    );
  }

  async stop(): Promise<void> {
    this.ctx = undefined;
  }

  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "plugin not started" }));
      return;
    }
    const url = new URL(req.url || "/", "http://local");
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const readBody = async (): Promise<Record<string, unknown>> => {
      let s = "";
      for await (const c of req) s += c;
      return s ? (JSON.parse(s) as Record<string, unknown>) : {};
    };
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(
          "agent-messaging plugin — POST api/send {from_agent, from_thread_id, thread_id, message, subject?, silent?}",
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/send") {
        const b = await readBody();
        const thread = String(b.thread_id ?? b.thread ?? "").trim();
        const message = String(b.message ?? "").trim();
        const from = String(b.from_agent ?? b.from ?? "").trim();
        const fromThread = String(b.from_thread_id ?? "").trim();
        if (!thread || !message || !from || !fromThread)
          return json(400, {
            error: "thread_id, message, from_agent and from_thread_id required",
          });
        const silent = b.silent === true;
        const subject = b.subject ? String(b.subject) : "";
        // Sender identity travels in metadata (From/FromThread/Subject); the
        // seeded plugin prompt documents the fields and how to reply.
        ctx.notify("agent_message", {
          text: message,
          channelId: "agent",
          threadIdOverride: thread,
          ...(silent ? { isSilent: true, doNotSteer: true } : {}),
          metadata: {
            from,
            fromThread,
            ...(subject ? { subject } : {}),
          },
        });
        return json(200, { ok: true, to: ctx.agentId, thread, silent });
      }
      json(404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) json(500, { error: String(e) });
    }
  }
}
