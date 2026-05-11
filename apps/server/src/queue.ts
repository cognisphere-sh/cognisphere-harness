import Database from "better-sqlite3";
import type { BatchMessage } from "./types.js";

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
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  plugin_id    TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  is_silent    INTEGER NOT NULL DEFAULT 0,
  text         TEXT NOT NULL,
  metadata     TEXT,
  status       TEXT NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_runnable
  ON events(thread_id, status, is_silent, priority DESC, id);
CREATE INDEX IF NOT EXISTS idx_events_updated ON events(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_status  ON events(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_plugin  ON events(plugin_id, updated_at DESC);
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
  text: string;
  metadata: string | null;
  status: EventStatus;
  priority: number;
  attempts: number;
  error: string | null;
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
            text, metadata, status, priority, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0)`,
      )
      .run(
        now,
        now,
        args.pluginId,
        args.channelId,
        args.threadId,
        args.isSilent ? 1 : 0,
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

  dequeueBatch(threadId: string): BatchMessage[] {
    const txn = this.db.transaction((): BatchMessage[] => {
      const rows = this.db
        .prepare<unknown[], EventRow>(
          `SELECT * FROM events
           WHERE thread_id = ? AND status = 'queued'
           ORDER BY priority DESC, id ASC`,
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

  markBatchDone(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE events SET status = 'done', updated_at = ?
         WHERE id IN (${placeholders})`,
      )
      .run(Date.now(), ...ids);
  }

  /** Terminal cancellation (user abort, plugin-driven cancel, runner stop). */
  markBatchCancelled(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE events SET status = 'cancelled', updated_at = ?
         WHERE id IN (${placeholders})`,
      )
      .run(Date.now(), ...ids);
  }

  markBatchFailed(
    ids: number[],
    error: string,
    maxAttempts: number,
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
                 SET status = 'failed', attempts = ?, error = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(next, error, now, r.id);
          dead.push(r.id);
        } else {
          this.db
            .prepare(
              `UPDATE events
                 SET status = 'queued', attempts = ?, error = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(next, error, now, r.id);
          retrying.push(r.id);
        }
      }
    });
    txn();
    return { retrying, dead };
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
    return this.markBatchFailed(rows.map((r) => r.id), error, maxAttempts);
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

  /** Reset a failed row back to queued. Returns the row id, or null if not found / not failed. */
  requeueFailed(id: number): number | null {
    const info = this.db
      .prepare(
        `UPDATE events
           SET status = 'queued', attempts = 0, error = NULL, updated_at = ?
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
