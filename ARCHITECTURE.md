# Architecture

Reader-first summary of how ghax is put together today. For the design
history (why these choices were made, alternatives rejected, etc.) see
[`design/plan/02-architecture.md`](./design/plan/02-architecture.md).

## Shape

```
┌─────────────────────────────────────────────────────────────────┐
│  User's running Chrome / Edge / Chromium                        │
│  (--remote-debugging-port=9222, real profile, real extensions)  │
└────────────────────────────┬────────────────────────────────────┘
                             │ CDP (WebSocket)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  ghax daemon (Node ESM bundle — dist/ghax-daemon.mjs)           │
│  Node 20+, unchanged from v0.4                                  │
│                                                                 │
│   Playwright's chromium.connectOverCDP   — tab-level ops        │
│   Raw CDP WebSocket pool (cdp-client.ts) — SW, side panels,     │
│                                            popups, gestures     │
│                                                                 │
│   ConsoleBuf + NetworkBuf (CircularBuffer, 5k entries each)     │
│   Active-tab pointer + ref map from last snapshot               │
│   Recording buffer (when ghax record is active)                 │
│                                                                 │
│   HTTP server on 127.0.0.1:<random>                             │
│   POST /rpc { cmd, args, opts }                                 │
│   GET  /sse/console  |  /sse/network  |  /sse/ext-sw-logs/<id>  │
│   GET  /health                                                  │
│   POST /shutdown                                                │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP (unchanged RPC protocol)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  ghax CLI (Rust 2021 edition — crates/cli/)                     │
│  ~2.6 MB stripped binary, ~20 ms cold start                     │
│                                                                 │
│   clap argv parsing → route to handler                          │
│   Handler → reqwest HTTP POST /rpc → serde_json → print result  │
│   SSE streams via reqwest async (console/network --follow)      │
│   Shell REPL via rustyline                                      │
│   Special cases: attach, detach, status, restart                │
└────────────────────────────┬────────────────────────────────────┘
                             │ stdout / stderr
                             ▼
                          User / agent
```

## Why CLI (Rust) + Daemon (Node)

Two processes, two runtimes, one reason per runtime:

- **Daemon stays Node** because Playwright's `connectOverCDP` is Node-only.
  The daemon is the working part of the stack; rewriting it means replacing
  Playwright, which is a separate project.
- **CLI moves to Rust** for distribution: the old Bun `--compile` output
  was 61 MB per platform. A Rust binary is ~2.6 MB stripped on Apple
  Silicon, ~10 MB on Linux x64. The HTTP RPC protocol is unchanged — Rust
  sends the same `POST /rpc { cmd, args, opts }` that Bun did.

Key performance numbers (Rust CLI vs old Bun CLI):
- **Cold start:** ~20 ms P50 (was ~70 ms P50, P99 ~600 ms under Bun).
- **Shell mode:** <15 ms/cmd (was ~30-40 ms/cmd).
- **End-to-end warm:** similar to before; dominant cost is now the RPC round
  trip to the daemon, not CLI startup.
- **Zero re-attach cost** — the daemon persists across invocations.

Build artifacts:
- `target/release/ghax` — Rust binary, ~2.6–10 MB depending on platform.
  Built via `cargo build --release` (or `bun run build:rust` for the
  in-repo shortcut).
- `dist/ghax-daemon.mjs` — ~134 KB Node ESM bundle (Playwright external).
  Built via `bun run build`.

## Rust dependency surface

| Crate | Purpose |
|-------|---------|
| `clap` (derive) | Argv parsing |
| `reqwest` (blocking + stream) | HTTP client; blocking for simple commands, async for SSE |
| `tokio` | Async runtime for SSE streams and shell REPL |
| `serde` + `serde_json` | JSON encode / decode |
| `rustyline` | Shell mode REPL (readline-compatible) |
| `anyhow` | Error propagation |
| `which` | Cross-platform PATH lookup (ffmpeg, git, gh, node) |
| `ctrlc` | Clean Ctrl-C handling in REPL + canary poll loop |

Daemon dependency surface is unchanged: Playwright, Node built-ins.

## Daemon discovery (attach.rs)

When `ghax attach` spawns the daemon subprocess, it resolves the bundle
path in this order:

1. `$GHAX_DAEMON_BUNDLE` env var — explicit override.
2. Sibling of the CLI binary (`argv[0]/../ghax-daemon.mjs`) — covers
   Homebrew and direct-download installs where both files land together.
3. Dev fallback: `<repo root>/dist/ghax-daemon.mjs` — works from any
   directory inside the git tree during local development.

## Serde type mirroring

The Rust CLI does not share TypeScript source with the daemon. Each RPC
return shape has a corresponding Rust struct with `#[derive(Deserialize)]`
in `crates/cli/src/`. These types are hand-mirrored from the TS
interfaces in `src/daemon.ts`. When the daemon changes a return shape,
the Rust struct must be updated in the same PR — see the CLAUDE.md
invariant.

## State

State lives in `.ghax/ghax.json` at the git root, or at `$GHAX_GLOBAL`
if that env var is set. Format:

```json
{
  "pid": 12345,
  "port": 54321,
  "browserKind": "edge",
  "browserUrl": "ws://127.0.0.1:9222/devtools/browser/<uuid>",
  "cwd": "/Users/gr/project",
  "startedAt": 1776601234000
}
```

Per-agent isolation uses `GHAX_STATE_FILE` — each agent points at its own
state file, gets its own daemon, owns its own active tab. No shared
mutable state.

Daemon auto-shuts after 30 minutes idle. A crashed daemon leaves an
orphaned state file; the next `attach` detects the dead pid and clears
it.

## The attach path

`ghax attach` has three modes, resolved in this order:

1. **Reuse** — scan ports 9222-9230 for live CDPs. If one is found,
   attach to it. If multiple, show a picker (or the first with a
   warning if stdin isn't a TTY).
2. **Launch** — with `--launch`, spawn the requested browser kind with
   `--remote-debugging-port=<first free port in 9222-9230>`. Optional
   `--headless` adds `--headless=new` (the only headless mode that
   supports extensions). Scratch profile at `~/.ghax/<kind>-profile/`
   unless `--data-dir` points elsewhere.
3. **Fail** — nothing running, no `--launch`, so print instructions for
   relaunching the user's browser with the CDP flag.

`--browser <kind>` filters the scan. Asking for Chrome while only Edge
runs gives a useful error (or triggers a launch with `--launch`),
instead of silently attaching to Edge.

## Ref resolution

`ghax snapshot -i` builds an accessibility tree and assigns `@e<n>` refs
(and `@c<n>` refs for cursor-interactive / shadow-DOM picks). The ref
map lives on the daemon's active tab. `ghax click @e3` looks up `@e3`
against that map and drives a Playwright locator.

Refs survive until the next snapshot. If the DOM changed and you run
`click @e3`, Playwright fails with a clear "no element" error — fix by
re-snapshotting.

Shadow DOM: the cursor-interactive pass walks open shadow roots and
emits Playwright chain selectors (`host >> inner`). This is the only
form of selector Playwright accepts for descending into shadow trees
as of Playwright 1.58+.

## Extension internals

MV3 extensions live as multiple CDP targets: one service worker, plus
separate page targets for popup, options, and any side panels.
`cdp-client.ts` maintains a pool keyed by target ID.

Each `ghax ext <sub>` command:

1. Resolves the requested extension via `/json/list` + manifest peek.
2. Connects to the right target (SW for `ext sw eval`, popup page for
   `ext popup eval`, etc.) via a fresh CDP session.
3. Sends `Runtime.evaluate` with the user's JS.
4. Returns the serialized result.

`ext hot-reload` is the one orchestrated ext command:

1. Connect to the SW. Read its manifest.
2. Fire `chrome.runtime.reload()` without awaiting (the SW disconnects
   us before the promise resolves).
3. Wait for the SW to restart (poll `/json/list` every 500ms).
4. For each `content_scripts[]` entry, query tabs matching its
   `matches` patterns and call `chrome.scripting.executeScript` to
   re-inject. Same for declared `css`.

## Capture buffers

Rolling 5k-entry CircularBuffers for console + network. Populated from
Playwright's `page.on('console' | 'pageerror' | 'request' | 'response')`
events, plus CDP-direct subscriptions for service-worker console
(`Runtime.consoleAPICalled` + `Runtime.exceptionThrown`).

Page errors get their stack trace parsed into structured frames
(`{fn, url, line, col}`) via `parseStack()` in `buffers.ts`. The
V8 `at fn (url:line:col)` and anonymous `at url:line:col` forms are
both handled.

Network entries store request + response headers, method, URL, status,
statusText, duration, resourceType, plus enough to reconstruct HAR 1.2
for export. Bodies are **not** captured by default — memory cost is too
high for a 5k rolling window.

## Streaming (SSE)

`ghax console --follow` / `ghax network --follow` / `ghax ext sw <id>
logs --follow` are thin wrappers over the daemon's `/sse/<stream>`
endpoints. Each CLI invocation opens a long-lived HTTP read, prints one
JSON line per event, exits on Ctrl-C. The daemon sends `:ping\n\n` every
15s to keep the connection alive through proxies.

## Background-window workflow

`ghax new-window [url]` calls CDP `Target.createTarget({ newWindow: true,
background: true })` against the browser-level CDP session. The new
window opens in the user's real browser (same profile, same auth, same
extensions) but doesn't raise or steal focus. The daemon auto-locks the
new tab as active so subsequent commands operate there without an
explicit `tab <id>` step.

Multi-agent parallelism comes free from this: each agent uses its own
`GHAX_STATE_FILE`, gets its own daemon + active-tab pointer, and
creates its own windows. They share the browser process but don't step
on each other.

## Source-map resolution

`ghax console --source-maps` lives in `src/source-maps.ts`. The
daemon holds a single `SourceMapCache` on `ctx.sourceMapCache` that
stores parsed `SourceMapConsumer` instances keyed by bundled script
URL. `null` means "tried and failed, don't retry" so we don't hammer
an unreachable script or a build that shipped without maps.

Flow per stack frame:
1. Check cache for the script URL.
2. On miss: fetch the script (3s timeout), scan for the *last*
   `//# sourceMappingURL=...` comment. Multiple are allowed in bundled
   output (one per chunk); the final one is authoritative.
3. Resolve the map URL. Inline data URIs are base64-decoded or
   URI-decoded in place. External URLs are fetched with another 3s
   timeout.
4. `new SourceMapConsumer(mapJson)` returns a parsed consumer.
5. `consumer.originalPositionFor({line, column})` returns the original
   `{source, line, column, name}`.
6. Emit a new `StackFrame` with resolved `url/line/col`, preserving
   the bundled position as `{bundledUrl, bundledLine, bundledCol}` for
   correlation.

Silent fallback: any failure at any step returns the original frame
unchanged. Source-map resolution never breaks a console read.

The `source-map` npm package (Mozilla) adds ~60KB to the daemon
bundle. Zero cost when `--source-maps` isn't passed — the cache is
lazy.

## Shell mode (REPL)

`ghax shell` is a `rustyline`-based REPL that tokenises each input line
(shell-ish quoting: single/double quotes, backslash escapes — no glob,
no env expansion) and re-enters the clap dispatcher per line.

Why it matters: even at ~20 ms cold start, agents that issue dozens of
commands per session benefit from zero-spawn overhead inside the REPL.
Shell mode targets <15 ms/cmd (budget enforced by `test/perf-bench.ts`).
Previously measured ~1.8x speedup vs separate invocations with the Bun
binary; the Rust baseline is faster to begin with.

The daemon doesn't care whether commands arrive from fresh CLI
invocations or from a long-running shell process. Same HTTP RPC,
same handlers, same state.

## Disconnect recovery

When the user closes their browser (or a scratch browser crashes),
Playwright fires `browser.on('disconnected')`. The daemon subscribes
to that event at connect time and calls `shutdown('browser-disconnected')`
via `setImmediate` to avoid running inside a Playwright event handler.

`shutdown()` clears the state file, unwinds HTTP listeners and the CDP
pool, and exits. The next `ghax attach` is fresh.

On the CLI side, the main dispatch catch clause rewrites raw Playwright
disconnect errors — `"browser has been closed"`, `"Target page has been
closed"`, anything matching `/disconnected/i` — into a one-liner:
`"browser has disconnected — run \`ghax attach\` to reconnect"`. Exit
code is `NOT_ATTACHED` so wrapper scripts can branch on it.

## What lives where

### Rust CLI (`crates/cli/src/`)

| File | Purpose |
|------|---------|
| `main.rs` | Entry point, clap dispatch |
| `attach.rs` | Browser detection, CDP probe, daemon spawn, daemon discovery |
| `rpc.rs` | `reqwest::blocking` HTTP client wrapper (`makeSimple` equivalent) |
| `sse.rs` | Async SSE stream parser (`console --follow`, `network --follow`) |
| `shell.rs` | `rustyline` REPL, tokenizer, dispatch loop |
| `types.rs` | Serde structs mirroring every RPC return shape |
| `commands/` | One file per complex verb (qa, canary, ship, review, …) |

### Node daemon (`src/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/daemon.ts` | ~1700 | RPC dispatch, all daemon-side handlers, SSE endpoints, capture wiring |
| `src/cdp-client.ts` | ~350 | Target pool, WebSocket management, raw CDP helpers |
| `src/snapshot.ts` | ~500 | a11y tree walker, ref assignment, cursor-interactive + shadow-DOM pass |
| `src/buffers.ts` | ~130 | CircularBuffer, entry types, parseStack |
| `src/source-maps.ts` | ~120 | SourceMapCache + resolver (opt-in via --source-maps) |
| `src/config.ts` | ~80 | State file resolution (uses Node child_process so it works under both Node and Bun) |

## Security model

- Daemon binds to `127.0.0.1` only. No auth, no network exposure.
- No `exec` of untrusted strings — the only arbitrary-JS path is
  `Runtime.evaluate` on the connected browser, which is already under
  the user's control.
- `ghax ext storage` can read extension auth tokens; treat its output
  like `localStorage.getItem` — don't paste it into chat.
- Multi-tenant `ghax pair` (exposing the daemon to remote agents with
  bearer-token auth) is the one v0.5 item deliberately deferred. For
  "me on another machine" use cases, the shipped SSH-tunnel mode
  (`ghax pair`) covers it without changing the daemon's security
  surface.
