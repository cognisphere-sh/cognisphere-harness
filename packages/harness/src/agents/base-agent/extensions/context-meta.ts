/**
 * context-meta — a pi extension loaded into every spawned `pi --mode rpc`
 * child (see `runner.ts:spawnPi`). Gives the agent context-window
 * awareness through two complementary mechanisms:
 *
 * 1. PERSISTENT per-step checkpoints (`message_end`): after each assistant
 *    response, the first following user/toolResult message is stamped with
 *
 *      CheckpointTokens: +<n>
 *
 *    = the exact context growth of the step that just completed (the
 *    response's output + the input messages appended before it), computed
 *    from consecutive provider-reported usage totals — no estimation.
 *    Deltas are self-contained per step (never cumulative), so the trail
 *    stays truthful when compaction rewrites history; a compaction shows
 *    up as `CheckpointTokens: reset`. Summing a span of stamps tells the
 *    agent what pruning that span would free.
 *
 *    The stamp goes on the message AFTER the response, never on the
 *    assistant message itself: injecting text into the model's own past
 *    turns invites the model to imitate it, and providers validate
 *    replayed assistant content (e.g. thinking-block signatures).
 *    `message_end` fires before the session append, so the stamped
 *    version is what pi persists to the JSONL and replays in context.
 *
 * 2. EPHEMERAL per-call fill (`context` hook): every LLM call gets
 *
 *      Model: <model id>
 *      ContextUsage: <tokens>/<context window>
 *
 *    appended to the outgoing context's last message. The `context` hook
 *    receives a deep copy, so nothing persists — exactly one fresh block
 *    exists per call, correct even right after compaction, and absolute
 *    fill never freezes into history where it could drift.
 *
 * `ContextUsage` = last valid assistant usage plus a chars/4 estimate of
 * trailing messages (pi's `estimateContextTokens`); omitted while unknown
 * (right after compaction, until the next response re-anchors it).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CLOSE_TAG = "</harness-metadata>";

interface AssistantLike {
  stopReason: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
}

/** True context size after a response: provider-reported, includes cache. */
const contextTokens = (m: AssistantLike): number | null => {
  if (m.stopReason === "aborted" || m.stopReason === "error") return null;
  const u = m.usage;
  const total = u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite;
  return total > 0 ? total : null;
};

const wrapBlock = (lines: string[]): string =>
  `<harness-metadata>\n${lines.join("\n")}\n${CLOSE_TAG}`;

export default function contextMeta(pi: ExtensionAPI): void {
  // Context size at the last stamped checkpoint. Seeded from the session so
  // the first stamp of a respawned child (one pi process per batch) covers
  // the gap since the previous batch's last response instead of resyncing.
  let prevC = 0;
  // Context size after the latest response, not yet written to a stamp.
  let pendingC: number | null = null;
  let seeded = false;

  const ensureSeeded = (ctx: ExtensionContext): void => {
    if (seeded) return;
    seeded = true;
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type !== "message" || e.message.role !== "assistant") continue;
      const c = contextTokens(e.message);
      if (c !== null) prevC = c;
    }
  };

  pi.on("message_end", (event, ctx) => {
    ensureSeeded(ctx);
    const msg = event.message;

    if (msg.role === "assistant") {
      const c = contextTokens(msg);
      if (c !== null) pendingC = c;
      return;
    }
    if (msg.role !== "user" && msg.role !== "toolResult") return;
    if (pendingC === null) return;

    // A negative delta means the context shrank underneath us (compaction);
    // the step's true cost is unknowable, so mark a reset instead.
    const delta = pendingC - prevC;
    const line = delta < 0 ? "CheckpointTokens: reset" : `CheckpointTokens: +${delta}`;
    prevC = pendingC;
    pendingC = null;

    if (msg.role === "user") {
      // Into the harness-supplied block when present (first block only — a
      // batched prompt has one per row; one stamp is enough), appended as
      // its own block otherwise (e.g. plain steer text).
      const { content } = msg;
      if (typeof content === "string") {
        const next = content.includes(CLOSE_TAG)
          ? content.replace(CLOSE_TAG, `${line}\n${CLOSE_TAG}`)
          : `${content}\n\n${wrapBlock([line])}`;
        return { message: { ...msg, content: next } };
      }
      const idx = content.findIndex((c) => c.type === "text" && c.text.includes(CLOSE_TAG));
      const part = content[idx];
      if (part?.type === "text") {
        const next = content.slice();
        next[idx] = { ...part, text: part.text.replace(CLOSE_TAG, `${line}\n${CLOSE_TAG}`) };
        return { message: { ...msg, content: next } };
      }
      return { message: { ...msg, content: [...content, { type: "text", text: wrapBlock([line]) }] } };
    }
    return {
      message: { ...msg, content: [...msg.content, { type: "text", text: wrapBlock([line]) }] },
    };
  });

  pi.on("context", (event, ctx) => {
    const lines: string[] = [];
    if (ctx.model) lines.push(`Model: ${ctx.model.id}`);
    const usage = ctx.getContextUsage();
    if (usage && usage.tokens !== null) {
      lines.push(`ContextUsage: ${usage.tokens}/${usage.contextWindow}`);
    }
    if (lines.length === 0) return;
    const block = wrapBlock(lines);

    const last = event.messages[event.messages.length - 1];
    if (!last) return;
    if (last.role === "user") {
      if (typeof last.content === "string") last.content = `${last.content}\n\n${block}`;
      else last.content.push({ type: "text", text: block });
    } else if (last.role === "toolResult") {
      last.content.push({ type: "text", text: block });
    } else {
      return;
    }
    return { messages: event.messages };
  });
}
