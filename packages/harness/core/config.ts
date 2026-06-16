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
  /** Data/migration version mirrored from the installed package version.
   *  Written by `cognisphere init`, bumped by the upgrade skill. Empty
   *  string when `harness.json` predates versioning. */
  version: string;
  /** When true, the server does not mount the web UI (API/webhook/admin only).
   *  Set via `COGNISPHERE_HEADLESS` (e.g. `cognisphere serve --headless`). */
  headless: boolean;
}

export function loadConfig(): ServerConfig {
  const rootDir =
    process.env.COGNISPHERE_ROOT_DIR ?? join(homedir(), ".cognisphere");
  const harnessId = process.env.COGNISPHERE_ID ?? "default";
  const port = Number(process.env.PORT ?? 7331);
  const bindHost = process.env.BIND_HOST ?? "127.0.0.1";
  const serverBaseUrl =
    process.env.SERVER_BASE_URL ?? `http://${bindHost}:${port}`;
  const harnessJson = readHarnessJson(rootDir, harnessId);
  const timezone =
    typeof harnessJson.timezone === "string" && harnessJson.timezone.length > 0
      ? harnessJson.timezone
      : "UTC";
  const version =
    typeof harnessJson.version === "string" ? harnessJson.version : "";
  const headless = /^(1|true|yes)$/i.test(process.env.COGNISPHERE_HEADLESS ?? "");
  return {
    rootDir,
    harnessId,
    port,
    serverBaseUrl,
    timezone,
    bindHost,
    version,
    headless,
  };
}

export function harnessRoot(cfg: ServerConfig): string {
  return join(cfg.rootDir, cfg.harnessId);
}

/**
 * Sensitive on-disk files (secrets.json, models.json, users.json,
 * session-key) live under `<harnessRoot>/.secrets/` so the harness root
 * can be a checked-in working directory without leaking credentials.
 */
export function secretsRoot(cfg: ServerConfig): string {
  return join(harnessRoot(cfg), ".secrets");
}

/** Path of the harness-wide settings file (currently just `{ timezone }`). */
export function harnessJsonFile(cfg: ServerConfig): string {
  return join(harnessRoot(cfg), "harness.json");
}

function readHarnessJson(
  rootDir: string,
  harnessId: string,
): { timezone?: unknown; version?: unknown } {
  const path = join(rootDir, harnessId, "harness.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as { timezone?: unknown; version?: unknown };
    }
  } catch {
    // fall through to defaults
  }
  return {};
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
