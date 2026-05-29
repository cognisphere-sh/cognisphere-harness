import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
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

const RESERVED_META = new Set(["Timestamp", "Plugin", "Channel", "IsSilent", "Retry"]);

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
  if (m.attempts > 0) lines.push("Retry: true");
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
  /** Order matters: each steer becomes its own user-message entry in pi's
   *  session, so we map row → entry id by dispatch-order index after the
   *  batch ends. Set was wrong for this; an array preserves order. */
  steerIds: number[];
  /** Canonical pi session id for this thread; assigned in processBatch
   *  before spawn, used to locate the JSONL post-batch. */
  sessionId: string;
  phase: "spawning" | "streaming" | "completing" | "exited";
  cancelled: boolean;
  rpc: PiRpcClient | null;
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
   * edits to `<harnessRoot>/.secrets/secrets.json`.
   */
  envSecrets?: Record<string, string>;
  /**
   * Resolve a provider's credential env vars on demand. Used when a thread
   * overrides its model to a *different* provider than the agent's default
   * (`envSecrets` only carries the default provider's key), so the override
   * provider's key must be injected at spawn time. Reads the live
   * `ModelsStore`, so newly-added provider keys work without an agent reload.
   */
  resolveProviderEnv?: (providerId: string) => Record<string, string>;
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
  /** When true, workers stop dequeuing new threads but currently-active
   *  batches keep running (and steers to them still land). Used by the
   *  AgentManager's stale-reload path; never reset on the same runner —
   *  the runner is replaced once `active` drains. */
  private dequeuePaused = false;
  private active = new Map<string, ActiveBatch>();
  private workers: Promise<void>[] = [];
  private waiters: Array<() => void> = [];

  /** Number of batches currently being processed. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Soft-stop signal: stop dequeuing new threads. Active batches finish
   *  on their own and emit `batch-completed` on exit; the AgentManager
   *  swaps the runner once `activeCount === 0`. */
  pauseDequeue(): void {
    this.dequeuePaused = true;
    this.signalAll();
  }

  /** Wake idle workers to re-check the queue. Used by HTTP paths that
   *  mutate row status directly (requeue, force status) without going
   *  through `notify()`. Safe to call on a stopped runner — no-op. */
  wake(): void {
    if (this.status !== "running") return;
    this.signalAll();
  }

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

    const active = this.active.get(threadId);
    if (
      active &&
      active.phase === "streaming" &&
      !payload.doNotSteer &&
      active.rpc
    ) {
      const msg: BatchMessage = {
        id,
        enqueuedAt: Date.now(),
        pluginId: payload.pluginId,
        channelId: payload.channelId,
        threadId,
        text: payload.text,
        metadata: payload.metadata ?? null,
        isSilent: payload.isSilent === true,
        attempts: 0,
      };
      const steerText = `${buildHarnessMetadata(msg, this.opts.timezone)}\n${payload.text}`;
      active.steerIds.push(id);
      try {
        active.rpc.sendSteer(steerText);
        // The row was enqueued as 'queued' but dequeueBatch never saw it;
        // advance it to in_flight now that it's live in the streaming batch
        // so the DB/UI reflect that it's being processed, not still waiting.
        this.opts.db.markInFlight([id]);
        this.opts.log.debug(
          { threadId, id, plugin: payload.pluginId },
          "steer dispatched",
        );
      } catch (err) {
        // Pop the id we just pushed. Safe under single-threaded JS because
        // notify() runs to completion before the next call interleaves.
        const idx = active.steerIds.lastIndexOf(id);
        if (idx >= 0) active.steerIds.splice(idx, 1);
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

  /** Whether a batch is currently in-flight on this thread. Used to
   *  refuse destructive ops (e.g. thread delete) that would race with
   *  the runner writing to the session jsonl. */
  isThreadActive(threadId: string): boolean {
    return this.active.has(threadId);
  }

  // ── internals ─────────────────────────────────────────────

  private async workerLoop(idx: number): Promise<void> {
    const log = this.opts.log.child({ worker: idx });
    while (this.status === "running") {
      if (this.dequeuePaused) {
        await this.waitForWork();
        continue;
      }
      const exclude = new Set(this.active.keys());
      const threadId = this.opts.db.peekHighestPriorityThread(exclude);
      if (!threadId) {
        await this.waitForWork();
        continue;
      }
      const batch = this.opts.db.dequeueBatch(threadId);
      if (batch.length === 0) continue;
      // Resolve the thread's canonical session id before spawning. First
      // batch on a thread → generate a UUID and persist; subsequent batches
      // pull the same id. We pass `--session <sessionDir>/<sessionId>.jsonl`
      // to pi (which creates the file on first append).
      let sessionId = this.opts.db.getThreadSessionId(threadId);
      if (!sessionId) {
        sessionId = randomUUID();
        this.opts.db.setThreadSessionId(threadId, sessionId);
      }
      const active: ActiveBatch = {
        threadId,
        ids: batch.map((m) => m.id),
        steerIds: [],
        sessionId,
        phase: "spawning",
        cancelled: false,
        rpc: null,
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
        this.emit("batch-completed");
      }
    }
    log.debug("worker stopped");
  }

  private async processBatch(
    active: ActiveBatch,
    batch: BatchMessage[],
    log: Logger,
  ): Promise<void> {
    const { threadId, sessionId } = active;
    const sessionDir = join(
      this.opts.rootDir,
      this.opts.harnessId,
      "agents",
      this.opts.agentId,
      "sessions",
      threadId,
    );
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, `${sessionId}.jsonl`);

    // Snapshot pre-batch user-message count so we can slice off the new
    // entries pi appends during this batch and map them to row ids.
    // Returns 0 when the file doesn't yet exist (first batch on this thread).
    const preBatchUserCount = countUserMessageEntries(sessionFile);

    let rpc: PiRpcClient | null = null;
    try {
      rpc = this.spawnPi(threadId, sessionDir, sessionId, log);
      active.rpc = rpc;

      const promptText = batch
        .map((m) => `${buildHarnessMetadata(m, this.opts.timezone)}\n${m.text}`)
        .join("\n\n");

      log.info(
        { threadId, sessionId, count: batch.length, plugin: batch[0]!.pluginId },
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
      // Pi responds to an abort frame by emitting agent_end cleanly, so the
      // race resolves successfully on user-cancel too. Route to the catch
      // branch (which sees `active.cancelled`) instead of marking done.
      if (active.cancelled) {
        throw new Error("batch aborted");
      }
      if (!endedCleanly) {
        const stderr = rpc.stderrSnapshot()?.slice(-512) ?? "";
        throw new Error(`[crash] pi exited without agent_end. stderr: ${stderr}`);
      }
      active.phase = "completing";
      rpc.endStdin();
      const exitTimer = setTimeout(() => rpc!.kill("SIGKILL"), 5000);
      await rpc.waitExit();
      clearTimeout(exitTimer);

      // Pi emits `agent_end` whenever its agent loop terminates — including
      // when the loop exited because the model call returned an error (e.g.
      // a 400 usage-limit response). In that case the final assistant entry
      // in the session JSONL carries `stopReason: "error"` with an
      // `errorMessage`. Surface it as a batch failure instead of marking the
      // rows done.
      const finalOutcome = readFinalAssistantOutcomeAfter(
        sessionFile,
        preBatchUserCount,
      );
      if (finalOutcome?.stopReason === "error") {
        throw new Error(
          `[agent_error] pi ended with stopReason=error: ${finalOutcome.errorMessage ?? "(no errorMessage)"}`,
        );
      }

      // Read pi's session JSONL post-`agent_end` and map the user-message
      // entries appended during this batch back to row ids:
      //   - all rows in active.ids share the first new entry id (one
      //     concatenated prompt → one user message),
      //   - active.steerIds[i] gets the (i+1)-th new entry id (each steer
      //     becomes its own user message; stdin is serial so pi appends
      //     them in dispatch order).
      const newEntryIds = readUserEntryIdsAfter(sessionFile, preBatchUserCount);
      const entryMap = new Map<number, string>();
      const e0 = newEntryIds[0];
      if (e0) for (const id of active.ids) entryMap.set(id, e0);
      active.steerIds.forEach((rowId, i) => {
        const eid = newEntryIds[i + 1];
        if (eid) entryMap.set(rowId, eid);
      });
      if (!e0 || newEntryIds.length < 1 + active.steerIds.length) {
        log.warn(
          {
            threadId,
            sessionFile,
            expected: 1 + active.steerIds.length,
            got: newEntryIds.length,
          },
          "fewer user-message entries than expected; some pi_entry_ids will be NULL",
        );
      }

      this.opts.db.markBatchDone(
        [...active.ids, ...active.steerIds],
        sessionId,
        entryMap,
      );
      log.debug(
        { threadId, batch: batch.length, steers: active.steerIds.length },
        "batch done",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (active.cancelled) {
        this.opts.db.markBatchCancelled(
          [...active.ids, ...active.steerIds],
          sessionId,
        );
        log.info({ threadId }, "batch cancelled");
      } else {
        const stderr = rpc?.stderrSnapshot()?.slice(-512);
        const tagged = msg.startsWith("[") ? msg : `[runner_error] ${msg}`;
        const errFull = stderr ? `${tagged}\n--stderr--\n${stderr}` : tagged;
        // Steers that were delivered live to this pi process count as a
        // failed attempt too — otherwise a row that's been steered into N
        // consecutive failing batches never accrues attempts and never
        // reaches a failed status. attempts++ matters even though they
        // were never in_flight.
        const r = this.opts.db.markBatchFailed(
          [...active.ids, ...active.steerIds],
          errFull,
          this.maxAttempts,
          sessionId,
        );
        log.error({ err: msg, threadId, retrying: r.retrying.length, dead: r.dead.length }, "batch failed");
      }
    }
  }

  private spawnPi(
    threadId: string,
    sessionDir: string,
    sessionId: string,
    log: Logger,
  ): PiRpcClient {
    const agentDir = join(
      this.opts.rootDir,
      this.opts.harnessId,
      "agents",
      this.opts.agentId,
    );
    const tools = AGENT_TOOLS.join(",");
    const systemPrompt = assembleSystemPrompt(agentDir, threadId);
    // We pass `--session <path>` (harness-owned filename = sessionId) so
    // the harness controls the canonical session per thread. Pi tolerates
    // a not-yet-existing file (`loadEntriesFromFile` returns []), creates
    // it on first append, and `SessionManager.open` derives the session
    // directory from `resolve(path, "..")` so we don't need `--session-dir`.
    // We drop `--continue` because the explicit path makes "continue" implicit.
    const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
    // Per-thread model override (set via the UI); falls back to the agent's
    // agent.json model for any unset field. A cross-provider override has its
    // credentials injected into `env` below.
    const override = this.opts.db.getThreadModel(threadId);
    const provider = override?.provider ?? this.opts.agentJson.model.provider;
    const modelId = override?.modelId ?? this.opts.agentJson.model.id;
    const thinking =
      override?.thinkingLevel ?? this.opts.agentJson.model.thinkingLevel ?? "medium";
    const args: string[] = [
      "--mode", "rpc",
      "--session", sessionFile,
      "--provider", provider,
      "--model", modelId,
      "--thinking", thinking,
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
    // own `--extension`. We verify the entry point exists before passing the
    // path to pi; otherwise pi crashes the whole run on a missing module.
    const extensionsRoot = join(agentDir, "extensions");
    if (existsDir(extensionsRoot)) {
      for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const path = join(extensionsRoot, entry.name);
        if (entry.isDirectory()) {
          const hasEntry =
            existsSync(join(path, "index.ts")) ||
            existsSync(join(path, "index.js")) ||
            existsSync(join(path, "package.json"));
          if (!hasEntry) continue;
        } else if (entry.isFile()) {
          if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
        } else {
          continue;
        }
        args.push("--extension", path);
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

    // Cross-provider thread override: `envSecrets` only carries the agent's
    // default provider key, so inject the override provider's credentials.
    // (Same-provider overrides need nothing extra.)
    if (override && override.provider !== this.opts.agentJson.model.provider) {
      const overrideEnv = this.opts.resolveProviderEnv?.(override.provider) ?? {};
      for (const [k, v] of Object.entries(overrideEnv)) {
        env[k] = v;
      }
    }

    // Sub-agent model: surfaced so the `scripts/agent/subagent` wrapper can
    // pass --provider/--model/--thinking to the `pi -p` children the agent
    // spawns (without these, sub-agents fall back to pi's global default
    // model). Inherits this agent's model when `subagentModel` is unset; if
    // it names a different provider than the agent default, inject that
    // provider's credentials too so the sub-agent can authenticate.
    const sub = this.opts.agentJson.subagentModel ?? this.opts.agentJson.model;
    env.PI_SUBAGENT_PROVIDER = sub.provider;
    env.PI_SUBAGENT_MODEL = sub.id;
    env.PI_SUBAGENT_THINKING = sub.thinkingLevel ?? "medium";
    if (sub.provider !== this.opts.agentJson.model.provider) {
      const subEnv = this.opts.resolveProviderEnv?.(sub.provider) ?? {};
      for (const [k, v] of Object.entries(subEnv)) {
        env[k] = v;
      }
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
    return new PiRpcClient(child, log.child({ rpc: threadId }));
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
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pi session JSONL helpers. Each line is one `SessionEntry` (or a
 * `SessionHeader` first line). We only care about user-message entries —
 * `{type:"message", id, message:{role:"user", ...}}` — because every batch
 * (initial concatenated prompt + each steer) becomes exactly one user
 * message, and pi appends them in dispatch order. Other entry types
 * (assistant/toolResult messages, compaction, branch_summary, …) are
 * skipped so they don't shift our index mapping.
 */
function countUserMessageEntries(path: string): number {
  if (!existsSync(path)) return 0;
  let n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (isUserMessageLine(line)) n++;
  }
  return n;
}

function readUserEntryIdsAfter(path: string, skip: number): string[] {
  if (!existsSync(path)) return [];
  const ids: string[] = [];
  let seen = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!isUserMessageLine(line)) continue;
    if (seen++ < skip) continue;
    try {
      const parsed = JSON.parse(line) as { id?: string };
      if (typeof parsed.id === "string") ids.push(parsed.id);
    } catch {
      /* malformed — skip; downstream warns when length < expected */
    }
  }
  return ids;
}

/**
 * Find the last assistant message entry appended after the first
 * {skipUserMsgs} user messages and return its `stopReason` / `errorMessage`.
 * Pi sets `stopReason: "error"` on the final assistant entry when its agent
 * loop bailed out due to a model/API error (the loop still terminates and
 * pi still emits `agent_end`, so the RPC handshake completes cleanly).
 */
function readFinalAssistantOutcomeAfter(
  path: string,
  skipUserMsgs: number,
): { stopReason?: string; errorMessage?: string } | null {
  if (!existsSync(path)) return null;
  let userSeen = 0;
  let last: { stopReason?: string; errorMessage?: string } | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line || !line.includes(`"type":"message"`)) continue;
    let parsed: {
      type?: string;
      message?: {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
      };
    };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.type !== "message") continue;
    const role = parsed.message?.role;
    if (role === "user") {
      userSeen++;
      continue;
    }
    if (userSeen <= skipUserMsgs) continue;
    if (role === "assistant") {
      last = {
        stopReason: parsed.message?.stopReason,
        errorMessage: parsed.message?.errorMessage,
      };
    }
  }
  return last;
}

function isUserMessageLine(line: string): boolean {
  if (!line) return false;
  // Cheap pre-filter to avoid JSON.parse on every non-message line.
  if (!line.includes(`"type":"message"`)) return false;
  if (!line.includes(`"role":"user"`)) return false;
  try {
    const e = JSON.parse(line) as {
      type?: string;
      message?: { role?: string };
    };
    return e.type === "message" && e.message?.role === "user";
  } catch {
    return false;
  }
}

