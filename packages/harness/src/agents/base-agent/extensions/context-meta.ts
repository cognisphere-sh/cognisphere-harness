/**
 * context-meta — a pi extension loaded into every spawned `pi --mode rpc`
 * child (see `runner.ts:spawnPi`). Gives the agent context-window
 * awareness through two complementary mechanisms:
 *
 * 1. CHECKPOINT MESSAGES: one standalone custom message (customType
 *    "context-meta.checkpoint") is injected before EVERY LLM call —
 *    after all inputs to that call (tool results / the user message)
 *    are in place:
 *
 *      Checkpoint: <n>
 *      CheckpointTokens: +<delta>
 *
 *    <n> is a monotonically increasing integer (one per LLM call, seeded
 *    across process respawns by replaying the session), and <delta> is the
 *    context growth since the previous checkpoint. The number is
 *    anchor + estimate: the last provider-reported assistant usage total
 *    (exact) plus pi's estimate of the messages after it (chars/4 for
 *    text, ~1200 tokens per image — `estimateContextTokens`, surfaced via
 *    ctx.getContextUsage()). Because every checkpoint re-anchors on
 *    provider truth, estimation error never accumulates: an off-by-X in
 *    one checkpoint's trailing estimate is compensated in the next
 *    checkpoint's delta, so summing a span of checkpoints stays accurate.
 *    `CheckpointTokens: reset` marks a boundary where the delta is
 *    unknowable (compaction shrink, or the fill is momentarily unknown).
 *
 *    Emission points — chosen so a message is only ever sent when the
 *    next LLM call is provably imminent (this is load-bearing: a pending
 *    message keeps pi's agent loop alive, so steering after a turn-ending
 *    response would provoke endless empty LLM calls — observed in
 *    production with an earlier design):
 *
 *    - Run start: `before_agent_start` returns the checkpoint message —
 *      pi appends it right after the incoming user message, before the
 *      run's first LLM call. This checkpoint also covers the PREVIOUS
 *      run's final response (the anchor), so nothing is lost across
 *      batches and no settle/catch-up machinery is needed.
 *    - Mid-run: the tool-calling assistant response says how many tool
 *      results to expect; on the last toolResult's `message_end` the
 *      checkpoint is sent as a steer, which pi drains after tool
 *      execution, before the next LLM call. The loop is guaranteed to
 *      continue (the response had tool calls), so the steer can't strand.
 *
 *    Placement caveats (all self-correcting at the next anchor): the last
 *    tool result may not yet be inside getContextUsage()'s estimate when
 *    its message_end fires, and steer user messages queued before the
 *    checkpoint land between it and the call. A checkpoint therefore
 *    reads as "approximately the input to the next LLM call"; spans are
 *    exact. (Note for a future pruner: tool calls and their results must
 *    be removed together, and checkpoints selected by customType, not
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
 *    freezes into history where it could drift.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHECKPOINT_TYPE = "context-meta.checkpoint";

/** Mirrors pi's ESTIMATED_IMAGE_CHARS (4800 chars ≈ 1200 tokens) for the
 *  incoming user message's images, which aren't in agent state yet when
 *  before_agent_start fires. */
const IMAGE_TOKENS = 1200;

export default function contextMeta(pi: ExtensionAPI): void {
  // Next checkpoint index and the total the previous checkpoint reported
  // (anchor + estimate; null when the fill was unknown, e.g. right after
  // compaction). Both seeded from the session on spawn.
  let nextIndex = 1;
  let prevTotal: number | null = null;
  let seeded = false;

  // Replay the session to continue the numbering and delta chain across
  // process respawns (the harness spawns a fresh pi per batch).
  const ensureSeeded = (ctx: ExtensionContext): void => {
    if (seeded) return;
    seeded = true;
    let count = 0;
    let lastDetails: { index?: number; total?: number | null } | undefined;
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type !== "custom_message" || e.customType !== CHECKPOINT_TYPE) continue;
      count++;
      lastDetails = e.details as typeof lastDetails;
    }
    nextIndex = (lastDetails?.index ?? count) + 1;
    prevTotal = lastDetails?.total ?? null;
  };

  // Build one checkpoint: delta from the previous checkpoint's total, or
  // `reset` when either side is unknown or the context shrank (compaction).
  const buildCheckpoint = (
    total: number | null,
  ): { customType: string; content: string; display: boolean; details: { index: number; total: number | null } } => {
    const delta =
      total !== null && prevTotal !== null && total >= prevTotal ? total - prevTotal : null;
    const index = nextIndex++;
    prevTotal = total;
    return {
      customType: CHECKPOINT_TYPE,
      content: `<harness-metadata>\nCheckpoint: ${index}\nCheckpointTokens: ${delta === null ? "reset" : `+${delta}`}\n</harness-metadata>`,
      display: true,
      details: { index, total },
    };
  };

  // Run start: the returned message is appended after the incoming user
  // message, before the run's first LLM call. getContextUsage() doesn't
  // include that user message yet (it enters agent state after this hook),
  // so estimate it from the prompt text and attached images.
  pi.on("before_agent_start", (event, ctx) => {
    ensureSeeded(ctx);
    const usage = ctx.getContextUsage();
    let total: number | null = null;
    if (usage && usage.tokens !== null) {
      const images = event.images?.length ?? 0;
      total = usage.tokens + Math.ceil(event.prompt.length / 4) + images * IMAGE_TOKENS;
    }
    return { message: buildCheckpoint(total) };
  });

  // Mid-run: the tool-calling response tells us how many tool results to
  // expect; the last one's message_end is the post-tool-results seam.
  let expectedToolResults = 0;
  let seenToolResults = 0;

  pi.on("message_end", (event, ctx) => {
    ensureSeeded(ctx);
    const msg = event.message;
    if (msg.role === "assistant") {
      expectedToolResults =
        msg.stopReason === "toolUse"
          ? (msg.content as Array<{ type: string }>).filter((b) => b.type === "toolCall").length
          : 0;
      seenToolResults = 0;
      return;
    }
    if (msg.role !== "toolResult" || expectedToolResults === 0) return;
    seenToolResults++;
    if (seenToolResults < expectedToolResults) return;
    expectedToolResults = 0;
    const usage = ctx.getContextUsage();
    pi.sendMessage(buildCheckpoint(usage?.tokens ?? null), {
      deliverAs: "steer",
      triggerTurn: false,
    });
  });

  // An aborted tool batch can end the run with an expectation pending;
  // clear it so a stale count can't mis-fire in a later run.
  pi.on("agent_settled", () => {
    expectedToolResults = 0;
    seenToolResults = 0;
  });

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
