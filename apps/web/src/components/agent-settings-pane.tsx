import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ChevronDown,
  Eye,
  EyeOff,
  FileJson,
  Loader2,
  Plug,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  endpoints,
  type ModelsView,
  type PluginSummary,
  type ProviderInfo,
  type PutSecretsBody,
  type SecretsView,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SchemaForm, type JsonSchema } from "@/components/schema-form";

const CLEAR_SENTINEL = "__CLEAR__";

/**
 * Built-in schema for `agent.json`. The server doesn't declare a config
 * schema for agents (only for plugins), so this lives client-side and
 * drives the per-agent Configuration form. Unknown fields in agent.json
 * (e.g. `secretsSchema`) are preserved through save because the draft is a
 * deep clone of the original — the form only mutates fields it renders.
 */
const AGENT_CONFIG_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Display name shown in the UI.",
    },
    model: {
      type: "object",
      description: "Model selection passed to pi --provider/--model/--thinking.",
      properties: {
        provider: {
          type: "string",
          description: "Provider id (e.g. anthropic, openai, google, openrouter).",
        },
        id: {
          type: "string",
          description: "Model id (e.g. claude-sonnet-4-5).",
        },
        thinkingLevel: {
          type: "string",
          enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
          description: "Reasoning depth (provider permitting).",
        },
      },
    },
    threadIdStrategy: {
      type: "object",
      description: "How threads are derived from incoming notifications.",
      properties: {
        type: {
          type: "string",
          enum: ["single", "plugin", "plugin_channel"],
        },
      },
    },
    maxConcurrentSlots: {
      type: "integer",
      minimum: 1,
      description: "Parallel batches the runner may execute for this agent.",
    },
    maxAttempts: {
      type: "integer",
      minimum: 1,
      description: "Retries before a message moves to the dead-letter queue.",
    },
    runtime: {
      type: "string",
      enum: ["subprocess"],
      description: "Execution runtime (only `subprocess` in v0).",
    },
    config: {
      type: "object",
      description:
        "Non-secret env vars exposed to the pi runtime (e.g. ELEVENLABS_VOICE_ID). Free-form { string: string } map.",
      additionalProperties: { type: "string" },
    },
  },
};

interface Props {
  agentId: string;
}

/**
 * Per-agent settings pane: edit agent.json, agent-level secrets, and for
 * each installed plugin its config.json and plugin-level secrets. Each
 * block has its own dirty state + Save button since they hit independent
 * endpoints; the user saves piecemeal.
 */
export function AgentSettingsPane({ agentId }: Props) {
  const { data: agent } = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => endpoints.getAgent(agentId),
  });
  const { data: pluginsData } = useQuery({
    queryKey: ["plugins", agentId],
    queryFn: () => endpoints.listPlugins(agentId),
  });
  const { data: secrets } = useQuery({
    queryKey: ["secrets"],
    queryFn: endpoints.getSecrets,
  });

  if (!agent || !pluginsData || !secrets) {
    return <div className="p-6 text-sm text-muted-foreground">loading…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2 sm:px-6">
        <p className="text-xs text-muted-foreground">
          Settings · saves auto-reload the agent if it's running
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <SecurityNote />
        <div className="grid gap-6">
          <AgentCard
            agentId={agentId}
            agentJson={agent.agentJson}
            secrets={secrets}
          />
          {pluginsData.plugins.map((p) => (
            <PluginCard
              key={p.pluginId}
              agentId={agentId}
              plugin={p}
              secrets={secrets}
            />
          ))}
          {pluginsData.plugins.length === 0 && (
            <p className="text-sm text-muted-foreground">No plugins installed.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SecurityNote() {
  return (
    <Card className="mb-6 border-warning/40 bg-warning/5">
      <CardHeader className="flex-row items-start gap-3">
        <ShieldAlert className="mt-0.5 size-4 text-warning" />
        <div>
          <CardTitle className="text-sm">Plaintext storage</CardTitle>
          <CardDescription className="mt-1">
            Secrets are stored unencrypted in <code>secrets.json</code>;
            agent + plugin configuration is plain JSON on disk. v1 will
            encrypt secrets at rest.
          </CardDescription>
        </div>
      </CardHeader>
    </Card>
  );
}

// ── Agent card ───────────────────────────────────────────────────────

function AgentCard({
  agentId,
  agentJson,
  secrets,
}: {
  agentId: string;
  agentJson: unknown;
  secrets: SecretsView;
}) {
  const qc = useQueryClient();
  const { data: models } = useQuery({
    queryKey: ["models"],
    queryFn: endpoints.getModels,
  });
  const save = useMutation({
    mutationFn: (config: unknown) => endpoints.putAgentConfig(agentId, config),
    onSuccess: () => {
      toast.success("saved · agent reloaded");
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
    },
    onError: (e: Error) => toast.error(`save failed: ${e.message}`),
  });

  const agentSchema = (secrets.schemas?.[agentId]?.[secrets.agentBucket] ??
    null) as JsonSchema | null;
  const agentBucketValues =
    secrets.secrets?.[agentId]?.[secrets.agentBucket] ?? {};

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-primary/80" />
          <CardTitle>Agent</CardTitle>
          <Badge variant="outline" className="font-mono">
            {agentId}
          </Badge>
        </div>
      </CardHeader>
      <Separator />
      <div className="grid gap-5 p-4">
        <AgentConfigBlock
          initial={agentJson}
          models={models ?? null}
          onSave={(v) => save.mutate(v)}
          saving={save.isPending}
        />
        {agentSchema?.properties &&
          Object.keys(agentSchema.properties).length > 0 && (
            <>
              <Separator />
              <SecretsBlock
                agentId={agentId}
                bucketId={secrets.agentBucket}
                heading="Secrets"
                icon={<Bot className="size-3.5 text-primary/70" />}
                schema={agentSchema}
                existing={agentBucketValues}
                mask={secrets.mask}
              />
            </>
          )}
      </div>
    </Card>
  );
}

// ── Plugin card ───────────────────────────────────────────────────────

function PluginCard({
  agentId,
  plugin,
  secrets,
}: {
  agentId: string;
  plugin: PluginSummary;
  secrets: SecretsView;
}) {
  const qc = useQueryClient();
  const saveConfig = useMutation({
    mutationFn: (config: unknown) =>
      endpoints.putPluginConfig(agentId, plugin.pluginId, config),
    onSuccess: () => {
      toast.success("saved · agent reloaded");
      qc.invalidateQueries({ queryKey: ["plugins", agentId] });
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
    },
    onError: (e: Error) => toast.error(`save failed: ${e.message}`),
  });

  const pluginSchema = (secrets.schemas?.[agentId]?.[plugin.pluginId] ??
    null) as JsonSchema | null;
  const pluginBucketValues =
    secrets.secrets?.[agentId]?.[plugin.pluginId] ?? {};
  const configSchema =
    (plugin.manifest?.configSchema as JsonSchema | undefined) ?? {
      type: "object",
      properties: {},
    };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Plug className="size-4 text-primary/80" />
          <CardTitle>
            {plugin.manifest?.displayName || plugin.pluginId}
          </CardTitle>
          <Badge variant="outline" className="font-mono">
            {plugin.pluginId}
          </Badge>
          {plugin.state !== "running" && (
            <Badge
              variant={plugin.state === "failed" ? "destructive" : "secondary"}
            >
              {plugin.state}
            </Badge>
          )}
          {!plugin.manifest && (
            <Badge variant="destructive">unknown plugin</Badge>
          )}
        </div>
        {plugin.manifest?.description && (
          <CardDescription className="mt-1">
            {plugin.manifest.description}
          </CardDescription>
        )}
      </CardHeader>
      <Separator />
      <div className="grid gap-5 p-4">
        <ConfigBlock
          subtitle={`plugins/${plugin.pluginId}/config.json`}
          schema={configSchema}
          initial={plugin.config}
          onSave={(v) => saveConfig.mutate(v)}
          saving={saveConfig.isPending}
        />

        {pluginSchema?.properties &&
          Object.keys(pluginSchema.properties).length > 0 && (
            <>
              <Separator />
              <SecretsBlock
                agentId={agentId}
                bucketId={plugin.pluginId}
                heading="Secrets"
                icon={<Plug className="size-3.5 text-primary/70" />}
                schema={pluginSchema}
                existing={pluginBucketValues}
                mask={secrets.mask}
              />
            </>
          )}
      </div>
    </Card>
  );
}

// ── Agent config block (model picker + schema-driven form) ───────────

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

interface AgentModel {
  provider?: string;
  id?: string;
  thinkingLevel?: string;
}

/**
 * Schema for the non-`model` portion of agent.json. The `model` block is
 * rendered separately by `<ModelPicker>` so provider/model can be live
 * dropdowns sourced from `/api/models`. Everything `model.*` round-trips
 * untouched on save because the draft is a deep clone — we only mutate
 * the keys our two sub-forms own.
 */
const AGENT_REST_SCHEMA: JsonSchema = {
  type: "object",
  properties: Object.fromEntries(
    Object.entries(AGENT_CONFIG_SCHEMA.properties ?? {}).filter(
      ([k]) => k !== "model",
    ),
  ),
};

function AgentConfigBlock({
  initial,
  models,
  onSave,
  saving,
}: {
  initial: unknown;
  models: ModelsView | null;
  onSave: (next: unknown) => void;
  saving: boolean;
}) {
  const initialClone = useMemo(() => deepClone(initial ?? {}), [initial]);
  const [draft, setDraft] = useState<Record<string, unknown>>(
    () => initialClone as Record<string, unknown>,
  );

  useEffect(() => {
    setDraft(deepClone(initial ?? {}) as Record<string, unknown>);
  }, [initial]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initialClone),
    [draft, initialClone],
  );

  const model = (draft.model ?? {}) as AgentModel;
  const setModel = (next: AgentModel) =>
    setDraft((d) => ({ ...d, model: { ...(d.model as object), ...next } }));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <FileJson className="size-3.5 text-primary/60" />
        <h3 className="text-sm font-medium">Configuration</h3>
        <code className="text-[11px] text-muted-foreground">agent.json</code>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft(deepClone(initial ?? {}) as Record<string, unknown>)
            }
            disabled={!dirty || saving}
          >
            <RotateCcw className="size-3.5" /> Reset
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => onSave(draft)}
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
        </div>
      </div>
      <div className="grid gap-4">
        <ModelPicker models={models} value={model} onChange={setModel} />
        <SchemaForm
          schema={AGENT_REST_SCHEMA}
          value={draft}
          onChange={(v) => setDraft(v as Record<string, unknown>)}
        />
      </div>
    </div>
  );
}

function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelsView | null;
  value: AgentModel;
  onChange: (next: AgentModel) => void;
}) {
  // Providers offered in the dropdown: those that are fully configured
  // (all required credentials set) and have at least one enabled model.
  // The currently-selected provider is always included even if it
  // doesn't qualify, so the operator can see what they have and fix it.
  const eligible = useMemo(
    () =>
      (models?.providers ?? []).filter(
        (p) => p.configured && p.enabledModels.length > 0,
      ),
    [models],
  );
  const providerById = useMemo(() => {
    const m = new Map<string, ProviderInfo>();
    for (const p of models?.providers ?? []) m.set(p.id, p);
    return m;
  }, [models]);

  const selected = value.provider ? providerById.get(value.provider) : undefined;
  const selectedEnabled = !!(
    selected &&
    selected.configured &&
    selected.enabledModels.length > 0
  );
  const providerOptions = [...eligible];
  if (value.provider && !providerOptions.find((p) => p.id === value.provider)) {
    // Surface the unconfigured choice so it's visible/fixable.
    if (selected) providerOptions.unshift(selected);
  }

  const modelOptions = selected ? selected.enabledModels : [];
  const modelMissing =
    !!value.id && !!selected && !modelOptions.includes(value.id);

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Bot className="size-3.5 text-primary/60" />
        <h4 className="text-sm font-medium">Model</h4>
        <span className="text-[11px] text-muted-foreground">
          --provider / --model / --thinking
        </span>
        <Link
          to="/settings/models"
          className="ml-auto text-[11px] text-primary hover:underline"
        >
          Manage providers →
        </Link>
      </div>
      {!models ? (
        <p className="text-xs text-muted-foreground">loading providers…</p>
      ) : eligible.length === 0 && !value.provider ? (
        <p className="text-xs text-muted-foreground">
          No providers configured yet.{" "}
          <Link to="/settings/models" className="text-primary hover:underline">
            Add an API key and enable models
          </Link>{" "}
          to choose one here.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label className="font-mono text-xs">provider</Label>
            <PickerSelect
              options={providerOptions.map((p) => ({
                value: p.id,
                label: p.displayName,
                hint:
                  p.configured && p.enabledModels.length > 0
                    ? p.id
                    : `${p.id} · not configured`,
              }))}
              value={value.provider ?? ""}
              placeholder="— select provider —"
              onChange={(v) =>
                onChange({ provider: v || undefined, id: undefined })
              }
            />
            {value.provider && !selectedEnabled && (
              <span className="text-[10px] text-warning">
                ● provider has no key or no enabled models
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label className="font-mono text-xs">model id</Label>
            {!selected ? (
              <p className="text-[11px] text-muted-foreground">
                pick a provider first
              </p>
            ) : modelOptions.length === 0 ? (
              <p className="text-[11px] text-warning">
                no models enabled for this provider —{" "}
                <Link
                  to="/settings/models"
                  className="text-primary hover:underline"
                >
                  enable some
                </Link>
              </p>
            ) : (
              <PickerSelect
                options={[
                  ...(modelMissing && value.id
                    ? [
                        {
                          value: value.id,
                          label: `${value.id} (not enabled)`,
                          hint: "no longer in allowlist",
                        },
                      ]
                    : []),
                  ...modelOptions.map((m) => ({ value: m, label: m })),
                ]}
                value={value.id ?? ""}
                placeholder="— select model —"
                onChange={(v) => onChange({ id: v || undefined })}
              />
            )}
            {modelMissing && (
              <span className="text-[10px] text-warning">
                ● this model is no longer enabled in Models settings
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-3">
            <Label className="font-mono text-xs">thinkingLevel</Label>
            <PickerSelect
              options={THINKING_LEVELS.map((l) => ({ value: l, label: l }))}
              value={value.thinkingLevel ?? ""}
              placeholder="— default —"
              onChange={(v) => onChange({ thinkingLevel: v || undefined })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function PickerSelect({
  options,
  value,
  placeholder,
  onChange,
}: {
  options: { value: string; label: string; hint?: string }[];
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-8 font-mono text-xs shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        )}
      >
        <option value="">{placeholder}</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
            {opt.hint ? ` — ${opt.hint}` : ""}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

// ── Config block (schema-driven form) ────────────────────────────────

function ConfigBlock({
  subtitle,
  schema,
  initial,
  onSave,
  saving,
}: {
  subtitle: string;
  schema: JsonSchema;
  initial: unknown;
  onSave: (next: unknown) => void;
  saving: boolean;
}) {
  // Draft is a deep clone of the original so the form may freely mutate
  // without affecting the upstream value, and unknown fields (those not in
  // `schema.properties`) round-trip untouched on save.
  const initialClone = useMemo(() => deepClone(initial ?? {}), [initial]);
  const [draft, setDraft] = useState<unknown>(initialClone);

  // Re-sync when upstream changes (e.g. after save invalidation).
  useEffect(() => {
    setDraft(deepClone(initial ?? {}));
  }, [initial]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initialClone),
    [draft, initialClone],
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <FileJson className="size-3.5 text-primary/60" />
        <h3 className="text-sm font-medium">Configuration</h3>
        <code className="text-[11px] text-muted-foreground">{subtitle}</code>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft(deepClone(initial ?? {}))}
            disabled={!dirty || saving}
          >
            <RotateCcw className="size-3.5" /> Reset
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => onSave(draft)}
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
        </div>
      </div>
      <SchemaForm schema={schema} value={draft} onChange={setDraft} />
    </div>
  );
}

// ── Secrets block (schema-driven, password rows) ─────────────────────

function SecretsBlock({
  agentId,
  bucketId,
  heading,
  icon,
  schema,
  existing,
  mask,
}: {
  agentId: string;
  bucketId: string;
  heading: string;
  icon: React.ReactNode;
  schema: JsonSchema;
  existing: Record<string, string>;
  mask: string;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  const save = useMutation({
    mutationFn: (body: PutSecretsBody) => endpoints.putSecrets(body),
    onSuccess: () => {
      toast.success("saved · agent reloaded");
      setDraft({});
      qc.invalidateQueries({ queryKey: ["secrets"] });
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
      qc.invalidateQueries({ queryKey: ["plugins", agentId] });
    },
    onError: (e: Error) => toast.error(`save failed: ${e.message}`),
  });

  const dirty = Object.keys(draft).length > 0;
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const keys = Object.keys(props);

  const onChange = (k: string, v: string) =>
    setDraft((p) => ({ ...p, [k]: v }));
  const onClear = (k: string) =>
    setDraft((p) => ({ ...p, [k]: CLEAR_SENTINEL }));

  const onSave = () => {
    const bucket: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(draft)) {
      bucket[k] = v === CLEAR_SENTINEL ? null : v;
    }
    save.mutate({ secrets: { [agentId]: { [bucketId]: bucket } } });
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="size-3.5 text-primary/60" />
        {icon}
        <h3 className="text-sm font-medium">{heading}</h3>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft({})}
            disabled={!dirty || save.isPending}
          >
            <RotateCcw className="size-3.5" /> Reset
          </Button>
          <Button size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
        </div>
      </div>
      {keys.length === 0 ? (
        <Badge variant="outline">no secrets declared</Badge>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {keys.map((k) => (
            <SecretRow
              key={k}
              keyName={k}
              schema={props[k]!}
              present={!!existing[k]}
              draftVal={draft[k]}
              mask={mask}
              revealed={!!reveal[`${agentId}/${bucketId}/${k}`]}
              onToggleReveal={() =>
                setReveal((r) => ({
                  ...r,
                  [`${agentId}/${bucketId}/${k}`]:
                    !r[`${agentId}/${bucketId}/${k}`],
                }))
              }
              onChange={(v) => onChange(k, v)}
              onClear={() => onClear(k)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SecretRow({
  keyName,
  schema,
  present,
  draftVal,
  mask,
  revealed,
  onToggleReveal,
  onChange,
  onClear,
}: {
  keyName: string;
  schema: JsonSchema;
  present: boolean;
  draftVal: string | undefined;
  mask: string;
  revealed: boolean;
  onToggleReveal: () => void;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  const placeholder = present ? mask : "(not set)";
  const isCleared = draftVal === CLEAR_SENTINEL;
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="font-mono text-xs">{keyName}</Label>
      {schema.description && (
        <span className="text-[11px] text-muted-foreground">
          {schema.description}
        </span>
      )}
      <div className="flex items-center gap-1">
        <Input
          type={revealed ? "text" : "password"}
          placeholder={placeholder}
          value={isCleared ? "" : (draftVal ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onToggleReveal}
          aria-label={revealed ? "hide" : "reveal"}
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
        {present && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-[11px] text-destructive hover:text-destructive"
            onClick={onClear}
            disabled={isCleared}
          >
            Clear
          </Button>
        )}
      </div>
      {draftVal && draftVal !== CLEAR_SENTINEL && (
        <span className="text-[10px] text-warning">● new value</span>
      )}
      {isCleared && (
        <span className="text-[10px] text-destructive">● will be cleared</span>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
