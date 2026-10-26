#!/usr/bin/env bash
# install-release — download a published GitHub Release archive for this
# platform, verify its SHA-256, and install the binary + daemon bundle.
#
# Usage:
#   npm run install-release            # latest release
#   npm run install-release -- v0.4.2  # specific version
#   curl -fsSL https://raw.githubusercontent.com/kepptic/ghax/main/scripts/install-release.sh | bash
#
# Installs the binary to the first of:
#   1. $GHAX_BIN_DIR/ghax        (explicit override)
#   2. the dir of the `ghax` already on PATH, if that is a regular file
#      (not a symlink) in a writable dir, so the new version replaces the
#      one you actually run
#   3. ~/.cargo/bin/ghax         (the standard installer location)
# and the daemon to ~/.local/share/ghax/ghax-daemon.mjs + node_modules/.
#
# After installing, if `ghax` on PATH still resolves to some other file, the
# script prints that path with a fix and exits 1 (the install itself is done).
#
# When run from a pipe, the helper bootstrap-daemon-runtime.sh is not next to
# the script, so it is downloaded from the same tag.
#
# Public repo, so plain `curl` against GitHub's release-download URLs needs
# no auth and is the default. Falls back to `gh release download` (which
# carries your auth) only if curl fails — e.g. rate-limiting, or a future
# private fork — and `gh` happens to be installed.

set -euo pipefail

# Resolve SCRIPT_DIR before any `cd` happens — `$0` is often relative
# (e.g. when invoked via `bash scripts/install-release.sh` or
# `npm run install-release`), so deferring this until after we chdir
# into the temp dir breaks the bootstrap step below.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

REPO="kepptic/ghax"
VERSION="${1:-}"
SHARE_DIR="$HOME/.local/share/ghax"
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

# Pick the install dir: GHAX_BIN_DIR, else replace a regular-file ghax already
# on PATH (if we can write there), else ~/.cargo/bin.
if [ -n "${GHAX_BIN_DIR:-}" ]; then
  BIN_DIR="$GHAX_BIN_DIR"
else
  BIN_DIR="$HOME/.cargo/bin"
  EXISTING="$(command -v ghax 2>/dev/null || true)"
  if [ -n "$EXISTING" ] && [ -f "$EXISTING" ] && [ ! -L "$EXISTING" ] \
     && [ -w "$(dirname "$EXISTING")" ]; then
    BIN_DIR="$(dirname "$EXISTING")"
  fi
fi

# Follow symlinks to the final file (readlink -f is not on macOS bash 3.2 era).
resolve_path() {
  local p="$1" t
  while [ -L "$p" ]; do
    t="$(readlink "$p")"
    case "$t" in
      /*) p="$t" ;;
      *)  p="$(dirname "$p")/$t" ;;
    esac
  done
  echo "$(cd "$(dirname "$p")" && pwd -P)/$(basename "$p")"
}

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
mkdir -p "$BIN_DIR" "$SHARE_DIR" \
  || { echo "install-release: cannot create $BIN_DIR or $SHARE_DIR. Set GHAX_BIN_DIR to a writable dir and re-run" >&2; exit 1; }
# Copy to a temp name then rename: overwriting a signed Mach-O in place can
# leave the kernel's cached code signature stale ("Killed: 9" on macOS).
BIN_TMP="$BIN_DIR/.ghax.tmp.$$"
{ cp "$INNER/ghax" "$BIN_TMP" && chmod +x "$BIN_TMP" && mv -f "$BIN_TMP" "$BIN_DIR/ghax"; } \
  || { rm -f "$BIN_TMP"; echo "install-release: cannot write $BIN_DIR/ghax. Set GHAX_BIN_DIR to a writable dir and re-run" >&2; exit 1; }
cp "$INNER/ghax-daemon.mjs" "$SHARE_DIR/ghax-daemon.mjs"

# Bootstrap node_modules. The shared helper handles version-mismatch
# detection too — so users who upgrade across a playwright bump get a
# refreshed install_modules without us hardcoding versions here.
echo "install-release: bootstrapping daemon runtime in $SHARE_DIR (no-op if already current)..."
# Piped installs (`curl ... | bash`) have no scripts/ dir next to $0, so fetch
# the helper from the same tag. It reads ../package.json only if present and
# otherwise uses embedded defaults, so it needs no other sibling files.
BOOTSTRAP="$SCRIPT_DIR/bootstrap-daemon-runtime.sh"
if [ ! -f "$BOOTSTRAP" ]; then
  BOOTSTRAP_URL="https://raw.githubusercontent.com/$REPO/$VERSION/scripts/bootstrap-daemon-runtime.sh"
  mkdir -p "$TMP_DIR/scripts"
  BOOTSTRAP="$TMP_DIR/scripts/bootstrap-daemon-runtime.sh"
  curl -fsSL -o "$BOOTSTRAP" "$BOOTSTRAP_URL" \
    || { echo "install-release: could not download $BOOTSTRAP_URL. Check your network, or run the script from a ghax checkout" >&2; exit 1; }
fi
bash "$BOOTSTRAP" "$SHARE_DIR" > /dev/null

# Sanity check.
INSTALLED="$("$BIN_DIR/ghax" --version 2>/dev/null || echo unknown)"
echo "install-release: installed → $BIN_DIR/ghax ($INSTALLED)"
echo "install-release:           + $SHARE_DIR/ghax-daemon.mjs"
echo "install-release:           + $SHARE_DIR/node_modules/"

# Verify PATH resolves `ghax` to what we just installed. A different ghax
# earlier on PATH (an old copy, or a symlink into a dev build) keeps the old
# version active, so fail loudly with the fix.
hash -r 2>/dev/null || true
ACTIVE="$(command -v ghax 2>/dev/null || true)"
if [ -z "$ACTIVE" ] || [ "$(resolve_path "$ACTIVE")" != "$(resolve_path "$BIN_DIR/ghax")" ]; then
  echo "" >&2
  if [ -z "$ACTIVE" ]; then
    echo "install-release: $BIN_DIR is not on your PATH, so 'ghax' will not be found." >&2
    echo "                Fix: add it, e.g. export PATH=\"$BIN_DIR:\$PATH\"" >&2
  else
    echo "install-release: 'ghax' on your PATH is $ACTIVE, not the one just installed ($BIN_DIR/ghax)." >&2
    if [ -L "$ACTIVE" ]; then
      LINK_TARGET="$(readlink "$ACTIVE")"
      case "$LINK_TARGET" in
        *target/release/ghax|*target/debug/ghax)
          echo "                It is a symlink to $LINK_TARGET (likely an in-repo dev build)." >&2 ;;
        *)
          echo "                It is a symlink to $LINK_TARGET." >&2 ;;
      esac
    fi
    echo "                Fix, either:" >&2
    echo "                  1. rm \"$ACTIVE\"  (PATH falls through to $BIN_DIR)" >&2
    echo "                  2. ln -sf \"$BIN_DIR/ghax\" \"$ACTIVE\"" >&2
    echo "                  3. re-run with GHAX_BIN_DIR=\"$(dirname "$ACTIVE")\" to install over it" >&2
  fi
  exit 1
fi
