# Release automation — adoption guide

ghax cuts a release automatically on every merge to `main` that (a) passes
CI and (b) contains release-worthy commits. No human runs a script. This
doc explains the design and how another Kepptic repo adopts the same
mechanism.

Two files do the work:
- **`scripts/bump-version.sh`** — repo-agnostic. Classifies commits since
  the last tag into a semver bump, rolls a Keep-a-Changelog `[Unreleased]`
  section, bumps one or more version files, commits `release: vX.Y.Z`,
  and tags it. Never pushes. `--help` documents every flag.
- **`.github/workflows/auto-release.yml`** — runs `bump-version.sh` in CI,
  pushes the result, and dispatches a publishing workflow. Usable as a
  reusable workflow (`workflow_call`) from another repo, or copied in.

## Prerequisites

1. **Conventional Commits** on `main` — `feat:`, `fix:`, `docs:`, etc.
   Merge-commit subjects and non-conforming subjects contribute nothing to
   the bump decision (safe default: no release).
2. **A version file** bump-version.sh knows how to read/write:
   `Cargo.toml` (`[workspace.package]`/`[package]`), `pyproject.toml`, a
   bare `VERSION` file, or **any `*.json` file with a top-level
   `"version"` key** (`package.json`, `composer.json`, ...) — rewritten via
   regex substitution on that key, never `json.load`/`dump`, so formatting
   survives. `package-lock.json` is special-cased to update both the root
   `"version"` and `packages[""].version`. A file literally named
   `manifest.json` (Chrome extension manifest) gets any
   `-prerelease`/`+build` suffix stripped before writing, with a warning
   logged when one was actually stripped — Chrome only accepts 1-4
   dot-separated integers there. Multiple files can be kept in lockstep via
   repeated `--version-file`, or via `.bump-version.conf` (below).
3. **A `CHANGELOG.md`** with a Keep-a-Changelog `## [Unreleased]` section —
   or pass `--changelog-policy ignore` to skip the gate entirely (no
   changelog, or one that isn't PR-maintained).
4. **A CI workflow named `ci`** to gate on (`workflow_run` triggers by
   workflow *name*, not filename). Any other trigger — `workflow_dispatch`
   or `workflow_call` — doesn't need this.
5. **A publishing workflow**, if you want one dispatched automatically —
   it must support `workflow_dispatch` (or be triggered by the tag push
   this workflow also makes; either way, add `workflow_dispatch:` to it
   too, since a GITHUB_TOKEN-authored tag push won't fire the tag trigger —
   see below). Or pass `release-workflow: ''` to skip dispatching anything
   and just cut the tag.

## Adoption path 1 — copy the files

```bash
cp ghax/scripts/bump-version.sh your-repo/scripts/bump-version.sh
mkdir -p your-repo/.github/workflows
cp ghax/.github/workflows/auto-release.yml your-repo/.github/workflows/
```

Edit the `on:` triggers if your CI workflow isn't named `ci`, and adjust
`--version-file` defaults if needed — auto-detection already covers
`Cargo.toml` / `package.json` / `VERSION` / `pyproject.toml`.

## Adoption path 2 — call ghax's copy directly

No local script at all. A ~12-line caller workflow:

```yaml
name: auto-release
on:
  workflow_run:
    workflows: ["ci"]
    types: [completed]
jobs:
  release:
    if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main'
    uses: kepptic/ghax/.github/workflows/auto-release.yml@main
    with:
      version-files: "VERSION Cargo.toml dashboard/package.json"
      changelog-policy: ignore
      release-workflow: ""
    permissions:
      contents: write
      actions: write
```

`secrets: inherit` is not required — everything runs off the caller
repo's own `GITHUB_TOKEN`, which `permissions:` above grants write access
to. ghax is public (MIT), so the cross-repo checkout needs no auth.
Pin `@main` or a tag/sha per your repo's tolerance for drift.

## The GITHUB_TOKEN-cascade caveat

GitHub Actions has an anti-recursion rule: a push or tag made using the
default `GITHUB_TOKEN` does **not** trigger other workflows' `push`/`tag`
triggers — otherwise a workflow that pushes could trigger itself
indefinitely. `workflow_dispatch`, invoked via `GITHUB_TOKEN`, is exempt.

That's why `auto-release.yml` pushes the tag, then explicitly runs
`gh workflow run <release-workflow> --ref vX.Y.Z` instead of relying on the
publishing workflow's own tag-push trigger — that trigger would simply
never fire for a CI-authored push. Your publishing workflow needs
`workflow_dispatch:` added (no inputs required — it's dispatched with
`--ref` set to the tag, so `github.ref_name` already resolves correctly
for tag-triggered logic written before this existed).

Humans running `scripts/release.sh` don't hit this — their `git push` is
authenticated as themselves, so the tag-push trigger fires normally. That
script still dispatches too (for a uniform way to find the run to poll),
but backs off first to check whether the tag-push-triggered run already
appeared, to avoid a duplicate/conflicting release.

## Config knobs (all flags on `bump-version.sh`; matching inputs on the workflow)

| Flag | Default | Notes |
|---|---|---|
| `--bump` | `auto` | or `patch`/`minor`/`major`/`X.Y.Z` |
| `--tag-prefix` | `v` | |
| `--changelog` | `CHANGELOG.md` if present | |
| `--changelog-policy` | `require` | `ignore` to skip the empty-`[Unreleased]` gate |
| `--version-file` | auto-detect | repeatable |
| `--commit-prefix` | `release:` | also the loop-guard match on HEAD |
| `--no-commit` / `--no-tag` | off | |
| `--dry-run` / `--print-next` | off | preview only, no writes |
| `--allow-empty-changelog` | off | proceed even with a required-but-empty changelog |

## Repo-local config: `.bump-version.conf`

For a repo that always wants the same flags (ghax itself is the example),
drop a `.bump-version.conf` at the repo root instead of passing flags every
time:

```bash
# .bump-version.conf — sourced as a plain shell fragment
VERSION_FILES="Cargo.toml package.json package-lock.json extension/manifest.json"
CHANGELOG_POLICY=require
TAG_PREFIX=v
COMMIT_PREFIX="release:"
```

Only four keys are read (`VERSION_FILES` as a **space-separated string**,
not a repeated flag; `CHANGELOG_POLICY`; `TAG_PREFIX`; `COMMIT_PREFIX`).
Precedence is **CLI flags > `.bump-version.conf` > built-in
defaults/auto-detect** — a `--version-file` on the CLI fully replaces the
conf's list (it doesn't append to it), same idea as any other flag
overriding a default. `auto-release.yml` is written to cooperate: it only
passes `--tag-prefix`/`--changelog-policy` through to the script when the
workflow was actually given an explicit value (a `workflow_dispatch` or
cross-repo `workflow_call` invocation) — on ghax's own normal
`workflow_run`-triggered path there's nothing to pass, so the repo's
`.bump-version.conf` governs every release without the workflow having to
know it exists.

## What Conduit would need

Conduit versions three surfaces in lockstep — the agent binary
(`VERSION`), the Rust workspace (`Cargo.toml`), and the dashboard
(`dashboard/package.json`) — and doesn't maintain a `CHANGELOG.md` today.
Adoption is path 2 above with:

```yaml
    with:
      version-files: "VERSION Cargo.toml dashboard/package.json"
      changelog-policy: ignore
```

`VERSION` (first in the list) becomes the source of truth for "current
version"; all three get bumped together. No changelog gate means every
`feat`/`fix` merge to `main` cuts a release the moment CI is green — same
as ghax, minus the changelog step.
