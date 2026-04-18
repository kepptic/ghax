# ghax — vision

## Who it's for

Solo developers and small teams shipping real products across many web apps.
They already have their work browser set up: logged in everywhere, extensions
installed, session cookies warm. They don't want to build a parallel headless
setup just to automate tests.

## What it is

A collection of CLI tools + Claude Code skills branded `ghax`. The flagship is
`ghax browse` — attach your automation to your **existing** Chrome or Edge
session via CDP. No separate profile, no cookie import, no re-login. Your real
browser becomes programmable.

Same DX lessons as `gstack` (Garry Tan's collection): persistent daemon for
speed, compiled single binary for zero-install, accessibility-tree snapshots
with `@refs` so LLMs can click by intent not CSS selectors.

## Why not just use gstack browse?

gstack browse launches its own Chromium. That's right for disposable testing
but wrong when:

- You're QAing SaaS dashboards behind SSO and don't want to re-auth every run.
- You're testing a Chrome extension you wrote — it's installed in your *real*
  browser, unpacked. gstack's Chromium doesn't have it.
- You want to observe your real day-to-day usage, not a clean-room replay.

gstack browse has a `--browser-url` CDP mode that attaches to a running
browser, but it only talks to tab DOM. It doesn't enumerate MV3 extension
targets (service workers, sidepanels, content scripts), doesn't dispatch real
user gestures, doesn't expose `chrome.storage`. `ghax browse` fills that gap.

## Design principles (inherited from gstack, adapted)

1. **Real over sandbox.** Attach to what the developer already has, don't
   recreate it.
2. **Daemon over one-shot.** Persistent background server keeps the browser
   connection warm — per-command overhead should be ~60-200ms, not seconds.
3. **Compiled single binary.** No Node install step, no pnpm dance. Bun
   `build --compile` gives us a portable Mach-O / ELF / exe.
4. **`@ref`-driven snapshots.** LLMs click `@e3` (interactive ref) not
   `div:nth-child(3) > button.primary` — the ref system survives across
   snapshot-change-click cycles.
5. **Zero config happy path.** `ghax attach` figures out where your browser is
   and what to connect to. Everything else is a command on top.
6. **MIT licensed.** Ship it so other people can use it.

## Non-goals

- Replacing Playwright or Puppeteer for programmatic test suites. `ghax` is
  for interactive and AI-driven QA, not CI test harnesses.
- Being cross-browser beyond Chromium-family (Chrome, Edge, Brave, Arc). CDP
  is the foundation. Firefox/Safari are out of scope.
- Building a UI. `ghax` is a CLI. If we need a UI, it's a separate product.
