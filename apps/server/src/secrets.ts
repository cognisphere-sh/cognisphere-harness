/**
 * Secrets resolution for agents and their plugins.
 *
 * v0: file-based, plaintext. Read from `<harnessRoot>/secrets.json` at
 * boot (cached per process). Encryption is deferred — see HLD §15.
 *
 * Format (uniform — every entry under `<agentId>` is a bucket):
 *
 *   {
 *     "<agentId>": {
 *       "agent":     { "<KEY>": "<value>", ... },   ← reserved bucket: agent-level
 *       "<pluginId>": { "<KEY>": "<value>", ... }   ← per-plugin bucket
 *     }
 *   }
 *
 * The bucket name `agent` (constant `AGENT_BUCKET`) is reserved for keys
 * declared in `agent.json.secretsSchema`. Other bucket names are plugin
 * ids; their keys are declared in each plugin's manifest. The same
 * `resolve(agentId, bucketId, ...)` accessor serves both.
 *
 * Top-level keys starting with `_` are ignored — used for inline docs in
 * the auto-created placeholder. PUT /api/secrets calls `invalidate()` and
 * auto-restarts the affected agents so edits reach the pi runtime
 * immediately — no server bounce needed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Reserved bucket id for agent-level secrets (declared in agent.json.secretsSchema). */
export const AGENT_BUCKET = "agent";

type Bucket = Record<string, string>;
type AgentBuckets = Record<string, Bucket>;
type Secrets = Record<string, AgentBuckets>;

const PLACEHOLDER_CONTENT = `{
  "_format": "{ <agentId>: { <bucketId>: { <KEY>: <value> } } }",
  "_usage": "Edit this file with real entries, then restart the server. Bucket id 'agent' is reserved for agent-level secrets (declared in agent.json.secretsSchema); other ids are plugin ids. Keys starting with _ are ignored.",
  "_example": {
    "<your-agent-id>": {
      "agent": {
        "ELEVENLABS_API_KEY": "paste-your-tts/stt-key-here"
      },
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

  /**
   * Resolve a single bucket's declared keys. Pass `AGENT_BUCKET` for
   * agent-level secrets, the plugin id for a plugin's bucket.
   */
  resolve(
    agentId: string,
    bucketId: string,
    declaredKeys: string[],
  ): Record<string, string> {
    const data = this.load();
    const bucket = data[agentId]?.[bucketId] ?? {};
    const out: Record<string, string> = {};
    for (const key of declaredKeys) {
      const raw = bucket[key];
      if (typeof raw === "string" && raw.length > 0) out[key] = raw;
    }
    return out;
  }

  /**
   * Flatten every bucket under `<agentId>` into a single bare-key map for
   * export into the agent's pi-runtime env. Plugin authors should
   * namespace their key names (e.g. `TELEGRAM_BOT_TOKEN`,
   * `GMAIL_OAUTH_TOKEN`) to avoid collisions across buckets; on
   * collision, last-writer-wins by iteration order.
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

  /**
   * Drop the in-memory cache so the next `resolve*` re-reads the file.
   * Called after a PUT /api/secrets so an auto-restarted agent picks
   * up the freshly-edited values without a server bounce.
   */
  invalidate(): void {
    this.cache = null;
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
      const buckets: AgentBuckets = {};
      for (const [bid, b] of Object.entries(val as Record<string, unknown>)) {
        if (!b || typeof b !== "object" || Array.isArray(b)) continue;
        const bucket: Bucket = {};
        for (const [k, v] of Object.entries(b)) {
          if (typeof v === "string") bucket[k] = v;
        }
        buckets[bid] = bucket;
      }
      filtered[aid] = buckets;
    }
    this.cache = filtered;
    return filtered;
  }
}
