# ghax — TODOs

Active, accepted-but-deferred work. Items here have been reviewed and
approved for future work but deliberately held out of the current commit
to keep diffs focused. When picking one up, the surrounding context is
recorded so you don't need to re-derive the reasoning.

Anything without enough context to restart cold in 3 months doesn't
belong here — either flesh it out or close it.

## Open

### Rewrite the CLI in Rust (public-release gate)

**What:** Replace `src/cli.ts` (~2,071 lines) with a Rust crate that
produces platform-specific binaries via `cargo-dist`. Daemon stays
Node/Playwright. Full design + phasing in
[`design/plan/06-rust-cli-rewrite.md`](./design/plan/06-rust-cli-rewrite.md).

**Why:** Distribution. The Bun-compiled CLI is 61MB because it embeds
the Bun runtime. A stripped Rust binary is ~10MB per platform. This
is the last concrete friction between current ghax and a public
release we'd be satisfied shipping.

Secondary wins: ~2-5ms cold start (vs 37ms Bun), no runtime
dependency, standard `cargo install` / `brew install` distribution,
no per-platform Bun builds needed (one `cargo build --release --target
<triple>` per OS × arch).

**Pros:**
- 6x smaller binary per platform (~10MB vs 61MB)
- 7-15x faster cold start for single-command invocations
- Standard Rust cross-compile toolchain via cargo-dist handles
  macOS/Linux/Windows × x64/ARM in one CI workflow
- Opens clean install paths: Homebrew tap, `cargo install ghax`, npm
  wrapper, direct GitHub Release download
- Rust binary is a more inviting open-source artifact than a 60MB blob

**Cons:**
- 3-4 days active dev time (per the phasing plan)
- Dual-language repo during the rewrite window (mitigated by a parity
  diff test in CI)
- Contributor pool shifts slightly — JS/TS folks contributing to CLI
  vs Rust folks. Daemon stays TS so JS contributors still have turf.
- Node remains a runtime dependency (for daemon) — we can't eliminate
  it without replacing Playwright, which is out of scope.

**Context:**
- Decision recorded 2026-04-19 after a perf deep-dive showed the
  stack is already at its physical floor for single-command
  invocations (~30ms, dominated by Bun CLI spawn).
- The design doc covers architecture, dependency choices, per-verb
  porting plan, distribution story, phasing (4 phases), risks, and
  success criteria (8 green checks gate the switch).
- Phase 1 is template work: 45 trivial verbs that are pure RPC +
  print. Fast.
- Phase 2 is the real work: attach, qa, canary, ship, review — 8
  verbs with CLI-side orchestration logic.
- Phase 3 is SSE + REPL (console/network --follow, ghax shell).
- Phase 4 flips `bin/ghax` to prefer the Rust binary.

**Depends on / blocked by:** Nothing. The Rust CLI and Bun CLI can
coexist during the rewrite. Dual-maintenance window lasts ~1-2 weeks.

**Effort:** ~3-4 days active, spread over 2-3 weeks calendar.

**Success criteria:** All 8 gates in `06-rust-cli-rewrite.md` green
(binary sizes, smoke parity, perf floor, parity diff, Homebrew
install, docs, cargo-dist release workflow).

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

(Items move here from "Open" once they ship, with commit reference.)
