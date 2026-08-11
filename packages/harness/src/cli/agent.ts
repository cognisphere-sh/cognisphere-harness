/**
 * `cognisphere agent new <name> [--dev]` — fork the base template into the
 * harness's `agents/<name>/` and write a starter `agent.json`. The fork is
 * owned by the harness: git-tracked and edited freely (§4). `--dev` overlays
 * the developer-agent persona and installs the cognisphere skills.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BASE_AGENT_DIR,
  DEV_AGENT_ID,
  DEV_AGENT_DIR,
  HOME_SKILL_IDS,
  copyDir,
  fail,
  info,
  requireHarnessDir,
  shippedSkillsRoot,
  writeJson,
} from "./util.js";

/** Fork the base template into `<harnessDir>/agents/<name>/`. Shared by
 *  `agent new` and `init` (which creates the developer agent). */
export function scaffoldAgent(
  harnessDir: string,
  name: string,
  opts: { dev?: boolean } = {},
): string {
  // The developer agent's id is frozen to "nova"; the name is reserved.
  if (opts.dev && name !== DEV_AGENT_ID) {
    fail(`the developer agent is always named "${DEV_AGENT_ID}" — its id is frozen`);
  }
  if (!opts.dev && name.toLowerCase() === DEV_AGENT_ID) {
    fail(`"${DEV_AGENT_ID}" is reserved for the developer agent (recreate it with --dev)`);
  }
  const target = join(harnessDir, "agents", name);
  if (existsSync(target)) fail(`agent "${name}" already exists at ${target}`);
  if (!existsSync(BASE_AGENT_DIR)) {
    fail(`base template missing at ${BASE_AGENT_DIR} (corrupt install?)`);
  }

  copyDir(BASE_AGENT_DIR, target);

  if (opts.dev) {
    copyDir(DEV_AGENT_DIR, target);
    // Other agents reach the dev agent via the core agent-messaging plugin;
    // human-facing channels (e.g. telegram) are opt-in per deployment.
  }

  // Install shipped skills into the agent's own skills dir — pi only loads
  // `<agentDir>/skills`, so the home-root `.claude/skills/` copies aren't
  // visible to the agent. Every agent gets `create-skill` (procedural memory
  // lands as skills); the dev agent gets the full set.
  const skillsRoot = shippedSkillsRoot();
  if (skillsRoot) {
    const ids = opts.dev ? HOME_SKILL_IDS : ["create-skill"];
    for (const id of ids) {
      const src = join(skillsRoot, id);
      if (existsSync(src)) copyDir(src, join(target, "skills", "agent", id));
    }
  }

  // Starter config — edit model/strategy before first run. The agent stays
  // "failed" until its model provider is configured (secrets + models.json).
  writeJson(join(target, "agent.json"), {
    name,
    description: opts.dev
      ? "Developer agent: owns and modifies this deployment's platform code — agent prompts/scripts, forked plugins, the user-facing frontend app, deploy scripts — and keeps docs/harness + docs/app current. Send code, app, docs and software-install requests here."
      : `TODO: one-line description of ${name}'s role (shown to other agents in the harness roster).`,
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    threadIdStrategy: { type: "single" },
    ...(opts.dev ? { devAgent: true } : {}),
  });
  return target;
}

export function cmdAgentNew(argv: string[]): void {
  const dev = argv.includes("--dev");
  const name = argv.find((a) => !a.startsWith("-"));
  if (!name) {
    fail("usage: cognisphere agent new <name> [--dev]");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    fail(`invalid agent name "${name}" — use letters, digits, ._- (no slashes)`);
  }

  const { dir } = requireHarnessDir();
  const target = scaffoldAgent(dir, name, { dev });

  info(`Created agent "${name}" at ${target}`);
  info("");
  info("Next steps:");
  info(`  edit agents/${name}/agent.json           # set model/provider`);
  info(`  edit agents/${name}/system_prompts/1-agent.md  # persona & behaviour (0-* files are harness-owned)`);
  info("  cognisphere plugin add <id>              # add a catalog plugin (e.g. telegram)");
}
