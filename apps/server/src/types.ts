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
  notifications: { name: string; description: string }[];
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
}

/**
 * Static catalog entry for a model provider. Mirrors the API-key-based
 * providers from pi's `providers.md` doc — subscription-only providers
 * (Codex via ChatGPT, Copilot, Claude Pro/Max) and cloud providers that
 * need OAuth/AWS auth (Bedrock, Vertex) are out of scope for the v0
 * Models settings page; operators wire those up via env vars on the
 * server host instead.
 *
 * `envVar` is the env var pi expects for this provider's API key — set
 * by the runner on the spawned child when an agent uses this provider.
 * `models` is the curated default list shown in the UI; the operator
 * may enable any subset and append custom model IDs that aren't here.
 */
export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  envVar: string;
  models: string[];
}

/**
 * Per-provider configuration as written to `<harnessRoot>/models.json`.
 * `apiKey` is plaintext in v0 (HLD §15); empty string === unset.
 * `enabledModels` is the full set of model IDs the operator has
 * authorized — agents may only select from this list. May contain
 * model IDs not in the catalog (custom-added).
 */
export interface ProviderConfig {
  apiKey?: string;
  enabledModels: string[];
}

export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}
