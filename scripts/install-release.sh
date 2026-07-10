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
# Public repo, so plain `curl` against GitHub's release-download URLs needs
# no auth and is the default. Falls back to `gh release download` (which
# carries your auth) only if curl fails — e.g. rate-limiting, or a future
# private fork — and `gh` happens to be installed.

set -euo pipefail

# Resolve SCRIPT_DIR before any `cd` happens — `$0` is often relative
# (e.g. when invoked via `bash scripts/install-release.sh` or
# `bun run install-release`), so deferring this until after we chdir
# into the temp dir breaks the bootstrap step below.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

REPO="kepptic/ghax"
VERSION="${1:-}"
SHARE_DIR="$HOME/.local/share/ghax"
BIN_DIR="$HOME/.cargo/bin"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Resolve version → tag (default to latest if blank). Plain curl against the
# public GitHub API first — no `gh` CLI or auth required. Only falls back to
# `gh` if curl can't get an answer and `gh` happens to be installed.
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
              | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true)"
  if [ -z "$VERSION" ] && command -v gh >/dev/null 2>&1; then
    VERSION="$(gh release list --repo "$REPO" --limit 5 --json tagName,isPrerelease \
                --jq '[.[] | select(.isPrerelease == false)][0].tagName' 2>/dev/null || true)"
  fi
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

# Download archive + checksum. curl first (public releases, no auth needed);
# fall back to `gh release download` if curl fails and gh is available.
cd "$TMP_DIR"
if ! curl -fsSL -o "$ARCHIVE" "https://github.com/$REPO/releases/download/$VERSION/$ARCHIVE" \
   || ! curl -fsSL -o "$ARCHIVE.sha256" "https://github.com/$REPO/releases/download/$VERSION/$ARCHIVE.sha256"; then
  rm -f "$ARCHIVE" "$ARCHIVE.sha256"
  if command -v gh >/dev/null 2>&1; then
    echo "install-release: curl download failed, retrying via gh..." >&2
    gh release download "$VERSION" --repo "$REPO" -p "$ARCHIVE" -p "$ARCHIVE.sha256"
  else
    echo "install-release: failed to download $ARCHIVE from $REPO releases $VERSION (no gh CLI to fall back on)" >&2
    exit 1
  fi
fi

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
