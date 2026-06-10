import Database from "better-sqlite3";
import type { BatchMessage, RetryMode } from "./types.js";

/**
 * Single-table event lifecycle: every notify() inserts one row; the row's
 * `status` advances as the runner processes it (queued → in_flight → done,
 * or queued ↔ failed, or cancelled). Rows persist after completion so the
 * UI can show the full history. Backed by a fresh `.events.db` file; the
 * pre-v2 `.queue.db` (with its messages/dead_letter/events split) is left
 * untouched on disk for operator inspection.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  plugin_id      TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  is_silent      INTEGER NOT NULL DEFAULT 0,
  do_not_steer   INTEGER NOT NULL DEFAULT 0,
  text           TEXT NOT NULL,
  metadata       TEXT,
  status         TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  pi_session_id  TEXT,
  pi_entry_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_runnable
  ON events(thread_id, status, is_silent, priority DESC, id);
CREATE INDEX IF NOT EXISTS idx_events_updated ON events(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_status  ON events(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_plugin  ON events(plugin_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS threads (
  thread_id      TEXT PRIMARY KEY,
  pi_session_id  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  model_provider TEXT,
  model_id       TEXT,
  thinking_level TEXT
);
`;

export type EventStatus = "queued" | "in_flight" | "done" | "failed" | "cancelled";

export interface EventRow {
  id: number;
  ts: number;
  updated_at: number;
  plugin_id: string;
  channel_id: string;
  thread_id: string;
  is_silent: number;
  do_not_steer: number;
  text: string;
  metadata: string | null;
  status: EventStatus;
  priority: number;
  attempts: number;
  error: string | null;
  pi_session_id: string | null;
  pi_entry_id: string | null;
}

/**
 * Derive a re-dispatch {@link RetryMode} from a row's persisted state. No
 * dedicated column: a row that was delivered to the model has its
 * `pi_entry_id` written in real time (by the runner, from the harness-bridge
 * extension), so its presence on a retried row means "already in pi's
 * history → continue, don't resend".
 */
function deriveRetryMode(row: EventRow): RetryMode | undefined {
  if (row.pi_entry_id != null) return "continue";
  if (row.attempts > 0) return "resend";
  return undefined;
}

function rowToMessage(row: EventRow): BatchMessage {
  return {
    id: row.id,
    enqueuedAt: row.ts,
    pluginId: row.plugin_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    text: row.text,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    isSilent: row.is_silent === 1,
    attempts: row.attempts,
    retryMode: deriveRetryMode(row),
  };
}

export interface EnqueueArgs {
  pluginId: string;
  channelId: string;
  threadId: string;
  text: string;
  metadata: Record<string, unknown> | null;
  priority: number;
  isSilent: boolean;
  doNotSteer: boolean;
}

export interface ListEventsOpts {
  statuses?: string[];
  pluginId?: string;
  search?: string;
  isSilent?: boolean;
  tsFrom?: number;
  tsTo?: number;
  updatedFrom?: number;
  updatedTo?: number;
  sortBy?: "ts" | "updated_at" | "status" | "plugin_id" | "thread_id";
  sortDir?: "asc" | "desc";
  limit: number;
  offset: number;
}

const SORTABLE_COLS = new Set<NonNullable<ListEventsOpts["sortBy"]>>([
  "ts",
  "updated_at",
  "status",
  "plugin_id",
  "thread_id",
]);

/**
 * SQLite event-lifecycle table for a single agent.
 *
 * `<agent>/sessions/.events.db`. WAL mode, synchronous writes, all calls sync.
 */
export class AgentDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.migrateAddColumn("events", "pi_session_id", "TEXT");
    this.migrateAddColumn("events", "pi_entry_id", "TEXT");
    // Steer opt-out: a row flagged here is never injected into a live batch by
    // the drain path — it waits for the next batch (see dequeueBatch).
    this.migrateAddColumn("events", "do_not_steer", "INTEGER NOT NULL DEFAULT 0");
    // Per-thread model override (NULL ⇒ inherit the agent's agent.json model).
    this.migrateAddColumn("threads", "model_provider", "TEXT");
    this.migrateAddColumn("threads", "model_id", "TEXT");
    this.migrateAddColumn("threads", "thinking_level", "TEXT");
  }

  /** Add a column to an existing table if it isn't already there. SQLite has
   *  no `ADD COLUMN IF NOT EXISTS`, so we check `PRAGMA table_info`. */
  private migrateAddColumn(table: string, column: string, type: string): void {
    const cols = this.db
      .prepare<unknown[], { name: string }>(`PRAGMA table_info(${table})`)
      .all();
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  close(): void {
    this.db.close();
  }

  // ── lifecycle writes ──────────────────────────────────────

  enqueue(args: EnqueueArgs): number {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO events
           (ts, updated_at, plugin_id, channel_id, thread_id, is_silent,
            do_not_steer, text, metadata, status, priority, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0)`,
      )
      .run(
        now,
        now,
        args.pluginId,
        args.channelId,
        args.threadId,
        args.isSilent ? 1 : 0,
        args.doNotSteer ? 1 : 0,
        args.text,
        args.metadata ? JSON.stringify(args.metadata) : null,
        args.priority,
      );
    return info.lastInsertRowid as number;
  }

  /**
   * Pick a thread that has at least one queued non-silent row (so all-silent
   * threads stay parked). Skip threads supplied in `excludeThreads`.
   */
  peekHighestPriorityThread(excludeThreads: Set<string>): string | null {
    const rows = this.db
      .prepare<unknown[], { thread_id: string }>(
        `SELECT DISTINCT thread_id FROM events
         WHERE status = 'queued' AND is_silent = 0
         ORDER BY priority DESC, id ASC`,
      )
      .all();
    for (const r of rows) {
      if (!excludeThreads.has(r.thread_id)) return r.thread_id;
    }
    return null;
  }

  /**
   * Claim queued rows for one thread and flip them to `in_flight` in a single
   * transaction.
   *
   * Options:
   *  - `continueOnly` — claim only *continue* rows (already delivered on a
   *    prior batch, `pi_entry_id IS NOT NULL`). The runner sends these as their
   *    own prompt (a continuation nudge), isolated from other work.
   *  - `excludeDoNotSteer` — skip rows flagged `do_not_steer`. Used by the
   *    drain path (`drainQueuedAsSteers`), which injects claimed rows as a
   *    *steer* into a live batch: a `doNotSteer` row must not be steered, so it
   *    is left queued for the next batch. The batch-start claim does NOT set
   *    this — `doNotSteer` only forbids steering into a live batch, not forming
   *    a fresh prompt.
   *
   * A plain call (no options) claims everything still queued — resend + fresh
   * rows — which the runner concatenates into one prompt.
   */
  dequeueBatch(
    threadId: string,
    opts: { continueOnly?: boolean; excludeDoNotSteer?: boolean } = {},
  ): BatchMessage[] {
    const conds = ["thread_id = ?", "status = 'queued'"];
    if (opts.continueOnly) conds.push("pi_entry_id IS NOT NULL");
    if (opts.excludeDoNotSteer) conds.push("do_not_steer = 0");
    const where = conds.join(" AND ");
    const txn = this.db.transaction((): BatchMessage[] => {
      const rows = this.db
        .prepare<unknown[], EventRow>(
          `SELECT * FROM events WHERE ${where} ORDER BY priority DESC, id ASC`,
        )
        .all(threadId);
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE events SET status = 'in_flight', updated_at = ?
           WHERE id IN (${placeholders})`,
        )
        .run(Date.now(), ...ids);
      return rows.map(rowToMessage);
    });
    return txn();
  }

  /**
   * Advance specific rows to `in_flight` by id. Used when a row is steered
   * into an already-streaming batch: `dequeueBatch` never sees it (it was
   * enqueued after the batch was dequeued), so the runner calls this once the
   * steer is successfully dispatched to the live pi — keeping the steered row's
   * status consistent with the rest of the in-flight batch instead of leaving
   * it stuck at `queued`.
   */
  markInFlight(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE events SET status = 'in_flight', updated_at = ?
           WHERE id IN (${placeholders}) AND status = 'queued'`,
      )
      .run(Date.now(), ...ids);
  }

  /**
   * Bind a row to its position in pi's session JSONL. Called by the runner in
   * real time as the harness-bridge extension reports each user-message entry
   * id (so the link exists even for rows whose batch later fails, and without
   * waiting for pi to exit). COALESCE on the session id preserves a value from
   * a prior attempt; the entry id is written outright (the latest delivery
   * wins).
   */
  setRowEntryId(rowId: number, sessionId: string, entryId: string): void {
    this.db
      .prepare(
        `UPDATE events
            SET pi_session_id = COALESCE(?, pi_session_id),
                pi_entry_id   = ?,
                updated_at    = ?
          WHERE id = ?`,
      )
      .run(sessionId, entryId, Date.now(), rowId);
  }

  /**
   * Mark every id done. `sessionId` (when non-null) is written to all rows.
   * Per-row `pi_entry_id`s are no longer threaded through here — they are
   * written in real time via {@link setRowEntryId} during the batch.
   */
  markBatchDone(ids: number[], sessionId: string | null): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const txn = this.db.transaction(() => {
      const stmt = this.db.prepare(
        `UPDATE events
            SET status = 'done',
                updated_at = ?,
                pi_session_id = COALESCE(?, pi_session_id)
          WHERE id = ?`,
      );
      for (const id of ids) {
        stmt.run(now, sessionId, id);
      }
    });
    txn();
  }

  /** Terminal cancellation (user abort, plugin-driven cancel, runner stop).
   *  `sessionId` is recorded so the operator can still link the row to a
   *  session even when no entry id was captured. */
  markBatchCancelled(ids: number[], sessionId: string | null): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE events
            SET status = 'cancelled',
                updated_at = ?,
                pi_session_id = COALESCE(?, pi_session_id)
          WHERE id IN (${placeholders})`,
      )
      .run(Date.now(), sessionId, ...ids);
  }

  markBatchFailed(
    ids: number[],
    error: string,
    maxAttempts: number,
    sessionId: string | null,
  ): { retrying: number[]; dead: number[] } {
    if (ids.length === 0) return { retrying: [], dead: [] };
    const retrying: number[] = [];
    const dead: number[] = [];
    const txn = this.db.transaction(() => {
      const placeholders = ids.map(() => "?").join(",");
      const rows = this.db
        .prepare<unknown[], EventRow>(
          `SELECT id, attempts FROM events WHERE id IN (${placeholders})`,
        )
        .all(...ids);
      const now = Date.now();
      for (const r of rows) {
        const next = r.attempts + 1;
        if (next >= maxAttempts) {
          this.db
            .prepare(
              `UPDATE events
                 SET status = 'failed', attempts = ?, error = ?, updated_at = ?,
                     pi_session_id = COALESCE(?, pi_session_id)
               WHERE id = ?`,
            )
            .run(next, error, now, sessionId, r.id);
          dead.push(r.id);
        } else {
          this.db
            .prepare(
              `UPDATE events
                 SET status = 'queued', attempts = ?, error = ?, updated_at = ?,
                     pi_session_id = COALESCE(?, pi_session_id)
               WHERE id = ?`,
            )
            .run(next, error, now, sessionId, r.id);
          retrying.push(r.id);
        }
      }
    });
    txn();
    return { retrying, dead };
  }

  // ── per-thread session binding ─────────────────────────────

  /** Returns the canonical pi session id for this thread, or null if none
   *  has been recorded yet (first batch on this thread). */
  getThreadSessionId(threadId: string): string | null {
    const row = this.db
      .prepare<unknown[], { pi_session_id: string }>(
        `SELECT pi_session_id FROM threads WHERE thread_id = ?`,
      )
      .get(threadId);
    return row?.pi_session_id ?? null;
  }

  /** Record a thread's canonical session id. INSERT OR IGNORE so a
   *  concurrent bind never overwrites an existing mapping (the harness
   *  serializes per-thread anyway, but this is a cheap belt-and-braces). */
  setThreadSessionId(threadId: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO threads (thread_id, pi_session_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(threadId, sessionId, Date.now());
  }

  // ── per-thread model override ──────────────────────────────
  // NULL columns mean "inherit the agent's agent.json model". A row only
  // exists once the thread has bound a session (setThreadSessionId), so the
  // setters UPDATE in place rather than insert.

  /** Returns the thread's model override, or null if it inherits the agent
   *  default (or has no row yet). */
  getThreadModel(
    threadId: string,
  ): { provider: string; modelId: string; thinkingLevel: string | null } | null {
    const row = this.db
      .prepare<
        unknown[],
        {
          model_provider: string | null;
          model_id: string | null;
          thinking_level: string | null;
        }
      >(
        `SELECT model_provider, model_id, thinking_level
           FROM threads WHERE thread_id = ?`,
      )
      .get(threadId);
    if (!row || !row.model_provider || !row.model_id) return null;
    return {
      provider: row.model_provider,
      modelId: row.model_id,
      thinkingLevel: row.thinking_level,
    };
  }

  /** Set a thread's model override. Returns false if the thread has no row
   *  yet (no session bound) — the caller should surface that to the user. */
  setThreadModel(
    threadId: string,
    provider: string,
    modelId: string,
    thinkingLevel: string | null,
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE threads
            SET model_provider = ?, model_id = ?, thinking_level = ?
          WHERE thread_id = ?`,
      )
      .run(provider, modelId, thinkingLevel, threadId);
    return info.changes > 0;
  }

  /** Clear a thread's override so it reverts to the agent default. Returns
   *  false if the thread has no row yet. */
  clearThreadModel(threadId: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE threads
            SET model_provider = NULL, model_id = NULL, thinking_level = NULL
          WHERE thread_id = ?`,
      )
      .run(threadId);
    return info.changes > 0;
  }

  /** Drop all events for a thread and its session-binding row, in one
   *  transaction. Returns the number of event rows deleted. Caller is
   *  responsible for ensuring no batch is in-flight for this thread. */
  deleteThread(threadId: string): { events: number } {
    let events = 0;
    const txn = this.db.transaction(() => {
      const info = this.db
        .prepare(`DELETE FROM events WHERE thread_id = ?`)
        .run(threadId);
      events = info.changes;
      this.db
        .prepare(`DELETE FROM threads WHERE thread_id = ?`)
        .run(threadId);
    });
    txn();
    return { events };
  }

  /** Drop a still-queued row. Refuses if it has already advanced past queued. */
  removeById(id: number): boolean {
    const info = this.db
      .prepare(`DELETE FROM events WHERE id = ? AND status = 'queued'`)
      .run(id);
    return info.changes > 0;
  }

  /** Crash recovery: any row stuck in 'in_flight' is treated as a failed attempt. */
  sweepInFlight(maxAttempts: number, error = "process died mid-batch") {
    const rows = this.db
      .prepare<unknown[], { id: number }>(
        `SELECT id FROM events WHERE status = 'in_flight'`,
      )
      .all();
    if (rows.length === 0) return { retrying: [], dead: [] };
    // sessionId=null preserves any existing pi_session_id via COALESCE.
    return this.markBatchFailed(rows.map((r) => r.id), `[crash] ${error}`, maxAttempts, null);
  }

  countPending(): number {
    const r = this.db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) as n FROM events WHERE status IN ('queued','in_flight')`,
      )
      .get();
    return r?.n ?? 0;
  }

  // ── DLQ-style actions on failed rows ──────────────────────

  /** Revive a failed (dead-lettered) row back to queued as a **warned resend**.
   *  `pi_entry_id` is cleared and `attempts` is set to 1 (not 0), so the row
   *  re-dispatches in resend mode — full original text carrying `Retry: true`
   *  — rather than continue mode (a contentless nudge).
   *
   *  A DLQ row only reaches here via operator action, long after the automatic
   *  continue-retries already failed `maxAttempts` times; re-nudging just
   *  repeats the strategy that failed and is fragile to a stale/compacted
   *  session, whereas a resend re-establishes the actual content and the
   *  `Retry: true` line guards against re-doing partial work. `attempts = 1`
   *  both selects resend mode (`deriveRetryMode`) and renders `Retry: true`
   *  (`buildHarnessMetadata`), while leaving `maxAttempts − 1` further tries.
   *  The next delivery re-sets `pi_entry_id`, so any subsequent *automatic*
   *  retry resumes in continue mode as usual — this only forces one resend.
   *
   *  Returns the row id, or null if not found / not failed. */
  requeueFailed(id: number): number | null {
    const info = this.db
      .prepare(
        `UPDATE events
           SET status = 'queued', attempts = 1, error = NULL,
               pi_entry_id = NULL, updated_at = ?
         WHERE id = ? AND status = 'failed'`,
      )
      .run(Date.now(), id);
    return info.changes > 0 ? id : null;
  }

  /** Permanently delete a failed row. */
  removeFailed(id: number): boolean {
    const info = this.db
      .prepare(`DELETE FROM events WHERE id = ? AND status = 'failed'`)
      .run(id);
    return info.changes > 0;
  }

  /**
   * Permanently delete any row that is not currently in_flight. Refuses
   * in_flight to avoid racing the runner mid-batch — abort the batch first.
   * Returns 'ok' on success, 'not_found' if no such row, 'in_flight' if the
   * row is owned by the runner.
   */
  removeAny(id: number): "ok" | "not_found" | "in_flight" {
    const cur = this.db
      .prepare<unknown[], { status: EventStatus }>(
        `SELECT status FROM events WHERE id = ?`,
      )
      .get(id);
    if (!cur) return "not_found";
    if (cur.status === "in_flight") return "in_flight";
    const info = this.db
      .prepare(`DELETE FROM events WHERE id = ? AND status != 'in_flight'`)
      .run(id);
    return info.changes > 0 ? "ok" : "not_found";
  }

  /**
   * Force a row to a new status. Refuses to touch rows currently in_flight
   * and refuses to set status to in_flight — both transitions belong to the
   * runner. When forcing back to 'queued', attempts/error are reset like
   * requeueFailed does.
   */
  setStatus(
    id: number,
    next: EventStatus,
  ): "ok" | "not_found" | "in_flight" | "bad_status" {
    if (next === "in_flight") return "bad_status";
    const cur = this.db
      .prepare<unknown[], { status: EventStatus }>(
        `SELECT status FROM events WHERE id = ?`,
      )
      .get(id);
    if (!cur) return "not_found";
    if (cur.status === "in_flight") return "in_flight";
    const now = Date.now();
    if (next === "queued") {
      // Operator-forced revival is a **warned resend**, same as requeueFailed:
      // clear `pi_entry_id` and set `attempts = 1` so the row re-dispatches as
      // full text with `Retry: true`, never a continue nudge. Continue mode is
      // reserved for the automatic in-loop retry; no manual action produces it.
      this.db
        .prepare(
          `UPDATE events
             SET status = 'queued', attempts = 1, error = NULL,
                 pi_entry_id = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, id);
    } else {
      this.db
        .prepare(`UPDATE events SET status = ?, updated_at = ? WHERE id = ?`)
        .run(next, now, id);
    }
    return "ok";
  }

  // ── reads ─────────────────────────────────────────────────

  listEvents(opts: ListEventsOpts): EventRow[] {
    const { sql, params } = this.buildWhere(opts);
    const sortBy = opts.sortBy && SORTABLE_COLS.has(opts.sortBy) ? opts.sortBy : "updated_at";
    const sortDir = opts.sortDir === "asc" ? "ASC" : "DESC";
    return this.db
      .prepare<unknown[], EventRow>(
        `SELECT * FROM events ${sql} ORDER BY ${sortBy} ${sortDir}, id ${sortDir} LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset);
  }

  countEvents(opts: Omit<ListEventsOpts, "sortBy" | "sortDir" | "limit" | "offset">): number {
    const { sql, params } = this.buildWhere(opts);
    const r = this.db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) as n FROM events ${sql}`,
      )
      .get(...params);
    return r?.n ?? 0;
  }

  private buildWhere(
    opts: Pick<
      ListEventsOpts,
      | "statuses"
      | "pluginId"
      | "search"
      | "isSilent"
      | "tsFrom"
      | "tsTo"
      | "updatedFrom"
      | "updatedTo"
    >,
  ): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.statuses && opts.statuses.length > 0) {
      const ph = opts.statuses.map(() => "?").join(",");
      clauses.push(`status IN (${ph})`);
      params.push(...opts.statuses);
    }
    if (opts.pluginId) {
      clauses.push(`plugin_id = ?`);
      params.push(opts.pluginId);
    }
    if (opts.search) {
      clauses.push(`(text LIKE ? OR metadata LIKE ?)`);
      const needle = `%${opts.search}%`;
      params.push(needle, needle);
    }
    if (opts.isSilent != null) {
      clauses.push(`is_silent = ?`);
      params.push(opts.isSilent ? 1 : 0);
    }
    if (opts.tsFrom != null) {
      clauses.push(`ts >= ?`);
      params.push(opts.tsFrom);
    }
    if (opts.tsTo != null) {
      clauses.push(`ts <= ?`);
      params.push(opts.tsTo);
    }
    if (opts.updatedFrom != null) {
      clauses.push(`updated_at >= ?`);
      params.push(opts.updatedFrom);
    }
    if (opts.updatedTo != null) {
      clauses.push(`updated_at <= ?`);
      params.push(opts.updatedTo);
    }
    return {
      sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
      params,
    };
  }
}
