#!/usr/bin/env bash
# release — bump version, tag, push, wait for the GitHub Actions release
# workflow to go green, then install the published artifact on this machine.
#
# Usage:
#   bun run release patch       # 0.4.2 → 0.4.3
#   bun run release minor       # 0.4.2 → 0.5.0
#   bun run release major       # 0.4.2 → 1.0.0
#   bun run release 0.4.3       # explicit version
#   bun run release             # default: patch
#
# Refuses to run if:
#   - working tree is dirty
#   - current branch isn't main (or trunk)
#   - the bumped tag already exists
#
# After tagging, polls `gh run watch` (which exits when the workflow finishes)
# then runs scripts/install-release.sh against the new tag. End state: the
# binary you just shipped is the binary you're running locally.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BUMP="${1:-patch}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# ── 0. Sanity ─────────────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  echo "release: working tree is dirty — commit or stash first" >&2
  git status --short >&2
  exit 1
fi
if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "trunk" ]; then
  echo "release: not on main/trunk (current: $BRANCH) — refuse to release" >&2
  exit 1
fi
git pull --ff-only origin "$BRANCH"

# ── 1. Compute new version ────────────────────────────────────────
CURRENT="$(grep '^version' Cargo.toml | head -1 | sed 's/.*"\(.*\)".*/\1/')"
echo "release: current version = $CURRENT"

case "$BUMP" in
  patch|minor|major)
    NEW="$(node -e '
      const [maj, min, pat] = process.argv[1].split(".").map(Number);
      const bump = process.argv[2];
      if (bump === "patch") console.log(`${maj}.${min}.${pat + 1}`);
      else if (bump === "minor") console.log(`${maj}.${min + 1}.0`);
      else console.log(`${maj + 1}.0.0`);
    ' "$CURRENT" "$BUMP")"
    ;;
  *)
    NEW="$BUMP"
    ;;
esac
TAG="v$NEW"
echo "release: new version    = $NEW (tag $TAG)"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "release: tag $TAG already exists locally — refuse to overwrite" >&2
  exit 1
fi
if gh release view "$TAG" --json tagName >/dev/null 2>&1; then
  echo "release: tag $TAG already published on GitHub — refuse to overwrite" >&2
  exit 1
fi

# ── 2a. Roll CHANGELOG [Unreleased] → [NEW] ───────────────────────
# cargo-dist auto-injects the matching `## [X.Y.Z]` section into the
# GitHub Release body, so every tag ships with real notes.
CHANGELOG="$REPO_ROOT/CHANGELOG.md"
if [ ! -f "$CHANGELOG" ]; then
  echo "release: CHANGELOG.md not found — refuse to release without notes" >&2
  exit 1
fi

# Extract the body of `## [Unreleased]` (lines between it and the next
# `## [...]` heading). Reject if empty — we don't ship headline-less
# releases. Bullet-only blank lines and the trailing section separator
# don't count as content.
UNRELEASED_BODY="$(awk '
  /^## \[Unreleased\]/ { in_block = 1; next }
  in_block && /^## \[/ { exit }
  in_block { print }
' "$CHANGELOG")"
if ! printf '%s' "$UNRELEASED_BODY" | grep -Eq '^(- |### )'; then
  echo "release: CHANGELOG.md [Unreleased] is empty — add entries before releasing" >&2
  echo "release: (at least one '- ' bullet or '### Added/Changed/Fixed' section required)" >&2
  exit 1
fi

TODAY="$(date -u +%Y-%m-%d)"
# In-place rewrite: rename the current [Unreleased] heading to [NEW] with
# date, then insert a fresh empty [Unreleased] stub at the top, and update
# the link footer so `[Unreleased]` points at the new tag-compare URL.
python3 - "$CHANGELOG" "$NEW" "$TAG" "$TODAY" <<'PY'
import sys, re, pathlib

path, new_ver, new_tag, today = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = pathlib.Path(path).read_text()

# 1. Rename current [Unreleased] → [NEW] - DATE.
text = re.sub(
    r"^## \[Unreleased\]\s*$",
    f"## [Unreleased]\n\n_No changes yet._\n\n## [{new_ver}] - {today}",
    text, count=1, flags=re.MULTILINE,
)

# 2. Update link footer.
#    [Unreleased]: .../compare/vOLD...HEAD  →  .../compare/vNEW...HEAD
#    insert new line for [NEW] comparing against previous tag.
lines = text.splitlines()
for i, ln in enumerate(lines):
    m = re.match(r"^\[Unreleased\]:\s+(.+/compare/)(v[^.]+\.[^.]+\.[^.]+)\.\.\.HEAD\s*$", ln)
    if m:
        prefix, old_tag = m.group(1), m.group(2)
        lines[i] = f"[Unreleased]: {prefix}{new_tag}...HEAD"
        lines.insert(i + 1, f"[{new_ver}]: {prefix}{old_tag}...{new_tag}")
        break

pathlib.Path(path).write_text("\n".join(lines) + "\n")
PY

# ── 2b. Bump Cargo.toml + commit + tag ────────────────────────────
sed -i.bak "s/^version = \"$CURRENT\"/version = \"$NEW\"/" Cargo.toml && rm Cargo.toml.bak
# Refresh Cargo.lock to reflect the version bump without paying for a full
# release compile (the local artifact isn't consumed; CI builds the
# authoritative one). cargo update --workspace just touches the lock entry.
cargo update --workspace --quiet 2>&1 | tail -3
git add Cargo.toml Cargo.lock CHANGELOG.md
git commit -m "release: $TAG"
git tag -a "$TAG" -m "$TAG"

# ── 3. Push ───────────────────────────────────────────────────────
git push origin "$BRANCH"
git push origin "$TAG"

# ── 4. Wait for the workflow ──────────────────────────────────────
echo "release: waiting for GitHub Actions release workflow..."
sleep 5  # give GH a moment to register the run
RUN_ID="$(gh run list --workflow=release.yml --limit 1 --json databaseId,headBranch,headSha \
            --jq '.[0].databaseId')"
[ -z "$RUN_ID" ] && { echo "release: no workflow run found — manual install needed" >&2; exit 1; }
echo "release: tracking run $RUN_ID — https://github.com/kepptic/ghax/actions/runs/$RUN_ID"

if ! gh run watch "$RUN_ID" --exit-status; then
  echo "release: workflow $RUN_ID failed — release artifacts not published, NOT installing" >&2
  echo "release: inspect with: gh run view $RUN_ID --log-failed" >&2
  exit 2
fi

# ── 5. Install the published artifact ─────────────────────────────
echo "release: workflow green — installing published artifact"
bash "$REPO_ROOT/scripts/install-release.sh" "$TAG"

echo ""
echo "release: $TAG done — local binary now matches what users will get."
