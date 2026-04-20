# Changelog

All notable changes to ghax are tracked here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `ghax xpath <expression> [--limit N]` — query the page's DOM with an
  XPath expression, return every matching element with its tag, text
  preview, and bounding box. XPath is also usable via Playwright's
  `xpath=...` prefix in every selector-accepting command (`click`,
  `fill`, `screenshot`, `is`, etc.).
- `ghax box <@ref|selector>` — return `{x, y, width, height}` of the
  first matching element. Resolves snapshot refs (`@e3`, `@c1`) or any
  selector form.
- `ghax attach --capture-bodies[=<url-glob>]` — opt-in response-body
  capture. Without a pattern, captures every JSON/text-like response
  (application/json, text/\*, javascript, xml, html, css, graphql)
  up to 32KB each. With a glob (e.g. `'*/api/*'`), restricts to
  matching URLs so browsing doesn't blow memory on images or chunks.
  Bodies past 32KB truncate with a `[truncated N bytes]` marker.
  Included in HAR export when the content is available.
- `ghax console --source-maps` — resolve bundled stack frames back to their
  original source locations via the page's source maps. Each captured
  `pageerror` already parses its stack; with `--source-maps`, every frame
  is run through the daemon's source-map cache: fetch the script, read
  its `sourceMappingURL` comment (or data: URI), parse the map, look up
  the original position. Result includes the resolved `{url, line, col}`
  plus `{bundledUrl, bundledLine, bundledCol}` for correlation. Silent
  fallback to the bundled frame on any failure (script unreachable, no
  map comment, parse error, position out of range). Adds ~60KB to the
  daemon bundle for the `source-map` library; zero cost when the flag
  isn't used.
- `ghax shell` — interactive REPL. Reads commands from stdin, tokenises
  with shell-ish quoting (single/double quotes, backslash escapes),
  re-enters the main dispatcher per line. One process for the whole
  session, so the per-command Bun spawn cost goes away. Measured 1.8x
  faster for 10-command batches (138ms/cmd vs 247ms/cmd for separate
  invocations). Works as a pipe (`cat script.txt | ghax shell`) or
  interactively (TTY prompt, history, Ctrl-D to exit). `exit`/`quit`
  stop the loop; `#` lines are comments.
- Disconnect recovery. The daemon now listens for
  `browser.on('disconnected')` and self-shuts cleanly when the user's
  browser quits or a scratch browser crashes. State file gets cleared,
  next `ghax attach` is fresh. CLI-side, "browser has been closed" /
  "Target page has been closed" errors get rewritten to
  "browser has disconnected — run `ghax attach` to reconnect" instead
  of surfacing as a raw Playwright stack trace.
- `ghax try [<js>] [--css <rules>] [--selector <sel>] [--measure <expr>]
  [--shot <path>]` — live-injection fix-preview. Composable wrapper over
  `page.evaluate` + `page.screenshot` for the "mutate the live page,
  measure, maybe screenshot" loop. CSS appends `<style class="ghax-try">`;
  JS is IIFE-wrapped with optional `el` binding; `--measure` runs
  post-mutation. Revert = reload the page.
- `ghax perf [--wait <ms>]` — Core Web Vitals + navigation timing. Reads
  LCP (with size and URL), FCP, FP, CLS, TTFB, INP, long-task count,
  plus full navTiming breakdown (DNS, TCP, TLS, TTFB, response,
  DOMInteractive, DOMContentLoaded, load, transfer/encoded/decoded
  sizes). LCP/CLS/longtask come via a buffered PerformanceObserver — they
  don't live in the default timeline buffer.
- `ghax find <url-substring>` — list tabs whose URL contains the
  substring. Returns `[{id, url, title}]`. Pipe the id into `ghax tab`
  to attach to a matching tab, or fall through to `new-window`.
- `ghax new-window [url]` — open a new OS-level window via
  `Target.createTarget({ newWindow: true, background: true })`. Same
  profile, so auth + extensions carry over. Does NOT steal focus.
  Auto-locks the new tab as the daemon's active tab so subsequent
  commands land in the fresh window without an extra `tab` step.
- `ghax tab <id> --quiet` — skip `bringToFront`. Lets an agent lock onto
  a tab without raising the window or stealing focus from whatever
  the user is actively doing.
- `ghax attach` ergonomics: auto-port fallback (`--launch` without
  `--port` scans :9222-9230 and picks the first free one, prints the
  chosen port on fallback), multi-CDP picker (plain `ghax attach` with
  multiple live CDPs shows a numbered selector), `--headless` flag
  (scratch-profile only — spawns with `--headless=new` so extensions
  still work), and a clearer kind-mismatch error when `--browser chrome`
  is asked for but only Edge is running.
- `ghax console --dedup` — groups repeated entries by (level, text)
  into `[{level, text, count, firstAt, lastAt, url, source, stack}]`
  sorted by count desc. Turns "500 identical errors" into one row with
  count=500. On capture, `pageerror` events now include a parsed stack
  `[{fn, url, line, col}]` via a new V8 stack-trace parser in
  `buffers.ts`.
- `ghax network --status <code|family|range>` filter — `--status 404`
  (exact), `--status 4xx` (family), `--status 400-499` (range).
- `ghax network --har <path>` — export captured entries as HAR 1.2 JSON
  consumable by Charles, har-analyzer, WebPageTest, and the Chrome
  DevTools network panel.
- Request + response **headers** captured on every network entry (not
  just URL + status). Response `statusText` and `duration` also
  captured. Bodies are still not captured by default (memory cost too
  high for a 5k rolling buffer).
- `test/cross-browser.ts` + `bun run test:cross-browser` — iterates every
  Chromium-family browser `detectBrowsers()` finds, launches each
  headless in a disposable scratch profile, runs the full smoke suite
  against it, tabulates pass/fail + timing per browser. Arc is filtered
  out (no CDP). First baseline: Edge 64/64 in 24.3s, Chrome 64/64 in
  26.5s.
- `test/benchmark.ts` + `bun run test:benchmark` — headless CLI benchmark
  against gstack-browse, playwright-cli, and agent-browser on a
  6-step workflow (launch → goto → text → js → screenshot → snapshot →
  close). Reports cold (end-to-end) and warm (per-command, session
  reused) numbers. First baseline: ghax 65ms/cmd, gstack 56ms/cmd,
  agent-browser 178ms/cmd, playwright-cli 476ms/cmd.
- `ghax profile [--duration sec] [--heap] [--extension <id>]` — CDP
  `Performance.getMetrics` snapshot for the active tab or an
  extension service worker. Optional duration-based delta capture and
  heap snapshot (writes a `.heapsnapshot` loadable in DevTools).
  Report written to `.ghax/profiles/<ts>.json`.
- `ghax console --follow` / `ghax network --follow` / `ghax ext sw <id>
  logs --follow` — live Server-Sent-Events streaming. Daemon exposes
  `/sse/console`, `/sse/network`, `/sse/ext-sw-logs/<ext-id>`;
  CLI consumes and prints each event as JSON. Ctrl-C exits 0.
- `ghax ext sw <id> logs [--last N] [--errors]` — dedicated SW
  console buffer (subscribes to `Runtime.consoleAPICalled` +
  `Runtime.exceptionThrown` on first call). Persists across reads,
  auto-resubscribes after hot-reload.
- `ghax ext popup <id> eval <js>` + `ghax ext options <id> eval <js>`
  — same shape as `ext panel`, for the popup and options pages. URL
  pattern matching against `/popup.html`, `/options.html`, etc.
- `ghax diff-state <before.json> <after.json>` — structural JSON
  diff. Emits RFC-6901-style paths (`/a/b/0`) with `+` / `-` / `~`
  prefixes. Supports `--json` for machine output.
- `ghax ship [--message "..."] [--no-check] [--no-build] [--no-pr]
  [--dry-run]` — opinionated commit + push + PR workflow. Runs
  typecheck + build first; on a non-main branch, fires
  `gh pr create --fill` or reports the existing PR URL.
- `ghax canary <url> [--interval sec] [--max sec] [--out r.json]
  [--fail-fast]` — periodic prod health check. Goto + snapshot +
  capture console errors + HTTP >=400 responses per cycle. Appends
  a rolling log to `.ghax/canary-<host>.log`; writes a structured
  JSON report on exit.
- `ghax review [--base origin/main] [--diff]` — emits a Claude-ready
  review prompt wrapping the branch's diff against a base. No API
  calls — stdout only, user pipes to `claude` or pastes.
- `ghax pair status` — v0 SSH-tunnel setup instructions. A proper
  token-auth multi-tenant mode is deferred to v0.5.

- `ghax qa` — orchestrated QA pass over a URL list. Flow: attach →
  goto each URL → `snapshot -i` → record console errors + HTTP >=400
  responses → write `qa-report.json`. Flags: `--url` (repeatable),
  `--urls a,b,c`, positional URLs, or stdin JSON array. `--out`,
  `--screenshots`, `--annotate`, `--gif`.
- `ghax qa --crawl <root>` — auto URL discovery. Tries
  `<root>/sitemap.xml` first; falls back to same-origin `<a href>`
  scraping up to `--depth N` hops (default 1), capped by `--limit N`
  (default 20).
- `ghax is <visible|hidden|enabled|disabled|checked|editable> <@ref|selector>`
  — assertion command. Exit 0 if condition holds, 1 otherwise.
- `ghax storage [local|session] [get|set|remove|clear|keys] [key] [value]`
  — page-level localStorage / sessionStorage.
- `ghax ext message <ext-id> <json-payload>` — `chrome.runtime.sendMessage`
  wrapper.
- `ghax gesture dblclick <x,y>` + `ghax gesture scroll <dir> [amount]` —
  real CDP `Input.dispatch*` gestures.
- `ghax attach --launch --load-extension <path> [--data-dir <path>]` —
  pass-through for Chrome's `--load-extension` + scratch profile.
- `test/smoke.ts` — 64-check harness against a live browser (grew from
  24 as the v0.4 + debugging-tier-1 surface landed).
- `test/hot-reload-smoke.ts` — fully scripted hot-reload verification.
- `test/fixtures/test-extension/` — minimal MV3 fixture.

### Changed

- `ghax ext list` enriches each entry with manifest-derived `name`,
  `version`, and `enabled` fields.
- `ghax attach` defaults changed: no `--port` now scans :9222-9230 for
  existing CDPs (multiple → picker, one → attach). With `--launch` and
  no `--port`, auto-picks the first free port in the same range. Pass
  `--port <n>` explicitly to opt out of the scan.
- `ghax attach --browser <kind>` now filters the scan too — so
  requesting Chrome while Edge runs on :9222 correctly triggers launch
  (with `--launch`) or a useful error (without it), instead of silently
  attaching to the wrong browser.
- `ghax tab <id>` gained a `--quiet` flag to skip `bringToFront`; default
  behavior unchanged.
- Network capture now stores request + response headers, response
  `statusText`, and per-request `duration` in addition to the original
  URL/status/method/resourceType.
- README reflects v0.4 features, expanded surface, and new debugging
  primitives (`perf`, `try`, `console --dedup`, `network --har`).
- `bun run install-link` / `bun run uninstall-link` — symlink
  `dist/ghax` into `~/.local/bin` so the binary resolves from any
  shell + any Claude Code session without the caller qualifying the
  path. Idempotent, reversible.

### Fixed

- Shadow-DOM selector generation: direct children of a `ShadowRoot`
  were emitting an empty segment. Now falls back to `walker.parentNode`
  when `parentElement` is null at the shadow boundary.
- Shadow-DOM selectors use ` >> ` (Playwright's chain combinator)
  instead of the invented `>>>`.

## [1.0.0] - 2026-04-19 (UNRELEASED)

The Rust CLI rewrite. ghax is now a 2.6 MB Rust binary that talks to the
unchanged Node daemon over HTTP. 30x faster cold start, 24x smaller
download, distributed as platform-specific binaries via cargo-dist for 6
target triples.

### Changed
- ghax CLI: TypeScript → Rust 2021 edition. The TS source under `src/`
  stays as a fallback during the transition release.
- Distribution: 61 MB Bun-compiled universal blob → ~2.6 MB stripped Rust
  binary on Apple Silicon (~10 MB on Linux x64) per platform.
- Cold start: ~70 ms (P50) → ~20 ms (P50). P99 ~600 ms → ~20 ms.
- Build: now requires Rust toolchain (1.80+) in addition to Bun + Node.

### Added
- 6-target release matrix via cargo-dist (macOS x64/ARM, Linux x64/ARM,
  Windows x64/ARM).
- Shell + PowerShell installer scripts that download from this repo's
  GitHub Releases. All distribution stays inside `kepptic/ghax` — no
  Homebrew tap, no crates.io publish, no npm publish required.
- Daemon discovery precedence in `attach.rs`: (1) `$GHAX_DAEMON_BUNDLE`
  env var, (2) sibling of CLI binary, (3) dev fallback at
  `<repo root>/dist/ghax-daemon.mjs`.
- Serde type mirror in `crates/cli/src/types.rs` — one struct per RPC
  return shape, hand-mirrored from the TS interfaces in `src/daemon.ts`.
- `test/parity.ts` — CI check that Rust and Bun CLIs produce byte-equal
  output for deterministic verbs. Fails loud on format drift.

### Deprecated
- The Bun-compiled CLI (`dist/ghax`). The `bin/ghax` shim now prefers the
  Rust binary when present. Bun fallback will be removed in v1.1 once the
  Rust binary has shipped to enough users.

## [0.3.0] — 2026-04-18

### Added

- `ghax ext hot-reload <ext-id>` — MV3 seamless reload. Reads the extension
  manifest, fires `chrome.runtime.reload()` without awaiting, waits for the
  service worker to restart, then re-injects each declared `content_scripts`
  entry (JS + CSS) into every open tab whose URL matches the manifest's
  `matches` patterns. Returns per-tab `{tabId, url, status, error?}`. Flags:
  `--wait <seconds>` (default 5), `--no-inject`, `--verbose`. Exit codes
  3 (ext not found), 4 (CDP error), 5 (SW didn't return), 6 (some tabs failed).
- `ghax gif <recording> [out.gif]` — replay a recording and stitch a GIF via
  ffmpeg (2-pass palette for clean colors). Flags: `--delay ms` (default
  1000), `--scale px` (default 800), `--keep-frames` for debugging.
- Shadow-DOM aware snapshot cursor scan. Recursively walks open shadow roots
  and emits Playwright chain selectors (`host >> inner`) so click/fill
  commands keep working on custom elements (Shoelace, Lit, Polymer, etc.).
- Deprecation hint on `ghax ext reload` when the extension declares content
  scripts — suggests `hot-reload` instead.
- Exit-code propagation from daemon to CLI for domain-specific errors
  (missing ext, SW timeout, etc.).

## [0.2.0] — 2026-04-18

### Added

- `ghax snapshot -a -o <path>` — annotated screenshot: red overlay boxes +
  `@e<n>` labels composited onto a full-page screenshot via an injected SVG
  (avoids re-layout on React pages).
- `ghax viewport <WxH>` — resize the active tab's viewport.
- `ghax responsive [prefix] [--fullPage]` — triple-shot at mobile (375x667),
  tablet (768x1024), desktop (1440x900) widths with the viewport restored
  after.
- `ghax diff <url1> <url2>` — naive line-based text diff between two pages.
- `ghax chain` — reads a JSON array of `{cmd, args?, opts?}` from stdin and
  dispatches the steps sequentially, returning an array of per-step results.
- `ghax record start [name] / stop / status` + `ghax replay <file>` — daemon
  captures every RPC (except meta + read-only queries) into
  `.ghax/recordings/<name>.json`, then replay walks the file and
  re-dispatches.

## [0.1.0] — 2026-04-18

### Added

- Flagship `ghax browse` — attach to a running Chrome or Edge via CDP.
- Daemon architecture: compiled Bun CLI → HTTP → Node ESM bundle daemon
  (Playwright's `connectOverCDP` hangs under Bun 1.3.x, so the daemon runs
  under Node). Auto-shuts after 30min idle.
- Tab commands: `tabs`, `tab`, `goto`, `back`, `forward`, `reload`, `eval`,
  `text`, `html`, `screenshot`, `cookies`, `wait`.
- Accessibility-tree snapshots with `@e<n>` refs (`ghax snapshot -i`).
  Includes a cursor-interactive pass for Radix / Headless UI popovers that
  never land in the a11y tree.
- Interaction: `click`, `fill` (React-safe native setter + input event),
  `press`, `type` — all ref- or selector-addressable.
- Console + network capture from the moment of attach — rolling 5k-entry
  CircularBuffers, `--errors` and `--pattern` filters.
- MV3 extension internals:
  - `ghax ext list` / `targets` / `reload`
  - `ghax ext sw <id> eval <js>`
  - `ghax ext panel <id> eval <js>`
  - `ghax ext storage <id> [local|session|sync] [get|set|clear] [key] [value]`
- Real user gestures via CDP `Input.dispatchMouseEvent` /
  `Input.dispatchKeyEvent` (needed for `chrome.sidePanel.open()` and other
  user-gesture-required APIs).
- `--json` flag on every command for machine-readable output.
- `bun build --compile` single-binary CLI + Node ESM daemon bundle.

[Unreleased]: https://github.com/kepptic/ghax/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/kepptic/ghax/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/kepptic/ghax/releases/tag/v0.3.0
[0.2.0]: https://github.com/kepptic/ghax/releases/tag/v0.2.0
[0.1.0]: https://github.com/kepptic/ghax/releases/tag/v0.1.0
