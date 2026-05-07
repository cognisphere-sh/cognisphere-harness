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

export interface AgentSummary {
  id: string;
  name: string;
  installedPlugins: string[];
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
