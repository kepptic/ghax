# ghax

Drive your **real** running Chrome or Edge from the command line. Not a
sandboxed copy. Your actual browser, with your actual auth, your actual
extensions, and your actual open tabs.

```bash
ghax attach
ghax goto https://app.example.com
ghax snapshot -i              # aria tree with @e1, @e2, ... refs
ghax click @e3
ghax fill @e5 "hello"
```

That's it. No separate browser to install. No fresh Chromium. No
"please log in again." The browser you already have open is the
browser you drive.

Prefer a scratch browser? That's one flag away — `ghax attach --launch
--headless` spawns a fresh Chromium in its own profile for CI-style
runs without touching your daily driver.

## Why this exists

Every AI coding agent and every browser-automation script out there has
the same problem: they launch their own browser. Which means they don't
have your SSO session, don't have your Chrome extensions, don't know
which tabs you're already working in, and will happily trigger
Cloudflare bot protection on every SaaS dashboard worth QAing.

`ghax` attaches over CDP. One command. Real browser. Real state.

Or a scratch profile if that's what you want. Your call.

## What it does

- **Accessibility-tree snapshots** with `@e<n>` refs. Interact by role
  and name, not fragile CSS selectors. Walks open shadow roots for
  custom-element apps (Lit, Shoelace, web components) and emits
  chain selectors (`host >> inner`) that descend into shadow trees.
- **Dialog-aware**. When a modal is open, snapshots walk the modal, not
  the `aria-hidden="true"` app behind it. Saves you from empty trees
  on Radix / Headless UI / Material dialogs.
- **MV3 extension internals**. List extensions, reload them, eval JS in
  service workers, read/write `chrome.storage.*`, interact with side
  panels, popups, options pages. Hot-reload on rebuild so `pnpm build`
  gives you new code in 5 seconds without losing tab state.
- **Real user gestures** via CDP `Input.dispatch*`. Because
  `chrome.sidePanel.open()` and friends refuse synthetic clicks.
- **Console + network capture** from the moment you attach. Rolling 5k
  buffers, `--errors` and `--pattern` filters, request + response
  headers, HAR 1.2 export, stack-frame parsing, dedup grouping, and
  **source-map resolution** (`main.abc123.js:1:48291` →
  `src/AuthForm.tsx:42:12`).
- **Core Web Vitals** (`ghax perf`). LCP (with the element that hit
  it), FCP, CLS, TTFB, full nav timing. Buffered observers catch
  entries that fired before you asked.
- **Live fix-preview** (`ghax try`). Inject CSS or JS against the
  running page, measure the result, screenshot it, all in one call.
  Revert = reload.
- **Framework-safe `fill`**. Native-setter + `input` for React,
  explicit `blur` for Angular validators, `contenteditable` paths for
  Material chip inputs and rich editors. Works on every framework you
  actually hit.
- **Batch execution**. `ghax batch '[{"cmd":"click","args":["@e7"]},
  ...]'` ships a whole plan in one round-trip and auto-re-snapshots
  between steps that use refs, so a mid-plan combobox reshuffle
  doesn't break the rest of your sequence.
- **Background-window workflow**. `new-window`, `find`, `tab --quiet`
  give an agent its own window in your browser without stealing focus
  from the window you're working in. Multi-agent isolation via
  `GHAX_STATE_FILE`.

Full command reference in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Install

ghax ships as a platform-specific Rust binary. Under 3 MB stripped on
Apple Silicon. Distribution is GitHub Releases only. No registries,
no taps, no accounts.

```bash
# macOS / Linux
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/kepptic/ghax/releases/latest/download/ghax-installer.sh | sh

# Windows PowerShell
irm https://github.com/kepptic/ghax/releases/latest/download/ghax-installer.ps1 | iex
```

Runtime needs **Node 20+** for the daemon. Most developer laptops
already have it.

Build from source (Rust 1.80+, Node 20+):

```bash
git clone https://github.com/kepptic/ghax.git
cd ghax
npm install
npm run build:all
npm run install-link        # symlinks → ~/.local/bin/ghax
```

## Quickstart

1. Launch your browser with CDP enabled:

   ```bash
   # macOS Edge
   "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
     --remote-debugging-port=9222 &

   # macOS Chrome (v113+ also needs an explicit profile path — see
   # CONTRIBUTING.md "Known browser quirks")
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.config/chrome-ghax" &
   ```

2. Attach. Ghax scans ports 9222–9230 and picks the running browser:

   ```bash
   ghax attach
   ```

3. Drive it:

   ```bash
   ghax tabs                          # list open tabs
   ghax goto https://example.com
   ghax snapshot -i                   # get @e refs
   ghax click @e3
   ghax fill @e5 "hello"
   ghax screenshot --path /tmp/shot.png
   ghax perf                          # Core Web Vitals
   ```

4. Detach when done:

   ```bash
   ghax detach
   ```

## Which profile?

You pick. Three modes:

- **Your real profile** — launch Edge or Chrome with
  `--remote-debugging-port=9222` (the quickstart above). You keep your
  extensions, your SSO cookies, and your open tabs. Ghax just drives
  what's already there.
- **A dedicated ghax profile** — pass `--user-data-dir=<path>` to your
  browser launch to keep ghax's tabs separate from your daily driver.
  Same browser binary, different profile directory. Useful if you
  don't want an agent touching your personal tabs.
- **A fresh scratch profile** — `ghax attach --launch` spawns your
  browser with a throwaway profile under `~/.ghax/<kind>-profile/`.
  Add `--headless` for a no-window CI-style run. Zero overlap with
  your daily driver.

The quickstart covers option 1. Options 2 and 3 are one flag each.

## Use with AI coding agents

Ghax was built for AI-driven browser work. Every capability has a CLI
so any agent that can run shell commands can use it.

### Claude Code

The repo ships two skills under `.claude/skills/`:

- [`ghax`](./.claude/skills/ghax.md) — top-level router; Claude picks
  it up when you say "attach to my browser", "test the extension",
  "snapshot the dashboard", etc.
- [`ghax-browse`](./.claude/skills/ghax-browse.md) — the flagship
  skill; full workflow examples for QA, extension hot-reload, SaaS
  dashboard automation, snapshot-interact-assert loops.

Both skills auto-register once the repo is on disk. If you run Claude
Code globally, add ghax to your skill index (see your gstack
`skill-registry` setup) and you're done.

### Codex / Cursor / any shell-driving agent

Ghax is a plain CLI. Give your agent three facts:

1. How to attach:

   ```bash
   ghax attach           # scans :9222-9230, picks what's running
   ghax attach --launch  # or spawn a scratch browser
   ```

2. The snapshot-then-interact pattern:

   ```bash
   ghax snapshot -i --json     # returns the a11y tree + @e refs
   ghax click @e3              # refs survive until next snapshot
   ghax fill @e5 "hello"
   ```

3. How to batch for one round-trip:

   ```bash
   ghax batch '[
     {"cmd":"goto","args":["https://app.example.com"]},
     {"cmd":"snapshot","opts":{"interactive":true}},
     {"cmd":"click","args":["@e7"]},
     {"cmd":"fill","args":["@e9","new-value"]}
   ]'
   ```

Add `--json` to any command for machine-readable output. That's the
whole integration.

### Multi-agent on one browser

Two agents, one browser, zero stepping on each other:

```bash
# Agent A
GHAX_STATE_FILE=/tmp/ghax-a.json ghax attach
GHAX_STATE_FILE=/tmp/ghax-a.json ghax new-window https://app-a.com

# Agent B (separate shell)
GHAX_STATE_FILE=/tmp/ghax-b.json ghax attach
GHAX_STATE_FILE=/tmp/ghax-b.json ghax new-window https://app-b.com
```

Same browser, same profile, same auth. Different windows and separate
daemon state. Neither agent sees the other's active-tab pointer.

## When to reach for ghax

- You're running an AI agent against a SaaS dashboard behind SSO.
  Fresh-browser tools break on login. Ghax uses the session you
  already have.
- You're developing a Chrome extension and want `pnpm build` to hot-
  reload your service worker + content scripts without losing tab
  state. No other tool does this.
- You want Core Web Vitals on your real app with your real user
  profile, not a headless clean-room.
- You're QAing a deploy and need screenshots + console errors +
  failed-request list in one report. `ghax qa --url <u>` does the
  whole thing.
- You need to automate a dashboard that actively refuses headless
  browsers but you still want CI-style repeatability — attach to a
  real visible browser locally, drive it the same way an agent would
  in prod.
- You want a clean-room disposable browser for CI. `ghax attach
  --launch --headless` gives you one in its own scratch profile.

## When not to reach for ghax

- You need cross-browser testing on Firefox or Safari. Ghax is CDP-
  only — Chrome family (Edge, Chrome, Chromium, Brave, Arc).
- You want codegen from a UI recorder. Ghax records into its own JSON
  format for replay, not for generating test code.

## Architecture

```
ghax CLI (Rust, ~3 MB, ~20 ms cold start)
        │  HTTP to 127.0.0.1:<random>
        ▼
ghax daemon (Node ESM bundle, ~80 KB)
        │  ├─ CDP tab driver — navigation, snapshot, interact
        │  └─ Raw CDP WebSocket pool — service workers, side panels, gestures
        ▼
Your running Chrome / Edge (--remote-debugging-port=9222)
```

The CLI is a thin HTTP client so the binary stays small. The daemon
owns every CDP session and auto-shuts after 30 minutes idle. Full
notes in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Security

The daemon binds to `127.0.0.1` only. No auth token — this is a
single-user, localhost tool. State lives in `.ghax/` relative to the
current git root, or `~/.ghax/` with `GHAX_GLOBAL=1`.

`chrome.storage.local` often contains auth tokens. Treat
`ghax ext storage` output like `localStorage.getItem` — don't paste
it into chat.

See [SECURITY.md](./SECURITY.md) for the threat model and disclosure
process.

## Contributing

Issues and PRs welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md)
— it covers the Rust + Node split, the 95-check live-browser smoke
suite, and the hard invariants that'll bite you if you skip them.

## License

MIT. Portions adapted from [gstack](https://github.com/garrytan/gstack)
by Garry Tan (also MIT): `buffers.ts`, `config.ts`, and the
accessibility-snapshot algorithm in `snapshot.ts`.

## Credits

Shaped by months of running AI agents against real dashboards and
logging every papercut. Field reports in
[`docs/sessions/`](./docs/sessions/) if you want the receipts.
