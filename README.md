# ghax

A fast CLI for Chromium-family browser automation. Alternative to playwright-cli, Puppeteer, and Claude-in-Chrome for interactive and agent-driven workflows.

```bash
ghax attach
ghax goto https://example.com
ghax snapshot -i
ghax click @e3
ghax fill @e5 "hello"
```

[Benchmarks](#benchmarks) · [Install](#install) · [Quickstart](#quickstart) · [Features](#features) · [AI agent integration](#ai-agent-integration) · [Commands](#command-reference)

---

## Benchmarks

Most browser-automation CLIs boot a fresh browser on every command. Ghax keeps a CDP session open via a small persistent daemon, so the cold start is paid once per session instead of once per call.

Cold-start workflow (launch → goto → text → eval → screenshot → snapshot → close), Apple Silicon, against `example.com`:

| Tool | Cold start | Warm (per command) | Speedup |
|------|-----------:|-------------------:|--------:|
| **ghax** | **1.56 s** | **49 ms** | — |
| gstack-browse | 6.70 s | 58 ms | ghax 4.3× faster cold |
| agent-browser | 3.48 s | 344 ms | ghax 7.0× faster warm |
| playwright-cli | 5.13 s | 680 ms | **ghax 13.9× faster warm** |

Warm-loop on a real Wikipedia article (~250 KB): ghax 117 ms/cmd vs playwright-cli 778 ms/cmd. Text extraction 9× faster (154 ms vs 1,404 ms) because ghax hits a DOM that's already parsed instead of booting a browser to query it.

Binary: ~3 MB stripped on Apple Silicon. Cold single-command invocation: ~20 ms. Daemon bundle: ~80 KB of JavaScript.

Full methodology, per-operation breakdowns, and reproduction steps: [docs/BENCHMARK.md](./docs/BENCHMARK.md).

---

## Install

Prerequisites: Node 20+, Rust 1.80+.

```bash
git clone https://github.com/kepptic/ghax.git
cd ghax
npm install
npm run build:all
npm run install-link
```

Ensure `~/.local/bin` is on `PATH`. Then:

```bash
ghax --version     # → ghax 0.4.2
ghax --help        # full command surface (71 verbs)
```

Uninstall: `npm run uninstall-link`.

Pre-built release archives for macOS, Linux, and Windows are published on [GitHub Releases](https://github.com/kepptic/ghax/releases).

---

## Quickstart

Launch Chrome or Edge with CDP enabled:

```bash
# macOS Edge
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --remote-debugging-port=9222 &

# macOS Chrome
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/chrome-ghax" &
```

Attach and drive:

```bash
ghax attach
ghax tabs
ghax goto https://example.com
ghax snapshot -i
ghax click @e3
ghax fill @e5 "hello"
ghax screenshot --path /tmp/shot.png
ghax perf
ghax detach
```

---

## Profile modes

Three modes, one flag each.

| Mode | How | When |
|------|-----|------|
| **Existing browser session** | Launch your browser with `--remote-debugging-port=9222`, then `ghax attach` | Default. Attaches to the running Chromium process. |
| **Dedicated profile** | Same as above, but add `--user-data-dir=<path>` to the launch command | Keep ghax traffic separate from other sessions. |
| **Scratch profile** | `ghax attach --launch` (add `--headless` for no window) | CI-style runs, reproducible environments, ephemeral state. |

---

## Features

### Snapshot and interact

- Accessibility-tree snapshots with `@e<n>` refs. Click by role and name, not brittle CSS selectors.
- Dialog-aware walker. When a modal is open, snapshots walk the modal instead of the `aria-hidden="true"` app behind it.
- Shadow-DOM traversal. Chain selectors (`host >> inner`) descend into open shadow roots for custom-element apps (Lit, Shoelace, web components).
- Framework-safe `fill`. Native-setter plus `input` event for React, explicit `blur` for Angular validators, `contenteditable` paths for Material chip inputs and rich editors.
- Real user gestures via CDP `Input.dispatch*`. Needed for APIs like `chrome.sidePanel.open()` that refuse synthetic clicks.

### MV3 extensions

- Service worker eval: `ghax ext sw <id> eval "<js>"`
- `chrome.storage` read/write: `ghax ext storage <id> local get|set|remove|clear`
- Popup, options, and side-panel eval via the same shape
- Runtime message dispatch: `ghax ext message <id> <json-payload>`
- Hot-reload: `ghax ext hot-reload <id>` reloads the service worker and re-injects content scripts into every matching tab in ~5 seconds, without losing tab state.

### Observability

- Console and network capture from attach onward. Rolling 5k-entry buffers, `--errors` and `--pattern` filters, request and response headers, HAR 1.2 export, stack-frame parsing, dedup grouping.
- Source-map resolution: `console --source-maps` maps `main.abc123.js:1:48291` back to `src/AuthForm.tsx:42:12`.
- Core Web Vitals (`ghax perf`): LCP with the element that triggered it, FCP, CLS, TTFB, full nav timing. Buffered observers catch entries that fired before the call.
- Live SSE tail: `console --follow`, `network --follow`, `ext sw <id> logs --follow`.

### Execution patterns

- `ghax batch '<json-array>'` ships a whole plan in one round-trip and auto-re-snapshots between ref-using steps, so a mid-plan combobox reshuffle doesn't break later refs.
- `ghax chain` reads the same shape from stdin for ad-hoc flows.
- `ghax try [<js>] [--css <rules>] [--selector <sel>] [--measure <expr>] [--shot <path>]` mutates the running page, measures a result, and screenshots in one call. Revert = reload.
- `ghax shell` is a REPL that keeps the CLI process alive between commands, ~1.8× faster for multi-turn agent sessions.
- `ghax record start / stop` captures commands into a replayable JSON file; `ghax replay <file>` runs them back; `ghax gif <recording>` stitches frames via ffmpeg.

### Orchestrated verbs

- `ghax qa --url <u> [--crawl <root>]` walks URLs and produces a JSON report with screenshots, console errors, and failed requests.
- `ghax canary <url> --interval 60` tails a deployed URL for regressions.
- `ghax perf` and `ghax profile` for page-level and extension performance.
- `ghax diff-state <before.json> <after.json>` for comparing captured state snapshots.

### Multi-agent isolation

Per-agent state files let multiple agents share the same browser without stepping on each other:

```bash
# Agent A
GHAX_STATE_FILE=/tmp/ghax-a.json ghax attach
GHAX_STATE_FILE=/tmp/ghax-a.json ghax new-window https://app-a.com

# Agent B
GHAX_STATE_FILE=/tmp/ghax-b.json ghax attach
GHAX_STATE_FILE=/tmp/ghax-b.json ghax new-window https://app-b.com
```

Same browser process, separate windows and separate daemon state. Neither agent sees the other's active-tab pointer.

---

## Command reference

71 verbs across attach/detach, navigation, snapshot and interact, file uploads, real user gestures, MV3 extension internals, console and network capture, Core Web Vitals, screenshots, XPath, live injection, batch execution, recording and replay, and orchestrated flows.

```bash
ghax --help           # full surface — authoritative
ghax --help | less    # scroll it
```

Every verb accepts `--json` for machine-readable output. Exit codes: `0` ok, `1` usage error, `2` not attached, `4` CDP error, `10` build/bootstrap failure.

---

## AI agent integration

Ghax ships a repo-level [`llms.txt`](./llms.txt) that any shell-capable AI agent can follow to install and verify itself.

### One-paste install (any agent)

Drop this into Claude Code, Cursor, Codex, Aider, Continue, or similar:

> Clone `https://github.com/kepptic/ghax` and follow the install steps in its `llms.txt`. Verify with `ghax --version`.

The agent reads `llms.txt`, runs the three build commands, verifies the binary, and reports back.

### Claude Code

Two skills ship under [.claude/skills/](./.claude/skills/): `ghax` (router) and `ghax-browse` (flagship with workflow examples). Copy them once:

```bash
mkdir -p ~/.claude/skills
cp .claude/skills/ghax.md .claude/skills/ghax-browse.md ~/.claude/skills/
```

They're picked up automatically on phrases like *"snapshot the dashboard"* or *"hot-reload the extension"*.

### Codex, Cursor, Aider, Continue, Windsurf

These agents read a project memory file ([`AGENTS.md`](./AGENTS.md), `.cursorrules`, `CONVENTIONS.md`, or equivalent). Drop the following into your project's memory file:

```markdown
## Browser automation: use ghax

When a task requires a browser, use the `ghax` CLI. Three patterns:

1. Attach: `ghax attach` (or `ghax attach --launch` for a scratch browser)
2. Snapshot-then-interact:
   `ghax snapshot -i --json` → `ghax click @e3` → `ghax fill @e5 "..."`
3. One-round-trip batch:
   `ghax batch '[{"cmd":"click","args":["@e7"]}, ...]'`

Every verb takes `--json`. Full surface: `ghax --help`.
```

The agent reads the memory file at session start and knows when to reach for ghax.

---

## Browser compatibility

Chromium-family only: Edge, Chrome, Chromium, Brave, Arc. Firefox and Safari are out of scope (CDP-only).

Edge honors `--remote-debugging-port` on its default profile without extra flags.

Chrome 113+ silently ignores `--remote-debugging-port` on the default user-data-dir. Always pass `--user-data-dir=<path>` explicitly on Chrome launch (the quickstart above shows this).

Both browsers set `navigator.webdriver = true` when launched with `--remote-debugging-port`. Add `--disable-blink-features=AutomationControlled` to suppress that bit if a page you're automating treats it as a bot signal. Full notes: [CONTRIBUTING.md → Known browser quirks](./CONTRIBUTING.md#known-browser-quirks).

---

## Architecture

```
ghax CLI (Rust, ~3 MB, ~20 ms cold start)
        │  HTTP to 127.0.0.1:<random>
        ▼
ghax daemon (Node ESM bundle, ~80 KB)
        │  ├─ CDP tab driver — navigation, snapshot, interact
        │  └─ Raw CDP WebSocket pool — service workers, side panels, gestures
        ▼
Chromium-family browser (--remote-debugging-port=9222)
```

The CLI is a thin HTTP client so the binary stays small. The daemon owns every CDP session and auto-shuts after 30 minutes idle. Full notes: [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Contributing

Issues and PRs welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md) — it covers the Rust + Node split, the 95-check live-browser smoke suite, and hard invariants. Coding agents working on the repo should read [AGENTS.md](./AGENTS.md) first.

This project follows the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md).

---

## License

MIT. See [LICENSE](./LICENSE).

Portions adapted from [gstack](https://github.com/garrytan/gstack) by Garry Tan (also MIT): `buffers.ts`, `config.ts`, and the accessibility-snapshot algorithm in `snapshot.ts`.
