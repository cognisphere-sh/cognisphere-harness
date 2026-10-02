#!/usr/bin/env node
/**
 * `pnpm test`: run the runner tests with node:test.
 *
 * Real-Pi tests need PI_TEST_PROVIDER, PI_TEST_MODEL and PI_TEST_API_KEY.
 * Missing values come from `.env.test` (gitignored, 0600). If that file
 * doesn't exist and we're in a terminal, ask once and save the answers;
 * blank answers are saved too, which means "skip the LLM tests" (delete
 * `.env.test` to be asked again). Without a terminal (CI), they are skipped.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(PKG, ".env.test");
const KEYS = ["PI_TEST_PROVIDER", "PI_TEST_MODEL", "PI_TEST_API_KEY"];
const env = { ...process.env };

if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && KEYS.includes(m[1]) && env[m[1]] === undefined) env[m[1]] = m[2];
  }
} else if (process.stdin.isTTY && process.stdout.isTTY && KEYS.some((k) => !env[k])) {
  console.log("Real-Pi tests call a real model. Leave blank to skip them (saved to .env.test).");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = async (key, question, secret = false) => {
    if (env[key]) return;
    // ponytail: readline has no hidden-input option; muting its echo hook
    // is the standard trick (private API, harmless if it ever stops working).
    const write = rl._writeToOutput;
    if (secret) rl._writeToOutput = (s) => (s.startsWith(question) ? write.call(rl, s) : undefined);
    env[key] = (await rl.question(question)).trim();
    rl._writeToOutput = write;
    if (secret) process.stdout.write("\n");
  };
  await ask("PI_TEST_PROVIDER", "Provider id (e.g. anthropic, openai, openrouter): ");
  if (env.PI_TEST_PROVIDER) {
    await ask("PI_TEST_MODEL", "Model id (e.g. claude-haiku-4-5): ");
    await ask("PI_TEST_API_KEY", "API key (hidden): ", true);
  }
  rl.close();
  writeFileSync(ENV_FILE, KEYS.map((k) => `${k}=${env[k] ?? ""}`).join("\n") + "\n", { mode: 0o600 });
  console.log(`Saved ${ENV_FILE}.`);
}

const r = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-timeout=200000", "--test-force-exit", "test/*.test.ts"],
  { cwd: PKG, env, stdio: "inherit" },
);
process.exit(r.status ?? 1);
