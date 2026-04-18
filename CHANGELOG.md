# Changelog

All notable changes to ghax are tracked here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
- `test/smoke.ts` — 34-check harness against a live browser.
- `test/hot-reload-smoke.ts` — fully scripted hot-reload verification.
- `test/fixtures/test-extension/` — minimal MV3 fixture.

### Changed

- `ghax ext list` enriches each entry with manifest-derived `name`,
  `version`, and `enabled` fields.
- README reflects v0.3+ features and the current v0.4 status.

### Fixed

- Shadow-DOM selector generation: direct children of a `ShadowRoot`
  were emitting an empty segment. Now falls back to `walker.parentNode`
  when `parentElement` is null at the shadow boundary.
- Shadow-DOM selectors use ` >> ` (Playwright's chain combinator)
  instead of the invented `>>>`.

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

[Unreleased]: https://github.com/kepptic/ghax/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/kepptic/ghax/releases/tag/v0.3.0
[0.2.0]: https://github.com/kepptic/ghax/releases/tag/v0.2.0
[0.1.0]: https://github.com/kepptic/ghax/releases/tag/v0.1.0
