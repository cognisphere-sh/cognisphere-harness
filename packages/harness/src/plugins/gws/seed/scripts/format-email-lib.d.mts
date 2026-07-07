/** Type declarations for `format-email-lib.mjs` (see that file for why the
 *  implementation is plain JavaScript). */

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

export function collectHeaders(part: GmailPart): Map<string, string>;
export function pickTextBody(part: GmailPart): string;
export function collectAttachments(part: GmailPart): GmailPart[];
export function sanitizeFilename(name: string): string;
export function stripQuotedHistory(body: string): string;
export function formatTs(unixMs: number, timeZone: string): string;
export function fetchAttachment(
  runGws: GwsRunner,
  messageId: string,
  attachmentId: string,
  target: string,
): Promise<void>;
