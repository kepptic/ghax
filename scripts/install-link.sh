#!/usr/bin/env bash
# install-link — symlink the in-repo Rust binary + daemon bundle into ~/.local
# AND bootstrap the daemon's node_modules so `ghax attach` actually works.
#
# Why the bootstrap: dist/ghax-daemon.mjs imports `playwright` as a bare
# specifier. esbuild marks it external, so the .mjs needs to find playwright
# via Node's module resolution. We give it a sibling node_modules dir.
#
# This script is idempotent — running it twice is fine.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SHARE_DIR="$HOME/.local/share/ghax"
BIN="$REPO/target/release/ghax"
DAEMON="$REPO/dist/ghax-daemon.mjs"

# ── 0. Sanity: built artifacts exist ──────────────────────────────
[ -x "$BIN" ]    || { echo "ghax: $BIN missing — run 'bun run build:rust' first" >&2; exit 1; }
[ -f "$DAEMON" ] || { echo "ghax: $DAEMON missing — run 'bun run build' first"   >&2; exit 1; }

# ── 1. Symlink the binary ─────────────────────────────────────────
mkdir -p "$HOME/.local/bin" "$SHARE_DIR"
ln -sf "$BIN" "$HOME/.local/bin/ghax"
ln -sf "$DAEMON" "$SHARE_DIR/ghax-daemon.mjs"

# ── 2. Bootstrap daemon's node_modules (BUG-001 fix) ──────────────
# Read playwright version from the repo's package.json so we stay in sync.
PW_VERSION="$(node -e 'console.log(require("'"$REPO"'/package.json").dependencies.playwright || "*")')"

SM_VERSION="$(node -e 'console.log(require("'"$REPO"'/package.json").dependencies["source-map"] || "*")')"

cat > "$SHARE_DIR/package.json" <<JSON
{
  "name": "ghax-daemon-runtime",
  "private": true,
  "type": "module",
  "description": "Sibling deps for ghax-daemon.mjs — see scripts/install-link.sh",
  "dependencies": {
    "playwright": "$PW_VERSION",
    "source-map": "$SM_VERSION"
  }
}
JSON

# Only npm-install if playwright isn't already installed at the right version,
# or the install dir is empty. Avoids a pointless ~10s on every re-run.
NEED_INSTALL=1
if [ -f "$SHARE_DIR/node_modules/playwright/package.json" ]; then
  CURRENT="$(node -e 'console.log(require("'"$SHARE_DIR"'/node_modules/playwright/package.json").version)' 2>/dev/null || echo "")"
  WANTED="$(node -e 'console.log(require("'"$REPO"'/node_modules/playwright/package.json").version)')"
  [ "$CURRENT" = "$WANTED" ] && NEED_INSTALL=0
fi

if [ "$NEED_INSTALL" = "1" ]; then
  echo "ghax: bootstrapping daemon runtime in $SHARE_DIR (one-time, ~10s)..."
  (cd "$SHARE_DIR" && npm install --silent --no-audit --no-fund --omit=dev 2>&1 | grep -vE '^(npm warn|added|removed|changed)' || true)
fi

# ── 3. Done ──────────────────────────────────────────────────────
echo "linked → $HOME/.local/bin/ghax"
echo "        + $SHARE_DIR/ghax-daemon.mjs"
echo "        + $SHARE_DIR/node_modules/ (playwright $PW_VERSION)"
