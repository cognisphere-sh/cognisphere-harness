import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { Code2, Download, Eye, FileWarning, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { endpoints, rawFileUrl, ApiError } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { cn, formatBytes } from "@/lib/utils";
import { MarkdownText } from "@/components/markdown-text";

interface Props {
  agentId: string;
  path: string;
}

export function FileEditor({ agentId, path }: Props) {
  const { theme } = useTheme();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["file", agentId, path],
    queryFn: () => endpoints.readFile(agentId, path),
    retry: false,
  });

  const [draft, setDraft] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const initialFor = useRef<string | null>(null);
  const previewKind = previewKindFor(path);
  const [mode, setMode] = useState<"preview" | "code">(
    previewKind ? "preview" : "code",
  );

  useEffect(() => {
    if (data && initialFor.current !== path) {
      setDraft(data.content);
      setDirty(false);
      initialFor.current = path;
      setMode(previewKindFor(path) ? "preview" : "code");
    }
  }, [data, path]);

  const save = useMutation({
    mutationFn: () => endpoints.writeFile(agentId, path, draft),
    onSuccess: () => {
      setDirty(false);
      toast.success("saved");
      qc.invalidateQueries({ queryKey: ["file", agentId, path] });
      qc.invalidateQueries({ queryKey: ["tree", agentId] });
    },
    onError: (e: Error) => toast.error(`save failed: ${e.message}`),
  });

  const lang = useMemo(() => extensionFor(path), [path]);

  if (error) {
    const apiErr = error as ApiError;
    const isBinary = apiErr.status === 415;
    const tooBig = apiErr.status === 413;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <FileWarning className="size-6 text-warning" />
        <div className="text-center">
          <div className="font-medium text-foreground">
            {isBinary ? "Binary file" : tooBig ? "File too large" : "Failed to read"}
          </div>
          <div>{apiErr.message}</div>
        </div>
        <a
          href={rawFileUrl(agentId, path, { download: true })}
          className="inline-flex items-center gap-1.5 text-primary hover:underline"
        >
          <Download className="size-4" />
          download
        </a>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
        <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{path}</code>
        {data && (
          <span className="text-[10px] text-muted-foreground">
            {formatBytes(data.size)}
          </span>
        )}
        {dirty && <span className="text-[10px] text-warning">● unsaved</span>}
        <div className="ml-auto flex items-center gap-2">
          {previewKind && (
            <div className="flex overflow-hidden rounded-md border">
              <button
                type="button"
                onClick={() => setMode("preview")}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-1 text-xs transition-colors",
                  mode === "preview"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                <Eye className="size-3.5" />
                Preview
              </button>
              <button
                type="button"
                onClick={() => setMode("code")}
                className={cn(
                  "inline-flex items-center gap-1 border-l px-2 py-1 text-xs transition-colors",
                  mode === "code"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                <Code2 className="size-3.5" />
                Code
              </button>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={save.isPending}
          >
            Reload
          </Button>
          <Button
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            loading…
          </div>
        ) : previewKind && mode === "preview" ? (
          <FilePreview kind={previewKind} content={draft} agentId={agentId} />
        ) : (
          <CodeMirror
            value={draft}
            height="100%"
            theme={theme === "dark" ? oneDark : "light"}
            extensions={lang ? [lang] : []}
            onChange={(v) => {
              setDraft(v);
              setDirty(true);
            }}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              tabSize: 2,
            }}
            style={{ height: "100%", fontSize: 13 }}
          />
        )}
      </div>
    </div>
  );
}

type PreviewKind = "html" | "md" | "csv";

function previewKindFor(path: string): PreviewKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  if (lower.endsWith(".csv")) return "csv";
  return null;
}

function FilePreview({
  kind,
  content,
  agentId,
}: {
  kind: PreviewKind;
  content: string;
  agentId: string;
}) {
  if (kind === "html") {
    return (
      <iframe
        srcDoc={content}
        sandbox=""
        title="html preview"
        className="size-full border-0 bg-white"
      />
    );
  }
  if (kind === "md") {
    return (
      <div className="h-full overflow-auto px-4 py-3">
        <MarkdownText text={content} agentId={agentId} />
      </div>
    );
  }
  return <CsvPreview content={content} />;
}

function CsvPreview({ content }: { content: string }) {
  const rows = useMemo(() => parseCsv(content), [content]);
  if (rows.length === 0) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        empty
      </div>
    );
  }
  const [header, ...body] = rows;
  return (
    <div className="h-full overflow-auto">
      <table className="min-w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-muted/80 backdrop-blur">
          <tr>
            <th className="border border-border px-2 py-1 text-right font-medium text-muted-foreground">
              #
            </th>
            {header?.map((h, i) => (
              <th
                key={i}
                className="border border-border px-2 py-1 text-left font-medium"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="odd:bg-muted/20">
              <td className="border border-border px-2 py-1 text-right text-muted-foreground">
                {r + 1}
              </td>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="whitespace-pre-wrap break-words border border-border px-2 py-1 align-top"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      cell = "";
      row = [];
    } else if (c === "\r") {
      // skip
    } else {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function extensionFor(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return json();
  if (lower.endsWith(".md")) return markdown();
  if (lower.endsWith(".py")) return python();
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx")
  ) {
    return javascript({
      jsx: lower.endsWith(".jsx") || lower.endsWith(".tsx"),
      typescript: lower.endsWith(".ts") || lower.endsWith(".tsx"),
    });
  }
  return null;
}
