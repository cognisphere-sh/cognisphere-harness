#!/usr/bin/env bash
# Control the deployed services.
# Usage: sudo ./scripts/server.sh {start|stop|restart [app|harness]|status|logs|build|harness|dev|secrets}
# start/stop/restart take an optional target (app|harness) to bounce one unit;
# omit it to bounce both. `restart app` leaves the harness (and any agent driving
# this script) running — the safe way to apply an app-only change.
# The three commands: sudo ./scripts/setup-server.sh (one-time prod prep) ·
# sudo ./scripts/server.sh build (build only) · sudo ./scripts/server.sh … (run/manage).
# start/restart run secrets + build themselves — deploy loop:
#   git pull && sudo ./scripts/server.sh restart
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$ROOT/config" ] && . "$ROOT/config"
NAME="${APP_NAME:-$(basename "$ROOT")}"
HARNESS_PORT="${HARNESS_PORT:-3142}"
APP_PORT="${APP_PORT:-3000}"
APP_USER="${APP_USER:-operator}"
# app/ is optional until it has a package.json — the harness runs alone before that.
HAS_APP=false; [[ -f "$ROOT/app/package.json" ]] && HAS_APP=true

UNITS=("$NAME-harness.service")
$HAS_APP && UNITS+=("$NAME-app.service")

# Materialize the deploy `config` into the files the stack reads:
#   harness/.secrets/users.json — operator console sign-in
#   app/.env.local              — harness login + DOMAIN/PORT/HARNESS_URL (when app/ exists)
# `config` is the single source of truth; both files are gitignored + regenerated.
# Blank APP_PASS = generated once, then REUSED from the existing users.json so a
# blank config doesn't churn the password across restarts. A tiny node writer
# does the JSON (safe escaping); node is a hard dependency of the harness.
#
# When ARTIFACTS_AGENT is set it also wires the `artifacts` plugin end to end —
# the shared secret has to exist in two places at once (the agent's plugin
# secret and the app's env), so generating it here is the only way a fresh
# deploy comes up working. See scripts/../app/artifacts-routes/README.md.
gen_secrets() {
  install -d "$ROOT/harness/.secrets"
  ROOT="$ROOT" APP_USER="$APP_USER" APP_PASS="${APP_PASS:-}" \
  DOMAIN="${DOMAIN:-}" APP_PORT="$APP_PORT" HARNESS_PORT="$HARNESS_PORT" \
  HAS_APP="$HAS_APP" ARTIFACTS_AGENT="${ARTIFACTS_AGENT:-}" \
  ARTIFACTS_SESSION_COOKIE="${ARTIFACTS_SESSION_COOKIE:-}" \
  node <<'NODE'
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
const E = process.env;
const usersPath = path.join(E.ROOT, "harness/.secrets/users.json");
let old = null; try { old = JSON.parse(fs.readFileSync(usersPath, "utf8")); } catch {}
const user = E.APP_USER;
const pass = E.APP_PASS || old?.users?.[0]?.password || crypto.randomBytes(12).toString("hex");
const write600 = (p, s) => { fs.writeFileSync(p, s); fs.chmodSync(p, 0o600); };
write600(usersPath, JSON.stringify({ users: [{ username: user, password: pass }] }, null, 2) + "\n");

// ---- artifacts plugin (opt-in: blank ARTIFACTS_AGENT = not wired) ----------
// The app serves /public/artifacts/* and /private/artifacts/* and proves a
// reader is signed in by presenting ARTIFACTS_APP_SECRET to the plugin, so the
// same secret must reach harness/.secrets/secrets.json AND app/.env.local.
// Generated once here, then REUSED from secrets.json (like APP_PASS) so links
// and sessions survive a restart.
const agent = (E.ARTIFACTS_AGENT || "").trim();
let artifactsEnv = "";
if (agent) {
  const secretsPath = path.join(E.ROOT, "harness/.secrets/secrets.json");
  let secrets = {}; try { secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8")); } catch {}
  const bucket = { ...(secrets[agent]?.artifacts ?? {}) };
  bucket.ARTIFACTS_APP_SECRET ||= crypto.randomBytes(24).toString("hex");
  secrets[agent] = { ...(secrets[agent] ?? {}), artifacts: bucket };
  write600(secretsPath, JSON.stringify(secrets, null, 2) + "\n");

  // The plugin needs the app origin to build shareable links, and only runs on
  // an agent that has the dir — creating it here is what enables the feature.
  const pluginDir = path.join(E.ROOT, "harness/agents", agent, "plugins/artifacts");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "config.json"),
    JSON.stringify({ appBaseUrl: `https://${E.DOMAIN}` }, null, 2) + "\n");

  artifactsEnv =
    `ARTIFACTS_AGENT=${agent}\nARTIFACTS_APP_SECRET=${bucket.ARTIFACTS_APP_SECRET}\n` +
    `ARTIFACTS_SESSION_COOKIE=${E.ARTIFACTS_SESSION_COOKIE}\n`;
  console.error(`>> artifacts: wired for agent '${agent}' at https://${E.DOMAIN}/{public,private}/artifacts/<slug>`);
}

if (E.HAS_APP === "true") {
  write600(path.join(E.ROOT, "app/.env.local"),
    "# Generated from ../config by scripts/server.sh — do not hand-edit.\n" +
    `HARNESS_USER=${user}\nHARNESS_PASS=${pass}\nDOMAIN=${E.DOMAIN}\nPORT=${E.APP_PORT}\n` +
    `HARNESS_URL=http://127.0.0.1:${E.HARNESS_PORT}\n` + artifactsEnv);
}
console.error(`>> operator login: ${user} / ${pass}`);
NODE
  if $HAS_APP; then
    echo ">> wrote harness/.secrets/users.json + app/.env.local from config"
  else
    echo ">> wrote harness/.secrets/users.json from config"
  fi
  # Deployment hook: app-specific secrets/config materialization lives in the
  # deployment-owned scripts/app/secrets.sh (see scripts/app/README.md), never
  # in this file. Sourced, so it sees ROOT/NAME/HAS_APP + everything in config;
  # the resolved operator login is in harness/.secrets/users.json.
  if [[ -f "$ROOT/scripts/app/secrets.sh" ]]; then
    echo ">> deployment hook: scripts/app/secrets.sh"
    source "$ROOT/scripts/app/secrets.sh"
  fi
}

# Build via scripts/build.sh. Under sudo, drop to the app user so node_modules
# and .next don't end up root-owned (RUN_USER from config, else the sudo'er).
do_build() {
  local BUILD_USER="${RUN_USER:-${SUDO_USER:-}}"
  if [[ $EUID -eq 0 && -n "$BUILD_USER" ]]; then
    sudo -u "$BUILD_USER" bash "$ROOT/scripts/build.sh"
  else
    bash "$ROOT/scripts/build.sh"
  fi
}

# Resolve an optional {app|harness} target ($2) to the unit(s) to act on;
# no target = both. Errors if `app` is asked for but app/ doesn't exist yet.
target_units() {
  case "${1:-}" in
    "")      printf '%s\n' "${UNITS[@]}" ;;
    harness) echo "$NAME-harness.service" ;;
    app)     $HAS_APP || { echo "no app/ to target" >&2; exit 1; }
             echo "$NAME-app.service" ;;
    *) echo "usage: $0 {start|stop|restart} [app|harness]" >&2; exit 1 ;;
  esac
}

# start/restart = secrets + build + systemctl, so `git pull && sudo
# ./scripts/server.sh restart` is the whole deploy. `build` alone is for
# building without touching the running services.
case "${1:-}" in
  secrets) gen_secrets ;;
  build)   do_build ;;
  # systemctl restart also starts stopped units, so start == restart.
  # ponytail: build is unconditional even for `restart harness` (rebuilds the
  # app it won't bounce) — split the build if that ever gets slow enough to hurt.
  start|restart) gen_secrets; do_build; units=$(target_units "${2:-}"); systemctl restart $units ;;
  stop)    units=$(target_units "${2:-}"); systemctl stop $units ;;
  status)  systemctl status --no-pager "${UNITS[@]}" ;;
  logs)
    JARGS=(-u "$NAME-harness")
    $HAS_APP && JARGS+=(-u "$NAME-app")
    journalctl "${JARGS[@]}" -f
    ;;
  harness) cd "$ROOT/harness" && exec pnpm exec cognisphere serve --port "$HARNESS_PORT" ;;
  dev)
    # Run the harness (port HARNESS_PORT) and, when app/ exists, the app dev
    # server together so the app's /api proxy has a backend. gen_secrets just
    # wrote app/.env.local (DOMAIN/PORT/HARNESS_URL), so the app reads its env
    # from there. Harness runs in the background; Ctrl-C tears both down.
    gen_secrets
    if $HAS_APP; then
      ( cd "$ROOT/harness" && pnpm exec cognisphere serve --port "$HARNESS_PORT" ) &
      HARNESS_PID=$!
      trap 'kill "$HARNESS_PID" 2>/dev/null' EXIT INT TERM
      pnpm --dir "$ROOT/app" run dev
    else
      cd "$ROOT/harness" && exec pnpm exec cognisphere dev --port "$HARNESS_PORT"
    fi
    ;;
  *) echo "usage: $0 {start|stop|restart [app|harness]|status|logs|build|harness|dev|secrets}"; exit 1 ;;
esac

# Deployment hook: app-specific lifecycle work (migrations on restart, extra
# services to bounce, …) lives in the deployment-owned scripts/app/server.sh
# (see scripts/app/README.md), never in this file. Sourced after the stock
# action with the same positional args ($1 command, $2 target) and vars
# (ROOT/NAME/UNITS/HAS_APP/…) in scope — case on "$1" for per-command work.
# Not reached by the foreground/exec commands (harness, dev, logs).
if [[ -f "$ROOT/scripts/app/server.sh" ]]; then
  echo ">> deployment hook: scripts/app/server.sh $*"
  source "$ROOT/scripts/app/server.sh"
fi
