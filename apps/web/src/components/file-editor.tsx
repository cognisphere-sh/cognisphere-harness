import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { Download, FileWarning, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { endpoints, rawFileUrl, ApiError } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/utils";

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

  useEffect(() => {
    if (data && initialFor.current !== path) {
      setDraft(data.content);
      setDirty(false);
      initialFor.current = path;
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
