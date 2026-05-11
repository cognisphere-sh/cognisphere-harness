import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Loader2,
  MessagesSquare,
  Paperclip,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { endpoints, type ThreadRow } from "@/lib/api";
import { flattenSession } from "@/lib/session";
import {
  AssistantMessageBubble,
  UserMessageBubble,
} from "@/components/chat-message";
import { Button } from "@/components/ui/button";
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

  const threads = threadsData?.threads ?? [];
  const [selected, setSelected] = useState<{
    threadId: string;
    sessionId: string;
  } | null>(null);

  // Default selection: first thread, latest session.
  useEffect(() => {
    if (selected) return;
    const first = threads[0];
    const firstSession = first?.sessions[0];
    if (first && firstSession) {
      setSelected({ threadId: first.threadId, sessionId: firstSession.sessionId });
    }
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
    enabled: !!selected,
    refetchInterval: 3_000,
  });

  const chunks = useMemo(
    () => (sessionData ? flattenSession(sessionData.entries) : []),
    [sessionData],
  );

  const [input, setInput] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  // Auto-scroll on new messages, but only if we're already near the bottom.
  useEffect(() => {
    if (!pinnedToBottom) return;
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [chunks.length, pinnedToBottom]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distance < 80);
  };

  const send = useMutation({
    mutationFn: (text: string) =>
      endpoints.sendChat(agentId, text, selected?.threadId),
    onSuccess: () => {
      setInput("");
      qc.invalidateQueries({ queryKey: ["threads", agentId] });
      qc.invalidateQueries({
        queryKey: ["session", agentId, selected?.threadId, selected?.sessionId],
      });
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

  const upload = useMutation({
    mutationFn: (file: File) => endpoints.uploadFile(agentId, file, "uploads"),
    onSuccess: (r) => {
      const ref = `uploads/${r.name}`;
      setInput((prev) => (prev ? `${prev} ${ref}` : ref));
      toast.success(`uploaded ${ref}`);
      qc.invalidateQueries({ queryKey: ["tree", agentId] });
    },
    onError: (e: Error) => toast.error(`upload failed: ${e.message}`),
  });

  const onSend = () => {
    const text = input.trim();
    if (!text) return;
    send.mutate(text);
  };

  return (
    <div className="flex h-full min-h-0 flex-col lg:grid lg:grid-cols-[minmax(220px,22%)_1fr]">
      <ThreadList
        threads={threads}
        loading={threadsLoading}
        selected={selected}
        onSelect={setSelected}
      />
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
              <code className="min-w-0 truncate">{selected.sessionId}</code>
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
              {selected ? "(empty session)" : "Send a message to start a thread."}
            </div>
          )}
          {chunks.map((c) =>
            c.kind === "user" ? (
              <UserMessageBubble key={c.id} agentId={agentId} bubble={c} />
            ) : (
              <AssistantMessageBubble key={c.id} agentId={agentId} bubble={c} />
            ),
          )}
        </div>
        <div className="shrink-0 border-t bg-card p-3">
          <div className="flex items-end gap-2">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => fileInput.current?.click()}
              disabled={upload.isPending}
              aria-label="upload file"
            >
              {upload.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Paperclip className="size-4" />
              )}
            </Button>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message the agent…"
              rows={1}
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
              disabled={!input.trim() || send.isPending}
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
            Enter to send · Shift+Enter for newline · 📎 uploads to{" "}
            <code>uploads/</code>
          </div>
        </div>
      </div>
    </div>
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
  const value = selected ? `${selected.threadId}::${selected.sessionId}` : "";
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5 lg:hidden">
      <MessagesSquare className="size-4 shrink-0" />
      <select
        value={value}
        onChange={(e) => {
          const [threadId, sessionId] = e.target.value.split("::");
          if (threadId && sessionId) onSelect({ threadId, sessionId });
        }}
        className="min-w-0 flex-1 truncate rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="select thread"
      >
        {!selected && <option value="">— pick a thread —</option>}
        {threads.map((t) =>
          t.sessions.slice(0, 5).map((s) => (
            <option
              key={`${t.threadId}::${s.sessionId}`}
              value={`${t.threadId}::${s.sessionId}`}
            >
              {t.threadId.slice(0, 12)}… / {s.sessionId.slice(0, 10)}…
            </option>
          )),
        )}
      </select>
    </label>
  );
}

function ThreadList({
  threads,
  loading,
  selected,
  onSelect,
}: {
  threads: ThreadRow[];
  loading: boolean;
  selected: { threadId: string; sessionId: string } | null;
  onSelect: (s: { threadId: string; sessionId: string }) => void;
}) {
  return (
    <div className="hidden h-full min-h-0 flex-col lg:flex">
      <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Threads
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {loading && (
          <div className="px-3 py-1 text-xs text-muted-foreground">loading…</div>
        )}
        {threads.map((t) => (
          <div key={t.threadId} className="mb-2">
            <div className="px-3 py-1 font-mono text-xs text-foreground/80">
              {t.threadId}
            </div>
            <div className="space-y-0.5">
              {t.sessions.slice(0, 5).map((s) => {
                const isSel =
                  selected?.threadId === t.threadId &&
                  selected.sessionId === s.sessionId;
                return (
                  <button
                    key={s.sessionId}
                    onClick={() =>
                      onSelect({ threadId: t.threadId, sessionId: s.sessionId })
                    }
                    className={cn(
                      "block w-full truncate rounded-md px-3 py-1 text-left text-[11px] font-mono transition-colors",
                      isSel
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-accent",
                    )}
                    title={s.sessionId}
                  >
                    {s.sessionId.slice(0, 18)}…
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {!loading && threads.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No threads yet. Send a message below to start one.
          </div>
        )}
      </div>
    </div>
  );
}
