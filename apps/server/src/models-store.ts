/**
 * Provider/model configuration backed by `<harnessRoot>/models.json`.
 *
 * Shape on disk:
 *   {
 *     "providers": {
 *       "<providerId>": {
 *         "apiKey": "<plaintext>",
 *         "enabledModels": ["<modelId>", ...]
 *       }
 *     }
 *   }
 *
 * v0: file-based, plaintext (HLD §15). Read on every `load()` so PUT
 * writes are immediately visible to subsequent agent starts. Edits to
 * the in-memory snapshot don't reach already-running agents — matches
 * the secrets store's restart-required model.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelsConfig, ProviderConfig } from "./types.js";

const PLACEHOLDER: ModelsConfig = { providers: {} };

export class ModelsStore {
  constructor(private readonly filePath: string) {}

  path(): string {
    return this.filePath;
  }

  /** Read-through; never cached. Cheap (small file) and keeps PUT trivial. */
  load(): ModelsConfig {
    if (!existsSync(this.filePath)) return { providers: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (err) {
      throw new Error(
        `models file ${this.filePath} is not valid JSON: ${(err as Error).message}`,
      );
    }
    return normalize(parsed);
  }

  save(cfg: ModelsConfig): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify(normalize(cfg), null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  /** Initialize empty file with 0600 perms if missing. */
  ensureExists(): void {
    if (existsSync(this.filePath)) return;
    this.save(PLACEHOLDER);
  }

  getProvider(providerId: string): ProviderConfig | undefined {
    return this.load().providers[providerId];
  }
}

function normalize(input: unknown): ModelsConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { providers: {} };
  }
  const raw = input as { providers?: unknown };
  if (!raw.providers || typeof raw.providers !== "object" || Array.isArray(raw.providers)) {
    return { providers: {} };
  }
  const out: Record<string, ProviderConfig> = {};
  for (const [pid, val] of Object.entries(raw.providers as Record<string, unknown>)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const v = val as { apiKey?: unknown; enabledModels?: unknown };
    const apiKey = typeof v.apiKey === "string" ? v.apiKey : "";
    const enabledModels = Array.isArray(v.enabledModels)
      ? v.enabledModels.filter((m): m is string => typeof m === "string")
      : [];
    out[pid] = { apiKey, enabledModels };
  }
  return { providers: out };
}
