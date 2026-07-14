import { Hono } from "hono";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { AgentManager } from "../core/agent-manager.js";
import { LifecycleError } from "../core/agent-manager.js";
import { agentDir, secretsRoot } from "../core/config.js";
import type { ServerConfig } from "../core/config.js";
import { ModelsStore } from "../core/models-store.js";
import { findProviderInCatalog } from "../core/models-catalog.js";

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
 *   GET  /api/agents/:id/sessions/:threadId/usage       — per-(agent, model) token/cost totals
 *   GET  /api/agents/:id/events?status=&plugin=&search=&sortBy=&sortDir=&limit=&offset=
 *   POST /api/agents/:id/events/:rowId/requeue          — re-queue a status=failed row
 *   POST /api/agents/:id/events/:rowId/status           — force status of a non-in-flight row
 *   DELETE /api/agents/:id/events/:rowId                — discard a non-in-flight row
 *
 * Mutating chat actions (send/abort) live on /admin/* and predate this
 * router; they are unchanged.
 */
export function agentsRouter(am: AgentManager, cfg: ServerConfig): Hono {
  const r = new Hono();
  const models = new ModelsStore(join(secretsRoot(cfg), "models.json"));

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
      lastContext: LastContextInfo | null;
      totalCost: number | null;
      modelOverride: {
        provider: string;
        modelId: string;
        thinkingLevel: string | null;
      } | null;
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
      // Pull the last assistant usage off the active session (or newest
      // on-disk session if no canonical id yet) for the sidebar scale.
      // Tail-read keeps this cheap even for large jsonls.
      const lastSessionId = activeSessionId ?? sessions[0]?.sessionId ?? null;
      const lastContext = lastSessionId
        ? readLastAssistantUsage(join(tDir, `${lastSessionId}.jsonl`))
        : null;
      // Sum cost.total across every assistant message in every session
      // file (main + each sub-agent) so the sidebar can show running
      // spend per thread. We *only* read the mtime cache here — if any
      // file is cold, return `null` and schedule a background warm-up;
      // otherwise the first /sessions call after a fresh boot would
      // block on parsing every jsonl in the agent (which can be 1000+
      // files for a long-running agent). The sidebar polls every 5s,
      // so costs populate within a few ticks instead of stalling page
      // load.
      const totalCost = getThreadTotalCostFast(tDir);
      threads.push({
        threadId: ent.name,
        activeSessionId,
        sessions,
        lastContext,
        totalCost,
        modelOverride: inst.db?.getThreadModel(ent.name) ?? null,
      });
    }
    threads.sort(
      (a, b) =>
        (b.sessions[0]?.modified ?? 0) - (a.sessions[0]?.modified ?? 0),
    );
    return c.json({ threads });
  });

  r.delete("/:id/sessions/:threadId", (c) => {
    const id = c.req.param("id");
    const inst = am.get(id);
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    const threadId = c.req.param("threadId");
    if (!isSafeId(threadId)) {
      return c.json({ error: "invalid thread id" }, 400);
    }
    if (inst.runner?.isThreadActive(threadId)) {
      return c.json(
        { error: "thread is currently in-flight — abort it first" },
        409,
      );
    }
    const dbRes = inst.db?.deleteThread(threadId) ?? { events: 0 };
    const tDir = join(agentDir(cfg, id), "sessions", threadId);
    let removedDir = false;
    if (existsSync(tDir)) {
      rmSync(tDir, { recursive: true, force: true });
      removedDir = true;
    }
    return c.json({
      ok: true,
      threadId,
      events: dbRes.events,
      removedDir,
    });
  });

  // Per-thread model override. Stored on the thread's `threads` row and read
  // live by the runner on the next batch (no agent reload). A null
  // provider/modelId clears the override (revert to the agent default).
  r.put("/:id/sessions/:threadId/model", async (c) => {
    const id = c.req.param("id");
    const inst = am.get(id);
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ error: "agent not initialized" }, 503);
    const threadId = c.req.param("threadId");
    if (!isSafeId(threadId)) return c.json({ error: "invalid thread id" }, 400);

    const body = (await c.req.json().catch(() => null)) as {
      provider?: string | null;
      modelId?: string | null;
      thinkingLevel?: string | null;
    } | null;
    if (!body) return c.json({ error: "expected JSON body" }, 400);

    if (body.provider == null || body.modelId == null) {
      const ok = inst.db.clearThreadModel(threadId);
      if (!ok) {
        return c.json({ error: "send a message first to create the thread" }, 409);
      }
      return c.json({ ok: true });
    }

    const { provider, modelId } = body;
    const thinkingLevel = body.thinkingLevel ?? null;

    const entry = findProviderInCatalog(provider);
    if (!entry) return c.json({ error: `unknown provider "${provider}"` }, 400);
    const pcfg = models.getProvider(provider);
    const configured =
      !!pcfg &&
      entry.credentials
        .filter((f) => f.required)
        .every((f) => {
          const v = pcfg.credentials[f.key];
          return typeof v === "string" && v.length > 0;
        });
    if (!configured) {
      return c.json({ error: `provider "${provider}" is not configured` }, 400);
    }
    if (!pcfg.enabledModels.includes(modelId)) {
      return c.json(
        { error: `model "${modelId}" is not enabled for ${provider}` },
        400,
      );
    }
    if (thinkingLevel !== null && !THINKING_LEVELS.has(thinkingLevel)) {
      return c.json({ error: "invalid thinkingLevel" }, 400);
    }

    const ok = inst.db.setThreadModel(threadId, provider, modelId, thinkingLevel);
    if (!ok) {
      return c.json({ error: "send a message first to create the thread" }, 409);
    }
    return c.json({ ok: true });
  });

  r.get("/:id/sessions/:threadId/usage", (c) => {
    const id = c.req.param("id");
    if (!am.get(id)) return c.json({ error: "unknown agent" }, 404);
    const threadId = c.req.param("threadId");
    if (!isSafeId(threadId)) {
      return c.json({ error: "invalid thread id" }, 400);
    }
    const tDir = join(agentDir(cfg, id), "sessions", threadId);
    if (!existsSync(tDir)) {
      return c.json({
        threadId,
        main: { agent: "main", models: [], lastContext: null },
        subagents: [],
      });
    }

    // Main agent: aggregate every *.jsonl directly under the thread dir.
    // (Compaction creates new sessions in the same dir; we sum them all.)
    const mainState = newAgentState();
    for (const f of readdirSync(tDir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      aggregateAgentFile(join(tDir, f.name), mainState);
    }

    // Sub-agents: one entry per `subagents/<subAgentId>/` directory, summing
    // every *.jsonl inside it (sub-agents can be continued with `-c`, which
    // appends to the same file or creates new sessions in the same dir).
    const subagents: AgentUsage[] = [];
    const subRoot = join(tDir, "subagents");
    if (existsSync(subRoot)) {
      for (const ent of readdirSync(subRoot, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const subDir = join(subRoot, ent.name);
        const subState = newAgentState();
        for (const f of readdirSync(subDir, { withFileTypes: true })) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          aggregateAgentFile(join(subDir, f.name), subState);
        }
        subagents.push(stateToAgentUsage(ent.name, subState));
      }
      subagents.sort((a, b) => a.agent.localeCompare(b.agent));
    }

    return c.json({
      threadId,
      main: stateToAgentUsage("main", mainState),
      subagents,
    });
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
        doNotSteer: row.do_not_steer === 1,
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
    inst.runner?.wake();
    return c.json({ ok: true, id });
  });

  r.delete("/:id/events/:rowId", (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ error: "agent not initialized" }, 503);
    const rowId = Number(c.req.param("rowId"));
    if (!Number.isFinite(rowId)) return c.json({ error: "bad row id" }, 400);
    const res = inst.db.removeAny(rowId);
    if (res === "not_found") return c.json({ error: "no such row" }, 404);
    if (res === "in_flight")
      return c.json({ error: "row is in_flight; abort batch first" }, 409);
    return c.json({ ok: true });
  });

  r.post("/:id/events/:rowId/status", async (c) => {
    const inst = am.get(c.req.param("id"));
    if (!inst) return c.json({ error: "unknown agent" }, 404);
    if (!inst.db) return c.json({ error: "agent not initialized" }, 503);
    const rowId = Number(c.req.param("rowId"));
    if (!Number.isFinite(rowId)) return c.json({ error: "bad row id" }, 400);
    const body = await c.req
      .json<{ status?: string }>()
      .catch(() => ({}) as { status?: string });
    const next = body.status;
    if (
      next !== "queued" &&
      next !== "done" &&
      next !== "failed" &&
      next !== "cancelled"
    ) {
      return c.json({ error: "bad status" }, 400);
    }
    const res = inst.db.setStatus(rowId, next);
    if (res === "not_found") return c.json({ error: "no such row" }, 404);
    if (res === "in_flight")
      return c.json({ error: "row is in_flight; abort batch first" }, 409);
    if (res === "bad_status") return c.json({ error: "bad status" }, 400);
    if (next === "queued") inst.runner?.wake();
    return c.json({ ok: true, status: next });
  });

  return r;
}

interface SessionEntry {
  sessionId: string;
  modified: number;
  size: number;
}

// ── usage aggregation ─────────────────────────────────────────────
// Each `assistant` jsonl entry carries a `usage` block (tokens + cost)
// computed by pi-ai. We sum across every assistant message in every
// session file, keyed by `<provider>/<model>` so a model change mid-
// session yields one row per distinct model. We also track the
// most-recent non-aborted assistant message so the UI can render a
// "context window in use" scale next to the agent header.

interface ModelUsageAgg {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface LastContextInfo {
  tokens: number;
  /** `null` when the model isn't in pi-ai's registry (e.g. a custom id). */
  contextWindow: number | null;
  model: string;
}

interface AgentUsage {
  agent: string;
  models: ModelUsageAgg[];
  lastContext: LastContextInfo | null;
}

interface AgentState {
  models: Map<string, ModelUsageAgg>;
  /** Highest-timestamp non-aborted assistant message seen so far. */
  latest: { ts: number; tokens: number; provider: string; model: string } | null;
}

function newAgentState(): AgentState {
  return { models: new Map(), latest: null };
}

function stateToAgentUsage(name: string, state: AgentState): AgentUsage {
  const latest = state.latest;
  return {
    agent: name,
    models: aggToRows(state.models),
    lastContext: latest
      ? {
          tokens: latest.tokens,
          contextWindow: getContextWindow(latest.provider, latest.model),
          model: latest.provider
            ? `${latest.provider}/${latest.model}`
            : latest.model,
        }
      : null,
  };
}

function aggregateAgentFile(filePath: string, state: AgentState): void {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(entry) || entry.type !== "message") continue;
    const msg = (entry as { message?: unknown }).message;
    if (!isPlainObject(msg) || msg.role !== "assistant") continue;
    const usage = msg.usage;
    if (!isPlainObject(usage)) continue;
    const provider = typeof msg.provider === "string" ? msg.provider : "";
    const model = typeof msg.model === "string" ? msg.model : "";
    const key = `${provider}/${model}`;
    const row = state.models.get(key) ?? {
      provider,
      model,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    row.input += numField(usage, "input");
    row.output += numField(usage, "output");
    row.cacheRead += numField(usage, "cacheRead");
    row.cacheWrite += numField(usage, "cacheWrite");
    const cost = isPlainObject(usage.cost) ? usage.cost : undefined;
    if (cost) {
      row.cost.input += numField(cost, "input");
      row.cost.output += numField(cost, "output");
      row.cost.cacheRead += numField(cost, "cacheRead");
      row.cost.cacheWrite += numField(cost, "cacheWrite");
      row.cost.total += numField(cost, "total");
    }
    state.models.set(key, row);

    // Track latest (excluding aborted / error — they don't reflect real
    // context). Mirrors pi-coding-agent's getLastAssistantUsage.
    const stop = msg.stopReason;
    if (stop === "aborted" || stop === "error") continue;
    const ts = entryTimestamp(entry, msg);
    if (!state.latest || ts > state.latest.ts) {
      const tokens = lastUsageTokens(usage);
      if (tokens > 0) state.latest = { ts, tokens, provider, model };
    }
  }
}

function entryTimestamp(
  entry: Record<string, unknown>,
  msg: Record<string, unknown>,
): number {
  // Prefer the message's epoch-ms timestamp; fall back to the entry's
  // ISO string. Either may be absent on very old sessions.
  const mt = msg.timestamp;
  if (typeof mt === "number" && Number.isFinite(mt)) return mt;
  const et = entry.timestamp;
  if (typeof et === "string") {
    const parsed = Date.parse(et);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function lastUsageTokens(usage: Record<string, unknown>): number {
  // Mirrors pi-coding-agent's `calculateContextTokens`: prefer the
  // native `totalTokens` field, fall back to the per-bucket sum.
  const total = numField(usage, "totalTokens");
  if (total > 0) return total;
  return (
    numField(usage, "input") +
    numField(usage, "output") +
    numField(usage, "cacheRead") +
    numField(usage, "cacheWrite")
  );
}

function getContextWindow(provider: string, modelId: string): number | null {
  if (!provider || !modelId) return null;
  // pi-ai's `getBuiltinModel` is generic over a literal model-id union; we
  // cast to a dynamic signature since the runtime impl is just a Map lookup
  // that returns undefined on miss.
  const fn = getBuiltinModel as unknown as (
    p: string,
    m: string,
  ) => { contextWindow?: number } | undefined;
  return fn(provider, modelId)?.contextWindow ?? null;
}

/** Tail-read just the last ~128 KiB of a session jsonl and pull out
 *  the most-recent non-aborted assistant usage. Used by the threads
 *  list, which polls every 5s and can't afford to slurp every session
 *  file in full. Returns null if no assistant message lives within
 *  the tail window. */
function readLastAssistantUsage(filePath: string): LastContextInfo | null {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    const TAIL = 128 * 1024;
    const start = Math.max(0, st.size - TAIL);
    const len = st.size - start;
    if (len === 0) return null;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    // If we mid-read into a line, the leading partial line is garbage —
    // drop everything before the first newline.
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(entry) || entry.type !== "message") continue;
      const msg = (entry as { message?: unknown }).message;
      if (!isPlainObject(msg) || msg.role !== "assistant") continue;
      const stop = msg.stopReason;
      if (stop === "aborted" || stop === "error") continue;
      const usage = msg.usage;
      if (!isPlainObject(usage)) continue;
      const tokens = lastUsageTokens(usage);
      if (tokens <= 0) continue;
      const provider = typeof msg.provider === "string" ? msg.provider : "";
      const model = typeof msg.model === "string" ? msg.model : "";
      return {
        tokens,
        contextWindow: getContextWindow(provider, model),
        model: provider ? `${provider}/${model}` : model,
      };
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Fast path for the threads-list endpoint: walk the thread's jsonls
 *  and sum from the mtime cache only. If any file is uncached (cold
 *  boot, new file, file mutated since last read), return `null` and
 *  schedule a background warm-up so the next poll returns the real
 *  number. Keeps page-open instant on large agents (1k+ session
 *  files). */
// Every jsonl under a thread directory: the main agent's session files
// plus each sub-agent dir under `subagents/`. Shared by the fast (cache-
// only) and full (re-parse) cost walkers below.
function* threadJsonlFiles(threadDir: string): Generator<string> {
  for (const f of readdirSync(threadDir, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith(".jsonl")) yield join(threadDir, f.name);
  }
  const subRoot = join(threadDir, "subagents");
  if (!existsSync(subRoot)) return;
  for (const sub of readdirSync(subRoot, { withFileTypes: true })) {
    if (!sub.isDirectory() || sub.name.startsWith(".")) continue;
    const subDir = join(subRoot, sub.name);
    for (const f of readdirSync(subDir, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith(".jsonl")) yield join(subDir, f.name);
    }
  }
}

function getThreadTotalCostFast(threadDir: string): number | null {
  let total = 0;
  let cold = false;
  for (const filePath of threadJsonlFiles(threadDir)) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    const hit = fileTotalCostCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) total += hit.cost;
    else cold = true;
  }
  if (cold) {
    scheduleThreadCostWarmup(threadDir);
    return null;
  }
  return total;
}

// In-flight warm-ups. One setImmediate per thread keeps the queue
// from being double-scheduled across rapid polls while still
// processing every uncached thread eventually.
const warmingThreadDirs = new Set<string>();

function scheduleThreadCostWarmup(threadDir: string): void {
  if (warmingThreadDirs.has(threadDir)) return;
  warmingThreadDirs.add(threadDir);
  setImmediate(() => {
    try {
      sumThreadTotalCost(threadDir);
    } catch {
      // ignore — next poll will re-trigger if the dir is still readable
    } finally {
      warmingThreadDirs.delete(threadDir);
    }
  });
}

/** Sum `cost.total` across every assistant message in every jsonl
 *  under the thread directory (main agent + every sub-agent dir).
 *  Synchronous — only call off the request hot-path (e.g. from the
 *  background warm-up triggered by `getThreadTotalCostFast`). */
function sumThreadTotalCost(threadDir: string): number {
  let total = 0;
  for (const filePath of threadJsonlFiles(threadDir)) {
    total += sumFileTotalCostCached(filePath);
  }
  return total;
}

// Process-lifetime cache: a jsonl's per-file total cost rarely changes
// between polls (most threads are idle), and re-parsing every line of
// every session file on every 5s sidebar poll would be wasteful. Key
// by absolute path + mtime so any append invalidates the entry.
const fileTotalCostCache = new Map<string, { mtimeMs: number; cost: number }>();

function sumFileTotalCostCached(filePath: string): number {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
  const hit = fileTotalCostCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.cost;
  const cost = sumFileTotalCost(filePath);
  fileTotalCostCache.set(filePath, { mtimeMs, cost });
  return cost;
}

function sumFileTotalCost(filePath: string): number {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(entry) || entry.type !== "message") continue;
    const msg = (entry as { message?: unknown }).message;
    if (!isPlainObject(msg) || msg.role !== "assistant") continue;
    const usage = msg.usage;
    if (!isPlainObject(usage)) continue;
    const cost = isPlainObject(usage.cost) ? usage.cost : undefined;
    if (cost) total += numField(cost, "total");
  }
  return total;
}

function aggToRows(agg: Map<string, ModelUsageAgg>): ModelUsageAgg[] {
  return [...agg.values()].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.model.localeCompare(b.model);
  });
}

// Thread ids are created by the harness from arbitrary inputs (e.g. email
// subjects), so they can contain spaces, parens, brackets, and unicode.
// We only need to ensure the id is a single path segment that can't escape
// the agent's `sessions/` directory.
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function isSafeId(s: string): boolean {
  if (!s || s.length > 256) return false;
  if (s.startsWith(".")) return false; // blocks ".", "..", and hidden dirs
  if (s.includes("/") || s.includes("\\") || s.includes("\0")) return false;
  return true;
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
