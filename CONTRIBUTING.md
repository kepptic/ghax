# Contributing to ghax

Thanks for your interest. ghax is pre-v1; expect rough edges and
opinionated pushback. That said, PRs are welcome — this doc lists the
moving parts so you can land one without friction.

## Repo layout

```
ghax/
  bin/ghax                  Shell shim — falls back from dist/ghax to bun run src/cli.ts
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

Prerequisites: **Bun 1.3+** and **Node 20+**.

```bash
bun install
bun run build            # produces dist/ghax (compiled) + dist/ghax-daemon.mjs
./dist/ghax attach       # attach to a running Edge on :9222
./dist/ghax --help       # command surface
bunx tsc --noEmit        # typecheck
```

During dev, editing `src/*.ts` requires `bun run build` again — the
daemon is a bundle, not a live file. The CLI alone can run via
`bun run src/cli.ts <cmd>`, but the daemon can't run directly
(imports use extensionless paths that only the bundle resolves).

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

- **CLI = Bun (compiled). Daemon = Node (ESM bundle).** Playwright's
  `connectOverCDP` hangs under Bun 1.3.x. Don't reach for `Bun.serve`
  or `Bun.spawn` inside `daemon.ts` — use Node's `http` and `child_process`.
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
bun run typecheck           # bunx tsc --noEmit — runs in CI
bun run test:smoke          # test/smoke.ts — drives a real browser, NOT in CI
bun run test:capture-bodies # test/capture-bodies-smoke.ts — end-to-end body capture
bun run test:cross-browser  # run smoke against every installed Chromium (Edge + Chrome, Brave, Chromium if present)
bun run test:benchmark      # compare per-command latency vs gstack-browse / playwright-cli / agent-browser
bun run test:perf           # perf budget test — FAILS if P50 regresses past threshold
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
Current floor: ~30ms/cmd for single-invocation (dominated by Bun CLI
spawn), ~4.4ms/cmd in shell mode.

For MV3 hot-reload specifically, load `test/fixtures/test-extension/`
as an unpacked extension and follow its README — that's the one bit of
QA that needs a dedicated fixture rather than the real web.

## Before opening a PR

1. `bun run typecheck` passes.
2. `bun run build` succeeds on macOS (CI also runs Linux + Windows).
3. `bun run test:smoke` passes against a real running Edge.
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
