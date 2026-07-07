/**
 * Shared Gmail-message decoding logic. Plain ESM JavaScript (not TypeScript)
 * so the same file can be imported both by the plugin runtime (via tsx) and
 * by the standalone `scripts/gws/format-email` CLI seeded into the agent
 * workspace (via plain `node`, which cannot load .ts). The seed tree is
 * copied verbatim into the agent dir, so the CLI's `../format-email-lib.mjs`
 * relative import resolves in both locations. Types live in
 * `format-email-lib.d.mts`.
 */
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

export function collectHeaders(part) {
  const m = new Map();
  for (const h of part.headers ?? []) m.set(h.name.toLowerCase(), h.value);
  return m;
}

export function pickTextBody(part) {
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

export function collectAttachments(part) {
  const out = [];
  walk(part, (p) => {
    if (p.body?.attachmentId && p.filename) out.push(p);
  });
  return out;
}

export function sanitizeFilename(name) {
  return name.replace(/[/\\:*?"<>|]+/g, "_").slice(0, 200) || "attachment";
}

export function formatTs(unixMs, timeZone) {
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
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
}

/** Strip quoted reply history from a plain-text body: cut at the earliest
 *  common reply marker (Gmail `On … wrote:`, Outlook `From:`/`Sent:` block,
 *  `-----Original Message-----`, `____` divider, or a `>`-quoted line).
 *  Returns the body unchanged when no marker is found or when stripping
 *  would leave nothing.
 *  ponytail: marker heuristics only — wrapped `On … wrote:` lines and exotic
 *  clients fall through to the full body; add markers as they show up. */
export function stripQuotedHistory(body) {
  const markers = [
    /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^On [^\n]{0,300}wrote:\s*$/m,
    /^From:[^\n]+\n(Sent|Date):/m,
    /^_{5,}\s*$/m,
    /^>/m,
  ];
  let cut = -1;
  for (const re of markers) {
    const m = re.exec(body);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut <= 0) return body;
  const stripped = body.slice(0, cut).trim();
  return stripped || body;
}

export async function fetchAttachment(runGws, messageId, attachmentId, target) {
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
  const att = JSON.parse(stdout);
  await writeFile(target, Buffer.from(att.data, "base64url"));
}

function walk(part, fn) {
  fn(part);
  for (const child of part.parts ?? []) walk(child, fn);
}

function findFirst(part, pred) {
  if (pred(part)) return part;
  for (const child of part.parts ?? []) {
    const hit = findFirst(child, pred);
    if (hit) return hit;
  }
  return undefined;
}

function decodeBase64url(s) {
  return Buffer.from(s, "base64url").toString("utf8");
}

function stripTags(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
