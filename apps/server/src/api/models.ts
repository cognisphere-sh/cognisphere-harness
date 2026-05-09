import { Hono } from "hono";
import { join } from "node:path";
import type { AgentManager } from "../agent-manager.js";
import type { ServerConfig } from "../config.js";
import { harnessRoot } from "../config.js";
import type { Logger } from "../logger.js";
import { PROVIDER_CATALOG } from "../models-catalog.js";
import { ModelsStore } from "../models-store.js";
import type { ProviderConfig } from "../types.js";

/**
 * /api/models — global (cross-agent) provider + model configuration.
 *
 *   GET  /  → { providers: ProviderInfo[], path, mask }
 *   PUT  /  → write models.json (sentinel `null` clears apiKey, MASK leaves it)
 *
 * The catalog (provider IDs, env var names, default model lists) is
 * fixed in code; the persisted config only stores per-provider apiKey
 * and enabledModels (which may include custom IDs not in the catalog).
 *
 * v0: api keys are plaintext on disk. The runner injects each
 * configured provider's `envVar` into the spawned pi child if the
 * agent's `model.provider` matches.
 */

const MASK = "********";

export interface ProviderInfo {
  id: string;
  displayName: string;
  envVar: string;
  catalogModels: string[];
  enabledModels: string[];
  apiKey: string;
  apiKeyConfigured: boolean;
}

type PutBody = {
  providers?: Record<
    string,
    { apiKey?: string | null; enabledModels?: string[] }
  >;
};

export function modelsRouter(
  am: AgentManager,
  cfg: ServerConfig,
  log: Logger,
): Hono {
  const r = new Hono();
  const path = join(harnessRoot(cfg), "models.json");
  const store = new ModelsStore(path);

  r.get("/", (c) => {
    const data = store.load();
    const providers: ProviderInfo[] = PROVIDER_CATALOG.map((entry) => {
      const cfgEntry = data.providers[entry.id];
      const has = !!cfgEntry?.apiKey;
      return {
        id: entry.id,
        displayName: entry.displayName,
        envVar: entry.envVar,
        catalogModels: entry.models,
        enabledModels: cfgEntry?.enabledModels ?? [],
        apiKey: has ? MASK : "",
        apiKeyConfigured: has,
      };
    });
    return c.json({ providers, path, mask: MASK });
  });

  r.put("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as PutBody | null;
    if (!body || !body.providers || typeof body.providers !== "object") {
      return c.json(
        {
          error:
            'expected { providers: { <providerId>: { apiKey?: string | null, enabledModels?: string[] } } }',
        },
        400,
      );
    }
    const known = new Set(PROVIDER_CATALOG.map((p) => p.id));
    const existing = store.load();
    const merged: Record<string, ProviderConfig> = { ...existing.providers };

    for (const [pid, payload] of Object.entries(body.providers)) {
      if (!known.has(pid)) continue;
      if (!payload || typeof payload !== "object") continue;
      const target: ProviderConfig = merged[pid] ?? {
        apiKey: "",
        enabledModels: [],
      };
      if ("apiKey" in payload) {
        if (payload.apiKey === null) target.apiKey = "";
        else if (payload.apiKey === MASK) {
          // unchanged — leave existing apiKey intact
        } else if (typeof payload.apiKey === "string") {
          target.apiKey = payload.apiKey;
        }
      }
      if (Array.isArray(payload.enabledModels)) {
        target.enabledModels = payload.enabledModels.filter(
          (m): m is string => typeof m === "string" && m.length > 0,
        );
      }
      merged[pid] = target;
    }

    store.save({ providers: merged });

    // Restart every running agent whose model.provider matches one we
    // just touched, so the new key/allowlist reaches the pi runtime
    // without a server bounce. Agents using providers outside this PUT
    // are left alone.
    const changedProviders = new Set(
      Object.keys(body.providers).filter((p) => known.has(p)),
    );
    const restarted: string[] = [];
    for (const a of am.list()) {
      const inst = am.get(a.id);
      const provider = inst?.agentJson?.model?.provider;
      if (!provider || !changedProviders.has(provider)) continue;
      const reloaded = await am.reloadAgent(a.id);
      if (reloaded && reloaded.state === "running") restarted.push(a.id);
    }
    log.info(
      { providers: [...changedProviders], restarted },
      "models updated; agents reloaded",
    );
    return c.json({ ok: true, restartRequired: false, restarted });
  });

  return r;
}
