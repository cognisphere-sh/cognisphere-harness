/**
 * Thin fetch wrapper around the harness API.
 *
 * - Always sends cookies (auth session).
 * - 401 → calls `onUnauthenticated` once so the app can redirect to /login.
 * - Throws ApiError(message, status, body) on non-2xx for callers to render.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: (() => void) | null): void {
  onUnauthenticated = fn;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const url = withQuery(path, opts.query);
  const init: RequestInit = {
    method: opts.method ?? "GET",
    credentials: "same-origin",
    signal: opts.signal,
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  };
  const res = await fetch(url, init);
  if (res.status === 401 && onUnauthenticated) onUnauthenticated();
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") && text ? safeParse(text) : text;
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && "error" in body && (body as { error: string }).error) ||
      res.statusText ||
      `HTTP ${res.status}`;
    throw new ApiError(String(msg), res.status, body);
  }
  return body as T;
}

function withQuery(
  path: string,
  q?: Record<string, string | number | undefined>,
): string {
  if (!q) return path;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `${path}?${s}` : path;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export const api = {
  get: <T>(p: string, q?: ApiOptions["query"], signal?: AbortSignal) =>
    request<T>(p, { query: q, signal }),
  post: <T>(p: string, body?: unknown, q?: ApiOptions["query"]) =>
    request<T>(p, { method: "POST", body, query: q }),
  put: <T>(p: string, body?: unknown, q?: ApiOptions["query"]) =>
    request<T>(p, { method: "PUT", body, query: q }),
  delete: <T>(p: string, q?: ApiOptions["query"]) =>
    request<T>(p, { method: "DELETE", query: q }),
  upload: async <T>(path: string, file: File, query?: ApiOptions["query"]): Promise<T> => {
    const fd = new FormData();
    fd.append("file", file);
    const url = withQuery(path, query);
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      body: fd,
    });
    if (res.status === 401 && onUnauthenticated) onUnauthenticated();
    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    const body = ct.includes("application/json") && text ? safeParse(text) : text;
    if (!res.ok) {
      throw new ApiError(`upload failed: ${res.status}`, res.status, body);
    }
    return body as T;
  },
};

// ── typed endpoint wrappers ───────────────────────────────────

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

export interface AgentDetail {
  id: string;
  name: string;
  agentJson: {
    name: string;
    model: { provider: string; id: string; thinkingLevel?: string };
    threadIdStrategy: { type: string };
    maxConcurrentSlots?: number;
    maxAttempts?: number;
    runtime?: string;
  } | null;
  installedPlugins: string[];
  state: AgentState;
  error: string | null;
  changedAt: number;
}

export interface PluginManifest {
  displayName: string;
  description?: string;
  notifications: { name: string; description: string }[];
  configSchema: unknown;
  secretsSchema: unknown;
}

export interface PluginSummary {
  pluginId: string;
  manifest: PluginManifest | null;
  config: unknown;
  notifications: { enabled: string[] };
  state: PluginState;
  error: string | null;
  changedAt: number;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  modified: number;
}

export interface SessionRow {
  sessionId: string;
  modified: number;
  size: number;
}
export interface ThreadRow {
  threadId: string;
  sessions: SessionRow[];
}

export interface PendingMessage {
  id: number;
  enqueuedAt: number;
  pluginId: string;
  channelId: string;
  threadId: string;
  text: string;
  priority: number;
  isSilent: boolean;
  inFlight: boolean;
  attempts: number;
}

export interface DLQMessage {
  id: number;
  enqueuedAt: number;
  pluginId: string;
  channelId: string;
  threadId: string;
  text: string;
  priority: number;
  attempts: number;
  lastError: string | null;
  deadAt: number;
}

export interface EventRow {
  id: number;
  ts: number;
  event: string;
  agent_id: string;
  plugin_id: string | null;
  notification: string | null;
  channel_id: string | null;
  thread_id: string | null;
  batch_id: string | null;
  status: string;
  message_queue_id: number | null;
  session_file: string | null;
  message_index: number | null;
  log: string | null;
  error: string | null;
}

/**
 * Uniform wire shape: under each agent, every entry is a bucket.
 * `agentBucket` (e.g. `"agent"`) is the reserved bucket id holding
 * agent-level secrets; other ids are plugin ids.
 */
export type SecretsBucket = Record<string, string>;
export type AgentBuckets = Record<string, SecretsBucket>;

export interface SecretsView {
  secrets: Record<string, AgentBuckets>;
  schemas: Record<string, Record<string, unknown>>;
  agentBucket: string;
  mask: string;
  path: string;
}

export type PutSecretsBucket = Record<string, string | null>;
export interface PutSecretsBody {
  secrets: Record<string, Record<string, PutSecretsBucket>>;
}

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

export interface ProviderInfo {
  id: string;
  displayName: string;
  credentials: CredField[];
  /** Per-field current value: secrets shown as MASK if set / "" if unset; non-secrets shown plain. */
  credentialValues: Record<string, string>;
  /** All required fields populated. */
  configured: boolean;
  catalogModels: string[];
  enabledModels: string[];
  notes?: string;
}

export interface ModelsView {
  providers: ProviderInfo[];
  path: string;
  mask: string;
}

export interface PutModelsProvider {
  /** null = delete field; MASK string = leave unchanged; "" or absent = no change; any other string = set. */
  credentials?: Record<string, string | null>;
  enabledModels?: string[];
}
export interface PutModelsBody {
  providers: Record<string, PutModelsProvider>;
}

export const endpoints = {
  me: () => api.get<{ user: string | null }>("/api/auth/me"),
  login: (username: string, password: string) =>
    api.post<{ ok: true; username: string }>("/api/auth/login", { username, password }),
  logout: () => api.post<{ ok: true }>("/api/auth/logout"),

  listAgents: () => api.get<{ agents: AgentSummary[] }>("/api/agents"),
  getAgent: (id: string) => api.get<AgentDetail>(`/api/agents/${id}`),
  listPlugins: (id: string) =>
    api.get<{ plugins: PluginSummary[] }>(`/api/agents/${id}/plugins`),
  startAgent: (id: string) =>
    api.post<{ ok: true; state: AgentState; error: string | null }>(
      `/api/agents/${id}/start`,
    ),
  stopAgent: (id: string) =>
    api.post<{ ok: true; state: AgentState; error: string | null }>(
      `/api/agents/${id}/stop`,
    ),
  restartAgent: (id: string) =>
    api.post<{ ok: true; state: AgentState; error: string | null }>(
      `/api/agents/${id}/restart`,
    ),

  listTree: (id: string, path: string) =>
    api.get<{ path: string; entries: FsEntry[] }>(`/api/agents/${id}/fs/tree`, {
      path,
    }),
  readFile: (id: string, path: string) =>
    api.get<FileContent>(`/api/agents/${id}/fs/file`, { path }),
  writeFile: (id: string, path: string, content: string) =>
    api.put<{ path: string; size: number; modified: number }>(
      `/api/agents/${id}/fs/file`,
      { content },
      { path },
    ),
  uploadFile: (id: string, file: File, dir: string) =>
    api.upload<{ path: string; size: number; name: string }>(
      `/api/agents/${id}/fs/upload`,
      file,
      { dir },
    ),

  listThreads: (id: string) =>
    api.get<{ threads: ThreadRow[] }>(`/api/agents/${id}/sessions`),
  readSession: (id: string, threadId: string, sessionId: string) =>
    api.get<{ threadId: string; sessionId: string; entries: unknown[] }>(
      `/api/agents/${id}/sessions/${encodeURIComponent(threadId)}/${encodeURIComponent(sessionId)}`,
    ),

  listPending: (id: string) =>
    api.get<{ messages: PendingMessage[] }>(`/api/agents/${id}/queue/pending`),
  listDLQ: (id: string) =>
    api.get<{ messages: DLQMessage[] }>(`/api/agents/${id}/queue/dlq`),
  listEvents: (id: string, since?: number) =>
    api.get<{ events: EventRow[] }>(`/api/agents/${id}/queue/events`, { since }),
  requeueDLQ: (id: string, rowId: number) =>
    api.post<{ ok: true }>(`/api/agents/${id}/queue/dlq/${rowId}/requeue`),
  deleteDLQ: (id: string, rowId: number) =>
    api.delete<{ ok: true }>(`/api/agents/${id}/queue/dlq/${rowId}`),

  sendChat: (id: string, text: string, threadId?: string, channelId?: string) =>
    api.post<{ ok: true }>(`/admin/${id}/send`, { text, threadId, channelId }),
  abortChat: (id: string, threadId: string) =>
    api.post<{ ok: boolean }>(`/admin/${id}/abort`, { threadId }),

  getSecrets: () => api.get<SecretsView>("/api/secrets"),
  putSecrets: (body: PutSecretsBody) =>
    api.put<{ ok: true; restartRequired: boolean }>("/api/secrets", body),

  getModels: () => api.get<ModelsView>("/api/models"),
  putModels: (body: PutModelsBody) =>
    api.put<{ ok: true; restartRequired: boolean }>("/api/models", body),

  putAgentConfig: (id: string, config: unknown) =>
    api.put<{ ok: true; restartRequired: boolean }>(
      `/api/agents/${id}/config`,
      { config },
    ),
  putPluginConfig: (id: string, pluginId: string, config: unknown) =>
    api.put<{ ok: true; restartRequired: boolean }>(
      `/api/agents/${id}/plugins/${pluginId}/config`,
      { config },
    ),
  putPluginNotifications: (id: string, pluginId: string, enabled: string[]) =>
    api.put<{ ok: true; restartRequired: boolean; enabled: string[] }>(
      `/api/agents/${id}/plugins/${pluginId}/notifications`,
      { enabled },
    ),
};

export function rawFileUrl(agentId: string, path: string, opts?: { download?: boolean }): string {
  const usp = new URLSearchParams({ path });
  if (opts?.download) usp.set("download", "1");
  return `/api/agents/${agentId}/fs/raw?${usp.toString()}`;
}
