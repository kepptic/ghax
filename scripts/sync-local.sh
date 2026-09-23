#!/usr/bin/env bash
# sync-local — the post-release "make my machine match what I just shipped"
# command, in one idempotent step: pull, rebuild the CLI + daemon, install
# them, then reload the bridge extension so the browser catches up too —
# with no click in edge://extensions.
#
# Usage:
#   npm run sync-local              # pull + build + install + bridge reload
#   npm run sync-local -- --no-pull # skip the git pull (e.g. you already have
#                                    # the commit you want, or you're offline)
#
# Idempotent: running it twice in a row with nothing new to build is a
# no-op past the first line (no backups are made when the installed version
# already matches what was just built; the bridge reload still runs, since
# refreshing a service worker's cached build-info.json is cheap and safe
# even when nothing changed).
#
# Runs the extension half on a PRIVATE state file
# ($HOME/.ghax/sync-local.json), so it never collides with a running agent's
# daemon — it auto-picks a free bridge port instead of fighting one for 9223.
#
# Exit codes:
#   0  everything in sync (or the extension simply never showed up — see
#      below; the CLI+daemon half still succeeded in that case)
#   1  a build/install step failed
#   2  extension reachable but versions disagree, or its provenance is
#      still unknown after the reload (something didn't take)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DO_PULL=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) DO_PULL=0 ;;
    -h|--help)
      awk 'NR>1 && /^set -euo/{exit} NR>1{print}' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "sync-local: unknown arg '$arg'" >&2; exit 1 ;;
  esac
done

BIN_PATH="$HOME/.local/bin/ghax"
DAEMON_PATH="$HOME/.local/share/ghax/ghax-daemon.mjs"

echo "── ghax sync-local ──"

# ── 1. Pull ─────────────────────────────────────────────────────────
if [ "$DO_PULL" = 1 ]; then
  echo "▸ git pull --ff-only"
  git pull --ff-only
else
  echo "▸ git pull skipped (--no-pull)"
fi

# ── 2. Capture the currently-installed version, before we overwrite it ──
OLD_VERSION=""
if [ -x "$BIN_PATH" ]; then
  OLD_VERSION="$("$BIN_PATH" --version 2>/dev/null | awk '{print $2}' || true)"
fi

# ── 3. Rebuild ───────────────────────────────────────────────────────
echo "▸ npm run build:rust"
npm run build:rust --silent
echo "▸ npm run build"
npm run build --silent

NEW_VERSION="$("$REPO_ROOT/target/release/ghax" --version | awk '{print $2}')"

# ── 4. Dated backup of the previously-installed artifacts ───────────
# Only when there WAS a previous install and its version actually differs —
# re-running sync-local against an unchanged HEAD must not pile up backups.
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
  DATE_TAG="$(date +%Y-%m-%d)"
  if [ -f "$BIN_PATH" ]; then
    cp "$BIN_PATH" "$BIN_PATH.bak-$DATE_TAG-$OLD_VERSION"
    echo "▸ backed up $BIN_PATH → $(basename "$BIN_PATH").bak-$DATE_TAG-$OLD_VERSION"
  fi
  if [ -f "$DAEMON_PATH" ]; then
    cp "$DAEMON_PATH" "$DAEMON_PATH.bak-$DATE_TAG-$OLD_VERSION"
    echo "▸ backed up $DAEMON_PATH → $(basename "$DAEMON_PATH").bak-$DATE_TAG-$OLD_VERSION"
  fi
else
  echo "▸ no backup needed (installed version matches, or nothing installed yet)"
fi

# ── 5. Install ───────────────────────────────────────────────────────
echo "▸ scripts/install-link.sh"
bash "$REPO_ROOT/scripts/install-link.sh"

# ── 6. Bridge extension reload ───────────────────────────────────────
# A private state file so this never fights a running agent's daemon for a
# bridge port — it scans and auto-picks a free one, same as any second agent.
mkdir -p "$HOME/.ghax"
export GHAX_STATE_FILE="$HOME/.ghax/sync-local.json"
BIN="$BIN_PATH"

cleanup() {
  "$BIN" detach >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "▸ ghax attach --extension (private state file, own bridge port)"
"$BIN" attach --extension >/dev/null 2>&1 || {
  echo "sync-local: 'ghax attach --extension' failed to start the daemon — see above." >&2
  exit 1
}

# node -e reads the JSON straight off stdin so parsing doesn't need jq.
read_field() {
  # $1 = JSON on stdin, $2 = dotted path (e.g. "daemon.extensionInfo.gitSha")
  node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const path = process.argv[1].split(".");
    let v = data;
    for (const k of path) { v = v?.[k]; }
    process.stdout.write(v === undefined || v === null ? "" : String(v));
  ' "$2" <<< "$1"
}

echo "▸ waiting up to 30s for the bridge extension to connect..."
EXT_CONNECTED=0
VERSION_JSON=""
for _ in $(seq 1 30); do
  VERSION_JSON="$("$BIN" version --full --json 2>/dev/null || echo '{}')"
  if [ -n "$(read_field "$VERSION_JSON" "daemon.extensionInfo.version")" ]; then
    EXT_CONNECTED=1
    break
  fi
  sleep 1
done

if [ "$EXT_CONNECTED" = 1 ]; then
  echo "▸ ghax bridge reload --force --timeout 30000"
  # --force: this is an unattended local sync, not an interactive session —
  # keeping the extension current outweighs any in-progress agent's tab, and
  # every agent already recovers from a reload the same way it recovers from
  # an ordinary MV3 service-worker eviction (see docs/design/plan/09).
  "$BIN" bridge reload --force --timeout 30000 || {
    echo "sync-local: bridge reload did not complete cleanly — reporting versions as-is." >&2
  }
  VERSION_JSON="$("$BIN" version --full --json 2>/dev/null || echo '{}')"
else
  echo ""
  echo "sync-local: no bridge extension connected within 30s."
  echo "            Load/reload it once by hand in edge://extensions (or chrome://extensions),"
  echo "            then re-run 'npm run sync-local' to finish the bridge half."
fi

CLI_VERSION="$(read_field "$VERSION_JSON" "cli.version")"
CLI_SHA="$(read_field "$VERSION_JSON" "cli.gitSha")"
CLI_DATE="$(read_field "$VERSION_JSON" "cli.buildDate")"
DAEMON_VERSION="$(read_field "$VERSION_JSON" "daemon.version")"
DAEMON_SHA="$(read_field "$VERSION_JSON" "daemon.gitSha")"
DAEMON_DATE="$(read_field "$VERSION_JSON" "daemon.buildDate")"
EXT_VERSION="$(read_field "$VERSION_JSON" "daemon.extensionInfo.version")"
EXT_SHA="$(read_field "$VERSION_JSON" "daemon.extensionInfo.gitSha")"
EXT_DATE="$(read_field "$VERSION_JSON" "daemon.extensionInfo.buildDate")"

echo ""
echo "── versions ──"
printf '%-10s %-10s %-10s %s\n' "component" "version" "sha" "date"
printf '%-10s %-10s %-10s %s\n' "cli" "${CLI_VERSION:-?}" "${CLI_SHA:-?}" "${CLI_DATE:-?}"
printf '%-10s %-10s %-10s %s\n' "daemon" "${DAEMON_VERSION:-?}" "${DAEMON_SHA:-?}" "${DAEMON_DATE:-?}"
if [ "$EXT_CONNECTED" = 1 ]; then
  printf '%-10s %-10s %-10s %s\n' "extension" "${EXT_VERSION:-?}" "${EXT_SHA:-?}" "${EXT_DATE:-?}"
else
  printf '%-10s %s\n' "extension" "(not connected)"
fi

# ── 7. Verdict ───────────────────────────────────────────────────────
CLI_DAEMON_MATCH=1
[ "$CLI_VERSION" = "$DAEMON_VERSION" ] && [ -n "$CLI_VERSION" ] || CLI_DAEMON_MATCH=0

if [ "$EXT_CONNECTED" = 0 ]; then
  if [ "$CLI_DAEMON_MATCH" = 1 ]; then
    echo ""
    echo "sync-local: CLI + daemon are in sync (v$CLI_VERSION). Extension pending — see above."
    exit 0
  fi
  echo ""
  echo "sync-local: CLI ($CLI_VERSION) and daemon ($DAEMON_VERSION) disagree — something didn't rebuild." >&2
  exit 1
fi

ALL_MATCH=1
[ "$CLI_DAEMON_MATCH" = 1 ] || ALL_MATCH=0
[ "$CLI_VERSION" = "$EXT_VERSION" ] || ALL_MATCH=0
[ -n "$EXT_SHA" ] && [ "$EXT_SHA" != "unknown" ] || ALL_MATCH=0

if [ "$ALL_MATCH" = 1 ]; then
  echo ""
  echo "sync-local: cli / daemon / extension all at v$CLI_VERSION ($CLI_SHA) — fully in sync."
  exit 0
fi

echo ""
echo "sync-local: versions disagree, or the extension's provenance is still unknown after reload." >&2
exit 2
