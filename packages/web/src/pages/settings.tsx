import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ChevronRight,
  Clock,
  KeyRound,
  Loader2,
  Palette,
  Save,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { endpoints } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Global / app-level settings page. Per-agent + per-plugin configuration
 * (config files, secrets) lives on each agent's own Settings tab — see
 * `<AgentSettingsPane>`.
 */
export function SettingsPage() {
  const { theme, set } = useTheme();
  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: endpoints.listAgents,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b py-3 pl-14 pr-4 md:px-6">
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

          <TimezoneCard />

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

          <Card className="lg:col-span-2 border-warning/40 bg-warning/5">
            <CardHeader className="flex-row items-start gap-3">
              <ShieldAlert className="mt-0.5 size-4 text-warning" />
              <div>
                <CardTitle className="text-sm">
                  Plaintext secrets on disk
                </CardTitle>
                <CardDescription className="mt-1">
                  All plugin and agent secrets are stored unencrypted in
                  the harness root's <code>secrets.json</code>. Restrict
                  access to that file at the OS level until v1 ships
                  encryption.
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

function TimezoneCard() {
  const qc = useQueryClient();
  const { data: harness } = useQuery({
    queryKey: ["harness"],
    queryFn: endpoints.getHarness,
  });
  const [draft, setDraft] = useState<string>("");

  useEffect(() => {
    if (harness?.timezone) setDraft(harness.timezone);
  }, [harness?.timezone]);

  const tzOptions = useMemo(() => listIanaTimezones(), []);
  const tzSet = useMemo(() => new Set(tzOptions), [tzOptions]);

  const save = useMutation({
    mutationFn: (tz: string) => endpoints.putHarness({ timezone: tz }),
    onSuccess: (res) => {
      toast.success(
        res.restarted.length > 0
          ? `timezone saved · reloaded ${res.restarted.length} agent(s)`
          : "timezone saved",
      );
      qc.invalidateQueries({ queryKey: ["harness"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (e: Error) => toast.error(`save failed: ${e.message}`),
  });

  const trimmed = draft.trim();
  const isValid = tzSet.has(trimmed);
  const dirty = !!harness && trimmed.length > 0 && trimmed !== harness.timezone;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-primary/80" />
          <CardTitle>Timezone</CardTitle>
        </div>
        <CardDescription>
          IANA timezone used for <code>&lt;harness-metadata&gt;</code>{" "}
          timestamps and scheduler cron firing. Saving reloads every
          running agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[14rem] flex-1 flex-col gap-1.5">
          <Label className="font-mono text-xs" htmlFor="harness-tz-input">
            timezone
          </Label>
          <Input
            id="harness-tz-input"
            list="harness-tz-options"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search… e.g. Asia/Kolkata"
            autoComplete="off"
            className="font-mono text-xs"
          />
          <datalist id="harness-tz-options">
            {tzOptions.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          {trimmed.length > 0 && !isValid && (
            <span className="text-[11px] text-warning">
              ● not a recognized IANA timezone
            </span>
          )}
        </div>
        <Button
          size="sm"
          disabled={!dirty || !isValid || save.isPending}
          onClick={() => save.mutate(trimmed)}
        >
          {save.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

/** IANA timezones from the browser when available; small fallback list
 *  otherwise (older browsers). */
function listIanaTimezones(): string[] {
  const IntlAny = Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof IntlAny.supportedValuesOf === "function") {
    try {
      return IntlAny.supportedValuesOf("timeZone");
    } catch {
      // fall through
    }
  }
  return [
    "UTC",
    "America/Los_Angeles",
    "America/New_York",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Kolkata",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];
}
