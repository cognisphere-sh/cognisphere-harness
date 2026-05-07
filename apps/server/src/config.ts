import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

export interface ServerConfig {
  rootDir: string;
  harnessId: string;
  port: number;
  serverBaseUrl: string;
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
  const timezone = process.env.TZ ?? "UTC";
  return { rootDir, harnessId, port, serverBaseUrl, timezone, bindHost };
}

export function harnessRoot(cfg: ServerConfig): string {
  return join(cfg.rootDir, cfg.harnessId);
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
