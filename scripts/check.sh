#!/usr/bin/env bash
# Mirror what GitHub Actions' ci.yml runs, so we catch breakage locally
# before committing. Fast enough to run in a pre-commit hook (<10s on
# incremental builds).
#
# Run manually:
#     bash scripts/check.sh
#
# Or via git:
#     git commit     # pre-commit hook invokes this
#     SKIP_CHECK=1 git commit    # bypass (discouraged)

set -euo pipefail

if [ "${SKIP_CHECK:-0}" = "1" ]; then
  echo "ghax check: SKIP_CHECK=1 — skipping."
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "── ghax check ──"

# 1. TypeScript — matches CI `typecheck` job
if [ -f package.json ]; then
  echo "▸ bunx tsc --noEmit"
  bunx tsc --noEmit
fi

# 2. Rust — matches CI `build` job's compile step. `cargo check` is much
#    faster than `cargo build --release` and catches the same type errors.
if [ -f Cargo.toml ]; then
  echo "▸ cargo check --manifest-path crates/cli/Cargo.toml"
  cargo check --manifest-path crates/cli/Cargo.toml --quiet
fi

# 3. Daemon bundle still builds — catches bad imports in src/
echo "▸ bun run build (daemon bundle)"
bun run build >/dev/null

echo "✓ all checks passed"
