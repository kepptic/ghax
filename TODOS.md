# ghax — TODOs

Active, accepted-but-deferred work. Items here have been reviewed and
approved for future work but deliberately held out of the current commit
to keep diffs focused. When picking one up, the surrounding context is
recorded so you don't need to re-derive the reasoning.

Anything without enough context to restart cold in 3 months doesn't
belong here — either flesh it out or close it.

## Open

### Split `src/daemon.ts` by domain


**What:** Extract handler groups into domain-specific files. Approved in
plan-eng-review on 2026-04-19.

- `src/daemon.ts` (2227 lines, 72 handlers) → split into:
  - `src/handlers/tab.ts` (tabs, tab, goto, back/forward/reload, find,
    new-window)
  - `src/handlers/snapshot.ts` (snapshot + cursor walker)
  - `src/handlers/interact.ts` (click, fill, press, type, wait, is)
  - `src/handlers/ext.ts` (every `ext.*` register call)
  - `src/handlers/capture.ts` (console, network, cookies, storage, HAR)
  - `src/handlers/orchestrated.ts` (qa, profile, diff-state, perf)
  - `src/handlers/util.ts` (eval, try, xpath, box, screenshot,
    viewport, responsive, diff)
  - `src/daemon.ts` keeps: Ctx interface, bootstrap, HTTP server,
    SSE endpoints, shutdown, recording dispatcher

> **Note:** `src/cli.ts` split was originally part of this TODO but
> has been dropped — the Rust CLI rewrite replaces `cli.ts` entirely,
> so splitting the TypeScript version first would be wasted work.

**Why:** At 2227 lines, navigation cost is real. A second contributor
would friction looking for "where does goto live." Today it's one file.
Future debugging sessions also benefit: smaller blast radius per edit,
cleaner git blame.

**Pros:**
- Maintainability gain for anyone who isn't the original author
- Makes future feature additions land in obvious files
- Smaller per-file compile units (marginal bundle-time improvement)
- Enables parallel PRs that don't collide on daemon.ts

**Cons:**
- One-time churn on every handler
- Import paths need updating across registered handlers
- Minor risk of subtle ordering issues (register() calls need to fire
  before HTTP server starts — verify the entry-point import chain
  triggers all handler files)

**Context:**
- The `register()` pattern in daemon.ts is the natural split boundary.
  Each handler file just imports from `./daemon` (for register + Ctx
  type) and calls register() at module top level. The bootstrap
  function in daemon.ts then imports the handler modules for side
  effects, triggering all register() calls.
- Cross-browser smoke already covers behavioral equivalence; after
  the split, `bun run test:smoke` + `bun run test:cross-browser`
  should catch any regression.

**Depends on / blocked by:** Nothing. Land the simplify and
plan-eng-review follow-ups first (already in main as of 6f42830),
then do this as its own focused PR.

**Effort:** ~30 min with CC, probably an hour to get right including
smoke re-verification.

## Completed

- **Rewrite the CLI in Rust (public-release gate)** — shipped across
  phases 1-4. `src/cli.ts` deleted in `b2748e7` (refactor: remove the
  Bun CLI source — Rust is the single source of truth). `bin/ghax`
  shim now prefers `target/release/ghax`; installed users run the
  Rust binary directly. Bun runtime fully removed in `8d1deb5`;
  esbuild bundles the daemon, tsx runs the tests. All 8 success
  gates green: ~2.6 MB stripped Apple Silicon binary (under the 10MB
  target), 70/70 smoke parity, cold-start floor hit, cross-browser
  green on Edge + Chrome, install-link/install-release flows live.
