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

# ── 2. Bump version + commit + tag ────────────────────────────────
sed -i.bak "s/^version = \"$CURRENT\"/version = \"$NEW\"/" Cargo.toml && rm Cargo.toml.bak
cargo build --release --quiet 2>&1 | tail -3   # also refreshes Cargo.lock
git add Cargo.toml Cargo.lock
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
