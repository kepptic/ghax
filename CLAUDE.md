# ghax — project instructions for Claude Code

This file tells Claude (and other agents) how to work on this repo without
friction. Human contributors should read [CONTRIBUTING.md](./CONTRIBUTING.md)
instead — it has the same info plus the bits that don't matter to agents
(code of conduct, PR style, issue reporting).

## What this repo is

ghax is a CLI browser-automation tool that **attaches to the user's real
running Chrome or Edge via CDP**. Not a sandboxed browser — the user's own
session, with auth, extensions, and open tabs intact. Plus a Claude Code
skill layer (`/kepptic-ghax` router + `/kepptic-ghax-browse` main skill).

For the full architecture see [ARCHITECTURE.md](./ARCHITECTURE.md). For the
"why" behind each design decision see
[`design/plan/`](./design/plan/).

## Hard invariants

Before making changes, internalize these. Violating any of them has broken
the tool in the past.

1. **CLI is Rust. Daemon runs under Node.** Playwright's
   `connectOverCDP` is Node-only — keep all Playwright usage in the
   daemon. The Rust CLI calls the daemon via HTTP RPC; it has no Playwright
   dependency. The old Bun CLI source under `src/cli.ts` is gone — use
   `git log --oneline -- src/cli.ts` to find it in history if you need it.

2. **Single daemon per state file.** `.ghax/ghax.json` stores
   `{pid, port, browserKind, browserUrl, cwd}`. Never spawn a second
   daemon pointing at the same state file. For parallel agents, use
   `GHAX_STATE_FILE=/tmp/ghax-<agent>.json` — each gets its own daemon.

3. **Refs survive only until the next snapshot — and only on the tab
   they were taken on.** `ghax click @e3` looks up `@e3` against the
   daemon's *last* snapshot ref map. If the DOM changed, re-snapshot
   first. The `tab` and `new-window` handlers clear the ref map when
   the active page changes, so a stale ref from tab A can't resolve
   against tab B; a smoke check asserts this. Never cache ref IDs in
   code that outlives a single action.

4. **Daemon restart required after editing `src/daemon.ts`.** The daemon
   bundle is loaded once at attach time. Changes to `src/daemon.ts` don't
   take effect until `ghax detach && bun run build && ghax attach`. Bit me
   once debugging LCP capture — daemon returned null because it was still
   running the pre-fix code.

5. **The Rust CLI and daemon do not share source.** The Rust CLI uses
   `serde_json::Value` for daemon responses (the daemon already returns
   JSON; deserializing into named structs would be a re-implementation of
   `printResult()` for no benefit). When the daemon changes an RPC
   return shape, just update whatever Rust dispatch code reads
   `data.get("foo")` if the field name changed. Smoke (`test/smoke.ts`
   via `GHAX_BIN=$PWD/target/release/ghax bun run test:smoke`) catches
   the breakage.

## Command patterns

Adding a new verb takes 3 steps:

1. **Register a handler in `daemon.ts`** (Node side):
   ```ts
   register('myVerb', async (ctx, args, opts) => {
     const page = await activePage(ctx);
     // ...
     return { ...result };
   });
   ```

2. **Wire the Rust dispatch in `crates/cli/src/dispatch.rs`.** For
   trivial verbs (parse args → POST /rpc → print), add the verb name
   to one of the existing `match` arms — `simple()` does the rest.
   For verbs with CLI-side logic (custom print, multi-RPC, shell-out),
   add a new module under `crates/cli/src/<verb>.rs` exposing
   `pub fn cmd_<verb>(parsed: &Parsed) -> Result<i32>`, then wire it
   in `dispatch.rs::dispatch_inner` and declare `mod <verb>;` in
   `main.rs`. See `qa.rs`, `ship.rs`, `attach.rs` for templates.

3. **Add a smoke check in `test/smoke.ts`.** Run it against both Bun
   (irrelevant now — only the daemon is Bun-built) and Rust
   (`GHAX_BIN=$PWD/target/release/ghax bun run test:smoke`).

## Common workflows

### QA a site end-to-end

```bash
ghax attach
ghax qa --url https://example.com --out /tmp/report.json
# Produces {urlsAttempted, urlsOk, pages: [{url, refCount, consoleErrors, failedRequests, screenshotPath?}]}
```

### Debug why a page is slow

```bash
ghax goto https://target.com
ghax perf --wait 2000    # let SPA hydration settle
# Returns LCP (with size + URL), FCP, CLS, TTFB, longTaskCount, full navTiming
```

### Test a Chrome extension after rebuild

```bash
ghax attach
ghax ext list                  # find your ext-id
ghax ext hot-reload <ext-id>   # reload SW + re-inject content scripts
# Returns { ok, tabs: [...], swVersion, durationMs }
```

### Inject a CSS fix preview before editing source

```bash
ghax try --css '.wrapper { width: max-content }' \
         --measure 'document.querySelector(".wrapper").offsetWidth' \
         --shot /tmp/preview.png
# Returns { value: <new width>, shot: '/tmp/preview.png' }
# Revert by reloading the page.
```

### Run many commands fast (multi-turn agent sessions)

```bash
cat <<'EOF' | ghax shell
goto https://target.com
wait 500
snapshot -i
click @e3
text
perf
exit
EOF
```

One process, no per-command spawn cost. ~1.8x faster than separate
`ghax <cmd>` invocations. For interactive use (TTY), just `ghax shell`
and type commands at the prompt. `exit`/`quit`/Ctrl-D to leave. Blank
lines and `#` lines are ignored. Quoting works like a real shell:
`try --css 'body { color: red }'` passes the whole CSS intact.

### Share the browser with a user who's actively working

```bash
# Agent side:
export GHAX_STATE_FILE=/tmp/ghax-agent.json
ghax attach
tab=$(ghax new-window https://target.com --json | jq -r .id)
# Work in $tab — user's other tabs/windows untouched, no focus steal.
```

### Multi-agent parallel work (two agents, two apps)

```bash
# Agent A (Setsail work)
GHAX_STATE_FILE=/tmp/ghax-setsail.json ghax attach
GHAX_STATE_FILE=/tmp/ghax-setsail.json ghax new-window https://setsail.app

# Agent B (Conduit work)
GHAX_STATE_FILE=/tmp/ghax-conduit.json ghax attach
GHAX_STATE_FILE=/tmp/ghax-conduit.json ghax new-window https://conduit-dash.dagtech.com
```

Each agent has its own daemon + window. They share the browser process
(same profile, same auth) but can't see each other's active-tab pointer.

## Build, test, verify

Every change must pass:

```bash
# Rust CLI
cargo build --release            # compile Rust CLI (crates/cli/)
npm run typecheck                # tsc --noEmit (daemon TS + tests)
npm run build                    # bundle daemon → dist/ghax-daemon.mjs (esbuild)
npm run test:smoke               # 70-check smoke suite against a live Edge session
```

For bigger changes also run:

```bash
npm run test:cross-browser    # Edge + Chrome both pass the suite
npm run test:benchmark        # per-command latency hasn't regressed
```

The smoke test requires a Chromium-family browser on
`--remote-debugging-port=9222`. If you don't have one running, either
launch Edge/Chrome with that flag or the smoke will abort at the first
attach.

`GHAX_BIN=./target/release/ghax npm run test:smoke` runs the smoke
suite against the Rust binary — useful for verifying parity.

## Before committing

1. Typecheck + smoke passes.
2. Every new flag / verb / RPC has a smoke check.
3. `CHANGELOG.md` under `## [Unreleased]` has an entry for the change.
4. If the change is user-facing: `README.md` command surface reflects it.
5. If the change affects how to work in the codebase: `CONTRIBUTING.md`
   updated.
6. If the change is architectural: `ARCHITECTURE.md` updated, and maybe
   a note in `design/plan/04-roadmap.md`.

## What's intentionally NOT here

These were considered and deferred. Don't try to add them without a
design discussion:

- **Multi-tenant `ghax pair`** — bearer-token auth on a
  network-exposed daemon. Deferred because any RPC bug becomes remote
  code execution. The shipped SSH-tunnel mode covers the "me on
  another machine" case.
- **Skill acceptance eval harness** — scripted Claude API calls
  against the skills with tool-call assertions. Deferred indefinitely
  because the 70-check E2E smoke catches the same regressions at zero
  API cost.
- ~~Source-map resolution for stack frames.~~ Shipped — opt-in via
  `ghax console --source-maps`.
- ~~Request/response body capture.~~ Shipped — opt-in via
  `ghax attach --capture-bodies[=<glob>]`.
- ~~XPath surface + bounding-box command.~~ Shipped — `ghax xpath`,
  `ghax box`, plus `xpath=//...` prefix works on every selector arg.
- **CPU flame graph export**. `ghax profile` captures point-in-time
  metrics + heap snapshots, not CPU traces. No plans to add.

## Questions or blockers

For design-level questions, read the five docs under
[`design/plan/`](./design/plan/) in order. They're session-by-session
captures of the reasoning as the project evolved — not API reference,
but "why is it this way" documentation.

If a test fails that you can't explain, check the "Daemon restart
required" invariant above. It's the single most common source of
confusion.
