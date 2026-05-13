import { Hono } from "hono";
import { join } from "node:path";
import type { AgentManager } from "../agent-manager.js";
import type { ServerConfig } from "../config.js";
import { secretsRoot } from "../config.js";
import type { Logger } from "../logger.js";
import { PROVIDER_CATALOG } from "../models-catalog.js";
import { ModelsStore } from "../models-store.js";
import type { CredField, ProviderConfig } from "../types.js";

/**
 * /api/models — global (cross-agent) provider + model configuration.
 *
 *   GET  /  → { providers: ProviderInfo[], path, mask }
 *   PUT  /  → write models.json
 *
 * The catalog (provider IDs, credential schemas, default model lists)
 * is fixed in code; the persisted config only stores per-provider
 * `credentials` (a Record<string,string>) and `enabledModels` (which
 * may include custom IDs not in the catalog).
 *
 * v0: credentials are plaintext on disk. The runner injects each
 * configured provider's env vars into the spawned pi child if the
 * agent's `model.provider` matches.
 *
 * PUT semantics for `credentials[key]`:
 *   - `null`            → delete this field
 *   - `MASK` (string)   → leave existing value untouched
 *   - any other string  → set this value
 */

const MASK = "********";

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

type PutBody = {
  providers?: Record<
    string,
    {
      credentials?: Record<string, string | null>;
      enabledModels?: string[];
    }
  >;
};

export function modelsRouter(
  am: AgentManager,
  cfg: ServerConfig,
  log: Logger,
): Hono {
  const r = new Hono();
  const path = join(secretsRoot(cfg), "models.json");
  const store = new ModelsStore(path);

  r.get("/", (c) => {
    const data = store.load();
    const providers: ProviderInfo[] = PROVIDER_CATALOG.map((entry) => {
      const cfgEntry = data.providers[entry.id];
      const stored = cfgEntry?.credentials ?? {};
      const values: Record<string, string> = {};
      for (const field of entry.credentials) {
        const v = stored[field.key];
        if (typeof v !== "string" || v.length === 0) {
          values[field.key] = "";
        } else if (field.secret) {
          values[field.key] = MASK;
        } else {
          values[field.key] = v;
        }
      }
      const configured = entry.credentials
        .filter((f) => f.required)
        .every((f) => {
          const v = stored[f.key];
          return typeof v === "string" && v.length > 0;
        });
      return {
        id: entry.id,
        displayName: entry.displayName,
        credentials: entry.credentials,
        credentialValues: values,
        configured,
        catalogModels: entry.models,
        enabledModels: cfgEntry?.enabledModels ?? [],
        notes: entry.notes,
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
            'expected { providers: { <providerId>: { credentials?: Record<string,string|null>, enabledModels?: string[] } } }',
        },
        400,
      );
    }
    const catalogById = new Map<string, (typeof PROVIDER_CATALOG)[number]>(
      PROVIDER_CATALOG.map((p) => [p.id, p]),
    );
    const existing = store.load();
    const merged: Record<string, ProviderConfig> = { ...existing.providers };

    for (const [pid, payload] of Object.entries(body.providers)) {
      const entry = catalogById.get(pid);
      if (!entry) continue;
      if (!payload || typeof payload !== "object") continue;

      const target: ProviderConfig = merged[pid] ?? {
        credentials: {},
        enabledModels: [],
      };
      const nextCreds = { ...target.credentials };

      if (payload.credentials && typeof payload.credentials === "object") {
        const validKeys = new Set(entry.credentials.map((f) => f.key));
        for (const [k, v] of Object.entries(payload.credentials)) {
          if (!validKeys.has(k)) continue;
          if (v === null) {
            delete nextCreds[k];
          } else if (v === MASK) {
            // unchanged — leave existing value intact
          } else if (typeof v === "string") {
            if (v.length === 0) delete nextCreds[k];
            else nextCreds[k] = v;
          }
        }
      }
      target.credentials = nextCreds;

      if (Array.isArray(payload.enabledModels)) {
        target.enabledModels = payload.enabledModels.filter(
          (m): m is string => typeof m === "string" && m.length > 0,
        );
      }
      merged[pid] = target;
    }

    store.save({ providers: merged });

    // Restart every running agent whose model.provider matches one we
    // just touched, so the new credentials/allowlist reach the pi
    // runtime without a server bounce.
    const changedProviders = new Set(
      Object.keys(body.providers).filter((p) => catalogById.has(p)),
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
