import { Hono } from "hono";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentManager } from "../agent-manager.js";
import { LifecycleError } from "../agent-manager.js";
import { agentDir } from "../config.js";
import type { ServerConfig } from "../config.js";

/**
 * /api/agents/* surface for the web UI.
 *
 *   GET  /api/agents
 *   GET  /api/agents/:id
 *   GET  /api/agents/:id/plugins
 *   POST /api/agents/:id/start                          — lifecycle
 *   POST /api/agents/:id/stop                           — lifecycle
 *   POST /api/agents/:id/restart                        — lifecycle (full reload)
 *   GET  /api/agents/:id/sessions                       — list threads + sessions
 *   GET  /api/agents/:id/sessions/:threadId/:sessionId  — raw jsonl entries
 *   GET  /api/agents/:id/queue/pending
 *   GET  /api/agents/:id/queue/dlq
 *   GET  /api/agents/:id/queue/events?since=&limit=
 *   POST /api/agents/:id/queue/dlq/:rowId/requeue
 *   DELETE /api/agents/:id/queue/dlq/:rowId
 *
 * Mutating chat actions (send/abort) live on /admin/* and predate this
 * router; they are unchanged.
 */
export function agentsRouter(am: AgentManager, cfg: ServerConfig): Hono {
  const r = new Hono();

  r.get("/", (c) => c.json({ agents: am.list() }));

  r.get("/:id", (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    return c.json({
      id: inst.id,
      name: inst.agentJson?.name ?? inst.id,
      agentJson: inst.agentJson,
      installedPlugins: inst.installedPluginIds,
      state: inst.state,
      error: inst.error,
      changedAt: inst.changedAt,
    });
  });

  r.get("/:id/plugins", (c) => {
    const id = c.req.param("id");
    const inst = am.get(id);
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    // Iterate every installed plugin dir so the Settings UI can surface
    // configuration for plugins that failed to start due to missing secrets.
    const out = inst.installedPluginIds.map((pid) => {
      const entry = inst.plugins.get(pid);
      const manifest = am.getPluginManifest(pid) ?? null;
      const config =
        entry?.config !== undefined && entry?.config !== null
          ? entry.config
          : readJsonFile(pluginPath(cfg, id, pid, "config.json"));
      const notifications =
        entry?.notifications ??
        (readJsonFile(pluginPath(cfg, id, pid, "notifications.json")) as {
          enabled?: string[];
        } | null) ??
        { enabled: [] as string[] };
      return {
        pluginId: pid,
        manifest,
        config,
        notifications,
        state: entry?.state ?? "stopped",
        error: entry?.error ?? null,
        changedAt: entry?.changedAt ?? 0,
      };
    });
    return c.json({ plugins: out });
  });

  // ── lifecycle: start / stop / restart ──────────────────────────────

  r.post("/:id/start", async (c) => {
    const id = c.req.param("id");
    try {
      const inst = await am.manualStart(id);
      return c.json({ ok: true, state: inst.state, error: inst.error });
    } catch (err) {
      return lifecycleErrorResponse(c, err);
    }
  });

  r.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    try {
      const inst = await am.manualStop(id);
      return c.json({ ok: true, state: inst.state, error: inst.error });
    } catch (err) {
      return lifecycleErrorResponse(c, err);
    }
  });

  r.post("/:id/restart", async (c) => {
    const id = c.req.param("id");
    try {
      const inst = await am.restartAgent(id);
      return c.json({ ok: true, state: inst.state, error: inst.error });
    } catch (err) {
      return lifecycleErrorResponse(c, err);
    }
  });

  // ── mutating: agent config + plugin config + notification subscriptions ──
  // All three require a server restart for the runner to pick them up.

  r.put("/:id/config", async (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.json({ error: "unknown agent" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      config?: unknown;
    } | null;
    if (!body || body.config === undefined) {
      return c.json({ error: "expected { config: <agent.json> }" }, 400);
    }
    if (!isPlainObject(body.config)) {
      return c.json({ error: "config must be a JSON object" }, 400);
    }
    const path = join(agentDir(cfg, id), "agent.json");
    writeFileSync(path, JSON.stringify(body.config, null, 2) + "\n");
    const inst = await am.reloadAgent(id);
    return c.json({
      ok: true,
      restartRequired: false,
      state: inst?.state,
      error: inst?.error ?? null,
    });
  });

  r.put("/:id/plugins/:pluginId/config", async (c) => {
    const id = c.req.param("id");
    const pid = c.req.param("pluginId");
    const inst = am.get(id);
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.installedPluginIds.includes(pid)) {
      return c.json({ error: "plugin not installed" }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as {
      config?: unknown;
    } | null;
    if (!body || body.config === undefined) {
      return c.json({ error: "expected { config: <object> }" }, 400);
    }
    if (!isPlainObject(body.config)) {
      return c.json({ error: "config must be a JSON object" }, 400);
    }
    const path = pluginPath(cfg, id, pid, "config.json");
    writeFileSync(path, JSON.stringify(body.config, null, 2) + "\n");
    const inst2 = await am.reloadAgent(id);
    return c.json({
      ok: true,
      restartRequired: false,
      state: inst2?.state,
      error: inst2?.error ?? null,
    });
  });

  r.put("/:id/plugins/:pluginId/notifications", async (c) => {
    const id = c.req.param("id");
    const pid = c.req.param("pluginId");
    const inst = am.get(id);
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.installedPluginIds.includes(pid)) {
      return c.json({ error: "plugin not installed" }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    if (!body || !Array.isArray(body.enabled)) {
      return c.json({ error: "expected { enabled: string[] }" }, 400);
    }
    const declared = new Set(
      (am.getPluginManifest(pid)?.notifications ?? []).map((n) => n.name),
    );
    const enabled = body.enabled.filter(
      (x): x is string => typeof x === "string" && declared.has(x),
    );
    const path = pluginPath(cfg, id, pid, "notifications.json");
    writeFileSync(path, JSON.stringify({ enabled }, null, 2) + "\n");
    const inst3 = await am.reloadAgent(id);
    return c.json({
      ok: true,
      restartRequired: false,
      enabled,
      state: inst3?.state,
      error: inst3?.error ?? null,
    });
  });

  r.get("/:id/sessions", (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.json({ error: "unknown agent" }, 404);
    const dir = join(agentDir(cfg, id), "sessions");
    if (!existsSync(dir)) return c.json({ threads: [] });
    const threads: { threadId: string; sessions: SessionEntry[] }[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".")) continue;
      const tDir = join(dir, ent.name);
      const sessions: SessionEntry[] = [];
      for (const f of readdirSync(tDir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
        const fp = join(tDir, f.name);
        const st = statSync(fp);
        sessions.push({
          sessionId: f.name.replace(/\.jsonl$/, ""),
          modified: st.mtimeMs,
          size: st.size,
        });
      }
      sessions.sort((a, b) => b.modified - a.modified);
      threads.push({ threadId: ent.name, sessions });
    }
    threads.sort(
      (a, b) =>
        (b.sessions[0]?.modified ?? 0) - (a.sessions[0]?.modified ?? 0),
    );
    return c.json({ threads });
  });

  r.get("/:id/sessions/:threadId/:sessionId", (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.json({ error: "unknown agent" }, 404);
    const threadId = c.req.param("threadId");
    const sessionId = c.req.param("sessionId");
    if (!isSafeId(threadId) || !isSafeId(sessionId)) {
      return c.json({ error: "invalid thread or session id" }, 400);
    }
    const fp = join(
      agentDir(cfg, id),
      "sessions",
      threadId,
      `${sessionId}.jsonl`,
    );
    if (!existsSync(fp)) return c.json({ error: "no such session" }, 404);
    const text = readFileSync(fp, "utf8");
    const entries: unknown[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return c.json({ threadId, sessionId, entries });
  });

  r.get("/:id/queue/pending", (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ messages: [] });
    const limit = clampLimit(c.req.query("limit"), 200, 1000);
    return c.json({
      messages: inst.db.listPending(limit).map((row) => ({
        id: row.id,
        enqueuedAt: row.enqueued_at,
        pluginId: row.plugin_id,
        channelId: row.channel_id,
        threadId: row.thread_id,
        text: row.text,
        priority: row.priority,
        isSilent: row.is_silent === 1,
        inFlight: row.in_flight === 1,
        attempts: row.attempts,
      })),
    });
  });

  r.get("/:id/queue/dlq", (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ messages: [] });
    const limit = clampLimit(c.req.query("limit"), 200, 1000);
    return c.json({
      messages: inst.db.listDeadLetter(limit).map((row) => ({
        id: row.id,
        enqueuedAt: row.enqueued_at,
        pluginId: row.plugin_id,
        channelId: row.channel_id,
        threadId: row.thread_id,
        text: row.text,
        priority: row.priority,
        attempts: row.attempts,
        lastError: row.last_error,
        deadAt: row.dead_at,
      })),
    });
  });

  r.get("/:id/queue/events", (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ events: [] });
    const since = Number(c.req.query("since") ?? 0);
    const limit = clampLimit(c.req.query("limit"), 200, 1000);
    return c.json({ events: inst.db.tailEvents(since || null, limit) });
  });

  r.post("/:id/queue/dlq/:rowId/requeue", (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ error: "agent not initialized" }, 503);
    const rowId = Number(c.req.param("rowId"));
    if (!Number.isFinite(rowId)) return c.json({ error: "bad row id" }, 400);
    const newId = inst.db.requeueDeadLetter(rowId);
    if (newId === null) return c.json({ error: "no such row" }, 404);
    return c.json({ ok: true, id: newId });
  });

  r.delete("/:id/queue/dlq/:rowId", (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ error: "agent not initialized" }, 503);
    const rowId = Number(c.req.param("rowId"));
    if (!Number.isFinite(rowId)) return c.json({ error: "bad row id" }, 400);
    const ok = inst.db.removeDeadLetter(rowId);
    if (!ok) return c.json({ error: "no such row" }, 404);
    return c.json({ ok: true });
  });

  return r;
}

interface SessionEntry {
  sessionId: string;
  modified: number;
  size: number;
}

function isSafeId(s: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(s);
}

function clampLimit(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

function pluginPath(
  cfg: ServerConfig,
  agentId: string,
  pluginId: string,
  filename: string,
): string {
  return join(agentDir(cfg, agentId), "plugins", pluginId, filename);
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function lifecycleErrorResponse(c: import("hono").Context, err: unknown) {
  if (err instanceof LifecycleError) {
    if (err.code === "not_found") return c.json({ error: err.message }, 404);
    return c.json({ error: err.message }, 409);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
}
