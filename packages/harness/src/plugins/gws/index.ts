import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import type {
  Plugin,
  PluginInstanceContext,
  PluginManifest,
} from "../../core/types.js";
import {
  collectHeaders,
  formatEmail,
  type GmailMessage,
} from "./seed/scripts/format-email.js";

const execFileP = promisify(execFile);
const UNREAD_LABEL = "UNREAD";
const LEDGER_FILE = "ingested-threads.jsonl";

interface GwsConfig {
  pollIntervalSec?: number;
  gmailQuery?: string;
  firstOfThreadOnly?: boolean;
  allowedSenders?: string;
}

interface GwsSecrets {
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE?: string;
}

interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

/**
 * Polls Gmail through the `gws` CLI. For each matching thread it looks only
 * at the most recent message: if the agent's own email is in that message's
 * `To` header it delivers headers + body + attachment paths and wakes the
 * agent; otherwise nothing is emitted. Older messages in the thread are
 * never re-emitted. Every unread message in a handled thread is marked read
 * so the poll query stops re-matching it.
 *
 * (Backlog mode — `firstOfThreadOnly` — instead emits every message in a
 * matching thread, waking only on the first.)
 *
 * Threading: the harness thread id is `<Subject> [<gmailThreadId>]` — taken
 * from the first message of the Gmail thread so a later `Re: …` rewrite
 * still routes to the same queue thread. The agent calls `gws` directly
 * for send / reply-all; no helper CLI is shipped.
 */
export default class GwsPlugin implements Plugin {
  manifest: PluginManifest = {
    displayName: "Google Workspace",
    description:
      "Gmail polling via the `gws` CLI. One notification per inbound message; the agent sends/replies by calling `gws` directly.",
    configSchema: {
      type: "object",
      properties: {
        pollIntervalSec: {
          type: "integer",
          default: 60,
          minimum: 10,
          description: "Seconds between Gmail polls.",
        },
        gmailQuery: {
          type: "string",
          default: "is:unread in:inbox",
          description: "Gmail search query for the poll loop.",
        },
        firstOfThreadOnly: {
          type: "boolean",
          default: false,
          description:
            "Backlog mode: emit every message in matching threads but only wake on the first message of each thread (where messageId == threadId); other messages are delivered silently as context. Skip threads already in state/ingested-threads.jsonl, and append each new threadId to that ledger after emit.",
        },
        allowedSenders: {
          type: "string",
          default: "*",
          description:
            "Comma-separated list of allowed sender patterns; `*` is a wildcard (e.g. `*@abc.com`). Only messages whose `From` address matches an entry are read/emitted; all others are ignored (and marked read). The default `*` (and an empty string) allows every sender.",
        },
      },
      additionalProperties: false,
    },
    secretsSchema: {
      type: "object",
      properties: {
        GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: { type: "string" },
      },
      required: ["GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"],
      additionalProperties: false,
    },
  };

  private ctx?: PluginInstanceContext;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private pollIntervalMs = 60_000;
  private gmailQuery = "is:unread in:inbox";
  private firstOfThreadOnly = false;
  private allowedSenderPatterns: RegExp[] = [];
  private agentEmail = "";

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    const cfg = (ctx.config as GwsConfig | undefined) ?? {};
    this.pollIntervalMs = (cfg.pollIntervalSec ?? 60) * 1000;
    this.gmailQuery = cfg.gmailQuery ?? "is:unread in:inbox";
    this.firstOfThreadOnly = cfg.firstOfThreadOnly === true;
    this.allowedSenderPatterns = parseSenderPatterns(cfg.allowedSenders ?? "*");

    await this.verifyAuth();
    await this.loadAgentEmail();
    this.stopped = false;

    // Self-rescheduling poll: schedules the next tick only after the
    // current one settles, so a slow poll never queues up overlapping ticks.
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.pollOnce();
      } catch (err) {
        ctx.log.error({ err }, "gws poll tick failed; will retry next interval");
      } finally {
        if (!this.stopped) {
          this.timer = setTimeout(tick, this.pollIntervalMs);
        }
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ctx = undefined;
  }

  private async runGws(
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("gws plugin not started");
    const creds =
      (ctx.secrets as GwsSecrets).GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE ?? "";
    return execFileP("gws", args, {
      env: {
        ...process.env,
        GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: creds,
        GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file",
      },
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  /** Look up the authenticated mailbox's primary address via `users.getProfile`.
   *  The agent's address is what we match against `To`/`Cc`/`Bcc` headers to
   *  decide whether an inbound message wakes the agent or parks as silent. */
  private async loadAgentEmail(): Promise<void> {
    const ctx = this.ctx!;
    const params = JSON.stringify({ userId: "me" });
    const { stdout } = await this.runGws([
      "gmail",
      "users",
      "getProfile",
      "--params",
      params,
    ]);
    const profile = JSON.parse(stdout || "{}") as { emailAddress?: string };
    const email = (profile.emailAddress ?? "").trim().toLowerCase();
    if (!email) {
      throw new Error(
        "gws users.getProfile returned no emailAddress; cannot determine agent's own address.",
      );
    }
    this.agentEmail = email;
    ctx.log.info({ agentEmail: email }, "gws agent email resolved");
  }

  /** True when no allow-list is configured, or when any address in the `From`
   *  header matches a configured sender pattern. Disallowed senders are never
   *  read or emitted (their messages are still marked read so the poll query
   *  stops re-matching them). */
  private senderAllowed(from: string): boolean {
    if (this.allowedSenderPatterns.length === 0) return true;
    const emails = extractEmails(from);
    return emails.some((e) =>
      this.allowedSenderPatterns.some((re) => re.test(e)),
    );
  }

  private async verifyAuth(): Promise<void> {
    const ctx = this.ctx!;
    const creds = (ctx.secrets as GwsSecrets)
      .GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
    if (!creds) {
      throw new Error(
        "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE is not set. Run `gws auth login` on a host with a browser, then `gws auth export --unmasked > /path/to/credentials.json` and point this secret at the file.",
      );
    }
    try {
      await access(creds, fsConstants.R_OK);
    } catch {
      throw new Error(
        `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE points to '${creds}' but the file is not readable.`,
      );
    }
    try {
      await this.runGws(["auth", "status"]);
      ctx.log.info("gws auth verified");
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stderr?: string;
        code?: string | number;
      };
      if (e.code === "ENOENT") {
        throw new Error(
          "gws CLI not found on PATH. Install with `npm install -g @googleworkspace/cli`.",
        );
      }
      const stderr = (e.stderr ?? "").toString().trim();
      throw new Error(
        `gws auth verification failed (exit ${e.code ?? "?"}) using credentials file '${creds}'. The file may be expired or invalid — re-export it. Stderr: ${stderr || "(empty)"}`,
      );
    }
  }

  private async pollOnce(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    // Page through every result of the query — Gmail caps a single list
    // response at maxResults, so a backlog query covering many days will
    // otherwise drop everything past the first page.
    const messages: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;
    do {
      const params = JSON.stringify({
        userId: "me",
        q: this.gmailQuery,
        maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
      });
      const { stdout } = await this.runGws([
        "gmail",
        "users",
        "messages",
        "list",
        "--params",
        params,
      ]);
      const list = JSON.parse(stdout || "{}") as {
        messages?: Array<{ id: string; threadId: string }>;
        nextPageToken?: string;
      };
      if (list.messages) messages.push(...list.messages);
      pageToken = list.nextPageToken;
    } while (pageToken);

    if (messages.length === 0) return;

    // Backlog mode: drop any thread already recorded in the ledger; every
    // remaining thread is dispatched in full, with handleThread deciding
    // which messages wake the agent.
    const alreadyIngested = this.firstOfThreadOnly
      ? await this.readLedger()
      : null;
    const threadIds = new Set<string>();
    for (const m of messages) {
      if (this.firstOfThreadOnly && alreadyIngested!.has(m.threadId)) continue;
      threadIds.add(m.threadId);
    }
    for (const tid of threadIds) {
      try {
        await this.handleThread(tid);
      } catch (err) {
        ctx.log.error(
          { err, threadId: tid },
          "failed to handle thread; will retry next tick",
        );
      }
    }
  }

  private ledgerPath(): string {
    return join(this.ctx!.stateDir, LEDGER_FILE);
  }

  private async readLedger(): Promise<Set<string>> {
    const seen = new Set<string>();
    let raw: string;
    try {
      raw = await readFile(this.ledgerPath(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return seen;
      throw err;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as { threadId?: string };
        if (row.threadId) seen.add(row.threadId);
      } catch {
        // tolerate hand-edited junk lines — the user may have annotated
        this.ctx?.log.warn({ line: trimmed }, "skipping unparseable ledger line");
      }
    }
    return seen;
  }

  private async appendLedger(
    threadId: string,
    subject: string,
  ): Promise<void> {
    const entry =
      JSON.stringify({
        threadId,
        subject,
        ingestedAt: new Date().toISOString().slice(0, 10),
      }) + "\n";
    await appendFile(this.ledgerPath(), entry, "utf8");
  }

  private async handleThread(threadId: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    const params = JSON.stringify({ userId: "me", id: threadId, format: "full" });
    const { stdout } = await this.runGws([
      "gmail",
      "users",
      "threads",
      "get",
      "--params",
      params,
    ]);
    const thread = JSON.parse(stdout) as GmailThread;
    const raw = thread.messages ?? [];
    if (raw.length === 0) return;

    const ordered = [...raw].sort(
      (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
    );

    // Subject is frozen at the first message so a later `Re: …` rewrite
    // doesn't fork the harness thread id.
    const firstHeaders = collectHeaders(ordered[0]!.payload);
    const subject = firstHeaders.get("subject") ?? "(no subject)";
    const threadIdOverride = `${sanitizeForPath(subject)}[${threadId}]`;

    // Backlog mode: deliver every message in the thread, most-recent first
    // so the chronologically-first message (the only one that wakes the
    // agent) is emitted last. Default mode: consider only the most recent
    // message and wake only when it is unread and the agent's address is in
    // its `To` — older messages are never re-emitted.
    let toEmit: GmailMessage[];
    if (this.firstOfThreadOnly) {
      toEmit = [...ordered]
        .reverse()
        .filter((m) =>
          this.senderAllowed(collectHeaders(m.payload).get("from") ?? ""),
        );
    } else {
      const last = ordered[ordered.length - 1]!;
      const headers = collectHeaders(last.payload);
      const to = headers.get("to") ?? "";
      const from = headers.get("from") ?? "";
      toEmit =
        hasLabel(last, UNREAD_LABEL) &&
        extractEmails(to).includes(this.agentEmail) &&
        this.senderAllowed(from)
          ? [last]
          : [];
    }

    // Resolve every message's payload first, then emit. `formatEmail` shells
    // out to `gws`, so awaiting it between `ctx.notify` calls would yield the
    // event loop mid-thread and let the runner dequeue an earlier message as
    // its own batch before the next is enqueued — splitting what should be one
    // batch (and missing the steer window, which only fires once a batch is
    // streaming). Building all payloads up front keeps the emit loop below
    // free of awaits, so same-thread rows enqueue atomically and batch.
    const pending: Array<{
      invoked: boolean;
      text: string;
      metadata: Record<string, unknown>;
    }> = [];

    for (const m of toEmit) {
      const h = collectHeaders(m.payload);
      const from = h.get("from") ?? "(unknown sender)";
      const to = h.get("to") ?? "(unknown recipient)";
      const timestamp = m.internalDate
        ? formatTs(Number(m.internalDate), ctx.timezone)
        : (h.get("date") ?? "(unknown)");
      const timestampUtc = m.internalDate
        ? new Date(Number(m.internalDate)).toISOString()
        : "(unknown)";

      const header = [
        `Subject: ${subject}`,
        `From: ${from}`,
        `To: ${to}`,
        `TimeStamp: ${timestamp}`,
      ].join("\n");

      // Backlog mode: only the first message of the thread wakes the agent;
      // every other message is silent context.
      // Default mode: agent address in `To` → wake (full body); Cc/Bcc / not
      // addressed → silent.
      const invoked = this.firstOfThreadOnly
        ? m.id === threadId
        : extractEmails(to).includes(this.agentEmail);

      let text = header;
      if (invoked) {
        const formatted = await formatEmail(m, {
          attachmentsDir: ctx.inboxDir,
          runGws: (a) => this.runGws(a),
        });
        const body = formatted.body || "(no plain-text body)";
        const attLines = formatted.attachments
          .filter((a) => a.path)
          .map((a) => `${a.filename}[${relative(ctx.agentDir, a.path!)}]`);
        text =
          attLines.length > 0
            ? `${header}\n\n${body}\n\n${attLines.join("\n")}`
            : `${header}\n\n${body}`;
      }

      pending.push({
        invoked,
        text,
        metadata: {
          MessageId: m.id,
          GmailThreadId: threadId,
          From: from,
          ReceivedAt: timestamp,
          ReceivedAtUtc: timestampUtc,
        },
      });
    }

    // Synchronous emit — no awaits between notify() calls, so the runner sees
    // every row of this thread as `queued` before its worker can dequeue, and
    // pulls them into a single batch.
    for (const p of pending) {
      ctx.notify(p.invoked ? "email_received" : "email_silent", {
        text: p.text,
        channelId: threadId,
        threadIdOverride,
        isSilent: !p.invoked,
        metadata: p.metadata,
      });
    }

    // Mark every unread message in the thread read so the poll query stops
    // re-matching it, regardless of which (if any) message we emitted.
    const unreadToMark = ordered.filter((m) => hasLabel(m, UNREAD_LABEL));
    if (unreadToMark.length > 0) await this.markRead(unreadToMark);

    if (this.firstOfThreadOnly) {
      try {
        await this.appendLedger(threadId, subject);
      } catch (err) {
        ctx.log.warn(
          { err, threadId },
          "failed to append to ingested-threads ledger; thread may be re-emitted on the next poll",
        );
      }
    }
  }

  private async markRead(messages: GmailMessage[]): Promise<void> {
    const ctx = this.ctx;
    for (const m of messages) {
      try {
        const params = JSON.stringify({ userId: "me", id: m.id });
        const json = JSON.stringify({ removeLabelIds: [UNREAD_LABEL] });
        await this.runGws([
          "gmail",
          "users",
          "messages",
          "modify",
          "--params",
          params,
          "--json",
          json,
        ]);
      } catch (err) {
        ctx?.log.warn({ err, id: m.id }, "failed to mark message as read");
      }
    }
  }
}

function hasLabel(m: GmailMessage, label: string): boolean {
  return (m.labelIds ?? []).includes(label);
}

/** Pull all email addresses out of an RFC-5322 address header. Handles
 *  `name <addr>`, bare `addr`, quoted display names, and comma-separated
 *  lists. Returns lowercased addresses for case-insensitive comparison. */
function extractEmails(header: string): string[] {
  const matches = header.match(/[\w!#$%&'*+/=?^`{|}~.-]+@[\w.-]+/g) ?? [];
  return matches.map((e) => e.toLowerCase());
}

/** Parse a comma-separated allow-list of sender patterns into anchored,
 *  case-insensitive regexes. `*` is the only wildcard (matches any run of
 *  characters); every other regex metacharacter is escaped literally. Blank
 *  entries are dropped, so an empty / whitespace-only config yields no
 *  patterns (which `senderAllowed` treats as "allow every sender"). */
function parseSenderPatterns(raw: string): RegExp[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .map((pattern) => {
      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`);
    });
}

/** Strip characters that would break a directory name; `<Subject>` is used
 *  as the prefix of the harness thread id, which becomes a sessions/ dir. */
function sanitizeForPath(s: string): string {
  return s.replace(/[/\\\0]+/g, "_").slice(0, 120).trim() || "(no subject)";
}

function formatTs(unixMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
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
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
}
