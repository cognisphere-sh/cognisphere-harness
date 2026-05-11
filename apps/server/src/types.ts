import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "./logger.js";

export type ThreadIdStrategy =
  | { type: "single" }
  | { type: "plugin" }
  | { type: "plugin_channel" };

export type RuntimeKind = "subprocess";

export interface AgentJson {
  name: string;
  model: {
    provider: string;
    id: string;
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  };
  threadIdStrategy: ThreadIdStrategy;
  maxConcurrentSlots?: number;
  maxAttempts?: number;
  runtime?: RuntimeKind;
  /**
   * Optional JSON-Schema describing agent-level secrets (env vars exposed
   * to the pi runtime that aren't owned by any single plugin — e.g. an
   * agent-wide TTS API key consumed directly by user scripts). Same v0
   * contract as plugin secrets: every key in `properties` is treated as
   * required, regardless of `required`.
   */
  secretsSchema?: JsonSchema;
  /**
   * Optional JSON-Schema describing the shape of `config`. Mirrors plugin
   * `configSchema` from `PluginManifest` and the agent's own
   * `secretsSchema`: drives ajv validation + `useDefaults` at start, and
   * the settings UI renders typed inputs (named fields, descriptions,
   * enums, defaults) instead of a free-form JSON map. Per-property
   * `type` should be `"string"` (with optional `enum`) — env values are
   * always strings at the runtime boundary.
   *
   * Required when `config` is set. Validation failure (or the schema
   * being missing while `config` has keys) fails the agent start.
   */
  configSchema?: JsonSchema;
  /**
   * Non-secret agent-level env vars exposed to the pi runtime. Use this
   * for values that aren't sensitive (model ids, voice ids, feature
   * toggles) so they don't end up in `secrets.json`. Keys are flattened
   * into the pi child's env on every spawn alongside agent secrets and
   * provider env; collisions across these three sources throw at start.
   * Validated against `configSchema` when present.
   */
  config?: Record<string, string>;
}

/** All 7 built-in pi tools, fixed for every harness agent. */
export const AGENT_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export interface NotifyPayload {
  text: string;
  channelId: string;
  metadata?: Record<string, unknown>;
  threadIdOverride?: string;
  doNotSteer?: boolean;
  isSilent?: boolean;
  priority?: number;
}

/**
 * Minimal JSON Schema shape for plugin manifests. Captures the fields the
 * runtime actually touches (`required`, `properties`, `default`, `type`,
 * `additionalProperties`) with real types; the `[key: string]: unknown`
 * index signature lets plugin authors use any other JSON Schema keyword
 * (`enum`, `minimum`, `pattern`, ...) without TypeScript complaints. Stays
 * structurally compatible with ajv's `Schema` type at validation time.
 */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
  description?: string;
  [key: string]: unknown;
}

export interface PluginManifest {
  displayName: string;
  description?: string;
  configSchema: JsonSchema;
  secretsSchema: JsonSchema;
}

export interface PluginInstanceContext {
  agentId: string;
  agentDir: string;
  stateDir: string;
  inboxDir: string;
  config: unknown;
  secrets: Record<string, string>;
  /** Harness-wide IANA timezone (from `<harnessRoot>/harness.json`).
   *  Plugins that schedule or render times should use this rather than
   *  declaring their own `timezone` config field. */
  timezone: string;
  notify(name: string, payload: NotifyPayload): void;
  httpBaseUrl?: string;
  log: Logger;
}

export interface Plugin {
  manifest: PluginManifest;
  start(ctx: PluginInstanceContext): Promise<void>;
  stop(): Promise<void>;
  handleHttpRequest?(
    req: IncomingMessage,
    res: ServerResponse,
  ): void | Promise<void>;
}

export type AgentState = "running" | "stopped" | "failed";
export type PluginState = "running" | "stopped" | "failed";

export interface AgentSummary {
  id: string;
  name: string;
  installedPlugins: string[];
  state: AgentState;
  error: string | null;
  runningPlugins: string[];
  failedPlugins: string[];
}

export interface QueuedRow {
  id: number;
  enqueued_at: number;
  plugin_id: string;
  channel_id: string;
  thread_id: string;
  text: string;
  metadata: string | null;
  priority: number;
  is_silent: number;
  in_flight: number;
  attempts: number;
}

export interface BatchMessage {
  id: number;
  enqueuedAt: number;
  pluginId: string;
  channelId: string;
  threadId: string;
  text: string;
  metadata: Record<string, unknown> | null;
  isSilent: boolean;
  /** 0 on first delivery; >0 means this row was previously dequeued and
   *  failed (or the runner crashed mid-batch), so the agent may have
   *  taken partial actions on the prior attempt. */
  attempts: number;
}

/**
 * One credential field a provider needs. Renders to a single form input
 * in the Models settings page; on agent start each populated field is
 * injected as `env[envVar]` on the spawned pi child. Cloud providers
 * (Bedrock, Vertex, Azure, Cloudflare) declare multiple fields here;
 * plain API-key providers declare exactly one.
 *
 * `key` is the storage/form key. `secret: true` masks the value in API
 * responses and uses a password-style input. `required: true` makes
 * `resolveAndValidateProvider()` refuse to start the agent if the field
 * is empty. `multiline: true` is for paste-blobs like Vertex's service
 * account JSON (rendered as a textarea); the field is still injected
 * via env, except Vertex's service-account-file path which the runtime
 * materializes to disk — see `agent-manager.ts:resolveAndValidateProvider`.
 */
export interface CredField {
  key: string;
  envVar: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  multiline?: boolean;
}

/**
 * Static catalog entry for a model provider. Mirrors pi-coding-agent's
 * provider surface (`packages/coding-agent/docs/providers.md`). OAuth
 * subscription providers (Claude Pro/Max, ChatGPT Codex, GitHub Copilot)
 * are out of scope for v0.
 *
 * `credentials` is 1+ fields the operator must supply. `models` is the
 * curated default list shown in the UI; operators may enable any subset
 * and append custom model IDs not in this list. `notes` shows under
 * the card for provider-specific guidance (e.g. Bedrock alt auth modes).
 */
export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  credentials: CredField[];
  models: string[];
  notes?: string;
}

/**
 * Per-provider configuration as written to `<harnessRoot>/models.json`.
 * `credentials` keys mirror the catalog entry's `CredField.key`s.
 * Plaintext on disk in v0 (HLD §15); empty/missing values === unset.
 * `enabledModels` is the operator-curated allowlist — agents may only
 * select from this list. May contain model IDs not in the catalog.
 */
export interface ProviderConfig {
  credentials: Record<string, string>;
  enabledModels: string[];
}

export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}
