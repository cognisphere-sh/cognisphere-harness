import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { checkRequiredSecrets, validateAndDefault } from "./validation.js";
import type {
  AgentJson,
  AgentState,
  AgentSummary,
  Plugin,
  PluginInstanceContext,
  PluginState,
} from "./types.js";

export interface PluginEntry {
  pluginId: string;
  state: PluginState;
  /** Live instance — non-null only when state === "running". */
  instance: Plugin | null;
  /** Last validated config; preserved across stop so the UI can still show it. */
  config: unknown | null;
  notifications: { enabled: string[] };
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
  /** One entry per plugin id present under `<agentDir>/plugins/`. State on
   *  the entry tells whether it's actually running. */
  plugins: Map<string, PluginEntry>;
  /** Every plugin directory found under `<agentDir>/plugins/`. Refreshed on
   *  each (re)start so newly-added or removed dirs are picked up. */
  installedPluginIds: string[];
  /** Convenience reference to the admin plugin's `deliver()` if running. */
  adminPlugin: import("../plugins/admin/index.js").default | null;
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
 *   - boot()              → load every agent dir; failed agents stay listed.
 *   - manualStart(id)     → from "stopped" / "failed" → "running" / "failed".
 *   - manualStop(id)      → from "running" → "stopped".
 *   - restartAgent(id)    → stop (if running) → re-read disk → start.
 *   - shutdown()          → stop everything and close dbs.
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
      const runningPlugins: string[] = [];
      const failedPlugins: string[] = [];
      for (const e of a.plugins.values()) {
        if (e.state === "running") runningPlugins.push(e.pluginId);
        else if (e.state === "failed") failedPlugins.push(e.pluginId);
      }
      return {
        id: a.id,
        name: a.agentJson?.name ?? a.id,
        installedPlugins: a.installedPluginIds,
        state: a.state,
        error: a.error,
        runningPlugins,
        failedPlugins,
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
   * the secrets cache (so the next start re-reads the file). If the
   * agent is currently running, restart it so the new values reach the
   * pi runtime immediately. Stopped/failed agents stay as-is — the next
   * manual start will pick up the changes naturally.
   *
   * Restart errors are caught and logged; the agent stays listed with
   * its updated state/error so the UI can surface the failure. Returns
   * `null` if the id is unknown (no throw — callers iterate freely).
   */
  async reloadAgent(id: string): Promise<AgentInstance | null> {
    const inst = this.agents.get(id);
    if (!inst) return null;
    this.secrets.invalidate();
    if (inst.state !== "running" && !inst.runner) return inst;
    try {
      return await this.restartAgent(id);
    } catch (err) {
      this.log.warn({ err, agent: id }, "auto-reload failed");
      return this.agents.get(id) ?? null;
    }
  }

  // ── boot/load helper ───────────────────────────────────────────────

  /**
   * Build the AgentInstance shell, register it (so it's visible even if
   * start fails), and run startAgent. Always inserts into `this.agents`
   * — failed agents stay listed so the UI can show their error.
   */
  private async loadAgent(id: string): Promise<AgentInstance> {
    const inst: AgentInstance = {
      id,
      agentJson: null,
      runner: null,
      db: null,
      state: "stopped",
      error: null,
      changedAt: Date.now(),
      plugins: new Map(),
      installedPluginIds: [],
      adminPlugin: null,
    };
    this.agents.set(id, inst);
    try {
      await this.withTransition(id, "starting", () => this.startAgent(inst));
    } catch (err) {
      // startAgent itself shouldn't throw — it captures errors onto inst —
      // but a transition-in-progress race could surface here. Log and move on.
      this.log.error({ err, id }, "loadAgent failed");
    }
    return inst;
  }

  // ── start / stop core ──────────────────────────────────────────────

  private async startAgent(inst: AgentInstance): Promise<AgentInstance> {
    const dir = agentDir(this.cfg, inst.id);
    inst.installedPluginIds = scanPluginDirs(dir);
    inst.plugins.clear();
    inst.adminPlugin = null;

    // 1. Parse agent.json + agent-secret validation + model gating.
    let agentJson: AgentJson;
    try {
      const raw = readFileSync(join(dir, "agent.json"), "utf8");
      agentJson = JSON.parse(raw) as AgentJson;
      if (agentJson.secretsSchema) {
        const declared = Object.keys(agentJson.secretsSchema.properties ?? {});
        const resolved = this.secrets.resolve(inst.id, AGENT_BUCKET, declared);
        checkRequiredSecrets(
          agentJson.secretsSchema,
          resolved,
          `agent ${inst.id}`,
        );
      }
      checkModelEnabled(this.models, agentJson, inst.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err, agent: inst.id }, "agent spec parse/validate failed");
      inst.agentJson = null;
      inst.runner = null;
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

    // 3. Construct a fresh runner with the latest secret snapshot.
    //    Per-agent secrets win over the global provider key on collision —
    //    matches the broader secrets.json > models.json precedence.
    const envSecrets: Record<string, string> = {
      ...resolveProviderEnv(this.models, agentJson),
      ...this.secrets.resolveAll(inst.id),
    };
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

    // 4. Start each installed plugin; per-plugin failures don't sink the agent.
    for (const pid of inst.installedPluginIds) {
      try {
        await this.startPluginInstance(inst, pid);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(
          { err, agent: inst.id, plugin: pid },
          "failed to start plugin",
        );
        inst.plugins.set(pid, {
          pluginId: pid,
          state: "failed",
          instance: null,
          config: null,
          notifications: { enabled: [] },
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

    const running: string[] = [];
    const failed: string[] = [];
    for (const e of inst.plugins.values()) {
      if (e.state === "running") running.push(e.pluginId);
      else if (e.state === "failed") failed.push(e.pluginId);
    }
    this.log.info(
      { agentId: inst.id, runningPlugins: running, failedPlugins: failed },
      "agent started",
    );
    return inst;
  }

  private async stopAgent(inst: AgentInstance): Promise<AgentInstance> {
    for (const entry of inst.plugins.values()) {
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
          { err, agent: inst.id, plugin: entry.pluginId },
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

    inst.adminPlugin = null;
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
    const notifPath = join(pdir, "notifications.json");

    const rawConfig = existsSync(cfgPath)
      ? (JSON.parse(readFileSync(cfgPath, "utf8")) as unknown)
      : {};
    const config = validateAndDefault(
      entry.manifest.configSchema,
      rawConfig,
      { agentId: inst.id, pluginId },
    );
    const notifications = existsSync(notifPath)
      ? (JSON.parse(readFileSync(notifPath, "utf8")) as { enabled: string[] })
      : { enabled: entry.manifest.notifications.map((n) => n.name) };

    const secretKeys = manifestSecretKeys(entry.manifest);
    const resolvedSecrets = this.secrets.resolve(inst.id, pluginId, secretKeys);
    checkRequiredSecrets(
      entry.manifest.secretsSchema,
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
      pluginId,
      state: "running",
      instance: pluginInstance,
      config,
      notifications,
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
      log,
      httpBaseUrl: pluginInstance.handleHttpRequest
        ? `${this.cfg.serverBaseUrl}/webhook/${inst.id}/${pluginId}`
        : undefined,
      notify: (name, payload) => {
        if (!pluginEntry.notifications.enabled.includes(name)) return;
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

    if (pluginId === "admin") {
      inst.adminPlugin =
        pluginInstance as import("../plugins/admin/index.js").default;
    }
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

function manifestSecretKeys(m: {
  secretsSchema: { properties?: object };
}): string[] {
  return Object.keys(m.secretsSchema.properties ?? {});
}

/**
 * Look up the agent's chosen provider in the global Models config and
 * return the env var pi expects for that provider, populated with the
 * configured API key. Empty map if the provider has no API key set or
 * isn't a known catalog entry — pi falls back to ambient env / OAuth /
 * agent-level secrets in that case.
 */
function resolveProviderEnv(
  models: ModelsStore,
  agentJson: AgentJson,
): Record<string, string> {
  const providerId = agentJson.model?.provider;
  if (!providerId) return {};
  const entry = findProviderInCatalog(providerId);
  if (!entry) return {};
  const cfg = models.getProvider(providerId);
  if (!cfg?.apiKey) return {};
  return { [entry.envVar]: cfg.apiKey };
}

/**
 * Enforce the operator-curated allowlist: an agent may only use a model
 * that's been enabled in the Models settings page. Skipped silently if
 * the provider has no entry yet — that lets newly-created agents still
 * boot before the operator's first pass at the Models page, and lets
 * out-of-catalog providers (Bedrock, Vertex, ...) keep working.
 */
function checkModelEnabled(
  models: ModelsStore,
  agentJson: AgentJson,
  agentId: string,
): void {
  const providerId = agentJson.model?.provider;
  const modelId = agentJson.model?.id;
  if (!providerId || !modelId) return;
  if (!findProviderInCatalog(providerId)) return;
  const cfg = models.getProvider(providerId);
  if (!cfg) return;
  if (cfg.enabledModels.length === 0) return;
  if (!cfg.enabledModels.includes(modelId)) {
    throw new Error(
      `agent ${agentId}: model ${providerId}/${modelId} is not enabled in Models settings`,
    );
  }
}
