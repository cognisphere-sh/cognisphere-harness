/**
 * `cognisphere agent new <name>` — fork the base template into the harness's
 * `agents/<name>/` and write a starter `agent.json`. The fork is owned by the
 * harness: git-tracked and edited freely (§4).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BASE_AGENT_DIR,
  copyDir,
  fail,
  info,
  requireHarnessDir,
  writeJson,
} from "./util.js";

export function cmdAgentNew(argv: string[]): void {
  const name = argv[0];
  if (!name || name.startsWith("-")) {
    fail("usage: cognisphere agent new <name>");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    fail(`invalid agent name "${name}" — use letters, digits, ._- (no slashes)`);
  }

  const { dir } = requireHarnessDir();
  const target = join(dir, "agents", name);
  if (existsSync(target)) fail(`agent "${name}" already exists at ${target}`);
  if (!existsSync(BASE_AGENT_DIR)) {
    fail(`base template missing at ${BASE_AGENT_DIR} (corrupt install?)`);
  }

  copyDir(BASE_AGENT_DIR, target);

  // Starter config — edit model/strategy before first run. The agent stays
  // "failed" until its model provider is configured (secrets + models.json).
  writeJson(join(target, "agent.json"), {
    name,
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    threadIdStrategy: { type: "single" },
  });

  info(`Created agent "${name}" at ${target}`);
  info("");
  info("Next steps:");
  info(`  edit agents/${name}/agent.json           # set model/provider`);
  info(`  edit agents/${name}/system_prompts/      # tailor the prompt`);
  info(`  cognisphere plugin add <id>              # add a catalog plugin`);
}
