# Contributing to ghax

Thanks for your interest. ghax is pre-v1; expect rough edges and
opinionated pushback. That said, PRs are welcome. This doc lists the
moving parts so you can land one without friction.

**Working with an AI coding agent?** Point it at [llms.txt](./llms.txt)
(install/usage) and [AGENTS.md](./AGENTS.md) (project memory). Those
two files contain everything an agent needs to work on this repo; this
document covers the same ground plus human-oriented bits (PR style,
code of conduct, issue reporting).

## Repo layout

```
ghax/
  bin/ghax                  Shell shim — launches the Rust binary from target/release/ghax
  crates/cli/               Rust CLI — argv parsing, dispatch, daemon RPC. All user-facing verbs.
    src/main.rs             Entry point + verb dispatch table
    src/dispatch.rs         Per-verb routing to daemon RPC or local orchestration
    src/attach.rs           Daemon spawn, CDP probe, port scan, bundle resolution
    src/qa.rs               QA orchestrator (parallel URL crawl, screenshots, report)
    src/canary.rs           Post-deploy canary monitor
    src/ship.rs             Ship workflow (bump, changelog, commit, push, PR)
    src/rpc.rs              HTTP+JSON client with transient-error retry
    src/state.rs            State file resolution + daemon liveness
    src/shell.rs            Interactive REPL (ghax shell)
  src/
    daemon.ts               Node HTTP daemon. Playwright connectOverCDP + raw CDP pool.
    cdp-client.ts           /json/list target discovery + per-target WebSocket pool.
    config.ts               State file resolution (git root → .ghax/ghax.json).
    buffers.ts              CircularBuffer<T>, ConsoleEntry, NetworkEntry, parseStack().
    snapshot.ts             aria tree → @e<n> refs, cursor-interactive + shadow-DOM + dialog-scope.
  test/
    smoke.ts                Live-browser harness (95 checks, ~30s).
    cross-browser.ts        Iterate every detected Chromium browser; run smoke on each.
    benchmark.ts            Headless CLI benchmark vs gstack-browse, playwright-cli, agent-browser.
    hot-reload-smoke.ts     Scripted MV3 hot-reload probe against test/fixtures/test-extension/.
    fixtures/test-extension/  Minimal MV3 fixture for hot-reload verification.
  .claude/skills/           Claude Code skills (auto-register via devops-skill-registry).
  design/plan/              Vision, architecture, commands, roadmap, session handoff.
  ARCHITECTURE.md           Current architecture summary (for readers).
  CLAUDE.md                 Project instructions for Claude Code / other agents.
  dist/                     Built binaries (gitignored).
```

## Dev loop

Prerequisites: **Rust 1.80+**, **Node 20+**, git.

```bash
npm install
npm run build            # bundles Node daemon → dist/ghax-daemon.mjs (esbuild)
npm run build:rust       # compiles Rust CLI → target/release/ghax
./target/release/ghax attach   # attach to a running Edge on :9222
./target/release/ghax --help   # command surface
npm run typecheck              # tsc --noEmit
```

During dev, editing `src/*.ts` requires `npm run build` again — the
daemon is a bundle, not a live file.

## Local checks (pre-commit)

`scripts/check.sh` runs the same verifications GitHub Actions runs —
TypeScript `tsc --noEmit`, `cargo check`, and the daemon bundle build —
and completes in ~3s on an incremental checkout. **Always run it (or
let the pre-commit hook run it) before pushing.**

```bash
bash scripts/check.sh       # one-shot
SKIP_CHECK=1 git commit     # bypass the hook (discouraged)
```

The hook lives at `.githooks/pre-commit` (tracked in the repo). After
cloning, wire it up once per clone:

```bash
git config core.hooksPath .githooks
```

## Cutting a release

The release flow is fully scripted and won't install a binary locally
unless the GitHub Actions release workflow goes green first — so what
you ship is exactly what you keep running.

```bash
npm run release patch    # 0.4.2 → 0.4.3 (default)
npm run release minor    # 0.4.2 → 0.5.0
npm run release major    # 0.4.2 → 1.0.0
npm run release 0.4.3    # explicit version
```

Steps the script takes:
1. Refuses to run if the working tree is dirty or you're not on `main`.
2. Bumps the version in `Cargo.toml`, refreshes `Cargo.lock`, commits, tags `v<version>`.
3. Pushes the commit + tag.
4. Polls the GitHub Actions release workflow with `gh run watch --exit-status`.
5. **Only on green:** downloads the published archive, verifies its SHA-256,
   installs the binary to `~/.cargo/bin/ghax`, drops the daemon bundle into
   `~/.local/share/ghax/`, and bootstraps the daemon's `node_modules/`.
6. **On red:** stops with a pointer to `gh run view --log-failed`. Nothing
   gets installed locally — you keep running the previous version until you
   fix the build.

To pull the latest published release without cutting a new one (e.g. another
machine, or after a manual hotfix release):

```bash
npm run install-release            # latest non-prerelease
npm run install-release v0.4.2     # specific tag
```

Both scripts share the same install path. Idempotent — safe to re-run.

## Adding a new command

1. Register a handler in `daemon.ts` via `register('name', async (ctx, args, opts) => {...})`.
2. Wire the Rust dispatch in `crates/cli/src/dispatch.rs`. For trivial
   verbs (parse args → POST /rpc → print), add the verb name to one
   of the existing `match` arms — `simple()` does the rest. For verbs
   with CLI-side logic (custom print, multi-RPC, shell-out), add a
   new module under `crates/cli/src/<verb>.rs` exposing
   `pub fn cmd_<verb>(parsed: &Parsed) -> Result<i32>`, then wire it
   in `dispatch.rs::dispatch_inner` and declare `mod <verb>;` in
   `main.rs`. See `qa.rs`, `ship.rs`, `attach.rs` for templates.
3. Update `crates/cli/src/help.rs` + `README.md` + `design/plan/03-commands.md`.
4. Add a smoke check in `test/smoke.ts`.
5. If it should be recorded by `ghax record`, do nothing (it's recorded
   by default). If it's meta / read-only, add the name to `NEVER_RECORD`
   in `daemon.ts`.
5. If it has a custom exit code, throw `new DaemonError(msg, code)` and
   the CLI will propagate it.

## Architecture invariants

- **CLI = Rust. Daemon = Node (ESM bundle).** Playwright's
  `connectOverCDP` is Node-only. Don't reach for `Bun.serve`
  or `Bun.spawn` anywhere — use Node's `http` and `child_process`.
- **Single daemon per project.** State file at `.ghax/ghax.json` points
  at pid + port. Never write a second state file.
- **Refs survive until re-snapshot.** `click @e3` resolves against the
  last snapshot's ref map. If the DOM changed, re-snapshot before
  clicking.
- **Daemon binds to 127.0.0.1 only.** No auth token in v0.x (single-user,
  localhost).

## Commit style

- **Imperative**, 70-char subject, motivation in the body.
- Prefix optional but helpful: `feat(ext): ...`, `fix(daemon): ...`,
  `docs(plan): ...`.
- Don't claim "Co-Authored-By" unless a human co-authored.

## Testing

Six test surfaces:

```bash
npm run typecheck           # tsc --noEmit — runs in CI
npm run test:smoke          # test/smoke.ts — drives a real browser, NOT in CI
npm run test:capture-bodies # test/capture-bodies-smoke.ts — end-to-end body capture
npm run test:cross-browser  # run smoke against every installed Chromium (Edge + Chrome, Brave, Chromium if present)
npm run test:benchmark      # compare per-command latency vs gstack-browse / playwright-cli / agent-browser
npm run test:perf           # perf budget test — FAILS if P50 regresses past threshold
```

The smoke test requires a running Chromium-family browser on
`--remote-debugging-port=9222`. It attaches, runs **95 non-destructive
commands** (navigation, snapshots, interaction, extensions, orchestrated
verbs, `try`, `perf`, console dedup, network status/HAR, new-window
workflow, `shell` mode tokenising), and detaches. Takes ~30s end-to-end.

`test:cross-browser` launches each installed browser headless in a
disposable scratch profile and runs the full smoke against each.
Confirms the codebase is truly browser-agnostic within the Chromium
family — no Edge-specific branches.

`test:benchmark` is a reference comparison against the other main CLI
browser-automation tools. Useful when changing daemon internals or the
RPC path — the warm per-command number should stay in the same tier as
gstack-browse.

`test:perf` enforces P50 budgets on 13 critical operations + the shell-
mode fast path + a cold-start workflow. It FAILS on regression. The
budgets are calibrated against measured steady-state + 30% margin.
Current floor: ~20ms/cmd for single-invocation (Rust CLI spawn), ~4.4ms/cmd in shell mode.

For MV3 hot-reload specifically, load `test/fixtures/test-extension/`
as an unpacked extension and follow its README — that's the one bit of
QA that needs a dedicated fixture rather than the real web.

## Before opening a PR

1. `npm run typecheck` passes.
2. `npm run build` succeeds on macOS (CI also runs Linux + Windows).
3. `npm run test:smoke` passes against a real running Edge.
4. You dogfooded the specific thing you changed — fix a bug? reproduce
   it before and after.
5. Updated `CHANGELOG.md` under `## [Unreleased]`.

## Known browser quirks

These are not ghax bugs — they're browser / site behaviors that surface
when driving a real browser over CDP. Document them here so the next
person doesn't re-discover them.

### Chrome v113+ refuses CDP on the default profile

As of Chrome 113, `--remote-debugging-port` is ignored when the browser
is using the default `--user-data-dir`. Launching Chrome without an
explicit profile path silently opens DevTools-less — `ghax attach`
will fail to find the `/json/version` endpoint.

Workaround: point at a writable profile directory.

```bash
# Chrome — explicit profile
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/chrome-ghax" &
```

Edge is not affected (still honors CDP on its default profile as of
2026-Q1). If you want Edge + a clean profile anyway, the same
`--user-data-dir=<path>` flag works.

### Google anti-bot on sensitive flows

Chrome / Edge launched with `--remote-debugging-port` sets
`navigator.webdriver = true` plus a few related fingerprintable flags.
Google's anti-bot on sensitive pages (Business Profile verification,
Drive sharing consent, some OAuth challenges, Google Ads campaign
edits) refuses to render, throws a "disconnected" modal, or logs you
out mid-flow.

Cheap mitigation — add `--disable-blink-features=AutomationControlled`
to the launch command:

```bash
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --remote-debugging-port=9222 \
  --disable-blink-features=AutomationControlled &
```

This clears the `navigator.webdriver` bit and unblocks most flows. It
won't defeat determined server-side fingerprinting — for flows where
even the mitigation fails (e.g. rapid form submits on Google Ads that
trigger a "session disconnected" modal), the documented pattern is:

1. `ghax detach`
2. Do the Google-specific step manually in the browser.
3. `ghax attach` and resume.

Full stealth-mode JS injection is explicitly out of scope — cat-and-
mouse maintenance isn't worth it for a dev tool.

## Reporting issues

Include:
- `ghax --version` (once we have one — meanwhile, `git rev-parse HEAD`).
- `ghax status --json`.
- Relevant excerpt from `.ghax/ghax-daemon.log`.
- Reproduction steps. Small repros beat big ones.

## Code of conduct

We follow the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md). Be
decent. No discrimination, no harassment.
