#!/usr/bin/env bash
# One-time AWS provisioning, driven by scripts/aws/config. Run LOCALLY (needs
# aws CLI with admin-ish creds), NOT on the server:  ./scripts/aws/setup.sh
# Creates: S3 bucket, key pair (.pem), IAM role+instance profile (S3 read/write
# on the bucket), security group (80/443 open; 22 per config), EC2 (Ubuntu),
# Elastic IP, ~/.ssh/config entry — then ssh's in to install gh + Claude Code,
# runs their interactive auth, and clones this repo.
# Re-runnable: existing resources are found by name and reused.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="${1:-$ROOT/scripts/aws/config}"
[[ -f "$CONFIG" ]] || { echo "no $CONFIG — run: cp scripts/aws/config.example scripts/aws/config && edit it"; exit 1; }
# shellcheck source=config.example
source "$CONFIG"
command -v aws >/dev/null || { echo "aws CLI not installed (brew install awscli)"; exit 1; }
[[ -n "${AWS_PROFILE:-}" ]] && export AWS_PROFILE
export AWS_DEFAULT_REGION="$AWS_REGION"
EC2_TYPE="${EC2_TYPE:-t3.medium}"
EC2_DISK_GB="${EC2_DISK_GB:-30}"
UBUNTU_VERSION="${UBUNTU_VERSION:-24.04}"
ROLE="${IAM_ROLE:-$EC2_NAME-role}"
HOST_ALIAS="${SSH_HOST_ALIAS:-$EC2_NAME}"
aq() { aws --output text "$@"; }

echo ">> region=$AWS_REGION bucket=$S3_BUCKET ec2=$EC2_NAME($EC2_TYPE) key=$KEY_NAME role=$ROLE"

# ---- 1. S3 bucket ----------------------------------------------------------
if ! aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
  if [[ "$AWS_REGION" == us-east-1 ]]; then
    aws s3api create-bucket --bucket "$S3_BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$S3_BUCKET" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
  fi
  echo ">> created s3://$S3_BUCKET"
else
  echo ">> s3://$S3_BUCKET exists — skipping"
fi

# ---- 2. key pair (.pem, needed before launch) ------------------------------
PEM="$HOME/.ssh/$KEY_NAME.pem"
if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  mkdir -p ~/.ssh
  aq ec2 create-key-pair --key-name "$KEY_NAME" --query KeyMaterial > "$PEM"
  chmod 400 "$PEM"
  echo ">> created key pair -> $PEM"
elif [[ ! -f "$PEM" ]]; then
  echo "key pair $KEY_NAME exists in AWS but $PEM is missing locally (AWS never re-shows private keys)."
  echo "delete it (aws ec2 delete-key-pair --key-name $KEY_NAME) and rerun."; exit 1
else
  echo ">> key pair $KEY_NAME exists — skipping"
fi

# ---- 3. IAM role: S3 read/write on the backup bucket ------------------------
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  # ponytail: scoped to $S3_BUCKET, not s3:* — widen the Resource list if the app needs more buckets.
  aws iam put-role-policy --role-name "$ROLE" --policy-name s3-readwrite --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[
      {\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::$S3_BUCKET\"},
      {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::$S3_BUCKET/*\"}]}"
  echo ">> created role $ROLE"
else
  echo ">> role $ROLE exists — skipping (policy untouched)"
fi
if ! aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  sleep 10   # IAM is eventually consistent; a brand-new profile 400s in run-instances
fi

# ---- 4. security group: 80/443 from anywhere; 22 per SSH_OPEN ----------------
SG_NAME="$EC2_NAME-sg"
SG_ID="$(aq ec2 describe-security-groups --filters Name=group-name,Values="$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' 2>/dev/null || true)"
if [[ -z "$SG_ID" || "$SG_ID" == None ]]; then
  SG_ID="$(aq ec2 create-security-group --group-name "$SG_NAME" \
    --description "$EC2_NAME web + ssh" --query GroupId)"   # default VPC
fi
if [[ "${SSH_OPEN:-false}" == true ]]; then
  SSH_CIDR="0.0.0.0/0"
else
  SSH_CIDR="$(curl -fsS https://checkip.amazonaws.com)/32"
fi
for rule in "80:0.0.0.0/0" "443:0.0.0.0/0" "22:$SSH_CIDR"; do
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp \
    --port "${rule%%:*}" --cidr "${rule#*:}" 2>/dev/null || true   # duplicate rule = fine
done
echo ">> sg $SG_ID: 80,443 open; 22 from $SSH_CIDR"

# ---- 5. EC2 instance (latest Ubuntu $UBUNTU_VERSION) -------------------------
INSTANCE_ID="$(aq ec2 describe-instances \
  --filters Name=tag:Name,Values="$EC2_NAME" Name=instance-state-name,Values=pending,running \
  --query 'Reservations[0].Instances[0].InstanceId')"
if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == None ]]; then
  AMI="$(aq ssm get-parameter \
    --name "/aws/service/canonical/ubuntu/server/$UBUNTU_VERSION/stable/current/amd64/hvm/ebs-gp3/ami-id" \
    --query Parameter.Value)"
  INSTANCE_ID="$(aq ec2 run-instances --image-id "$AMI" --instance-type "$EC2_TYPE" \
    --key-name "$KEY_NAME" --security-group-ids "$SG_ID" \
    --iam-instance-profile Name="$ROLE" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$EC2_DISK_GB,VolumeType=gp3}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$EC2_NAME}]" \
    --query 'Instances[0].InstanceId')"
  echo ">> launched $INSTANCE_ID (ubuntu $UBUNTU_VERSION)"
else
  echo ">> instance $EC2_NAME exists ($INSTANCE_ID) — skipping"
fi
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"

# ---- 6. Elastic IP -----------------------------------------------------------
ALLOC="$(aq ec2 describe-addresses --filters Name=tag:Name,Values="$EIP_NAME" \
  --query 'Addresses[0].AllocationId')"
if [[ -z "$ALLOC" || "$ALLOC" == None ]]; then
  ALLOC="$(aq ec2 allocate-address \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$EIP_NAME}]" \
    --query AllocationId)"
fi
# associate only if not already attached to this instance
if [[ "$(aq ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].InstanceId')" != "$INSTANCE_ID" ]]; then
  aws ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC" >/dev/null
fi
IP="$(aq ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp')"
echo ">> $EC2_NAME: $INSTANCE_ID @ $IP (elastic ip $EIP_NAME)"

# ---- 7. ~/.ssh/config --------------------------------------------------------
if grep -qE "^Host[[:space:]]+$HOST_ALIAS\$" ~/.ssh/config 2>/dev/null; then
  echo ">> ~/.ssh/config already has 'Host $HOST_ALIAS' — verify HostName is $IP"
else
  cat >> ~/.ssh/config <<EOF

Host $HOST_ALIAS
    HostName $IP
    User ubuntu
    IdentityFile $PEM
EOF
  echo ">> added 'Host $HOST_ALIAS' to ~/.ssh/config"
fi

# ---- 8. remote bootstrap: gh + Claude Code (interactive auth) + clone --------
REPO_URL="${GIT_REPO:-$(git -C "$ROOT" remote get-url origin)}"
REPO_SLUG="$(sed -E 's#(git@github.com:|https://github.com/)##; s/\.git$//' <<<"$REPO_URL")"

echo ">> waiting for SSH on $HOST_ALIAS"
for _ in $(seq 1 30); do
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "$HOST_ALIAS" true 2>/dev/null && break
  sleep 5
done

# Ship the bootstrap script, then run it with a tty (-t) so the interactive
# gh / Claude Code auth flows work.
ssh "$HOST_ALIAS" 'cat > ~/bootstrap.sh' <<'REMOTE'
#!/usr/bin/env bash
set -euo pipefail
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates

# gh — official apt repo (the Ubuntu-archive gh is stale)
if ! command -v gh >/dev/null; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y gh
fi

# Claude Code — native installer into ~/.local/bin
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash
grep -q '\.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"

# gh interactive auth — read:packages is required to install @cognisphere-sh packages
if ! gh auth status >/dev/null 2>&1; then
  gh auth login -s read:packages
elif ! gh auth status 2>&1 | grep -q read:packages; then
  gh auth refresh -s read:packages
fi

# Claude Code auth only — setup-token runs the OAuth flow and stores the
# credential without starting a session. Skipped if already authenticated.
[[ -f ~/.claude/.credentials.json ]] || claude setup-token

# clone the repo
REPO_DIR="$HOME/$(basename "$REPO_SLUG")"
[[ -d "$REPO_DIR" ]] || gh repo clone "$REPO_SLUG" "$REPO_DIR"
echo ">> bootstrap done: $REPO_DIR"
REMOTE
ssh -t "$HOST_ALIAS" "REPO_SLUG='$REPO_SLUG' bash ~/bootstrap.sh && rm ~/bootstrap.sh"

echo ">> done. ssh $HOST_ALIAS   |   next: cd $(basename "$REPO_SLUG") && cp config.example config && sudo ./scripts/setup-server.sh"
