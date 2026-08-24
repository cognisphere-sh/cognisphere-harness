import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, LogIn, LogOut, Mail, Save } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { endpoints, type PluginSummary } from "@/lib/api";
import { Button } from "@/components/ui/button";

/** "https://www.googleapis.com/auth/gmail.modify" → "gmail.modify". */
function scopeShortName(scope: string): string {
  return scope.split("/").pop() ?? scope;
}

/** Scope picker for the per-agent `oauthScopes` gws config key, grouped by
 *  Google service. `always: true` marks the baseline the sign-in flow
 *  requests regardless (not stored in config).
 *
 *  Gmail is deliberately not granular: in Google's permission model
 *  `gmail.readonly` / `gmail.compose` / `gmail.send` / `gmail.labels` are
 *  all strict subsets of `gmail.modify` (everything except permanent
 *  deletion, which is only in `https://mail.google.com/` — never
 *  requested). The poll loop marks messages read, which needs `modify`,
 *  so a narrower Gmail grant either breaks the loop or is redundant
 *  alongside the one it requires. */
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
 * Google sign-in/sign-out + scope picker rendered on the gws plugin's card
 * in the agent's Settings tab. The shared OAuth client (id + secret) is
 * configured once on the app-level Settings page; everything account-level
 * — which scopes, signing in, signing out — happens here, per agent.
 * The OAuth callback redirects back to this page with `?gws=` /
 * `?gwsError=` for the outcome toast.
 */
export function GwsSignInBlock({
  agentId,
  plugin,
}: {
  agentId: string;
  plugin: PluginSummary;
}) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["gws-oauth"],
    queryFn: endpoints.getGwsOauth,
  });
  const [open, setOpen] = useState(false);
  /** Known-scope selection being edited; null = untouched (mirror config). */
  const [draft, setDraft] = useState<Set<string> | null>(null);

  // Callback lands back on this page with ?gws=… — surface the outcome once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ok = params.get("gws");
    const err = params.get("gwsError");
    if (!ok && !err) return;
    if (ok) toast.success("Google sign-in complete");
    if (err) toast.error(`Google sign-in failed: ${err}`);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const signIn = useMutation({
    mutationFn: () => endpoints.startGwsSignIn(agentId),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (e: Error) => toast.error(`sign-in failed: ${e.message}`),
  });

  const signOut = useMutation({
    mutationFn: () => endpoints.gwsSignOut(agentId),
    onSuccess: () => {
      toast.success("Signed out of Google");
      qc.invalidateQueries({ queryKey: ["gws-oauth"] });
      qc.invalidateQueries({ queryKey: ["plugins", agentId] });
    },
    onError: (e: Error) => toast.error(`sign-out failed: ${e.message}`),
  });

  const gwsConfig = (plugin.config ?? null) as { oauthScopes?: string } | null;
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

  const me = data?.agents.find((a) => a.agentId === agentId);

  const saveScopes = useMutation({
    mutationFn: () =>
      endpoints.putPluginConfig(agentId, "gws", {
        ...(gwsConfig ?? {}),
        oauthScopes: [...unknown, ...(draft ?? [])].join(", "),
      }),
    onSuccess: () => {
      toast.success(
        me?.signedIn ? "Scopes saved — sign in again to apply" : "Scopes saved",
      );
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["plugins", agentId] });
    },
    onError: (e: Error) => toast.error(`save failed: ${e.message}`),
  });

  if (!data || !me) return null;

  const clientConfigured =
    data.client.clientId.length > 0 && data.client.clientSecret.length > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Mail className="size-3.5 text-primary/60" />
        <h3 className="text-sm font-medium">Google account</h3>
        <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {me.signedIn
            ? me.email
              ? `Signed in as ${me.email}`
              : "Signed in"
            : "Not signed in"}
          {me.scopes.length > 0 && (
            <>
              {" · "}
              {me.scopes
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
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
          <ChevronRight
            className={`size-4 transition-transform ${open ? "rotate-90" : ""}`}
          />
          Scopes
        </Button>
        {me.signedIn ? (
          <Button
            size="sm"
            variant="outline"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            {signOut.isPending ? (
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
            onClick={() => signIn.mutate()}
            title={
              clientConfigured
                ? undefined
                : "Save the OAuth client id and secret in Settings first"
            }
          >
            {signIn.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogIn className="size-4" />
            )}
            Sign in with Google
          </Button>
        )}
      </div>
      {!clientConfigured && (
        <p className="text-[11px] text-muted-foreground">
          The shared Google OAuth client isn&rsquo;t configured yet —{" "}
          <Link to="/settings" className="text-primary hover:underline">
            save a client id and secret in Settings
          </Link>{" "}
          first.
        </p>
      )}

      {open && (
        <div className="flex flex-col gap-3 border-t pt-3">
          <p className="text-[11px] text-muted-foreground">
            Stored as <code>oauthScopes</code> in this plugin&rsquo;s config
            — changing scopes requires signing in again.{" "}
            <code>gmail.modify</code> is always requested: it is
            Google&rsquo;s read/write Gmail tier (read, drafts, send,
            labels, mark-read — everything except permanent deletion), and
            the narrower Gmail scopes are subsets of it that would break
            inbox polling on their own.
          </p>
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
                      disabled={s.always}
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
