/**
 * `cognisphere agent new <name> [--dev]` — fork the base template into the
 * harness's `agents/<name>/` and write a starter `agent.json`. The fork is
 * owned by the harness: git-tracked and edited freely (§4). `--dev` overlays
 * the developer-agent persona, installs the cognisphere skills, and enables
 * the telegram plugin (the dev agent's only channel).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BASE_AGENT_DIR,
  DEFAULT_DEV_AGENT,
  DEV_AGENT_DIR,
  HOME_SKILL_IDS,
  copyDir,
  fail,
  info,
  readJson,
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
  const target = join(harnessDir, "agents", name);
  if (existsSync(target)) fail(`agent "${name}" already exists at ${target}`);
  if (!existsSync(BASE_AGENT_DIR)) {
    fail(`base template missing at ${BASE_AGENT_DIR} (corrupt install?)`);
  }

  copyDir(BASE_AGENT_DIR, target);

  // Bake the developer agent's name into the prompt fragments (create-time
  // baking, like the other agent-fixed {{vars}} — see server.md §6.8). For a
  // --dev fork that's this agent's own name; otherwise the existing dev
  // agent's id (falling back to the default when none exists yet). The
  // "Platform code changes" hand-off lives in the main-agent prompt.
  const devId = opts.dev
    ? name
    : findDevAgentId(harnessDir) ?? DEFAULT_DEV_AGENT;
  bakeDevAgentName(join(target, "system_prompts", "0.1-main-agent.md"), devId);

  if (opts.dev) {
    copyDir(DEV_AGENT_DIR, target);
    bakeDevAgentName(join(target, "system_prompts", "1-dev-agent.md"), devId);
    // The dev agent is telegram-only; an empty plugin dir installs it.
    mkdirSync(join(target, "plugins", "telegram"), { recursive: true });
    // Install the cognisphere skills into the agent's own skills dir — pi
    // only loads `<agentDir>/skills`, so the home-root `.claude/skills/`
    // copies aren't visible to the agent.
    const skillsRoot = shippedSkillsRoot();
    if (skillsRoot) {
      for (const id of HOME_SKILL_IDS) {
        const src = join(skillsRoot, id);
        if (existsSync(src)) copyDir(src, join(target, "skills", "agent", id));
      }
    }
  }

  // Starter config — edit model/strategy before first run. The agent stays
  // "failed" until its model provider is configured (secrets + models.json).
  writeJson(join(target, "agent.json"), {
    name,
    description: opts.dev
      ? "Developer agent: owns and modifies this deployment's platform code (agent prompts/scripts, plugins, app, deploy). Reachable on Telegram."
      : `TODO: one-line description of ${name}'s role (shown to other agents in the harness roster).`,
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    threadIdStrategy: { type: "single" },
    ...(opts.dev ? { devAgent: true } : {}),
  });
  return target;
}

/** Id of the harness's existing developer agent (agent.json `devAgent: true`),
 *  or null when none exists. */
function findDevAgentId(harnessDir: string): string | null {
  const agentsDir = join(harnessDir, "agents");
  if (!existsSync(agentsDir)) return null;
  for (const ent of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const specPath = join(agentsDir, ent.name, "agent.json");
    if (!existsSync(specPath)) continue;
    try {
      if (readJson<{ devAgent?: boolean }>(specPath).devAgent === true) {
        return ent.name;
      }
    } catch {
      // unreadable agent.json — not the dev agent
    }
  }
  return null;
}

function bakeDevAgentName(file: string, id: string): void {
  if (!existsSync(file)) return;
  const displayName = id.charAt(0).toUpperCase() + id.slice(1);
  writeFileSync(
    file,
    readFileSync(file, "utf8")
      .replaceAll("{{DevAgentId}}", id)
      .replaceAll("{{DevAgentName}}", displayName),
  );
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
  info(`  edit agents/${name}/system_prompts/      # tailor the prompt`);
  if (dev) {
    info(`  set the telegram bot token               # secrets.json → ${name}.telegram.TELEGRAM_BOT_TOKEN`);
  } else {
    info("  cognisphere plugin add <id>              # add a catalog plugin");
  }
}
