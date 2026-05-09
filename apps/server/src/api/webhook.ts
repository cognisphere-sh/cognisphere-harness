import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentManager } from "../agent-manager.js";
import type { Logger } from "../logger.js";

/**
 * Pure-Node handler for /webhook/<agentId>/<pluginId>/<rest>. Hono is overkill
 * here — we strip the prefix and hand the request straight to the plugin's
 * `handleHttpRequest`, which expects raw IncomingMessage / ServerResponse.
 *
 * Returns true if the URL matched the webhook prefix (router consumed it).
 */
export async function maybeHandleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  am: AgentManager,
  log: Logger,
): Promise<boolean> {
  const url = req.url ?? "/";
  if (!url.startsWith("/webhook/")) return false;

  // Path AFTER /webhook/. Split into [agentId, pluginId, ...rest]
  const tail = url.slice("/webhook/".length);
  const qIdx = tail.indexOf("?");
  const pathPart = qIdx === -1 ? tail : tail.slice(0, qIdx);
  const queryPart = qIdx === -1 ? "" : tail.slice(qIdx);

  const segments = pathPart.split("/");
  const agentId = segments[0];
  const pluginId = segments[1];
  const rest = "/" + segments.slice(2).join("/");

  if (!agentId || !pluginId) {
    res.writeHead(404).end("missing agentId/pluginId");
    return true;
  }

  const inst = am.get(agentId);
  if (!inst) {
    res.writeHead(404).end(`unknown agent: ${agentId}`);
    return true;
  }
  const plugin = inst.plugins.get(pluginId);
  if (
    !plugin ||
    plugin.state !== "running" ||
    !plugin.instance ||
    !plugin.instance.handleHttpRequest
  ) {
    res.writeHead(404).end(`unknown plugin or no http handler: ${pluginId}`);
    return true;
  }

  // Rewrite req.url to /<rest>?<query> so the plugin sees a clean path.
  req.url = rest + queryPart;
  try {
    await plugin.instance.handleHttpRequest(req, res);
  } catch (err) {
    log.error({ err, agentId, pluginId, rest }, "webhook handler threw");
    if (!res.headersSent) {
      res.writeHead(500).end("plugin handler error");
    } else if (!res.writableEnded) {
      res.end();
    }
  }
  return true;
}
