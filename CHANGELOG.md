# Changelog

All notable changes to ghax are tracked here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
  and emits Playwright pierce selectors (`host >>> inner`) so click/fill
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

[Unreleased]: https://github.com/kepptic/ghax/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kepptic/ghax/releases/tag/v0.2.0
[0.1.0]: https://github.com/kepptic/ghax/releases/tag/v0.1.0
