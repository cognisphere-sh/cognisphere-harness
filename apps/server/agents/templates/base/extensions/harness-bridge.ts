/**
 * harness-bridge — a pi extension loaded into every spawned `pi --mode rpc`
 * child (see `runner.ts:spawnPi`). Its sole job is to report each user-message
 * session **entry id** back to the harness in real time, so the parent can
 * link a queued event row to its place in pi's session JSONL without reading
 * the file and without waiting for the child to exit (which matters because a
 * failed batch never reaches a post-exit read).
 *
 * Transport: `ctx.ui.setStatus("pi-harness", <json>)`. In RPC mode this is a
 * fire-and-forget `extension_ui_request{method:"setStatus"}` frame on stdout,
 * which the harness's `PiRpcClient` already receives. The extension never
 * touches the harness DB — it has no knowledge of harness row ids — it only
 * reports `{ index, entryId }` in dispatch order; the parent maps index→row.
 *
 * Why a sweep instead of reading the entry in the `message_end` handler: pi
 * emits the extension event *before* it appends the message to the session
 * (agent-session: emit then `appendMessage`), so the entry id does not exist
 * yet at `message_end` time. Instead we re-scan `getEntries()` on every event
 * and emit any newly-appeared user-message entries; the id reliably lands on
 * the next event after the user message (typically the assistant's
 * `message_start`).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-harness";

export default function harnessBridge(pi: ExtensionAPI): void {
  // Number of user-message entries already reported for the current run.
  let reported = 0;

  const isUserMessageEntry = (e: SessionEntry): boolean =>
    e.type === "message" && e.message.role === "user";

  const sweep = (ctx: ExtensionContext): void => {
    const userEntries = ctx.sessionManager.getEntries().filter(isUserMessageEntry);
    for (let i = reported; i < userEntries.length; i++) {
      const entry = userEntries[i];
      if (!entry) continue;
      ctx.ui.setStatus(
        STATUS_KEY,
        JSON.stringify({ kind: "user_entry", index: i, entryId: entry.id }),
      );
    }
    reported = userEntries.length;
  };

  // One prompt = one run. Reset the per-run counter, then sweep any entries
  // pi may already have appended (e.g. the initial prompt) by the time the
  // next event fires.
  pi.on("agent_start", (_event, ctx) => {
    reported = 0;
    sweep(ctx);
  });

  // Re-scan on the events that follow a user message being appended (initial
  // prompt and each steer). Covering several event types makes the capture
  // robust to exactly when pi persists the entry.
  pi.on("message_start", (_event, ctx) => sweep(ctx));
  pi.on("turn_start", (_event, ctx) => sweep(ctx));
  pi.on("turn_end", (_event, ctx) => sweep(ctx));
  pi.on("agent_end", (_event, ctx) => sweep(ctx));
}
