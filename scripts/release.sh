#!/usr/bin/env bash
# release — manual/offline entry point for cutting a ghax release. Thin
# wrapper around scripts/bump-version.sh: same sanity checks as before,
# but the version-bump + changelog-roll + commit + tag logic now lives in
# bump-version.sh so it's shared with .github/workflows/auto-release.yml
# (which cuts releases automatically on every merge to main — see
# docs/release-automation.md). Use this script when you want to cut a
# release right now from your machine instead of waiting for CI, or to
# preview one with --dry-run.
#
# Usage:
#   npm run release                 # auto (derive bump from commits since last tag)
#   npm run release patch           # 0.5.0 → 0.5.1
#   npm run release minor           # 0.5.0 → 0.6.0
#   npm run release major           # 0.5.0 → 1.0.0
#   npm run release 0.5.3           # explicit version
#   npm run release -- --dry-run    # preview only, no writes/push
#
# Refuses to run if:
#   - working tree is dirty
#   - current branch isn't main (or trunk)
#   - there's nothing release-worthy since the last tag (auto mode)
#   - the bumped tag already exists
#
# After tagging, pushes, dispatches (or picks up) the `release.yml`
# workflow, polls it with `gh run watch`, then on green runs
# scripts/install-release.sh against the new tag. End state: the binary
# you're running locally is the binary users will get.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BUMP="auto"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      awk 'NR>1 && /^set -euo/{exit} NR>1{print}' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) BUMP="$arg" ;;
  esac
done

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# ── 0. Sanity ─────────────────────────────────────────────────────
# Runs even under --dry-run: a preview that hides "you're on the wrong
# branch with local changes" isn't a useful preview.
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

# ── 1. Bump version, roll changelog, commit, tag (all local) ───────
BUMP_ARGS=(--bump "$BUMP" --version-file Cargo.toml)
[ "$DRY_RUN" = 1 ] && BUMP_ARGS+=(--dry-run)

NEW="$(bash "$REPO_ROOT/scripts/bump-version.sh" "${BUMP_ARGS[@]}" | tail -1)"

if [ "$NEW" = "none" ]; then
  echo "release: nothing release-worthy since the last tag — nothing to do" >&2
  exit 0
fi

TAG="v$NEW"

if [ "$DRY_RUN" = 1 ]; then
  echo ""
  echo "release: [dry-run] would cut $TAG — no files were written, nothing pushed." >&2
  exit 0
fi

echo "release: cut $TAG locally — pushing"

# ── 2. Push ───────────────────────────────────────────────────────
git push origin "$BRANCH"
git push origin "$TAG"

# ── 3. Get release.yml running for this tag ─────────────────────────
# release.yml triggers on tag push (`v[0-9]+.[0-9]+.[0-9]+*`), and this
# script pushes the tag with the operator's own `git`/`gh` credentials
# (not a GITHUB_TOKEN), so that push trigger fires normally — unlike
# auto-release.yml, which pushes via GITHUB_TOKEN and MUST dispatch
# explicitly (GitHub doesn't chain workflow runs off GITHUB_TOKEN-authored
# pushes). To stay uniform with that path without double-triggering the
# release (two concurrent `gh release create` calls for the same tag
# would race and one would fail), briefly poll for the tag-push-triggered
# run before falling back to an explicit dispatch.
echo "release: waiting for GitHub Actions release workflow..."
RUN_ID=""
for _ in 1 2 3 4 5 6; do
  RUN_ID="$(gh run list --workflow=release.yml --limit 5 \
              --json databaseId,headBranch,event \
              --jq "[.[] | select(.headBranch == \"$TAG\" and .event == \"push\")][0].databaseId" 2>/dev/null || true)"
  [ -n "$RUN_ID" ] && break
  sleep 2
done

if [ -z "$RUN_ID" ]; then
  echo "release: no tag-push-triggered run found — dispatching release.yml explicitly" >&2
  gh workflow run release.yml --ref "$TAG"
  sleep 5
  RUN_ID="$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
fi

[ -z "$RUN_ID" ] && { echo "release: no workflow run found — manual install needed" >&2; exit 1; }
echo "release: tracking run $RUN_ID — https://github.com/kepptic/ghax/actions/runs/$RUN_ID"

if ! gh run watch "$RUN_ID" --exit-status; then
  echo "release: workflow $RUN_ID failed — release artifacts not published, NOT installing" >&2
  echo "release: inspect with: gh run view $RUN_ID --log-failed" >&2
  exit 2
fi

# ── 4. Install the published artifact ─────────────────────────────
echo "release: workflow green — installing published artifact"
bash "$REPO_ROOT/scripts/install-release.sh" "$TAG"

echo ""
echo "release: $TAG done — local binary now matches what users will get."
