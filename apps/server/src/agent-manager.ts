import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import { agentDir, agentsRoot, harnessRoot } from "./config.js";
import type { Logger } from "./logger.js";
import { childLogger } from "./logger.js";
import type { PluginRegistry } from "./plugin-registry.js";
import { AgentDb } from "./queue.js";
import { AgentRunner } from "./runner.js";
import { SecretsStore } from "./secrets.js";
import { checkRequiredSecrets, validateAndDefault } from "./validation.js";
import type {
  AgentJson,
  AgentSummary,
  Plugin,
  PluginInstanceContext,
} from "./types.js";

export interface PluginEntry {
  pluginId: string;
  instance: Plugin;
  config: unknown;
  notifications: { enabled: string[] };
}

export interface AgentInstance {
  id: string;
  agentJson: AgentJson;
  runner: AgentRunner;
  db: AgentDb;
  plugins: Map<string, PluginEntry>;
  /** Convenience reference to the admin plugin's `deliver()` if installed. */
  adminPlugin: import("../plugins/admin/index.js").default | null;
}

/**
 * Loads agents from disk on boot and exposes them by id. Authoring (creating
 * agents, installing plugins, editing configs) is deferred to a later phase
 * — see `docs/v0-deferred.md`. v0: agents are created manually on disk; the
 * server picks them up at boot.
 */
export class AgentManager {
  private agents = new Map<string, AgentInstance>();
  private readonly secrets: SecretsStore;
  private readonly log: Logger;

  constructor(
    private cfg: ServerConfig,
    private registry: PluginRegistry,
    log?: Logger,
  ) {
    this.log = log ?? childLogger("agent-manager");
    this.secrets = new SecretsStore(join(harnessRoot(cfg), "secrets.json"));
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
        await this.load(id);
      } catch (err) {
        this.log.error({ err, id }, "failed to load agent");
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const inst of this.agents.values()) {
      for (const e of inst.plugins.values()) {
        try {
          await e.instance.stop();
        } catch (err) {
          this.log.warn({ err, agent: inst.id, plugin: e.pluginId }, "stop failed");
        }
      }
      await inst.runner.stop();
      inst.db.close();
    }
    this.agents.clear();
  }

  get(id: string): AgentInstance | undefined {
    return this.agents.get(id);
  }

  list(): AgentSummary[] {
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      name: a.agentJson.name,
      installedPlugins: [...a.plugins.keys()],
    }));
  }

  // ── load one agent ─────────────────────────────────────────────────

  private async load(id: string): Promise<AgentInstance> {
    const dir = agentDir(this.cfg, id);
    const agentJson = JSON.parse(
      readFileSync(join(dir, "agent.json"), "utf8"),
    ) as AgentJson;

    mkdirSync(join(dir, "sessions"), { recursive: true });
    const db = new AgentDb(join(dir, "sessions", ".queue.db"), id);

    const inst: AgentInstance = {
      id,
      agentJson,
      runner: undefined as unknown as AgentRunner,
      db,
      plugins: new Map(),
      adminPlugin: null,
    };

    inst.runner = new AgentRunner({
      rootDir: this.cfg.rootDir,
      harnessId: this.cfg.harnessId,
      agentId: id,
      agentJson,
      db,
      serverBaseUrl: this.cfg.serverBaseUrl,
      timezone: this.cfg.timezone,
      envSecrets: this.secrets.resolveAll(id),
      log: childLogger(`agent:${id}`),
    });

    const pluginsDir = join(dir, "plugins");
    if (existsSync(pluginsDir)) {
      const ids = readdirSync(pluginsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name);
      for (const pid of ids) {
        try {
          await this.startPluginInstance(inst, pid);
        } catch (err) {
          this.log.error({ err, agent: id, plugin: pid }, "failed to start plugin");
        }
      }
    }

    inst.runner.start();
    this.agents.set(id, inst);
    this.log.info({ agentId: id, plugins: [...inst.plugins.keys()] }, "agent loaded");
    return inst;
  }

  // ── plugin start helper ───────────────────────────────────────────

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
    checkRequiredSecrets(entry.manifest, resolvedSecrets, {
      agentId: inst.id,
      pluginId,
    });

    const log = childLogger(`plugin:${inst.id}:${pluginId}`);
    const pluginInstance = new entry.ctor();

    const stateDir = join(pdir, "state");
    const inboxDir = join(pdir, "inbox");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(inboxDir, { recursive: true });

    const pluginEntry: PluginEntry = {
      pluginId,
      instance: pluginInstance,
      config,
      notifications,
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
          inst.runner.notify({
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
      inst.adminPlugin = pluginInstance as import("../plugins/admin/index.js").default;
    }
  }
}

function manifestSecretKeys(m: { secretsSchema: { properties?: object } }): string[] {
  return Object.keys(m.secretsSchema.properties ?? {});
}
