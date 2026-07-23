/**
 * `cognisphere plugin add <id>` — fork a catalog plugin from the package into
 * the harness's `plugins/<id>/`, where it shadows the bundled copy and can be
 * edited (§5). Core plugins (admin, scheduler) are bundled-only and refused.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_PLUGINS_DIR,
  CORE_PLUGINS,
  copyDir,
  fail,
  info,
  requireHarnessDir,
} from "./util.js";

export function cmdPluginAdd(argv: string[]): void {
  const id = argv.find((a) => !a.startsWith("-"));
  if (!id) {
    fail(`usage: cognisphere plugin add <id>\n${catalogHint()}`);
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

  copyDir(source, target);
  info(`Forked catalog plugin "${id}" into ${target}`);
  info("It now shadows the bundled copy. Enable it per agent and edit freely.");
}

function catalogHint(): string {
  if (!existsSync(BUILTIN_PLUGINS_DIR)) return "";
  const catalog = readdirSync(BUILTIN_PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !CORE_PLUGINS.has(e.name))
    .map((e) => e.name);
  return catalog.length ? `Catalog plugins: ${catalog.join(", ")}` : "";
}
