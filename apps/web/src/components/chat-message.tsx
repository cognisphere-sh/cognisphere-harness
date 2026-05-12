import { motion } from "framer-motion";
import { Bot, Brain, User as UserIcon } from "lucide-react";
import type { AssistantBubble, UserBubble } from "@/lib/session";
import { splitHarnessMeta } from "@/lib/session";
import { cn, formatTime } from "@/lib/utils";
import { MarkdownText } from "@/components/markdown-text";
import { ToolCallCard } from "@/components/tool-call-card";

interface UserProps {
  agentId: string;
  bubble: UserBubble;
}

export function UserMessageBubble({ agentId, bubble }: UserProps) {
  const { meta, body } = splitHarnessMeta(bubble.text);
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="flex justify-end"
    >
      <div className="flex max-w-[88%] gap-2 sm:max-w-[78%]">
        <div className="min-w-0 space-y-2">
          {meta && (
            <details className="rounded-md border bg-card/60 px-2 py-1 text-[11px] text-muted-foreground">
              <summary className="cursor-pointer select-none">harness metadata</summary>
              <pre className="mt-1 whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">{meta}</pre>
            </details>
          )}
          <div className="overflow-hidden rounded-2xl rounded-tr-sm border bg-card px-3 py-2 text-sm shadow-card [overflow-wrap:anywhere]">
            <MarkdownText agentId={agentId} text={body} />
          </div>
          {bubble.images.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {bubble.images.map((img, i) => (
                <img
                  key={i}
                  alt=""
                  src={`data:${img.mimeType};base64,${img.data}`}
                  className="max-h-40 rounded-md border"
                />
              ))}
            </div>
          )}
          <div className="text-right text-[10px] text-muted-foreground">{formatTime(bubble.ts)}</div>
        </div>
        <div className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground">
          <UserIcon className="size-3.5" />
        </div>
      </div>
    </motion.div>
  );
}

interface AssistantProps {
  agentId: string;
  bubble: AssistantBubble;
}

export function AssistantMessageBubble({ agentId, bubble }: AssistantProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="flex justify-start"
    >
      <div className="flex max-w-[92%] gap-2 sm:max-w-[82%]">
        <div className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <Bot className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {bubble.segments.map((seg, i) => {
            if (seg.type === "thinking") {
              return (
                <details
                  key={i}
                  className="rounded-md border bg-card/60 px-3 py-2 text-xs text-muted-foreground"
                >
                  <summary className="flex cursor-pointer items-center gap-1.5 select-none">
                    <Brain className="size-3.5" />
                    thinking
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono">
                    {seg.thinking}
                  </pre>
                </details>
              );
            }
            if (seg.type === "text") {
              return (
                <div
                  key={i}
                  className={cn(
                    "overflow-hidden rounded-2xl rounded-tl-sm border bg-primary/5 px-3 py-2 text-sm shadow-card [overflow-wrap:anywhere]",
                    "border-primary/15",
                  )}
                >
                  <MarkdownText agentId={agentId} text={seg.text} />
                </div>
              );
            }
            if (seg.type === "toolCall") {
              return (
                <ToolCallCard
                  key={i}
                  agentId={agentId}
                  call={seg}
                  result={bubble.toolResults.get(seg.id)}
                />
              );
            }
            return null;
          })}
          {bubble.errorMessage && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {bubble.errorMessage}
            </div>
          )}
          <div className="text-[10px] text-muted-foreground">
            {bubble.model} · {formatTime(bubble.ts)}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
