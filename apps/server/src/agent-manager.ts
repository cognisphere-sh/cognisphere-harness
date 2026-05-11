import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import type { ServerConfig } from "./config.js";
import { agentDir, agentsRoot, harnessRoot } from "./config.js";
import type { Logger } from "./logger.js";
import { childLogger } from "./logger.js";
import type { PluginRegistry } from "./plugin-registry.js";
import { AgentDb } from "./queue.js";
import { AgentRunner } from "./runner.js";
import { findProviderInCatalog } from "./models-catalog.js";
import { ModelsStore } from "./models-store.js";
import { AGENT_BUCKET, SecretsStore } from "./secrets.js";
import type {
  AgentJson,
  AgentState,
  AgentSummary,
  JsonSchema,
  Plugin,
  PluginInstanceContext,
  PluginState,
} from "./types.js";

const ajv = new Ajv({
  useDefaults: true,
  coerceTypes: false,
  allErrors: true,
  strict: false,
});

export interface PluginEntry {
  state: PluginState;
  /** Live instance — non-null only when state === "running". */
  instance: Plugin | null;
  /** Last validated config; preserved across stop so the UI can still show it. */
  config: unknown | null;
  /** Last startup error message; non-null when state === "failed". */
  error: string | null;
  changedAt: number;
}

export interface AgentInstance {
  id: string;
  /** Parsed agent.json, or null if the file is missing/invalid (state="failed"). */
  agentJson: AgentJson | null;
  /** Constructed only when state === "running"; null otherwise. */
  runner: AgentRunner | null;
  /** Opened lazily and kept open across stop/start; closed only on shutdown
   *  (queue rows must persist across restarts). */
  db: AgentDb | null;
  state: AgentState;
  error: string | null;
  changedAt: number;
  /** One entry per plugin dir under `<agentDir>/plugins/`. Cleared and
   *  repopulated on every start (so added/removed dirs are picked up).
   *  `stopAgent` leaves entries with state="stopped" so the UI can still
   *  render them. */
  plugins: Map<string, PluginEntry>;
  /** Non-null when a config/secrets edit landed while batches were active.
   *  The runner was paused (no new threads dequeued) and is awaiting
   *  natural drain; once `runner.activeCount` hits 0 the manager swaps in
   *  a fresh runner with the new config. Cleared synchronously when the
   *  swap fires. */
  staleReason: string | null;
}

export type LifecycleErrorCode = "not_found" | "conflict";

export class LifecycleError extends Error {
  constructor(message: string, public code: LifecycleErrorCode) {
    super(message);
  }
}

/**
 * Loads agents from disk on boot and exposes them by id. Authoring (creating
 * agents, installing plugins, editing configs) is deferred to a later phase
 * — see `docs/v0-deferred.md`. v0: agents are created manually on disk; the
 * server picks them up at boot.
 *
 * Lifecycle:
 *   - boot()                   → load every agent dir; failed agents stay listed.
 *   - manualStart(id)          → from "stopped" / "failed" → "running" / "failed".
 *   - manualStop(id)           → from "running" → "stopped" (aborts active batches).
 *   - restartAgent(id)         → stop (if running) → re-read disk → start.
 *   - reloadAgent(id)          → soft: mark stale, pause new dequeues, swap
 *                                runner once active batches drain naturally.
 *   - reloadPlugin(id, pid)    → bounce a single plugin in place; runner
 *                                untouched.
 *   - shutdown()               → stop everything and close dbs.
 */
export class AgentManager {
  private agents = new Map<string, AgentInstance>();
  private transitions = new Map<string, "starting" | "stopping">();
  private readonly secrets: SecretsStore;
  private readonly models: ModelsStore;
  private readonly log: Logger;

  constructor(
    private cfg: ServerConfig,
    private registry: PluginRegistry,
    log?: Logger,
  ) {
    this.log = log ?? childLogger("agent-manager");
    this.secrets = new SecretsStore(join(harnessRoot(cfg), "secrets.json"));
    this.models = new ModelsStore(join(harnessRoot(cfg), "models.json"));
  }

  /**
   * Scan <root>/agents/* and load each one. Missing root → no agents.
   */
  async boot(): Promise<void> {
    const root = agentsRoot(this.cfg);
    mkdirSync(root, { recursive: true });
    const ids = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
    if (ids.length === 0) {
      this.log.warn(
        { root },
        "no agents found; create one manually under <root>/agents/<id>/ and restart",
      );
      return;
    }
    for (const id of ids) {
      try {
        await this.loadAgent(id);
      } catch (err) {
        this.log.error({ err, id }, "failed to load agent");
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const inst of this.agents.values()) {
      if (inst.state === "running") {
        await this.stopAgent(inst).catch((err) =>
          this.log.warn({ err, agent: inst.id }, "shutdown stop failed"),
        );
      }
      inst.db?.close();
      inst.db = null;
    }
    this.agents.clear();
  }

  get(id: string): AgentInstance | undefined {
    return this.agents.get(id);
  }

  list(): AgentSummary[] {
    return [...this.agents.values()].map((a) => {
      const { running, failed } = partitionPluginsByState(a.plugins);
      return {
        id: a.id,
        name: a.agentJson?.name ?? a.id,
        installedPlugins: [...a.plugins.keys()],
        state: a.state,
        error: a.error,
        runningPlugins: running,
        failedPlugins: failed,
      };
    });
  }

  /**
   * Look up the manifest for an installed plugin id from the registry.
   * Independent of whether the plugin actually started — used by the
   * secrets and plugins APIs to surface schemas for plugins that failed
   * validation so the operator can fix them.
   */
  getPluginManifest(
    pluginId: string,
  ): import("./types.js").PluginManifest | undefined {
    return this.registry.get(pluginId)?.manifest;
  }

  // ── public lifecycle ───────────────────────────────────────────────

  async manualStart(id: string): Promise<AgentInstance> {
    const inst = this.requireAgent(id);
    if (inst.state === "running") {
      throw new LifecycleError("already running", "conflict");
    }
    return this.withTransition(id, "starting", () => this.startAgent(inst));
  }

  async manualStop(id: string): Promise<AgentInstance> {
    const inst = this.requireAgent(id);
    if (inst.state !== "running") {
      throw new LifecycleError(`not running (state=${inst.state})`, "conflict");
    }
    return this.withTransition(id, "stopping", () => this.stopAgent(inst));
  }

  async restartAgent(id: string): Promise<AgentInstance> {
    const inst = this.requireAgent(id);
    return this.withTransition(id, "starting", async () => {
      if (inst.runner || inst.state === "running") {
        await this.stopAgent(inst);
      }
      return this.startAgent(inst);
    });
  }

  /**
   * Apply an out-of-band config/secrets/models edit. Always invalidates
   * the secrets cache (so the next start re-reads the file). For a
   * running agent, mark it stale and pause new dequeues; the runner is
   * swapped once active batches drain naturally (zero interruption,
   * zero Retry events). Stopped/failed agents stay as-is — the next
   * manual start will pick up the changes naturally.
   *
   * Coalesced: a second `reloadAgent` call while already stale is a
   * no-op (the pending swap will satisfy both edits). Returns `null`
   * if the id is unknown.
   */
  async reloadAgent(id: string): Promise<AgentInstance | null> {
    const inst = this.agents.get(id);
    if (!inst) return null;
    this.secrets.invalidate();
    if (inst.state !== "running" || !inst.runner) return inst;
    if (inst.staleReason) return inst;

    inst.staleReason = "config or secrets edit";
    inst.runner.pauseDequeue();
    if (inst.runner.activeCount === 0) {
      return this.performStaleSwap(inst);
    }
    return inst;
  }

  /**
   * Reload a single plugin in place: stop its instance (if running),
   * then re-run `startPluginInstance` so the next batch sees the new
   * config / secrets. Decoupled from agent reload — does not touch the
   * runner or other plugins. The agent remains "running" throughout.
   */
  async reloadPlugin(
    agentId: string,
    pluginId: string,
  ): Promise<AgentInstance | null> {
    const inst = this.agents.get(agentId);
    if (!inst) return null;
    this.secrets.invalidate();
    if (inst.state !== "running") return inst;
    if (!inst.plugins.has(pluginId)) return inst;

    const entry = inst.plugins.get(pluginId);
    if (entry?.state === "running" && entry.instance) {
      const instance = entry.instance;
      try {
        await Promise.race([
          instance.stop(),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error("plugin stop timed out after 5s")),
              5000,
            ),
          ),
        ]);
      } catch (err) {
        this.log.warn(
          { err, agent: agentId, plugin: pluginId },
          "plugin stop failed during reload",
        );
      }
    }

    try {
      await this.startPluginInstance(inst, pluginId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        { err, agent: agentId, plugin: pluginId },
        "plugin reload failed",
      );
      inst.plugins.set(pluginId, {
        state: "failed",
        instance: null,
        config: null,
        error: message,
        changedAt: Date.now(),
      });
    }
    return inst;
  }

  /**
   * Internal: swap in a fresh runner once active batches have drained.
   * Clears `staleReason` synchronously up-front so concurrent
   * `batch-completed` events that fire on the dying runner during stop
   * don't trigger duplicate swaps.
   */
  private async performStaleSwap(
    inst: AgentInstance,
  ): Promise<AgentInstance> {
    if (!inst.staleReason) return inst;
    inst.staleReason = null;
    try {
      return await this.restartAgent(inst.id);
    } catch (err) {
      this.log.warn({ err, agent: inst.id }, "stale swap failed");
      return this.agents.get(inst.id) ?? inst;
    }
  }

  // ── boot/load helper ───────────────────────────────────────────────

  /**
   * Build the AgentInstance shell, register it (so it's visible even if
   * start fails), and run startAgent. Always inserts into `this.agents`
   * — failed agents stay listed so the UI can show their error.
   */
  private async loadAgent(id: string): Promise<void> {
    const inst: AgentInstance = {
      id,
      agentJson: null,
      runner: null,
      db: null,
      state: "stopped",
      error: null,
      changedAt: Date.now(),
      plugins: new Map(),
      staleReason: null,
    };
    this.agents.set(id, inst);
    try {
      await this.withTransition(id, "starting", () => this.startAgent(inst));
    } catch (err) {
      // startAgent itself shouldn't throw — it captures errors onto inst —
      // but a transition-in-progress race could surface here. Log and move on.
      this.log.error({ err, id }, "loadAgent failed");
    }
  }

  // ── start / stop core ──────────────────────────────────────────────

  private async startAgent(inst: AgentInstance): Promise<AgentInstance> {
    const dir = agentDir(this.cfg, inst.id);
    const installedPluginIds = scanPluginDirs(dir);
    inst.plugins.clear();

    // 1. Parse agent.json + agent-secret validation + provider gating +
    //    env-secret resolution. All sources (provider catalog env, agent
    //    bucket, plugin buckets) must use disjoint keys — collisions
    //    throw so the operator sees the conflict instead of one source
    //    silently overriding another.
    let agentJson: AgentJson;
    let envSecrets: Record<string, string> = {};
    try {
      const raw = readFileSync(join(dir, "agent.json"), "utf8");
      agentJson = JSON.parse(raw) as AgentJson;
      if (agentJson.secretsSchema) {
        const declared = Object.keys(agentJson.secretsSchema.properties ?? {});
        const resolved = this.secrets.resolve(inst.id, AGENT_BUCKET, declared);
        checkRequiredSecrets(declared, resolved, `agent ${inst.id}`);
      }
      const providerEnv = resolveAndValidateProvider(
        this.models,
        agentJson,
        dir,
        inst.id,
        this.log,
      );
      const resolvedSecrets = this.secrets.resolveAll(inst.id);
      const agentConfigEnv = resolveAgentConfigEnv(agentJson, inst.id);
      const collisions = [
        ...Object.keys(resolvedSecrets).filter((k) => k in providerEnv),
        ...Object.keys(agentConfigEnv).filter(
          (k) => k in providerEnv || k in resolvedSecrets,
        ),
      ];
      if (collisions.length > 0) {
        throw new Error(
          `agent ${inst.id}: env keys collide across provider/secrets/config: ${collisions.join(", ")}`,
        );
      }
      envSecrets = { ...providerEnv, ...resolvedSecrets, ...agentConfigEnv };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err, agent: inst.id }, "agent spec parse/validate failed");
      inst.agentJson = null;
      inst.state = "failed";
      inst.error = message;
      inst.changedAt = Date.now();
      return inst;
    }
    inst.agentJson = agentJson;

    // 2. Open the queue db lazily, reuse across restarts.
    mkdirSync(join(dir, "sessions"), { recursive: true });
    if (!inst.db) {
      inst.db = new AgentDb(join(dir, "sessions", ".queue.db"), inst.id);
    }

    // 3. Construct a fresh runner with the resolved env snapshot.
    inst.runner = new AgentRunner({
      rootDir: this.cfg.rootDir,
      harnessId: this.cfg.harnessId,
      agentId: inst.id,
      agentJson,
      db: inst.db,
      serverBaseUrl: this.cfg.serverBaseUrl,
      timezone: this.cfg.timezone,
      envSecrets,
      log: childLogger(`agent:${inst.id}`),
    });
    // When a stale-reload is pending and the last active batch finishes,
    // swap to a fresh runner. The listener captures `inst` (stable) and
    // checks `inst.runner` at fire time so a swap-in-progress no-ops.
    inst.runner.on("batch-completed", () => {
      if (inst.staleReason && inst.runner?.activeCount === 0) {
        void this.performStaleSwap(inst);
      }
    });

    // 4. Start each installed plugin; per-plugin failures don't sink the agent.
    for (const pid of installedPluginIds) {
      try {
        await this.startPluginInstance(inst, pid);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(
          { err, agent: inst.id, plugin: pid },
          "failed to start plugin",
        );
        inst.plugins.set(pid, {
          state: "failed",
          instance: null,
          config: null,
          error: message,
          changedAt: Date.now(),
        });
      }
    }

    // 5. Start the runner.
    inst.runner.start();
    inst.state = "running";
    inst.error = null;
    inst.changedAt = Date.now();

    const { running, failed } = partitionPluginsByState(inst.plugins);
    this.log.info(
      { agentId: inst.id, runningPlugins: running, failedPlugins: failed },
      "agent started",
    );
    return inst;
  }

  private async stopAgent(inst: AgentInstance): Promise<AgentInstance> {
    // A stop supersedes any pending stale swap; otherwise the listener on
    // the dying runner could re-trigger a swap mid-stop.
    inst.staleReason = null;
    for (const [pid, entry] of inst.plugins) {
      if (entry.state !== "running" || !entry.instance) continue;
      const instance = entry.instance;
      try {
        await Promise.race([
          instance.stop(),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error("plugin stop timed out after 5s")),
              5000,
            ),
          ),
        ]);
      } catch (err) {
        this.log.warn(
          { err, agent: inst.id, plugin: pid },
          "plugin stop failed",
        );
      }
      entry.state = "stopped";
      entry.instance = null;
      entry.error = null;
      entry.changedAt = Date.now();
    }

    if (inst.runner) {
      try {
        await inst.runner.stop();
      } catch (err) {
        this.log.warn({ err, agent: inst.id }, "runner stop failed");
      }
      inst.runner = null;
    }

    cleanupProviderArtifacts(agentDir(this.cfg, inst.id), this.log);

    inst.state = "stopped";
    inst.error = null;
    inst.changedAt = Date.now();
    this.log.info({ agentId: inst.id }, "agent stopped");
    return inst;
  }

  // ── plugin start helper ───────────────────────────────────────────

  /**
   * Throws on any failure (caller in `startAgent` records a failed
   * `PluginEntry`). On success, sets a running entry.
   */
  private async startPluginInstance(
    inst: AgentInstance,
    pluginId: string,
  ): Promise<void> {
    const entry = this.registry.get(pluginId);
    if (!entry) throw new Error(`unknown plugin id: ${pluginId}`);

    const dir = agentDir(this.cfg, inst.id);
    const pdir = join(dir, "plugins", pluginId);
    const cfgPath = join(pdir, "config.json");

    const rawConfig = existsSync(cfgPath)
      ? (JSON.parse(readFileSync(cfgPath, "utf8")) as unknown)
      : {};
    const config = validateAndDefault(
      entry.manifest.configSchema,
      rawConfig,
      { agentId: inst.id, pluginId },
    );

    const secretKeys = Object.keys(entry.manifest.secretsSchema.properties ?? {});
    const resolvedSecrets = this.secrets.resolve(inst.id, pluginId, secretKeys);
    checkRequiredSecrets(
      secretKeys,
      resolvedSecrets,
      `plugin ${pluginId} on ${inst.id}`,
    );

    const log = childLogger(`plugin:${inst.id}:${pluginId}`);
    const pluginInstance = new entry.ctor();

    const stateDir = join(pdir, "state");
    const inboxDir = join(pdir, "inbox");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(inboxDir, { recursive: true });

    const pluginEntry: PluginEntry = {
      state: "running",
      instance: pluginInstance,
      config,
      error: null,
      changedAt: Date.now(),
    };

    const ctx: PluginInstanceContext = {
      agentId: inst.id,
      agentDir: dir,
      stateDir,
      inboxDir,
      config,
      secrets: resolvedSecrets,
      timezone: this.cfg.timezone,
      log,
      httpBaseUrl: pluginInstance.handleHttpRequest
        ? `${this.cfg.serverBaseUrl}/webhook/${inst.id}/${pluginId}`
        : undefined,
      notify: (name, payload) => {
        const meta = { ...(payload.metadata ?? {}), _notification: name };
        try {
          inst.runner?.notify({
            ...payload,
            metadata: meta,
            pluginId,
          });
        } catch (err) {
          log.error({ err }, "notify failed");
        }
      },
    };

    await pluginInstance.start(ctx);
    inst.plugins.set(pluginId, pluginEntry);
  }

  // ── helpers ────────────────────────────────────────────────────────

  private requireAgent(id: string): AgentInstance {
    const inst = this.agents.get(id);
    if (!inst) throw new LifecycleError(`unknown agent: ${id}`, "not_found");
    return inst;
  }

  private async withTransition<T>(
    id: string,
    kind: "starting" | "stopping",
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.transitions.has(id)) {
      throw new LifecycleError("transition in progress", "conflict");
    }
    this.transitions.set(id, kind);
    try {
      return await fn();
    } finally {
      this.transitions.delete(id);
    }
  }
}

function scanPluginDirs(dir: string): string[] {
  const pluginsDir = join(dir, "plugins");
  if (!existsSync(pluginsDir)) return [];
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
}

/** Filename under <agentDir> where Vertex's service-account JSON is materialized. */
const VERTEX_SA_FILE = ".vertex-sa.json";

/**
 * Validate the agent's chosen provider/model against operator settings and
 * return the env vars pi should see. Throws if the provider isn't configured,
 * the model isn't enabled, or required credentials are missing — but only
 * when a model id is specified; an agent.json with provider but no model
 * passes through silently (preserves the pre-merge permissive behavior).
 *
 * Special case: google-vertex's `serviceAccountKey` field is paste-blob
 * JSON — we write it to <agentDir>/.vertex-sa.json (0600) and point
 * GOOGLE_APPLICATION_CREDENTIALS at the path. Cleaned up by
 * `cleanupProviderArtifacts()` on agent stop.
 *
 * Empty map if the provider has no catalog entry — pi falls back to
 * ambient env in that case (the operator can still set vars on the
 * server host for out-of-catalog setups).
 */
function resolveAndValidateProvider(
  models: ModelsStore,
  agentJson: AgentJson,
  agentDir: string,
  agentId: string,
  log: Logger,
): Record<string, string> {
  const providerId = agentJson.model?.provider;
  if (!providerId) return {};
  const entry = findProviderInCatalog(providerId);
  if (!entry) return {};
  const cfg = models.getProvider(providerId);
  const modelId = agentJson.model?.id;

  if (!cfg) {
    if (modelId) {
      throw new Error(
        `agent ${agentId}: provider ${providerId} is not configured in Models settings`,
      );
    }
    return {};
  }

  if (modelId) {
    if (cfg.enabledModels.length === 0 || !cfg.enabledModels.includes(modelId)) {
      throw new Error(
        `agent ${agentId}: model ${providerId}/${modelId} is not enabled in Models settings`,
      );
    }
    const missing = entry.credentials
      .filter((f) => f.required)
      .filter((f) => {
        const v = cfg.credentials[f.key];
        return typeof v !== "string" || v.length === 0;
      })
      .map((f) => f.label);
    if (missing.length > 0) {
      throw new Error(
        `agent ${agentId}: provider ${providerId} is missing required credentials: ${missing.join(", ")} (set them in Models settings)`,
      );
    }
  }

  const env: Record<string, string> = {};
  for (const field of entry.credentials) {
    const value = cfg.credentials[field.key];
    if (typeof value !== "string" || value.length === 0) continue;

    if (providerId === "google-vertex" && field.key === "serviceAccountKey") {
      const path = join(agentDir, VERTEX_SA_FILE);
      try {
        writeFileSync(path, value, { mode: 0o600 });
        env[field.envVar] = path;
      } catch (err) {
        log.error(
          { err, agentDir, providerId },
          "failed to materialize vertex service account file",
        );
      }
      continue;
    }

    env[field.envVar] = value;
  }
  return env;
}

/** Best-effort cleanup of provider-injected files (currently just Vertex's SA JSON). */
function cleanupProviderArtifacts(agentDir: string, log: Logger): void {
  const path = join(agentDir, VERTEX_SA_FILE);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch (err) {
    log.warn({ err, path }, "failed to remove vertex service account file");
  }
}

function partitionPluginsByState(plugins: Map<string, PluginEntry>): {
  running: string[];
  failed: string[];
} {
  const running: string[] = [];
  const failed: string[] = [];
  for (const [pid, e] of plugins) {
    if (e.state === "running") running.push(pid);
    else if (e.state === "failed") failed.push(pid);
  }
  return { running, failed };
}

/**
 * Validate (and default-fill) a plugin config against its manifest's
 * configSchema. Returns the (possibly mutated) config; throws on validation
 * failure. The input object is mutated in place by ajv's `useDefaults`.
 */
function validateAndDefault(
  schema: JsonSchema,
  config: unknown,
  ctx: { agentId: string; pluginId: string },
): unknown {
  const data = (config ?? {}) as Record<string, unknown>;
  const validate = ajv.compile(schema);
  const ok = validate(data);
  if (!ok) {
    const msgs =
      validate.errors
        ?.map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
        .join("; ") ?? "unknown";
    throw new Error(
      `config invalid for ${ctx.pluginId} on ${ctx.agentId}: ${msgs}`,
    );
  }
  return data;
}

/**
 * Enforce that every declared secret is populated. v0 contract: all
 * declared secrets are mandatory — there are no optional secrets.
 *
 * `label` is rendered in the error message — pass `"plugin <pluginId> on
 * <agentId>"` for plugin secrets or `"agent <agentId>"` for agent-level
 * secrets.
 */
function checkRequiredSecrets(
  declared: string[],
  resolved: Record<string, string>,
  label: string,
): void {
  const missing = declared.filter((k) => !(k in resolved));
  if (missing.length > 0) {
    throw new Error(`${label}: missing secrets: ${missing.join(", ")}`);
  }
}

/**
 * Validate and return the env-vars map from `agent.json.config`. Empty if
 * the field is absent. Throws if the field is present but malformed so a
 * typo in agent.json surfaces at start instead of silently dropping values.
 */
function resolveAgentConfigEnv(
  agentJson: AgentJson,
  agentId: string,
): Record<string, string> {
  const raw = agentJson.config;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `agent ${agentId}: agent.json "config" must be an object mapping env-var names to string values`,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") {
      throw new Error(
        `agent ${agentId}: agent.json config.${k} must be a string (got ${typeof v})`,
      );
    }
    if (v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** Typed lookup for the admin plugin's `deliver()`. Null unless the plugin
 *  is installed and currently running. */
export function getAdminPlugin(
  inst: AgentInstance,
): import("../plugins/admin/index.js").default | null {
  const e = inst.plugins.get("admin");
  if (e?.state !== "running" || !e.instance) return null;
  return e.instance as import("../plugins/admin/index.js").default;
}
