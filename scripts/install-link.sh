#!/usr/bin/env bash
# install-link — symlink the in-repo Rust binary + daemon bundle into ~/.local
# AND bootstrap the daemon's node_modules so `ghax attach` works.
#
# Why the bootstrap: dist/ghax-daemon.mjs imports `playwright` and `source-map`
# as bare specifiers. esbuild leaves them external, so the .mjs needs a sibling
# node_modules directory to resolve them.
#
# Idempotent.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SHARE_DIR="$HOME/.local/share/ghax"
BIN="$REPO/target/release/ghax"
DAEMON="$REPO/dist/ghax-daemon.mjs"

[ -x "$BIN" ]    || { echo "ghax: $BIN missing — run 'bun run build:rust' first" >&2; exit 1; }
[ -f "$DAEMON" ] || { echo "ghax: $DAEMON missing — run 'bun run build' first"   >&2; exit 1; }

mkdir -p "$HOME/.local/bin" "$SHARE_DIR"
ln -sf "$BIN" "$HOME/.local/bin/ghax"
ln -sf "$DAEMON" "$SHARE_DIR/ghax-daemon.mjs"

# Bootstrap daemon runtime (no-op if already current).
bash "$REPO/scripts/bootstrap-daemon-runtime.sh" "$SHARE_DIR"

echo "linked → $HOME/.local/bin/ghax"
echo "        + $SHARE_DIR/ghax-daemon.mjs"
echo "        + $SHARE_DIR/node_modules/"
