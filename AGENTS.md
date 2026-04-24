# AGENTS.md

This is the generic agent memory file for the ghax repo. Any AI coding agent working on this codebase (Codex, Cursor, Aider, Continue, Windsurf, or Claude Code) should read this before editing anything.

Claude Code users: [CLAUDE.md](./CLAUDE.md) extends this file with Claude-specific workflow notes; both apply.

## What this project is

ghax is a CLI that attaches to the user's real running Chrome or Edge over Chrome DevTools Protocol. It drives tabs, takes accessibility-tree snapshots with `@e<n>` refs, works with MV3 extension internals, and captures console/network traffic. The CLI is Rust (small, fast binary); the daemon is Node (because Chromium automation needs a Node runtime).

If you just arrived and need to install: see [llms.txt](./llms.txt) for the install + verify sequence.

## Hard invariants (violating any of these has broken the tool)

1. **CLI is Rust. Daemon is Node.** The CLI calls the daemon via HTTP RPC on 127.0.0.1. Do not add browser-automation calls to the Rust side. Do not add daemon bundling to the Rust side. The split is load-bearing.

2. **Single daemon per state file.** `.ghax/ghax.json` at the git root stores `{pid, port, browserKind, browserUrl, cwd}`. Never spawn a second daemon pointing at the same state file. For parallel agents, use `GHAX_STATE_FILE=/tmp/ghax-<name>.json`.

3. **Refs survive only until the next snapshot, only on the tab they were taken on.** `ghax click @e3` looks up `@e3` against the daemon's last snapshot ref map. If the DOM changed, re-snapshot first. The `tab` and `new-window` handlers clear the ref map when the active page changes.

4. **Daemon restart required after editing `src/daemon.ts`.** The daemon bundle is loaded once at attach time. Changes to `src/daemon.ts` don't take effect until `ghax detach && npm run build && ghax attach`.

5. **The Rust CLI and daemon do not share source.** Rust uses `serde_json::Value` for daemon responses. When the daemon changes an RPC return shape, update whatever Rust dispatch code reads `data.get("foo")` if the field name changed. The smoke suite catches breakage.

## Build and test

```bash
# Daily dev loop
npm install                  # Node deps (playwright + source-map)
npm run build                # bundles daemon → dist/ghax-daemon.mjs (esbuild, ~50 ms)
npm run build:rust           # compiles Rust CLI → target/release/ghax
npm run build:all            # both of the above
npm run typecheck            # tsc --noEmit

# Install to ~/.local/bin (idempotent)
npm run install-link

# Smoke suite (requires Edge or Chrome running with --remote-debugging-port=9222)
npm run test:smoke           # 95 checks, ~30 s, drives a real browser
npm run test:cross-browser   # runs smoke against every detected Chromium family browser
npm run test:perf            # enforces P50 latency budgets on critical ops
npm run test:benchmark       # compare latency vs other CLIs (reference only, not a gate)
```

To run the smoke suite against a specific binary: `GHAX_BIN=$PWD/target/release/ghax npm run test:smoke`.

## Project layout

```
ghax/
├── bin/ghax                  Shim that execs target/release/ghax
├── crates/cli/               Rust CLI source (single crate, workspace root at repo root)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs           Entry point + verb dispatch
│       ├── dispatch.rs       Per-verb routing to daemon RPC or local orchestration
│       ├── args.rs           Argv → Parsed struct (mirrors TS parseArgs exactly)
│       ├── rpc.rs            HTTP+JSON client with transient-error retry
│       ├── state.rs          State file resolution + daemon liveness
│       ├── attach.rs         Daemon spawn, CDP probe, port scan, bundle resolution
│       ├── shell.rs          Interactive REPL (ghax shell)
│       ├── help.rs           --help text (single source of truth)
│       ├── small.rs          Medium verbs: status, chain, batch, replay, gif, pair, diff-state
│       ├── qa.rs             QA orchestrator (parallel URL crawl)
│       ├── canary.rs         Post-deploy canary monitor
│       ├── ship.rs           Ship workflow (bump, changelog, commit, push, PR)
│       ├── review.rs         Diff-aware code review emitter
│       ├── sse.rs            Server-Sent Events client (live tail)
│       ├── output.rs         JSON pretty-print
│       ├── qa_common.rs      Shared filters between qa.rs and canary.rs
│       └── time_util.rs      ISO-8601 / days-to-ymd (shared by qa/canary/ship)
├── src/                      Node daemon source
│   ├── daemon.ts             Main HTTP server + all RPC handlers (~2,500 lines, 72 verbs)
│   ├── snapshot.ts           ARIA tree walker, cursor-interactive pass, shadow-DOM + dialog-aware
│   ├── cdp-client.ts         Raw CDP WebSocket pool for SW/popup/option/sidepanel targets
│   ├── buffers.ts            CircularBuffer, ConsoleEntry, NetworkEntry, parseStack
│   ├── config.ts             State file resolution
│   └── source-maps.ts        Opt-in source-map resolver for --source-maps
├── test/
│   ├── smoke.ts              95 live-browser checks (the main safety net)
│   ├── cross-browser.ts      Iterate every detected Chromium and smoke each
│   ├── benchmark.ts          Latency comparison vs other CLIs
│   ├── perf-bench.ts         P50 budget enforcer
│   ├── capture-bodies-smoke.ts  Body-capture end-to-end test
│   └── hot-reload-smoke.ts   MV3 hot-reload test against fixtures/test-extension/
├── .claude/skills/           Claude Code skills (ghax + ghax-browse)
├── docs/
│   ├── BENCHMARK.md          Perf numbers
│   ├── design/               Design history (why the current architecture exists)
│   └── sessions/             Field reports from production agent runs
├── scripts/
│   ├── install-link.sh       Symlink into ~/.local/bin + bootstrap daemon node_modules
│   ├── install-release.sh    Download latest GitHub release + install
│   ├── release.sh            Cut a release (refuses to run with dirty tree)
│   └── bootstrap-daemon-runtime.sh   Shared npm install step
├── ARCHITECTURE.md           CLI/daemon split, CDP model, ref resolution
├── CHANGELOG.md              Per-version changes
├── CLAUDE.md                 Claude Code specific notes (auto-discovered)
├── CONTRIBUTING.md           Full contributor guide
├── LICENSE                   MIT
├── SECURITY.md               Threat model
├── llms.txt                  Discovery + install guide for AI agents
└── README.md                 Human-facing overview
```

## Adding a new CLI verb

Three steps; the smoke suite catches most mistakes.

1. **Register the handler in `src/daemon.ts`**:

   ```ts
   register('myVerb', async (ctx, args, opts) => {
     const page = await activePage(ctx);
     // ...
     return { ...result };
   });
   ```

2. **Wire the Rust dispatch in `crates/cli/src/dispatch.rs`**. For trivial verbs (parse args → POST /rpc → print), add the verb name to an existing `match` arm and let `simple()` handle it. For verbs with CLI-side logic (custom print, multi-RPC, shell-out), add a new module under `crates/cli/src/<verb>.rs` exposing `pub fn cmd_<verb>(parsed: &Parsed) -> Result<i32>`, then wire it in `dispatch_inner` and declare `mod <verb>;` in `main.rs`. See `qa.rs`, `ship.rs`, `attach.rs` as templates.

3. **Add a smoke check in `test/smoke.ts`**. Shape:

   ```ts
   c('my-verb does the expected thing', async () => {
     const r = await run(['my-verb', 'arg', '--json']);
     const data = parseJson<...>(r.stdout);
     assert(...);
   });
   ```

4. **Update `crates/cli/src/help.rs`** — the --help output is byte-authoritative for what we claim the tool does.

Rebuild: `npm run build:all`. Restart the daemon: `ghax detach && ghax attach`. Run the smoke check: `GHAX_BIN=$PWD/target/release/ghax npm run test:smoke`.

## Code style

- **Rust**: rustfmt (run `cargo fmt` before committing). Prefer `anyhow::Result` in CLI modules, `thiserror` for domain-specific errors. No `unsafe` except the POSIX `kill` shim in `state.rs`.
- **TypeScript**: strict mode (see `tsconfig.json`). No `any` unless crossing an external-library boundary. Handlers return plain JSON-serializable objects — no class instances that serialize oddly.
- **Bash scripts**: `set -euo pipefail` at the top. Use `[ -f "$path" ]` test forms. Quote everything.
- **Comments**: explain *why*, not *what*. If a function does something subtle (an invariant, a workaround, a perf reason), leave a short note. Don't narrate what `if (x.length === 0)` already tells the reader.
- **Errors from the daemon**: throw `new DaemonError(message, exitCode)` where exitCode is a documented code (0, 2, 4). Plain `throw new Error(...)` maps to exit code 4.

## Voice and writing

When touching user-facing text (README, CHANGELOG, --help output, error messages), match the repo's existing voice: direct, concrete, builder-to-builder. Short sentences. Name specifics (real file paths, real numbers, real scenarios). No AI vocabulary (no "delve", "robust", "comprehensive", "leverage", "pivotal"). No em dashes. Avoid corporate tone.

Error messages should name the problem and the fix:
- Bad: `Error: connection failed`
- Good: `daemon at :52321 not responding to /health — run 'ghax attach'`

## Confusion protocol

If you hit ambiguity with meaningful blast radius (two plausible architectures, a destructive operation with unclear scope, a request that contradicts existing patterns), stop and ask. Do not guess at architectural decisions. Routine coding, small features, and obvious changes don't need permission.

## Commits and PRs

- **Imperative subject, 70 char limit.** `feat(ext): reload re-injects content scripts` not `Fixed the extension reload thing`.
- **Reference the area in parens**: `feat(daemon)`, `fix(rust-cli)`, `docs(readme)`, `refactor(snapshot)`.
- **Body explains motivation** — the *why*, not a restatement of the subject. Link field-report or issue reference if applicable.
- **Don't claim `Co-Authored-By`** unless a human co-authored the change.
- **No force-push to `main`.** Feature branches are fine to rebase.

Before opening a PR: typecheck clean, daemon bundle builds, Rust builds release, smoke passes, CHANGELOG updated under `## [Unreleased]`. Details in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Secrets

The daemon binds to `127.0.0.1` only — no auth token. This is correct for single-user localhost (see [SECURITY.md](./SECURITY.md) for the rationale). Don't add features that expose the daemon over the network without a full security review.

`chrome.storage.local` and cookie capture often contain auth tokens. Treat output from `ghax ext storage`, `ghax cookies`, and capture-bodies like `localStorage.getItem` — do not echo into commit messages, logs, or chat context.
