/**
 * `cognisphere init <name>` — scaffold an app home: a pnpm workspace holding
 * the harness data dir (`harness/`), a placeholder for the user-facing app
 * (`app/`), and the AWS deploy scripts (`scripts/`). The harness code is
 * installed from the registry, not copied.
 */
import { mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative, resolve } from "node:path";
import {
  PKG_ROOT,
  copyDir,
  fail,
  info,
  packageVersion,
  run,
  writeJson,
} from "./util.js";

const GITIGNORE = `node_modules/
.secrets/
.venv/
dist/
.next/
logs/
.env.local
config
**/sessions/
**/inbox/
**/inboxes/
`;

// The auth token deliberately is NOT here: pnpm refuses to expand env-var
// credentials from a committed project .npmrc, so the _authToken line must
// live in the run user's ~/.npmrc (scripts/setup-server.sh writes it on the
// server; `init` prints the one-liner for local installs).
const NPMRC = `# @cognisphere-sh/* packages live on GitHub Packages, not npmjs.org.
@cognisphere-sh:registry=https://npm.pkg.github.com
`;

const WORKSPACE_YAML = `packages:
  - harness
  - app
# Native/postinstall builds the harness needs: better-sqlite3 (session DB) and
# esbuild (tsx loader) must compile to run. \`allowBuilds\` is the pnpm 11
# setting name, \`onlyBuiltDependencies\` the pnpm ≤10 one — keep in sync.
allowBuilds:
  better-sqlite3: true
  esbuild: true
onlyBuiltDependencies:
  - better-sqlite3
  - esbuild
# Our own package — skip pnpm's release-age wait so fresh harness releases
# install immediately.
minimumReleaseAgeExclude:
  - '@cognisphere-sh/cognisphere-harness'
`;

export function cmdInit(argv: string[]): void {
  const { id, timezone, root } = parseArgs(argv);
  const dir = join(root, id);

  if (existsSync(dir) && readdirSync(dir).length > 0) {
    fail(`${dir} already exists and is not empty`);
  }

  const version = packageVersion();

  // ── workspace root (the app home) ────────────────────────────────────────
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "package.json"), {
    name: id,
    private: true,
    description: `${id}: cognisphere app home — the agent harness (harness/) + the user-facing app (app/). Workspace members are listed in pnpm-workspace.yaml.`,
  });
  writeFileSync(join(dir, "pnpm-workspace.yaml"), WORKSPACE_YAML);
  writeFileSync(join(dir, ".npmrc"), NPMRC);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);

  // Deploy scripts, config templates, and the app/ placeholder — shipped with
  // the package as a verbatim template (cpSync and npm pack both preserve the
  // scripts' exec bits). Platform-specific provisioning lives in
  // scripts/<platform>/ (aws only, for now).
  copyDir(join(PKG_ROOT, "home-template"), dir);

  // ── harness data dir ──────────────────────────────────────────────────────
  const harnessDir = join(dir, "harness");
  mkdirSync(join(harnessDir, "agents"), { recursive: true });
  mkdirSync(join(harnessDir, "plugins"), { recursive: true });
  mkdirSync(join(harnessDir, ".secrets"), { recursive: true, mode: 0o700 });

  // Data/migration version mirrors the installed package version (see §6).
  writeJson(join(harnessDir, "harness.json"), { version, timezone });

  // Generate the session-signing key now so the dir is deploy-ready and
  // sessions are stable from first boot (the server would otherwise lazily
  // create it). 0600 — never commit (.gitignore excludes .secrets/).
  writeFileSync(join(harnessDir, ".secrets", "session-key"), randomBytes(32), {
    mode: 0o600,
  });

  writeJson(join(harnessDir, "package.json"), {
    name: `${id}-harness`,
    private: true,
    type: "module",
    dependencies: { "@cognisphere-sh/cognisphere-harness": version },
  });

  writeFileSync(join(harnessDir, "agents", ".gitkeep"), "");
  writeFileSync(join(harnessDir, "plugins", ".gitkeep"), "");

  copySkills(dir);

  // The app home is a git repo so upgrades are reviewable diffs (§9).
  run("git", ["init", "--quiet", dir]);

  const rel = relative(process.cwd(), dir);
  const cdTarget = rel && !rel.startsWith("..") ? rel : dir;

  info(`Created app home "${id}" at ${dir}`);
  info("  harness/  the cognisphere harness (agents, plugins, secrets)");
  info("  app/      your user-facing app (see app/README.md)");
  info("  scripts/  AWS deploy + lifecycle scripts (see config.example)");
  info("");
  info("Next steps:");
  info(`  cd ${cdTarget}`);
  info("  # the private registry needs a read:packages token in YOUR ~/.npmrc");
  info("  # (same env var the deploy scripts use — export it before installing):");
  info("  echo '//npm.pkg.github.com/:_authToken=${COGNISPHERE_NPM_TOKEN}' >> ~/.npmrc");
  info("  pnpm install");
  info("  cd harness");
  info("  pnpm exec cognisphere agent new <name>           # add your first agent");
  info("  pnpm exec cognisphere dev                        # run locally (hot reload)");
}

/**
 * Copy the home-facing agent skills (upgrade, create-plugin) into the app
 * home's `.claude/skills/` and `.agents/skills/`, so agents working inside
 * the home discover them. Source is the package's bundled `skills/`
 * (prepack); falls back to the monorepo's `.claude/skills/` when running
 * from a checkout (same pattern as the upgrade command's CHANGELOG).
 */
function copySkills(dir: string): void {
  const shipped = join(PKG_ROOT, "skills");
  const source = existsSync(shipped)
    ? shipped
    : resolve(PKG_ROOT, "..", "..", ".claude", "skills");
  if (!existsSync(source)) return;
  for (const id of ["cognisphere-upgrade", "create-plugin"]) {
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
  // Default to the current directory — the app home lands at ./<name>.
  // `--root` overrides.
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
  if (!id) fail("usage: cognisphere init <name> [--timezone <IANA>] [--root <dir>]");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    fail(`invalid app name "${id}" — use letters, digits, ._- (no slashes)`);
  }
  return { id, timezone, root };
}
