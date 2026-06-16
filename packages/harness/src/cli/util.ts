/**
 * Shared helpers for the `cognisphere` CLI. The CLI runs in two contexts:
 *
 *  1. Bootstrap — `npx @cognisphere-sh/cognisphere-harness init <id>` (no harness yet).
 *  2. Inside an installed harness — cwd is the harness data dir, which has a
 *     `package.json` depending on the harness and `node_modules/.../cli`.
 *
 * `PKG_ROOT` is the package root (holds `package.json` and the bundled
 * `dist-web/` + `CHANGELOG.md`); `SRC_ROOT` is `src/` inside it (the engine,
 * `plugins/`, and `base-agent/`).
 */
import {
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_PLUGIN_IDS } from "../core/plugin-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // src/cli

/** Package root — `.../node_modules/@cognisphere-sh/cognisphere-harness` when
 *  installed, or `packages/harness` in the monorepo. Holds `package.json` and
 *  the bundled `dist-web/` + `CHANGELOG.md`. */
export const PKG_ROOT = resolve(HERE, "..", "..");

/** Source root (`src/`) — the engine, plugins, and base template. */
const SRC_ROOT = resolve(HERE, "..");

/** Plugins shipped with the package (the catalog + core plugins). */
export const BUILTIN_PLUGINS_DIR = join(SRC_ROOT, "plugins");

/** The single base template every agent forks from. */
export const BASE_AGENT_DIR = join(SRC_ROOT, "base-agent");

/** The server process entrypoint. */
export const MAIN_TS = join(SRC_ROOT, "core", "main.ts");

/** Core plugins are bundled and resolved from the package; forking them is a
 *  footgun, so `plugin add` refuses these ids. */
export const CORE_PLUGINS = new Set<string>(CORE_PLUGIN_IDS);

/** Version of the installed harness package (source of truth for `init`). */
export function packageVersion(): string {
  const pkg = readJson<{ version?: string }>(join(PKG_ROOT, "package.json"));
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

/** The CHANGELOG the upgrade command reads — shipped in the package, with a
 *  monorepo fallback for in-repo dev runs. */
export function changelogPath(): string | null {
  const shipped = join(PKG_ROOT, "CHANGELOG.md");
  if (existsSync(shipped)) return shipped;
  const repoRoot = resolve(PKG_ROOT, "..", "..", "CHANGELOG.md");
  if (existsSync(repoRoot)) return repoRoot;
  return null;
}

// ── stdio ───────────────────────────────────────────────────────────────

export function info(msg: string): void {
  process.stdout.write(msg + "\n");
}

export function fail(msg: string): never {
  process.stderr.write(`cognisphere: ${msg}\n`);
  process.exit(1);
}

// ── JSON / fs ─────────────────────────────────────────────────────────────

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function copyDir(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true });
}

// ── harness-dir resolution ────────────────────────────────────────────────

export interface HarnessDir {
  /** Absolute path of the harness data dir (the cwd). */
  dir: string;
  /** `COGNISPHERE_ROOT_DIR` derived from the dir. */
  rootDir: string;
  /** `COGNISPHERE_ID` derived from the dir. */
  id: string;
}

/**
 * Resolve the harness the command operates on: the current working directory.
 * A harness is identified by its `harness.json`. Fails with a hint when the
 * cwd is not a harness dir.
 */
export function requireHarnessDir(): HarnessDir {
  const dir = process.cwd();
  if (!existsSync(join(dir, "harness.json"))) {
    fail(
      `${dir} is not a harness dir (no harness.json).\n` +
        `  cd into a harness, or create one with: cognisphere init <id>`,
    );
  }
  return { dir, rootDir: dirname(dir), id: basename(dir) };
}

// ── subprocess ────────────────────────────────────────────────────────────

/** Run a command inheriting stdio; return its exit status (or 1 on spawn error). */
export function run(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): number {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: env ?? process.env,
  });
  if (res.error) return 1;
  return res.status ?? 0;
}

// ── version compare (numeric major.minor.patch; prerelease ignored) ─────────

function parts(v: string): [number, number, number] {
  const core = v.replace(/^v/, "").split("-")[0] ?? "0";
  const [a, b, c] = core.split(".");
  return [Number(a) || 0, Number(b) || 0, Number(c) || 0];
}

/** -1 if a<b, 0 if equal, 1 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
