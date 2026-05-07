/**
 * Secrets resolution for plugin instances.
 *
 * v0: file-based, plaintext. Read from `<harnessRoot>/secrets.json` at
 * boot (cached per process). Format:
 *   {
 *     "<agentId>": {
 *       "<pluginId>": { "<KEY>": "<value>", ... }
 *     }
 *   }
 *
 * Top-level keys starting with `_` are ignored — used for inline docs in
 * the auto-created placeholder. Encryption is deferred — see HLD §15.
 *
 * Edits require a server restart to take effect.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Bucket = Record<string, string>;
type AgentBuckets = Record<string, Bucket>;
type Secrets = Record<string, AgentBuckets>;

const PLACEHOLDER_CONTENT = `{
  "_format": "{ <agentId>: { <pluginId>: { <KEY>: <value> } } }",
  "_usage": "Edit this file with real entries, then restart the server. Keys starting with _ are ignored.",
  "_example": {
    "<your-agent-id>": {
      "telegram": {
        "TELEGRAM_BOT_TOKEN": "paste-your-bot-token-here"
      },
      "gmail": {
        "GMAIL_OAUTH_TOKEN": "paste-your-oauth-token-here"
      }
    }
  }
}
`;

export class SecretsStore {
  private cache: Secrets | null = null;

  constructor(private readonly filePath: string) {}

  resolve(
    agentId: string,
    pluginId: string,
    declaredKeys: string[],
  ): Record<string, string> {
    const data = this.load();
    const bucket = data[agentId]?.[pluginId] ?? {};
    const out: Record<string, string> = {};
    for (const key of declaredKeys) {
      const raw = bucket[key];
      if (typeof raw === "string" && raw.length > 0) {
        out[key] = raw;
      }
    }
    return out;
  }

  /**
   * Flatten every secret bucket under `<agentId>` into a single bare-key map,
   * for export into the agent's pi-runtime env. Plugin authors should
   * namespace their key names (e.g. `TELEGRAM_BOT_TOKEN`, `GMAIL_OAUTH_TOKEN`)
   * to avoid collisions across plugins; on collision, last-writer-wins by
   * iteration order.
   */
  resolveAll(agentId: string): Record<string, string> {
    const data = this.load();
    const buckets = data[agentId] ?? {};
    const out: Record<string, string> = {};
    for (const bucket of Object.values(buckets)) {
      for (const [k, v] of Object.entries(bucket)) {
        if (typeof v === "string" && v.length > 0) out[k] = v;
      }
    }
    return out;
  }

  /** Path of the file backing this store; useful for error messages. */
  path(): string {
    return this.filePath;
  }

  private load(): Secrets {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, PLACEHOLDER_CONTENT, { mode: 0o600 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (err) {
      throw new Error(
        `secrets file ${this.filePath} is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `secrets file ${this.filePath} must be a JSON object at top level`,
      );
    }
    const filtered: Secrets = {};
    for (const [aid, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (aid.startsWith("_")) continue;
      if (!val || typeof val !== "object" || Array.isArray(val)) continue;
      filtered[aid] = val as AgentBuckets;
    }
    this.cache = filtered;
    return filtered;
  }
}
