import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ChevronRight,
  Clock,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Mail,
  Palette,
  Save,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { endpoints, type GwsOauthAgent } from "@/lib/api";
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

          <GoogleWorkspaceCard />

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

/** "https://www.googleapis.com/auth/gmail.modify" → "gmail.modify". */
function scopeShortName(scope: string): string {
  return scope.split("/").pop() ?? scope;
}

/** Scope picker for the per-agent `oauthScopes` gws config key, grouped by
 *  Google service. `always: true` marks the baseline the sign-in flow
 *  requests regardless (not stored in config). */
const GWS_SCOPE_GROUPS: {
  service: string;
  scopes: { scope: string; always?: boolean }[];
}[] = [
  {
    service: "Gmail",
    scopes: [
      { scope: "https://www.googleapis.com/auth/gmail.modify", always: true },
    ],
  },
  {
    service: "Calendar",
    scopes: [
      { scope: "https://www.googleapis.com/auth/calendar" },
      { scope: "https://www.googleapis.com/auth/calendar.readonly" },
      { scope: "https://www.googleapis.com/auth/calendar.events" },
      { scope: "https://www.googleapis.com/auth/calendar.events.readonly" },
    ],
  },
  {
    service: "Drive",
    scopes: [
      { scope: "https://www.googleapis.com/auth/drive" },
      { scope: "https://www.googleapis.com/auth/drive.file" },
      { scope: "https://www.googleapis.com/auth/drive.readonly" },
      { scope: "https://www.googleapis.com/auth/drive.metadata.readonly" },
    ],
  },
  {
    service: "Docs",
    scopes: [
      { scope: "https://www.googleapis.com/auth/documents" },
      { scope: "https://www.googleapis.com/auth/documents.readonly" },
    ],
  },
  {
    service: "Sheets",
    scopes: [
      { scope: "https://www.googleapis.com/auth/spreadsheets" },
      { scope: "https://www.googleapis.com/auth/spreadsheets.readonly" },
    ],
  },
  {
    service: "Slides",
    scopes: [
      { scope: "https://www.googleapis.com/auth/presentations" },
      { scope: "https://www.googleapis.com/auth/presentations.readonly" },
    ],
  },
  {
    service: "Contacts",
    scopes: [
      { scope: "https://www.googleapis.com/auth/contacts" },
      { scope: "https://www.googleapis.com/auth/contacts.readonly" },
      { scope: "https://www.googleapis.com/auth/contacts.other.readonly" },
    ],
  },
  {
    service: "Tasks",
    scopes: [
      { scope: "https://www.googleapis.com/auth/tasks" },
      { scope: "https://www.googleapis.com/auth/tasks.readonly" },
    ],
  },
];

const GWS_KNOWN_SCOPES = new Set(
  GWS_SCOPE_GROUPS.flatMap((g) =>
    g.scopes.filter((s) => !s.always).map((s) => s.scope),
  ),
);

/**
 * Google sign-in/sign-out for agents running the gws plugin. Hidden when no
 * agent has the plugin installed. The OAuth client (id + secret from the
 * operator's own GCP project, with `<origin>/api/gws/oauth/callback`
 * registered as a redirect URI) is saved once and shared by every agent.
 */
function GoogleWorkspaceCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["gws-oauth"],
    queryFn: endpoints.getGwsOauth,
  });
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  useEffect(() => {
    if (!data) return;
    setClientId(data.client.clientId);
    setClientSecret(data.client.clientSecret);
  }, [data]);

  // Callback lands back on /settings?gws=… — surface the outcome once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ok = params.get("gws");
    const err = params.get("gwsError");
    if (!ok && !err) return;
    if (ok) toast.success("Google sign-in complete");
    if (err) toast.error(`Google sign-in failed: ${err}`);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const saveClient = useMutation({
    mutationFn: () =>
      endpoints.putGwsOauthClient({ clientId: clientId.trim(), clientSecret }),
    onSuccess: () => {
      toast.success("OAuth client saved");
      qc.invalidateQueries({ queryKey: ["gws-oauth"] });
    },
    onError: (e: Error) => toast.error(`save failed: ${e.message}`),
  });

  const signIn = useMutation({
    mutationFn: (agentId: string) => endpoints.startGwsSignIn(agentId),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (e: Error) => toast.error(`sign-in failed: ${e.message}`),
  });

  const signOut = useMutation({
    mutationFn: (agentId: string) => endpoints.gwsSignOut(agentId),
    onSuccess: () => {
      toast.success("Signed out of Google");
      qc.invalidateQueries({ queryKey: ["gws-oauth"] });
    },
    onError: (e: Error) => toast.error(`sign-out failed: ${e.message}`),
  });

  if (!data || data.agents.length === 0) return null;

  const clientConfigured =
    data.client.clientId.length > 0 && data.client.clientSecret.length > 0;
  const clientDirty =
    clientId.trim() !== data.client.clientId ||
    clientSecret !== data.client.clientSecret;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Mail className="size-4 text-primary/80" />
          <CardTitle>Google Workspace</CardTitle>
        </div>
        <CardDescription>
          Sign each gws-enabled agent into its Google account. Needs a
          &ldquo;Web application&rdquo; OAuth client from your GCP project
          with <code>{window.location.origin}/api/gws/oauth/callback</code>{" "}
          registered as a redirect URI. Gmail access is always requested;
          pick extra scopes per agent with the Scopes button (stored as
          <code>oauthScopes</code> in the agent&rsquo;s gws plugin config)
          before signing in.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
            <Label className="font-mono text-xs" htmlFor="gws-client-id">
              client id
            </Label>
            <Input
              id="gws-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="…apps.googleusercontent.com"
              autoComplete="off"
              className="font-mono text-xs"
            />
          </div>
          <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
            <Label className="font-mono text-xs" htmlFor="gws-client-secret">
              client secret
            </Label>
            <Input
              id="gws-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
              className="font-mono text-xs"
            />
          </div>
          <Button
            size="sm"
            disabled={!clientDirty || clientId.trim() === "" || saveClient.isPending}
            onClick={() => saveClient.mutate()}
          >
            {saveClient.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          {data.agents.map((a) => (
            <GwsAgentRow
              key={a.agentId}
              agent={a}
              clientConfigured={clientConfigured}
              signIn={signIn}
              signOut={signOut}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface GwsRowMutation {
  mutate: (agentId: string) => void;
  isPending: boolean;
  variables: string | undefined;
}

/** One gws-enabled agent: sign-in/out plus a collapsible per-service scope
 *  picker that edits `oauthScopes` in the agent's gws plugin config. */
function GwsAgentRow({
  agent: a,
  clientConfigured,
  signIn,
  signOut,
}: {
  agent: GwsOauthAgent;
  clientConfigured: boolean;
  signIn: GwsRowMutation;
  signOut: GwsRowMutation;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  /** Known-scope selection being edited; null = untouched (mirror config). */
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const { data: plugins } = useQuery({
    queryKey: ["agent-plugins", a.agentId],
    queryFn: () => endpoints.listPlugins(a.agentId),
    enabled: open,
  });
  const gwsConfig = (plugins?.plugins.find((p) => p.pluginId === "gws")
    ?.config ?? null) as { oauthScopes?: string } | null;
  const configured = useMemo(
    () =>
      new Set(
        (gwsConfig?.oauthScopes ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    [gwsConfig?.oauthScopes],
  );
  const knownConfigured = [...configured].filter((s) =>
    GWS_KNOWN_SCOPES.has(s),
  );
  // hand-edited scopes outside the checkbox list — preserved on save
  const unknown = [...configured].filter((s) => !GWS_KNOWN_SCOPES.has(s));
  const selected = draft ?? configured;
  const dirty =
    draft !== null &&
    [...draft].sort().join(",") !== [...knownConfigured].sort().join(",");

  const toggle = (scope: string, checked: boolean) => {
    setDraft((prev) => {
      const next = new Set(prev ?? knownConfigured);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
  };

  const saveScopes = useMutation({
    mutationFn: () =>
      endpoints.putPluginConfig(a.agentId, "gws", {
        ...(gwsConfig ?? {}),
        oauthScopes: [...unknown, ...(draft ?? [])].join(", "),
      }),
    onSuccess: () => {
      toast.success(
        a.signedIn ? "Scopes saved — sign in again to apply" : "Scopes saved",
      );
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["agent-plugins", a.agentId] });
    },
    onError: (e: Error) => toast.error(`save failed: ${e.message}`),
  });

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Bot className="size-4 text-primary/80" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{a.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {a.signedIn
              ? a.email
                ? `Signed in as ${a.email}`
                : a.managed
                  ? "Signed in"
                  : "Using an operator-managed credentials file"
              : "Not signed in"}
            {a.scopes.length > 0 && (
              <>
                {" · "}
                {a.scopes
                  .filter(
                    // hide the identity scopes (openid / userinfo.*) —
                    // only the workspace grants are interesting here
                    (s) =>
                      s.includes("googleapis.com/auth/") &&
                      !s.includes("/userinfo."),
                  )
                  .map(scopeShortName)
                  .join(", ")}
              </>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronRight
            className={`size-4 transition-transform ${open ? "rotate-90" : ""}`}
          />
          Scopes
        </Button>
        {a.signedIn ? (
          <Button
            size="sm"
            variant="outline"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate(a.agentId)}
          >
            {signOut.isPending && signOut.variables === a.agentId ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
            Sign out
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!clientConfigured || signIn.isPending}
            onClick={() => signIn.mutate(a.agentId)}
            title={
              clientConfigured
                ? undefined
                : "Save the OAuth client id and secret first"
            }
          >
            {signIn.isPending && signIn.variables === a.agentId ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogIn className="size-4" />
            )}
            Sign in with Google
          </Button>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-t pt-3">
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
            {GWS_SCOPE_GROUPS.map((g) => (
              <div key={g.service} className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {g.service}
                </span>
                {g.scopes.map((s) => (
                  <label
                    key={s.scope}
                    className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px]"
                    title={s.scope}
                  >
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={s.always || selected.has(s.scope)}
                      // no toggling until the current config has loaded —
                      // a save from a half-loaded draft would drop scopes
                      disabled={s.always || !plugins}
                      onChange={(e) => toggle(s.scope, e.target.checked)}
                    />
                    {scopeShortName(s.scope)}
                    {s.always && (
                      <span className="font-sans text-[10px] text-muted-foreground">
                        (always)
                      </span>
                    )}
                  </label>
                ))}
              </div>
            ))}
          </div>
          {unknown.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              Also configured: {unknown.map(scopeShortName).join(", ")} (kept
              on save)
            </div>
          )}
          <div>
            <Button
              size="sm"
              disabled={!dirty || saveScopes.isPending}
              onClick={() => saveScopes.mutate()}
            >
              {saveScopes.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Save scopes
            </Button>
          </div>
        </div>
      )}
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
