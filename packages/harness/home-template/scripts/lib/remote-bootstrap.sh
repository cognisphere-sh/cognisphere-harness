#!/usr/bin/env bash
# Shared remote-bootstrap steps for the per-platform setup scripts
# (scripts/aws/setup.sh, scripts/contabo/setup.sh). Sourced, not executed —
# callers set ROOT, HOST_ALIAS and IP (plus optional GIT_REPO from config)
# before calling the functions below.

# Append a Host entry for $HOST_ALIAS -> $IP to ~/.ssh/config.
# usage: add_ssh_config_entry <remote-user> <identity-file>
add_ssh_config_entry() {
  if grep -qE "^Host[[:space:]]+$HOST_ALIAS\$" ~/.ssh/config 2>/dev/null; then
    echo ">> ~/.ssh/config already has 'Host $HOST_ALIAS' — verify HostName is $IP"
  else
    cat >> ~/.ssh/config <<EOF

Host $HOST_ALIAS
    HostName $IP
    User $1
    IdentityFile $2
EOF
    echo ">> added 'Host $HOST_ALIAS' to ~/.ssh/config"
  fi
}

wait_for_ssh() {
  echo ">> waiting for SSH on $HOST_ALIAS"
  for _ in $(seq 1 30); do
    ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "$HOST_ALIAS" true 2>/dev/null && break
    sleep 5
  done
}

# Install gh + Claude Code on the box, run their interactive auth, and clone
# the repo (GIT_REPO from config, else this checkout's origin).
remote_bootstrap() {
  REPO_URL="${GIT_REPO:-$(git -C "$ROOT" remote get-url origin)}"
  REPO_SLUG="$(sed -E 's#(git@github.com:|https://github.com/)##; s/\.git$//' <<<"$REPO_URL")"

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
}
