/**
 * `cognisphere init <id>` — scaffold a harness data dir: a small pnpm project
 * that depends on the harness package and holds the harness's data (agents,
 * plugins, secrets). The code is installed from the registry, not copied.
 */
import { mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { PKG_ROOT, copyDir, fail, info, packageVersion, run, writeJson } from "./util.js";

const GITIGNORE = `node_modules/
.secrets/
.venv/
dist/
**/sessions/
**/inbox/
**/inboxes/
`;

const NPMRC = `@cognisphere-sh:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=\${GITHUB_TOKEN}
`;

export function cmdInit(argv: string[]): void {
  const { id, timezone, root } = parseArgs(argv);
  const dir = join(root, id);

  if (existsSync(dir) && readdirSync(dir).length > 0) {
    fail(`${dir} already exists and is not empty`);
  }

  const version = packageVersion();

  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "plugins"), { recursive: true });
  mkdirSync(join(dir, ".secrets"), { recursive: true, mode: 0o700 });

  // Data/migration version mirrors the installed package version (see §6).
  writeJson(join(dir, "harness.json"), { version, timezone });

  // Generate the session-signing key now so the dir is deploy-ready and
  // sessions are stable from first boot (the server would otherwise lazily
  // create it). 0600 — never commit (.gitignore excludes .secrets/).
  writeFileSync(join(dir, ".secrets", "session-key"), randomBytes(32), {
    mode: 0o600,
  });

  writeJson(join(dir, "package.json"), {
    name: `cognisphere-harness-${id}`,
    private: true,
    type: "module",
    dependencies: { "@cognisphere-sh/cognisphere-harness": version },
    // better-sqlite3 ships a native addon; pnpm 10 blocks build scripts unless
    // the package is pre-approved here.
    pnpm: { onlyBuiltDependencies: ["better-sqlite3"] },
  });

  writeFileSync(join(dir, ".npmrc"), NPMRC);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  writeFileSync(join(dir, "agents", ".gitkeep"), "");
  writeFileSync(join(dir, "plugins", ".gitkeep"), "");

  copySkills(dir);

  // The harness dir is a git repo so upgrades are reviewable diffs (§9).
  run("git", ["init", "--quiet", dir]);

  const rel = relative(process.cwd(), dir);
  const cdTarget = rel && !rel.startsWith("..") ? rel : dir;

  info(`Created harness "${id}" at ${dir}`);
  info("");
  info("Next steps:");
  info(`  cd ${cdTarget}`);
  info("  export GITHUB_TOKEN=<token with read:packages>   # to install the harness");
  info("  pnpm install");
  info("  cognisphere agent new <name>                     # add your first agent");
  info("  cognisphere dev                                  # run locally (hot reload)");
}

/**
 * Copy the harness-dir-facing agent skills (deploy, upgrade, create-plugin)
 * into the new dir's `.claude/skills/` and `.agents/skills/`, so agents
 * working inside the harness discover them. Source is the package's bundled
 * `skills/` (prepack); falls back to the monorepo's `.claude/skills/` when
 * running from a checkout (same pattern as the upgrade command's CHANGELOG).
 */
function copySkills(dir: string): void {
  const shipped = join(PKG_ROOT, "skills");
  const source = existsSync(shipped)
    ? shipped
    : resolve(PKG_ROOT, "..", "..", ".claude", "skills");
  if (!existsSync(source)) return;
  for (const id of ["cognisphere-deploy", "cognisphere-upgrade", "create-plugin"]) {
    const src = join(source, id);
    if (!existsSync(src)) continue;
    for (const target of [".claude", ".agents"]) {
      copyDir(src, join(dir, target, "skills", id));
    }
  }
}

function parseArgs(argv: string[]): {
  id: string;
  timezone: string;
  root: string;
} {
  let id: string | undefined;
  let timezone = "UTC";
  // Default to the current directory — the harness lands at ./<id>. `--root`
  // overrides (e.g. `--root ~/.cognisphere` for a conventional deploy layout).
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--timezone" || a === "-t") {
      timezone = argv[++i] ?? fail("--timezone needs a value");
    } else if (a === "--root") {
      root = argv[++i] ?? fail("--root needs a value");
    } else if (a && !a.startsWith("-")) {
      id = a;
    } else {
      fail(`unknown option: ${a}`);
    }
  }
  if (!id) fail("usage: cognisphere init <id> [--timezone <IANA>] [--root <dir>]");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    fail(`invalid harness id "${id}" — use letters, digits, ._- (no slashes)`);
  }
  return { id, timezone, root };
}
