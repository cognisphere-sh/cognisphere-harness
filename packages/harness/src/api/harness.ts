import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentManager } from "../core/agent-manager.js";
import type { ServerConfig } from "../core/config.js";
import { harnessJsonFile } from "../core/config.js";
import type { Logger } from "../core/logger.js";

/**
 * /api/harness — harness-wide settings (currently just the IANA timezone
 * used for `<harness-metadata>` timestamps and scheduler cron firing).
 *
 *   GET  /  → { timezone, path }
 *   PUT  /  → write `<harnessRoot>/harness.json`, mutate cfg in place,
 *             reload every agent so the new timezone reaches running runners
 *             and plugin contexts without a server bounce.
 */
export function harnessRouter(
  am: AgentManager,
  cfg: ServerConfig,
  log: Logger,
): Hono {
  const r = new Hono();
  const path = harnessJsonFile(cfg);

  r.get("/", (c) =>
    c.json({ timezone: cfg.timezone, version: cfg.version, path }),
  );

  r.put("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      timezone?: unknown;
    } | null;
    if (!body || typeof body.timezone !== "string" || body.timezone.length === 0) {
      return c.json({ error: "expected { timezone: <IANA tz string> }" }, 400);
    }
    const tz = body.timezone;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    } catch {
      return c.json({ error: `invalid IANA timezone: ${tz}` }, 400);
    }

    mkdirSync(dirname(path), { recursive: true });
    // Preserve the data/migration version stamp — only timezone is editable here.
    const next = cfg.version
      ? { version: cfg.version, timezone: tz }
      : { timezone: tz };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    cfg.timezone = tz;

    const restarted: string[] = [];
    for (const a of am.list()) {
      const inst = await am.reloadAgent(a.id);
      if (inst && inst.state === "running") restarted.push(a.id);
    }
    log.info({ tz, restarted }, "harness timezone updated; agents reloaded");
    return c.json({ ok: true, timezone: tz, restarted });
  });

  return r;
}
