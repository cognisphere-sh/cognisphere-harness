#!/usr/bin/env node
// prepack — bundle the assets the published package needs but that live
// outside the package dir in the monorepo: the built web UI (sibling `web`
// package) and the repo-root CHANGELOG (read by `cognisphere upgrade`).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, ".."); // packages/harness

// 1. Build the web UI and copy its dist into the package as dist-web/.
const webDist = resolve(pkgRoot, "..", "web", "dist");
const distWeb = resolve(pkgRoot, "dist-web");
console.log("[prepack] building cognisphere-web …");
execFileSync("pnpm", ["--filter", "cognisphere-web", "build"], {
  stdio: "inherit",
});
if (!existsSync(webDist)) {
  console.error(`[prepack] expected web build at ${webDist} — aborting`);
  process.exit(1);
}
rmSync(distWeb, { recursive: true, force: true });
cpSync(webDist, distWeb, { recursive: true });
console.log(`[prepack] ${webDist} → ${distWeb}`);

// 2. Copy the repo-root CHANGELOG so the upgrade command can read it from an
//    installed package.
const changelog = resolve(pkgRoot, "..", "..", "CHANGELOG.md");
if (existsSync(changelog)) {
  cpSync(changelog, resolve(pkgRoot, "CHANGELOG.md"));
  console.log("[prepack] CHANGELOG.md bundled");
}
