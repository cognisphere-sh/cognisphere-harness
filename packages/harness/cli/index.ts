/**
 * `cognisphere` CLI entrypoint — install, scaffold, run, and upgrade a harness
 * (see docs/distribution-and-deployment.md §10). Dispatch only; each command
 * lives in its own module.
 */
import { cmdAgentNew } from "./agent.js";
import { cmdInit } from "./init.js";
import { cmdPluginAdd } from "./plugin.js";
import { cmdRun } from "./run.js";
import { cmdLogs, cmdStatus, cmdUp } from "./service.js";
import { cmdUpgrade } from "./upgrade.js";
import { fail, info, packageVersion } from "./util.js";

const USAGE = `cognisphere — multi-agent harness CLI (v${packageVersion()})

Usage: cognisphere <command> [args]

Scaffold
  init <id> [--timezone <tz>] [--root <dir>]   create a harness data dir
  agent new <name>                             fork the base template
  plugin add <id> [--force]                    fork a catalog plugin

Run
  dev                                          run the server (hot reload)
  serve                                        run the server (production)
  up [id] [--reinstall]                        enable+start the systemd unit
  logs [id] [-f]                               tail the service logs
  status [id]                                  systemd unit status

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
      return cmdRun("dev");
    case "serve":
      return cmdRun("serve");
    case "up":
      return cmdUp(rest);
    case "logs":
      return cmdLogs(rest);
    case "status":
      return cmdStatus(rest);
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
