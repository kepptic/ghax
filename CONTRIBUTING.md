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
    browser-launch.ts       Browser binary detection + CDP probe + --launch scratch profile.
    cdp-client.ts           /json/list target discovery + per-target WebSocket pool.
    config.ts               State file resolution (git root → .ghax/ghax.json).
    buffers.ts              CircularBuffer<T> for console + network entries.
    snapshot.ts             aria tree → @e<n> refs, cursor-interactive + shadow-DOM pass.
  .claude/skills/           Claude Code skills (auto-register via devops-skill-registry).
  design/plan/              Vision, architecture, commands, roadmap, session handoff.
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

Two test surfaces:

```bash
bun run typecheck    # bunx tsc --noEmit — runs in CI
bun run test:smoke   # test/smoke.ts — drives a real browser, NOT in CI
```

The smoke test requires a running Chromium-family browser on
`--remote-debugging-port=9222`. It attaches, runs ~24 non-destructive
commands, and detaches. Takes ~20s end-to-end.

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
