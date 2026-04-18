# ghax

G's open-source developer toolkit. A collection of CLI tools + Claude Code skills
that attach to your **real** environment (real browser, real auth, real extensions)
instead of spinning up sandboxed copies.

**Status**: v0.1 in active development. The flagship `ghax browse` is working
against real Chrome/Edge sessions — including MV3 extension service workers
and side panels.

## What v0.1 does today

Attach to a running Chrome or Edge over CDP, then drive it:

- **Tabs**: list, switch, navigate, back/forward/reload, screenshot, text, eval.
- **Accessibility-tree snapshots** with `@e<n>` refs. Interact by role + name,
  not fragile CSS selectors. Includes a cursor-interactive pass for Radix /
  Headless UI popovers that never land in the a11y tree.
- **MV3 extensions**: list all extensions, reload them, eval JS in a service
  worker, read/write `chrome.storage.*`, interact with side panels.
- **Real user gestures** via CDP `Input.dispatch*` (needed for APIs like
  `chrome.sidePanel.open()` that refuse synthetic clicks).
- **Console + network capture** from the moment you attach — rolling 5k-entry
  buffers, `--errors` and `--pattern` filters.

## Quickstart

Prerequisites: Bun 1.3+, Node 20+.

```bash
bun install
bun run build
```

1. Launch your Edge or Chrome with CDP enabled:

   ```bash
   # macOS — Edge
   "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
     --remote-debugging-port=9222 &
   ```

2. Attach:

   ```bash
   ./bin/ghax attach
   # attached — pid 12345, port 54321, browser edge
   ```

3. Drive it:

   ```bash
   ./bin/ghax tabs
   ./bin/ghax goto https://example.com
   ./bin/ghax snapshot -i
   ./bin/ghax click @e3
   ./bin/ghax fill @e5 "hello"
   ./bin/ghax screenshot --path /tmp/shot.png

   # Extension work
   ./bin/ghax ext list
   ./bin/ghax ext sw <ext-id> eval "chrome.runtime.getManifest().version"
   ./bin/ghax ext storage <ext-id> local get
   ./bin/ghax ext storage <ext-id> local set someKey '{"a":1}'
   ```

4. Detach when done:

   ```bash
   ./bin/ghax detach
   ```

Don't want to relaunch your browser manually? `ghax attach --launch` will spawn
Edge (or `--browser chrome`) with a scratch profile under `~/.ghax/<kind>-profile/`.
Using your **real** profile without relaunching is a v0.2 item — it needs a
profile-copy dance to keep cookies working.

## Why not just use gstack browse?

`gstack browse` launches its own Chromium. That's right for disposable testing
but wrong when:

- You're QAing SaaS dashboards behind SSO and don't want to re-auth every run.
- You're testing a Chrome extension you wrote — it's installed in your *real*
  browser, unpacked. `gstack`'s Chromium doesn't have it.
- You want to observe your real day-to-day usage, not a clean-room replay.

`gstack browse` has a `--browser-url` CDP mode that attaches to a running
browser, but it only talks to tab DOM. It doesn't enumerate MV3 extension
targets (service workers, sidepanels, content scripts), doesn't dispatch real
user gestures, and doesn't expose `chrome.storage`. `ghax browse` fills that gap.

## Architecture

```
ghax CLI (Bun-compiled single binary)
        │  HTTP to 127.0.0.1:<random>
        ▼
ghax daemon (Node, ESM bundle)
        │  ├─ Playwright (chromium.connectOverCDP) — tab-level
        │  └─ Raw CDP WebSocket pool — service workers, sidepanels, gestures
        ▼
User's running Chrome / Edge (--remote-debugging-port=9222)
```

Why split CLI (Bun) and daemon (Node)? The CLI is short-lived and benefits from
Bun's fast startup + `--compile` portable binary. The daemon uses Playwright's
`connectOverCDP`, which hangs under Bun today — but runs reliably under Node.

The daemon auto-shuts after 30 minutes idle.

## Full command surface

See [`design/plan/03-commands.md`](./design/plan/03-commands.md) for the full
planned surface. Commands shipped in v0.1:

```
attach [--port N] [--browser edge|chrome] [--launch]
status [--json]
detach
restart
tabs
tab <id>
goto <url>
back | forward | reload
eval <js>
text
html [<selector>]
screenshot [<@ref|selector>] [--path p] [--fullPage]
snapshot [-i] [-c] [-d N] [-s <sel>] [-C]
click <@ref|selector>
fill <@ref|selector> <value>
press <key>
type <text>
wait <selector|ms|--networkidle|--load>
console [--errors] [--last N]
network [--pattern re] [--last N]
cookies
ext list
ext targets <ext-id>
ext reload <ext-id>
ext sw <ext-id> eval <js>
ext panel <ext-id> eval <js>
ext storage <ext-id> [local|session|sync] [get|set|clear] [key] [value]
gesture click <x,y>
gesture key <key>
```

Add `--json` on any command for machine-readable output.

## Roadmap

See [`design/plan/04-roadmap.md`](./design/plan/04-roadmap.md).

- **v0.1** (current) — flagship `ghax browse` working against real browsers.
- **v0.2** — recording + replay, responsive, diff, `@ref` annotations on screenshots.
- **v0.3** — Claude Code skills auto-registered.
- **v1.0** — npm publish, GitHub Actions CI, docs site.

## Security

The daemon binds to `127.0.0.1` only. No auth token in v0.1 (single-user,
localhost). State lives in `.ghax/` relative to the current git root, or
`~/.ghax/` if you export `GHAX_GLOBAL=1`. `ghax detach` shuts the daemon
cleanly; a crashed daemon's state file is detected and replaced on next attach.

`chrome.storage.local` often contains auth tokens. Treat `ghax ext storage`
output like you would `localStorage.getItem` — don't paste it into chat.

## License

MIT. Portions adapted from [gstack](https://github.com/garrytan/gstack) by Garry
Tan (also MIT) — `buffers.ts`, `config.ts`, and the accessibility-snapshot
algorithm in `snapshot.ts`.
