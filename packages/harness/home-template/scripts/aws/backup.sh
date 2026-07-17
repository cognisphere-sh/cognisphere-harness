#!/usr/bin/env bash
# backup.sh — zip the whole app dir to S3. Driven by the cron job that
# setup-server.sh writes (/etc/cron.d/<name>-backup); config keys:
# BACKUP_S3_BUCKET (bucket or bucket/prefix; blank = off), BACKUP_KEEP.
#
# What's in the zip: everything under the app home — .secrets, agent
# workspaces/sessions, .git — EXCEPT node_modules/.next/.venv (reproducible
# via pnpm install / the app build) and the LIVE SQLite files.
# SQLite: each *.db is snapshotted with `sqlite3 .backup` into <name>.db.snap
# (consistent even mid-write under WAL); the live .db/.db-wal/.db-shm are
# excluded. RESTORE: unzip, then rename each *.db.snap back to *.db.
#
# AWS auth: the aws CLI default chain — on EC2 that's the instance IAM role
# (needs s3:PutObject/ListBucket/DeleteObject on the backup bucket).
set -euo pipefail

# Config comes from the app home's root `config` (the BACKUP_* keys) — NOT
# scripts/aws/config, which is the local-only provisioning file.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../config.example
source "$ROOT/config"
NAME="${APP_NAME:-$(basename "$ROOT")}"
[[ -n "${BACKUP_S3_BUCKET:-}" ]] || exit 0   # backups disabled
# Local testing: honor the config's named aws-cli profile (EC2 uses the IAM role).
[[ -n "${AWS_PROFILE:-}" ]] && export AWS_PROFILE

KEEP="${BACKUP_KEEP:-14}"
DEST="s3://${BACKUP_S3_BUCKET%/}"
ZIP="$NAME-$(date -u +%Y%m%d-%H%M%S).zip"
TMP="$(mktemp -d)"
# -prune skips the big subtrees entirely (node_modules/.next/.venv/.git are
# tens of thousands of inodes); -not -path would still stat-walk them all.
finddb() { find "$ROOT" \( -name node_modules -o -name .next -o -name .venv -o -name .git \) -prune -o -name "$1" -print 2>/dev/null; }
cleanup() { rm -rf "$TMP"; finddb '*.db.snap' | while IFS= read -r s; do rm -f "$s"; done; }
trap cleanup EXIT

# Consistent SQLite snapshots next to each live DB (picked up by the zip).
while IFS= read -r db; do
  sqlite3 "$db" ".backup '$db.snap'"
done < <(finddb '*.db')

cd "$ROOT/.."
zip -qr "$TMP/$ZIP" "$(basename "$ROOT")" \
  -x '*/node_modules/*' '*/.next/*' '*/.venv/*' '*.db' '*.db-wal' '*.db-shm'

aws s3 cp --only-show-errors "$TMP/$ZIP" "$DEST/$ZIP"

# Retention: keep the newest $KEEP, delete the rest (names sort chronologically).
aws s3 ls "$DEST/" \
  | awk -v n="$NAME" '$4 ~ ("^" n "-[0-9]{8}-[0-9]{6}\\.zip$") {print $4}' \
  | sort | head -n -"$KEEP" \
  | while read -r old; do aws s3 rm --only-show-errors "$DEST/$old"; done

echo "$(date -u +%FT%TZ) backup ok: $ZIP -> $DEST (keep $KEEP)"
