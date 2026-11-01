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
# refreshing a service worker's cached build-info.js is cheap and safe
# even when nothing changed).
#
# Runs the extension half on a PRIVATE state file
# ($HOME/.ghax/sync-local.json), so it never collides with a running agent's
# daemon — it auto-picks a free bridge port instead of fighting one for 9223.
# With several browsers running the extension (Chrome + Edge, or two
# profiles), attach binds nothing (BRIDGE_AMBIGUOUS); the script then walks
# `ghax bridge instances` and does `bridge use <id>` + `bridge reload` for
# EVERY instance, reporting each. An extension too old to ack a reload gets a
# manual edge://extensions instruction and the loop continues. All ghax calls
# run under `timeout`.
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

# macOS has no `timeout`; coreutils' `gtimeout` is the same thing.
if ! command -v timeout >/dev/null 2>&1; then
  if command -v gtimeout >/dev/null 2>&1; then
    timeout() { gtimeout "$@"; }
  else
    echo "sync-local: needs 'timeout' (macOS: brew install coreutils)." >&2
    exit 1
  fi
fi

cleanup() {
  timeout 30 "$BIN" detach >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Every ghax call is bounded: a wedged daemon must not hang the sync.
# </dev/null: g runs inside `while read ... <<< list` loops; a ghax call that
# touched stdin would swallow the remaining rows.
g() { timeout "${GHAX_SYNC_TIMEOUT:-60}" "$BIN" "$@" </dev/null; }

echo "▸ ghax attach --extension (private state file, own bridge port)"
# With Chrome + Edge both running the extension, attach reports
# BRIDGE_AMBIGUOUS and binds nothing — that is fine: the daemon is up and we
# bind each instance in turn below. Only a daemon that is not reachable at all
# is fatal.
timeout 60 "$BIN" attach --extension >/dev/null 2>&1 || true
if ! g status >/dev/null 2>&1; then
  echo "sync-local: 'ghax attach --extension' failed to start the daemon — see above." >&2
  exit 1
fi

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

# Print "<instanceId>\t<browser>\t<label>" per connected instance.
list_instances() {
  local json
  json="$(g bridge instances --json 2>/dev/null || echo '{}')"
  node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const i of d.instances ?? []) console.log([i.instanceId, i.browser, i.label].join("\t"));
  ' <<< "$json" 2>/dev/null || true
}

echo "▸ waiting up to 30s for the bridge extension(s) to connect..."
INSTANCES=""
for _ in $(seq 1 30); do
  INSTANCES="$(list_instances)"
  [ -n "$INSTANCES" ] && break
  sleep 1
done

EXT_CONNECTED=0
VERSION_JSON=""
RELOAD_FAILED=0
# Per-instance extension versions, for the verdict.
EXT_ROWS=""
EXT_MISMATCH=0

if [ -n "$INSTANCES" ]; then
  EXT_CONNECTED=1
  # --force: this is an unattended local sync, not an interactive session —
  # keeping the extension current outweighs any in-progress agent's tab, and
  # every agent already recovers from a reload the same way it recovers from
  # an ordinary MV3 service-worker eviction (see docs/design/plan/09).
  while IFS=$'\t' read -r IID IBROWSER ILABEL; do
    [ -n "$IID" ] || continue
    WHO="$IBROWSER${ILABEL:+ ($ILABEL)} [${IID:0:8}]"
    echo "▸ $WHO: bridge use + reload"
    if ! g bridge use "$IID" >/dev/null 2>&1; then
      echo "  could not bind $WHO — skipped." >&2
      RELOAD_FAILED=1
      continue
    fi
    if g bridge reload --force --timeout 30000 >/dev/null 2>&1; then
      echo "  reloaded."
    else
      RELOAD_FAILED=1
      echo "  no reload ack (a pre-reload extension can't reload itself)." >&2
      echo "  Reload it by hand once: open edge://extensions (or chrome://extensions) in $IBROWSER and click reload on 'ghax bridge'." >&2
    fi
    # The reload re-handshakes; give the instance a moment, then read what it reports.
    sleep 2
    VJ="$(g version --full --json 2>/dev/null || echo '{}')"
    VERSION_JSON="$VJ"
    EXT_ROWS+="$IBROWSER${ILABEL:+ ($ILABEL)}"$'\t'"$(read_field "$VJ" "daemon.extensionInfo.version")"$'\t'"$(read_field "$VJ" "daemon.extensionInfo.gitSha")"$'\t'"$(read_field "$VJ" "daemon.extensionInfo.buildDate")"$'\n'
  done <<< "$INSTANCES"
else
  echo ""
  echo "sync-local: no bridge extension connected within 30s."
  echo "            Load/reload it once by hand in edge://extensions (or chrome://extensions),"
  echo "            then re-run 'npm run sync-local' to finish the bridge half."
  VERSION_JSON="$(g version --full --json 2>/dev/null || echo '{}')"
fi

CLI_VERSION="$(read_field "$VERSION_JSON" "cli.version")"
CLI_SHA="$(read_field "$VERSION_JSON" "cli.gitSha")"
CLI_DATE="$(read_field "$VERSION_JSON" "cli.buildDate")"
DAEMON_VERSION="$(read_field "$VERSION_JSON" "daemon.version")"
DAEMON_SHA="$(read_field "$VERSION_JSON" "daemon.gitSha")"
DAEMON_DATE="$(read_field "$VERSION_JSON" "daemon.buildDate")"
echo ""
echo "── versions ──"
printf '%-10s %-10s %-10s %s\n' "component" "version" "sha" "date"
printf '%-10s %-10s %-10s %s\n' "cli" "${CLI_VERSION:-?}" "${CLI_SHA:-?}" "${CLI_DATE:-?}"
printf '%-10s %-10s %-10s %s\n' "daemon" "${DAEMON_VERSION:-?}" "${DAEMON_SHA:-?}" "${DAEMON_DATE:-?}"
if [ "$EXT_CONNECTED" = 1 ]; then
  while IFS=$'\t' read -r ENAME EVER ESHA EDATE; do
    [ -n "$ENAME" ] || continue
    printf '%-10s %-10s %-10s %s\n' "ext:$ENAME" "${EVER:-?}" "${ESHA:-?}" "${EDATE:-?}"
    [ "$EVER" = "$CLI_VERSION" ] && [ -n "$ESHA" ] && [ "$ESHA" != "unknown" ] || EXT_MISMATCH=1
  done <<< "$EXT_ROWS"
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
[ "$EXT_MISMATCH" = 0 ] || ALL_MATCH=0

if [ "$ALL_MATCH" = 1 ]; then
  echo ""
  echo "sync-local: cli / daemon / extension all at v$CLI_VERSION ($CLI_SHA) — fully in sync (every connected browser)."
  exit 0
fi

echo ""
echo "sync-local: a connected extension's version disagrees or its provenance is still unknown after reload (RELOAD_FAILED=$RELOAD_FAILED)." >&2
exit 2
