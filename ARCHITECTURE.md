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
│  ghax daemon (Node, ESM bundle — dist/ghax-daemon.mjs)          │
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
                             │ HTTP
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  ghax CLI (Bun-compiled single binary — dist/ghax)              │
│                                                                 │
│   Argv → parseArgs → route to handler                           │
│   Handler → rpc(port, cmd, args, opts) → print result           │
│   Special cases: attach, detach, status, restart                │
└────────────────────────────┬────────────────────────────────────┘
                             │ stdout / stderr
                             ▼
                          User / agent
```

## Why CLI (Bun) + Daemon (Node)

Two processes, two runtimes, one reason: Playwright's
`connectOverCDP` hangs under Bun 1.3.x. The daemon needs Node; the CLI
benefits from Bun's fast startup + `--compile` single-binary output
(portable, no `node_modules` in the shipped artifact).

This buys us:
- **~30-40ms CLI spawn** (Bun compiled binary vs ~150ms cold Node).
- **~65ms end-to-end per command warm** (CLI + RPC + daemon handler).
  Benchmark vs other tools: gstack-browse 56ms/cmd, ghax 65ms/cmd,
  agent-browser 178ms/cmd, playwright-cli 476ms/cmd.
- **Zero re-attach cost** — the daemon persists across invocations.
  Other tools re-attach to saved state per call.

Both build artifacts land in `dist/` via `bun run build`:
- `dist/ghax` — 61MB Mach-O (macOS), single-file CLI binary
- `dist/ghax-daemon.mjs` — ~66KB Node ESM bundle (Playwright external)

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

## What lives where

| File | Lines | Purpose |
|------|-------|---------|
| `src/cli.ts` | ~1700 | Argv parsing, verb dispatch, special-case handlers (attach, qa, ship, canary, review, pair, gif, try) |
| `src/daemon.ts` | ~1700 | RPC dispatch, all daemon-side handlers, SSE endpoints, capture wiring |
| `src/browser-launch.ts` | ~230 | Browser detect, CDP probe, scan/findFreePort, launch-browser + headless |
| `src/cdp-client.ts` | ~350 | Target pool, WebSocket management, raw CDP helpers |
| `src/snapshot.ts` | ~500 | a11y tree walker, ref assignment, cursor-interactive + shadow-DOM pass |
| `src/buffers.ts` | ~130 | CircularBuffer, entry types, parseStack |
| `src/config.ts` | ~80 | State file resolution |

The whole codebase is ~5000 lines of TypeScript plus ~500 lines of test
code. Short enough to read top-to-bottom.

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
