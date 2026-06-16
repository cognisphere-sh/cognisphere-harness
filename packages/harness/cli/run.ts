/**
 * `cognisphere dev` / `cognisphere serve` — run the harness against the current
 * harness dir.
 *
 * - `dev` runs the backend under `tsx --watch` (hot reload) and, when the web
 *   package is available (the monorepo), also starts the Vite dev server (HMR)
 *   with its `/api` proxy pointed at the backend.
 * - `serve` runs the backend once (no watch). The backend serves the prebuilt
 *   web UI (`dist-web/`) itself, so production needs no separate web process.
 *
 * Flags: `--port` (backend, default 7331 / `$PORT`), `--web-port` (Vite dev,
 * default 7330), `--no-web` (dev: skip the Vite dev server), `--headless`
 * (the backend serves no web UI at all — for backend-only deployments).
 *
 * The harness data dir is the cwd, so `COGNISPHERE_ROOT_DIR` / `COGNISPHERE_ID`
 * are derived from it — matching the server's `loadConfig()` resolution.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAIN_TS, PKG_ROOT, fail, info, requireHarnessDir } from "./util.js";

const DEFAULT_PORT = 7331;
const DEFAULT_WEB_PORT = 7330;

/** The web package dir (present only in the monorepo, not in an installed harness). */
const WEB_DIR = resolve(PKG_ROOT, "..", "web");

interface RunOpts {
  port?: number;
  webPort?: number;
  web: boolean;
  headless: boolean;
}

export function cmdRun(mode: "dev" | "serve", argv: string[]): void {
  const opts = parseArgs(argv);
  const { rootDir, id } = requireHarnessDir();
  const port =
    opts.port ?? (process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT);

  const children: ChildProcess[] = [];
  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) if (!c.killed) c.kill("SIGTERM");
    process.exit(code);
  };
  const supervise = (child: ChildProcess): void => {
    children.push(child);
    child.on("exit", (code, signal) => shutdown(code ?? (signal ? 1 : 0)));
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  // Backend. `--import tsx` registers the TS loader from an absolute path
  // (cwd-relative resolution would miss it — the harness dir may have no
  // node_modules); `--watch` is node's own.
  const tsx = createRequire(join(PKG_ROOT, "package.json")).resolve("tsx");
  const backendArgs = ["--import", pathToFileURL(tsx).href];
  if (mode === "dev") backendArgs.push("--watch");
  backendArgs.push(MAIN_TS);
  supervise(
    spawn(process.execPath, backendArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        COGNISPHERE_ROOT_DIR: rootDir,
        COGNISPHERE_ID: id,
        PORT: String(port),
        ...(opts.headless ? { COGNISPHERE_HEADLESS: "1" } : {}),
      },
    }),
  );
  info(`backend:  http://127.0.0.1:${port}`);

  if (opts.headless) {
    info(`web:      disabled (--headless)`);
    return;
  }

  // Web frontend dev server — dev mode only, and only when Vite is installed
  // (i.e. running from the monorepo). An installed harness serves the bundled
  // UI from the backend, so there is no separate frontend process to start.
  if (mode === "dev" && opts.web) {
    const viteBin = resolveViteBin();
    if (viteBin) {
      const webPort = opts.webPort ?? DEFAULT_WEB_PORT;
      supervise(
        spawn(
          process.execPath,
          [viteBin, "--port", String(webPort), "--strictPort"],
          {
            stdio: "inherit",
            cwd: WEB_DIR,
            env: { ...process.env, PI_SERVER_URL: `http://127.0.0.1:${port}` },
          },
        ),
      );
      info(`web:      http://127.0.0.1:${webPort}  (vite dev — /api → :${port})`);
    } else {
      info(`web:      served by the backend at :${port} (bundled UI; no Vite dev server here)`);
    }
  } else if (mode === "serve") {
    info(`web:      served by the backend at :${port} (bundled UI)`);
  }
}

/**
 * Resolve the Vite bin from the web package; null when it isn't installed (an
 * installed harness). Vite's `exports` map blocks deep-resolving the bin
 * directly, so resolve its `package.json` (an allowed export) and read `bin`.
 */
function resolveViteBin(): string | null {
  try {
    const pkgJsonPath = createRequire(join(WEB_DIR, "package.json")).resolve(
      "vite/package.json",
    );
    const bin = (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    }).bin;
    const rel = typeof bin === "string" ? bin : bin?.vite;
    return rel ? resolve(dirname(pkgJsonPath), rel) : null;
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): RunOpts {
  const opts: RunOpts = { web: true, headless: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") {
      opts.port = intArg(argv[++i], "--port");
    } else if (a === "--web-port") {
      opts.webPort = intArg(argv[++i], "--web-port");
    } else if (a === "--no-web") {
      opts.web = false;
    } else if (a === "--headless") {
      opts.headless = true;
    } else {
      fail(`unknown option: ${a}`);
    }
  }
  return opts;
}

function intArg(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n <= 0) fail(`${name} needs a port number`);
  return n;
}
