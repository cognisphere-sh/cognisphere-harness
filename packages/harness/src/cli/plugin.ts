/**
 * `cognisphere plugin add <id>` — fork a catalog plugin from the package into
 * the harness's `plugins/<id>/`, where it shadows the bundled copy and can be
 * edited (§5). Core plugins (admin, scheduler) are bundled-only and refused.
 *
 * Compatibility: if a plugin ships a `plugin.json` with `compatibleHarness`
 * (a `>=X <Y` range), it is validated against `harness.json.version`. No
 * builtin plugin declares one yet, so this is a forward-looking guard.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_PLUGINS_DIR,
  CORE_PLUGINS,
  compareVersions,
  copyDir,
  fail,
  info,
  readJson,
  requireHarnessDir,
} from "./util.js";

export function cmdPluginAdd(argv: string[]): void {
  const force = argv.includes("--force");
  const id = argv.find((a) => !a.startsWith("-"));
  if (!id) {
    fail(`usage: cognisphere plugin add <id> [--force]\n${catalogHint()}`);
  }

  if (CORE_PLUGINS.has(id)) {
    fail(`"${id}" is a core plugin — bundled and resolved from the package, not forkable`);
  }

  const source = join(BUILTIN_PLUGINS_DIR, id);
  if (!existsSync(join(source, "index.ts"))) {
    fail(`unknown catalog plugin "${id}".\n${catalogHint()}`);
  }

  const { dir } = requireHarnessDir();
  const target = join(dir, "plugins", id);
  if (existsSync(target)) {
    fail(`plugin "${id}" is already forked at ${target}`);
  }

  checkCompatible(source, dir, id, force);

  copyDir(source, target);
  info(`Forked catalog plugin "${id}" into ${target}`);
  info("It now shadows the bundled copy. Enable it per agent and edit freely.");
}

function checkCompatible(
  source: string,
  harnessDir: string,
  id: string,
  force: boolean,
): void {
  const manifestPath = join(source, "plugin.json");
  if (!existsSync(manifestPath)) return; // no declared range — nothing to check
  const range = readJson<{ compatibleHarness?: string }>(manifestPath)
    .compatibleHarness;
  if (!range) return;

  const version = readJson<{ version?: string }>(
    join(harnessDir, "harness.json"),
  ).version;
  if (!version) return; // un-versioned harness — can't check

  if (!satisfies(version, range)) {
    const msg = `plugin "${id}" declares compatibleHarness "${range}" but this harness is ${version}`;
    if (!force) fail(`${msg}\n  re-run with --force to fork anyway`);
    info(`warning: ${msg} (forking due to --force)`);
  }
}

/** Minimal range check for the `>=X <Y` / `>=X` / `<Y` / exact forms. */
function satisfies(version: string, range: string): boolean {
  for (const token of range.trim().split(/\s+/)) {
    if (token.startsWith(">=")) {
      if (compareVersions(version, token.slice(2)) < 0) return false;
    } else if (token.startsWith("<")) {
      if (compareVersions(version, token.slice(1)) >= 0) return false;
    } else if (compareVersions(version, token) !== 0) {
      return false;
    }
  }
  return true;
}

function catalogHint(): string {
  if (!existsSync(BUILTIN_PLUGINS_DIR)) return "";
  const catalog = readdirSync(BUILTIN_PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !CORE_PLUGINS.has(e.name))
    .map((e) => e.name);
  return catalog.length ? `Catalog plugins: ${catalog.join(", ")}` : "";
}
