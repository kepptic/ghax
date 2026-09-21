#!/usr/bin/env bash
# bump-version — generic Conventional-Commits version bumper + CHANGELOG
# roller. Computes the next version from the commits since the last tag,
# rolls a Keep-a-Changelog `[Unreleased]` section, bumps one or more
# version files, and creates a `release: vX.Y.Z` commit + annotated tag.
# Never pushes — that's the caller's job.
#
# Designed to be repo-agnostic so any Kepptic repo can copy this one file
# (plus .github/workflows/auto-release.yml) to get the same behaviour.
# See docs/release-automation.md for the adoption guide.
#
# Usage:
#   scripts/bump-version.sh [options]
#
# Options:
#   --bump auto|patch|minor|major|X.Y.Z   What to bump. Default: auto
#                                          (derived from Conventional
#                                          Commits since the last tag).
#   --tag-prefix <prefix>                  Default: v
#   --changelog <path>                     Default: CHANGELOG.md if present
#   --changelog-policy require|ignore      Default: require (only enforced
#                                          when the changelog file exists)
#   --version-file <path>                  Repeatable. Default: repo-local
#                                          config (see below), else
#                                          auto-detect Cargo.toml,
#                                          package.json, VERSION,
#                                          pyproject.toml (in that order,
#                                          whichever exist). The FIRST file
#                                          given/found is the source of
#                                          truth for the current version;
#                                          ALL listed files get bumped,
#                                          REGARDLESS of what version they
#                                          currently hold (a file that has
#                                          drifted out of sync gets forced
#                                          to match, it is never silently
#                                          skipped).
#   --commit-prefix <prefix>               Default: "release:"
#   --no-commit                            Bump files/changelog but don't commit
#   --no-tag                               Commit but don't tag
#   --dry-run                              Report what would happen, change nothing
#   --print-next                           Print the computed next version
#                                          (or "none") and exit — no writes
#   --allow-empty-changelog                Don't refuse when [Unreleased] has
#                                          no entries (rolls it anyway)
#
# Repo-local config: if `.bump-version.conf` exists at the repo root, it is
# sourced for four optional plain-string settings — `VERSION_FILES` (a
# SPACE-SEPARATED string, not a flag list), `CHANGELOG_POLICY`, `TAG_PREFIX`,
# `COMMIT_PREFIX`. Precedence is CLI flags > `.bump-version.conf` > the
# built-in defaults/auto-detect above. A `--version-file` flag on the CLI
# fully replaces the conf's file list rather than appending to it.
#
# Supported version-file types: Cargo.toml / pyproject.toml (TOML
# `^version = "..."`), a bare VERSION file, and ANY `*.json` file with a
# top-level `"version"` key (package.json, composer.json, ...) — rewritten
# via textual regex substitution, never json.load/dump, so formatting is
# preserved. `package-lock.json` is special-cased: both the root `"version"`
# and `packages[""].version` fields are updated. A file literally named
# `manifest.json` (Chrome extension manifest) gets any `-prerelease`/`+build`
# suffix stripped before writing (Chrome requires 1-4 dot-separated
# integers), with a warning logged when a suffix was actually stripped.
#
# Bump rule (--bump auto):
#   A `Release-As: X.Y.Z` trailer in any commit since the last tag wins,
#   unconditionally. A `[skip release]` token in HEAD's subject, or HEAD
#   already being a release commit/tag, means nothing to do. Otherwise,
#   scanning commit subjects (merges skipped) and bodies (merges included,
#   for BREAKING CHANGE footers) since the last tag:
#     - `type!:` subject or a `BREAKING CHANGE:` footer -> major (if the
#       current major version is >= 1) or minor (if still 0.x, so 0.x
#       stays in the 0.x line per semver's pre-1.0 convention)
#     - `feat` -> minor
#     - `fix|perf|refactor|revert|build|deps` -> patch
#     - only `docs|chore|ci|test|style|release`, or nothing parses -> none
#
# Exit codes: 0 = ok or nothing to release, 1 = error, 2 = refused
# (dirty tree, empty changelog when required, tag already exists).
#
# All diagnostics go to stderr. The LAST line of stdout is always the
# result: the new version (e.g. "0.6.0") or the literal string "none".

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log()    { echo "bump-version: $*" >&2; }
die()    { echo "bump-version: $*" >&2; exit 1; }
refuse() { echo "bump-version: $*" >&2; exit 2; }

# ── defaults ──────────────────────────────────────────────────────
BUMP="auto"
TAG_PREFIX="v"
CHANGELOG=""
CHANGELOG_SET=0
CHANGELOG_POLICY="require"
VERSION_FILES=()
COMMIT_PREFIX="release:"
DO_COMMIT=1
DO_TAG=1
DRY_RUN=0
PRINT_NEXT=0
ALLOW_EMPTY_CHANGELOG=0

# ── repo-local config (.bump-version.conf) ───────────────────────
# Sourced into a subshell so its variable names (VERSION_FILES as a plain
# string, TAG_PREFIX, CHANGELOG_POLICY, COMMIT_PREFIX) never collide with
# this script's own array/scalar variables of the same name.
CONF="$REPO_ROOT/.bump-version.conf"
CONF_TAG_PREFIX=""
CONF_CHANGELOG_POLICY=""
CONF_COMMIT_PREFIX=""
CONF_VERSION_FILES=""
if [ -f "$CONF" ]; then
  # This subshell's VERSION_FILES is a plain string (what .bump-version.conf
  # itself assigns, e.g. `VERSION_FILES="a b c"`) — a genuinely different
  # variable from the outer script's VERSION_FILES array, because a `( ... )`
  # subshell gets its own scope. shellcheck's static analysis doesn't model
  # that scoping and flags these two lines as if they touched the outer
  # array; both are intentional.
  # shellcheck disable=SC2178,SC2128
  eval "$(
    ( VERSION_FILES=""; TAG_PREFIX=""; CHANGELOG_POLICY=""; COMMIT_PREFIX=""
      # shellcheck disable=SC1090
      source "$CONF"
      printf 'CONF_TAG_PREFIX=%q\n' "$TAG_PREFIX"
      printf 'CONF_CHANGELOG_POLICY=%q\n' "$CHANGELOG_POLICY"
      printf 'CONF_COMMIT_PREFIX=%q\n' "$COMMIT_PREFIX"
      printf 'CONF_VERSION_FILES=%q\n' "$VERSION_FILES"
    )
  )"
  log "repo-local config: $CONF"
  [ -n "$CONF_TAG_PREFIX" ] && log "  tag-prefix       = $CONF_TAG_PREFIX"
  [ -n "$CONF_CHANGELOG_POLICY" ] && log "  changelog-policy = $CONF_CHANGELOG_POLICY"
  [ -n "$CONF_COMMIT_PREFIX" ] && log "  commit-prefix    = $CONF_COMMIT_PREFIX"
  [ -n "$CONF_VERSION_FILES" ] && log "  version-files    = $CONF_VERSION_FILES"
fi

[ -n "$CONF_TAG_PREFIX" ] && TAG_PREFIX="$CONF_TAG_PREFIX"
[ -n "$CONF_CHANGELOG_POLICY" ] && CHANGELOG_POLICY="$CONF_CHANGELOG_POLICY"
[ -n "$CONF_COMMIT_PREFIX" ] && COMMIT_PREFIX="$CONF_COMMIT_PREFIX"
if [ -n "$CONF_VERSION_FILES" ]; then
  read -ra VERSION_FILES <<< "$CONF_VERSION_FILES"
fi

# ── CLI flags (override conf and defaults) ───────────────────────
VERSION_FILES_CLI_RESET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bump) BUMP="$2"; shift 2 ;;
    --tag-prefix) TAG_PREFIX="$2"; shift 2 ;;
    --changelog) CHANGELOG="$2"; CHANGELOG_SET=1; shift 2 ;;
    --changelog-policy) CHANGELOG_POLICY="$2"; shift 2 ;;
    --version-file)
      # First --version-file on the CLI replaces whatever conf/auto-detect
      # put in this array wholesale; later ones append, same as before.
      if [ "$VERSION_FILES_CLI_RESET" = 0 ]; then
        VERSION_FILES=()
        VERSION_FILES_CLI_RESET=1
      fi
      VERSION_FILES+=("$2"); shift 2 ;;
    --commit-prefix) COMMIT_PREFIX="$2"; shift 2 ;;
    --no-commit) DO_COMMIT=0; shift ;;
    --no-tag) DO_TAG=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --print-next) PRINT_NEXT=1; shift ;;
    --allow-empty-changelog) ALLOW_EMPTY_CHANGELOG=1; shift ;;
    -h|--help)
      awk 'NR>1 && /^set -euo/{exit} NR>1{print}' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

case "$CHANGELOG_POLICY" in
  require|ignore) ;;
  *) die "--changelog-policy must be 'require' or 'ignore', got: $CHANGELOG_POLICY" ;;
esac

# ── changelog default ────────────────────────────────────────────
if [ "$CHANGELOG_SET" = 0 ] && [ -f "$REPO_ROOT/CHANGELOG.md" ]; then
  CHANGELOG="$REPO_ROOT/CHANGELOG.md"
fi

# ── version-file auto-detect ─────────────────────────────────────
if [ "${#VERSION_FILES[@]}" -eq 0 ]; then
  for f in Cargo.toml package.json VERSION pyproject.toml; do
    [ -f "$REPO_ROOT/$f" ] && VERSION_FILES+=("$f")
  done
fi
[ "${#VERSION_FILES[@]}" -eq 0 ] && die "no version file found (Cargo.toml/package.json/VERSION/pyproject.toml) and none given via --version-file"
log "version files: ${VERSION_FILES[*]}"

# ── dirty tree guard (skipped for --dry-run / --print-next) ─────────
if [ "$DRY_RUN" = 0 ] && [ "$PRINT_NEXT" = 0 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    refuse "working tree is dirty — commit or stash first"
  fi
fi

# ── get/set version in a file ────────────────────────────────────
# JSON handling (package.json, package-lock.json, extension/manifest.json,
# composer.json, ...) is generic: any `*.json` file is read/written via a
# regex match on the first `"version": "..."` occurrence, never
# json.load/dump, so key order, indentation, and trailing whitespace survive
# untouched.
get_version() {
  local f="$1"
  case "$f" in
    *Cargo.toml|*pyproject.toml)
      grep -m1 '^version = "' "$f" | sed -E 's/version = "([^"]+)".*/\1/'
      ;;
    */VERSION|VERSION)
      tr -d '[:space:]' < "$f"
      ;;
    *.json)
      grep -m1 '"version"[[:space:]]*:' "$f" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
      ;;
    *)
      die "don't know how to read a version from $f (unsupported file type — supported: Cargo.toml, pyproject.toml, VERSION, *.json)"
      ;;
  esac
}

# Writes $new into $f UNCONDITIONALLY — regardless of what version the file
# currently holds. Earlier versions of this script matched on the OLD value
# textually and silently no-op'd when a file had drifted out of sync (the
# bug that left package.json/package-lock.json/extension/manifest.json
# stuck at their placeholder versions across several ghax releases). Every
# supported file type below is rewritten by matching the *shape* of the
# version field (a `version = "..."` TOML line, a `"version": "..."` JSON
# key), never the specific old value.
json_replace_version() {
  # json_replace_version <file> <new-version> <expected-occurrence-count>
  local f="$1" new="$2" count="$3"
  python3 - "$f" "$new" "$count" <<'PY'
import re
import sys
import pathlib

path, new, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
p = pathlib.Path(path)
text = p.read_text()
new_text, n = re.subn(r'"version"\s*:\s*"[^"]*"', f'"version": "{new}"', text, count=count)
if n < count:
    print(f"bump-version: expected {count} \"version\" occurrence(s) in {path}, found {n}", file=sys.stderr)
    sys.exit(1)
p.write_text(new_text)
PY
}

set_version() {
  local f="$1" new="$2"
  case "$f" in
    *Cargo.toml|*pyproject.toml)
      python3 - "$f" "$new" <<'PY'
import re
import sys
import pathlib

path, new = sys.argv[1], sys.argv[2]
p = pathlib.Path(path)
text = p.read_text()
new_text, n = re.subn(r'(?m)^version = "[^"]*"', f'version = "{new}"', text, count=1)
if n == 0:
    print(f"bump-version: no 'version = \"...\"' line found in {path}", file=sys.stderr)
    sys.exit(1)
p.write_text(new_text)
PY
      ;;
    */VERSION|VERSION)
      printf '%s\n' "$new" > "$f"
      ;;
    *manifest.json)
      # Chrome extension manifests only accept 1-4 dot-separated integers —
      # strip any semver prerelease/build metadata before writing.
      local stripped="$new"
      if [[ "$stripped" =~ ^([0-9]+(\.[0-9]+){0,3}) ]]; then
        stripped="${BASH_REMATCH[1]}"
      fi
      if [ "$stripped" != "$new" ]; then
        log "warning: $f is a Chrome manifest — stripping prerelease/build suffix: $new -> $stripped"
      fi
      json_replace_version "$f" "$stripped" 1
      ;;
    */package-lock.json|package-lock.json)
      # Two occurrences to update: the root "version" and packages[""].version.
      json_replace_version "$f" "$new" 2
      ;;
    *.json)
      json_replace_version "$f" "$new" 1
      ;;
    *)
      die "don't know how to write a version to $f (unsupported file type)"
      ;;
  esac
}

CURRENT="$(get_version "${VERSION_FILES[0]}")"
[ -z "$CURRENT" ] && die "could not determine current version from ${VERSION_FILES[0]}"
log "current version = $CURRENT (from ${VERSION_FILES[0]})"

# ── loop guard: HEAD already released? ───────────────────────────
LAST_TAG="$(git describe --tags --abbrev=0 --match "${TAG_PREFIX}[0-9]*" 2>/dev/null || true)"
HEAD_SHA="$(git rev-parse HEAD)"
HEAD_SUBJECT="$(git log -1 --format=%s)"

if [ -n "$LAST_TAG" ]; then
  LAST_TAG_SHA="$(git rev-list -n1 "$LAST_TAG" 2>/dev/null || true)"
  if [ "$LAST_TAG_SHA" = "$HEAD_SHA" ]; then
    log "nothing to release: HEAD is a release commit/tag ($LAST_TAG)"
    echo "none"
    exit 0
  fi
fi
if [[ "$HEAD_SUBJECT" == "$COMMIT_PREFIX"* ]]; then
  log "nothing to release: HEAD is a release commit/tag ($HEAD_SUBJECT)"
  echo "none"
  exit 0
fi
if [[ "$HEAD_SUBJECT" == *"[skip release]"* ]]; then
  log "HEAD subject contains [skip release] — nothing to release"
  echo "none"
  exit 0
fi

if [ -n "$LAST_TAG" ]; then
  RANGE="$LAST_TAG..HEAD"
  log "commits since $LAST_TAG"
else
  RANGE="HEAD"
  log "no previous $TAG_PREFIX* tag — considering full history"
fi

# ── compute NEW version ───────────────────────────────────────────
bump_field() {
  # bump_field <version> <field: major|minor|patch>
  python3 -c "
v = '$1'.split('.')
maj, minr, pat = int(v[0]), int(v[1]), int(v[2])
field = '$2'
if field == 'major': maj, minr, pat = maj + 1, 0, 0
elif field == 'minor': minr, pat = minr + 1, 0
else: pat += 1
print(f'{maj}.{minr}.{pat}')
"
}

if [[ "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  NEW="$(bump_field "$CURRENT" "$BUMP")"
elif [ "$BUMP" != "auto" ]; then
  NEW="$BUMP"
else
  RELEASE_AS="$(git log "$RANGE" --format=%B 2>/dev/null \
    | grep -m1 -E '^Release-As:[[:space:]]*[0-9]+\.[0-9]+\.[0-9]+[[:space:]]*$' \
    | sed -E 's/^Release-As:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/' || true)"
  if [ -n "$RELEASE_AS" ]; then
    NEW="$RELEASE_AS"
    log "Release-As trailer found -> $NEW (overrides auto classification)"
  else
    BREAKING=0
    if git log "$RANGE" --format=%B 2>/dev/null | grep -qE '^BREAKING CHANGE:'; then
      BREAKING=1
    fi
    LEVEL="none"  # none < patch < minor
    BREAKING_RE='^[a-zA-Z]+(\([^)]*\))?!:'
    while IFS= read -r subj; do
      [ -z "$subj" ] && continue
      if [[ "$subj" =~ $BREAKING_RE ]]; then
        BREAKING=1
        continue
      fi
      TYPE="$(sed -E 's/^([a-zA-Z]+)(\([^)]*\))?!?:.*/\1/' <<<"$subj" | tr '[:upper:]' '[:lower:]')"
      case "$TYPE" in
        feat) LEVEL="minor" ;;
        fix|perf|refactor|revert|build|deps) [ "$LEVEL" = "none" ] && LEVEL="patch" ;;
        *) : ;;  # docs/chore/ci/test/style/release, or unparseable -> no contribution
      esac
    done < <(git log --no-merges "$RANGE" --format=%s 2>/dev/null || true)

    if [ "$BREAKING" = 1 ]; then
      MAJOR="$(cut -d. -f1 <<<"$CURRENT")"
      if [ "$MAJOR" -ge 1 ]; then
        NEW="$(bump_field "$CURRENT" major)"
      else
        NEW="$(bump_field "$CURRENT" minor)"
      fi
      log "breaking change detected -> $NEW"
    elif [ "$LEVEL" = "minor" ]; then
      NEW="$(bump_field "$CURRENT" minor)"
      log "feat commit(s) found -> $NEW"
    elif [ "$LEVEL" = "patch" ]; then
      NEW="$(bump_field "$CURRENT" patch)"
      log "fix/perf/refactor/revert/build/deps commit(s) found -> $NEW"
    else
      log "no release-worthy commits since ${LAST_TAG:-repo start} (only docs/chore/ci/test/style/release, or none) — nothing to release"
      echo "none"
      exit 0
    fi
  fi
fi

if [ "$PRINT_NEXT" = 1 ]; then
  echo "$NEW"
  exit 0
fi

TAG="${TAG_PREFIX}${NEW}"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  refuse "tag $TAG already exists locally — refuse to overwrite"
fi

# ── changelog policy check ───────────────────────────────────────
CHANGELOG_WILL_ROLL=0
if [ -n "$CHANGELOG" ] && [ -f "$CHANGELOG" ]; then
  CHANGELOG_WILL_ROLL=1
  if [ "$CHANGELOG_POLICY" = "require" ] && [ "$ALLOW_EMPTY_CHANGELOG" = 0 ]; then
    UNRELEASED_BODY="$(awk '
      /^## \[Unreleased\]/ { f = 1; next }
      f && /^## \[/ { exit }
      f { print }
    ' "$CHANGELOG")"
    if ! printf '%s' "$UNRELEASED_BODY" | grep -Eq '^(- |### )'; then
      refuse "$CHANGELOG [Unreleased] is empty — add entries before releasing (or pass --allow-empty-changelog / --changelog-policy ignore)"
    fi
  fi
elif [ -n "$CHANGELOG" ]; then
  log "changelog $CHANGELOG not found — skipping changelog roll"
fi

if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] would release $TAG (current $CURRENT -> $NEW)"
  log "[dry-run] version files: ${VERSION_FILES[*]}"
  if [ "$CHANGELOG_WILL_ROLL" = 1 ]; then
    log "[dry-run] would roll changelog: $CHANGELOG"
  fi
  if [ "$DO_COMMIT" = 1 ]; then
    log "[dry-run] would commit: $COMMIT_PREFIX $TAG"
  else
    log "[dry-run] --no-commit set — would leave files bumped, uncommitted"
  fi
  if [ "$DO_TAG" = 1 ]; then
    log "[dry-run] would create annotated tag $TAG"
  else
    log "[dry-run] --no-tag set"
  fi
  echo "$NEW"
  exit 0
fi

# ── do the work ────────────────────────────────────────────────────
CHANGED_FILES=()

if [ "$CHANGELOG_WILL_ROLL" = 1 ]; then
  TODAY="$(date -u +%Y-%m-%d)"
  # Renames the current `## [Unreleased]` heading to `## [NEW] - DATE`,
  # inserts a fresh empty `[Unreleased]` stub above it, and updates the
  # `[Unreleased]: .../compare/vOLD...HEAD` footer link to point at the
  # new tag (inserting a `[NEW]: .../compare/vPREV...vNEW` line for it).
  python3 - "$CHANGELOG" "$NEW" "$TAG" "$TODAY" <<'PY'
import sys, re, pathlib

path, new_ver, new_tag, today = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = pathlib.Path(path).read_text()

text, n = re.subn(
    r"^## \[Unreleased\]\s*$",
    f"## [Unreleased]\n\n_No changes yet._\n\n## [{new_ver}] - {today}",
    text, count=1, flags=re.MULTILINE,
)
if n == 0:
    print(f"bump-version: no '## [Unreleased]' heading found in {path}", file=sys.stderr)
    sys.exit(1)

lines = text.splitlines()
for i, ln in enumerate(lines):
    m = re.match(r"^\[Unreleased\]:\s+(.+/compare/)([^.]+\.[^.]+\.[^.]+)\.\.\.HEAD\s*$", ln)
    if m:
        prefix, old_tag = m.group(1), m.group(2)
        lines[i] = f"[Unreleased]: {prefix}{new_tag}...HEAD"
        lines.insert(i + 1, f"[{new_ver}]: {prefix}{old_tag}...{new_tag}")
        break
else:
    print(f"bump-version: warning: no '[Unreleased]: .../compare/vX...HEAD' footer link found in {path} — left unchanged", file=sys.stderr)

pathlib.Path(path).write_text("\n".join(lines) + "\n")
PY
  CHANGED_FILES+=("$CHANGELOG")
fi

for f in "${VERSION_FILES[@]}"; do
  FILE_CURRENT="$(get_version "$f" 2>/dev/null || echo '?')"
  set_version "$f" "$NEW"
  if [ "$FILE_CURRENT" = "$NEW" ]; then
    log "bumped $f (already $NEW)"
  else
    log "bumped $f: $FILE_CURRENT -> $NEW"
  fi
  CHANGED_FILES+=("$f")
done

# Keep Cargo.lock's own `ghax` entry in lockstep with a bumped Cargo.toml.
HAS_CARGO=0
for f in "${VERSION_FILES[@]}"; do
  case "$f" in *Cargo.toml) HAS_CARGO=1 ;; esac
done
if [ "$HAS_CARGO" = 1 ] && [ -f "$REPO_ROOT/Cargo.lock" ]; then
  if command -v cargo >/dev/null 2>&1; then
    log "refreshing Cargo.lock via cargo update --workspace"
    ( cargo update --workspace --quiet 2>&1 | sed 's/^/bump-version: cargo update: /' >&2 ) || true
  else
    log "cargo not on PATH — patching Cargo.lock's ghax entry with awk instead"
    awk -v new="$NEW" '
      /^name = "ghax"$/ { inpkg = 1; print; next }
      inpkg && /^version = / && !done { sub(/"[^"]*"/, "\"" new "\""); done = 1; inpkg = 0; print; next }
      { print }
    ' "$REPO_ROOT/Cargo.lock" > "$REPO_ROOT/Cargo.lock.tmp" && mv "$REPO_ROOT/Cargo.lock.tmp" "$REPO_ROOT/Cargo.lock"
  fi
  if [ -n "$(git status --porcelain -- "$REPO_ROOT/Cargo.lock")" ]; then
    CHANGED_FILES+=("$REPO_ROOT/Cargo.lock")
  fi
fi

if [ "$DO_COMMIT" = 1 ]; then
  git add "${CHANGED_FILES[@]}"
  git commit -q -m "$COMMIT_PREFIX $TAG"
  log "committed: $COMMIT_PREFIX $TAG"
  if [ "$DO_TAG" = 1 ]; then
    git tag -a "$TAG" -m "$TAG"
    log "tagged: $TAG"
  fi
else
  log "--no-commit set — left ${CHANGED_FILES[*]} bumped, uncommitted"
fi

echo "$NEW"
