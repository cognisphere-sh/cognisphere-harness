import { Children, Fragment, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { rawFileUrl } from "@/lib/api";
import { splitWithPaths } from "@/lib/format";
import { cn } from "@/lib/utils";

function linkifyString(text: string, agentId: string): ReactNode {
  const segs = splitWithPaths(text);
  if (segs.length === 1 && segs[0]?.kind === "text") return text;
  return segs.map((s, i) => {
    if (s.kind === "text") return <Fragment key={i}>{s.value}</Fragment>;
    const path = s.path!;
    const basename = path.split("/").pop() || path;
    return (
      <a
        key={i}
        href={rawFileUrl(agentId, path)}
        target="_blank"
        rel="noreferrer"
        title={path}
        className="rounded bg-primary/10 px-1 py-px font-mono text-[0.85em] text-primary underline-offset-2 hover:underline"
      >
        {basename}
      </a>
    );
  });
}

function withLinkifiedText(children: ReactNode, agentId: string): ReactNode {
  return Children.map(children, (child) =>
    typeof child === "string" ? linkifyString(child, agentId) : child,
  );
}

export function MarkdownText({
  text,
  agentId,
  className,
}: {
  text: string;
  agentId: string;
  className?: string;
}) {
  const link = (c: ReactNode) => withLinkifiedText(c, agentId);

  const components: Components = {
    p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{link(children)}</p>,
    ul: ({ children }) => (
      <ul className="my-1 ml-5 list-disc space-y-0.5 first:mt-0 last:mb-0">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="my-1 ml-5 list-decimal space-y-0.5 first:mt-0 last:mb-0">{children}</ol>
    ),
    li: ({ children }) => <li>{link(children)}</li>,
    h1: ({ children }) => (
      <h1 className="mb-1 mt-2 text-base font-semibold first:mt-0">{link(children)}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-1 mt-2 text-[0.95rem] font-semibold first:mt-0">{link(children)}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{link(children)}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-1 mt-2 text-sm font-medium first:mt-0">{link(children)}</h4>
    ),
    h5: ({ children }) => (
      <h5 className="mb-1 mt-2 text-sm font-medium first:mt-0">{link(children)}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="mb-1 mt-2 text-xs font-medium uppercase tracking-wide first:mt-0">
        {link(children)}
      </h6>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-1 border-l-2 border-primary/30 pl-3 text-muted-foreground">
        {children}
      </blockquote>
    ),
    code: ({ className: cls, children }) => {
      const raw = String(children ?? "");
      const isBlock = (cls?.startsWith("language-") ?? false) || raw.includes("\n");
      if (isBlock) {
        return <code className={cn("font-mono text-xs", cls)}>{children}</code>;
      }
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
      );
    },
    pre: ({ children }) => (
      <pre className="my-2 overflow-x-auto rounded-md border bg-muted/50 p-2 text-xs">
        {children}
      </pre>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2 hover:opacity-80"
      >
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto">
        <table className="min-w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
    th: ({ children }) => (
      <th className="border border-border px-2 py-1 text-left font-medium">{link(children)}</th>
    ),
    td: ({ children }) => (
      <td className="border border-border px-2 py-1">{link(children)}</td>
    ),
    hr: () => <hr className="my-2 border-border" />,
    strong: ({ children }) => <strong className="font-semibold">{link(children)}</strong>,
    em: ({ children }) => <em className="italic">{link(children)}</em>,
    del: ({ children }) => <del className="opacity-70">{link(children)}</del>,
    img: ({ src, alt }) => (
      <img src={src} alt={alt ?? ""} className="my-2 max-h-72 rounded-md border" />
    ),
  };

  return (
    <div className={cn("text-sm leading-relaxed", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
