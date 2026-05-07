import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDb } from "./queue.js";
import { PiRpcClient } from "./rpc.js";
import type {
  AgentJson,
  BatchMessage,
  NotifyPayload,
  ThreadIdStrategy,
} from "./types.js";
import { AGENT_TOOLS } from "./types.js";
import type { Logger } from "./logger.js";

const RESERVED_META = new Set(["Timestamp", "Plugin", "Channel", "IsSilent"]);

function pascal(s: string): string {
  return s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");
}

function renderMetaValue(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v))
    return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const TS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function tsFormatter(tz: string): Intl.DateTimeFormat {
  let f = TS_FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    });
    TS_FORMATTERS.set(tz, f);
  }
  return f;
}

function fmtTs(unixMs: number, tz: string): string {
  const parts = tsFormatter(tz).formatToParts(new Date(unixMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
}

export function buildHarnessMetadata(m: BatchMessage, tz: string): string {
  const lines = [
    "<harness-metadata>",
    `Timestamp: ${fmtTs(m.enqueuedAt, tz)}`,
    `Plugin: ${m.pluginId}`,
    `Channel: ${m.channelId}`,
  ];
  if (m.isSilent) lines.push("IsSilent: true");
  if (m.metadata) {
    for (const [k, v] of Object.entries(m.metadata)) {
      const r = renderMetaValue(v);
      if (r === null) continue;
      const key = pascal(k);
      if (RESERVED_META.has(key)) continue;
      lines.push(`${key}: ${r}`);
    }
  }
  lines.push("</harness-metadata>");
  return lines.join("\n");
}

interface ActiveBatch {
  threadId: string;
  ids: number[];
  steerIds: Set<number>;
  phase: "spawning" | "streaming" | "completing" | "exited";
  cancelled: boolean;
  rpc: PiRpcClient | null;
  child: ChildProcess | null;
}

export interface RunnerOpts {
  rootDir: string;
  harnessId: string;
  agentId: string;
  agentJson: AgentJson;
  db: AgentDb;
  serverBaseUrl: string;
  timezone: string;
  /**
   * Bare-key → value map of secrets exposed to the pi runtime as env vars.
   * Snapshot at AgentRunner construction; restart the server to pick up
   * edits to `<harnessRoot>/secrets.json`.
   */
  envSecrets?: Record<string, string>;
  log: Logger;
}

/**
 * One worker pool per agent. Owns the SQLite queue (passed in), spawns one
 * `pi --mode rpc` child per batch, concatenates batch messages into a single
 * `prompt` frame, supports steer/abort, durable-on-crash.
 */
export class AgentRunner extends EventEmitter {
  private readonly opts: RunnerOpts;
  private readonly maxSlots: number;
  private readonly maxAttempts: number;
  private status: "stopped" | "running" = "stopped";
  private active = new Map<string, ActiveBatch>();
  private workers: Promise<void>[] = [];
  private waiters: Array<() => void> = [];

  constructor(opts: RunnerOpts) {
    super();
    this.opts = opts;
    this.maxSlots = Math.max(1, opts.agentJson.maxConcurrentSlots ?? 1);
    this.maxAttempts = opts.agentJson.maxAttempts ?? 3;
  }

  start(): void {
    if (this.status === "running") return;
    const swept = this.opts.db.sweepInFlight(this.maxAttempts);
    if (swept.retrying.length || swept.dead.length) {
      this.opts.log.info(
        { retrying: swept.retrying.length, dead: swept.dead.length },
        "swept stuck rows on start",
      );
    }
    this.status = "running";
    for (let i = 0; i < this.maxSlots; i++) {
      this.workers.push(this.workerLoop(i));
    }
    this.opts.log.info({ workers: this.maxSlots }, "runner started");
    this.signalAll();
  }

  async stop(): Promise<void> {
    this.opts.log.info(
      { workers: this.workers.length, active: this.active.size },
      "runner stopping",
    );
    this.status = "stopped";
    for (const a of this.active.values()) {
      a.cancelled = true;
      a.rpc?.sendAbort();
    }
    this.signalAll();
    await Promise.all(this.workers).catch(() => {});
    this.workers = [];
  }

  /**
   * Plugin-driven enqueue. Always persists to the queue first; if a batch is
   * actively streaming on the same threadId+plugin+channel, also emits a steer
   * to the live child (best-effort).
   */
  notify(payload: NotifyPayload & { pluginId: string }): number {
    if (this.status !== "running") {
      throw new Error(`runner ${this.opts.agentId} not running`);
    }
    const threadId = payload.threadIdOverride ?? this.computeThreadId(payload);
    const id = this.opts.db.enqueue({
      pluginId: payload.pluginId,
      channelId: payload.channelId,
      threadId,
      text: payload.text,
      metadata: payload.metadata ?? null,
      priority: payload.priority ?? 0,
      isSilent: payload.isSilent === true,
    });
    this.opts.db.appendEvent({
      event: "notify",
      status: "queued",
      pluginId: payload.pluginId,
      notification: payload.metadata?._notification as string | undefined,
      channelId: payload.channelId,
      threadId,
      messageQueueId: id,
    });

    const active = this.active.get(threadId);
    const canSteer =
      active !== undefined &&
      active.phase === "streaming" &&
      !payload.doNotSteer &&
      !payload.isSilent &&
      active.rpc !== null;
    if (canSteer && active) {
      const msg: BatchMessage = {
        id,
        enqueuedAt: Date.now(),
        pluginId: payload.pluginId,
        channelId: payload.channelId,
        threadId,
        text: payload.text,
        metadata: payload.metadata ?? null,
        isSilent: false,
      };
      const steerText = `${buildHarnessMetadata(msg, this.opts.timezone)}\n${payload.text}`;
      active.steerIds.add(id);
      try {
        active.rpc!.sendSteer(steerText);
        this.opts.log.debug(
          { threadId, id, plugin: payload.pluginId },
          "steer dispatched",
        );
      } catch (err) {
        active.steerIds.delete(id);
        this.opts.log.error({ err, threadId, id }, "steer failed; row kept pending");
      }
      return id;
    }

    this.signalAll();
    return id;
  }

  abort(threadId: string): boolean {
    const a = this.active.get(threadId);
    if (!a) return false;
    a.cancelled = true;
    a.rpc?.sendAbort();
    this.opts.log.info({ threadId }, "abort requested");
    return true;
  }

  // ── internals ─────────────────────────────────────────────

  private async workerLoop(idx: number): Promise<void> {
    const log = this.opts.log.child({ worker: idx });
    while (this.status === "running") {
      const exclude = new Set(this.active.keys());
      const threadId = this.opts.db.peekHighestPriorityThread(exclude);
      if (!threadId) {
        await this.waitForWork();
        continue;
      }
      const batch = this.opts.db.dequeueBatch(threadId);
      if (batch.length === 0) continue;
      const active: ActiveBatch = {
        threadId,
        ids: batch.map((m) => m.id),
        steerIds: new Set(),
        phase: "spawning",
        cancelled: false,
        rpc: null,
        child: null,
      };
      this.active.set(threadId, active);
      try {
        await this.processBatch(active, batch, log);
      } catch (err) {
        log.error({ err, threadId }, "batch crashed (uncaught)");
      } finally {
        active.phase = "exited";
        this.active.delete(threadId);
        this.signalAll();
      }
    }
    log.debug("worker stopped");
  }

  private async processBatch(
    active: ActiveBatch,
    batch: BatchMessage[],
    log: Logger,
  ): Promise<void> {
    const { threadId } = active;
    const batchId = `b-${Date.now()}-${threadId}`;
    const sessionDir = join(
      this.opts.rootDir,
      this.opts.harnessId,
      "agents",
      this.opts.agentId,
      "sessions",
      threadId,
    );
    mkdirSync(sessionDir, { recursive: true });

    this.opts.db.appendEvent({
      event: "batch_start",
      status: "in_flight",
      threadId,
      batchId,
      log: `${batch.length} message(s)`,
    });

    let rpc: PiRpcClient | null = null;
    try {
      const { child, rpc: client } = this.spawnPi(threadId, sessionDir, log);
      rpc = client;
      active.rpc = client;
      active.child = child;

      const promptText = batch
        .map((m) => `${buildHarnessMetadata(m, this.opts.timezone)}\n${m.text}`)
        .join("\n\n");

      log.info(
        { threadId, count: batch.length, plugin: batch[0]!.pluginId },
        "prompt",
      );

      let endedCleanly = false;
      const agentEnded = new Promise<void>((resolve) => {
        rpc!.onAgentEnd(() => {
          endedCleanly = true;
          resolve();
        });
      });
      await rpc.sendPrompt(promptText);
      active.phase = "streaming";
      // Race agent_end against pi exit; if pi exits first without emitting
      // agent_end, treat it as a crash.
      await Promise.race([agentEnded, rpc.waitExit()]);
      if (!endedCleanly) {
        const stderr = rpc.stderrSnapshot()?.slice(-512) ?? "";
        throw new Error(`pi exited without agent_end. stderr: ${stderr}`);
      }
      active.phase = "completing";
      rpc.endStdin();
      const exitTimer = setTimeout(() => rpc!.kill("SIGKILL"), 5000);
      await rpc.waitExit();
      clearTimeout(exitTimer);

      const sessionFile = pickLatestSession(sessionDir);
      this.opts.db.markBatchDone([...active.ids, ...active.steerIds]);
      this.opts.db.appendEvent({
        event: "batch_end",
        status: "done",
        threadId,
        batchId,
        sessionFile: sessionFile ?? undefined,
        log: `done (steers=${active.steerIds.size})`,
      });
      log.debug({ threadId, batch: batch.length, steers: active.steerIds.size }, "batch done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (active.cancelled) {
        this.opts.db.markBatchDone([...active.ids, ...active.steerIds]);
        this.opts.db.appendEvent({
          event: "batch_end",
          status: "done",
          threadId,
          batchId,
          log: "cancelled by user",
        });
        log.info({ threadId }, "batch cancelled");
      } else {
        const stderr = rpc?.stderrSnapshot()?.slice(-512);
        const errFull = stderr ? `${msg}\n--stderr--\n${stderr}` : msg;
        const r = this.opts.db.markBatchFailed(active.ids, errFull, this.maxAttempts);
        this.opts.db.appendEvent({
          event: "batch_end",
          status: "failed",
          threadId,
          batchId,
          error: msg,
          log: `retrying=${r.retrying.length} dead=${r.dead.length}`,
        });
        log.error({ err: msg, threadId }, "batch failed");
      }
    }
  }

  private spawnPi(
    threadId: string,
    sessionDir: string,
    log: Logger,
  ): { child: ChildProcess; rpc: PiRpcClient } {
    const agentDir = join(
      this.opts.rootDir,
      this.opts.harnessId,
      "agents",
      this.opts.agentId,
    );
    const tools = AGENT_TOOLS.join(",");
    const systemPrompt = assembleSystemPrompt(agentDir, threadId);
    const args: string[] = [
      "--mode", "rpc",
      "--continue",
      "--session-dir", sessionDir,
      "--provider", this.opts.agentJson.model.provider,
      "--model", this.opts.agentJson.model.id,
      "--thinking", this.opts.agentJson.model.thinkingLevel ?? "medium",
      "--tools", tools,
      "--system-prompt", systemPrompt,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    ];

    // Skills: pi's --skill loader (`loadSkillsFromDir`) recurses into
    // subdirectories looking for SKILL.md, so one top-level dir is enough.
    const skillsRoot = join(agentDir, "skills");
    if (existsDir(skillsRoot)) args.push("--skill", skillsRoot);

    // Extensions: pi's --extension flag dispatches each path to
    // `loadExtension`, which expects an entry point at the path itself
    // (`index.ts`/`index.js`/`package.json` for a dir, or a `.ts`/`.js` file).
    // No recursion — so we pass each first-level child of `extensions/` as its
    // own `--extension`. No coupling to plugin ids — driven by the dir.
    const extensionsRoot = join(agentDir, "extensions");
    if (existsDir(extensionsRoot)) {
      for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const isDir = entry.isDirectory();
        const isJsTs =
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".js"));
        if (!isDir && !isJsTs) continue;
        args.push("--extension", join(extensionsRoot, entry.name));
      }
    }

    // Auto-activate `<agentDir>/.venv` if present: prepend its bin/ to PATH,
    // set VIRTUAL_ENV, and clear PYTHONHOME (per Python venv convention).
    // The operator creates the venv (`python -m venv .venv`) in the agent
    // dir; if missing, this block is a no-op and pi inherits ambient Python.
    const env: Record<string, string | undefined> = { ...process.env };
    const venvDir = join(agentDir, ".venv");
    const venvBin = join(venvDir, "bin");
    if (existsDir(venvBin)) {
      env.VIRTUAL_ENV = venvDir;
      env.PATH = `${venvBin}:${env.PATH ?? ""}`;
      delete env.PYTHONHOME;
    }

    // Identity + loopback URL so plugin scripts can reach back into in-process
    // plugins via `${PI_WEBHOOK_BASE}/<plugin-id>/<rest>`.
    env.PI_AGENT_ID = this.opts.agentId;
    env.PI_WEBHOOK_BASE = `${this.opts.serverBaseUrl}/webhook/${this.opts.agentId}`;

    // Plugin secrets, flattened to bare keys (e.g. TELEGRAM_BOT_TOKEN), so
    // the agent's bash invocations and plugin CLI scripts can read them
    // directly from env. Trade-off: secrets become visible to anything the
    // agent runs (bash history, error logs, transcripts). The operator
    // accepts this trade-off in exchange for ergonomic plugin scripts.
    for (const [k, v] of Object.entries(this.opts.envSecrets ?? {})) {
      env[k] = v;
    }

    log.debug(
      {
        argv: args.length,
        threadId,
        venv: env.VIRTUAL_ENV,
        secrets: Object.keys(this.opts.envSecrets ?? {}).length,
      },
      "spawn pi",
    );
    const child = spawn("pi", args, {
      cwd: agentDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rpc = new PiRpcClient(child, log.child({ rpc: threadId }));
    return { child, rpc };
  }

  private computeThreadId(p: NotifyPayload & { pluginId: string }): string {
    const s: ThreadIdStrategy = this.opts.agentJson.threadIdStrategy;
    switch (s.type) {
      case "single":
        return "default";
      case "plugin":
        return p.pluginId;
      case "plugin_channel":
        return `${p.pluginId}:${p.channelId}`;
    }
  }

  private waitForWork(): Promise<void> {
    if (this.status !== "running") return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private signalAll(): void {
    if (this.waiters.length === 0) return;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

/**
 * Read every <agentDir>/system_prompts/*.md in lex order, concatenate, and
 * append the per-run ThreadId / ThreadSessions block. Agent-fixed `{{vars}}`
 * (AgentId, AgentName, AgentDir, Workspace, Sessions, Tools, Timezone) are
 * baked into the .md files at agent-create time; ThreadId / ThreadSessions
 * are referenced as literal `{{...}}` in the body and resolved by the
 * appended block — the model maps them.
 */
function assembleSystemPrompt(agentDir: string, threadId: string): string {
  const promptsDir = join(agentDir, "system_prompts");
  const files = readdirSync(promptsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => d.name)
    .sort();
  const parts = files.map((f) =>
    readFileSync(join(promptsDir, f), "utf8").replace(/\s+$/, ""),
  );
  return (
    parts.join("\n\n-----\n\n-----\n\n") +
    `\n\n-----\n\n-----\n\nThreadId: ${threadId}\nThreadSessions: sessions/${threadId}/\n`
  );
}

function existsDir(p: string): boolean {
  try {
    const s = readdirSync(p, { withFileTypes: true });
    return s.length >= 0;
  } catch {
    return false;
  }
}

function pickLatestSession(dir: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name)
      .sort();
    const last = entries[entries.length - 1];
    return last ? join(dir, last) : null;
  } catch {
    return null;
  }
}
