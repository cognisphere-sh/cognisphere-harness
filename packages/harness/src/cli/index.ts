/**
 * `cognisphere` CLI entrypoint — install, scaffold, run, and upgrade a harness
 * (see docs/distribution-and-deployment.md §10). Dispatch only; each command
 * lives in its own module.
 */
import { cmdAgentNew } from "./agent.js";
import { cmdInit } from "./init.js";
import { cmdPluginAdd } from "./plugin.js";
import { cmdRun } from "./run.js";
import { cmdUpgrade } from "./upgrade.js";
import { fail, info, packageVersion } from "./util.js";

const USAGE = `cognisphere — multi-agent harness CLI (v${packageVersion()})

Usage: cognisphere <command> [args]

Scaffold
  init <name> [--timezone <tz>] [--root <dir>] create an app home (harness/ + app/ + scripts/)
  agent new <name>                             fork the base template
  plugin add <id> [--force]                    fork a catalog plugin

Run (deployment is scripts/setup-server.sh + scripts/server.sh in the app home)
  dev [--port <n>] [--web-port <n>] [--no-web] backend (watch) + Vite dev server
  serve [--port <n>] [--headless]              backend only (--headless: no web UI)

Upgrade
  upgrade                                       show the pending migration window
  upgrade --to <version>                        bump the code dependency
  upgrade --set-version <version>               stamp harness.json (skill finalize)
`;

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "init":
      return cmdInit(rest);
    case "agent":
      if (rest[0] === "new") return cmdAgentNew(rest.slice(1));
      return fail("usage: cognisphere agent new <name>");
    case "plugin":
      if (rest[0] === "add") return cmdPluginAdd(rest.slice(1));
      return fail("usage: cognisphere plugin add <id>");
    case "dev":
      return cmdRun("dev", rest);
    case "serve":
      return cmdRun("serve", rest);
    case "upgrade":
      return cmdUpgrade(rest);
    case "-h":
    case "--help":
    case undefined:
      return info(USAGE);
    case "-v":
    case "--version":
      return info(packageVersion());
    default:
      process.stderr.write(USAGE);
      return fail(`unknown command: ${cmd}`);
  }
}

main();
