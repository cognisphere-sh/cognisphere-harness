import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { join } from "node:path";
import type { AgentManager } from "../core/agent-manager.js";
import type { ServerConfig } from "../core/config.js";
import { secretsRoot } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import { PROVIDER_CATALOG } from "../core/models-catalog.js";
import { ModelsStore } from "../core/models-store.js";
import { OAuthLoginManager } from "../core/oauth-logins.js";
import type { CredField, ProviderConfig } from "../core/types.js";
import {
  applyMaskedPut,
  MASK,
  maskCredential,
  requiredCredentialsPresent,
} from "./credentials.js";

/**
 * /api/models — global (cross-agent) provider + model configuration.
 *
 *   GET  /  → { providers: ProviderInfo[], path, mask }
 *   PUT  /  → write models.json
 *
 * OAuth subscription login (catalog entries with `oauth: true`):
 *
 *   POST   /oauth/:provider/login   → start flow, returns { state, url, instructions }
 *   POST   /oauth/:provider/input   → paste redirect URL / auth code { value }
 *   POST   /oauth/:provider/cancel  → abort a pending flow
 *   GET    /oauth/:provider/status  → poll { state, url?, instructions?, message? }
 *   DELETE /oauth/:provider         → sign out (remove stored tokens)
 *
 * OAuth tokens live in pi's own auth.json, not models.json — see
 * `oauth-logins.ts` for the design rationale.
 *
 * The catalog (provider IDs, credential schemas, default model lists)
 * is fixed in code; the persisted config only stores per-provider
 * `credentials` (a Record<string,string>), `enabledModels` (which
 * may include custom IDs not in the catalog), and optional
 * `modelOverrides` (per-model contextWindow/maxTokens tweaks layered
 * over pi-ai's built-in catalog; `null` per model deletes the entry).
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

export interface ProviderInfo {
  id: string;
  displayName: string;
  credentials: CredField[];
  /** Per-field current value: secrets shown as MASK if set / "" if unset; non-secrets shown plain. */
  credentialValues: Record<string, string>;
  /** All required fields populated (or subscription OAuth connected). */
  configured: boolean;
  catalogModels: string[];
  enabledModels: string[];
  modelOverrides: Record<string, { contextWindow?: number; maxTokens?: number }>;
  notes?: string;
  /** Present only for providers with subscription OAuth support. */
  oauth?: { supported: true; connected: boolean };
}

type PutBody = {
  providers?: Record<
    string,
    {
      credentials?: Record<string, string | null>;
      enabledModels?: string[];
      modelOverrides?: Record<
        string,
        { contextWindow?: number; maxTokens?: number } | null
      >;
    }
  >;
};

/**
 * Restart every running agent whose `model.provider` is in `providerIds`
 * so new credentials reach the pi runtime without a server bounce.
 */
async function reloadAgentsUsingProviders(
  am: AgentManager,
  providerIds: Set<string>,
): Promise<string[]> {
  const restarted: string[] = [];
  for (const a of am.list()) {
    const inst = am.get(a.id);
    const provider = inst?.agentJson?.model?.provider;
    if (!provider || !providerIds.has(provider)) continue;
    const reloaded = await am.reloadAgent(a.id);
    if (reloaded && reloaded.state === "running") restarted.push(a.id);
  }
  return restarted;
}

export function modelsRouter(
  am: AgentManager,
  cfg: ServerConfig,
  log: Logger,
): Hono {
  const r = new Hono();
  const path = join(secretsRoot(cfg), "models.json");
  const store = new ModelsStore(path);
  const oauth = new OAuthLoginManager(log, (providerId) => {
    void reloadAgentsUsingProviders(am, new Set([providerId])).then(
      (restarted) =>
        log.info({ providerId, restarted }, "oauth connected; agents reloaded"),
    );
  });

  r.get("/", (c) => {
    const data = store.load();
    const providers: ProviderInfo[] = PROVIDER_CATALOG.map((entry) => {
      const cfgEntry = data.providers[entry.id];
      const stored = cfgEntry?.credentials ?? {};
      const values: Record<string, string> = {};
      for (const field of entry.credentials) {
        values[field.key] = maskCredential(stored[field.key], field.secret);
      }
      const requiredOk = requiredCredentialsPresent(entry.credentials, stored);
      const oauthConnected =
        entry.oauth === true &&
        readStoredCredential(entry.id)?.type === "oauth";
      // OAuth-only providers (no cred fields) are configured iff connected;
      // otherwise OAuth connection satisfies missing required fields.
      const configured =
        entry.credentials.length === 0
          ? oauthConnected
          : requiredOk || oauthConnected;
      return {
        id: entry.id,
        displayName: entry.displayName,
        credentials: entry.credentials,
        credentialValues: values,
        configured,
        catalogModels: entry.models,
        enabledModels: cfgEntry?.enabledModels ?? [],
        modelOverrides: cfgEntry?.modelOverrides ?? {},
        notes: entry.notes,
        oauth: entry.oauth
          ? { supported: true as const, connected: oauthConnected }
          : undefined,
      };
    });
    return c.json({ providers, path, mask: MASK });
  });

  // ── OAuth subscription login ─────────────────────────────────────
  const oauthEntry = async (providerId: string) => {
    const entry = PROVIDER_CATALOG.find((p) => p.id === providerId);
    return entry?.oauth && (await oauth.supported(providerId))
      ? entry
      : undefined;
  };

  r.post("/oauth/:provider/login", async (c) => {
    const providerId = c.req.param("provider");
    if (!(await oauthEntry(providerId))) {
      return c.json({ error: `provider ${providerId} does not support OAuth` }, 404);
    }
    const state = await oauth.start(providerId);
    return c.json(state);
  });

  r.post("/oauth/:provider/input", async (c) => {
    const providerId = c.req.param("provider");
    const body = (await c.req.json().catch(() => null)) as {
      value?: string;
      kind?: string;
    } | null;
    if (!body || typeof body.value !== "string" || body.value.length === 0) {
      return c.json({ error: "expected { value: string, kind?: 'text'|'select' }" }, 400);
    }
    const kind = body.kind === "select" ? "select" : "text";
    if (!oauth.submitInput(providerId, body.value, kind)) {
      return c.json({ error: "no pending login awaiting input" }, 409);
    }
    return c.json({ ok: true });
  });

  r.post("/oauth/:provider/cancel", async (c) => {
    await oauth.cancel(c.req.param("provider"));
    return c.json({ ok: true });
  });

  r.get("/oauth/:provider/status", (c) => {
    return c.json(oauth.status(c.req.param("provider")));
  });

  r.delete("/oauth/:provider", async (c) => {
    const providerId = c.req.param("provider");
    if (!(await oauthEntry(providerId))) {
      return c.json({ error: `provider ${providerId} does not support OAuth` }, 404);
    }
    await oauth.cancel(providerId);
    await oauth.logout(providerId);
    const restarted = await reloadAgentsUsingProviders(am, new Set([providerId]));
    log.info({ providerId, restarted }, "oauth signed out; agents reloaded");
    return c.json({ ok: true, restarted });
  });

  r.put("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as PutBody | null;
    if (!body || !body.providers || typeof body.providers !== "object") {
      return c.json(
        {
          error:
            'expected { providers: { <providerId>: { credentials?: Record<string,string|null>, enabledModels?: string[], modelOverrides?: Record<string,{contextWindow?,maxTokens?}|null> } } }',
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
          // Empty string clears the field, same as null.
          applyMaskedPut(nextCreds, k, v === "" ? null : v);
        }
      }
      target.credentials = nextCreds;

      if (Array.isArray(payload.enabledModels)) {
        target.enabledModels = payload.enabledModels.filter(
          (m): m is string => typeof m === "string" && m.length > 0,
        );
      }

      // Merge per model; `null` deletes. Value validation (finite,
      // positive numbers) is store.save()'s normalize().
      if (payload.modelOverrides && typeof payload.modelOverrides === "object") {
        const next = { ...(target.modelOverrides ?? {}) };
        for (const [modelId, o] of Object.entries(payload.modelOverrides)) {
          if (o === null) delete next[modelId];
          else next[modelId] = o;
        }
        if (Object.keys(next).length > 0) target.modelOverrides = next;
        else delete target.modelOverrides;
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
    const restarted = await reloadAgentsUsingProviders(am, changedProviders);
    log.info(
      { providers: [...changedProviders], restarted },
      "models updated; agents reloaded",
    );
    return c.json({ ok: true, restartRequired: false, restarted });
  });

  return r;
}
