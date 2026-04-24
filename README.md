# ghax

**Drive your real Chrome or Edge from the command line.** Not a sandboxed copy. Your actual browser, with your actual auth, your actual extensions, and your actual open tabs.

```bash
ghax attach
ghax goto https://app.example.com
ghax snapshot -i                  # aria tree with @e1, @e2, … refs
ghax click @e3
ghax fill @e5 "hello"
```

That's it. No separate browser to install. No fresh Chromium. No *please log in again*. Or use a scratch profile if that's what you want. Your call.

[Benchmarks →](#fast-really-fast) · [Install →](#install) · [Quickstart →](#quickstart) · [Use with AI agents →](#install-with-an-ai-agent) · [Full commands →](#command-reference) · [License](#license)

---

## Fast. Really fast.

Ghax doesn't launch a browser — it connects to one you already have running. Zero per-command launch tax.

| Tool | Cold start | Warm (per command) | Speedup |
|------|-----------:|-------------------:|--------:|
| **ghax** | **1.56 s** | **49 ms** | — |
| gstack-browse | 6.70 s | 58 ms | ghax 4.3× faster cold |
| agent-browser | 3.48 s | 344 ms | ghax 7.0× faster warm |
| playwright-cli | 5.13 s | 680 ms | **ghax 13.9× faster warm** |

Cold-start workflow: launch → goto → text → eval → screenshot → snapshot → close. Warm: per-command loop on an already-attached session. Apple Silicon, Edge on `--remote-debugging-port=9222`.

On real-world content (Wikipedia's `JavaScript` article, ~250 KB), the warm-loop gap widens: **ghax 117 ms/cmd vs playwright-cli 778 ms/cmd.** Text extraction is 9× faster (154 ms vs 1,404 ms) because ghax hits a DOM that's already parsed instead of launching a fresh browser to query it.

The binary: **~3 MB** stripped on Apple Silicon. The daemon bundle: **~80 KB** of JavaScript. Cold single-command invocation: **~20 ms**.

Full methodology + per-operation breakdowns + reproduction steps in [docs/BENCHMARK.md](./docs/BENCHMARK.md).

---

## Why this exists

Every AI coding agent and every browser-automation script has the same problem: they launch their own browser. So they don't have your SSO session, don't have your Chrome extensions, don't know which tabs you're already working in, and will happily trip Cloudflare bot protection on any SaaS dashboard.

ghax attaches over CDP. One command. Real browser. Real state.

---

## Install with an AI agent

Got Claude Code, Cursor, Codex, Aider, Continue, ChatGPT, or any other AI coding agent? Paste this into the chat:

> **Clone `https://github.com/kepptic/ghax` and follow the install steps in its `llms.txt` file. Verify with `ghax --version` and report success.**

The agent reads [llms.txt](./llms.txt), runs three build commands, verifies the install works, and tells you when it's done. Total time: under a minute on modern hardware.

If you're running Claude Code, the repo ships with two skills under [.claude/skills/](./.claude/skills/) that light up automatically when Claude opens this directory. See [Use with AI coding agents](#use-with-ai-coding-agents) below for how to surface them in every session.

---

## Install

Prerequisites: **Node 20+**, **Rust 1.80+**, git.

```bash
git clone https://github.com/kepptic/ghax.git
cd ghax
npm install
npm run build:all        # compiles the Rust CLI + bundles the Node daemon
npm run install-link     # symlinks target/release/ghax → ~/.local/bin/ghax
```

Ensure `~/.local/bin` is on `PATH`. Then verify:

```bash
ghax --version           # → ghax 0.4.2
ghax --help              # prints the full command surface (71 verbs)
```

To uninstall: `npm run uninstall-link`.

**Pre-built release archives** (macOS, Linux, Windows) are published on [GitHub Releases](https://github.com/kepptic/ghax/releases) when CI is green. Install the latest with `npm run install-release`.

---

## Quickstart

### 1. Launch your browser with CDP enabled

```bash
# macOS Edge
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --remote-debugging-port=9222 &

# macOS Chrome v113+ — also needs an explicit profile path
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/chrome-ghax" &
```

Linux and Windows launch commands are in [CONTRIBUTING.md](./CONTRIBUTING.md).

### 2. Attach

```bash
ghax attach              # scans :9222–:9230, picks the running browser
```

### 3. Drive it

```bash
ghax tabs                            # list open tabs
ghax goto https://example.com
ghax snapshot -i                     # interactive @e refs
ghax click @e3
ghax fill @e5 "hello"
ghax screenshot --path /tmp/shot.png
ghax perf                            # Core Web Vitals
```

### 4. Detach

```bash
ghax detach
```

---

## Which profile?

You pick. Three modes, one flag each.

| Mode | Command | When |
|------|---------|------|
| **Your real profile** | Launch your browser yourself with `--remote-debugging-port=9222`, then `ghax attach` | Default. Keeps your SSO, extensions, and open tabs. |
| **A dedicated ghax profile** | Same as above, but add `--user-data-dir=<path>` to the browser launch | You want to keep ghax traffic separate from your daily driver. |
| **A throwaway scratch profile** | `ghax attach --launch` (add `--headless` for no window) | CI-style runs, reproducible environments, or you just don't want to launch the browser yourself. |

---

## Browser compatibility

Works on every Chromium-family browser: Edge, Chrome, Chromium, Brave, Arc. Firefox and Safari are out of scope — CDP-only.

**Edge is the recommended daily driver.** It honors `--remote-debugging-port` on its default profile with no extra flags, so the quickstart above works verbatim.

**Chrome has two sharp edges you'll hit if you don't know about them:**

1. **Chrome 113+ silently ignores `--remote-debugging-port` on the default profile.** Launch Chrome without `--user-data-dir` and `ghax attach` will fail to find `/json/version`. Fix: always pass an explicit profile path to the Chrome launch command (the quickstart above already shows this). Edge has no such restriction.

2. **Chrome updates more aggressively than Edge**, so CDP protocol changes, extension policy tweaks, and new anti-automation heuristics land there first. If a flow that worked yesterday breaks today, try the same thing on Edge — it's usually a week or two behind on the same change.

**Both Chrome and Edge** set `navigator.webdriver = true` when launched with `--remote-debugging-port`, which a few sensitive Google services use as a bot signal. Mitigate with `--disable-blink-features=AutomationControlled` on the browser launch. Full notes on quirks and workarounds: [CONTRIBUTING.md → Known browser quirks](./CONTRIBUTING.md#known-browser-quirks).

---

## What it does

- **Accessibility-tree snapshots** with `@e<n>` refs. Interact by role and name, not fragile CSS selectors. Walks open shadow roots for custom-element apps (Lit, Shoelace, web components) and emits chain selectors (`host >> inner`) that descend into shadow trees.
- **Dialog-aware snapshots.** When a modal is open, `ghax snapshot` walks the modal instead of the `aria-hidden="true"` app behind it. Saves you from empty trees on Radix, Headless UI, and Material dialogs.
- **MV3 extension internals.** List extensions, reload them, eval JS in service workers, read/write `chrome.storage.*`, interact with side panels, popups, and options pages. **Hot-reload** on rebuild: `pnpm build` → new code running in 5 seconds without losing tab state.
- **Real user gestures** via CDP `Input.dispatch*`. Needed for APIs like `chrome.sidePanel.open()` that refuse synthetic clicks.
- **Console + network capture** from the moment you attach. Rolling 5k buffers, `--errors` and `--pattern` filters, request + response headers, HAR 1.2 export, stack-frame parsing, dedup grouping, and source-map resolution (`main.abc123.js:1:48291` → `src/AuthForm.tsx:42:12`).
- **Core Web Vitals** (`ghax perf`). LCP with the element that caused it, FCP, CLS, TTFB, full nav timing. Buffered observers catch entries that fired before you asked.
- **Live fix-preview** (`ghax try`). Inject CSS or JS against the running page, measure the result, screenshot it, all in one call. Revert = reload.
- **Framework-safe `fill`.** Native-setter + `input` for React, explicit `blur` for Angular validators, `contenteditable` paths for Material chip inputs and rich editors.
- **Batch execution.** `ghax batch '[{"cmd":"click","args":["@e7"]}, …]'` ships a whole plan in one round-trip and auto-re-snapshots between steps that use refs, so a mid-plan combobox reshuffle doesn't break the rest of your sequence.
- **Background-window workflow.** `new-window`, `find`, `tab --quiet` give an agent its own window in your browser without stealing focus.

---

## Command reference

ghax ships 71 verbs. The full surface lives in `ghax --help` — no man pages, `--help` is authoritative.

```bash
ghax --help              # full command surface
ghax --help | less       # scroll it
ghax <verb> --help       # some verbs have per-verb help
```

Add `--json` to any command for machine-readable output.

**Exit codes:** `0` ok · `1` usage error · `2` not attached · `4` CDP error · `10` build/bootstrap failure.

---

## Use with AI coding agents

Ghax is a plain CLI. Any agent that can run shell commands can drive a browser through it.

### Claude Code

Two skills ship under [.claude/skills/](./.claude/skills/):

- [`ghax.md`](./.claude/skills/ghax.md) — top-level router. Claude picks it up when you say *"attach to my browser"*, *"test the extension"*, *"snapshot the dashboard"*.
- [`ghax-browse.md`](./.claude/skills/ghax-browse.md) — flagship skill with full workflow examples (QA, hot-reload, SaaS automation, snapshot-interact-assert loops).

Install them:

```bash
# Option 1: user-global (available in every Claude Code session)
mkdir -p ~/.claude/skills
cp .claude/skills/ghax.md .claude/skills/ghax-browse.md ~/.claude/skills/

# Option 2: project-local (auto-discovered when Claude opens this repo)
# They already live here — nothing to do.

# Option 3: symlink so future updates flow in
ln -s "$PWD/.claude/skills/ghax.md"        ~/.claude/skills/ghax.md
ln -s "$PWD/.claude/skills/ghax-browse.md" ~/.claude/skills/ghax-browse.md
```

Verify: `claude /skills` should list `ghax` and `ghax-browse`.

### Codex · Cursor · Aider · Continue · Windsurf

These agents read a project memory file. For Codex and Cursor, the convention is `AGENTS.md` at the repo root. This repo already ships one: [AGENTS.md](./AGENTS.md). For Cursor specifically you can also symlink to `.cursorrules`, for Aider to `CONVENTIONS.md`.

If you're adding ghax to **another project**, drop this snippet into that project's `AGENTS.md`:

```markdown
## Browser automation: use ghax

When a task requires a real browser (QA, dashboard automation, extension
testing, anything behind SSO), use the `ghax` CLI instead of asking the
user for screenshots or step-by-step clicks.

Three patterns cover almost every case:

1. Attach:
     ghax attach           # scans :9222-9230 for a running browser
     ghax attach --launch  # or spawn a scratch browser

2. Snapshot-then-interact (refs survive until next snapshot):
     ghax snapshot -i --json
     ghax click @e3
     ghax fill @e5 "hello"

3. One-round-trip batch (auto re-snapshots between ref-using steps):
     ghax batch '[{"cmd":"click","args":["@e7"]}, …]'

Full surface: `ghax --help`. JSON on any verb with `--json`.
```

### Raw-shell / scripted harnesses

Ghax is a well-formed Unix CLI: documented exit codes (`0` ok, `2` not attached, `4` CDP error), `--json` on every verb, stable argv. Script against it the same way you'd script against `curl` or `rg`. See `ghax --help` for the full interface.

### Multi-agent on one browser

Two agents, one browser, zero stepping on each other:

```bash
# Agent A shell
export GHAX_STATE_FILE=/tmp/ghax-a.json
ghax attach
ghax new-window https://app-a.com

# Agent B shell
export GHAX_STATE_FILE=/tmp/ghax-b.json
ghax attach
ghax new-window https://app-b.com
```

Same browser process, same profile, same auth. Different windows and separate daemon state. Neither agent sees the other's active-tab pointer.

---

## When ghax is the right call

- You're running an AI agent against a SaaS dashboard behind SSO. Fresh-browser tools break on login; ghax uses the session you already have.
- You're developing a Chrome extension and want `pnpm build` to hot-reload your service worker and content scripts without losing tab state.
- You want Core Web Vitals on your real app with your real user profile, not a headless clean-room.
- You need screenshots + console errors + failed requests in one deploy-verify report. `ghax qa --url <u>` does the whole thing in one shot.
- You need to automate a site that refuses headless browsers, but you still want CI-style repeatability.

## When ghax is the wrong call

- You need cross-browser testing on Firefox or Safari. Ghax is CDP-only — Chromium family only (Edge, Chrome, Chromium, Brave, Arc).
- You want UI-recorder codegen. Ghax records into its own JSON format for replay, not for generating test code.
- You need a fully isolated clean-room browser. Use `ghax attach --launch --headless` for disposable runs, but recognize that it still uses your system Chromium.

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
Your running Chrome / Edge (--remote-debugging-port=9222)
```

The CLI is a thin HTTP client so the binary stays small. The daemon owns every CDP session and auto-shuts after 30 minutes idle. Deeper notes: [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Security

The daemon binds to `127.0.0.1` only. No auth token — this is a single-user localhost tool. State lives in `.ghax/` relative to the current git root, or `~/.ghax/` with `GHAX_GLOBAL=1`.

`chrome.storage.local` often contains auth tokens. Treat `ghax ext storage` output like `localStorage.getItem` — don't paste it into chat context, commit messages, or logs.

Full threat model: [SECURITY.md](./SECURITY.md).

---

## Contributing

Issues and PRs welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md) — it covers the Rust + Node split, the 95-check live-browser smoke suite, and the hard invariants. If you're a coding agent working on the repo, read [AGENTS.md](./AGENTS.md) first.

This project follows the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md).

---

## License

MIT. See [LICENSE](./LICENSE).

Portions adapted from [gstack](https://github.com/garrytan/gstack) by Garry Tan (also MIT): `buffers.ts`, `config.ts`, and the accessibility-snapshot algorithm in `snapshot.ts`.

---

## Credits

Shaped by months of running AI agents against real browsers and logging every papercut. Field reports in [docs/sessions/](./docs/sessions/) for the receipts.
