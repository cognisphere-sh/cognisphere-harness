import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.js";
import { adminRouter } from "../api/admin.js";
import { agentsRouter } from "../api/agents.js";
import {
  authRouter,
  ensureCredentials,
  makeAuthStore,
  redirectIfUnauthenticated,
  requireAuth,
} from "../api/auth.js";
import { filesRouter } from "../api/files.js";
import { gwsOauthRouter } from "../api/gws-oauth.js";
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
  // here = packages/harness/src/core → package root is two up; the monorepo
  // web package is three up (packages/web/dist).
  const bundled = resolve(here, "../../dist-web");
  if (existsSync(bundled)) return bundled;
  return resolve(here, "../../../web/dist");
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = rootLogger();
  log.info({ cfg }, "boot");

  // Shared secret that authenticates in-harness callers of the agent-messaging
  // webhook. Generated per boot unless the operator pins one; inherited by
  // every pi child via `{...process.env}` (runner.spawnPi) so seeded scripts
  // can send it, and read back by the plugin handler from `process.env`.
  // ponytail: one shared insider secret, not per-agent tokens — the webhook is
  //   loopback/single-tenant and co-resident agents already share the box.
  //   Per-agent tokens are the global-isolation trigger, not this.
  if (!process.env.COGNISPHERE_WEBHOOK_SECRET) {
    process.env.COGNISPHERE_WEBHOOK_SECRET = randomUUID();
  }

  const registry = new PluginRegistry(
    BUILTIN_PLUGINS_DIR,
    userPluginsRoot(cfg),
    childLogger("plugin-registry"),
  );
  await registry.scan();

  const am = new AgentManager(cfg, registry, childLogger("agent-manager"));
  await am.boot();

  const jlog = childLogger("tmp-janitor");
  sweepTmpDebris(jlog);
  setInterval(() => sweepTmpDebris(jlog), 6 * 60 * 60 * 1000).unref();

  await ensureCredentials(cfg, childLogger("auth"));
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
  api.route("/gws/oauth", gwsOauthRouter(am, cfg, childLogger("gws-oauth")));
  app.route("/api", api);

  // /admin/* (predates web UI) — also gated by auth.
  const admin = new Hono();
  admin.use("*", requireAuth(auth));
  admin.route("/", adminRouter(am));
  app.route("/admin", admin);

  // Static UI — only mounted if the build exists and the server isn't headless.
  // In dev the operator runs Vite separately on a different port and proxies
  // /api, /admin, /webhook here, so this branch is a no-op. `--headless`
  // (COGNISPHERE_HEADLESS) skips it for backend-only deployments.
  if (!cfg.headless && existsSync(WEB_DIST_DIR)) {
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
        note: cfg.headless
          ? "headless mode — web UI disabled (COGNISPHERE_HEADLESS)"
          : "web UI not built; run `pnpm run build:web`, or `pnpm run dev:web` on a separate port",
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

/**
 * Age-based sweep of known agent debris in the OS temp dir. Two producers
 * fill it up on a long-running server:
 *  - pi's bash tool spills any oversized command output to
 *    `$TMPDIR/pi-bash-<id>.log` and never deletes it (the path is handed to
 *    the agent as "full output saved to…", then abandoned);
 *  - browsers launched via the bash tool leave their profile dirs behind,
 *    especially when the batch teardown SIGKILLs them.
 * The spill files must outlive their bash call (the agent may read the path
 * later in the turn), so deletion is age-based: anything matching a known
 * pattern and older than 24h is fair game. Runs at boot and every 6h.
 */
const TMP_DEBRIS =
  /^(pi-bash-[0-9a-f]+\.log|\.org\.chromium\..*|puppeteer_dev_chrome_profile-.*|playwright.*)$/;
const TMP_DEBRIS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function sweepTmpDebris(log: Logger): void {
  const dir = tmpdir();
  const cutoff = Date.now() - TMP_DEBRIS_MAX_AGE_MS;
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TMP_DEBRIS.test(name)) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs >= cutoff) continue;
      rmSync(p, { recursive: true, force: true });
      removed++;
    } catch {
      /* vanished or not ours (EPERM) — skip */
    }
  }
  if (removed > 0) log.info({ removed, dir }, "swept tmp debris");
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
