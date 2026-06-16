/**
 * `cognisphere init <id>` — scaffold a harness data dir: a small pnpm project
 * that depends on the harness package and holds the harness's data (agents,
 * plugins, secrets). The code is installed from the registry, not copied.
 */
import { mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative } from "node:path";
import { fail, info, packageVersion, run, writeJson } from "./util.js";

const GITIGNORE = `node_modules/
.secrets/
.venv/
dist/
**/sessions/
**/inbox/
**/inboxes/
`;

const NPMRC = `@cognisphere:registry=https://npm.pkg.github.com
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
    dependencies: { "@cognisphere/cognisphere-harness": version },
  });

  writeFileSync(join(dir, ".npmrc"), NPMRC);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  writeFileSync(join(dir, "agents", ".gitkeep"), "");
  writeFileSync(join(dir, "plugins", ".gitkeep"), "");

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
