/**
 * Mirrors the slice of pi's session jsonl shape we render. Pi is the
 * authoritative source — see
 * temp/pi-mono/packages/coding-agent/src/core/session-manager.ts and
 * temp/pi-mono/packages/ai/src/types.ts. Each line of
 * `<agentDir>/sessions/<threadId>/<sessionId>.jsonl` is a `FileEntry`.
 */

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface TextContent {
  type: "text";
  text: string;
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}
export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  timestamp: number;
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: AgentMessage;
}

export interface OtherEntry {
  type: string;
  id?: string;
  timestamp?: string;
}

export type SessionEntry = SessionMessageEntry | OtherEntry;

// ── flatten a session into chat-friendly chunks ──────────────────

export interface UserBubble {
  kind: "user";
  id: string;
  text: string;
  images: ImageContent[];
  ts: number;
}

export interface AssistantBubble {
  kind: "assistant";
  id: string;
  segments: (TextContent | ThinkingContent | ToolCall)[];
  toolResults: Map<string, ToolResultMessage>;
  ts: number;
  model: string;
  errorMessage?: string;
}

export type ChatChunk = UserBubble | AssistantBubble;

export function flattenSession(rawEntries: unknown[]): ChatChunk[] {
  const entries = rawEntries.filter(
    (e): e is SessionEntry =>
      typeof e === "object" && e !== null && "type" in (e as object),
  );
  const messages = entries.filter(
    (e): e is SessionMessageEntry => e.type === "message",
  );

  const chunks: ChatChunk[] = [];
  // Index assistant chunks by toolCall.id so we can attach toolResults later.
  const assistantByToolCallId = new Map<string, AssistantBubble>();

  for (const entry of messages) {
    const m = entry.message;
    if (m.role === "user") {
      const text = stringifyUserContent(m.content);
      const images = Array.isArray(m.content)
        ? m.content.filter((p): p is ImageContent => p.type === "image")
        : [];
      chunks.push({
        kind: "user",
        id: entry.id,
        text,
        images,
        ts: m.timestamp,
      });
    } else if (m.role === "assistant") {
      const bubble: AssistantBubble = {
        kind: "assistant",
        id: entry.id,
        segments: m.content,
        toolResults: new Map(),
        ts: m.timestamp,
        model: m.model,
        errorMessage: m.errorMessage,
      };
      chunks.push(bubble);
      for (const seg of m.content) {
        if (seg.type === "toolCall") {
          assistantByToolCallId.set(seg.id, bubble);
        }
      }
    } else if (m.role === "toolResult") {
      const target = assistantByToolCallId.get(m.toolCallId);
      if (target) target.toolResults.set(m.toolCallId, m);
      // If we don't find a target (older sessions, partial data), drop silently.
    }
  }
  return chunks;
}

function stringifyUserContent(c: UserMessage["content"]): string {
  if (typeof c === "string") return c;
  return c
    .filter((p): p is TextContent => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Pull just the `<harness-metadata>` block out of a user text. */
export function splitHarnessMeta(text: string): { meta: string | null; body: string } {
  const m = text.match(/^<harness-metadata>\n([\s\S]*?)\n<\/harness-metadata>\n([\s\S]*)$/);
  if (!m) return { meta: null, body: text };
  return { meta: m[1] ?? "", body: m[2] ?? "" };
}
