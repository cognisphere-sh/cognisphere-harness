/**
 * Decode a Gmail message JSON (as emitted by `gws gmail users messages get
 * --format full`) into a plain-text body and a list of attachments. Used by
 * the plugin runtime; the agent itself calls `gws` directly and does its
 * own decoding.
 */
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailBody {
  size?: number;
  data?: string;
  attachmentId?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  labelIds?: string[];
  payload: GmailPart;
}

export type GwsRunner = (
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface FormatEmailOptions {
  /** Fetch attachments and write them under `<attachmentsDir>/<messageId>/`. */
  attachmentsDir: string;
  runGws: GwsRunner;
}

export interface FormattedAttachment {
  filename: string;
  /** Absolute path on disk; undefined when the fetch failed. */
  path?: string;
}

export interface FormattedEmail {
  body: string;
  attachments: FormattedAttachment[];
}

export async function formatEmail(
  msg: GmailMessage,
  opts: FormatEmailOptions,
): Promise<FormattedEmail> {
  const body = pickTextBody(msg.payload);
  const attParts = collectAttachments(msg.payload);
  const attachments: FormattedAttachment[] = [];

  if (attParts.length === 0) return { body, attachments };

  const dir = join(opts.attachmentsDir, msg.id);
  await mkdir(dir, { recursive: true });
  for (const part of attParts) {
    const filename = sanitizeFilename(
      part.filename ?? `attachment-${part.partId ?? "0"}`,
    );
    const target = resolve(join(dir, filename));
    try {
      await fetchAttachment(opts.runGws, msg.id, part.body!.attachmentId!, target);
      attachments.push({ filename, path: target });
    } catch {
      attachments.push({ filename });
    }
  }
  return { body, attachments };
}

async function fetchAttachment(
  runGws: GwsRunner,
  messageId: string,
  attachmentId: string,
  target: string,
): Promise<void> {
  const params = JSON.stringify({ userId: "me", messageId, id: attachmentId });
  const { stdout } = await runGws([
    "gmail",
    "users",
    "messages",
    "attachments",
    "get",
    "--params",
    params,
  ]);
  const att = JSON.parse(stdout) as { data: string };
  await writeFile(target, Buffer.from(att.data, "base64url"));
}

export function collectHeaders(part: GmailPart): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of part.headers ?? []) m.set(h.name.toLowerCase(), h.value);
  return m;
}

export function pickTextBody(part: GmailPart): string {
  const plain = findFirst(
    part,
    (p) => p.mimeType === "text/plain" && !!p.body?.data,
  );
  if (plain?.body?.data) return decodeBase64url(plain.body.data);
  const html = findFirst(
    part,
    (p) => p.mimeType === "text/html" && !!p.body?.data,
  );
  if (html?.body?.data) return stripTags(decodeBase64url(html.body.data));
  return "";
}

function collectAttachments(part: GmailPart): GmailPart[] {
  const out: GmailPart[] = [];
  walk(part, (p) => {
    if (p.body?.attachmentId && p.filename) out.push(p);
  });
  return out;
}

function walk(part: GmailPart, fn: (p: GmailPart) => void): void {
  fn(part);
  for (const child of part.parts ?? []) walk(child, fn);
}

function findFirst(
  part: GmailPart,
  pred: (p: GmailPart) => boolean,
): GmailPart | undefined {
  if (pred(part)) return part;
  for (const child of part.parts ?? []) {
    const hit = findFirst(child, pred);
    if (hit) return hit;
  }
  return undefined;
}

function decodeBase64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\/\\:*?"<>|]+/g, "_").slice(0, 200) || "attachment";
}
