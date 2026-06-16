import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminRouter } from "../api/admin.js";
import { agentsRouter } from "../api/agents.js";
import {
  authRouter,
  makeAuthStore,
  redirectIfUnauthenticated,
  requireAuth,
} from "../api/auth.js";
import { filesRouter } from "../api/files.js";
import { harnessRouter } from "../api/harness.js";
import { modelsRouter } from "../api/models.js";
import { secretsRouter } from "../api/secrets.js";
import { maybeHandleWebhook } from "../api/webhook.js";
import { AgentManager } from "./agent-manager.js";
import { loadConfig, userPluginsRoot } from "./config.js";
import { childLogger, rootLogger } from "./logger.js";
import { PluginRegistry } from "./plugin-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_PLUGINS_DIR = resolve(HERE, "../plugins");
const WEB_DIST_DIR = resolveWebDist(HERE);

/**
 * The built UI ships in two layouts: the published package bundles it at
 * `<pkg>/dist-web` (via the `prepack` web-bundle step), while the monorepo
 * keeps it in the sibling web package at `packages/web/dist`. Prefer the
 * bundled copy so an installed harness serves the UI without the workspace.
 */
function resolveWebDist(here: string): string {
  const bundled = resolve(here, "../dist-web");
  if (existsSync(bundled)) return bundled;
  return resolve(here, "../../web/dist");
}

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

  const auth = makeAuthStore(cfg, childLogger("auth"));

  const app = new Hono();

  // Public surface — no auth needed.
  app.get("/healthz", (c) => c.json({ ok: true, agents: am.list().length }));
  app.route("/api/auth", authRouter(auth));

  // Authenticated API.
  const api = new Hono();
  api.use("*", requireAuth(auth));
  api.route("/agents", agentsRouter(am, cfg));
  api.route("/agents", filesRouter(am, cfg));
  api.route("/secrets", secretsRouter(am, cfg, childLogger("secrets-api")));
  api.route("/models", modelsRouter(am, cfg, childLogger("models-api")));
  api.route("/harness", harnessRouter(am, cfg, childLogger("harness-api")));
  app.route("/api", api);

  // /admin/* (predates web UI) — also gated by auth.
  const admin = new Hono();
  admin.use("*", requireAuth(auth));
  admin.route("/", adminRouter(am));
  app.route("/admin", admin);

  // Static UI — only mounted if the build exists. In dev the operator runs
  // Vite separately on a different port and proxies /api, /admin, /webhook
  // here, so this branch is a no-op.
  if (existsSync(WEB_DIST_DIR)) {
    log.info({ dir: WEB_DIST_DIR }, "serving web UI");
    const indexHtml = readFileSync(resolve(WEB_DIST_DIR, "index.html"), "utf8");
    app.use("/assets/*", serveStatic({ root: relativeToCwd(WEB_DIST_DIR) }));
    app.get("/login", (c) => c.html(indexHtml));
    const gate = redirectIfUnauthenticated(auth);
    app.get("/", gate, (c) => c.html(indexHtml));
    app.get("/settings", gate, (c) => c.html(indexHtml));
    app.get("/settings/*", gate, (c) => c.html(indexHtml));
    app.get("/agents/*", gate, (c) => c.html(indexHtml));
  } else {
    app.get("/", (c) =>
      c.json({
        name: "cognisphere",
        agents: am.list(),
        note: "web UI not built; run `npm run dev:web` (with the server on a separate port) or `npm run build:web`",
      }),
    );
  }

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

function relativeToCwd(abs: string): string {
  const cwd = process.cwd();
  if (abs.startsWith(cwd + "/")) return abs.slice(cwd.length + 1);
  return abs;
}

main().catch((err) => {
  rootLogger().error({ err }, "fatal");
  process.exit(1);
});
