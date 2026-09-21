#!/usr/bin/env bash
# release-bump — offline smoke test for scripts/bump-version.sh.
#
# Clones this repo into a temp dir (so nothing here ever gets tagged,
# committed, or pushed for real), exercises the classification rules and
# the full roll+commit+tag flow against that throwaway clone, and asserts
# on the results. Never pushes anywhere.
#
# Run:
#   npm run test:release
#   bash test/release-bump.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  ok   - $*"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $*"; }

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$desc"
  else
    fail "$desc (expected [$expected], got [$actual])"
  fi
}

assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc (expected exit $expected, got $actual)"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if grep -qF "$needle" <<<"$haystack"; then
    pass "$desc"
  else
    fail "$desc (missing: $needle)"
  fi
}

echo "── release-bump smoke ──"

# ── 0. static checks ────────────────────────────────────────────
echo "▸ bash -n"
if bash -n "$REPO_ROOT/scripts/bump-version.sh" && bash -n "$REPO_ROOT/scripts/release.sh"; then
  pass "bash -n scripts/bump-version.sh scripts/release.sh"
else
  fail "bash -n scripts/bump-version.sh scripts/release.sh"
fi

SHELLCHECK_AVAILABLE=0
if command -v shellcheck >/dev/null 2>&1; then
  SHELLCHECK_AVAILABLE=1
  echo "▸ shellcheck"
  if shellcheck "$REPO_ROOT/scripts/bump-version.sh" "$REPO_ROOT/scripts/release.sh"; then
    pass "shellcheck scripts/bump-version.sh scripts/release.sh"
  else
    fail "shellcheck scripts/bump-version.sh scripts/release.sh"
  fi
else
  echo "  skip - shellcheck not installed"
fi

ACTIONLINT_AVAILABLE=0
if command -v actionlint >/dev/null 2>&1; then
  ACTIONLINT_AVAILABLE=1
  echo "▸ actionlint"
  # Scoped to auto-release.yml only: it's the new, hand-authored workflow.
  # release.yml is cargo-dist-generated and carries pre-existing, unrelated
  # embedded-shellcheck findings in job steps this change never touches —
  # not something this test should fail on.
  if actionlint "$REPO_ROOT/.github/workflows/auto-release.yml"; then
    pass "actionlint .github/workflows/auto-release.yml"
  else
    fail "actionlint .github/workflows/auto-release.yml"
  fi
else
  echo "  skip - actionlint not installed"
fi

# ── setup: throwaway clone ──────────────────────────────────────
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "▸ cloning into $TMP"
git clone -q "$REPO_ROOT" "$TMP"
cd "$TMP"
git config user.email "release-bump-test@ghax.local"
git config user.name "release-bump-test"

# scripts/bump-version.sh may be new/uncommitted in the working repo (that's
# exactly the case the first time this lands) — a plain clone only carries
# committed history, so make sure the clone actually has the script under
# test before anything else runs.
mkdir -p scripts
cp "$REPO_ROOT/scripts/bump-version.sh" scripts/bump-version.sh
chmod +x scripts/bump-version.sh
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "chore: seed clone with script under test"
fi

BV=(bash scripts/bump-version.sh --version-file Cargo.toml)

commit() {
  # commit <subject> [body]
  echo "x" >> README.md
  git add README.md
  if [ -n "${2:-}" ]; then
    git commit -q -m "$1" -m "$2"
  else
    git commit -q -m "$1"
  fi
}

# ── (a) print-next on a clean tag ───────────────────────────────
OUT="$("${BV[@]}" --print-next 2>/dev/null)"
assert_eq "(a) print-next on clean tag == none" "none" "$OUT"

# ── (b) docs commit -> none ─────────────────────────────────────
commit "docs: tweak the readme"
OUT="$("${BV[@]}" --print-next 2>/dev/null)"
assert_eq "(b) docs commit -> none" "none" "$OUT"

# ── (c) fix commit -> patch ─────────────────────────────────────
commit "fix(cli): correct a typo"
OUT="$("${BV[@]}" --print-next 2>/dev/null)"
assert_eq "(c) fix commit -> patch" "0.5.1" "$OUT"

# ── (d) feat commit -> minor ────────────────────────────────────
commit "feat(cli): add a new verb"
OUT="$("${BV[@]}" --print-next 2>/dev/null)"
assert_eq "(d) feat commit -> minor" "0.6.0" "$OUT"

# ── (e) feat! on 0.x -> minor; on a fake 1.0.0 tag -> major ─────
commit "feat!: breaking change while still 0.x"
OUT="$("${BV[@]}" --print-next 2>/dev/null)"
assert_eq "(e1) feat! on 0.x -> minor" "0.6.0" "$OUT"

sed -i.bak 's/^version = "0.5.0"/version = "1.0.0"/' Cargo.toml && rm -f Cargo.toml.bak
git add Cargo.toml
git commit -q -m "chore: fake-bump to 1.0.0 for test fixture"
git tag -a v1.0.0 -m v1.0.0
commit "feat!: breaking change on 1.x"
OUT="$("${BV[@]}" --print-next 2>/dev/null)"
assert_eq "(e2) feat! on 1.x -> major" "2.0.0" "$OUT"

# ── (f) Release-As trailer overrides everything ─────────────────
commit "chore: irrelevant subject" "Release-As: 9.9.9"
OUT="$("${BV[@]}" --print-next 2>/dev/null)"
assert_eq "(f) Release-As trailer wins" "9.9.9" "$OUT"

# ── (i) empty [Unreleased] + feat: -> exit 2 with refusal ───────
# Strip the "_No changes yet._" stub so [Unreleased] has no bullets/
# sections left — version-independent of whatever the next `## [x.y.z]`
# heading happens to be.
python3 - <<'PY'
import pathlib
p = pathlib.Path("CHANGELOG.md")
t = p.read_text()
t = t.replace("## [Unreleased]\n\n_No changes yet._\n\n", "## [Unreleased]\n\n", 1)
p.write_text(t)
PY
git add CHANGELOG.md
git commit -q -m "chore: empty the unreleased section for the empty-changelog test"
commit "feat: this would be minor if the changelog weren't empty"
set +e
OUT="$("${BV[@]}" 2>&1)"
STATUS=$?
set -e
assert_exit "(i) empty [Unreleased] refusal" "2" "$STATUS"
assert_contains "(i) refusal message mentions [Unreleased]" "$OUT" "[Unreleased] is empty"

# populate a real entry so the next (full-run) test can proceed
python3 - <<'PY'
import pathlib
p = pathlib.Path("CHANGELOG.md")
t = p.read_text()
t = t.replace("## [Unreleased]\n\n", "## [Unreleased]\n\n### Added\n- release-bump smoke test entry\n\n", 1)
p.write_text(t)
PY
git add CHANGELOG.md
git commit -q -m "docs: add a real [Unreleased] entry for the full-run test"

# ── (j) dirty tree -> exit 2 ─────────────────────────────────────
echo "dirty" >> README.md
set +e
OUT="$("${BV[@]}" 2>&1)"
STATUS=$?
set -e
git checkout -q -- README.md
assert_exit "(j) dirty tree refusal" "2" "$STATUS"
assert_contains "(j) refusal message mentions dirty tree" "$OUT" "dirty"

# ── (g) full non-dry-run: commit, tag, changelog roll, Cargo bump ─
BEFORE_HEAD="$(git rev-parse HEAD)"
set +e
OUT="$("${BV[@]}" 2>/dev/null)"
STATUS=$?
set -e
NEW="$(tail -1 <<<"$OUT")"
assert_exit "(g) full run exits 0" "0" "$STATUS"

AFTER_HEAD="$(git rev-parse HEAD)"
if [ "$AFTER_HEAD" != "$BEFORE_HEAD" ]; then
  pass "(g) full run created a new commit"
else
  fail "(g) full run created a new commit"
fi

SUBJECT="$(git log -1 --format=%s)"
assert_contains "(g) commit subject is release: v<version>" "$SUBJECT" "release: v"

if git rev-parse "v$NEW" >/dev/null 2>&1; then
  pass "(g) annotated tag v$NEW created"
else
  fail "(g) annotated tag v$NEW created"
fi

CARGO_VER="$(grep -m1 '^version = "' Cargo.toml | sed -E 's/version = "([^"]+)".*/\1/')"
assert_eq "(g) Cargo.toml bumped to $NEW" "$NEW" "$CARGO_VER"

LOCK_VER="$(awk '/^name = "ghax"$/{f=1;next} f&&/^version = /{print;exit}' Cargo.lock | sed -E 's/version = "([^"]+)".*/\1/')"
assert_eq "(g) Cargo.lock ghax entry bumped to $NEW" "$NEW" "$LOCK_VER"

if grep -q "^## \[$NEW\] - " CHANGELOG.md; then
  pass "(g) CHANGELOG.md has a new '## [$NEW] - DATE' section"
else
  fail "(g) CHANGELOG.md has a new '## [$NEW] - DATE' section"
fi

if grep -q "^_No changes yet._" CHANGELOG.md; then
  pass "(g) CHANGELOG.md [Unreleased] reset to the empty stub"
else
  fail "(g) CHANGELOG.md [Unreleased] reset to the empty stub"
fi

if grep -q "^\[Unreleased\]: .*compare/v$NEW\.\.\.HEAD" CHANGELOG.md; then
  pass "(g) footer [Unreleased] compare link points at v$NEW"
else
  fail "(g) footer [Unreleased] compare link points at v$NEW"
fi

if grep -q "^\[$NEW\]: .*compare/" CHANGELOG.md; then
  pass "(g) footer gained a [$NEW]: compare link"
else
  fail "(g) footer gained a [$NEW]: compare link"
fi

# ── (h) second run right after -> loop guard -> none ────────────
OUT="$("${BV[@]}" --print-next 2>/dev/null)"
assert_eq "(h) second run is a no-op (loop guard)" "none" "$OUT"

# never push from this test
if [ -z "$(git remote -v)" ]; then
  : # clone with no remotes configured for push — nothing to assert
fi

echo ""
echo "── linters ──"
echo "shellcheck: $([ "$SHELLCHECK_AVAILABLE" = 1 ] && echo available || echo 'not installed, skipped')"
echo "actionlint: $([ "$ACTIONLINT_AVAILABLE" = 1 ] && echo available || echo 'not installed, skipped')"

echo ""
echo "── release-bump: $PASS passed, $FAIL failed ──"
[ "$FAIL" -eq 0 ]
