import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminRouter } from "./api/admin.js";
import { maybeHandleWebhook } from "./api/webhook.js";
import { AgentManager } from "./agent-manager.js";
import {
  loadConfig,
  userPluginsRoot,
} from "./config.js";
import { childLogger, rootLogger } from "./logger.js";
import { PluginRegistry } from "./plugin-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_PLUGINS_DIR = resolve(HERE, "../plugins");

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = rootLogger();
  log.info({ cfg }, "boot");

  const registry = new PluginRegistry(
    BUILTIN_PLUGINS_DIR,
    userPluginsRoot(cfg),
    childLogger("plugin-registry"),
  );
  await registry.scan();

  const am = new AgentManager(cfg, registry, childLogger("agent-manager"));
  await am.boot();

  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, agents: am.list().length }));
  app.route("/admin", adminRouter(am));
  app.get("/", (c) => c.json({ name: "pi-harness v2", agents: am.list() }));

  // Wrap the Hono fetch handler so /webhook/* takes precedence (and gets the
  // raw IncomingMessage/ServerResponse the plugin's handleHttpRequest expects).
  const honoFetch = app.fetch.bind(app);
  const server = serve(
    {
      fetch: honoFetch,
      port: cfg.port,
      hostname: cfg.bindHost,
    },
    (info) => {
      log.info({ host: info.address, port: info.port }, "http server listening");
    },
  );

  // The @hono/node-server runs Hono via Node http.Server. Splice in our
  // webhook router before Hono sees the request.
  const httpServer = server as unknown as {
    on(ev: "request", cb: (...args: unknown[]) => void): void;
    listeners(ev: string): Array<(...args: unknown[]) => void>;
    removeAllListeners(ev: "request"): void;
  };
  const honoListeners = httpServer.listeners("request");
  httpServer.removeAllListeners("request");
  const wlog = childLogger("webhook");
  httpServer.on("request", async (...args) => {
    const [req, res] = args as [
      import("node:http").IncomingMessage,
      import("node:http").ServerResponse,
    ];
    const handled = await maybeHandleWebhook(req, res, am, wlog);
    if (handled) return;
    for (const fn of honoListeners) fn(req, res);
  });

  const shutdown = async () => {
    log.info("shutdown");
    await am.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  rootLogger().error({ err }, "fatal");
  process.exit(1);
});
