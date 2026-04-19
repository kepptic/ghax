# ghax — TODOs

Active, accepted-but-deferred work. Items here have been reviewed and
approved for future work but deliberately held out of the current commit
to keep diffs focused. When picking one up, the surrounding context is
recorded so you don't need to re-derive the reasoning.

Anything without enough context to restart cold in 3 months doesn't
belong here — either flesh it out or close it.

## Open

### Split `src/daemon.ts` and `src/cli.ts` by domain

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
- `src/cli.ts` (2071 lines) → split similarly:
  - `src/cli/dispatch.ts` (main dispatch switch)
  - `src/cli/orchestrated.ts` (cmdQa, cmdShip, cmdCanary, cmdReview,
    cmdPair, cmdGif)
  - `src/cli/shell.ts` (cmdShell + tokenizer)
  - `src/cli/attach.ts` (cmdAttach, cmdDetach, cmdStatus, cmdRestart,
    spawnDaemon, daemon health)
  - `src/cli.ts` keeps: main(), HELP constant, parseArgs, rpc, util helpers

**Why:** At 2000+ lines each, navigation cost is real. A second contributor
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
- For cli.ts, the dispatch() function's switch can move to
  `src/cli/dispatch.ts` with per-verb handlers imported from
  sibling files. `makeSimple` and `parseArgs` stay in cli.ts as
  shared utilities.
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
