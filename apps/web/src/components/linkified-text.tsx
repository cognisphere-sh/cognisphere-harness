import { Fragment } from "react";
import { rawFileUrl } from "@/lib/api";
import { splitWithPaths } from "@/lib/format";

/**
 * Render a chat text where any path-shaped substring becomes a link to
 * /api/agents/<agentId>/fs/raw?path=…&download=1. Paths inside backticks
 * keep their backticks for visual continuity.
 */
export function LinkifiedText({
  text,
  agentId,
  className,
}: {
  text: string;
  agentId: string;
  className?: string;
}) {
  const segs = splitWithPaths(text);
  return (
    <span className={className}>
      {segs.map((s, i) => {
        if (s.kind === "text") return <Fragment key={i}>{s.value}</Fragment>;
        const href = rawFileUrl(agentId, s.path!);
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-primary/10 px-1 py-px font-mono text-[0.85em] text-primary underline-offset-2 hover:underline"
          >
            {s.value.startsWith("`") && s.value.endsWith("`")
              ? s.value
              : s.value}
          </a>
        );
      })}
    </span>
  );
}
