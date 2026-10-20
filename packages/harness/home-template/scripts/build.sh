#!/usr/bin/env bash
# build.sh — install deps + build the user-facing app (when app/ exists).
# Run as the app user, no sudo:   ./scripts/build.sh
#
# The three commands:
#   sudo ./scripts/setup-server.sh   one-time prod prep (deps, systemd, nginx, HTTPS)
#   sudo ./scripts/server.sh build   build only (start/restart also run this build)
#                                    (or ./scripts/build.sh directly as the app user)
#   sudo ./scripts/server.sh …       start | stop | restart | status | logs | secrets | dev
# Typical deploy loop:  git pull && sudo ./scripts/server.sh restart
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$ROOT/config" ]] && source "$ROOT/config"

cd "$ROOT"
pnpm install --frozen-lockfile
if [[ -f "$ROOT/app/package.json" ]]; then
  pnpm --dir "$ROOT/app" run build
fi
echo ">> build ok — apply with: sudo ./scripts/server.sh restart"
