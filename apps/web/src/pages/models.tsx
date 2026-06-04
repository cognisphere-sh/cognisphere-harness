import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  endpoints,
  type CredField,
  type ProviderInfo,
  type PutModelsBody,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

const CLEAR_SENTINEL = "__CLEAR__";

interface DraftState {
  /** Per-field: undefined = unchanged; CLEAR_SENTINEL = pending clear; non-empty string = pending new value. */
  credentials: Record<string, string | undefined>;
  enabledModels: Set<string>;
}

/**
 * Global Models settings — provider credentials + the model allowlist
 * agents may select. Backed by `<harnessRoot>/models.json`. Saving here
 * automatically reloads any running agent that uses a changed provider.
 */
export function ModelsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["models"],
    queryFn: endpoints.getModels,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b py-3 pl-14 pr-4 md:px-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link
            to="/settings"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ArrowLeft className="size-3" />
            Settings
          </Link>
          <span>·</span>
          <span>Models</span>
        </div>
        <h1 className="text-lg font-semibold">Models</h1>
        <p className="text-xs text-muted-foreground">
          Provider credentials and the model allowlist agents can choose
          from. Saving here automatically reloads any running agent that
          uses a changed provider — no server restart needed.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {isLoading || !data ? (
          <div className="text-sm text-muted-foreground">loading…</div>
        ) : (
          <div className="grid gap-4">
            <Card className="border-warning/40 bg-warning/5">
              <CardHeader>
                <CardTitle className="text-sm">Plaintext storage</CardTitle>
                <CardDescription className="mt-1">
                  Provider credentials are stored unencrypted at{" "}
                  <code>{data.path}</code>. v1 will encrypt at rest. OAuth
                  subscription tokens are stored separately in pi&apos;s own{" "}
                  <code>~/.pi/agent/auth.json</code>.
                </CardDescription>
              </CardHeader>
            </Card>
            {data.providers.map((p) => (
              <ProviderCard key={p.id} provider={p} mask={data.mask} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  mask,
}: {
  provider: ProviderInfo;
  mask: string;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<DraftState>({
    credentials: {},
    enabledModels: new Set(provider.enabledModels),
  });
  const [customDraft, setCustomDraft] = useState("");

  // Re-sync from server after save.
  useEffect(() => {
    setDraft({
      credentials: {},
      enabledModels: new Set(provider.enabledModels),
    });
    setCustomDraft("");
  }, [provider.enabledModels, provider.credentialValues]);

  const allModels = useMemo(() => {
    const set = new Set<string>(provider.catalogModels);
    for (const m of provider.enabledModels) set.add(m);
    return [...set];
  }, [provider.catalogModels, provider.enabledModels]);

  const initialEnabled = useMemo(
    () => new Set(provider.enabledModels),
    [provider.enabledModels],
  );

  const dirty = useMemo(() => {
    if (Object.keys(draft.credentials).length > 0) return true;
    if (draft.enabledModels.size !== initialEnabled.size) return true;
    for (const m of draft.enabledModels) {
      if (!initialEnabled.has(m)) return true;
    }
    return false;
  }, [draft, initialEnabled]);

  // Effective values after applying draft, used for the configured-after-save check.
  const requiredOk = useMemo(() => {
    // Subscription OAuth substitutes for required credential fields.
    if (provider.oauth?.connected) return true;
    for (const f of provider.credentials) {
      if (!f.required) continue;
      const drafted = draft.credentials[f.key];
      if (drafted === CLEAR_SENTINEL) return false;
      if (drafted !== undefined) {
        if (drafted.length === 0) return false;
        continue;
      }
      // unchanged → falls back to server value
      const current = provider.credentialValues[f.key] ?? "";
      if (current.length === 0) return false;
    }
    return true;
  }, [
    provider.credentials,
    provider.credentialValues,
    provider.oauth,
    draft.credentials,
  ]);

  const save = useMutation({
    mutationFn: (body: PutModelsBody) => endpoints.putModels(body),
    onSuccess: () => {
      toast.success("saved · agents using this provider reloaded");
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (e: Error) => toast.error(`save failed: ${e.message}`),
  });

  const setField = (key: string, value: string | undefined) => {
    setDraft((d) => {
      const next = { ...d.credentials };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return { ...d, credentials: next };
    });
  };

  const toggleModel = (m: string) => {
    setDraft((d) => {
      const next = new Set(d.enabledModels);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return { ...d, enabledModels: next };
    });
  };

  const addCustom = () => {
    const v = customDraft.trim();
    if (!v) return;
    setDraft((d) => {
      const next = new Set(d.enabledModels);
      next.add(v);
      return { ...d, enabledModels: next };
    });
    setCustomDraft("");
  };

  const removeCustom = (m: string) => {
    setDraft((d) => {
      const next = new Set(d.enabledModels);
      next.delete(m);
      return { ...d, enabledModels: next };
    });
  };

  const reset = () => {
    setDraft({
      credentials: {},
      enabledModels: new Set(provider.enabledModels),
    });
    setCustomDraft("");
  };

  const onSave = () => {
    const credentials: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(draft.credentials)) {
      if (v === undefined) continue;
      credentials[k] = v === CLEAR_SENTINEL ? null : v;
    }
    const payload: PutModelsBody["providers"][string] = {
      enabledModels: [...draft.enabledModels],
    };
    if (Object.keys(credentials).length > 0) {
      payload.credentials = credentials;
    }
    save.mutate({ providers: { [provider.id]: payload } });
  };

  const customExtras = [...draft.enabledModels].filter(
    (m) => !provider.catalogModels.includes(m),
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="size-4 text-primary/80" />
          <CardTitle>{provider.displayName}</CardTitle>
          <Badge variant="outline" className="font-mono">
            {provider.id}
          </Badge>
          {provider.configured ? (
            <Badge variant="secondary">configured</Badge>
          ) : (
            <Badge variant="outline">incomplete</Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={reset}
              disabled={!dirty || save.isPending}
            >
              <RotateCcw className="size-3.5" /> Reset
            </Button>
            <Button
              size="sm"
              onClick={onSave}
              disabled={!dirty || save.isPending}
            >
              {save.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Save
            </Button>
          </div>
        </div>
        {provider.notes && (
          <CardDescription className="mt-1 text-[11px]">
            {provider.notes}
          </CardDescription>
        )}
      </CardHeader>
      <Separator />
      <div className="grid gap-5 p-4">
        {provider.oauth?.supported && <OAuthSection provider={provider} />}

        {provider.credentials.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <KeyRound className="size-3.5 text-primary/60" />
              <h3 className="text-sm font-medium">Credentials</h3>
              {!requiredOk && (
                <span className="text-[11px] text-warning">
                  required field(s) missing
                </span>
              )}
            </div>
            <div className="grid gap-3">
              {provider.credentials.map((field) => (
                <CredentialField
                  key={field.key}
                  field={field}
                  serverValue={provider.credentialValues[field.key] ?? ""}
                  draftValue={draft.credentials[field.key]}
                  mask={mask}
                  onChange={(v) => setField(field.key, v)}
                />
              ))}
            </div>
          </div>
        )}

        <Separator />

        <div>
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="size-3.5 text-primary/60" />
            <h3 className="text-sm font-medium">Enabled models</h3>
            <span className="text-[11px] text-muted-foreground">
              only checked models can be selected by agents
            </span>
          </div>
          {allModels.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No catalog models — add a custom model id below.
            </p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {allModels.map((m) => {
                const checked = draft.enabledModels.has(m);
                const isCustom = !provider.catalogModels.includes(m);
                return (
                  <label
                    key={m}
                    className="flex cursor-pointer items-center gap-2 rounded-md border p-2 transition-colors hover:bg-accent/40"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleModel(m)}
                      className="size-4 accent-primary"
                    />
                    <span className="font-mono text-xs">{m}</span>
                    {isCustom && (
                      <Badge variant="outline" className="ml-auto text-[10px]">
                        custom
                      </Badge>
                    )}
                  </label>
                );
              })}
            </div>
          )}
          <div className="mt-3">
            <Label className="text-xs">Add custom model id</Label>
            <div className="mt-1 flex items-center gap-1">
              <Input
                value={customDraft}
                onChange={(e) => setCustomDraft(e.target.value)}
                placeholder="e.g. my-org/my-model"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={addCustom}
                aria-label="add"
              >
                <Plus className="size-4" />
              </Button>
            </div>
            {customExtras.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {customExtras.map((m) => (
                  <span
                    key={m}
                    className="inline-flex items-center gap-1 rounded-md border bg-secondary px-2 py-0.5 font-mono text-[11px]"
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() => removeCustom(m)}
                      aria-label={`remove ${m}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Subscription OAuth sign-in (e.g. Claude Pro/Max, ChatGPT Codex).
 * The server drives pi's login flow; tokens land in pi's own auth.json.
 * If the harness runs on the same machine as the browser, the localhost
 * OAuth callback completes the flow automatically — otherwise the
 * operator pastes the final redirect URL into the input below.
 */
function OAuthSection({ provider }: { provider: ProviderInfo }) {
  const qc = useQueryClient();
  const [active, setActive] = useState(false);
  const [pasteValue, setPasteValue] = useState("");

  const status = useQuery({
    queryKey: ["oauth-status", provider.id],
    queryFn: () => endpoints.getOauthStatus(provider.id),
    enabled: active,
    refetchInterval: (q) =>
      q.state.data?.state === "pending" ? 1000 : false,
  });
  const flow = status.data;

  // Terminal states: success refreshes the page data; error stays visible.
  useEffect(() => {
    if (!active || flow?.state !== "success") return;
    setActive(false);
    setPasteValue("");
    toast.success("signed in · agents using this provider reloaded");
    qc.invalidateQueries({ queryKey: ["models"] });
    qc.invalidateQueries({ queryKey: ["agents"] });
    qc.invalidateQueries({ queryKey: ["agent"] });
  }, [active, flow?.state, qc]);

  const start = useMutation({
    mutationFn: () => endpoints.startOauthLogin(provider.id),
    onSuccess: (data) => {
      setActive(true);
      if (data.url) window.open(data.url, "_blank", "noopener");
    },
    onError: (e: Error) => toast.error(`sign-in failed to start: ${e.message}`),
  });

  const submit = useMutation({
    mutationFn: () => endpoints.submitOauthInput(provider.id, pasteValue.trim()),
    onSuccess: () => setPasteValue(""),
    onError: (e: Error) => toast.error(`submit failed: ${e.message}`),
  });

  const cancel = useMutation({
    mutationFn: () => endpoints.cancelOauthLogin(provider.id),
    onSuccess: () => setActive(false),
  });

  const signOut = useMutation({
    mutationFn: () => endpoints.oauthLogout(provider.id),
    onSuccess: () => {
      toast.success("signed out · agents using this provider reloaded");
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (e: Error) => toast.error(`sign-out failed: ${e.message}`),
  });

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <LogIn className="size-3.5 text-primary/60" />
        <h3 className="text-sm font-medium">Subscription sign-in</h3>
        {provider.oauth?.connected && (
          <Badge variant="secondary">OAuth connected</Badge>
        )}
      </div>
      {provider.oauth?.connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[11px] text-muted-foreground">
            Tokens are stored in pi&apos;s <code>auth.json</code> and
            auto-refreshed. OAuth takes precedence over an API key.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            {signOut.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogOut className="size-3.5" />
            )}
            Sign out
          </Button>
        </div>
      ) : !active ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => start.mutate()}
          disabled={start.isPending}
        >
          {start.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <LogIn className="size-3.5" />
          )}
          Sign in with {provider.displayName}
        </Button>
      ) : (
        <div className="grid gap-2 rounded-md border bg-accent/20 p-3">
          {flow?.state === "error" ? (
            <p className="text-xs text-destructive">{flow.message}</p>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              waiting for sign-in to complete…
            </div>
          )}
          {flow?.instructions && (
            <p className="text-[11px] text-muted-foreground">
              {flow.instructions}
            </p>
          )}
          {flow?.url && (
            <a
              href={flow.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="size-3" />
              open sign-in page
            </a>
          )}
          {flow?.state === "pending" && (
            <div className="flex items-center gap-1">
              <Input
                value={pasteValue}
                onChange={(e) => setPasteValue(e.target.value)}
                placeholder="paste the redirect URL or authorization code"
                className="font-mono text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && pasteValue.trim()) {
                    e.preventDefault();
                    submit.mutate();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => submit.mutate()}
                disabled={!pasteValue.trim() || submit.isPending}
              >
                {submit.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  "Submit"
                )}
              </Button>
            </div>
          )}
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-[11px] text-muted-foreground"
              onClick={() =>
                flow?.state === "error" ? setActive(false) : cancel.mutate()
              }
            >
              {flow?.state === "error" ? "Dismiss" : "Cancel"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CredentialField({
  field,
  serverValue,
  draftValue,
  mask,
  onChange,
}: {
  field: CredField;
  serverValue: string;
  draftValue: string | undefined;
  mask: string;
  onChange: (v: string | undefined) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const isSet = serverValue.length > 0;
  const isCleared = draftValue === CLEAR_SENTINEL;
  const hasNew =
    draftValue !== undefined &&
    draftValue !== CLEAR_SENTINEL &&
    draftValue.length > 0;

  // Display value in the input.
  const inputValue =
    draftValue === undefined
      ? field.secret
        ? "" // never echo the masked value into the input — placeholder shows "(set)"
        : serverValue
      : draftValue === CLEAR_SENTINEL
        ? ""
        : draftValue;

  const placeholder = field.secret
    ? isSet
      ? mask
      : field.placeholder ?? "(not set)"
    : field.placeholder ?? "(not set)";

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <Label className="text-xs">
          {field.label}
          {field.required && <span className="ml-1 text-destructive">*</span>}
        </Label>
        <code className="text-[10px] text-muted-foreground">{field.envVar}</code>
        {hasNew && <span className="text-[10px] text-warning">● new value</span>}
        {isCleared && (
          <span className="text-[10px] text-destructive">● will clear</span>
        )}
      </div>
      <div className="flex items-start gap-1">
        {field.multiline ? (
          <Textarea
            value={inputValue}
            placeholder={placeholder}
            rows={6}
            className="font-mono text-xs"
            onChange={(e) =>
              onChange(e.target.value.length === 0 ? undefined : e.target.value)
            }
          />
        ) : (
          <Input
            type={field.secret && !reveal ? "password" : "text"}
            value={inputValue}
            placeholder={placeholder}
            className="font-mono text-xs"
            onChange={(e) =>
              onChange(e.target.value.length === 0 ? undefined : e.target.value)
            }
          />
        )}
        {field.secret && !field.multiline && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? "hide" : "reveal"}
          >
            {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        )}
        {isSet && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-[11px] text-destructive hover:text-destructive"
            onClick={() => onChange(CLEAR_SENTINEL)}
            disabled={isCleared}
          >
            Clear
          </Button>
        )}
      </div>
      {field.helpText && (
        <p className="mt-1 text-[11px] text-muted-foreground">{field.helpText}</p>
      )}
    </div>
  );
}
