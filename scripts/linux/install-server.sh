#!/usr/bin/env bash
# Installs or updates the School Dashboard server as a systemd user service.
# Run it from the checkout on the Linux server (scripts/deploy-server.ps1 does this for you):
#
#   bash scripts/linux/install-server.sh
#
# Safe to rerun: it reuses the Node.js it installed, keeps .env values, rebuilds, and restarts.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_VERSION="${SCHOOL_DASHBOARD_NODE_VERSION:-24.15.0}"
NODE_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/school-dashboard/node-v${NODE_VERSION}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="school-dashboard.service"
ENV_FILE="$APP_DIR/.env"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

cd "$APP_DIR"

# --- Node.js ------------------------------------------------------------------------------
# Vite 8 and sharp need Node 20.19+/22.12+. A distro Node 18 is too old, and sudo is not needed:
# a checksum-verified official build is installed for this user only.
node_is_recent() {
  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19) ? 0 : 1)' 2>/dev/null
}
if [[ -x "$NODE_HOME/bin/node" ]] && node_is_recent "$NODE_HOME/bin/node"; then
  NODE_BIN="$NODE_HOME/bin/node"
elif command -v node >/dev/null && node_is_recent "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
else
  case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64) node_arch=arm64 ;;
    *) die "Unsupported CPU $(uname -m); install Node.js 22 or newer and rerun." ;;
  esac
  archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  log "Installing Node.js ${NODE_VERSION} in ${NODE_HOME} (system Node is missing or too old)"
  download="$(mktemp -d)"
  trap 'rm -rf "$download"' EXIT
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "$download/$archive"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$download/SHASUMS256.txt"
  (cd "$download" && grep " ${archive}\$" SHASUMS256.txt | sha256sum -c - >/dev/null) \
    || die "The Node.js download failed its checksum."
  mkdir -p "$NODE_HOME"
  tar -xJf "$download/$archive" -C "$NODE_HOME" --strip-components=1
  NODE_BIN="$NODE_HOME/bin/node"
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
log "Using Node.js $("$NODE_BIN" --version) at $NODE_BIN"

for tool in pdfinfo pdftotext pdftoppm; do
  command -v "$tool" >/dev/null \
    || log "warning: $tool is missing; PDF workflows need poppler-utils (sudo apt install poppler-utils)."
done

# --- Dependencies and production bundle ---------------------------------------------------
log "Installing dependencies"
npm ci --no-audit --no-fund
log "Building the dashboard"
npm run build

# --- .env ---------------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  cp .env.example "$ENV_FILE"
  log "Created .env from .env.example"
fi
chmod 600 "$ENV_FILE"
# A .env edited or copied from Windows may carry CRLF endings; keep values free of stray CRs.
sed -i 's/\r$//' "$ENV_FILE"
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}
[[ -n "$(env_value SCHOOL_DASHBOARD_HOST)" ]] || set_env SCHOOL_DASHBOARD_HOST 0.0.0.0
[[ -n "$(env_value SCHOOL_DASHBOARD_AGENT_EXECUTION)" ]] || set_env SCHOOL_DASHBOARD_AGENT_EXECUTION worker
if [[ -z "$(env_value SCHOOL_DASHBOARD_WORKER_TOKEN)" ]]; then
  set_env SCHOOL_DASHBOARD_WORKER_TOKEN "$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  log "Generated SCHOOL_DASHBOARD_WORKER_TOKEN (copy it into the laptop's .env)"
fi
case "$(env_value CANVAS_API_TOKEN)" in
  "" | replace-with-your-token) log "warning: CANVAS_API_TOKEN is not set in $ENV_FILE" ;;
esac
if [[ -n "$(env_value TASK_SYNC_SSH_TARGET)" ]]; then
  log "warning: TASK_SYNC_SSH_TARGET is set. On the Task Sync server itself, clear it and use"
  log "         TASK_SYNC_API_BASE=http://127.0.0.1:8790/api/v1 instead."
fi
port="$(env_value SCHOOL_DASHBOARD_PORT)"
port="${port:-8892}"

# --- systemd user service -----------------------------------------------------------------
mkdir -p "$UNIT_DIR"
sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@NODE@|$NODE_BIN|g" \
  deploy/linux/school-dashboard.service >"$UNIT_DIR/$UNIT_NAME"
systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1
systemctl --user restart "$UNIT_NAME"
log "Installed and (re)started $UNIT_NAME"
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
  log "warning: lingering is off, so the dashboard will not start at boot or survive logout."
  log "         Enable it once with: sudo loginctl enable-linger $USER"
fi

# --- Codex on this server ------------------------------------------------------------------
# The dashboard's "Run agents on" switch can send runs to Codex here instead of the laptop. That
# uses this user's own ~/.codex sign-in (never the laptop's).
codex_bin="$(find "$APP_DIR/node_modules/@openai" -path '*/vendor/*/codex' -type f 2>/dev/null | head -n 1)"
if [[ -n "$codex_bin" ]] && "$codex_bin" login status >/dev/null 2>&1; then
  log "Codex is signed in on this server, so agents can also run here (switch in the dashboard sidebar)"
else
  log "note: Codex is not signed in on this server; the Server agent option stays unavailable until you run"
  log "      ${codex_bin:-node_modules/@openai/codex-linux-x64/vendor/*/bin/codex} login --device-auth"
fi

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${port}/api/settings" >/dev/null 2>&1; then
    log "School Dashboard is up: http://$(hostname):${port}/ (Tailscale only)"
    log "Laptop .env: SCHOOL_DASHBOARD_SERVER_URL=http://$(hostname):${port}"
    log "             SCHOOL_DASHBOARD_WORKER_TOKEN=<the value in $ENV_FILE>"
    exit 0
  fi
  sleep 1
done
systemctl --user --no-pager status "$UNIT_NAME" | tail -n 20 || true
die "The dashboard did not answer on port ${port}. Logs: journalctl --user -u $UNIT_NAME -e"
