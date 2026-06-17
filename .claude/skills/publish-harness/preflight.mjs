#!/usr/bin/env node
// publish-harness preflight — runs every check CI's publish.yml runs, locally,
// WITHOUT pushing to the registry. Bumping + the actual publish happen via a
// GitHub Release (CI does `pnpm publish`); this verifies the release is safe to
// cut. Run from the repo root.
//
//   node .claude/skills/publish-harness/preflight.mjs
//
// ponytail: no flags/config — one job (verify the release is publishable) and
// it either passes or tells you exactly what to fix.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const pkgPath = resolve(root, "packages/harness/package.json");
if (!existsSync(pkgPath)) {
  console.error("✗ run me from the repo root (packages/harness/package.json not found)");
  process.exit(1);
}

const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`✓ ${msg}`);
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const tag = `v${version}`;
console.log(`\n── preflight: @cognisphere-sh/cognisphere-harness ${version} ──\n`);

// 1. CHANGELOG has a section for this version.
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
if (changelog.includes(`## [${version}]`)) ok(`CHANGELOG.md has a [${version}] section`);
else fail(`CHANGELOG.md has no "## [${version}]" section — add release notes first`);

// 2. Tag must not already exist (existing tag ⇒ already released).
const tags = execFileSync("git", ["tag"], { cwd: root, encoding: "utf8" }).split("\n");
if (tags.includes(tag)) fail(`git tag ${tag} already exists — bump the version before releasing`);
else ok(`git tag ${tag} is free`);

// 3. typecheck + lint (CI gate).
console.log("\n── pnpm check ──");
try { run("pnpm", ["check"]); ok("pnpm check passed"); }
catch { fail("pnpm check failed — fix before releasing"); }

// 4. Build the publish tarball (runs prepack: builds web UI + bundles CHANGELOG).
console.log("\n── pnpm pack (exercises prepack) ──");
let tarball;
try {
  run("pnpm", ["--filter", "@cognisphere-sh/cognisphere-harness", "pack"]);
  // pnpm pack with --filter writes the .tgz into the cwd (repo root).
  tarball = readdirSync(root).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("no .tgz produced");
} catch (e) {
  fail(`pnpm pack failed — ${e.message}`);
}

if (tarball) {
  const tgz = resolve(root, tarball);
  const entries = execFileSync("tar", ["tzf", tgz], { encoding: "utf8" });
  const has = (re) => entries.split("\n").filter((l) => re.test(l)).length;
  has(/dist-web\//) ? ok(`tarball ships ${has(/dist-web\//)} dist-web/ files`) : fail("tarball missing dist-web/ (prepack web build failed)");
  has(/CHANGELOG\.md/) ? ok("tarball ships CHANGELOG.md") : fail("tarball missing CHANGELOG.md");
  has(/^package\/bin\//) ? ok("tarball ships bin/") : fail("tarball missing bin/");
  rmSync(tgz); // local artifact — CI builds its own
}

console.log("\n────────────────────────────────────");
if (process.exitCode) {
  console.log("PREFLIGHT FAILED — fix the ✗ items above, then re-run.");
} else {
  console.log(`PREFLIGHT PASSED. Cut the release to publish ${version}:\n`);
  console.log(`  git tag ${tag} && git push origin ${tag}`);
  console.log(`  gh release create ${tag} --title "${tag}" --notes-from-tag`);
  console.log(`\nThe 'release: published' event triggers .github/workflows/publish.yml,`);
  console.log(`which runs 'pnpm publish' against GitHub Packages.`);
}
