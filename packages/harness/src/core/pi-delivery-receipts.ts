/**
 * delivery-receipts — a pi extension the runner loads into every spawned
 * `pi --mode rpc` child from the package (see `runner.ts:spawnPi`), never
 * from the agent folder, so an agent can't lose or edit it.
 *
 * Every input the runner sends carries `EventId: <row id>` in its
 * `<harness-metadata>` block. For each user message pi saves, this reports
 * `{ entryId, eventIds }`: the saved session entry and the queue rows it
 * contains. That one receipt answers both "did the row reach pi?" and "which
 * saved message is it?", so the two can't disagree.
 *
 * Transport: `pi.appendEntry(RECEIPT_TYPE, { entryId, eventIds })`. Pi saves
 * it as a custom session entry (kept out of the model's context) and reports
 * it on stdout as an `entry_appended` event, which `PiRpcClient` routes to the
 * runner. Saved receipts also let recovery rebuild row-to-entry links from
 * the session file.
 *
 * Pi emits `message_end` before it appends the message to the session, so the
 * entry id doesn't exist yet there. Instead we re-scan the entries on the
 * events that follow and report each entry once. Entries already in the file
 * when pi starts are history from earlier batches (their receipts were sent
 * then, or the session predates saved receipts), so they're never reported
 * again — otherwise every spawn would append duplicate receipts.
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export const RECEIPT_TYPE = "cognisphere.delivery";

/** Row ids named by `EventId:` lines inside `<harness-metadata>` blocks. */
export function eventIdsIn(text: string): number[] {
  const ids: number[] = [];
  for (const block of text.matchAll(/<harness-metadata>([\s\S]*?)<\/harness-metadata>/g)) {
    const m = /^EventId: (\d+)$/m.exec(block[1]!);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}

function messageText(entry: SessionEntry): string | null {
  if (entry.type !== "message" || entry.message.role !== "user") return null;
  const { content } = entry.message;
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

export default function deliveryReceipts(pi: ExtensionAPI): void {
  const reported = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) reported.add(entry.id);
  });

  const sweep = (_event: unknown, ctx: ExtensionContext): void => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (reported.has(entry.id)) continue;
      const text = messageText(entry);
      if (text === null) continue;
      reported.add(entry.id);
      const eventIds = eventIdsIn(text);
      if (eventIds.length === 0) continue;
      pi.appendEntry(RECEIPT_TYPE, { entryId: entry.id, eventIds });
    }
  };

  pi.on("message_start", sweep);
  pi.on("turn_start", sweep);
  pi.on("turn_end", sweep);
  pi.on("agent_end", sweep);
}
