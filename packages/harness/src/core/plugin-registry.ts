import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import type { Plugin, PluginManifest } from "./types.js";

/** Built-in plugins auto-installed on every agent (always started, regardless
 *  of the agent's plugins dir). `plugin add` refuses these ids. */
export const CORE_PLUGIN_IDS = ["admin", "scheduler"] as const;

export interface RegistryEntry {
  id: string;
  ctor: new () => Plugin;
  manifest: PluginManifest;
  sourceDir: string;
  scope: "builtin" | "user";
}

/**
 * Discovers plugins by scanning roots for `<root>/<id>/index.ts` and
 * dynamically importing each one. Built-in plugins live under
 * packages/harness/plugins/; user plugins live under <rootDir>/<harnessId>/plugins/
 * (later root wins on id collision).
 */
export class PluginRegistry {
  private entries = new Map<string, RegistryEntry>();
  private readonly roots: { dir: string; scope: "builtin" | "user" }[];

  constructor(builtinRoot: string, userRoot: string, private log: Logger) {
    this.roots = [
      { dir: resolve(builtinRoot), scope: "builtin" },
      { dir: resolve(userRoot), scope: "user" },
    ];
  }

  async scan(): Promise<void> {
    this.entries.clear();
    for (const { dir, scope } of this.roots) {
      if (!existsSync(dir)) {
        this.log.debug({ dir, scope }, "plugin root absent, skipping");
        continue;
      }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        const id = entry.name;
        const sourceDir = join(dir, id);
        const indexTs = join(sourceDir, "index.ts");
        if (!existsSync(indexTs)) {
          this.log.warn({ id, sourceDir }, "no index.ts; skipping plugin");
          continue;
        }
        try {
          const mod = await import(pathToFileURL(indexTs).href);
          const Ctor = (mod.default ?? mod[id]) as new () => Plugin;
          if (typeof Ctor !== "function") {
            this.log.error({ id }, "plugin index.ts has no default export class");
            continue;
          }
          const inst = new Ctor();
          if (!inst.manifest) {
            this.log.error({ id }, "plugin instance lacks .manifest");
            continue;
          }
          this.entries.set(id, {
            id,
            ctor: Ctor,
            manifest: inst.manifest,
            sourceDir,
            scope,
          });
          this.log.info({ id, scope, source: sourceDir }, "plugin loaded");
        } catch (err) {
          this.log.error({ err, id }, "failed to load plugin");
        }
      }
    }
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()];
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }
}
