import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronRight, Sparkles } from "lucide-react";
import { endpoints } from "@/lib/api";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/agent-status";
import { cn } from "@/lib/utils";

export function IndexPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: endpoints.listAgents,
    refetchInterval: 5000,
  });

  return (
    <div className="flex h-full flex-col">
      <header className="border-b py-3 pl-14 pr-4 md:px-6">
        <h1 className="text-lg font-semibold">Agents</h1>
        <p className="text-xs text-muted-foreground">
          Pick an agent to manage files, chat, or inspect the queue.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {isLoading && <div className="text-sm text-muted-foreground">loading…</div>}
        {!isLoading && (data?.agents.length ?? 0) === 0 && <EmptyState />}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data?.agents.map((a, i) => (
            <Link
              key={a.id}
              to={`/agents/${a.id}`}
              className="block animate-in fade-in slide-in-from-bottom-1.5 fill-mode-backwards duration-200"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <Card
                hoverable
                className={cn(
                  "group relative overflow-hidden",
                  a.state === "stopped" && "opacity-70",
                )}
              >
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <div className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
                      <Bot className="size-4" />
                    </div>
                    <CardTitle className="truncate">{a.name}</CardTitle>
                    <StatusDot state={a.state} />
                    <ChevronRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                  <CardDescription className="font-mono">{a.id}</CardDescription>
                  {a.installedPlugins.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {a.installedPlugins.map((p) => {
                        const variant = a.failedPlugins.includes(p)
                          ? "destructive"
                          : a.runningPlugins.includes(p)
                            ? "secondary"
                            : "outline";
                        return (
                          <Badge key={p} variant={variant}>
                            {p}
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                  {a.state === "failed" && a.error && (
                    <p className="mt-2 truncate text-xs text-destructive">
                      {a.error}
                    </p>
                  )}
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="p-6 text-center">
      <Sparkles className="mx-auto mb-2 size-6 text-primary" />
      <CardTitle>No agents yet</CardTitle>
      <CardDescription className="mt-2">
        Agents are created manually on disk in v0. See{" "}
        <code>docs/v0-deferred.md</code> for the recipe.
      </CardDescription>
    </Card>
  );
}
