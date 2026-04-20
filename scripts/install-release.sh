#!/usr/bin/env bash
# install-release — download a published GitHub Release archive for this
# platform, verify its SHA-256, and install the binary + daemon bundle.
#
# Usage:
#   bun run install-release            # latest release
#   bun run install-release v0.4.2     # specific version
#
# Installs to:
#   ~/.cargo/bin/ghax            (the standard installer location)
#   ~/.local/share/ghax/ghax-daemon.mjs + node_modules/ (bootstrap)
#
# Repo private? Uses `gh release download` (which carries your auth) —
# falls back to a plain curl if gh isn't installed.

set -euo pipefail

REPO="kepptic/ghax"
VERSION="${1:-}"
SHARE_DIR="$HOME/.local/share/ghax"
BIN_DIR="$HOME/.cargo/bin"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Resolve version → tag (default to latest if blank).
if [ -z "$VERSION" ]; then
  VERSION="$(gh release list --repo "$REPO" --limit 5 --json tagName,isPrerelease \
              --jq '[.[] | select(.isPrerelease == false)][0].tagName' 2>/dev/null || true)"
  [ -z "$VERSION" ] && { echo "install-release: no published (non-prerelease) release found in $REPO" >&2; exit 1; }
fi
echo "install-release: version $VERSION"

# Detect platform → triple.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  TRIPLE="aarch64-apple-darwin" ;;
  Darwin-x86_64) TRIPLE="x86_64-apple-darwin" ;;
  Linux-aarch64) TRIPLE="aarch64-unknown-linux-gnu" ;;
  Linux-x86_64)  TRIPLE="x86_64-unknown-linux-gnu" ;;
  *) echo "install-release: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
ARCHIVE="ghax-$TRIPLE.tar.xz"
echo "install-release: target $ARCHIVE"

# Download archive + checksum.
cd "$TMP_DIR"
gh release download "$VERSION" --repo "$REPO" -p "$ARCHIVE" -p "$ARCHIVE.sha256"

# Verify checksum.
if command -v shasum >/dev/null 2>&1; then
  EXPECTED="$(awk '{print $1}' "$ARCHIVE.sha256")"
  ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  [ "$EXPECTED" = "$ACTUAL" ] || { echo "install-release: SHA-256 mismatch — expected $EXPECTED, got $ACTUAL" >&2; exit 1; }
  echo "install-release: SHA-256 OK ($EXPECTED)"
fi

# Unpack + install binary.
tar xJf "$ARCHIVE"
INNER="$TMP_DIR/ghax-$TRIPLE"
[ -x "$INNER/ghax" ]            || { echo "install-release: ghax binary missing in archive"   >&2; exit 1; }
[ -f "$INNER/ghax-daemon.mjs" ] || { echo "install-release: daemon bundle missing in archive" >&2; exit 1; }
mkdir -p "$BIN_DIR" "$SHARE_DIR"
cp "$INNER/ghax" "$BIN_DIR/ghax"
chmod +x "$BIN_DIR/ghax"
cp "$INNER/ghax-daemon.mjs" "$SHARE_DIR/ghax-daemon.mjs"

# Bootstrap node_modules. The shared helper handles version-mismatch
# detection too — so users who upgrade across a playwright bump get a
# refreshed install_modules without us hardcoding versions here.
echo "install-release: bootstrapping daemon runtime in $SHARE_DIR (no-op if already current)..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$SCRIPT_DIR/bootstrap-daemon-runtime.sh" "$SHARE_DIR" > /dev/null

# Sanity check.
INSTALLED="$("$BIN_DIR/ghax" --version 2>/dev/null || echo unknown)"
echo "install-release: installed → $BIN_DIR/ghax ($INSTALLED)"
echo "install-release:           + $SHARE_DIR/ghax-daemon.mjs"
echo "install-release:           + $SHARE_DIR/node_modules/"

# Heads-up if the symlink at ~/.local/bin/ghax shadows the installed binary.
if [ -L "$HOME/.local/bin/ghax" ]; then
  TARGET="$(readlink "$HOME/.local/bin/ghax")"
  case "$TARGET" in
    *target/release/ghax)
      echo ""
      echo "install-release: NOTE — ~/.local/bin/ghax still points at the in-repo dev build:"
      echo "                  $TARGET"
      echo "                Your PATH likely picks that one up first. To make the released"
      echo "                binary primary, either:"
      echo "                  1. rm ~/.local/bin/ghax  (PATH falls through to ~/.cargo/bin)"
      echo "                  2. ln -sf $BIN_DIR/ghax ~/.local/bin/ghax"
      ;;
  esac
fi
