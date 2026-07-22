#!/usr/bin/env bash
# One-time prod setup: deps, build, systemd units, nginx + Let's Encrypt HTTPS.
# Run as root on a fresh Ubuntu/Debian box:  sudo ./scripts/setup-server.sh
# Re-runnable: rebuilds, rewrites units/nginx, renews cert.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/config" ]] || { echo "no config file — run: cp config.example config && edit it"; exit 1; }
# shellcheck source=../config.example
source "$ROOT/config"
RUN_USER="${RUN_USER:-${SUDO_USER:-$USER}}"
NAME="${APP_NAME:-$(basename "$ROOT")}"
# app/ is optional until it has a package.json — the harness runs alone before that.
HAS_APP=false; [[ -f "$ROOT/app/package.json" ]] && HAS_APP=true

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
echo ">> name=$NAME app=$DOMAIN:$APP_PORT (present: $HAS_APP) console=$CONSOLE_DOMAIN:$HARNESS_PORT dir=$ROOT user=$RUN_USER"

# ---- system packages ------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates nginx zip sqlite3
# Agent runtime deps (the bootstrap runs as the app user and can't apt-install):
#  - python3-venv provides ensurepip; without it each agent's `python -m venv`
#    leaves a broken venv with no pip, so markitdown/ddgs never install.
#  - ffmpeg + poppler-utils back markitdown's media/PDF conversions.
#  - postgresql-client provides psql for agent DB scripts.
#  - jq backs scripts/scheduler/scheduler-cli's atomic state writes.
apt-get install -y python3-venv python3-pip ffmpeg poppler-utils postgresql-client jq
# Chrome shared libraries for agent-browser's headless Chrome. Best-effort: a
# package renamed on a given Ubuntu release shouldn't abort the whole provision
# (the box may already have them). If launch still fails, the app user can run
# `~/.npm-global/bin/agent-browser install --with-deps`.
apt-get install -y \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0t64 \
  || echo ">> WARN: some Chrome libraries did not install; run agent-browser install --with-deps if the browser fails to launch"
command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-nginx
command -v aws >/dev/null || apt-get install -y awscli   # S3 backups

# Node (NodeSource) + pnpm via corepack
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
  apt-get install -y nodejs
fi
# The corepack bundled with Node can be too old to launch a recent pnpm
# (throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING). Update it first.
npm install -g corepack@latest
corepack enable
corepack prepare pnpm@latest --activate

# ---- GitHub Packages token --------------------------------------------------
# @cognisphere-sh/* live on GitHub Packages, whose npm registry requires a token
# with the read:packages scope EVEN for public packages (anonymous = 401, a
# scope-short token = 403). Prefer COGNISPHERE_NPM_TOKEN from config (a PAT); else
# use the run user's gh CLI token. A gh OAuth token (gho_*) exists but often lacks
# read:packages, so a bare `gh auth token` check would pass yet still 403 at fetch
# time — verify/repair the scope here instead of failing mid-build.
if [[ -z "${COGNISPHERE_NPM_TOKEN:-}" ]]; then
  command -v gh >/dev/null || { echo "no COGNISPHERE_NPM_TOKEN in config and gh CLI not installed. Set COGNISPHERE_NPM_TOKEN (a PAT with read:packages) in config, or install gh and run: sudo -u $RUN_USER gh auth login -s read:packages"; exit 1; }
  # gh runs as the app user; ensure it's logged in and the token carries read:packages.
  # (gh prints "Token scopes:" to stderr, hence 2>&1.)
  if ! sudo -u "$RUN_USER" gh auth status >/dev/null 2>&1; then
    echo ">> gh is not authenticated for $RUN_USER — launching login (needs read:packages)"
    sudo -u "$RUN_USER" gh auth login -s read:packages || { echo "gh auth login failed"; exit 1; }
  elif ! sudo -u "$RUN_USER" gh auth status 2>&1 | grep -q 'read:packages'; then
    echo ">> gh token for $RUN_USER lacks the read:packages scope — refreshing"
    sudo -u "$RUN_USER" gh auth refresh -s read:packages || { echo "gh auth refresh failed"; exit 1; }
  fi
  COGNISPHERE_NPM_TOKEN="$(sudo -u "$RUN_USER" gh auth token 2>/dev/null || true)"
fi
[[ -n "$COGNISPHERE_NPM_TOKEN" ]] || { echo "no GitHub token for @cognisphere-sh packages. Set COGNISPHERE_NPM_TOKEN in config (a PAT with read:packages), or run: sudo -u $RUN_USER gh auth refresh -s read:packages"; exit 1; }
# pnpm refuses to expand env-var credentials from the committed project .npmrc,
# so the auth line must live in the run user's ~/.npmrc (a trusted source).
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
sudo -u "$RUN_USER" touch "$RUN_HOME/.npmrc"
sudo -u "$RUN_USER" grep -qF 'npm.pkg.github.com/:_authToken' "$RUN_HOME/.npmrc" \
  || echo '//npm.pkg.github.com/:_authToken=${COGNISPHERE_NPM_TOKEN}' | sudo -u "$RUN_USER" tee -a "$RUN_HOME/.npmrc" >/dev/null

# ---- credentials ------------------------------------------------------------
# `scripts/server.sh secrets` is the single source: it writes users.json
# (harness login) and, when app/ exists, app/.env.local (harness login +
# DOMAIN/PORT/HARNESS_URL). Blank APP_PASS is generated once and reused. Runs
# as RUN_USER so the files are owned correctly.
install -d -o "$RUN_USER" "$ROOT/harness/.secrets"
sudo -u "$RUN_USER" bash "$ROOT/scripts/server.sh" secrets

# ---- build (as the app user so node_modules aren't root-owned) -------------
# Delegated to scripts/build.sh — the same command used for every later deploy
# (git pull && sudo ./scripts/server.sh restart).
sudo -u "$RUN_USER" env COGNISPHERE_NPM_TOKEN="$COGNISPHERE_NPM_TOKEN" bash "$ROOT/scripts/build.sh"

# ---- agent runtimes: build each agent's Python venv + CLIs ------------------
# Each agent has a bootstrap/bootstrap.sh (idempotent) that creates <agent>/.venv
# with markitdown/ddgs and installs the pi / agent-browser CLIs the harness
# spawns by name. Run as the app user so the venv and ~/.local installs aren't
# root-owned. Best-effort: a warning here shouldn't abort the whole provision.
for bs in "$ROOT"/harness/agents/*/bootstrap/bootstrap.sh; do
  [[ -f "$bs" ]] || continue
  agent_name="$(basename "$(dirname "$(dirname "$bs")")")"
  echo ">> bootstrapping agent runtime: $agent_name"
  sudo -u "$RUN_USER" bash "$bs" \
    || echo ">> WARN: bootstrap for '$agent_name' reported issues — review its output above"
done

# ---- systemd units --------------------------------------------------------
NODE_BIN_DIR="$(dirname "$(command -v node)")"
# pnpm lives where corepack@latest installed it (the npm global bin, e.g.
# /usr/local/bin) — NOT necessarily next to node. The OS may also ship an older
# /usr/bin/pnpm (apt node-corepack) that throws
# ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING on Node 22, so resolve the active pnpm
# explicitly and put its dir first on the unit PATH instead of assuming
# $NODE_BIN_DIR/pnpm.
PNPM_BIN="$(command -v pnpm)"
PNPM_BIN_DIR="$(dirname "$PNPM_BIN")"
# The harness spawns the `pi` coding agent by name (PATH lookup). pi is a
# per-user install ($RUN_HOME/.local/bin/pi), so that dir MUST be on the unit
# PATH or every spawn fails with `spawn pi ENOENT`. node/pnpm may both live in
# /usr/bin, so don't rely on their dirs to carry it.
# $RUN_HOME/.npm-global/bin carries the npm-global CLIs the agent bootstrap
# installs as the app user (pi, agent-browser) when the default npm prefix is
# root-owned. Must be on the unit PATH or bare `agent-browser`/`pi` spawns 127.
UNIT_PATH="$RUN_HOME/.local/bin:$RUN_HOME/.npm-global/bin:$PNPM_BIN_DIR:$NODE_BIN_DIR:/usr/bin:/bin"

# A previous run under a different APP_NAME leaves its units behind, and both
# names would then fight over the same ports. Retire anything pointing at this
# ROOT under another name (units + nginx site + backup cron).
for u in /etc/systemd/system/*-harness.service; do
  [[ -f "$u" ]] || continue
  OLD="$(basename "$u" -harness.service)"
  [[ "$OLD" == "$NAME" ]] && continue
  grep -q "^WorkingDirectory=$ROOT/harness$" "$u" || continue
  echo ">> retiring stale units from previous name '$OLD'"
  systemctl disable --now "$OLD-harness.service" "$OLD-app.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/$OLD-harness.service" "/etc/systemd/system/$OLD-app.service" \
        "/etc/nginx/sites-enabled/$OLD" "/etc/nginx/sites-available/$OLD" "/etc/cron.d/$OLD-backup"
done

cat > "/etc/systemd/system/$NAME-harness.service" <<EOF
[Unit]
Description=$NAME cognisphere harness (backend + operator console)
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT/harness
Environment=PATH=$UNIT_PATH
# Empty so pnpm can expand the \${COGNISPHERE_NPM_TOKEN} ref in the run user's
# ~/.npmrc without warning. The service does no installs, so no real token is
# needed at runtime.
Environment=COGNISPHERE_NPM_TOKEN=
ExecStart=$PNPM_BIN exec cognisphere serve --port $HARNESS_PORT
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

UNITS=("$NAME-harness.service")
if $HAS_APP; then
  cat > "/etc/systemd/system/$NAME-app.service" <<EOF
[Unit]
Description=$NAME user-facing app
After=network.target $NAME-harness.service
Wants=$NAME-harness.service

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT/app
Environment=PATH=$UNIT_PATH
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT
Environment=HARNESS_URL=http://127.0.0.1:$HARNESS_PORT
Environment=COGNISPHERE_NPM_TOKEN=
# 'next start' honors \$PORT; passing "-- -p" trips Next 16's arg parser (it
# reads -p as a project dir), so rely on the PORT env above.
ExecStart=$PNPM_BIN start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  UNITS+=("$NAME-app.service")
else
  rm -f "/etc/systemd/system/$NAME-app.service"
fi

systemctl daemon-reload
systemctl enable --now "${UNITS[@]}"

# ---- nginx: app on $DOMAIN (when present), harness console on $CONSOLE_DOMAIN
# Console UI binds to 127.0.0.1 only; nginx is the sole public entry.
proxy_block() { cat <<EOF
    location / {
        proxy_pass http://127.0.0.1:$1;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
EOF
}

{
  if $HAS_APP; then
    cat <<EOF
server {
    listen 80;
    server_name $DOMAIN;
$(proxy_block "$APP_PORT")
}
EOF
  fi
  cat <<EOF
server {
    listen 80;
    server_name $CONSOLE_DOMAIN;
$(proxy_block "$HARNESS_PORT")
}
EOF
} > "/etc/nginx/sites-available/$NAME"
ln -sf "/etc/nginx/sites-available/$NAME" "/etc/nginx/sites-enabled/$NAME"
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ---- HTTPS (needs DNS pointing here already) --------------------------------
CERT_DOMAINS=(-d "$CONSOLE_DOMAIN")
$HAS_APP && CERT_DOMAINS+=(-d "$DOMAIN")
certbot --nginx "${CERT_DOMAINS[@]}" \
  --non-interactive --agree-tos -m "$EMAIL" --redirect

# ---- S3 backups (cron) -----------------------------------------------------
# scripts/aws/backup.sh zips the whole app dir (consistent SQLite snapshots,
# minus node_modules/.next/.venv) to BACKUP_S3_BUCKET and prunes to
# BACKUP_KEEP. Auth: the instance IAM role on AWS, or BACKUP_S3_ENDPOINT +
# BACKUP_S3_ACCESS_KEY/_SECRET_KEY for S3-compatible stores (Contabo).
if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
  H="${BACKUP_EVERY_HOURS:-24}"
  # cron can't express "every N hours" for N>=24 — degrade to daily at 03:00 UTC.
  if [[ "$H" =~ ^[0-9]+$ ]] && (( H >= 1 && H <= 23 )); then SCHED="0 */$H * * *"; else SCHED="0 3 * * *"; fi
  install -d -o "$RUN_USER" "$ROOT/logs"
  cat > "/etc/cron.d/$NAME-backup" <<EOF
# $NAME S3 backup — written by setup-server.sh; edit config, not this file.
$SCHED $RUN_USER $ROOT/scripts/aws/backup.sh >> $ROOT/logs/backup.log 2>&1
EOF
  chmod 644 "/etc/cron.d/$NAME-backup"
  echo ">> backups: $SCHED -> s3://${BACKUP_S3_BUCKET%/} (keep ${BACKUP_KEEP:-14})"
else
  rm -f "/etc/cron.d/$NAME-backup"
  echo ">> backups: off (BACKUP_S3_BUCKET is blank)"
fi

if $HAS_APP; then
  echo ">> done. app: https://$DOMAIN  console: https://$CONSOLE_DOMAIN  |  manage: ./scripts/server.sh status"
else
  echo ">> done. console: https://$CONSOLE_DOMAIN (no app/ yet)  |  manage: ./scripts/server.sh status"
fi
