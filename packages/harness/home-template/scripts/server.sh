#!/usr/bin/env bash
# Control the deployed services.
# Usage: sudo ./scripts/server.sh {start|stop|restart|status|logs|build|harness|dev|secrets}
# The three commands: sudo ./scripts/setup-server.sh (one-time prod prep) ·
# sudo ./scripts/server.sh build (build only) · sudo ./scripts/server.sh … (run/manage).
# start/restart run secrets + build themselves — deploy loop:
#   git pull && sudo ./scripts/server.sh restart
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$ROOT/config" ] && . "$ROOT/config"
NAME="${APP_NAME:-$(basename "$ROOT")}"
HARNESS_PORT="${HARNESS_PORT:-7331}"
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
gen_secrets() {
  install -d "$ROOT/harness/.secrets"
  ROOT="$ROOT" APP_USER="$APP_USER" APP_PASS="${APP_PASS:-}" \
  DOMAIN="${DOMAIN:-}" APP_PORT="$APP_PORT" HARNESS_PORT="$HARNESS_PORT" \
  HAS_APP="$HAS_APP" \
  node <<'NODE'
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
const E = process.env;
const usersPath = path.join(E.ROOT, "harness/.secrets/users.json");
let old = null; try { old = JSON.parse(fs.readFileSync(usersPath, "utf8")); } catch {}
const user = E.APP_USER;
const pass = E.APP_PASS || old?.users?.[0]?.password || crypto.randomBytes(12).toString("hex");
const write600 = (p, s) => { fs.writeFileSync(p, s); fs.chmodSync(p, 0o600); };
write600(usersPath, JSON.stringify({ users: [{ username: user, password: pass }] }, null, 2) + "\n");
if (E.HAS_APP === "true") {
  write600(path.join(E.ROOT, "app/.env.local"),
    "# Generated from ../config by scripts/server.sh — do not hand-edit.\n" +
    `HARNESS_USER=${user}\nHARNESS_PASS=${pass}\nDOMAIN=${E.DOMAIN}\nPORT=${E.APP_PORT}\n` +
    `HARNESS_URL=http://127.0.0.1:${E.HARNESS_PORT}\n`);
}
console.error(`>> operator login: ${user} / ${pass}`);
NODE
  if $HAS_APP; then
    echo ">> wrote harness/.secrets/users.json + app/.env.local from config"
  else
    echo ">> wrote harness/.secrets/users.json from config"
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

# start/restart = secrets + build + systemctl, so `git pull && sudo
# ./scripts/server.sh restart` is the whole deploy. `build` alone is for
# building without touching the running services.
case "${1:-}" in
  secrets) gen_secrets ;;
  build)   do_build ;;
  start)   gen_secrets; do_build; systemctl start   "${UNITS[@]}" ;;
  stop)    systemctl stop    "${UNITS[@]}" ;;
  restart) gen_secrets; do_build; systemctl restart "${UNITS[@]}" ;;
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
  *) echo "usage: $0 {start|stop|restart|status|logs|build|harness|dev|secrets}"; exit 1 ;;
esac
