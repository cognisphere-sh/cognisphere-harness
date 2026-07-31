/**
 * Mirror `.secrets/models.json` `modelOverrides` into pi's own models.json
 * (`<getAgentDir()>/models.json`, i.e. `~/.pi/agent/models.json` unless
 * `PI_CODING_AGENT_DIR` overrides it). Pi children re-read that file on
 * every spawn, so overrides configured in the harness Models settings take
 * effect natively inside pi — model registry, ContextUsage reporting, and
 * pi's own compaction thresholds all see the overridden contextWindow /
 * maxTokens, exactly as if the operator had hand-written pi's models.json.
 *
 * Ownership contract: for every provider present in the harness store,
 * the `modelOverrides` key of pi's models.json is HARNESS-OWNED — replaced
 * wholesale on each sync, and removed when the store has none — so
 * deleting an override in the harness UI also clears it from pi. All other
 * providers, and all other fields of a provider entry (baseUrl, apiKey,
 * models, ...), are preserved untouched.
 *
 * Called on agent start and after PUT /api/models. Best-effort: a corrupt
 * pi models.json is left alone (logged), never clobbered.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Logger } from "./logger.js";
import type { ModelsStore } from "./models-store.js";

export function syncPiModelOverrides(models: ModelsStore, log: Logger): void {
  const piModelsPath = join(getAgentDir(), "models.json");
  let piCfg: { providers?: Record<string, Record<string, unknown>> } = {};
  if (existsSync(piModelsPath)) {
    try {
      piCfg = JSON.parse(readFileSync(piModelsPath, "utf8")) as typeof piCfg;
    } catch (err) {
      log.warn({ err, path: piModelsPath }, "pi models.json unreadable; skipping override sync");
      return;
    }
  }
  const before = JSON.stringify(piCfg);
  const providers = { ...(piCfg.providers ?? {}) };

  for (const [providerId, cfg] of Object.entries(models.load().providers)) {
    const overrides = cfg.modelOverrides ?? {};
    const entry = { ...(providers[providerId] ?? {}) };
    if (Object.keys(overrides).length > 0) {
      entry.modelOverrides = overrides;
    } else {
      delete entry.modelOverrides;
    }
    if (Object.keys(entry).length > 0) providers[providerId] = entry;
    else delete providers[providerId];
  }

  const next = { ...piCfg, providers };
  if (Object.keys(next.providers).length === 0) delete (next as { providers?: unknown }).providers;
  if (JSON.stringify(next) === before) return;

  mkdirSync(getAgentDir(), { recursive: true });
  writeFileSync(piModelsPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  log.info({ path: piModelsPath }, "synced model overrides into pi models.json");
}

/**
 * Resolve a model's context window the way a spawned pi child would:
 * pi models.json `modelOverrides` first, then a custom model entry in
 * that file's `models` list, then pi-ai's built-in catalog. This is the
 * single lookup the harness API uses for reporting, so the dashboard and
 * the in-context ContextUsage telemetry can never disagree — pi-ai (as
 * configured by the synced models.json) is the sole source of truth.
 *
 * The file is tiny but this is called from the 5s-polled threads list,
 * so reads are mtime-cached.
 */
interface PiProviderEntry {
  modelOverrides?: Record<string, { contextWindow?: unknown }>;
  models?: Array<{ id?: unknown; contextWindow?: unknown }>;
}

let piModelsCache: { mtimeMs: number; providers: Record<string, PiProviderEntry> } | null = null;

function readPiProviders(): Record<string, PiProviderEntry> {
  const path = join(getAgentDir(), "models.json");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    piModelsCache = null;
    return {};
  }
  if (piModelsCache?.mtimeMs === mtimeMs) return piModelsCache.providers;
  let providers: Record<string, PiProviderEntry> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { providers?: unknown };
    if (parsed.providers && typeof parsed.providers === "object") {
      providers = parsed.providers as Record<string, PiProviderEntry>;
    }
  } catch {
    // Corrupt file: fall through to built-in catalog only.
  }
  piModelsCache = { mtimeMs, providers };
  return providers;
}

export function resolveContextWindow(provider: string, modelId: string): number | null {
  if (!provider || !modelId) return null;
  const entry = readPiProviders()[provider];
  const override = entry?.modelOverrides?.[modelId]?.contextWindow;
  if (typeof override === "number" && override > 0) return override;
  const custom = entry?.models?.find((m) => m?.id === modelId)?.contextWindow;
  if (typeof custom === "number" && custom > 0) return custom;
  // pi-ai's `getBuiltinModel` is generic over a literal model-id union; we
  // cast to a dynamic signature since the runtime impl is just a Map lookup
  // that returns undefined on miss.
  const fn = getBuiltinModel as unknown as (
    p: string,
    m: string,
  ) => { contextWindow?: number } | undefined;
  return fn(provider, modelId)?.contextWindow ?? null;
}
