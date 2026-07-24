#!/usr/bin/env bash
# install-link — install the in-repo Rust binary + daemon bundle into ~/.local
# AND bootstrap the daemon's node_modules so `ghax attach` works.
#
# By DEFAULT this COPIES the artifacts (like install-release.sh does), so a
# later `cargo clean` or disk cleanup can't decapitate the installed CLI — the
# exact failure that made an unreleased binary look like it was missing whole
# features (docs/design/plan/08-bridge-reliability.md §0). Pass --link for the
# old symlink behaviour, which is genuinely useful during active development:
# rebuild and the installed CLI updates in place with no reinstall.
#
# Why the bootstrap: dist/ghax-daemon.mjs imports `playwright` and `source-map`
# as bare specifiers. esbuild leaves them external, so the .mjs needs a sibling
# node_modules directory to resolve them.
#
# Idempotent.

set -euo pipefail

MODE="copy"
for arg in "$@"; do
  case "$arg" in
    --link) MODE="link" ;;
    --copy) MODE="copy" ;;
    -h|--help)
      echo "Usage: install-link.sh [--copy | --link]"
      echo "  --copy  (default) copy binary + daemon bundle — survives 'cargo clean'"
      echo "  --link  symlink into target/release + dist — updates in place on rebuild (dev)"
      exit 0 ;;
    *) echo "install-link: unknown arg '$arg' (expected --copy or --link)" >&2; exit 1 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SHARE_DIR="$HOME/.local/share/ghax"
BIN="$REPO/target/release/ghax"
DAEMON="$REPO/dist/ghax-daemon.mjs"

[ -x "$BIN" ]    || { echo "ghax: $BIN missing — run 'bun run build:rust' first" >&2; exit 1; }
[ -f "$DAEMON" ] || { echo "ghax: $DAEMON missing — run 'bun run build' first"   >&2; exit 1; }

mkdir -p "$HOME/.local/bin" "$SHARE_DIR"
if [ "$MODE" = "link" ]; then
  ln -sf "$BIN" "$HOME/.local/bin/ghax"
  ln -sf "$DAEMON" "$SHARE_DIR/ghax-daemon.mjs"
  VERB="linked"
else
  # Replace any prior symlink with a real copy (rm first so we don't write
  # through a dangling/old link into target/).
  rm -f "$HOME/.local/bin/ghax" "$SHARE_DIR/ghax-daemon.mjs"
  cp "$BIN" "$HOME/.local/bin/ghax"
  chmod +x "$HOME/.local/bin/ghax"
  cp "$DAEMON" "$SHARE_DIR/ghax-daemon.mjs"
  VERB="copied"
fi

# Bootstrap daemon runtime (no-op if already current).
bash "$REPO/scripts/bootstrap-daemon-runtime.sh" "$SHARE_DIR"

echo "$VERB → $HOME/.local/bin/ghax"
echo "        + $SHARE_DIR/ghax-daemon.mjs"
echo "        + $SHARE_DIR/node_modules/"
