import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { relative } from "node:path";
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
  pickTextBody,
} from "./seed/scripts/format-email.js";

const execFileP = promisify(execFile);
const UNREAD_LABEL = "UNREAD";
const SENT_LABEL = "SENT";

interface GwsConfig {
  pollIntervalSec?: number;
  invocationTerm?: string;
  gmailQuery?: string;
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
 * message. Invoked messages (first-of-thread, or — when `invocationTerm` is
 * set — body contains `@<term>`) deliver headers + body + attachment paths
 * and wake the agent. Non-invoked messages deliver headers only and are
 * marked `isSilent: true` so they park behind a future invoked message in
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
        invocationTerm: {
          type: "string",
          default: "",
          description:
            "Token (without leading `@`) an inbound message body must contain to trigger a full notification. Blank = every inbound message is treated as invoked.",
        },
        gmailQuery: {
          type: "string",
          default: "is:unread in:inbox",
          description: "Gmail search query for the poll loop.",
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
  private invocationTerm = "";
  private gmailQuery = "is:unread in:inbox";

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    const cfg = (ctx.config as GwsConfig | undefined) ?? {};
    this.pollIntervalMs = (cfg.pollIntervalSec ?? 60) * 1000;
    this.invocationTerm = (cfg.invocationTerm ?? "").trim();
    this.gmailQuery = cfg.gmailQuery ?? "is:unread in:inbox";

    await this.verifyAuth();
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
    const params = JSON.stringify({
      userId: "me",
      q: this.gmailQuery,
      maxResults: 50,
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
    };
    const messages = list.messages ?? [];
    if (messages.length === 0) return;

    // A single unread email surfaces once per thread message in the listing —
    // collapse to unique threads.
    const threadIds = new Set<string>();
    for (const m of messages) threadIds.add(m.threadId);
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

    const term = this.invocationTerm
      ? `@${this.invocationTerm}`.toLowerCase()
      : "";
    const isInvoked = (m: GmailMessage, isThreadFirst: boolean): boolean => {
      if (isThreadFirst) return true;
      if (!term) return true; // blank invocationTerm = every message is invoked
      return pickTextBody(m.payload).toLowerCase().includes(term);
    };

    const unreadToMark: GmailMessage[] = [];
    for (let i = start; i < ordered.length; i++) {
      const m = ordered[i]!;
      if (hasLabel(m, UNREAD_LABEL)) unreadToMark.push(m);

      const h = collectHeaders(m.payload);
      const from = h.get("from") ?? "(unknown sender)";
      const to = h.get("to") ?? "(unknown recipient)";
      const timestamp = m.internalDate
        ? formatTs(Number(m.internalDate), ctx.timezone)
        : (h.get("date") ?? "(unknown)");

      const header = [
        `Subject: ${subject}`,
        `From: ${from}`,
        `To: ${to}`,
        `TimeStamp: ${timestamp}`,
      ].join("\n");

      const invoked = isInvoked(m, i === 0);

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
        },
      });
    }

    if (unreadToMark.length > 0) await this.markRead(unreadToMark);
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

/** Strip characters that would break a directory name; `<Subject>` is used
 *  as the prefix of the harness thread id, which becomes a sessions/ dir. */
function sanitizeForPath(s: string): string {
  return s.replace(/[\/\\\0]+/g, "_").slice(0, 120).trim() || "(no subject)";
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
