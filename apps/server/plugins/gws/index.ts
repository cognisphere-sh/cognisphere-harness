import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import type {
  Plugin,
  PluginInstanceContext,
  PluginManifest,
} from "../../src/types.js";
import {
  collectHeaders,
  formatEmail,
  type GmailMessage,
} from "./seed/scripts/format-email.js";

const execFileP = promisify(execFile);
const UNREAD_LABEL = "UNREAD";
const SENT_LABEL = "SENT";
const LEDGER_FILE = "ingested-threads.jsonl";

interface GwsConfig {
  pollIntervalSec?: number;
  gmailQuery?: string;
  firstOfThreadOnly?: boolean;
}

interface GwsSecrets {
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE?: string;
}

interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

/**
 * Polls Gmail through the `gws` CLI and emits one notification per inbound
 * message. Messages where the agent's own email is in the `To` header
 * deliver headers + body + attachment paths and wake the agent. Messages
 * where the agent is only in `Cc`/`Bcc` deliver headers only and are
 * marked `isSilent: true` so they park behind a future addressed message in
 * the same harness thread, supplying context without a standalone wake.
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
  private agentEmail = "";

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    const cfg = (ctx.config as GwsConfig | undefined) ?? {};
    this.pollIntervalMs = (cfg.pollIntervalSec ?? 60) * 1000;
    this.gmailQuery = cfg.gmailQuery ?? "is:unread in:inbox";
    this.firstOfThreadOnly = cfg.firstOfThreadOnly === true;

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
    // agent) is emitted last. The ledger append after the loop then lands
    // immediately after that wake notification.
    let toEmit: GmailMessage[];
    if (this.firstOfThreadOnly) {
      toEmit = [...ordered].reverse();
    } else {
      // Boundary = most recent SENT message (an agent reply, or anything sent
      // from this Gmail account). Everything strictly after it is new and
      // should be delivered. If there's no SENT message, the whole thread is
      // new and we deliver from the start.
      let boundaryIdx = -1;
      for (let i = ordered.length - 1; i >= 0; i--) {
        if (hasLabel(ordered[i]!, SENT_LABEL)) {
          boundaryIdx = i;
          break;
        }
      }
      const start = boundaryIdx === -1 ? 0 : boundaryIdx + 1;
      if (start >= ordered.length) {
        // Nothing new past the boundary — still mark any stray unread to keep
        // the inbox query loop from re-firing on this thread.
        const unread = ordered.filter((m) => hasLabel(m, UNREAD_LABEL));
        if (unread.length > 0) await this.markRead(unread);
        return;
      }
      toEmit = ordered.slice(start);
    }

    const unreadToMark: GmailMessage[] = [];
    for (const m of toEmit) {
      if (hasLabel(m, UNREAD_LABEL)) unreadToMark.push(m);

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

      ctx.notify(invoked ? "email_received" : "email_silent", {
        text,
        channelId: threadId,
        threadIdOverride,
        isSilent: !invoked,
        metadata: {
          MessageId: m.id,
          GmailThreadId: threadId,
          From: from,
          ReceivedAt: timestamp,
          ReceivedAtUtc: timestampUtc,
        },
      });
    }

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
