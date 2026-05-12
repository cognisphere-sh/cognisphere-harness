import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { endpoints, type FsEntry } from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  agentId: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onPathDeleted?: (path: string) => void;
}

export function FileTree(props: Props) {
  const { data: agent } = useQuery({
    queryKey: ["agent", props.agentId],
    queryFn: () => endpoints.getAgent(props.agentId),
    enabled: !!props.agentId,
  });
  return (
    <div className="flex h-full flex-col text-sm">
      <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Files
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        <DirNode
          {...props}
          path=""
          name={agent?.name ?? props.agentId}
          depth={0}
          defaultOpen
          isRoot
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
  isRoot?: boolean;
}

function DirNode({
  agentId,
  path,
  name,
  depth,
  defaultOpen,
  selectedPath,
  onSelectFile,
  onPathDeleted,
  isRoot,
}: DirProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(!!defaultOpen);
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["tree", agentId, path],
    queryFn: () => endpoints.listTree(agentId, path),
    enabled: open,
  });

  const takenNames = new Set(data?.entries.map((e) => e.name) ?? []);

  const create = useMutation({
    mutationFn: async (childName: string) => {
      const kind = creating;
      const child = path ? `${path}/${childName}` : childName;
      if (kind === "folder") await endpoints.mkdir(agentId, child);
      else await endpoints.writeFile(agentId, child, "");
      return { child, kind };
    },
    onSuccess: ({ child, kind }) => {
      setCreating(null);
      toast.success(kind === "folder" ? "folder created" : "file created");
      qc.invalidateQueries({ queryKey: ["tree", agentId, path] });
      if (kind === "file") onSelectFile(child);
    },
    onError: (e: Error) => toast.error(`create failed: ${e.message}`),
  });

  const remove = useMutation({
    mutationFn: () => endpoints.deletePath(agentId, path),
    onSuccess: () => {
      setConfirmDelete(false);
      toast.success("deleted");
      qc.invalidateQueries({ queryKey: ["tree", agentId, parentOf(path)] });
      onPathDeleted?.(path);
    },
    onError: (e: Error) => toast.error(`delete failed: ${e.message}`),
  });

  const beginCreate = (kind: "file" | "folder") => {
    setOpen(true);
    setCreating(kind);
  };

  return (
    <div>
      <div
        className="group relative flex items-center"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors",
            "hover:bg-accent",
          )}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="folder actions"
              className={cn(
                "mr-1 rounded p-1 opacity-0 transition-opacity hover:bg-accent",
                "group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100",
              )}
            >
              <MoreHorizontal className="size-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => beginCreate("file")}>
              <FilePlus className="size-4" />
              New file
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => beginCreate("folder")}>
              <FolderPlus className="size-4" />
              New folder
            </DropdownMenuItem>
            {!isRoot && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setConfirmDelete(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {open && (
        <div>
          {creating && (
            <CreateInput
              depth={depth + 1}
              kind={creating}
              taken={takenNames}
              pending={create.isPending}
              onSubmit={(n) => create.mutate(n)}
              onCancel={() => setCreating(null)}
            />
          )}
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
              onPathDeleted={onPathDeleted}
            />
          ))}
          {data && data.entries.length === 0 && !creating && (
            <div
              className="px-2 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: 28 + depth * 12 }}
            >
              empty
            </div>
          )}
        </div>
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete folder?</DialogTitle>
            <DialogDescription>
              <code className="rounded bg-muted px-1 py-0.5">{path}</code> and
              everything inside will be permanently removed. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TreeRow({
  entry,
  depth,
  agentId,
  selectedPath,
  onSelectFile,
  onPathDeleted,
}: {
  entry: FsEntry;
  depth: number;
  agentId: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onPathDeleted?: (path: string) => void;
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
        onPathDeleted={onPathDeleted}
      />
    );
  }
  return (
    <FileRow
      entry={entry}
      depth={depth}
      agentId={agentId}
      selectedPath={selectedPath}
      onSelectFile={onSelectFile}
      onPathDeleted={onPathDeleted}
    />
  );
}

function FileRow({
  entry,
  depth,
  agentId,
  selectedPath,
  onSelectFile,
  onPathDeleted,
}: {
  entry: FsEntry;
  depth: number;
  agentId: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onPathDeleted?: (path: string) => void;
}) {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isSelected = selectedPath === entry.path;

  const remove = useMutation({
    mutationFn: () => endpoints.deletePath(agentId, entry.path),
    onSuccess: () => {
      setConfirmDelete(false);
      toast.success("deleted");
      qc.invalidateQueries({
        queryKey: ["tree", agentId, parentOf(entry.path)],
      });
      onPathDeleted?.(entry.path);
    },
    onError: (e: Error) => toast.error(`delete failed: ${e.message}`),
  });

  return (
    <div
      className="group relative flex items-center"
      style={{ paddingLeft: 24 + depth * 12 }}
    >
      <button
        type="button"
        onClick={() => onSelectFile(entry.path)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors",
          isSelected ? "bg-primary/10 text-primary" : "hover:bg-accent",
        )}
      >
        <File className="size-4 text-muted-foreground" />
        <span className="truncate">{entry.name}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {formatBytes(entry.size)}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="file actions"
            className={cn(
              "mr-1 rounded p-1 opacity-0 transition-opacity hover:bg-accent",
              "group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100",
            )}
          >
            <MoreHorizontal className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => setConfirmDelete(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete file?</DialogTitle>
            <DialogDescription>
              <code className="rounded bg-muted px-1 py-0.5">{entry.path}</code>{" "}
              will be permanently removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateInput({
  depth,
  kind,
  taken,
  pending,
  onSubmit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "folder";
  taken: Set<string>;
  pending: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const invalid =
    trimmed.length === 0 ||
    trimmed.includes("/") ||
    trimmed.startsWith(".") ||
    taken.has(trimmed);

  return (
    <div
      className="flex items-center gap-1.5 py-0.5"
      style={{ paddingLeft: 24 + (depth - 1) * 12 }}
    >
      {kind === "folder" ? (
        <Folder className="size-4 text-primary/80" />
      ) : (
        <File className="size-4 text-muted-foreground" />
      )}
      <input
        autoFocus
        type="text"
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !invalid) onSubmit(trimmed);
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          if (!pending) onCancel();
        }}
        placeholder={kind === "folder" ? "folder name" : "file name"}
        className={cn(
          "h-6 min-w-0 flex-1 rounded border bg-background px-1.5 text-xs outline-none focus:border-primary",
          invalid && value !== "" && "border-destructive",
        )}
      />
    </div>
  );
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
