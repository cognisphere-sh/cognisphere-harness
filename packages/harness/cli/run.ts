/**
 * `cognisphere dev` / `cognisphere serve` — run the harness server against the
 * current harness dir. `dev` adds `--watch` for hot reload; `serve` is the
 * plain production entry (what the systemd unit execs).
 *
 * The harness data dir is the cwd, so `COGNISPHERE_ROOT_DIR` / `COGNISPHERE_ID`
 * are derived from it — matching the server's `loadConfig()` resolution.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MAIN_TS, PKG_ROOT, requireHarnessDir, run } from "./util.js";

export function cmdRun(mode: "dev" | "serve"): void {
  const { rootDir, id } = requireHarnessDir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COGNISPHERE_ROOT_DIR: rootDir,
    COGNISPHERE_ID: id,
  };
  // Register the TypeScript loader from an absolute path: `--import tsx`
  // resolves relative to cwd (the harness dir, which may not have its own
  // node_modules), so resolve tsx from the package root where it's a dep.
  const tsx = createRequire(join(PKG_ROOT, "package.json")).resolve("tsx");
  const args = ["--import", pathToFileURL(tsx).href];
  if (mode === "dev") args.push("--watch");
  args.push(MAIN_TS);
  process.exit(run(process.execPath, args, env));
}
