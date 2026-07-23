#!/usr/bin/env bash
# One-time Contabo provisioning, driven by scripts/contabo/config. Run LOCALLY
# (needs cntb + jq), NOT on the server:  ./scripts/contabo/setup.sh
# Creates: object storage + backup bucket, SSH-key secret, Cloud VPS (Ubuntu),
# ~/.ssh/config entry — then ssh's in to enable ufw (Contabo has no security
# groups; every port is open by default), install gh + Claude Code, run their
# interactive auth, and clone this repo.
# Re-runnable: existing resources are found by displayName/region and reused —
# but note that unlike AWS, `cntb create instance` / `create objectStorage`
# PLACES A PAID ORDER (monthly contract). The first run buys; reruns reuse.
#
# Auth: cntb keeps its own credentials in ~/.cntb.yaml (nothing in this repo).
# One-time, with the four values from https://my.contabo.com -> Your Account -> API:
#   cntb config set-credentials --oauth2-clientid=... --oauth2-client-secret=... \
#     --oauth2-user=<account email> --oauth2-password=<API password>
#
# Contabo has no IAM roles, so backups authenticate with the object-storage
# access/secret keys — this script prints the four BACKUP_* values to paste
# into the app home's root `config` on the server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="${1:-$ROOT/scripts/contabo/config}"
[[ -f "$CONFIG" ]] || { echo "no $CONFIG — run: cp scripts/contabo/config.example scripts/contabo/config && edit it"; exit 1; }
# shellcheck source=config.example
source "$CONFIG"
# shellcheck source=../lib/remote-bootstrap.sh
source "$ROOT/scripts/lib/remote-bootstrap.sh"
command -v cntb >/dev/null || { echo "cntb not installed (brew install cntb, or github.com/contabo/cntb releases)"; exit 1; }
command -v jq >/dev/null || { echo "jq not installed (brew install jq)"; exit 1; }
cntb get instances -o json >/dev/null 2>&1 || { echo "cntb auth failed — run 'cntb config set-credentials ...' (see this script's header)"; exit 1; }

PERIOD="${PERIOD:-1}"
UBUNTU_VERSION="${UBUNTU_VERSION:-24.04}"
STORAGE_TB="${STORAGE_TB:-0.25}"
HOST_ALIAS="${SSH_HOST_ALIAS:-$INSTANCE_NAME}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_KEY="${SSH_KEY/#\~/$HOME}"   # sourced value may carry a literal ~
# cntb -o json wraps lists as {"data":[...]}; older builds emit the bare array.
data() { jq '(.data // .)'; }

echo ">> region=$REGION product=$PRODUCT_ID instance=$INSTANCE_NAME storage=$STORAGE_REGION bucket=$BUCKET"

# ---- 1. SSH key -> Contabo secret (their key-pair store) --------------------
[[ -f "$SSH_KEY" ]] || ssh-keygen -t ed25519 -N "" -f "$SSH_KEY"
SECRET_NAME="$INSTANCE_NAME-ssh"
SECRET_ID="$(cntb get secrets -o json | data | jq -r --arg n "$SECRET_NAME" 'map(select(.name==$n)) | .[0].secretId // empty')"
if [[ -z "$SECRET_ID" ]]; then
  SECRET_ID="$(cntb create secret --name "$SECRET_NAME" --type ssh --value "$(cat "$SSH_KEY.pub")")"
  echo ">> uploaded $SSH_KEY.pub as secret $SECRET_ID ($SECRET_NAME)"
else
  echo ">> secret $SECRET_NAME exists ($SECRET_ID) — skipping"
fi

# ---- 2. object storage (S3-compatible; max one per region) ------------------
OS_ID="$(cntb get objectStorages -o json | data | jq -r --arg r "$STORAGE_REGION" 'map(select(.region==$r)) | .[0].objectStorageId // empty')"
if [[ -z "$OS_ID" ]]; then
  OS_ID="$(cntb create objectStorage --region "$STORAGE_REGION" \
    --totalPurchasedSpaceTB "$STORAGE_TB" --scalingState disabled \
    --displayName "$INSTANCE_NAME-storage")"
  echo ">> ordered object storage $OS_ID ($STORAGE_TB TB, $STORAGE_REGION)"
else
  echo ">> object storage in $STORAGE_REGION exists ($OS_ID) — reusing"
fi
for _ in $(seq 1 60); do
  [[ "$(cntb get objectStorage "$OS_ID" -o 'jsonpath=$.data[0].status')" == "READY" ]] && break
  sleep 5
done
S3_URL="$(cntb get objectStorage "$OS_ID" -o 'jsonpath=$.data[0].s3Url')"

# ---- 3. backup bucket -------------------------------------------------------
if cntb get buckets --storageId "$OS_ID" -o json | data | jq -e --arg b "$BUCKET" 'map(select(.name==$b)) | length > 0' >/dev/null; then
  echo ">> bucket $BUCKET exists — skipping"
else
  cntb create bucket --storageId "$OS_ID" --name "$BUCKET" >/dev/null
  echo ">> created bucket $BUCKET"
fi

# ---- 4. S3 keys for backup.sh (no IAM roles on Contabo) ---------------------
# ponytail: .[0] = the account owner on a single-user account; pick explicitly if you add sub-users.
USER_ID="$(cntb get users -o json | data | jq -r '.[0].userId')"
CRED="$(cntb get user-credentials --userId "$USER_ID" --storageId "$OS_ID" -o json | data | jq '.[0] // .')"
ACCESS_KEY="$(jq -r '.accessKey' <<<"$CRED")"
SECRET_KEY="$(jq -r '.secretKey' <<<"$CRED")"

# ---- 5. Cloud VPS (Ubuntu $UBUNTU_VERSION) ----------------------------------
IMAGE_ID="$(cntb get images --size 500 -o json | data | jq -r --arg v "$UBUNTU_VERSION" \
  'map(select(((.name // "") | ascii_downcase | gsub("[ -]"; "")) == "ubuntu\($v)")) | .[0].imageId // empty')"
[[ -n "$IMAGE_ID" ]] || { echo "no standard image for ubuntu $UBUNTU_VERSION — check: cntb get images"; exit 1; }

INSTANCE_ID="$(cntb get instances --size 500 -o json | data | jq -r --arg n "$INSTANCE_NAME" 'map(select(.displayName==$n)) | .[0].instanceId // empty')"
if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID="$(cntb create instance --imageId "$IMAGE_ID" --productId "$PRODUCT_ID" \
    --region "$REGION" --displayName "$INSTANCE_NAME" --sshKeys "$SECRET_ID" \
    --defaultUser admin --period "$PERIOD")"
  echo ">> ordered instance $INSTANCE_ID ($PRODUCT_ID, ubuntu $UBUNTU_VERSION, $PERIOD-month contract)"
else
  echo ">> instance $INSTANCE_NAME exists ($INSTANCE_ID) — skipping"
fi

echo ">> waiting for instance to run (provisioning takes a few minutes)"
for _ in $(seq 1 60); do
  [[ "$(cntb get instance "$INSTANCE_ID" -o 'jsonpath=$.data[0].status')" == "running" ]] && break
  sleep 10
done
IP="$(cntb get instance "$INSTANCE_ID" -o 'jsonpath=$.data[0].ipConfig.v4.ip')"
echo ">> $INSTANCE_NAME: $INSTANCE_ID @ $IP (Contabo IPs are static for the instance's lifetime)"

# ---- 6. ~/.ssh/config -------------------------------------------------------
add_ssh_config_entry admin "$SSH_KEY"

# ---- 7. remote bootstrap: ufw + gh + Claude Code (interactive auth) + clone --
wait_for_ssh

# Contabo has no security groups — close everything except ssh/http/https.
ssh "$HOST_ALIAS" bash <<'REMOTE'
set -euo pipefail
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
REMOTE

remote_bootstrap
echo ">> backups have no IAM role here — set these in the root config on the box:"
echo "     BACKUP_S3_BUCKET=$BUCKET"
echo "     BACKUP_S3_ENDPOINT=$S3_URL"
echo "     BACKUP_S3_ACCESS_KEY=$ACCESS_KEY"
echo "     BACKUP_S3_SECRET_KEY=$SECRET_KEY"
