import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

export interface ServerConfig {
  rootDir: string;
  harnessId: string;
  port: number;
  serverBaseUrl: string;
  /** Mutable: PUT /api/harness updates this in place so subsequent agent
   *  reloads pick up the new value without restarting the server. */
  timezone: string;
  bindHost: string;
}

export function loadConfig(): ServerConfig {
  const rootDir =
    process.env.PIHARNESS_ROOT_DIR ?? join(homedir(), ".piharness");
  const harnessId = process.env.PIHARNESS_ID ?? "default";
  const port = Number(process.env.PORT ?? 7331);
  const bindHost = process.env.BIND_HOST ?? "127.0.0.1";
  const serverBaseUrl =
    process.env.SERVER_BASE_URL ?? `http://${bindHost}:${port}`;
  const timezone = readTimezoneFromHarnessJson(rootDir, harnessId);
  return { rootDir, harnessId, port, serverBaseUrl, timezone, bindHost };
}

export function harnessRoot(cfg: ServerConfig): string {
  return join(cfg.rootDir, cfg.harnessId);
}

/** Path of the harness-wide settings file (currently just `{ timezone }`). */
export function harnessJsonFile(cfg: ServerConfig): string {
  return join(harnessRoot(cfg), "harness.json");
}

function readTimezoneFromHarnessJson(rootDir: string, harnessId: string): string {
  const path = join(rootDir, harnessId, "harness.json");
  if (!existsSync(path)) return "UTC";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      timezone?: unknown;
    };
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.timezone === "string" &&
      parsed.timezone.length > 0
    ) {
      return parsed.timezone;
    }
  } catch {
    // fall through to default
  }
  return "UTC";
}

export function agentsRoot(cfg: ServerConfig): string {
  return join(harnessRoot(cfg), "agents");
}

export function agentDir(cfg: ServerConfig, agentId: string): string {
  return join(agentsRoot(cfg), agentId);
}

export function userPluginsRoot(cfg: ServerConfig): string {
  return join(harnessRoot(cfg), "plugins");
}
