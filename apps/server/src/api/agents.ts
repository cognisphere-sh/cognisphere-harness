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
 *   GET  /api/agents/:id/events?status=&plugin=&search=&sortBy=&sortDir=&limit=&offset=
 *   POST /api/agents/:id/events/:rowId/requeue          — re-queue a status=failed row
 *   DELETE /api/agents/:id/events/:rowId                — discard a status=failed row
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
      installedPlugins: [...inst.plugins.keys()],
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
    const out = [...inst.plugins.entries()].map(([pid, entry]) => {
      const manifest = am.getPluginManifest(pid) ?? null;
      const config =
        entry.config != null
          ? entry.config
          : readJsonFile(pluginPath(cfg, id, pid, "config.json"));
      return {
        pluginId: pid,
        manifest,
        config,
        state: entry.state,
        error: entry.error,
        changedAt: entry.changedAt,
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

  // ── mutating: agent config + plugin config ────────────────────────
  // Both auto-reload the agent so the runner picks up the new values.

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
    if (!inst.plugins.has(pid)) {
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
    const inst2 = await am.reloadPlugin(id, pid);
    return c.json({
      ok: true,
      restartRequired: false,
      state: inst2?.state,
      error: inst2?.error ?? null,
    });
  });

  r.get("/:id/sessions", (c) => {
    const id = c.req.param("id");
    const inst = am.get(id);
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    const dir = join(agentDir(cfg, id), "sessions");
    if (!existsSync(dir)) return c.json({ threads: [] });
    const threads: {
      threadId: string;
      activeSessionId: string | null;
      sessions: SessionEntry[];
    }[] = [];
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
      // The harness owns the canonical session id per thread (.events.db
      // `threads` table). UI uses this to open the active session directly
      // instead of guessing from filesystem mtime.
      const activeSessionId = inst.db?.getThreadSessionId(ent.name) ?? null;
      threads.push({ threadId: ent.name, activeSessionId, sessions });
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

  r.get("/:id/events", (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ events: [], total: 0 });
    const q = c.req.query.bind(c.req);
    const statusesRaw = q("status");
    const statuses = statusesRaw
      ? statusesRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const pluginId = q("plugin") || undefined;
    const search = q("search") || undefined;
    const sortBy = (q("sortBy") as
      | "ts"
      | "updated_at"
      | "status"
      | "plugin_id"
      | "thread_id"
      | undefined) ?? "updated_at";
    const sortDir: "asc" | "desc" = q("sortDir") === "asc" ? "asc" : "desc";
    const limit = clampLimit(q("limit"), 200, 1000);
    const offsetRaw = Number(q("offset") ?? 0);
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
    const tsFrom = parseMs(q("tsFrom"));
    const tsTo = parseMs(q("tsTo"));
    const updatedFrom = parseMs(q("updatedFrom"));
    const updatedTo = parseMs(q("updatedTo"));
    const isSilent = parseBool(q("isSilent"));

    const filterOpts = {
      statuses,
      pluginId,
      search,
      isSilent,
      tsFrom,
      tsTo,
      updatedFrom,
      updatedTo,
    };
    const rows = inst.db.listEvents({
      ...filterOpts,
      sortBy,
      sortDir,
      limit,
      offset,
    });
    const total = inst.db.countEvents(filterOpts);
    return c.json({
      events: rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        updatedAt: row.updated_at,
        pluginId: row.plugin_id,
        channelId: row.channel_id,
        threadId: row.thread_id,
        isSilent: row.is_silent === 1,
        text: row.text,
        metadata: parseMetadata(row.metadata),
        status: row.status,
        priority: row.priority,
        attempts: row.attempts,
        error: row.error,
        piSessionId: row.pi_session_id,
        piEntryId: row.pi_entry_id,
      })),
      total,
    });
  });

  r.post("/:id/events/:rowId/requeue", (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ error: "agent not initialized" }, 503);
    const rowId = Number(c.req.param("rowId"));
    if (!Number.isFinite(rowId)) return c.json({ error: "bad row id" }, 400);
    const id = inst.db.requeueFailed(rowId);
    if (id === null) return c.json({ error: "no such failed row" }, 404);
    return c.json({ ok: true, id });
  });

  r.delete("/:id/events/:rowId", (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ error: "agent not initialized" }, 503);
    const rowId = Number(c.req.param("rowId"));
    if (!Number.isFinite(rowId)) return c.json({ error: "bad row id" }, 400);
    const ok = inst.db.removeFailed(rowId);
    if (!ok) return c.json({ error: "no such failed row" }, 404);
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

function parseMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw == null || raw === "") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
