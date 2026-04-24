# Changelog

All notable changes to ghax are tracked here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Bucket A payload-reduction sprint** — six flags and one new verb
  to cut context cost for LLM operators driving ghax (sourced from a
  field report):
  - `screenshot --full-page` — kebab-case alias for the v0.1
    `--fullPage`, matching the rest of the CLI convention. Both
    forms accepted.
  - `tabs --filter <regex> --fields <csv>` — server-side regex
    filter (case-insensitive, matched against url + title) and
    field projection (id, title, url, active). Cuts ~200 bytes per
    google-product tab.
  - `eval --max-bytes <N>` — caps the stringified eval result at
    N utf-8 bytes. On trip, returns `{value, truncated: true,
    originalBytes}`; when under cap the shape is unchanged.
  - `text --selector <sel> --length <N> --skip <M>` — scoped,
    paged page-text dumps. Replaces hand-rolled
    `document.body.innerText.substring(...)`.
  - `upload <@ref|selector> <path>[,<path>…]` — first-class file
    upload verb wrapping Playwright's `locator.setInputFiles`.
    Comma-separated paths trigger multi-file mode.
  - `snapshot --compact` now suppresses the cursor-interactive
    pass when paired with `-i`. Explicit `-C` still forces it on.
    Large SPAs shrink measurably in compact mode.
- **Bucket B — architectural fixes** (sourced from a field report):
  - `ghax batch '<json-array>'` — one-round-trip sequence executor
    (TOK-09). Unlike `chain` (stdin, N round-trips), `batch` parses
    the inline JSON client-side, ships the whole plan in a single
    RPC, and **auto-re-snapshots between steps that reference
    `@e<n>` refs** so the ref map always resolves against the
    current DOM. That directly fixes the JNR-03 mid-sequence ref-
    shift pattern observed on Material / React forms (comboboxes
    opening mid-plan and reindexing the ARIA tree). Opt out of the
    auto-snapshot with `--no-auto-snapshot`; `--no-stopOnError`
    keeps running past a failed step. Results always emit as JSON.
  - `snapshot` is now **dialog-aware by default** (JNR-06). When an
    open modal is present (`[role=dialog]`, `[role=alertdialog]`,
    native `<dialog open>`, or `[aria-modal=true]`), the walker
    treats the top-most visible modal as the new root — so the
    outer app's `aria-hidden="true"` no longer swallows every
    interactive element inside the modal. Fall back to the old
    body-rooted behavior with `--no-dialog-scope`.
  - `fill` expands the framework-safe path to cover Angular and
    Material (JNR-04). React's native-setter + `input` pattern was
    already there; now the handler also dispatches `blur` (so
    Angular's `FormControl.markAsTouched` runs and pristine/dirty
    validators fire) and handles `contenteditable` hosts (Material
    chip inputs, rich editors) via `textContent` + a proper
    `InputEvent('insertText')`.
  - `state.rs::require_daemon` gives a more actionable message when
    state is stale (JNR-01): if a ghax daemon is alive on the
    9222–9230 scan range but our state file is missing, the "no
    daemon state" error now hints at the live port and says
    `ghax attach` will re-pair with it; the pid-mismatch branch
    spells out `ghax detach && ghax attach` as the fix.
- **Bucket C papercut bundle** — five quality-of-life fixes for LLM
  operators driving ghax (sourced from a field report):
  - `ghax attach` is now silent on fresh success (POSIX convention).
    Pass `--verbose` or set `GHAX_VERBOSE=1` to restore the
    `attached — pid / port / browser` one-liner. `already attached`
    keeps printing because that's informational, not success.
  - `ghax status` surfaces the active tab id + first 60 chars of its
    title as a new `active` row — matters most in multi-agent sessions
    where `new-window` parked the agent on a non-obvious tab.
    `status --json` gains `activeTabId`, `activeTabTitle`,
    `activeTabUrl` fields alongside the existing counts.
  - `ghax eval` auto-retries once past a navigation-in-flight
    (`Execution context was destroyed` / `Target closed` / frame
    detached). The daemon waits up to 3s for the next `load` event
    and re-issues the evaluate — matches what a human would do
    manually with `wait --load && eval …`.
  - Rust CLI's RPC client single-retries transient transport errors
    (connection refused/reset/timeout) after a 50 ms pause, so a
    daemon that briefly blinks (post-spawn warm-up, GC pause, hot
    reload) doesn't bubble up a user-visible failure. Semantic
    errors (daemon answered with `ok: false`) are not retried — those
    are real command failures, not flake.
  - `ghax --help` splits the overloaded `wait` line into three:
    `wait <selector>` (most common), `wait <ms>`, and
    `wait --networkidle | --load`. `eval` gains a `# auto-retries
    once past a nav-in-flight` inline note. `attach` lists
    `[--verbose]`.

### Docs
- **Known browser quirks** section in `CONTRIBUTING.md` covers two
  not-a-ghax-bug patterns that surface when driving a real browser:
  Chrome 113+ ignores `--remote-debugging-port` on the default
  user-data-dir (fix: pass `--user-data-dir=<path>`); and Google's
  anti-bot on sensitive pages refuses to render when
  `navigator.webdriver` is set (mitigation: launch with
  `--disable-blink-features=AutomationControlled`; for flows where
  even that fails, detach / do the step manually / re-attach).

### Changed
- Pre-commit hook (`.githooks/pre-commit`) + `scripts/check.sh` run
  the same typecheck + `cargo check` + daemon bundle build that CI
  runs, in ~3s on an incremental checkout — so breakage surfaces
  before push. Enable per-clone with `git config core.hooksPath .githooks`.

## [0.4.2] - 2026-04-20

### Fixed
- **BUG-001** — auto-bootstrap daemon's Playwright runtime on fresh
  attach. Release archives ship `dist/ghax-daemon.mjs` without a
  sibling `node_modules/`, so the first `ghax attach` against a
  fresh install used to fail with `Cannot find package 'playwright'`.
  `attach.rs` now detects the missing-module sentinel and runs
  `scripts/bootstrap-daemon-runtime.sh` (npm install playwright +
  source-map) before the second attempt. Version literals
  (`PLAYWRIGHT_VERSION`, `SOURCE_MAP_VERSION`) live at module level
  and can be overridden by a sibling `package.json` if one is
  present — so release archives can ship a real package.json and
  skip the constants entirely.

### Docs
- Reproducible cross-tool benchmark — `test/benchmark.ts` now reads
  `GHAX_BIN` env var so the same 7-step workflow (launch → goto →
  text → js → screenshot → snapshot → close) runs against any
  binary. First published baseline: ghax 65ms/cmd, gstack 56ms/cmd,
  agent-browser 178ms/cmd, playwright-cli 476ms/cmd.

## [0.4.1] - 2026-04-19

First public release. **The Rust CLI rewrite** — ghax is now a ~2.6 MB
Rust binary that talks to the unchanged Node daemon over HTTP. ~3×
faster cold start (P50 ~20 ms vs ~70 ms), ~20× smaller download,
distributed as platform-specific binaries via cargo-dist for 5 target
triples (macOS x64/ARM, Linux x64/ARM, Windows x64).

### Breaking
- Two error-surface tightenings fell out of the `evalInTarget` helper
  consolidation. Both are behavior improvements but worth flagging for
  anyone with scripted error handling:
  - `ext storage` used to return `{ ok: true }` when the underlying JS
    expression threw. It now throws a `DaemonError` (exit code 4) with
    the exception details, so a failed `chrome.storage.*.set` no longer
    silently looks successful.
  - `ext message` used to return `null` when the cross-extension
    `chrome.runtime.sendMessage` threw outside its inner try/catch. It
    now throws a `DaemonError` as well.

### Added
- 5-target release matrix via cargo-dist (macOS x64/ARM, Linux x64/ARM,
  Windows x64).
- Shell + PowerShell installer scripts that download from this repo's
  GitHub Releases. All distribution stays inside `kepptic/ghax` — no
  Homebrew tap, no crates.io publish, no npm publish required.
- Daemon discovery precedence in `attach.rs`: (1) `$GHAX_DAEMON_BUNDLE`
  env var, (2) sibling of CLI binary, (3) dev fallback at
  `<repo root>/dist/ghax-daemon.mjs`.
- Smoke suite (`test/smoke.ts`) reads `GHAX_BIN` env var so the same 80
  checks run against any binary. 80/80 against the Rust binary in 31.3s.
- `console --since <epoch-ms>` and `network --since <epoch-ms>` filter
  buffer entries server-side, so callers (notably `qa` and `canary`)
  don't have to ship hundreds of irrelevant entries across the HTTP
  RPC just to discard them locally. `console` also accepts `errors:
  true` via RPC opts so the daemon drops non-error levels before
  serialising; the Rust CLI uses this on the hot path.
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
- `ghax console --source-maps` — resolve bundled stack frames back to
  their original source locations via the page's source maps. Each
  captured `pageerror` already parses its stack; with `--source-maps`,
  every frame is run through the daemon's source-map cache. Silent
  fallback to the bundled frame on any failure. Adds ~60KB to the
  daemon bundle for the `source-map` library; zero cost when the flag
  isn't used.
- `ghax shell` — interactive REPL. Reads commands from stdin, tokenises
  with shell-ish quoting, re-enters the main dispatcher per line. One
  process for the whole session, so the per-command Bun spawn cost goes
  away. Measured 1.8× faster for 10-command batches (138ms/cmd vs
  247ms/cmd for separate invocations). Works as a pipe or TTY prompt.
- Disconnect recovery. The daemon now listens for
  `browser.on('disconnected')` and self-shuts cleanly when the user's
  browser quits or a scratch browser crashes. State file gets cleared,
  next `ghax attach` is fresh. CLI-side, Playwright "browser has been
  closed" / "Target page has been closed" errors get rewritten to
  "browser has disconnected — run `ghax attach` to reconnect".
- `ghax try [<js>] [--css <rules>] [--selector <sel>] [--measure <expr>]
  [--shot <path>]` — live-injection fix-preview. Composable wrapper over
  `page.evaluate` + `page.screenshot` for the "mutate the live page,
  measure, maybe screenshot" loop. Revert = reload the page.
- `ghax perf [--wait <ms>]` — Core Web Vitals + navigation timing. Reads
  LCP (with size + URL), FCP, FP, CLS, TTFB, INP, long-task count, plus
  full navTiming breakdown. LCP/CLS/longtask come via a buffered
  PerformanceObserver.
- `ghax find <url-substring>` — list tabs whose URL contains the
  substring. Returns `[{id, url, title}]`.
- `ghax new-window [url]` — open a new OS-level window via
  `Target.createTarget({ newWindow: true, background: true })`. Same
  profile, so auth + extensions carry over. Does NOT steal focus.
- `ghax tab <id> --quiet` — skip `bringToFront`. Lets an agent lock onto
  a tab without raising the window or stealing focus.
- `ghax attach` ergonomics: auto-port fallback (scans :9222-9230 and
  picks the first free one on `--launch`), multi-CDP picker, `--headless`
  flag (scratch-profile only), and a clearer kind-mismatch error when
  `--browser chrome` is asked for but only Edge is running.
- `ghax console --dedup` — groups repeated entries by (level, text)
  into `[{level, text, count, firstAt, lastAt, url, source, stack}]`
  sorted by count desc. On capture, `pageerror` events now include a
  parsed stack `[{fn, url, line, col}]` via a new V8 stack-trace parser.
- `ghax network --status <code|family|range>` filter — `--status 404`
  (exact), `--status 4xx` (family), `--status 400-499` (range).
- `ghax network --har <path>` — export captured entries as HAR 1.2 JSON
  consumable by Charles, har-analyzer, WebPageTest, and the Chrome
  DevTools network panel.
- Request + response **headers** captured on every network entry (not
  just URL + status). Response `statusText` and `duration` also
  captured.
- `test/cross-browser.ts` + `bun run test:cross-browser` — iterates every
  Chromium-family browser `detectBrowsers()` finds, launches each
  headless in a disposable scratch profile, runs the full smoke suite
  against it, tabulates pass/fail + timing per browser. First baseline:
  Edge 64/64 in 24.3s, Chrome 64/64 in 26.5s.
- `test/benchmark.ts` + `bun run test:benchmark` — headless CLI benchmark
  against gstack-browse, playwright-cli, and agent-browser on a
  6-step workflow.
- `ghax profile [--duration sec] [--heap] [--extension <id>]` — CDP
  `Performance.getMetrics` snapshot for the active tab or an
  extension service worker. Optional duration-based delta capture and
  heap snapshot (writes a `.heapsnapshot` loadable in DevTools).
- `ghax console --follow` / `ghax network --follow` / `ghax ext sw <id>
  logs --follow` — live Server-Sent-Events streaming. Daemon exposes
  `/sse/console`, `/sse/network`, `/sse/ext-sw-logs/<ext-id>`; CLI
  consumes and prints each event as JSON. Ctrl-C exits 0.
- `ghax ext sw <id> logs [--last N] [--errors]` — dedicated SW
  console buffer (subscribes to `Runtime.consoleAPICalled` +
  `Runtime.exceptionThrown` on first call). Persists across reads,
  auto-resubscribes after hot-reload.
- `ghax ext popup <id> eval <js>` + `ghax ext options <id> eval <js>`
  — same shape as `ext panel`, for the popup and options pages.
- `ghax diff-state <before.json> <after.json>` — structural JSON
  diff. Emits RFC-6901-style paths with `+` / `-` / `~` prefixes.
- `ghax ship [--message "..."] [--no-check] [--no-build] [--no-pr]
  [--dry-run]` — opinionated commit + push + PR workflow.
- `ghax canary <url> [--interval sec] [--max sec] [--out r.json]
  [--fail-fast]` — periodic prod health check. Goto + snapshot +
  capture console errors + HTTP >=400 responses per cycle.
- `ghax review [--base origin/main] [--diff]` — emits a Claude-ready
  review prompt wrapping the branch's diff against a base.
- `ghax pair status` — v0 SSH-tunnel setup instructions.
- `ghax qa` — orchestrated QA pass over a URL list.
- `ghax qa --crawl <root>` — auto URL discovery via `<root>/sitemap.xml`,
  falls back to same-origin `<a href>` scraping up to `--depth N` hops.
- `ghax is <visible|hidden|enabled|disabled|checked|editable>
  <@ref|selector>` — assertion command. Exit 0 if condition holds, 1
  otherwise.
- `ghax storage [local|session] [get|set|remove|clear|keys] [key]
  [value]` — page-level localStorage / sessionStorage.
- `ghax ext message <ext-id> <json-payload>` — `chrome.runtime.sendMessage`
  wrapper.
- `ghax gesture dblclick <x,y>` + `ghax gesture scroll <dir> [amount]` —
  real CDP `Input.dispatch*` gestures.
- `ghax attach --launch --load-extension <path> [--data-dir <path>]` —
  pass-through for Chrome's `--load-extension` + scratch profile.
- **Invariant enforcement**: `ctx.refs` is now cleared when the active
  tab changes (via `tab <id>` or `new-window`). Previously the
  "refs survive only until next snapshot" rule held within a tab but
  broke across tab switches — `@e3` from tab A could silently resolve
  against tab B's DOM. A new smoke check (`refs cleared on tab switch`)
  asserts the invariant.
- `test/smoke.ts` — 80-check harness against a live browser.
- `test/hot-reload-smoke.ts` — fully scripted hot-reload verification.
- `test/fixtures/test-extension/` — minimal MV3 fixture.

### Changed
- ghax CLI: TypeScript/Bun → Rust 2021 edition. Single source of truth.
- Distribution: 61 MB Bun-compiled universal blob → ~2.6 MB stripped Rust
  binary on Apple Silicon (~10 MB on Linux x64) per platform.
- Cold start: ~70 ms (P50) → ~20 ms (P50). P99 ~600 ms → ~20 ms.
- Build: now requires Rust toolchain (1.80+). Bun stays as a dev tool for
  the daemon bundle (`bun build --target=node`) and the test runner.
- Daemon DRY pass: three new helpers collapse repeated shapes.
  `evalInTarget()` centralises nine `Runtime.evaluate` sites with
  consistent `exceptionDetails` handling. `getSwTarget()` owns the
  find-sw / pool.get / Runtime.enable dance across five extension
  verbs. `withCdpSession()` owns the session open + try/finally +
  detach lifecycle across five gesture/profile sites.
- Rust CLI DRY pass: new `time_util` module consolidates three copies
  of the ISO-8601 / days-to-ymd logic; new `qa_common` module shares
  the `console_errors_since` / `failed_requests_since` filters
  between `qa` and `canary`, with the filtering now happening
  daemon-side via the new `since:` opt.
- `dispatch.rs` swaps a hand-rolled percent-encoder for the
  `urlencoding` crate; `qa.rs` swaps a hand-rolled URL resolver for
  `url::Url::join`.
- `require_daemon` (Rust) now trusts `/health` as the liveness
  signal and only falls back to the `kill(pid, 0)` syscall when
  `/health` fails — every CLI invocation shaves a syscall.
- `snapshot.ts` caches `getComputedStyle()` results per element for
  the duration of one walk. The cursor-interactive pass used to
  force-recalc styles O(n · depth) times on SPA-sized trees; now
  O(n) via a scoped `WeakMap`.
- Daemon: `pageTargetId()` caches the target id on a `WeakMap<Page>`.
  Every command that walks tabs used to pay a full CDP round-trip
  per page per call. With the cache, the hot path is O(1).
- Daemon: `tabs` and `find` handlers now fan out per-page
  `pageTargetId` + `page.title()` in parallel with `Promise.all`
  instead of a serial await loop.
- `snapshot.ts`: the aria-tree disambiguation pass used to call
  `parseLine()` twice per line. Parsed once into a reused array —
  meaningful on large SPAs.
- `attach.rs` simplification (post-/simplify pass): collapsed the
  two-function `spawn_daemon` + `spawn_daemon_with_retry` recursion-
  with-flag into a single `for attempt in 0..2` loop. Extracted
  `build_daemon_cmd()` and `is_missing_module()` helpers.
- Bash scripts factor out `scripts/bootstrap-daemon-runtime.sh` — now
  the single source of truth for the daemon's `npm install` step.
  `install-link.sh` and `install-release.sh` both delegate to it.
  Includes version-mismatch detection.
- `release.sh` swaps `cargo build --release` (30-90s, artifact unused)
  for `cargo update --workspace` (~1s) — the local build was only there
  to refresh `Cargo.lock` after the version sed; CI builds the
  authoritative artifact.
- `ghax ext list` enriches each entry with manifest-derived `name`,
  `version`, and `enabled` fields.
- `ghax attach` defaults changed: no `--port` now scans :9222-9230 for
  existing CDPs. Pass `--port <n>` explicitly to opt out of the scan.
- `ghax attach --browser <kind>` now filters the scan too.
- Network capture now stores request + response headers, response
  `statusText`, and per-request `duration`.
- `bun run install-link` / `bun run uninstall-link` — symlink
  `dist/ghax` into `~/.local/bin` so the binary resolves from any
  shell without the caller qualifying the path. Idempotent, reversible.
- README reflects v0.4 features, expanded surface, and new debugging
  primitives (`perf`, `try`, `console --dedup`, `network --har`).
- Trimmed a "BUG-001" ticket label out of the user-facing daemon-failure
  error message; the surrounding text already explains the fix.

### Fixed
- Shadow-DOM selector generation: direct children of a `ShadowRoot`
  were emitting an empty segment. Now falls back to `walker.parentNode`
  when `parentElement` is null at the shadow boundary.
- Shadow-DOM selectors use ` >> ` (Playwright's chain combinator)
  instead of the invented `>>>`.

### Removed
- The Bun CLI source — `src/cli.ts` (~2,071 lines) and
  `src/browser-launch.ts` (~230 lines). The `bin/ghax` shim now
  resolves to `target/release/ghax` (Rust) only; the Bun fallback
  paths are gone.
- The `dev` package.json script (`bun run src/cli.ts`) — no source
  CLI to hot-reload anymore. Use `cargo run --release` for the Rust
  equivalent.
- The Bun-compiled `dist/ghax` binary — the `build` script now
  bundles the daemon only.

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

[Unreleased]: https://github.com/kepptic/ghax/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/kepptic/ghax/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/kepptic/ghax/compare/v0.3.0...v0.4.1
[0.3.0]: https://github.com/kepptic/ghax/releases/tag/v0.3.0
[0.2.0]: https://github.com/kepptic/ghax/releases/tag/v0.2.0
[0.1.0]: https://github.com/kepptic/ghax/releases/tag/v0.1.0
