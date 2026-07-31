/**
 * context-meta — a pi extension loaded into every spawned `pi --mode rpc`
 * child (see `runner.ts:spawnPi`). Gives the agent context-window
 * awareness through two complementary mechanisms:
 *
 * 1. CHECKPOINT MESSAGES: after each assistant response, a standalone
 *    custom message (customType "context-meta.checkpoint") is injected:
 *
 *      CheckpointTokens: +<n>
 *
 *    <n> is the exact context growth of the completed step, computed from
 *    consecutive provider-reported usage totals (input + output + cache) —
 *    no estimation. Standalone messages (rather than stamps fused into
 *    neighboring messages) keep the trail prune-safe: a future context
 *    cleaner can add/remove checkpoints by identity, independent of the
 *    content messages they describe. `CheckpointTokens: reset` marks a
 *    shrink (compaction) where the delta is unknowable.
 *
 *    Placement: `deliverAs: "steer"` appends at the first provider-legal
 *    seam — after the response's tool calls finish (nothing may sit
 *    between a tool-use response and its tool results), before the next
 *    LLM call. So a checkpoint covers everything up through the nearest
 *    assistant response ABOVE it; tool results between that response and
 *    the checkpoint belong to the NEXT checkpoint.
 *
 *    Emission timing is load-bearing: while streaming, a pending message
 *    keeps pi's agent loop alive, so a checkpoint sent right after a
 *    turn-ending response would provoke an endless run of empty LLM calls.
 *    Checkpoints are therefore sent immediately only when the response has
 *    tool calls (the loop continues anyway); for a turn-ending response
 *    the emit waits for agent_settled, where isStreaming is false and
 *    sendMessage appends directly — right after the final response, before
 *    the next user message, no turn triggered. If the process exits first,
 *    seeding replays the session on spawn and emits the missing checkpoint
 *    as catch-up — the trail stays gapless across batch boundaries either
 *    way. (Note for the future pruner: tool calls and their tool results
 *    must be removed together — never orphan either — and checkpoint
 *    messages should be selected by customType/entry id, not by
 *    position.)
 *
 * 2. EPHEMERAL per-call fill (`context` hook): every LLM call gets
 *
 *      Model: <model id>
 *      ContextUsage: <tokens>/<context window>
 *
 *    appended to the outgoing context's last message. The hook receives a
 *    deep copy, so nothing persists — exactly one fresh block exists per
 *    call, correct even right after compaction, and absolute fill never
 *    freezes into history where it could drift. `ContextUsage` = last
 *    valid assistant usage plus a chars/4 estimate of trailing messages
 *    (pi's `estimateContextTokens`); omitted while unknown.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHECKPOINT_TYPE = "context-meta.checkpoint";

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

export default function contextMeta(pi: ExtensionAPI): void {
  // Context size covered by the last checkpoint emitted (or found in the
  // session at seed time). The next checkpoint's delta is measured from it.
  let prevC = 0;
  let seeded = false;

  const emitCheckpoint = (delta: number): void => {
    const line = delta < 0 ? "CheckpointTokens: reset" : `CheckpointTokens: +${delta}`;
    pi.sendMessage(
      {
        customType: CHECKPOINT_TYPE,
        content: `<harness-metadata>\n${line}\n</harness-metadata>`,
        display: true,
      },
      { deliverAs: "steer", triggerTurn: false },
    );
  };

  // Replay the session to recover where the previous batch left off: each
  // checkpoint entry consumes the nearest assistant total above it. If the
  // last response has no checkpoint after it (the previous process exited
  // with the message still queued), emit it now as catch-up — it lands
  // before this batch's first LLM call.
  const ensureSeeded = (ctx: ExtensionContext): void => {
    if (seeded) return;
    seeded = true;
    let lastC: number | null = null;
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type === "message" && e.message.role === "assistant") {
        const c = contextTokens(e.message);
        if (c !== null) lastC = c;
      } else if (e.type === "custom_message" && e.customType === CHECKPOINT_TYPE) {
        if (lastC !== null) prevC = lastC;
      }
    }
    if (lastC !== null && lastC !== prevC) {
      emitCheckpoint(lastC - prevC);
      prevC = lastC;
    }
  };

  // Checkpoint for a turn-ending response, held until it is safe to send.
  // While the agent is streaming, sendMessage lands in pi's pending queue,
  // and the loop keeps running while ANY pending message exists — so
  // emitting right after a response with no tool calls would keep
  // provoking empty LLM calls forever (observed in production). Safe
  // moments: while the loop continues anyway (response has tool calls,
  // steer rides along), or once the run has settled — at agent_settled
  // isStreaming is already false, so sendMessage takes its direct-append
  // branch: the checkpoint lands in the session right after the final
  // response, before any future user message, without triggering a turn.
  let deferred: number | null = null;

  const flushDeferred = (): void => {
    if (deferred === null) return;
    emitCheckpoint(deferred);
    deferred = null;
  };

  pi.on("message_end", (event, ctx) => {
    ensureSeeded(ctx);
    const msg = event.message;

    // Fallback flush (e.g. a queued follow-up continues the run before
    // agent_settled fires): ride the inbound message's imminent LLM call.
    if (msg.role === "user" || msg.role === "toolResult") {
      flushDeferred();
      return;
    }
    if (msg.role !== "assistant") return;
    const c = contextTokens(msg);
    if (c === null) return;
    const delta = c - prevC;
    prevC = c;
    if (msg.stopReason === "toolUse") {
      emitCheckpoint(delta);
    } else {
      deferred = delta;
    }
  });

  pi.on("agent_settled", () => flushDeferred());

  pi.on("context", (event, ctx) => {
    const lines: string[] = [];
    if (ctx.model) lines.push(`Model: ${ctx.model.id}`);
    const usage = ctx.getContextUsage();
    if (usage && usage.tokens !== null) {
      lines.push(`ContextUsage: ${usage.tokens}/${usage.contextWindow}`);
    }
    if (lines.length === 0) return;
    const block = `<harness-metadata>\n${lines.join("\n")}\n</harness-metadata>`;

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
