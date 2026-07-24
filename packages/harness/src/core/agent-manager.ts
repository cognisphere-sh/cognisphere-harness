import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Ajv, type ErrorObject } from "ajv";
import type { ServerConfig } from "./config.js";
import { agentDir, agentsRoot, secretsRoot } from "./config.js";
import type { Logger } from "./logger.js";
import { childLogger } from "./logger.js";
import type { PluginRegistry } from "./plugin-registry.js";
import { CORE_PLUGIN_IDS } from "./plugin-registry.js";
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
 *   - manualStop(id)           → from "running" → "stopped" (interrupts active
 *                                batches; their rows requeue for the next start).
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
    this.secrets = new SecretsStore(join(secretsRoot(cfg), "secrets.json"));
    this.models = new ModelsStore(join(secretsRoot(cfg), "models.json"));
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
   * Tear down one thread: refuse while a batch is in-flight (it would race
   * the runner writing the session jsonl), delete the thread's queue rows +
   * session binding, remove its `sessions/<threadId>/` dir. Shared by the
   * HTTP DELETE route and the plugin-context `resetThread`.
   */
  deleteThread(
    id: string,
    threadId: string,
  ): { events: number; removedDir: boolean } {
    const inst = this.requireAgent(id);
    if (inst.runner?.isThreadActive(threadId)) {
      throw new LifecycleError(
        "thread is currently in-flight — abort it first",
        "conflict",
      );
    }
    const events = inst.db?.deleteThread(threadId).events ?? 0;
    const tDir = join(agentDir(this.cfg, id), "sessions", threadId);
    let removedDir = false;
    if (existsSync(tDir)) {
      rmSync(tDir, { recursive: true, force: true });
      removedDir = true;
    }
    return { events, removedDir };
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
    // Seed this agent's roster fragment (write-if-absent — operator edits win).
    writeAgentDirectory(agentsRoot(this.cfg), inst.id, dir);
    // Core plugins (admin, scheduler) are auto-installed on every agent —
    // always started regardless of the agent's plugins dir, then unioned with
    // any user-installed plugins found on disk.
    const installedPluginIds = [
      ...new Set([...CORE_PLUGIN_IDS, ...scanPluginDirs(dir)]),
    ];
    inst.plugins.clear();
    // Seed every installed plugin as "stopped" so the Settings UI + the
    // secrets endpoint surface them even if agent validation fails before
    // step 4 reaches them (e.g. missing agent-level secret aborts early —
    // operator still needs to see plugin configs/secrets to fix them).
    // Step 4 overwrites these entries on successful startup.
    for (const pid of installedPluginIds) {
      inst.plugins.set(pid, {
        state: "stopped",
        instance: null,
        config: null,
        error: null,
        changedAt: Date.now(),
      });
    }

    // 1. Parse agent.json + agent-secret validation + provider gating +
    //    env-secret resolution. All sources (provider catalog env, agent
    //    bucket, plugin buckets) must use disjoint keys — collisions
    //    throw so the operator sees the conflict instead of one source
    //    silently overriding another.
    let agentJson: AgentJson;
    try {
      const raw = readFileSync(join(dir, "agent.json"), "utf8");
      agentJson = JSON.parse(raw) as AgentJson;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err, agent: inst.id }, "agent.json parse failed");
      inst.agentJson = null;
      inst.state = "failed";
      inst.error = message;
      inst.changedAt = Date.now();
      return inst;
    }
    // Expose the parsed spec to the UI immediately so any subsequent
    // validation failure still surfaces its schemas + config — otherwise
    // operators can't fix a "missing required secret" because the form
    // to set it is gated on the agent loading cleanly.
    inst.agentJson = agentJson;

    let envSecrets: Record<string, string> = {};
    try {
      if (agentJson.secretsSchema) {
        const declared = Object.keys(agentJson.secretsSchema.properties ?? {});
        const required = (agentJson.secretsSchema.required ?? []).filter((k) =>
          declared.includes(k),
        );
        const resolved = this.secrets.resolve(inst.id, AGENT_BUCKET, declared);
        checkRequiredSecrets(required, resolved, `agent ${inst.id}`);
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
      this.log.error({ err, agent: inst.id }, "agent spec validate failed");
      inst.state = "failed";
      inst.error = message;
      inst.changedAt = Date.now();
      return inst;
    }

    // 2. Open the events db lazily, reuse across restarts.
    mkdirSync(join(dir, "sessions"), { recursive: true });
    if (!inst.db) {
      inst.db = new AgentDb(join(dir, "sessions", ".events.db"));
      // One-time backfill: thread directories that already have a session
      // JSONL on disk (from before the harness owned session ids) need an
      // entry in `threads` so the runner reuses the existing session
      // instead of creating a fresh one. We pick the most recently
      // modified .jsonl in each thread dir — matches what `--continue`
      // would have selected.
      backfillThreadSessions(join(dir, "sessions"), inst.db, this.log);
    }

    // 2.5. Provision the agent runtime (system deps + .venv) by running the
    //      agent's bootstrap.sh, so the runner can auto-activate .venv at
    //      spawn. Idempotent and non-interactive; failures are logged and
    //      tolerated (a prior .venv may still be usable).
    //      ponytail: runs on every start — pip is quick once satisfied, the
    //      first boot is slow; agents load sequentially, so a slow bootstrap
    //      delays later agents.
    await runBootstrap(dir, this.log);

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
      resolveProviderEnv: (providerId) =>
        resolveProviderEnv(this.models, providerId, dir, this.log),
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

    // Provision the plugin's `seed/` (system prompt + helper scripts) into the
    // agent dir. The seed tree mirrors the agent layout
    // (`system_prompts/plugin-<id>.md`, `scripts/<id>/…`), so a recursive copy
    // drops everything in place. Files are plugin-owned and namespaced, and are
    // overwritten on every start so they track the installed package version.
    const seedDir = join(entry.sourceDir, "seed");
    if (existsSync(seedDir)) {
      cpSync(seedDir, dir, { recursive: true });
      // Seeds are copied AFTER bootstrap.sh's chmod pass (step 2.5 of
      // startAgent), so a seeded script that lost its exec bit in transit
      // would stay broken until the next restart. Re-assert +x here.
      makeScriptsExecutable(join(dir, "scripts"));
    }

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
    const requiredSecrets = (entry.manifest.secretsSchema.required ?? []).filter(
      (k) => secretKeys.includes(k),
    );
    const resolvedSecrets = this.secrets.resolve(inst.id, pluginId, secretKeys);
    checkRequiredSecrets(
      requiredSecrets,
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
      resetThread: (channelId) => {
        const runner = inst.runner;
        if (!runner) throw new Error("agent not running");
        const threadId = runner.threadIdFor(pluginId, channelId);
        this.deleteThread(inst.id, threadId);
        log.info({ threadId }, "thread reset by plugin");
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

/**
 * Run the agent's `bootstrap/bootstrap.sh` (cwd = agent dir) to provision its
 * runtime: system binaries + a Python `.venv`. The script is idempotent and
 * non-interactive (warns and continues on missing sudo deps), so it's safe to
 * run on every agent start. Never rejects — a failure is logged and tolerated
 * (a `.venv` from a prior run may still be usable). No-op if the agent ships no
 * `bootstrap/bootstrap.sh`. Output is inherited so progress shows in the logs.
 */
function runBootstrap(dir: string, log: Logger): Promise<void> {
  if (!existsSync(join(dir, "bootstrap", "bootstrap.sh"))) return Promise.resolve();
  log.info({ dir }, "running bootstrap.sh");
  return new Promise((resolve) => {
    const child = spawn("bash", ["bootstrap/bootstrap.sh"], {
      cwd: dir,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      log.warn({ err, dir }, "bootstrap.sh failed to spawn; continuing");
      resolve();
    });
    child.on("close", (code) => {
      if (code === 0) log.info({ dir }, "bootstrap.sh complete");
      else log.warn({ code, dir }, "bootstrap.sh exited non-zero; continuing");
      resolve();
    });
  });
}

/**
 * Recursively `chmod +x` every regular file under `scriptsDir` (no-op if the
 * dir is absent). Mirrors bootstrap.sh's exec-bit repair, but runs at seed-copy
 * time so plugin scripts provisioned after bootstrap are immediately runnable.
 * ponytail: chmods every file, not just shebang'd ones — scripts/ holds only
 * wrappers and the odd .md, and a +x .md is harmless.
 */
function makeScriptsExecutable(scriptsDir: string): void {
  if (!existsSync(scriptsDir)) return;
  for (const entry of readdirSync(scriptsDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    chmodSync(join(entry.parentPath, entry.name), 0o755);
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
  // Subscription OAuth (tokens in pi's own auth.json) substitutes for
  // models.json credentials — pi children resolve auth.json themselves,
  // so nothing extra is injected; only the model allowlist still applies.
  const oauthConnected =
    entry.oauth === true && readStoredCredential(providerId)?.type === "oauth";
  const cfg =
    models.getProvider(providerId) ??
    (oauthConnected ? { credentials: {}, enabledModels: [] } : undefined);
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
    if (missing.length > 0 && !oauthConnected) {
      throw new Error(
        `agent ${agentId}: provider ${providerId} is missing required credentials: ${missing.join(", ")} (set them in Models settings)`,
      );
    }
  }

  return resolveProviderEnv(models, providerId, agentDir, log);
}

/**
 * Map a configured provider's stored credentials to the env vars the pi
 * child expects. No validation — returns an empty object for an unknown or
 * unconfigured provider, and silently skips empty fields. Vertex's service
 * account JSON is materialized to a file and the env points at its path.
 *
 * Used both by `resolveAndValidateProvider` (the agent's default provider,
 * injected once at start) and by the runner for a thread's cross-provider
 * model override, where the override provider's key must be injected at
 * spawn time (`runner.ts:spawnPi`).
 */
export function resolveProviderEnv(
  models: ModelsStore,
  providerId: string,
  agentDir: string,
  log: Logger,
): Record<string, string> {
  const entry = findProviderInCatalog(providerId);
  if (!entry) return {};
  const cfg = models.getProvider(providerId);
  if (!cfg) return {};

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
 * Compile `schema` and validate `data` against it, backfilling declared
 * defaults in place via ajv's `useDefaults`. Throws `<label>: <messages>`
 * on validation failure.
 */
function validateWithSchema(
  schema: JsonSchema,
  data: Record<string, unknown>,
  label: string,
): void {
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    const msgs =
      validate.errors
        ?.map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
        .join("; ") ?? "unknown";
    throw new Error(`${label}: ${msgs}`);
  }
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
  validateWithSchema(
    schema,
    data,
    `config invalid for ${ctx.pluginId} on ${ctx.agentId}`,
  );
  return data;
}

/**
 * Seed `<selfDir>/system_prompts/0.3-agent-directory.md` — the roster fragment
 * that tells this agent who else is in the harness and how to message them.
 * Built from every agent.json on disk (so it's complete regardless of load
 * order) and written only when absent, so operator edits survive restarts.
 *
 * ponytail: write-if-absent, not regenerated. Adding/renaming an agent leaves
 *   existing rosters stale until their file is deleted (or hand-edited); the
 *   new agent still gets a complete one. Fine while agents are added rarely —
 *   `rm system_prompts/0.3-agent-directory.md` regenerates on next start.
 */
function writeAgentDirectory(
  agentsDir: string,
  selfId: string,
  selfDir: string,
): void {
  const others = existsSync(agentsDir)
    ? readdirSync(agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== selfId)
        .map((e) => {
          try {
            const spec = JSON.parse(
              readFileSync(join(agentsDir, e.name, "agent.json"), "utf8"),
            ) as AgentJson;
            return { id: e.name, description: spec.description, dev: spec.devAgent };
          } catch {
            return null; // unreadable/missing agent.json — skip
          }
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];
  // Nothing to say in a single-agent harness — skip so the file appears (with
  // a full roster) only once a second agent exists.
  if (others.length === 0) return;

  const dest = join(selfDir, "system_prompts", "0.3-agent-directory.md");
  if (existsSync(dest)) return;

  const lines = others.map((a) => {
    const tag = a.dev ? " (developer agent)" : "";
    const desc = a.description?.trim() ? ` — ${a.description.trim()}` : "";
    return `- **${a.id}**${tag}${desc}`;
  });
  const body = `# Other agents in this harness

The other agents running in this deployment. To hand work to one or reply to
it, use the agent-messaging plugin (if installed on you):
\`scripts/agent-msg/send --to-agent <id> --thread-id <theirThread> --message "…"\`.

${lines.join("\n")}

(The harness creates this file only when missing — edit it freely to customise.)
`;
  writeFileSync(dest, body);
}

/**
 * Enforce that every secret in `required` is populated. Keys declared in
 * `properties` but absent from `required` are optional — they show up in
 * the settings UI and are exported to env when set, but their absence is
 * non-fatal.
 *
 * `label` is rendered in the error message — pass `"plugin <pluginId> on
 * <agentId>"` for plugin secrets or `"agent <agentId>"` for agent-level
 * secrets.
 */
function checkRequiredSecrets(
  required: string[],
  resolved: Record<string, string>,
  label: string,
): void {
  const missing = required.filter((k) => !(k in resolved));
  if (missing.length > 0) {
    throw new Error(`${label}: missing secrets: ${missing.join(", ")}`);
  }
}

/**
 * Validate `agent.json.config` against `agent.json.configSchema` (ajv
 * with `useDefaults` so declared defaults backfill missing keys), then
 * return the env-vars map. Empty if neither is set. The two fields are
 * tied: declaring `config` without `configSchema` (or vice versa)
 * throws at start so the operator can't drift the value off its
 * contract. Empty-string values are dropped from the env so the runtime
 * sees them as unset.
 */
function resolveAgentConfigEnv(
  agentJson: AgentJson,
  agentId: string,
): Record<string, string> {
  const hasConfig = agentJson.config !== undefined;
  const hasSchema = agentJson.configSchema !== undefined;
  if (!hasConfig && !hasSchema) return {};
  if (hasConfig !== hasSchema) {
    throw new Error(
      `agent ${agentId}: agent.json "config" and "configSchema" must be set together (got config=${hasConfig}, configSchema=${hasSchema})`,
    );
  }
  const data = (agentJson.config ?? {}) as Record<string, unknown>;
  validateWithSchema(
    agentJson.configSchema!,
    data,
    `agent ${agentId}: agent.json config invalid`,
  );
  // ajv mutated `data` in place via useDefaults; write the populated
  // values back so the UI sees the same defaulted shape the runtime did.
  agentJson.config = data as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
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

/**
 * Walk `<sessionsDir>/<threadId>/` and seed the `threads` table with the
 * most-recently-modified `<uuid>.jsonl` for any thread that doesn't yet
 * have a binding. Idempotent (`setThreadSessionId` is INSERT OR IGNORE),
 * so safe to call on every start. Threads with no JSONL on disk are
 * skipped — the runner will mint a fresh id on their next batch.
 */
function backfillThreadSessions(
  sessionsDir: string,
  db: AgentDb,
  log: Logger,
): void {
  if (!existsSync(sessionsDir)) return;
  for (const ent of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const threadId = ent.name;
    if (db.getThreadSessionId(threadId)) continue;
    const tDir = join(sessionsDir, threadId);
    let bestId: string | null = null;
    let bestMtime = -1;
    for (const f of readdirSync(tDir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      try {
        const m = statSync(join(tDir, f.name)).mtimeMs;
        if (m > bestMtime) {
          bestMtime = m;
          bestId = f.name.replace(/\.jsonl$/, "");
        }
      } catch {
        /* file vanished between readdir and stat — ignore */
      }
    }
    if (bestId) {
      db.setThreadSessionId(threadId, bestId);
      log.info({ threadId, sessionId: bestId }, "backfilled thread session id");
    }
  }
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
