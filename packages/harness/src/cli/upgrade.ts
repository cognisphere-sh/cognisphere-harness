/**
 * `cognisphere upgrade` — drive the two-phase upgrade (§9).
 *
 *   cognisphere upgrade                 show the pending data-migration window
 *   cognisphere upgrade --to <version>  phase 1: bump the code dependency
 *   cognisphere upgrade --set-version <v>  phase 2 finalize: stamp harness.json
 *
 * The CLI owns the deterministic parts (dep bump, changelog window, version
 * stamp). The actual data migration — editing prompts/plugins/agent.json to
 * match a new version — is the `/cognisphere-upgrade` coding-agent skill's job.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  changelogPath,
  compareVersions,
  fail,
  info,
  packageVersion,
  readJson,
  requireHarnessDir,
  run,
  writeJson,
} from "./util.js";

export function cmdUpgrade(argv: string[]): void {
  const toIdx = argv.indexOf("--to");
  if (toIdx !== -1) return phaseBump(argv[toIdx + 1]);

  const setIdx = argv.indexOf("--set-version");
  if (setIdx !== -1) return phaseFinalize(argv[setIdx + 1]);

  return showWindow();
}

/** Phase 1 — bump the installed code. */
function phaseBump(version: string | undefined): void {
  if (!version) fail("usage: cognisphere upgrade --to <version>");
  requireHarnessDir();
  info(`Bumping @cognisphere-sh/cognisphere-harness to ${version} …`);
  const status = run("pnpm", ["add", `@cognisphere-sh/cognisphere-harness@${version}`]);
  if (status !== 0) fail("pnpm add failed");
  info("");
  info("Code updated. Next, migrate the harness data:");
  info("  cognisphere upgrade            # review the breaking-change window");
  info("  /cognisphere-upgrade          # run the skill in Claude Code to apply it");
}

/** Phase 2 finalize — stamp the data/migration version after a migration. */
function phaseFinalize(version: string | undefined): void {
  if (!version) fail("usage: cognisphere upgrade --set-version <version>");
  const { dir } = requireHarnessDir();
  const path = join(dir, "harness.json");
  const current = readJson<Record<string, unknown>>(path);
  writeJson(path, { ...current, version });
  info(`harness.json version → ${version}`);
}

/** Default — report the gap between data and code, and print the changelog. */
function showWindow(): void {
  const { dir } = requireHarnessDir();
  const dataVersion =
    readJson<{ version?: string }>(join(dir, "harness.json")).version ?? "";
  const codeVersion = packageVersion();

  info(`data version (harness.json): ${dataVersion || "(unset)"}`);
  info(`code version (installed):    ${codeVersion}`);
  info("");

  if (dataVersion && compareVersions(dataVersion, codeVersion) === 0) {
    info("Up to date — no data migration pending.");
    return;
  }
  if (dataVersion && compareVersions(dataVersion, codeVersion) > 0) {
    info("Data version is ahead of code — install the matching code with:");
    info(`  cognisphere upgrade --to ${dataVersion}`);
    return;
  }

  const sections = changelogWindow(dataVersion, codeVersion);
  if (sections.length === 0) {
    info("No changelog entries in this window. Finalize with:");
    info(`  cognisphere upgrade --set-version ${codeVersion}`);
    return;
  }

  info(`Breaking-change window (${dataVersion || "0"} → ${codeVersion}]:`);
  info("");
  for (const s of sections) info(s);
  info("");
  info("Apply these with the skill, then it will stamp the new version:");
  info("  /cognisphere-upgrade");
}

/** Changelog sections for versions in `(from, to]`, in file order. */
function changelogWindow(from: string, to: string): string[] {
  const path = changelogPath();
  if (!path) return [];
  const text = readFileSync(path, "utf8");

  const out: string[] = [];
  let curVersion: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (curVersion && buf.length) {
      const inRange =
        (!from || compareVersions(curVersion, from) > 0) &&
        compareVersions(curVersion, to) <= 0;
      if (inRange) out.push(buf.join("\n").trimEnd());
    }
    buf = [];
  };

  for (const line of text.split("\n")) {
    const m = /^##\s+\[?v?([0-9]+\.[0-9]+\.[0-9]+)\]?/.exec(line);
    if (m) {
      flush();
      curVersion = m[1] ?? null;
      buf = [line];
    } else if (curVersion) {
      buf.push(line);
    }
  }
  flush();
  return out;
}
