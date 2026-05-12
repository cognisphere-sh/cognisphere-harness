#!/usr/bin/env bash
# Bootstrap an agent's runtime: system binaries (ffmpeg, pdftoppm), Python
# venv + deps (markitdown[all]), and the websearch CLI (Rust).
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
if [ ! -d ".venv" ]; then
  log "creating .venv with $PYTHON ..."
  "$PYTHON" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r bootstrap/requirements.txt

# ── 3. websearch (Rust binary) ────────────────────────────────────────
if command -v websearch >/dev/null 2>&1; then
  log "websearch already installed"
elif command -v cargo >/dev/null 2>&1; then
  log "installing websearch via cargo (xynehq/websearch)..."
  cargo install --git https://github.com/xynehq/websearch.git \
    || warn "cargo install websearch failed"
else
  warn "cargo (Rust) not found; install Rust (https://rustup.rs) and re-run, or install websearch by hand"
fi

# ── 4. agent-browser (npm global) ─────────────────────────────────────
if command -v agent-browser >/dev/null 2>&1; then
  log "agent-browser already installed"
elif command -v npm >/dev/null 2>&1; then
  log "installing agent-browser via npm..."
  if npm install -g agent-browser 2>/dev/null; then
    agent-browser install || warn "agent-browser install (browser deps) failed"
  else
    warn "npm install -g agent-browser failed (permission issue? try: sudo npm install -g agent-browser)"
  fi
else
  warn "npm not found; install Node.js (https://nodejs.org) and re-run, or install agent-browser by hand"
fi

log "done. Restart the server so the runner picks up the new .venv."
