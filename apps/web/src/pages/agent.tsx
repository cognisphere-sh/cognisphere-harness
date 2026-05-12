import { lazy, Suspense, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Bot,
  Copy,
  FolderTree,
  MessagesSquare,
  Plug,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import { endpoints } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileTree } from "@/components/file-tree";
const FileEditor = lazy(() =>
  import("@/components/file-editor").then((m) => ({ default: m.FileEditor })),
);
import { ChatWindow } from "@/components/chat-window";
import { EventsTable } from "@/components/events-table";
import { AgentSettingsPane } from "@/components/agent-settings-pane";
import {
  LifecycleControls,
  StatusBadge,
} from "@/components/agent-status";

export function AgentPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { data: agent } = useQuery({
    queryKey: ["agent", id],
    queryFn: () => endpoints.getAgent(id),
    enabled: !!id,
    refetchInterval: 3000,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b py-3 pl-14 pr-4 md:px-6">
        <div className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {agent?.name ?? id}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {agent?.agentJson
              ? `${agent.agentJson.model.provider}/${agent.agentJson.model.id}`
              : id}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {agent && <StatusBadge state={agent.state} />}
          {agent && <LifecycleControls agentId={id} state={agent.state} />}
        </div>
      </header>
      {agent?.state === "failed" && agent.error && (
        <ErrorStrip message={agent.error} />
      )}
      <SubTabs agentId={id} />
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route index element={<Navigate to="chat" replace />} />
          <Route path="chat" element={<ChatWindow agentId={id} />} />
          <Route path="files/*" element={<FilesPane agentId={id} />} />
          <Route
            path="events"
            element={
              <div className="h-full p-4 sm:p-6">
                <EventsTable agentId={id} />
              </div>
            }
          />
          <Route path="queue" element={<Navigate to="../events" replace />} />
          <Route path="plugins" element={<PluginsPane agentId={id} />} />
          <Route path="settings" element={<AgentSettingsPane agentId={id} />} />
          <Route path="*" element={<Navigate to="chat" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function SubTabs({ agentId }: { agentId: string }) {
  const loc = useLocation();
  const tabs = [
    { to: `/agents/${agentId}/chat`, key: "chat", label: "Chat", icon: MessagesSquare },
    { to: `/agents/${agentId}/files`, key: "files", label: "Files", icon: FolderTree },
    { to: `/agents/${agentId}/events`, key: "events", label: "Events", icon: Activity },
    { to: `/agents/${agentId}/plugins`, key: "plugins", label: "Plugins", icon: Plug },
    { to: `/agents/${agentId}/settings`, key: "settings", label: "Settings", icon: Settings },
  ];
  return (
    <nav className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-1 sm:px-4">
      {tabs.map((t) => {
        const active = loc.pathname.startsWith(t.to);
        const Icon = t.icon;
        return (
          <Link
            key={t.key}
            to={t.to}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

function FilesPane({ agentId }: { agentId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="flex h-full min-h-0 md:grid md:grid-cols-[minmax(220px,28%)_1fr]">
      <aside
        className={cn(
          "min-h-0 flex-1 overflow-y-auto border-r bg-card/50 md:flex-none",
          selected && "hidden md:block",
        )}
      >
        <FileTree
          agentId={agentId}
          selectedPath={selected}
          onSelectFile={(p) => setSelected(p)}
          onPathDeleted={(p) => {
            if (
              selected &&
              (selected === p || selected.startsWith(`${p}/`))
            ) {
              setSelected(null);
            }
          }}
        />
      </aside>
      <section
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col md:flex",
          selected ? "flex" : "hidden md:flex",
        )}
      >
        {selected ? (
          <>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent md:hidden"
            >
              <ArrowLeft className="size-3.5" />
              Back to files
            </button>
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="grid h-full place-items-center text-sm text-muted-foreground">
                    Loading editor…
                  </div>
                }
              >
                <FileEditor agentId={agentId} path={selected} />
              </Suspense>
            </div>
          </>
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            Select a file from the tree to open it.
          </div>
        )}
      </section>
    </div>
  );
}

function PluginsPane({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["plugins", agentId],
    queryFn: () => endpoints.listPlugins(agentId),
    refetchInterval: 5000,
  });
  if (isLoading)
    return <div className="p-6 text-sm text-muted-foreground">loading…</div>;
  return (
    <div className="grid gap-3 p-4 sm:p-6 md:grid-cols-2 xl:grid-cols-3">
      {data?.plugins.map((p) => (
        <Card
          key={p.pluginId}
          role="button"
          tabIndex={0}
          onClick={() =>
            navigate(`/agents/${agentId}/settings#plugin-${p.pluginId}`)
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              navigate(`/agents/${agentId}/settings#plugin-${p.pluginId}`);
            }
          }}
          className="cursor-pointer transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CardHeader>
            <div className="flex items-center gap-2">
              <Plug className="size-4 text-primary/80" />
              <CardTitle className="truncate">
                {p.manifest?.displayName || p.pluginId}
              </CardTitle>
              <StatusBadge state={p.state} />
            </div>
            <CardDescription className="font-mono">{p.pluginId}</CardDescription>
            {p.manifest?.description && (
              <p className="mt-1 text-xs text-muted-foreground">
                {p.manifest.description}
              </p>
            )}
            {p.state === "failed" && p.error && (
              <pre className="mt-2 overflow-x-auto rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                {p.error}
              </pre>
            )}
          </CardHeader>
        </Card>
      ))}
      {data && data.plugins.length === 0 && (
        <div className="text-sm text-muted-foreground">No plugins installed.</div>
      )}
    </div>
  );
}

function ErrorStrip({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 border-y border-destructive/30 bg-destructive/10 px-4 py-2 text-destructive sm:px-6">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words text-xs">
        {message}
      </pre>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:bg-destructive/10"
        onClick={() => {
          navigator.clipboard.writeText(message);
          toast.success("error copied");
        }}
      >
        <Copy />
        Copy
      </Button>
    </div>
  );
}
