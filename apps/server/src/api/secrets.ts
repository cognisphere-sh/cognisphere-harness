import { Hono } from "hono";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ServerConfig } from "../config.js";
import { secretsRoot } from "../config.js";
import type { AgentManager } from "../agent-manager.js";
import { AGENT_BUCKET } from "../secrets.js";
import type { Logger } from "../logger.js";

/**
 * /api/secrets — view (masked) and edit the harness secrets file.
 *
 *   GET  /  → { secrets, schemas, agentBucket, mask, path }
 *   PUT  /  → write file (sentinel `null` clears a key, MASK leaves it)
 *
 * Wire and on-disk shapes are identical: one bucket per scope under each
 * agent, with the reserved bucket id `agent` (= `agentBucket` in the
 * response) holding agent-level secrets and other ids being plugin ids.
 *
 *   secrets[agentId][bucketId][KEY] = maskedString
 *   schemas[agentId][bucketId]     = JsonSchema
 *
 * v0 stores plaintext on disk (HLD §15). Runtime exposes resolved values
 * to the pi child as env vars on every spawn, so a value change requires
 * a server restart to take effect — the UI surfaces this caveat.
 */

type Bucket = Record<string, string>;
type AgentBuckets = Record<string, Bucket>;
type Secrets = Record<string, AgentBuckets>;

type PutBucket = Record<string, string | null>;
type PutAgent = Record<string, PutBucket>;

const MASK = "********";

export function secretsRouter(am: AgentManager, cfg: ServerConfig, log: Logger): Hono {
  const r = new Hono();
  const path = join(secretsRoot(cfg), "secrets.json");

  r.get("/", (c) => {
    const data = readSecrets(path);

    // Mask every value. Same shape in, same shape out.
    const masked: Secrets = {};
    for (const [aid, agentBuckets] of Object.entries(data)) {
      if (aid.startsWith("_")) continue;
      const out: AgentBuckets = {};
      for (const [bid, bucket] of Object.entries(agentBuckets)) {
        const m: Bucket = {};
        for (const [k, v] of Object.entries(bucket)) {
          m[k] = v && typeof v === "string" ? MASK : "";
        }
        out[bid] = m;
      }
      masked[aid] = out;
    }

    // Schemas: one map of the same shape. Agent-level under AGENT_BUCKET,
    // plugin-level under the plugin id. `inst.plugins` includes both
    // successfully-started and failed-validation entries, so plugins that
    // failed due to missing secrets still surface their schema — otherwise
    // the operator would have nothing to fill in to fix it.
    const schemas: Record<string, Record<string, unknown>> = {};
    for (const a of am.list()) {
      const inst = am.get(a.id);
      if (!inst) continue;
      const perBucket: Record<string, unknown> = {};
      if (inst.agentJson?.secretsSchema) {
        perBucket[AGENT_BUCKET] = inst.agentJson.secretsSchema;
      }
      for (const pid of inst.plugins.keys()) {
        const manifest = am.getPluginManifest(pid);
        if (manifest) perBucket[pid] = manifest.secretsSchema;
      }
      schemas[a.id] = perBucket;
      // Surface the agent in the secrets map even with nothing on disk yet.
      if (!masked[a.id]) masked[a.id] = {};
    }

    return c.json({
      secrets: masked,
      schemas,
      agentBucket: AGENT_BUCKET,
      mask: MASK,
      path,
    });
  });

  r.put("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      secrets?: Record<string, PutAgent>;
    } | null;
    if (!body || !body.secrets || typeof body.secrets !== "object") {
      return c.json(
        {
          error:
            'expected { secrets: { agentId: { bucketId: { KEY: value | null } } } }',
        },
        400,
      );
    }

    const existing = readSecrets(path);
    const merged: Secrets = {};
    for (const [aid, val] of Object.entries(existing)) {
      if (aid.startsWith("_")) continue;
      merged[aid] = JSON.parse(JSON.stringify(val)) as AgentBuckets;
    }

    for (const [aid, payload] of Object.entries(body.secrets)) {
      if (aid.startsWith("_")) continue;
      if (!payload || typeof payload !== "object") continue;
      const target = (merged[aid] ??= {});
      for (const [bid, bucket] of Object.entries(payload)) {
        if (!bucket || typeof bucket !== "object") continue;
        const tBucket = (target[bid] ??= {});
        for (const [k, v] of Object.entries(bucket)) {
          if (v === null) delete tBucket[k];
          else if (v === MASK) {
            // unchanged — keep existing value
          } else if (typeof v === "string") tBucket[k] = v;
        }
      }
    }

    // Round-trip the file with `_format` / `_usage` from the existing file
    // preserved at the top, since they were stripped by readSecrets.
    const docHeader = readDocHeader(path);
    const out: Record<string, unknown> = { ...docHeader, ...merged };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });

    // Reload every agent named in the body so edits reach the running pi
    // runtime without a server bounce. reloadAgent invalidates the
    // secrets cache before restarting; per-agent errors are logged but
    // don't fail the save.
    const restarted: string[] = [];
    for (const aid of Object.keys(body.secrets)) {
      if (aid.startsWith("_")) continue;
      const inst = await am.reloadAgent(aid);
      if (inst && inst.state === "running") restarted.push(aid);
    }
    log.info({ restarted }, "secrets updated; agents reloaded");
    return c.json({ ok: true, restartRequired: false, restarted });
  });

  return r;
}

function readSecrets(path: string): Secrets {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Secrets = {};
    for (const [aid, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (aid.startsWith("_")) continue;
      if (!val || typeof val !== "object" || Array.isArray(val)) continue;
      const buckets: AgentBuckets = {};
      for (const [bid, b] of Object.entries(val)) {
        if (!b || typeof b !== "object" || Array.isArray(b)) continue;
        const bucket: Bucket = {};
        for (const [k, v] of Object.entries(b)) {
          if (typeof v === "string") bucket[k] = v;
        }
        buckets[bid] = bucket;
      }
      out[aid] = buckets;
    }
    return out;
  } catch {
    return {};
  }
}

/** Read the `_*` doc keys at the top of the file so PUT preserves them. */
function readDocHeader(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k.startsWith("_")) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
