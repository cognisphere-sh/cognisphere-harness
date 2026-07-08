#!/usr/bin/env bash
# Bootstrap an agent's runtime: system binaries (ffmpeg, pdftoppm) and a
# Python venv + deps (markitdown[all], ddgs).
#
# Idempotent — safe to re-run. The script is non-interactive: it never
# prompts for a sudo password. If a system dep is missing and we can't
# install it without sudo, we emit a warning and continue, so the server
# boot doesn't hang.
#
# Usage (from anywhere):
#   bash bootstrap/bootstrap.sh
#
# Override the Python interpreter:
#   PYTHON=python3.12 bash bootstrap/bootstrap.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$AGENT_DIR"

PYTHON="${PYTHON:-python3}"

log() { printf "bootstrap: %s\n" "$*"; }
warn() { printf "bootstrap: WARN: %s\n" "$*" >&2; }

# ── 0. Make tool wrappers executable ──────────────────────────────────
# The agent invokes scripts/ wrappers directly (e.g. scripts/agent/markitdown).
# An exec bit can go missing — a file committed 100644, a `cp` that dropped it,
# a checkout on a noexec/relaxed filesystem — and the agent then gets a bare
# "Permission denied". Re-assert +x on every script (anything with a shebang)
# under scripts/ so this can't silently recur.
if [ -d scripts ]; then
  count=0
  while IFS= read -r f; do
    if [ "$(head -c2 "$f" 2>/dev/null)" = '#!' ] && [ ! -x "$f" ]; then
      chmod +x "$f" && count=$((count + 1))
    fi
  done < <(find scripts -type f)
  log "ensured scripts/ wrappers are executable (${count} fixed)"
fi

# ── 1. System binaries: ffmpeg + pdftoppm ─────────────────────────────
# Best-effort install. Skips silently if already present; warns and
# continues if no usable package manager is available without sudo.
install_system_dep() {
  local cmd="$1" macos_pkg="$2" debian_pkg="$3"
  if command -v "$cmd" >/dev/null 2>&1; then
    log "$cmd already installed"
    return
  fi
  if [[ "$OSTYPE" == "darwin"* ]] && command -v brew >/dev/null 2>&1; then
    log "installing $macos_pkg via brew (provides $cmd)..."
    brew install "$macos_pkg" || warn "brew install $macos_pkg failed"
  elif command -v apt-get >/dev/null 2>&1; then
    if [ "$EUID" -eq 0 ]; then
      log "installing $debian_pkg via apt-get (provides $cmd)..."
      DEBIAN_FRONTEND=noninteractive apt-get update -qq \
        && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$debian_pkg" \
        || warn "apt-get install $debian_pkg failed"
    else
      warn "$cmd missing; install by hand: sudo apt-get install -y $debian_pkg"
    fi
  else
    warn "$cmd missing; install '$macos_pkg' (macOS) or '$debian_pkg' (Debian/Ubuntu) by hand"
  fi
}

install_system_dep ffmpeg   ffmpeg  ffmpeg
install_system_dep pdftoppm poppler poppler-utils

# ── 2. Python venv + pip deps ─────────────────────────────────────────
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  warn "'$PYTHON' not found on PATH. Set PYTHON=<your-python> and re-run."
  exit 1
fi
# A venv needs ensurepip to seed pip. On Debian/Ubuntu that lives in the
# python3-venv package; without it `python -m venv` aborts mid-create and
# leaves a BROKEN .venv (bin/ has the python symlinks but no activate, no pip).
# Check up front and fail with an actionable message instead of producing junk.
if ! "$PYTHON" -c 'import ensurepip' >/dev/null 2>&1; then
  pyver="$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo 3)"
  warn "ensurepip is unavailable for '$PYTHON'; a working venv can't be built."
  warn "install it (root):  sudo apt-get install -y python${pyver}-venv python3-pip"
  exit 1
fi
# Create the venv if missing, or RECREATE it if a prior run left it incomplete
# (no bin/activate — e.g. it was built before python3-venv was installed).
if [ ! -f ".venv/bin/activate" ]; then
  if [ -d ".venv" ]; then
    warn "existing .venv is incomplete (no bin/activate) — recreating from scratch"
    rm -rf .venv
  fi
  log "creating .venv with $PYTHON ..."
  "$PYTHON" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r bootstrap/requirements.txt

# ── npm global prefix: make it user-writable ──────────────────────────
# The default npm prefix may be a root-owned dir (e.g. /usr), so `npm install
# -g` fails with EACCES when bootstrap runs as the (non-root) app user. Point
# it at ~/.npm-global — where the pi/agent-browser wrappers already look — and
# put its bin dir on PATH for the rest of this script and this shell.
if command -v npm >/dev/null 2>&1; then
  export NPM_CONFIG_PREFIX="$HOME/.npm-global"
  mkdir -p "$NPM_CONFIG_PREFIX/bin"
  export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
fi

# ── 3. pi-coding-agent (npm global) ───────────────────────────────────
# Provides the `pi` binary that the harness runner spawns (`pi --mode rpc`).
if command -v pi >/dev/null 2>&1; then
  log "pi-coding-agent already installed ($(command -v pi))"
elif command -v npm >/dev/null 2>&1; then
  log "installing @earendil-works/pi-coding-agent via npm..."
  npm install -g @earendil-works/pi-coding-agent \
    || warn "npm install -g @earendil-works/pi-coding-agent failed"
else
  warn "npm not found; install Node.js (https://nodejs.org) and re-run, or install @earendil-works/pi-coding-agent by hand"
fi

# ── 4. agent-browser (npm global) + its Chrome build ──────────────────
if command -v npm >/dev/null 2>&1; then
  if command -v agent-browser >/dev/null 2>&1; then
    log "agent-browser already installed ($(command -v agent-browser))"
  else
    log "installing agent-browser via npm..."
    npm install -g agent-browser 2>/dev/null \
      || warn "npm install -g agent-browser failed (npm prefix perms?)"
  fi
  # Download the Chrome build agent-browser drives (~180MB, first run only).
  browsers_dir="$HOME/.agent-browser/browsers"
  if command -v agent-browser >/dev/null 2>&1; then
    if [ -d "$browsers_dir" ] && [ -n "$(ls -A "$browsers_dir" 2>/dev/null)" ]; then
      log "agent-browser Chrome already downloaded"
    else
      log "downloading Chrome for agent-browser..."
      agent-browser install || warn "agent-browser install (Chrome download) failed"
    fi
  fi
else
  warn "npm not found; install Node.js (https://nodejs.org) and re-run, or install agent-browser by hand"
fi

log "done. Restart the server so the runner picks up the new .venv + tools."
