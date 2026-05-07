import { Hono } from "hono";
import type { AgentManager } from "../agent-manager.js";

/**
 * /admin/<agentId>/{send,abort}
 *
 *   POST /admin/<id>/send  { text, channelId?, threadId? }
 *   POST /admin/<id>/abort { threadId }
 *
 * `send` goes through the admin plugin's `deliver()` like any other plugin
 * notification — the runner decides whether to enqueue or steer based on
 * active-batch state. There is no operator-only steer endpoint.
 */
export function adminRouter(am: AgentManager): Hono {
  const r = new Hono();

  r.post("/:agentId/send", async (c) => {
    const agentId = c.req.param("agentId");
    const inst = am.get(agentId);
    if (!inst) return c.json({ error: `unknown agent: ${agentId}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string;
      channelId?: string;
      threadId?: string;
    };
    if (typeof body.text !== "string" || !body.text) {
      return c.json({ error: "missing text" }, 400);
    }
    const admin = inst.adminPlugin;
    if (!admin) {
      return c.json({ error: "admin plugin not installed on this agent" }, 500);
    }
    admin.deliver({
      text: body.text,
      channelId: body.channelId,
      threadIdOverride: body.threadId,
    });
    return c.json({ ok: true });
  });

  r.post("/:agentId/abort", async (c) => {
    const agentId = c.req.param("agentId");
    const inst = am.get(agentId);
    if (!inst) return c.json({ error: `unknown agent: ${agentId}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { threadId?: string };
    if (!body.threadId) return c.json({ error: "missing threadId" }, 400);
    const ok = inst.runner.abort(body.threadId);
    return c.json({ ok });
  });

  return r;
}
