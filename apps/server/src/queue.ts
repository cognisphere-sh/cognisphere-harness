import Database from "better-sqlite3";
import type { BatchMessage, QueuedRow } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  enqueued_at  INTEGER NOT NULL,
  plugin_id    TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  text         TEXT NOT NULL,
  metadata     TEXT,
  priority     INTEGER NOT NULL DEFAULT 0,
  is_silent    INTEGER NOT NULL DEFAULT 0,
  in_flight    INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pending
  ON messages(thread_id, in_flight, priority DESC, id);

CREATE TABLE IF NOT EXISTS dead_letter (
  id           INTEGER PRIMARY KEY,
  enqueued_at  INTEGER NOT NULL,
  plugin_id    TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  text         TEXT NOT NULL,
  metadata     TEXT,
  priority     INTEGER NOT NULL,
  is_silent    INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL,
  last_error   TEXT,
  dead_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  event            TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  plugin_id        TEXT,
  notification     TEXT,
  channel_id       TEXT,
  thread_id        TEXT,
  batch_id         TEXT,
  status           TEXT NOT NULL,
  message_queue_id INTEGER,
  session_file     TEXT,
  message_index    INTEGER,
  log              TEXT,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_thread    ON events(thread_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_status    ON events(status, ts);
`;

function rowToMessage(row: QueuedRow): BatchMessage {
  return {
    id: row.id,
    enqueuedAt: row.enqueued_at,
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

export interface DeadLetterRow {
  id: number;
  enqueued_at: number;
  plugin_id: string;
  channel_id: string;
  thread_id: string;
  text: string;
  metadata: string | null;
  priority: number;
  is_silent: number;
  attempts: number;
  last_error: string | null;
  dead_at: number;
}

export interface EventRow {
  id: number;
  ts: number;
  event: string;
  agent_id: string;
  plugin_id: string | null;
  notification: string | null;
  channel_id: string | null;
  thread_id: string | null;
  batch_id: string | null;
  status: string;
  message_queue_id: number | null;
  session_file: string | null;
  message_index: number | null;
  log: string | null;
  error: string | null;
}

export interface AppendEventArgs {
  event: string;
  status: string;
  pluginId?: string;
  notification?: string;
  channelId?: string;
  threadId?: string;
  batchId?: string;
  messageQueueId?: number;
  sessionFile?: string;
  messageIndex?: number;
  log?: string;
  error?: string;
}

/**
 * SQLite queue + event log for a single agent.
 *
 * `<agent>/sessions/.queue.db`. WAL mode, synchronous writes, all calls sync.
 * Both `messages` and `events` live in the same file.
 */
export class AgentDb {
  private db: Database.Database;

  constructor(
    dbPath: string,
    private readonly agentId: string,
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── messages ───────────────────────────────────────────────

  enqueue(args: EnqueueArgs): number {
    const info = this.db
      .prepare(
        `INSERT INTO messages
           (enqueued_at, plugin_id, channel_id, thread_id, text, metadata,
            priority, is_silent, in_flight, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(
        Date.now(),
        args.pluginId,
        args.channelId,
        args.threadId,
        args.text,
        args.metadata ? JSON.stringify(args.metadata) : null,
        args.priority,
        args.isSilent ? 1 : 0,
      );
    return info.lastInsertRowid as number;
  }

  /**
   * Pick a thread that has at least one pending non-silent message (so
   * all-silent threads stay parked). Skip threads supplied in `excludeThreads`.
   */
  peekHighestPriorityThread(excludeThreads: Set<string>): string | null {
    const rows = this.db
      .prepare<unknown[], { thread_id: string }>(
        `SELECT DISTINCT thread_id FROM messages
         WHERE in_flight = 0 AND is_silent = 0
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
        .prepare<unknown[], QueuedRow>(
          `SELECT * FROM messages
           WHERE thread_id = ? AND in_flight = 0
           ORDER BY priority DESC, id ASC`,
        )
        .all(threadId);
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(`UPDATE messages SET in_flight = 1 WHERE id IN (${placeholders})`)
        .run(...ids);
      return rows.map(rowToMessage);
    });
    return txn();
  }

  markBatchDone(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
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
        .prepare<unknown[], QueuedRow>(
          `SELECT * FROM messages WHERE id IN (${placeholders})`,
        )
        .all(...ids);
      const now = Date.now();
      for (const r of rows) {
        const next = r.attempts + 1;
        if (next >= maxAttempts) {
          this.db
            .prepare(
              `INSERT INTO dead_letter
                 (id, enqueued_at, plugin_id, channel_id, thread_id, text, metadata,
                  priority, is_silent, attempts, last_error, dead_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              r.id,
              r.enqueued_at,
              r.plugin_id,
              r.channel_id,
              r.thread_id,
              r.text,
              r.metadata,
              r.priority,
              r.is_silent,
              next,
              error,
              now,
            );
          this.db.prepare(`DELETE FROM messages WHERE id = ?`).run(r.id);
          dead.push(r.id);
        } else {
          this.db
            .prepare(
              `UPDATE messages SET attempts = ?, in_flight = 0 WHERE id = ?`,
            )
            .run(next, r.id);
          retrying.push(r.id);
        }
      }
    });
    txn();
    return { retrying, dead };
  }

  removeById(id: number): boolean {
    const info = this.db
      .prepare(`DELETE FROM messages WHERE id = ? AND in_flight = 0`)
      .run(id);
    return info.changes > 0;
  }

  /** Crash recovery: clear in_flight on all rows. Caller decides whether
   *  to bump attempts; we preserve the stuck-row invariant by returning ids. */
  sweepInFlight(maxAttempts: number, error = "process died mid-batch") {
    const rows = this.db
      .prepare<unknown[], { id: number }>(
        `SELECT id FROM messages WHERE in_flight = 1`,
      )
      .all();
    if (rows.length === 0) return { retrying: [], dead: [] };
    return this.markBatchFailed(rows.map((r) => r.id), error, maxAttempts);
  }

  countPending(): number {
    const r = this.db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) as n FROM messages`,
      )
      .get();
    return r?.n ?? 0;
  }

  listPending(limit = 200): QueuedRow[] {
    return this.db
      .prepare<unknown[], QueuedRow>(
        `SELECT * FROM messages ORDER BY priority DESC, id ASC LIMIT ?`,
      )
      .all(limit);
  }

  listDeadLetter(limit = 200): DeadLetterRow[] {
    return this.db
      .prepare<unknown[], DeadLetterRow>(
        `SELECT * FROM dead_letter ORDER BY dead_at DESC, id DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** Move a DLQ row back to messages and reset attempts. Returns the new id. */
  requeueDeadLetter(id: number): number | null {
    const txn = this.db.transaction((): number | null => {
      const row = this.db
        .prepare<unknown[], DeadLetterRow>(
          `SELECT * FROM dead_letter WHERE id = ?`,
        )
        .get(id);
      if (!row) return null;
      const info = this.db
        .prepare(
          `INSERT INTO messages
             (enqueued_at, plugin_id, channel_id, thread_id, text, metadata,
              priority, is_silent, in_flight, attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        )
        .run(
          Date.now(),
          row.plugin_id,
          row.channel_id,
          row.thread_id,
          row.text,
          row.metadata,
          row.priority,
          row.is_silent,
        );
      this.db.prepare(`DELETE FROM dead_letter WHERE id = ?`).run(id);
      return info.lastInsertRowid as number;
    });
    return txn();
  }

  removeDeadLetter(id: number): boolean {
    const info = this.db.prepare(`DELETE FROM dead_letter WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  // ── events ────────────────────────────────────────────────

  appendEvent(args: AppendEventArgs): number {
    const info = this.db
      .prepare(
        `INSERT INTO events
           (ts, event, agent_id, plugin_id, notification, channel_id,
            thread_id, batch_id, status, message_queue_id, session_file,
            message_index, log, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        args.event,
        this.agentId,
        args.pluginId ?? null,
        args.notification ?? null,
        args.channelId ?? null,
        args.threadId ?? null,
        args.batchId ?? null,
        args.status,
        args.messageQueueId ?? null,
        args.sessionFile ?? null,
        args.messageIndex ?? null,
        args.log ?? null,
        args.error ?? null,
      );
    return info.lastInsertRowid as number;
  }

  tailEvents(sinceMs: number | null, limit: number): EventRow[] {
    const since = sinceMs ?? 0;
    return this.db
      .prepare<unknown[], EventRow>(
        `SELECT * FROM events WHERE ts >= ? ORDER BY id DESC LIMIT ?`,
      )
      .all(since, limit);
  }
}
