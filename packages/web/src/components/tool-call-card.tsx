import { useState } from "react";
import { motion } from "framer-motion";
import {
  ChevronDown,
  Edit3,
  FileText,
  FolderTree,
  Pencil,
  Search,
  SearchCode,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { LinkifiedText } from "@/components/linkified-text";
import type {
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "@/lib/session";
import { rawFileUrl } from "@/lib/api";

const TOOL_META: Record<string, { icon: React.FC<{ className?: string }>; label: string }> = {
  read: { icon: FileText, label: "Read" },
  bash: { icon: TerminalSquare, label: "Bash" },
  edit: { icon: Edit3, label: "Edit" },
  write: { icon: Pencil, label: "Write" },
  grep: { icon: Search, label: "Grep" },
  find: { icon: SearchCode, label: "Find" },
  ls: { icon: FolderTree, label: "ls" },
};

interface Props {
  agentId: string;
  call: ToolCall;
  result?: ToolResultMessage;
}

export function ToolCallCard({ agentId, call, result }: Props) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[call.name] ?? { icon: Wrench, label: call.name };
  const Icon = meta.icon;
  const isError = result?.isError === true;
  const summary = oneLineSummary(call);

  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-card transition-all",
        "hover:shadow-card-hover",
        isError && "border-destructive/40",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon className="size-4 text-primary/80" />
        <span className="font-mono text-xs font-medium">{meta.label}</span>
        <span className="truncate text-xs text-muted-foreground">{summary}</span>
        <div className="ml-auto flex items-center gap-2">
          {result ? (
            <Badge variant={isError ? "destructive" : "success"}>
              {isError ? "error" : "ok"}
            </Badge>
          ) : (
            <Badge variant="outline">running</Badge>
          )}
          <motion.div
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.18 }}
            className="text-muted-foreground"
          >
            <ChevronDown className="size-4" />
          </motion.div>
        </div>
      </button>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="space-y-3 border-t px-3 py-3"
        >
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Input
            </div>
            <ArgsList agentId={agentId} args={call.arguments} />
          </div>
          {result && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Output
              </div>
              <ResultBody agentId={agentId} content={result.content} isError={isError} />
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}

function ArgsList({
  agentId,
  args,
}: {
  agentId: string;
  args: Record<string, unknown>;
}) {
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return <div className="text-xs text-muted-foreground">(no arguments)</div>;
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-muted-foreground">{k}</dt>
          <dd className="break-words font-mono">
            <ArgValue agentId={agentId} value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ArgValue({ agentId, value }: { agentId: string; value: unknown }) {
  if (typeof value === "string") {
    if (value.length > 240) {
      return (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 text-[11px]">
          {value}
        </pre>
      );
    }
    return <LinkifiedText agentId={agentId} text={value} />;
  }
  return (
    <pre className="overflow-auto rounded border bg-muted/40 p-2 text-[11px]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ResultBody({
  agentId,
  content,
  isError,
}: {
  agentId: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
}) {
  return (
    <div className="space-y-2">
      {content.map((c, i) => {
        if (c.type === "text") {
          return (
            <pre
              key={i}
              className={cn(
                "max-h-72 overflow-auto whitespace-pre-wrap rounded-md border p-2 font-mono text-[11px]",
                isError
                  ? "border-destructive/40 bg-destructive/5 text-destructive"
                  : "bg-muted/40",
              )}
            >
              <LinkifiedText agentId={agentId} text={c.text} />
            </pre>
          );
        }
        return (
          <img
            key={i}
            alt=""
            src={`data:${c.mimeType};base64,${c.data}`}
            className="max-h-72 rounded-md border"
          />
        );
      })}
    </div>
  );
}

function oneLineSummary(call: ToolCall): string {
  const args = call.arguments;
  const candidate = (args.path ?? args.command ?? args.pattern ?? args.file_path ?? "") as unknown;
  if (typeof candidate === "string") return candidate.slice(0, 120);
  return "";
}

// dummy export to keep rawFileUrl in the import-tree if linkified-text changes
void rawFileUrl;
