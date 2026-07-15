/**
 * Decode a Gmail message JSON (as emitted by `gws gmail users messages get
 * --format full`) into a plain-text body and a list of attachments. Used by
 * the plugin runtime; the agent uses the seeded `scripts/gws/format-email`
 * CLI instead. Both share the decoding logic in `format-email-lib.mjs`.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  collectAttachments,
  fetchAttachment,
  pickTextBody,
  sanitizeFilename,
  type GmailMessage,
  type GwsRunner,
} from "./format-email-lib.mjs";

export type {
  GmailBody,
  GmailHeader,
  GmailMessage,
  GmailPart,
  GwsRunner,
} from "./format-email-lib.mjs";
export { collectHeaders, formatTs } from "./format-email-lib.mjs";

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
      await fetchAttachment(
        opts.runGws,
        msg.id,
        part.body!.attachmentId!,
        target,
      );
      attachments.push({ filename, path: target });
    } catch {
      attachments.push({ filename });
    }
  }
  return { body, attachments };
}
