import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ChevronRight,
  KeyRound,
  Lock,
  Palette,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";
import { endpoints } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Global / app-level settings page. Per-agent + per-plugin configuration
 * (config files, secrets) lives on each agent's own Settings tab — see
 * `<AgentSettingsPane>`.
 */
export function SettingsPage() {
  const { user } = useAuth();
  const { theme, set } = useTheme();
  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: endpoints.listAgents,
  });
  const { data: secrets } = useQuery({
    queryKey: ["secrets"],
    queryFn: endpoints.getSecrets,
  });

  const harnessRoot = secrets?.path
    ? secrets.path.replace(/\/secrets\.json$/, "")
    : null;
  const usersPath = harnessRoot ? `${harnessRoot}/users.json` : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-xs text-muted-foreground">
          App-level — for agent and plugin configuration, open the agent's
          own Settings tab.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Palette className="size-4 text-primary/80" />
                <CardTitle>Appearance</CardTitle>
              </div>
              <CardDescription>Theme</CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button
                variant={theme === "light" ? "default" : "outline"}
                size="sm"
                onClick={() => set("light")}
              >
                Light
              </Button>
              <Button
                variant={theme === "dark" ? "default" : "outline"}
                size="sm"
                onClick={() => set("dark")}
              >
                Dark
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Users className="size-4 text-primary/80" />
                <CardTitle>Account</CardTitle>
              </div>
              <CardDescription>Logged-in user</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 text-sm">
                <Badge variant="secondary">{user ?? "—"}</Badge>
                <span className="text-xs text-muted-foreground">
                  edit <code>{usersPath ?? "users.json"}</code> and restart
                  to manage accounts
                </span>
              </div>
            </CardContent>
          </Card>

          <Link to="/settings/models" className="lg:col-span-2 block">
            <Card className="group cursor-pointer transition-colors hover:bg-accent/30">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Sparkles className="size-4 text-primary/80" />
                  <CardTitle>Models</CardTitle>
                  <ChevronRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>
                <CardDescription>
                  Provider API keys and the per-provider allowlist of
                  models that agents can pick from.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Lock className="size-4 text-primary/80" />
                <CardTitle>Storage</CardTitle>
              </div>
              <CardDescription>
                Where the harness keeps its state on disk
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <KV label="Harness root" value={harnessRoot ?? "—"} />
              <KV
                label="Secrets file"
                value={secrets?.path ?? "—"}
                hint="plaintext in v0; encryption in v1"
              />
              <KV label="Users file" value={usersPath ?? "—"} />
              <KV
                label="Agent buckets"
                value={`${agents?.agents.length ?? 0} agent(s) loaded`}
              />
            </CardContent>
          </Card>

          <Card className="lg:col-span-2 border-warning/40 bg-warning/5">
            <CardHeader className="flex-row items-start gap-3">
              <ShieldAlert className="mt-0.5 size-4 text-warning" />
              <div>
                <CardTitle className="text-sm">
                  Plaintext secrets on disk
                </CardTitle>
                <CardDescription className="mt-1">
                  All plugin and agent secrets are stored unencrypted at the
                  path above. Restrict access to that file at the OS level
                  until v1 ships encryption.
                </CardDescription>
              </div>
            </CardHeader>
          </Card>

          {agents && agents.agents.length > 0 && (
            <Card className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <KeyRound className="size-4 text-primary/80" />
                  <CardTitle>Per-agent settings</CardTitle>
                </div>
                <CardDescription>
                  Configure each agent's <code>agent.json</code>, plugin
                  configs, and secrets in its own Settings tab.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2">
                {agents.agents.map((a) => (
                  <Link
                    key={a.id}
                    to={`/agents/${a.id}/settings`}
                    className="group flex items-center gap-2 rounded-md border p-3 transition-colors hover:bg-accent"
                  >
                    <Bot className="size-4 text-primary/80" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {a.name}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {a.id}
                      </div>
                    </div>
                    <ChevronRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function KV({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-xs text-muted-foreground">{label}:</span>
      <code className="break-all text-xs">{value}</code>
      {hint && (
        <span className="text-[10px] text-muted-foreground">· {hint}</span>
      )}
    </div>
  );
}
