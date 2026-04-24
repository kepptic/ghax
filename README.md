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

That's it. No Playwright install dance. No fresh Chromium. No "please
log in again." The browser you already have open is the browser you
drive.

## Why this exists

Every AI coding agent and every browser-automation script out there has
the same problem: they launch their own browser. Which means they don't
have your SSO session, don't have your Chrome extensions, don't know
which tabs you're already working in, and will happily trigger
Cloudflare bot protection on every SaaS dashboard worth QAing.

`ghax` attaches over CDP. One command. Real browser. Real state.

It's the tool I wish existed when I was running an agent against
Autotask / Hudu / Azure Portal / Google Ads / any other dashboard
behind a 15-step SSO flow.

## What it does

- **Accessibility-tree snapshots** with `@e<n>` refs. Interact by role
  and name, not fragile CSS selectors. Walks open shadow roots for
  custom-element apps (Lit, Shoelace, web components) and emits
  Playwright chain selectors (`host >> inner`) automatically.
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

Runtime needs **Node 20+** for the daemon. If you have Playwright
installed anywhere, you already have it.

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
  browsers (Google Ads, Business Profile, Drive sharing, some Azure
  flows).

## When not to reach for ghax

- You want a clean-room / disposable Chromium for CI. Use
  [Playwright](https://playwright.dev) or `ghax attach --launch
  --headless`.
- You need cross-browser testing on Firefox or Safari. Ghax is CDP-
  only — Chrome family only (Edge, Chrome, Chromium, Brave, Arc).
- You want a recorder that generates Playwright code. Use Playwright's
  recorder. Ghax records into its own JSON format for replay, not for
  code generation.

## Architecture

```
ghax CLI (Rust, ~3 MB, ~20 ms cold start)
        │  HTTP to 127.0.0.1:<random>
        ▼
ghax daemon (Node ESM bundle, ~80 KB)
        │  ├─ Playwright (chromium.connectOverCDP) — tab-level
        │  └─ Raw CDP WebSocket pool — service workers, side panels, gestures
        ▼
Your running Chrome / Edge (--remote-debugging-port=9222)
```

The split exists because Playwright's `connectOverCDP` is Node-only,
but the CLI deserves a small fast native binary. The daemon auto-
shuts after 30 minutes idle. Full notes in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Multi-agent / parallel work

Each agent gets its own state file, its own daemon, its own window:

```bash
# Agent A
export GHAX_STATE_FILE=/tmp/ghax-agent-a.json
ghax attach
ghax new-window https://app-a.com

# Agent B (different terminal, different state)
export GHAX_STATE_FILE=/tmp/ghax-agent-b.json
ghax attach
ghax new-window https://app-b.com
```

Same browser process, same profile, same auth. Different windows.
Zero focus steal on either agent's operations.

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
