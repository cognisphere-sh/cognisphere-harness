import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import type { Plugin, PluginManifest } from "./types.js";

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
 * apps/server/plugins/; user plugins live under <rootDir>/<harnessId>/plugins/
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

  /** Add-only rescan: pick up new user-space plugins; don't touch loaded ones. */
  async rescan(): Promise<void> {
    for (const { dir, scope } of this.roots) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const id = entry.name;
        if (this.entries.has(id)) continue;
        const indexTs = join(dir, id, "index.ts");
        if (!existsSync(indexTs) || !statSync(indexTs).isFile()) continue;
        try {
          const mod = await import(pathToFileURL(indexTs).href);
          const Ctor = (mod.default ?? mod[id]) as new () => Plugin;
          if (typeof Ctor !== "function") continue;
          const inst = new Ctor();
          if (!inst.manifest) continue;
          this.entries.set(id, {
            id,
            ctor: Ctor,
            manifest: inst.manifest,
            sourceDir: join(dir, id),
            scope,
          });
          this.log.info({ id, scope }, "plugin loaded (rescan)");
        } catch (err) {
          this.log.error({ err, id }, "rescan: failed to load plugin");
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
