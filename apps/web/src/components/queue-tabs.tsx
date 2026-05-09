import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Inbox,
  RefreshCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { endpoints } from "@/lib/api";
import { cn, formatTime } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

interface Props {
  agentId: string;
}

export function QueueTabs({ agentId }: Props) {
  return (
    <Tabs defaultValue="pending" className="flex h-full min-h-0 flex-col">
      <TabsList className="self-start">
        <TabsTrigger value="pending">
          <Inbox className="size-3.5" /> Pending
        </TabsTrigger>
        <TabsTrigger value="dlq">
          <AlertTriangle className="size-3.5" /> Dead-letter
        </TabsTrigger>
        <TabsTrigger value="events">
          <Activity className="size-3.5" /> Events
        </TabsTrigger>
      </TabsList>
      <TabsContent value="pending" className="min-h-0 flex-1 overflow-auto">
        <Pending agentId={agentId} />
      </TabsContent>
      <TabsContent value="dlq" className="min-h-0 flex-1 overflow-auto">
        <Dlq agentId={agentId} />
      </TabsContent>
      <TabsContent value="events" className="min-h-0 flex-1 overflow-auto">
        <Events agentId={agentId} />
      </TabsContent>
    </Tabs>
  );
}

function Pending({ agentId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ["pending", agentId],
    queryFn: () => endpoints.listPending(agentId),
    refetchInterval: 2_000,
  });
  if (isLoading) return <Stub>loading…</Stub>;
  const rows = data?.messages ?? [];
  if (rows.length === 0) return <Stub>Queue is empty.</Stub>;
  return (
    <div className="grid gap-2">
      {rows.map((r) => (
        <Card key={r.id} hoverable className="p-3">
          <div className="mb-1 flex items-center gap-2 text-xs">
            <Badge variant={r.inFlight ? "warning" : "secondary"}>
              {r.inFlight ? "in-flight" : "queued"}
            </Badge>
            <span className="font-mono text-[11px] text-muted-foreground">
              #{r.id} · {r.pluginId}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {formatTime(r.enqueuedAt)}
            </span>
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            thread · {r.threadId}
          </div>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
            {r.text}
          </pre>
          <div className="mt-2 text-[10px] text-muted-foreground">
            attempts: {r.attempts} · priority: {r.priority}
            {r.isSilent && " · silent"}
          </div>
        </Card>
      ))}
    </div>
  );
}

function Dlq({ agentId }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["dlq", agentId],
    queryFn: () => endpoints.listDLQ(agentId),
    refetchInterval: 5_000,
  });
  const requeue = useMutation({
    mutationFn: (rowId: number) => endpoints.requeueDLQ(agentId, rowId),
    onSuccess: () => {
      toast.success("requeued");
      qc.invalidateQueries({ queryKey: ["dlq", agentId] });
      qc.invalidateQueries({ queryKey: ["pending", agentId] });
    },
  });
  const drop = useMutation({
    mutationFn: (rowId: number) => endpoints.deleteDLQ(agentId, rowId),
    onSuccess: () => {
      toast.success("removed");
      qc.invalidateQueries({ queryKey: ["dlq", agentId] });
    },
  });
  if (isLoading) return <Stub>loading…</Stub>;
  const rows = data?.messages ?? [];
  if (rows.length === 0)
    return (
      <Stub>
        <CheckCircle2 className="mx-auto mb-1 size-5 text-success" />
        No dead-lettered messages.
      </Stub>
    );
  return (
    <div className="grid gap-2">
      {rows.map((r) => (
        <Card key={r.id} className="p-3">
          <div className="mb-1 flex items-center gap-2 text-xs">
            <Badge variant="destructive">dead</Badge>
            <span className="font-mono text-[11px] text-muted-foreground">
              #{r.id} · {r.pluginId}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {formatTime(r.deadAt)}
            </span>
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            thread · {r.threadId} · attempts {r.attempts}
          </div>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
            {r.text}
          </pre>
          {r.lastError && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono text-[11px] text-destructive">
              {r.lastError}
            </pre>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => requeue.mutate(r.id)}
              disabled={requeue.isPending}
            >
              <RefreshCcw className="size-3.5" /> Requeue
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => drop.mutate(r.id)}
              disabled={drop.isPending}
            >
              <Trash2 className="size-3.5" /> Discard
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Events({ agentId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ["events", agentId],
    queryFn: () => endpoints.listEvents(agentId),
    refetchInterval: 3_000,
  });
  if (isLoading) return <Stub>loading…</Stub>;
  const rows = data?.events ?? [];
  if (rows.length === 0) return <Stub>No events yet.</Stub>;
  return (
    <div className="grid gap-1">
      {rows.map((r) => (
        <div
          key={r.id}
          className={cn(
            "flex flex-wrap items-baseline gap-x-2 gap-y-0 rounded-md border px-3 py-1.5 text-[12px] transition-colors hover:bg-accent",
            r.status === "failed" && "border-destructive/40",
            r.status === "done" && "border-success/30",
          )}
        >
          <span className="text-[10px] text-muted-foreground">
            {formatTime(r.ts)}
          </span>
          <Badge
            variant={
              r.status === "failed"
                ? "destructive"
                : r.status === "done"
                  ? "success"
                  : "secondary"
            }
          >
            {r.status}
          </Badge>
          <span className="font-mono text-xs">{r.event}</span>
          {r.thread_id && (
            <code className="text-[11px] text-muted-foreground">
              thread:{r.thread_id}
            </code>
          )}
          {r.plugin_id && (
            <code className="text-[11px] text-muted-foreground">
              plugin:{r.plugin_id}
            </code>
          )}
          {r.log && <span className="text-[11px] text-muted-foreground">{r.log}</span>}
          {r.error && (
            <span className="font-mono text-[11px] text-destructive">{r.error}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Stub({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-32 place-items-center text-center text-sm text-muted-foreground">
      <div>{children}</div>
    </div>
  );
}
