/**
 * `cognisphere up | logs | status` — thin wrappers over a systemd **user**
 * service. One install, many harnesses: a template unit `cognisphere@.service`
 * parameterizes on the harness id (§8), so each harness is its own unit.
 *
 * systemd is Linux-only; on macOS use `cognisphere dev` for local runs.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail, info, run } from "./util.js";

const UNIT_NAME = "cognisphere@.service";

/** Template unit. `%i` = harness id, `%h` = the user's home dir. Assumes the
 *  default root `~/.cognisphere`; edit WorkingDirectory for a custom root. */
const UNIT_TEMPLATE = `[Unit]
Description=CogniSphere harness %i
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.cognisphere/%i
ExecStart=%h/.cognisphere/%i/node_modules/.bin/cognisphere serve
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;

function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function requireLinux(): void {
  if (process.platform !== "linux") {
    fail(
      `systemd services are Linux-only (this is ${process.platform}).\n` +
        `  for local runs use: cognisphere dev`,
    );
  }
}

/** Resolve the harness id from an explicit arg or the cwd. */
function resolveId(argv: string[]): string {
  const id = argv.find((a) => !a.startsWith("-"));
  return id ?? basename(process.cwd());
}

export function cmdUp(argv: string[]): void {
  requireLinux();
  const id = resolveId(argv);
  const dir = unitDir();
  const unitPath = join(dir, UNIT_NAME);

  if (!existsSync(unitPath) || argv.includes("--reinstall")) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(unitPath, UNIT_TEMPLATE);
    info(`Installed ${unitPath}`);
    run("systemctl", ["--user", "daemon-reload"]);
  }

  const status = run("systemctl", ["--user", "enable", "--now", `cognisphere@${id}`]);
  if (status !== 0) fail(`failed to start cognisphere@${id}`);
  info(`Started cognisphere@${id}`);
  info(`  logs:   cognisphere logs ${id} -f`);
  info(`  status: cognisphere status ${id}`);
}

export function cmdLogs(argv: string[]): void {
  requireLinux();
  const id = resolveId(argv);
  const follow = argv.includes("-f") || argv.includes("--follow");
  const args = ["--user", "-u", `cognisphere@${id}`];
  if (follow) args.push("-f");
  else args.push("-n", "200", "--no-pager");
  process.exit(run("journalctl", args));
}

export function cmdStatus(argv: string[]): void {
  requireLinux();
  const id = resolveId(argv);
  process.exit(
    run("systemctl", ["--user", "status", `cognisphere@${id}`, "--no-pager"]),
  );
}
