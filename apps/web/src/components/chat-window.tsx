import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  MessagesSquare,
  Paperclip,
  Plus,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { endpoints, type ThreadRow } from "@/lib/api";
import { flattenSession } from "@/lib/session";
import {
  AssistantMessageBubble,
  UserMessageBubble,
} from "@/components/chat-message";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Props {
  agentId: string;
}

export function ChatWindow({ agentId }: Props) {
  const qc = useQueryClient();
  const { data: threadsData, isLoading: threadsLoading } = useQuery({
    queryKey: ["threads", agentId],
    queryFn: () => endpoints.listThreads(agentId),
    refetchInterval: 5_000,
  });

  const threads = useMemo(() => threadsData?.threads ?? [], [threadsData]);
  const [selected, setSelected] = useState<{
    threadId: string;
    sessionId: string;
  } | null>(null);

  // Deep-link target from the events tab: `?thread=<>&session=<>&entry=<>`.
  // We pre-select the thread/session, then scroll the matching entry into
  // view once the session JSONL loads. Each unique link triggers exactly
  // one consume (keyed on the param values) so clicking a *different*
  // event link re-fires; clicking the same one twice doesn't.
  const [searchParams, setSearchParams] = useSearchParams();
  const linkThread = searchParams.get("thread");
  const linkSession = searchParams.get("session");
  const linkEntry = searchParams.get("entry");
  const [highlightEntryId, setHighlightEntryId] = useState<string | null>(null);
  const lastConsumedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!linkThread || !linkSession) return;
    const key = `${linkThread}::${linkSession}::${linkEntry ?? ""}`;
    if (lastConsumedKeyRef.current === key) return;
    lastConsumedKeyRef.current = key;
    setSelected({ threadId: linkThread, sessionId: linkSession });
    if (linkEntry) setHighlightEntryId(linkEntry);
    // Strip the params so a subsequent thread switch isn't fought.
    const next = new URLSearchParams(searchParams);
    next.delete("thread");
    next.delete("session");
    next.delete("entry");
    setSearchParams(next, { replace: true });
  }, [linkThread, linkSession, linkEntry, searchParams, setSearchParams]);

  // Default selection: first thread, its active (canonical) session.
  // Falls back to the most-recent on-disk session for legacy threads
  // that pre-date the harness owning session ids.
  useEffect(() => {
    if (selected) return;
    const first = threads[0];
    if (!first) return;
    const sid = first.activeSessionId ?? first.sessions[0]?.sessionId;
    if (sid) setSelected({ threadId: first.threadId, sessionId: sid });
  }, [threads, selected]);

  // Once a pending new-thread's first message has been processed, the
  // thread appears in `threads` with a real session id — upgrade the
  // sentinel "" sessionId so the JSONL panel can load.
  useEffect(() => {
    if (!selected || selected.sessionId) return;
    const t = threads.find((x) => x.threadId === selected.threadId);
    if (!t) return;
    const sid = pickThreadSession(t);
    if (sid) setSelected({ threadId: selected.threadId, sessionId: sid });
  }, [threads, selected]);

  const { data: sessionData } = useQuery({
    queryKey: [
      "session",
      agentId,
      selected?.threadId,
      selected?.sessionId,
    ],
    queryFn: () =>
      endpoints.readSession(agentId, selected!.threadId, selected!.sessionId),
    enabled: !!selected?.sessionId,
    refetchInterval: 3_000,
  });

  const chunks = useMemo(
    () => (sessionData ? flattenSession(sessionData.entries) : []),
    [sessionData],
  );

  const currentThread = useMemo(
    () => threads.find((t) => t.threadId === selected?.threadId) ?? null,
    [threads, selected?.threadId],
  );
  const activeSessionId = currentThread
    ? pickThreadSession(currentThread)
    : null;
  // A "pending" thread is one the user just created via the New Thread
  // dialog: we hold its id locally, but the server-side thread row
  // doesn't exist until the first message lands.
  const isPendingNewThread = !!selected && selected.sessionId === "";
  const isViewingActive =
    isPendingNewThread ||
    (!!selected && !!activeSessionId && selected.sessionId === activeSessionId);

  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [newThreadInput, setNewThreadInput] = useState("");
  const onCreateThread = () => {
    const id = newThreadInput.trim();
    if (!id) {
      toast.error("thread id required");
      return;
    }
    if (threads.some((t) => t.threadId === id)) {
      toast.error(`thread "${id}" already exists`);
      return;
    }
    setSelected({ threadId: id, sessionId: "" });
    setNewThreadInput("");
    setNewThreadOpen(false);
  };

  const [input, setInput] = useState("");
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  // Auto-scroll on new messages, but only if we're already near the bottom.
  // Suppressed while a deep-link target is pending so we don't fight the
  // entry-id scroll below.
  useEffect(() => {
    if (highlightEntryId) return;
    if (!pinnedToBottom) return;
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [chunks.length, pinnedToBottom, highlightEntryId]);

  // Once the targeted entry is rendered, scroll it into view and flash a
  // highlight ring. We poll briefly because the bubble may not be in the DOM
  // on the first effect tick (chunks update right when sessionData arrives,
  // but child components mount one tick later).
  useEffect(() => {
    if (!highlightEntryId) return;
    if (chunks.length === 0) return;
    let attempts = 0;
    const tryScroll = () => {
      const root = scrollerRef.current;
      const el = root?.querySelector(
        `[data-entry-id="${cssEscape(highlightEntryId)}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-primary", "rounded-lg");
        setTimeout(() => {
          el.classList.remove("ring-2", "ring-primary", "rounded-lg");
        }, 2500);
        setHighlightEntryId(null);
        return;
      }
      if (attempts++ < 20) setTimeout(tryScroll, 100);
    };
    tryScroll();
  }, [chunks, highlightEntryId]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distance < 80);
  };

  const send = useMutation({
    mutationFn: async ({ text, files }: { text: string; files: File[] }) => {
      const uploaded: string[] = [];
      for (const f of files) {
        const r = await endpoints.uploadFile(agentId, f, "plugins/admin/inbox");
        uploaded.push(r.path);
      }
      const body =
        uploaded.length === 0
          ? text
          : [text, "attachments:", ...uploaded.map((p) => `- ${p}`)]
              .filter(Boolean)
              .join("\n");
      return endpoints.sendChat(agentId, body, selected?.threadId);
    },
    onSuccess: () => {
      setInput("");
      setStagedFiles([]);
      qc.invalidateQueries({ queryKey: ["threads", agentId] });
      qc.invalidateQueries({
        queryKey: ["session", agentId, selected?.threadId, selected?.sessionId],
      });
      qc.invalidateQueries({ queryKey: ["tree", agentId] });
    },
    onError: (e: Error) => toast.error(`send failed: ${e.message}`),
  });

  const abort = useMutation({
    mutationFn: () =>
      selected
        ? endpoints.abortChat(agentId, selected.threadId)
        : Promise.resolve({ ok: false }),
    onSuccess: (r) => {
      if (r.ok) toast.info("abort sent");
      else toast.message("nothing in flight");
    },
  });

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const deleteThread = useMutation({
    mutationFn: (threadId: string) => endpoints.deleteThread(agentId, threadId),
    onSuccess: (_r, threadId) => {
      toast.success(`thread "${threadId}" deleted`);
      if (selected?.threadId === threadId) setSelected(null);
      setPendingDelete(null);
      qc.invalidateQueries({ queryKey: ["threads", agentId] });
      qc.invalidateQueries({ queryKey: ["events", agentId] });
      qc.invalidateQueries({ queryKey: ["tree", agentId] });
    },
    onError: (e: Error) => toast.error(`delete failed: ${e.message}`),
  });

  const onDeleteThread = (threadId: string) => {
    // Pending (server-side empty) thread: just drop it locally.
    if (
      selected?.threadId === threadId &&
      selected.sessionId === "" &&
      !threads.some((t) => t.threadId === threadId)
    ) {
      setSelected(null);
      return;
    }
    setPendingDelete(threadId);
  };

  const onSend = () => {
    const text = input.trim();
    if (!text && stagedFiles.length === 0) return;
    send.mutate({ text, files: stagedFiles });
  };

  const onFilesPicked = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setStagedFiles((prev) => [...prev, ...Array.from(files)]);
  };

  const removeStaged = (idx: number) => {
    setStagedFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const canSend =
    (!!input.trim() || stagedFiles.length > 0) &&
    !send.isPending &&
    isViewingActive;

  return (
    <div className="flex h-full min-h-0 flex-col lg:grid lg:grid-cols-[minmax(220px,22%)_1fr]">
      <ThreadList
        threads={threads}
        loading={threadsLoading}
        selected={selected}
        onSelect={setSelected}
        onNewThread={() => setNewThreadOpen(true)}
        onDeleteThread={onDeleteThread}
        deletingThreadId={
          deleteThread.isPending ? deleteThread.variables ?? null : null
        }
      />
      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete thread?</DialogTitle>
            <DialogDescription>
              This permanently removes the thread{" "}
              <code className="rounded bg-muted px-1 font-mono">
                {pendingDelete}
              </code>{" "}
              and all of its sessions, queued events, and history.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                pendingDelete && deleteThread.mutate(pendingDelete)
              }
              disabled={deleteThread.isPending}
            >
              {deleteThread.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={newThreadOpen} onOpenChange={setNewThreadOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New thread</DialogTitle>
            <DialogDescription>
              Enter an id for the new thread. The thread will be created when
              you send the first message.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="thread id"
            value={newThreadInput}
            onChange={(e) => setNewThreadInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCreateThread();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setNewThreadInput("");
                setNewThreadOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button onClick={onCreateThread} disabled={!newThreadInput.trim()}>
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col lg:border-l">
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs text-muted-foreground">
          <MobileThreadPicker
            threads={threads}
            selected={selected}
            onSelect={setSelected}
          />
          {selected ? (
            <>
              <MessagesSquare className="hidden size-4 lg:inline" />
              <code className="min-w-0 truncate">{selected.threadId}</code>
              <span className="text-[10px]">·</span>
              <SessionPicker
                sessions={currentThread?.sessions ?? []}
                selectedSessionId={selected.sessionId}
                activeSessionId={activeSessionId}
                onSelect={(sid) =>
                  setSelected({ threadId: selected.threadId, sessionId: sid })
                }
              />
            </>
          ) : (
            <span>No session selected</span>
          )}
        </div>
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="flex-1 space-y-4 overflow-y-auto p-4"
        >
          {chunks.length === 0 && (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              {isPendingNewThread
                ? "Send a message to create this thread."
                : selected
                  ? "(empty session)"
                  : "Send a message to start a thread."}
            </div>
          )}
          {chunks.map((c) => (
            <div key={c.id} data-entry-id={c.id} className="transition-shadow">
              {c.kind === "user" ? (
                <UserMessageBubble agentId={agentId} bubble={c} />
              ) : (
                <AssistantMessageBubble agentId={agentId} bubble={c} />
              )}
            </div>
          ))}
        </div>
        <div className="shrink-0 border-t bg-card p-3">
          {stagedFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {stagedFiles.map((f, i) => (
                <StagedFileChip
                  key={`${f.name}-${i}`}
                  file={f}
                  onRemove={() => removeStaged(i)}
                  disabled={send.isPending}
                />
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                onFilesPicked(e.target.files);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => fileInput.current?.click()}
              disabled={send.isPending || !isViewingActive}
              aria-label="attach file"
            >
              <Paperclip className="size-4" />
            </Button>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                isViewingActive
                  ? "Message the agent…"
                  : "Archived session — switch to the latest session to send messages"
              }
              rows={1}
              disabled={!isViewingActive}
              className={cn("max-h-40 min-h-9 min-w-0 flex-1 resize-none")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.metaKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
            />
            <Button
              variant={send.isPending ? "secondary" : "default"}
              size="icon"
              onClick={() => (send.isPending ? null : onSend())}
              disabled={!canSend}
              aria-label="send"
            >
              {send.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => abort.mutate()}
              disabled={!selected}
              aria-label="abort"
              title="Abort current batch"
            >
              <Square className="size-4" />
            </Button>
          </div>
          <div className="px-1 pt-1 text-[10px] text-muted-foreground">
            {isViewingActive ? (
              <>
                Enter to send · Shift+Enter for newline · 📎 attaches to{" "}
                <code>plugins/admin/inbox/</code>
              </>
            ) : (
              <>Read-only — this is an archived session.</>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StagedFileChip({
  file,
  onRemove,
  disabled,
}: {
  file: File;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex max-w-xs items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs">
      <div className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
        <FileText className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{file.name}</div>
        <div className="text-[10px] text-muted-foreground">
          {formatFileSize(file.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`remove ${file.name}`}
        className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** Wrap CSS.escape with a fallback for environments that lack it. */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\]/g, "\\$&");
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Each thread has a single canonical session (the harness-owned
 *  `activeSessionId`). For legacy threads with no binding yet we fall
 *  back to the most-recent on-disk session. */
function pickThreadSession(t: ThreadRow): string | null {
  return t.activeSessionId ?? t.sessions[0]?.sessionId ?? null;
}

function SessionPicker({
  sessions,
  selectedSessionId,
  activeSessionId,
  onSelect,
}: {
  sessions: { sessionId: string; modified: number }[];
  selectedSessionId: string;
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  // Newest first. The active session is pinned to the top regardless.
  const sorted = useMemo(() => {
    const xs = [...sessions].sort((a, b) => b.modified - a.modified);
    if (!activeSessionId) return xs;
    const active = xs.find((s) => s.sessionId === activeSessionId);
    if (!active) return xs;
    const rest = xs.filter((s) => s.sessionId !== activeSessionId);
    return [active, ...rest];
  }, [sessions, activeSessionId]);

  // Legacy threads or threads with a single session: render plain code, no menu.
  if (sorted.length <= 1) {
    return <code className="min-w-0 truncate">{selectedSessionId}</code>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-w-0 items-center gap-1 truncate rounded-md px-1.5 py-0.5 font-mono text-xs",
            "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          aria-label="select session"
        >
          <span className="min-w-0 truncate">{selectedSessionId}</span>
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[min(28rem,90vw)]">
        {sorted.map((s) => {
          const isSel = s.sessionId === selectedSessionId;
          const isActive = s.sessionId === activeSessionId;
          return (
            <DropdownMenuItem
              key={s.sessionId}
              onSelect={() => onSelect(s.sessionId)}
              className="flex items-start gap-2"
            >
              <Check
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  isSel ? "opacity-100" : "opacity-0",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <code className="truncate text-xs">{s.sessionId}</code>
                  {isActive && (
                    <span className="rounded bg-primary/15 px-1 py-px text-[9px] font-medium uppercase tracking-wider text-primary">
                      latest
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {new Date(s.modified).toLocaleString()}
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileThreadPicker({
  threads,
  selected,
  onSelect,
}: {
  threads: ThreadRow[];
  selected: { threadId: string; sessionId: string } | null;
  onSelect: (s: { threadId: string; sessionId: string }) => void;
}) {
  if (threads.length === 0) return null;
  const value = selected ? selected.threadId : "";
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5 lg:hidden">
      <MessagesSquare className="size-4 shrink-0" />
      <select
        value={value}
        onChange={(e) => {
          const t = threads.find((x) => x.threadId === e.target.value);
          if (!t) return;
          const sid = pickThreadSession(t);
          if (sid) onSelect({ threadId: t.threadId, sessionId: sid });
        }}
        className="min-w-0 flex-1 truncate rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="select thread"
      >
        {!selected && <option value="">— pick a thread —</option>}
        {threads.map((t) => (
          <option key={t.threadId} value={t.threadId}>
            {t.threadId}
          </option>
        ))}
      </select>
    </label>
  );
}

function ThreadList({
  threads,
  loading,
  selected,
  onSelect,
  onNewThread,
  onDeleteThread,
  deletingThreadId,
}: {
  threads: ThreadRow[];
  loading: boolean;
  selected: { threadId: string; sessionId: string } | null;
  onSelect: (s: { threadId: string; sessionId: string }) => void;
  onNewThread: () => void;
  onDeleteThread: (threadId: string) => void;
  deletingThreadId: string | null;
}) {
  // A selected thread with sessionId === "" is a pending new thread the
  // user just created — it isn't in `threads` yet, so render it at the
  // top so the selection has a visible row.
  const pendingNew =
    selected &&
    selected.sessionId === "" &&
    !threads.some((t) => t.threadId === selected.threadId)
      ? selected.threadId
      : null;
  return (
    <div className="hidden h-full min-h-0 flex-col lg:flex">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Threads
        </div>
        <button
          type="button"
          onClick={onNewThread}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="new thread"
        >
          <Plus className="size-3.5" />
          New
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {loading && (
          <div className="px-3 py-1 text-xs text-muted-foreground">loading…</div>
        )}
        {pendingNew && (
          <ThreadRow
            label={pendingNew}
            sublabel="pending — send a message to create"
            selected
            onSelect={null}
            onDelete={() => onDeleteThread(pendingNew)}
            deleting={false}
          />
        )}
        {threads.map((t) => {
          const sid = pickThreadSession(t);
          const isSel = !!sid && selected?.threadId === t.threadId;
          return (
            <ThreadRow
              key={t.threadId}
              label={t.threadId}
              sublabel={sid ? `${sid.slice(0, 18)}…` : null}
              selected={isSel}
              onSelect={
                sid
                  ? () => onSelect({ threadId: t.threadId, sessionId: sid })
                  : null
              }
              onDelete={() => onDeleteThread(t.threadId)}
              deleting={deletingThreadId === t.threadId}
            />
          );
        })}
        {!loading && threads.length === 0 && !pendingNew && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No threads yet. Send a message below to start one.
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadRow({
  label,
  sublabel,
  selected,
  onSelect,
  onDelete,
  deleting,
}: {
  label: string;
  sublabel: string | null;
  selected: boolean;
  onSelect: (() => void) | null;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div
      className={cn(
        "group relative mb-1 flex items-center gap-1 rounded-md transition-colors",
        selected
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent",
      )}
    >
      <button
        type="button"
        onClick={onSelect ?? undefined}
        disabled={!onSelect}
        className={cn(
          "min-w-0 flex-1 truncate px-3 py-1.5 text-left",
          !onSelect && "cursor-default",
        )}
        title={sublabel ?? "no active session"}
      >
        <div className="truncate font-mono text-xs text-foreground/90">
          {label}
        </div>
        {sublabel && (
          <div
            className={cn(
              "truncate font-mono text-[10px]",
              selected ? "text-primary/70" : "text-muted-foreground",
            )}
          >
            {sublabel}
          </div>
        )}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        disabled={deleting}
        aria-label={`delete thread ${label}`}
        title="Delete thread"
        className={cn(
          "mr-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground/70",
          "opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          deleting && "opacity-100",
        )}
      >
        {deleting ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Trash2 className="size-3.5" />
        )}
      </button>
    </div>
  );
}
