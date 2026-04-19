# ghax

G's open-source developer toolkit. A collection of CLI tools + Claude Code skills
that attach to your **real** environment (real browser, real auth, real extensions)
instead of spinning up sandboxed copies.

**Status**: v0.4 complete. Flagship `ghax browse` plus an orchestrated
layer (`qa`, `perf`, `profile`, `diff-state`, `ship`, `canary`,
`review`, `pair`, `try`) and a background-window workflow
(`find`, `new-window`, `tab --quiet`) for multi-agent use. 66/66 smoke
checks on Edge + Chrome. Repo is private under `kepptic` for now;
open-source release paused.

## What ghax does today

Attach to a running Chrome or Edge over CDP, then drive it:

- **Tabs**: list, switch, navigate, back/forward/reload, screenshot, text, eval.
- **Accessibility-tree snapshots** with `@e<n>` refs. Interact by role + name,
  not fragile CSS selectors. Cursor-interactive pass for Radix / Headless UI
  popovers that never land in the a11y tree, and **shadow-DOM aware** —
  walks open shadow roots and emits Playwright chain selectors
  (`host >> inner`) for
  custom-element-heavy apps (Lit, Shoelace, web components).
- **Annotated snapshots** (`-a`): red overlay boxes + `@e<n>` labels drawn
  onto a full-page screenshot — useful when an LLM needs to "see" the refs.
- **MV3 extensions**: list all extensions, reload them, eval JS in a service
  worker, read/write `chrome.storage.*`, interact with side panels.
- **Seamless extension hot-reload** (`ghax ext hot-reload`): reload the SW
  and re-inject content scripts + CSS into every matching tab, so
  `pnpm build` → new code running in ~5s without killing your tab state.
- **Real user gestures** via CDP `Input.dispatch*` (needed for APIs like
  `chrome.sidePanel.open()` that refuse synthetic clicks).
- **Console + network capture** from the moment you attach — rolling 5k-entry
  buffers, `--errors` and `--pattern` filters, request+response headers,
  HAR 1.2 export, stack-frame parsing on page errors, dedup grouping.
- **Core Web Vitals** (`ghax perf`): LCP (with size + source URL), FCP,
  CLS, TTFB + full navigation-timing breakdown. Buffered
  PerformanceObserver so you catch entries that fired before you asked.
- **Live-injection fix-preview** (`ghax try`): mutate the live page via
  CSS/JS, optional measurement and screenshot in one call. Revert =
  reload the page.
- **Background-window workflow** (`ghax find` / `new-window` /
  `tab --quiet`): agent gets its own OS window in the same browser +
  profile, zero focus steal, user keeps working in their other tabs.
  Multi-agent isolation comes free via `GHAX_STATE_FILE`.
- **Headless scratch mode** (`ghax attach --launch --headless`): spawn a
  fresh Chromium on an auto-picked port for CI-style runs. Lives in its
  own window so it doesn't touch your daily-driver browser.
- **Interactive shell** (`ghax shell`): REPL that keeps the CLI process
  alive between commands. Skips the per-command Bun spawn cost — ~1.8x
  faster for multi-turn agent sessions. Works piped or interactive.
- **Disconnect recovery**: if the browser crashes or you close it, the
  daemon self-shuts cleanly and subsequent commands print a helpful
  message instead of a raw Playwright stack trace.
- **Responsive testing**: `ghax responsive` snaps mobile / tablet / desktop
  widths; `ghax viewport WxH` for one-offs.
- **Batch + record + render**: pipe JSON to `ghax chain` for scripted flows;
  `ghax record start / stop` captures every command into a replayable
  `.ghax/recordings/<name>.json`; `ghax gif <recording>` stitches the
  frames via ffmpeg.

## Quickstart

Prerequisites: Bun 1.3+, Node 20+.

```bash
bun install
bun run build
bun run install-link    # symlinks dist/ghax → ~/.local/bin/ghax
```

`install-link` is optional but makes `ghax` available from any
directory without qualifying the path. `~/.local/bin` is on the
default macOS user PATH. Re-run is idempotent; remove via
`bun run uninstall-link`.

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
planned surface. Commands shipped today:

```
attach [--port N] [--browser edge|chrome|chromium|brave|arc] [--launch]
       [--headless] [--load-extension <path>] [--data-dir <path>]
       # Without --port, scans :9222-9230. Multiple running → picker.
       # With --launch and no --port, auto-picks first free port in range.
status [--json]
detach
restart
tabs
tab <id> [--quiet]              # --quiet = don't bringToFront (agent mode)
find <url-substring>            # list matching tabs (pipe into `tab`)
new-window [url]                # new background window, same profile
goto <url>
back | forward | reload
eval <js>
try [<js>] [--css <rules>] [--selector <sel>] [--measure <expr>] [--shot <path>]
text
html [<selector>]
screenshot [<@ref|selector>] [--path p] [--fullPage]
snapshot [-i] [-c] [-d N] [-s <sel>] [-C] [-a] [-o <path>]
click <@ref|selector>
fill <@ref|selector> <value>
press <key>
type <text>
wait <selector|ms|--networkidle|--load>
viewport <WxH>
responsive [prefix] [--fullPage]
diff <url1> <url2>
is <visible|hidden|enabled|disabled|checked|editable> <@ref|selector>
storage [local|session] [get|set|remove|clear|keys] [key] [value]
chain < steps.json
record start [name] | stop | status
replay <file>
gif <recording> [out.gif] [--delay ms] [--scale px] [--keep-frames]
console [--errors] [--last N] [--dedup]
network [--pattern re] [--status 4xx|500|400-499] [--last N] [--har <path>]
cookies
ext list
ext targets <ext-id>
ext reload <ext-id>
ext hot-reload <ext-id> [--wait N] [--no-inject] [--verbose]
ext sw <ext-id> eval <js>
ext panel <ext-id> eval <js>
ext popup <ext-id> eval <js>
ext options <ext-id> eval <js>
ext storage <ext-id> [local|session|sync] [get|set|clear] [key] [value]
ext message <ext-id> <json-payload>
gesture click <x,y>
gesture dblclick <x,y>
gesture scroll <up|down|left|right> [amount]
gesture key <key>
qa --url <u> [--url <u> ...] [--urls a,b,c]
   [--crawl <root> [--depth N] [--limit N]]
   [--out report.json] [--screenshots <dir>] [--no-screenshots]
   [--annotate] [--gif <out.gif>]
profile [--duration sec] [--heap] [--extension <ext-id>]
perf [--wait <ms>]              # Core Web Vitals + navigation timing
diff-state <before.json> <after.json>
canary <url> [--interval 60] [--max 3600] [--out report.json] [--fail-fast]
ship [--message "..."] [--no-check] [--no-build] [--no-pr] [--dry-run]
review [--base origin/main] [--diff]
pair [status]
shell                             # interactive REPL — skip per-command spawn cost

# Live tail (SSE)
console --follow
network --follow
ext sw <id> logs --follow
```

Add `--json` on any command for machine-readable output.

## Roadmap

See [`design/plan/04-roadmap.md`](./design/plan/04-roadmap.md).

- **v0.1** — flagship `ghax browse` working against real browsers. ✓
- **v0.2** — annotated snapshots, responsive, diff, chain, record/replay. ✓
- **v0.3** — hot-reload, shadow-DOM, gif, Claude Code skills, CI. ✓
- **v1.0** — internal hardening: smoke tests, live hot-reload
  verification, `--load-extension` pass-through. ✓
- **v0.4** — orchestrated layer (`qa`, `profile`, `diff-state`,
  `ship`, `canary`, `review`, `pair`) + SSE tail mode on console /
  network / ext sw logs + `ext popup` / `ext options` / `ext message`
  + attach ergonomics (auto-port, `--headless`, multi-CDP picker)
  + background-window workflow (`find`, `new-window`, `tab --quiet`)
  + `ghax try` live-injection preview
  + debugging depth tier 1 (`perf`, `console --dedup` + stack parsing,
  `network --status`, `network --har`)
  + cross-browser smoke harness + headless CLI benchmark. ✓
- **v0.5** — multi-tenant token-auth pair mode (flagged not-planned for
  solo use). Skill-eval harness deferred indefinitely in favor of the
  64-check smoke suite.
- Public release (npm publish, docs site, announce) paused by decision.

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
