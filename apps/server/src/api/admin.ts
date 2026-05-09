import { Hono } from "hono";
import { getAdminPlugin, type AgentManager } from "../agent-manager.js";

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
    const admin = getAdminPlugin(inst);
    if (!admin) {
      const installed = inst.plugins.has("admin");
      const reason = installed
        ? `admin plugin not running (agent state=${inst.state})`
        : "admin plugin not installed on this agent";
      return c.json({ error: reason }, installed ? 503 : 500);
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
    if (!inst.runner) {
      return c.json({ error: "agent not running" }, 503);
    }
    const ok = inst.runner.abort(body.threadId);
    return c.json({ ok });
  });

  return r;
}
