import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { motion } from "framer-motion";
import { endpoints, type FsEntry } from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";

interface Props {
  agentId: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

export function FileTree({ agentId, selectedPath, onSelectFile }: Props) {
  return (
    <div className="flex h-full flex-col text-sm">
      <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Files
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        <DirNode
          agentId={agentId}
          path=""
          name="(root)"
          depth={0}
          defaultOpen
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
        />
      </div>
    </div>
  );
}

interface DirProps extends Props {
  path: string;
  name: string;
  depth: number;
  defaultOpen?: boolean;
}

function DirNode({
  agentId,
  path,
  name,
  depth,
  defaultOpen,
  selectedPath,
  onSelectFile,
}: DirProps) {
  const [open, setOpen] = useState(!!defaultOpen);
  const { data, isLoading } = useQuery({
    queryKey: ["tree", agentId, path],
    queryFn: () => endpoints.listTree(agentId, path),
    enabled: open,
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors",
          "hover:bg-accent",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="inline-flex"
        >
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </motion.span>
        {open ? (
          <FolderOpen className="size-4 text-primary/80" />
        ) : (
          <Folder className="size-4 text-primary/80" />
        )}
        <span className="truncate">{name}</span>
      </button>
      {open && (
        <div>
          {isLoading && (
            <div
              className="px-2 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: 28 + depth * 12 }}
            >
              loading…
            </div>
          )}
          {data?.entries.map((e) => (
            <TreeRow
              key={e.path}
              entry={e}
              depth={depth + 1}
              agentId={agentId}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          ))}
          {data && data.entries.length === 0 && (
            <div
              className="px-2 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: 28 + depth * 12 }}
            >
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TreeRow({
  entry,
  depth,
  agentId,
  selectedPath,
  onSelectFile,
}: {
  entry: FsEntry;
  depth: number;
  agentId: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}) {
  if (entry.isDir) {
    return (
      <DirNode
        agentId={agentId}
        path={entry.path}
        name={entry.name}
        depth={depth}
        selectedPath={selectedPath}
        onSelectFile={onSelectFile}
      />
    );
  }
  const isSelected = selectedPath === entry.path;
  return (
    <button
      type="button"
      onClick={() => onSelectFile(entry.path)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors",
        isSelected ? "bg-primary/10 text-primary" : "hover:bg-accent",
      )}
      style={{ paddingLeft: 24 + depth * 12 }}
    >
      <File className="size-4 text-muted-foreground" />
      <span className="truncate">{entry.name}</span>
      <span className="ml-auto text-[10px] text-muted-foreground">
        {formatBytes(entry.size)}
      </span>
    </button>
  );
}
