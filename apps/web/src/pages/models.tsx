import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  endpoints,
  type ProviderInfo,
  type PutModelsBody,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

const CLEAR_SENTINEL = "__CLEAR__";

interface DraftKeys {
  /** undefined = unchanged; "" = pending clear; non-empty = pending new value. */
  apiKey?: string;
  enabledModels: Set<string>;
}

/**
 * Global Models settings — provider API keys + which models agents may
 * select. Backed by `<harnessRoot>/models.json`. Only models enabled
 * here appear in the per-agent provider/model dropdowns.
 */
export function ModelsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["models"],
    queryFn: endpoints.getModels,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b px-4 py-3 sm:px-6">
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
          API keys and the model allowlist that agents can choose from.
          Saving here automatically reloads any running agent that uses
          a changed provider — no server restart needed.
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
                  Provider API keys are stored unencrypted at{" "}
                  <code>{data.path}</code>. v1 will encrypt at rest.
                </CardDescription>
              </CardHeader>
            </Card>
            {data.providers.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                mask={data.mask}
              />
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
  const [draft, setDraft] = useState<DraftKeys>({
    enabledModels: new Set(provider.enabledModels),
  });
  const [reveal, setReveal] = useState(false);
  const [customDraft, setCustomDraft] = useState("");

  // Re-sync from server after save.
  useEffect(() => {
    setDraft({ enabledModels: new Set(provider.enabledModels) });
    setCustomDraft("");
  }, [provider.enabledModels, provider.apiKeyConfigured]);

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
    if (draft.apiKey !== undefined) return true;
    if (draft.enabledModels.size !== initialEnabled.size) return true;
    for (const m of draft.enabledModels) {
      if (!initialEnabled.has(m)) return true;
    }
    return false;
  }, [draft, initialEnabled]);

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
    setDraft({ enabledModels: new Set(provider.enabledModels) });
    setCustomDraft("");
  };

  const onSave = () => {
    const payload: PutModelsBody["providers"][string] = {
      enabledModels: [...draft.enabledModels],
    };
    if (draft.apiKey !== undefined) {
      payload.apiKey = draft.apiKey === CLEAR_SENTINEL ? null : draft.apiKey;
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
          {provider.apiKeyConfigured ? (
            <Badge variant="secondary">key set</Badge>
          ) : (
            <Badge variant="outline">no key</Badge>
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
        <CardDescription className="mt-1 font-mono text-[11px]">
          env: {provider.envVar}
        </CardDescription>
      </CardHeader>
      <Separator />
      <div className="grid gap-5 p-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <KeyRound className="size-3.5 text-primary/60" />
            <h3 className="text-sm font-medium">API key</h3>
          </div>
          <div className="flex items-center gap-1">
            <Input
              type={reveal ? "text" : "password"}
              placeholder={
                provider.apiKeyConfigured ? mask : "(not set)"
              }
              value={
                draft.apiKey === CLEAR_SENTINEL ? "" : (draft.apiKey ?? "")
              }
              onChange={(e) =>
                setDraft((d) => ({ ...d, apiKey: e.target.value }))
              }
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? "hide" : "reveal"}
            >
              {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
            {provider.apiKeyConfigured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-[11px] text-destructive hover:text-destructive"
                onClick={() =>
                  setDraft((d) => ({ ...d, apiKey: CLEAR_SENTINEL }))
                }
                disabled={draft.apiKey === CLEAR_SENTINEL}
              >
                Clear
              </Button>
            )}
          </div>
          {draft.apiKey !== undefined && draft.apiKey !== CLEAR_SENTINEL && (
            <span className="text-[10px] text-warning">● new value</span>
          )}
          {draft.apiKey === CLEAR_SENTINEL && (
            <span className="text-[10px] text-destructive">● will be cleared</span>
          )}
        </div>

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
