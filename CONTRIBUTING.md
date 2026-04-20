# Contributing to ghax

Thanks for your interest. ghax is pre-v1; expect rough edges and
opinionated pushback. That said, PRs are welcome — this doc lists the
moving parts so you can land one without friction.

## Repo layout

```
ghax/
  bin/ghax                  Shell shim — launches the Rust binary from target/release/ghax
  src/
    cli.ts                  Argv → daemon RPC. Verb dispatcher + attach/detach specials.
    daemon.ts               Node HTTP daemon. Playwright connectOverCDP + raw CDP pool.
    browser-launch.ts       Browser detect + CDP probe + scan/findFreePort + --launch/--headless.
    cdp-client.ts           /json/list target discovery + per-target WebSocket pool.
    config.ts               State file resolution (git root → .ghax/ghax.json).
    buffers.ts              CircularBuffer<T>, ConsoleEntry, NetworkEntry, parseStack().
    snapshot.ts             aria tree → @e<n> refs, cursor-interactive + shadow-DOM pass.
  test/
    smoke.ts                Live-browser harness (70 checks, ~30s).
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
2. Add a CLI case in `src/cli.ts` — usually one line with `makeSimple('name')`.
3. Update the HELP constant + `README.md` + `design/plan/03-commands.md`.
4. If it should be recorded by `ghax record`, do nothing (it's recorded
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
`--remote-debugging-port=9222`. It attaches, runs **70 non-destructive
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

## Reporting issues

Include:
- `ghax --version` (once we have one — meanwhile, `git rev-parse HEAD`).
- `ghax status --json`.
- Relevant excerpt from `.ghax/ghax-daemon.log`.
- Reproduction steps. Small repros beat big ones.

## Code of conduct

We follow the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md). Be
decent. No discrimination, no harassment.
