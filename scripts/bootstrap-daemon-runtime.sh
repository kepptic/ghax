#!/usr/bin/env bash
# bootstrap-daemon-runtime — write a minimal package.json + run `npm install`
# in the target dir, so the ghax daemon bundle (which esbuild leaves with
# bare imports for `playwright` and `source-map`) can resolve them at runtime.
#
# Single source of truth for the bootstrap step. Called by:
#   - scripts/install-link.sh    (in-repo dev install)
#   - scripts/install-release.sh (post-download install of a release archive)
#   - crates/cli/src/attach.rs   (auto-bootstrap on first attach if missing)
#
# Usage:
#   scripts/bootstrap-daemon-runtime.sh <target-dir> [<playwright-version>] [<source-map-version>]
#
# Versions default to the current repo's package.json if invoked from a repo
# checkout, otherwise the embedded fallbacks (kept in sync with the build).

set -euo pipefail

TARGET="${1:-}"
[ -z "$TARGET" ] && { echo "bootstrap-daemon-runtime: missing <target-dir>" >&2; exit 1; }
mkdir -p "$TARGET"

PW_VERSION="${2:-}"
SM_VERSION="${3:-}"

# Try to read versions from the calling repo's package.json if not passed.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_PKG="$SCRIPT_DIR/../package.json"
if [ -z "$PW_VERSION" ] && [ -f "$REPO_PKG" ]; then
  read -r PW_VERSION SM_VERSION < <(node -e '
    const p = require(process.argv[1]).dependencies || {};
    process.stdout.write(`${p.playwright || "^1.58.2"} ${p["source-map"] || "^0.7.6"}\n`);
  ' "$REPO_PKG")
fi
PW_VERSION="${PW_VERSION:-^1.58.2}"
SM_VERSION="${SM_VERSION:-^0.7.6}"

# Decide whether install is needed: directory missing OR version mismatch.
NEED_INSTALL=1
if [ -f "$TARGET/node_modules/playwright/package.json" ]; then
  CURRENT="$(node -e 'console.log(require(process.argv[1]).version)' \
              "$TARGET/node_modules/playwright/package.json" 2>/dev/null || echo "")"
  # Wanted is the version constraint stripped of prefix chars (^/~/=).
  WANTED="${PW_VERSION#[\^~=]}"
  [ "$CURRENT" = "$WANTED" ] && NEED_INSTALL=0
fi

if [ "$NEED_INSTALL" = "0" ]; then
  exit 0
fi

cat > "$TARGET/package.json" <<JSON
{
  "name": "ghax-daemon-runtime",
  "private": true,
  "type": "module",
  "description": "Sibling deps for ghax-daemon.mjs",
  "dependencies": {
    "playwright": "$PW_VERSION",
    "source-map": "$SM_VERSION"
  }
}
JSON

(cd "$TARGET" && npm install --silent --no-audit --no-fund --omit=dev)
