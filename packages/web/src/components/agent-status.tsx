import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, Square, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { endpoints, type AgentState, type PluginState } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DOT_CLASSES: Record<AgentState, string> = {
  running: "bg-emerald-500",
  stopped: "bg-muted-foreground/40",
  failed: "bg-destructive",
};

export function StatusDot({
  state,
  className,
}: {
  state: AgentState | PluginState;
  className?: string;
}) {
  return (
    <span
      title={state}
      aria-label={`status: ${state}`}
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT_CLASSES[state], className)}
    />
  );
}

const BADGE_VARIANT: Record<AgentState, "success" | "secondary" | "destructive"> = {
  running: "success",
  stopped: "secondary",
  failed: "destructive",
};

export function StatusBadge({ state }: { state: AgentState | PluginState }) {
  return <Badge variant={BADGE_VARIANT[state]}>{state}</Badge>;
}

export function LifecycleControls({
  agentId,
  state,
}: {
  agentId: string;
  state: AgentState;
}) {
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["agents"] });
    qc.invalidateQueries({ queryKey: ["agent", agentId] });
    qc.invalidateQueries({ queryKey: ["plugins", agentId] });
  };

  const start = useMutation({
    mutationFn: () => endpoints.startAgent(agentId),
    onSuccess: (res) => {
      if (res.error) toast.warning(`started with errors: ${res.error}`);
      else toast.success("agent started");
    },
    onError: (e: Error) => toast.error(`start failed: ${e.message}`),
    onSettled: invalidate,
  });

  const stop = useMutation({
    mutationFn: () => endpoints.stopAgent(agentId),
    onSuccess: () => toast.success("agent stopped"),
    onError: (e: Error) => toast.error(`stop failed: ${e.message}`),
    onSettled: invalidate,
  });

  const restart = useMutation({
    mutationFn: () => endpoints.restartAgent(agentId),
    onSuccess: (res) => {
      if (res.error) toast.warning(`restarted with errors: ${res.error}`);
      else toast.success("agent restarted");
    },
    onError: (e: Error) => toast.error(`restart failed: ${e.message}`),
    onSettled: invalidate,
  });

  const busy = start.isPending || stop.isPending || restart.isPending;

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="outline"
        disabled={state === "running" || busy}
        onClick={() => start.mutate()}
      >
        {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}
        Start
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={state !== "running" || busy}
        onClick={() => stop.mutate()}
      >
        {stop.isPending ? <Loader2 className="animate-spin" /> : <Square />}
        Stop
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => restart.mutate()}
      >
        {restart.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
        Restart
      </Button>
    </div>
  );
}
