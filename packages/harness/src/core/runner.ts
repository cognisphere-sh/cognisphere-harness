import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentDb } from "./queue.js";
import { PiRpcClient } from "./rpc.js";
import type { PiMessage } from "./rpc.js";
import type {
  AgentJson,
  BatchMessage,
  NotifyPayload,
  ThreadIdStrategy,
} from "./types.js";
import { AGENT_TOOLS } from "./types.js";
import type { Logger } from "./logger.js";

const RESERVED_META = new Set([
  "Timestamp",
  "Plugin",
  "Channel",
  "ThreadId",
  "IsSilent",
  "Retry",
  "Continuation",
]);

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

function fmtTs(unixMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(new Date(unixMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const weekday = get("weekday").replace(".", "");
  return `${weekday} ${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
}

export function buildHarnessMetadata(m: BatchMessage, tz: string): string {
  const lines = [
    "<harness-metadata>",
    `Timestamp: ${fmtTs(m.enqueuedAt, tz)}`,
    `Plugin: ${m.pluginId}`,
    `Channel: ${m.channelId}`,
    `ThreadId: ${m.threadId}`,
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

/**
 * Prompt fragment used to resume a thread whose previous turn was interrupted
 * (the LLM connection dropped, or pi stopped mid-loop on a context cap). The
 * interrupted rows' original text is already in pi's session history, so we
 * send a single generic continuation note instead of re-sending it — the
 * automated equivalent of a human typing "continue". Carries a slim metadata
 * block (no plugin/channel; the originals are in history) tagged
 * `Continuation: true`, which the base prompt documents.
 */
export function buildContinuationNudge(tz: string): string {
  return [
    "<harness-metadata>",
    `Timestamp: ${fmtTs(Date.now(), tz)}`,
    "Continuation: true",
    "</harness-metadata>",
    "Your previous turn on this thread ended before it finished — the process or " +
      "model connection stopped mid-step. The original request(s) and everything " +
      "you already did are in the conversation history above and are NOT repeated " +
      "here. Do not restart from scratch and do not ask anyone to resend. Continue " +
      "from where you left off and finish the remaining work.",
  ].join("\n");
}

/**
 * Classify a finished pi run from the messages carried on its `agent_end`
 * frame. The turn is complete only when its **last** message is an assistant
 * message that stopped naturally (`stopReason: "stop"`). Pi's agent loop
 * appends tool results after an assistant turn, so a last message that is a
 * `toolResult` (or an assistant with `toolUse`/`length`) means the loop was
 * cut off mid-step (e.g. a context-budget stop) and the work isn't done.
 */
function endOfTurn(messages: PiMessage[]): { complete: boolean; errorTag: string } {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.stopReason === "stop") {
    return { complete: true, errorTag: "" };
  }
  if (last?.role === "assistant" && last.stopReason === "error") {
    return {
      complete: false,
      errorTag: `[agent_error] ${last.errorMessage ?? "(no errorMessage)"}`,
    };
  }
  const detail = last
    ? last.role === "assistant"
      ? `assistant/${last.stopReason ?? "?"}`
      : (last.role ?? "?")
    : "empty";
  return {
    complete: false,
    errorTag: `[incomplete] turn ended mid-step (last=${detail})`,
  };
}

interface ActiveBatch {
  threadId: string;
  /** User-message groups in dispatch order. `[0]` is the prompt's rows (the
   *  resend + fresh rows; empty on a continue batch, whose prompt is just the
   *  nudge). `[k≥1]` is the k-th steer's rows — a single-row group for a live
   *  `notify` steer, or the whole drained resend+fresh set for a continue
   *  batch's combined steer. Maps each user-message entry pi appends to the
   *  row ids sharing it (stdin is serial → append order = dispatch order). */
  messageGroups: number[][];
  /** Canonical pi session id for this thread; assigned in processBatch
   *  before spawn, used to locate the JSONL post-batch. */
  sessionId: string;
  phase: "spawning" | "streaming" | "completing" | "exited";
  cancelled: boolean;
  /** True when the cancel came from runner.stop() (server shutdown/restart,
   *  manual agent stop) rather than a user/plugin abort. The rows are then
   *  requeued via markBatchFailed — delivered rows retry as continue, the
   *  rest as resend — instead of being terminally cancelled. */
  shutdown: boolean;
  rpc: PiRpcClient | null;
  /** True when this batch's prompt is the continuation nudge (continue rows
   *  present); resend + fresh rows are then steered in as one combined steer
   *  via {@link AgentRunner.drainQueuedAsSteers}. */
  isContinue: boolean;
  /** Continue rows — already delivered on a prior batch (their `pi_entry_id`
   *  is set). NOT part of `messageGroups`: their text is not re-rendered (only
   *  the continuation nudge) and they keep their prior entry id, so they map to
   *  no user-message index this batch. Counted as delivered unconditionally. */
  continueIds: Set<number>;
  /** Count of user messages pi has appended this batch (prompt = 1, then one
   *  per delivered steer). Drives the post-batch delivery split. */
  deliveredCount: number;
  /** entryIds already bound to a row this batch. The harness-bridge sweeps
   *  pi's *entire* session JSONL (one file reused across all of a thread's
   *  batches), so on batch ≥2 it re-reports every historical user entry at a
   *  session-absolute index. We therefore ignore the reported index and bind
   *  each genuinely-new entryId — one not seen before for this batch — to the
   *  next unfilled message group in arrival order. This dedup is the seen-set;
   *  `nextGroupForEntry` is the arrival-order cursor into `messageGroups`. */
  seenEntryIds: Set<string>;
  /** Index of the next `messageGroups` slot to bind a new entryId to. Advances
   *  in dispatch order (group 0 = prompt, then steers), mirroring the order pi
   *  appends user entries to the session. */
  nextGroupForEntry: number;
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
      // A batch the user already aborted stays a cancellation; everything
      // else is a shutdown interruption and will be requeued for retry.
      if (!a.cancelled) a.shutdown = true;
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
      doNotSteer: payload.doNotSteer === true,
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
      const group = [id];
      active.messageGroups.push(group);
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
        // Drop the group we just pushed. Safe under single-threaded JS because
        // notify() runs to completion before the next call interleaves.
        const idx = active.messageGroups.indexOf(group);
        if (idx >= 0) active.messageGroups.splice(idx, 1);
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
      // Continue rows (a delivery that was interrupted) must resume in
      // isolation: they form their own prompt — a single continuation nudge —
      // and are never mixed with other work. If any exist they take priority;
      // the remaining resend + fresh rows are steered in afterwards as one
      // combined steer (drainQueuedAsSteers). Otherwise the normal path claims
      // all queued rows (resend + fresh) into a single concatenated prompt.
      const continueBatch = this.opts.db.dequeueBatch(threadId, { continueOnly: true });
      const isContinue = continueBatch.length > 0;
      const batch = isContinue ? continueBatch : this.opts.db.dequeueBatch(threadId);
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
        // messageGroups[0] = the prompt's rows (resend + fresh; empty on a
        // continue batch). Steers append groups [1..]. Continue rows are
        // tracked separately in continueIds (see the ActiveBatch doc).
        messageGroups: [
          batch.filter((m) => m.retryMode !== "continue").map((m) => m.id),
        ],
        sessionId,
        phase: "spawning",
        cancelled: false,
        shutdown: false,
        rpc: null,
        isContinue,
        continueIds: new Set(
          batch.filter((m) => m.retryMode === "continue").map((m) => m.id),
        ),
        deliveredCount: 0,
        // Pre-seed with entryIds already bound on this thread (prior batches),
        // so the bridge's re-report of historical entries from the reused
        // session JSONL is skipped — only this batch's new entries bind.
        seenEntryIds: new Set(this.opts.db.entryIdsForThread(threadId)),
        nextGroupForEntry: 0,
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

    let rpc: PiRpcClient | null = null;
    let childExited = false;
    try {
      rpc = this.spawnPi(threadId, sessionDir, sessionId, log);
      active.rpc = rpc;
      // Mark the child exited as soon as it closes, so the finally-block
      // teardown can skip the stdin-close/wait/SIGKILL dance on an
      // already-dead child (idempotency guard).
      void rpc.waitExit().then(() => {
        childExited = true;
      });

      // Real-time delivery + entry-id capture from the pi event stream:
      //  - each user message pi appends (the prompt, then each steer) fires
      //    onUserMessageStart → we count deliveries in dispatch order;
      //  - the harness-bridge extension reports each user entry's id, which we
      //    bind to the matching row immediately (so a row that later fails
      //    still carries its pi_entry_id → it retries as 'continue').
      rpc.onUserMessageStart(() => {
        active.deliveredCount++;
      });
      // The bridge's reported `index` is session-absolute and unusable here:
      // pi reuses one session JSONL across a thread's batches, so on batch ≥2
      // it re-reports every historical user entry. We ignore the index and
      // instead bind each genuinely-new entryId — deduped via seenEntryIds —
      // to the next unfilled message group in arrival order (which matches the
      // order pi appends entries: prompt, then each steer).
      rpc.onHarnessEntry(({ entryId }) => {
        if (active.seenEntryIds.has(entryId)) return;
        active.seenEntryIds.add(entryId);
        const group = this.rowsForUserIndex(active, active.nextGroupForEntry);
        active.nextGroupForEntry++;
        for (const id of group) {
          this.opts.db.setRowEntryId(id, sessionId, entryId);
        }
      });

      // Continue rows are not re-rendered — a single generic nudge stands in
      // for all of them (their original text is already in pi's history).
      // Fresh/resend rows render their full text (+ Retry: true when attempts>0).
      const parts: string[] = [];
      if (active.continueIds.size > 0) parts.push(buildContinuationNudge(this.opts.timezone));
      for (const m of batch) {
        if (m.retryMode === "continue") continue;
        parts.push(`${buildHarnessMetadata(m, this.opts.timezone)}\n${m.text}`);
      }
      const promptText = parts.join("\n\n");

      log.info(
        {
          threadId,
          sessionId,
          count: batch.length,
          continue: active.continueIds.size,
          isContinue: active.isContinue,
          plugin: batch[0]!.pluginId,
        },
        "prompt",
      );

      let endMessages: PiMessage[] | null = null;
      const agentEnded = new Promise<void>((resolve) => {
        rpc!.onAgentEnd((messages) => {
          endMessages = messages;
          resolve();
        });
      });
      await rpc.sendPrompt(promptText);
      active.phase = "streaming";
      // Drain anything queued for this thread into the live batch as one
      // combined steer: on a continue batch the resend + fresh rows left behind
      // by the continueOnly dequeue, and on any batch the rows that arrived
      // during the spawn window (before phase flipped to "streaming"). Steering
      // them now keeps FIFO — they land ahead of any later live steer instead
      // of waiting for the next batch. doNotSteer rows are skipped (left queued)
      // inside drainQueuedAsSteers.
      this.drainQueuedAsSteers(active, log);
      // Race agent_end against pi exit; if pi exits first without emitting
      // agent_end, treat it as a crash.
      await Promise.race([agentEnded, rpc.waitExit()]);
      // Pi responds to an abort frame by emitting agent_end cleanly, so the
      // race resolves successfully on user-cancel too. Route to the catch
      // branch (which sees `active.cancelled`) instead of finalizing.
      if (active.cancelled) {
        throw new Error("batch aborted");
      }
      active.phase = "completing";
      await this.ensureChildExited(rpc, log);
      childExited = true;

      // Verdict: completion comes purely from the shape of the agent_end
      // frame's messages (no JSONL read). No agent_end at all ⇒ crash.
      let complete: boolean;
      let errorTag: string;
      if (endMessages === null) {
        complete = false;
        const stderr = rpc.stderrSnapshot()?.slice(-512) ?? "";
        errorTag = `[crash] pi exited without agent_end. stderr: ${stderr}`;
      } else {
        ({ complete, errorTag } = endOfTurn(endMessages));
      }
      this.finalizeBatch(active, complete, errorTag, log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (active.cancelled && active.shutdown) {
        // Runner stop (server restart / manual agent stop) interrupted the
        // batch — requeue rather than cancel. Delivered rows already carry
        // their pi_entry_id, so they retry as continue; the rest as resend.
        const r = this.opts.db.markBatchFailed(
          [...active.continueIds, ...active.messageGroups.flat()],
          "[shutdown] runner stopped mid-batch",
          this.maxAttempts,
          sessionId,
        );
        log.info(
          { threadId, retrying: r.retrying.length, dead: r.dead.length },
          "batch interrupted by stop; requeued",
        );
      } else if (active.cancelled) {
        this.opts.db.markBatchCancelled(
          [...active.continueIds, ...active.messageGroups.flat()],
          sessionId,
        );
        log.info({ threadId }, "batch cancelled");
      } else {
        const stderr = rpc?.stderrSnapshot()?.slice(-512);
        const tagged = msg.startsWith("[") ? msg : `[runner_error] ${msg}`;
        const errFull = stderr ? `${tagged}\n--stderr--\n${stderr}` : tagged;
        const r = this.opts.db.markBatchFailed(
          [...active.continueIds, ...active.messageGroups.flat()],
          errFull,
          this.maxAttempts,
          sessionId,
        );
        log.error(
          { err: msg, threadId, retrying: r.retrying.length, dead: r.dead.length },
          "batch failed",
        );
      }
    } finally {
      // Guarantee the child is dead before the worker loop releases this
      // thread from `active`. The happy path already awaited exit (childExited
      // is set); on a runner_error / abort / throw the child may still be alive
      // and healthy, so close its stdin and SIGKILL-escalate if it lingers.
      // Without this the thread would be freed while a zombie pi keeps
      // appending to the session JSONL — and a worker could immediately spawn a
      // second pi against the same `--session` file, corrupting it.
      if (rpc && !childExited) {
        await this.ensureChildExited(rpc, log);
      }
    }
  }

  /**
   * Close pi's stdin and wait for it to exit, SIGKILL-escalating if it doesn't
   * leave within 5s. Idempotent: `endStdin` no-ops on an already-ended pipe,
   * `waitExit` returns the same cached exit promise (safe to await again), and
   * the SIGKILL timer is cleared the moment exit resolves so a dead child is
   * never signalled.
   */
  private async ensureChildExited(rpc: PiRpcClient, log: Logger): Promise<void> {
    rpc.endStdin();
    const exitTimer = setTimeout(() => {
      log.warn("pi did not exit within 5s; sending SIGKILL");
      rpc.kill("SIGKILL");
    }, 5000);
    try {
      await rpc.waitExit();
    } finally {
      clearTimeout(exitTimer);
    }
  }

  /**
   * Map a user-message dispatch index to the row id(s) sharing that entry.
   * Index 0 is the prompt (the resend/fresh rows on a non-continue batch;
   * empty on a continue batch, whose prompt is just the nudge). Index N≥1 is
   * the N-th steer — a single-row group for a live `notify` steer, or the
   * whole drained resend+fresh group for a continue batch.
   */
  private rowsForUserIndex(active: ActiveBatch, index: number): number[] {
    return active.messageGroups[index] ?? [];
  }

  /** Rows that actually reached the model this batch: continue rows (delivered
   *  on a prior batch) plus every user-message index pi appended. */
  private deliveredRowIds(active: ActiveBatch): Set<number> {
    const delivered = new Set<number>(active.continueIds);
    // messageGroups[k] is delivered once pi has appended k+1 user messages, so
    // every group index < deliveredCount has landed (group 0 = prompt).
    for (let k = 0; k < active.deliveredCount; k++) {
      for (const id of active.messageGroups[k] ?? []) delivered.add(id);
    }
    return delivered;
  }

  /**
   * Split the batch's rows by delivery and outcome:
   *   - rows that never reached the model → `[not_delivered]` (retry as resend);
   *   - delivered rows → done when the turn completed, else failed with
   *     `errorTag` (their pi_entry_id is already set → retry as continue).
   */
  private finalizeBatch(
    active: ActiveBatch,
    complete: boolean,
    errorTag: string,
    log: Logger,
  ): void {
    const allIds = [...active.continueIds, ...active.messageGroups.flat()];
    const delivered = this.deliveredRowIds(active);
    const undelivered = allIds.filter((id) => !delivered.has(id));
    const deliveredIds = allIds.filter((id) => delivered.has(id));

    if (undelivered.length > 0) {
      this.opts.db.markBatchFailed(
        undelivered,
        "[not_delivered] message missing from session after agent_end",
        this.maxAttempts,
        active.sessionId,
      );
    }
    if (deliveredIds.length === 0) {
      // nothing landed; the undelivered branch already handled the rows
    } else if (complete) {
      this.opts.db.markBatchDone(deliveredIds, active.sessionId);
    } else {
      this.opts.db.markBatchFailed(
        deliveredIds,
        errorTag,
        this.maxAttempts,
        active.sessionId,
      );
    }
    log.debug(
      {
        threadId: active.threadId,
        complete,
        delivered: deliveredIds.length,
        undelivered: undelivered.length,
      },
      complete && undelivered.length === 0 ? "batch done" : "batch finalized",
    );
  }

  /**
   * Claim the thread's currently-queued *steerable* rows and inject them as a
   * single combined steer (one user-message entry) into the live batch. Called
   * once the batch is streaming — covers a continue batch's left-behind
   * resend+fresh rows and any batch's spawn-window arrivals. `excludeDoNotSteer`
   * leaves `doNotSteer` rows queued for the next batch (they opt out of being
   * steered into a live turn). The rows are tracked as one group in
   * `messageGroups` before sending, so a broken pipe leaves them classified as
   * not-delivered (→ resend) by the post-batch split rather than orphaned
   * in_flight. resend rows carry `Retry: true` via their metadata.
   */
  private drainQueuedAsSteers(active: ActiveBatch, log: Logger): void {
    const rows = this.opts.db.dequeueBatch(active.threadId, { excludeDoNotSteer: true });
    if (rows.length === 0) return;
    active.messageGroups.push(rows.map((m) => m.id));
    const steerText = rows
      .map((m) => `${buildHarnessMetadata(m, this.opts.timezone)}\n${m.text}`)
      .join("\n\n");
    try {
      active.rpc!.sendSteer(steerText);
      log.debug({ threadId: active.threadId, drained: rows.length }, "drained queued as one steer");
    } catch (err) {
      // Pipe broke; pi is gone. The group stays in messageGroups — the delivery
      // split marks it not-delivered → resend on the next batch.
      log.error({ err, threadId: active.threadId, count: rows.length }, "drain steer failed");
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

