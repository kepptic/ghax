---
name: ghax
description: Drive Chrome or Edge via CDP — tabs, accessibility-tree snapshots with @ref clicks, MV3 extension internals (service workers, sidepanels, chrome.storage, hot-reload), real user gestures. Read this BEFORE any Edge/Chrome CDP or relaunch attempt — since Edge 150/Chrome 136 the real profile can't expose CDP directly, so ghax drives the user's REAL session through its own bridge extension (`ghax attach --extension`, full verb parity) and drives fresh user-approved scratch instances via `--launch`. Use when the user mentions ghax, asks to QA a site, verify a deploy, test an extension they wrote, or interact with a browser dashboard. Triggers — "attach to my browser", "test the extension", "hot-reload", "click in edge", "snapshot the dashboard", "run this in the service worker", "read chrome.storage", and after `pnpm build` finishes on any extension target. Do NOT use for headless one-off testing — use playwright-cli for that.
---

# Skill: ghax

`ghax` is G's open-source developer toolkit — CLI tools (and this Claude
Code skill) that attach to the user's real working environment rather
than sandboxing. The flagship is browser driving over CDP: @ref
snapshots, MV3 extension internals, real gestures, console/network
capture — things sandboxed tools don't surface cleanly.

**Since Edge 150 / Chrome 136 the user's real (default-profile) browser
cannot expose CDP directly** — see "Browser control model" below before
doing anything. Short version: ghax drives the user's real session
through its own **bridge extension** (`ghax attach --extension`, full
command parity as of v0.5), and drives fresh user-approved scratch
instances via `ghax attach --launch`.

## When to reach for ghax

- The user says **"attach"** or approves launching a browser instance
  for automation work.
- They just ran `pnpm build` / `npm run build` on a **Chrome extension**
  target. ghax is the only tool that can hot-reload the extension AND
  re-inject content scripts into every open matching tab without
  disrupting the user's workspace.
- They ask to read or write **`chrome.storage`** (local/session/sync) for
  debugging or scripting.
- They ask to eval something in an **extension service worker** — e.g.
  "make the SW re-fetch the token" or "clear its in-memory cache".
- They ask for an **accessibility-tree snapshot with refs** (`@e1`, `@e2`)
  of a complex page so you can click "the save button" without guessing
  at selectors.
- They want to **annotate a screenshot** with @ref overlays to share a
  debugging session.

## When NOT to reach for ghax

- Quick one-off headless testing → `ghax attach --launch` (scratch profile) or **playwright-cli**.
- Programmatic test suites, tracing, video → **playwright-cli**.
- The task needs the user's real session but the **ghax bridge extension
  isn't installed** and can't be → fall back to the **Claude-in-Chrome
  extension** (`mcp__claude-in-chrome__*`) or playwright-cli with the saved
  `.auth/` storageState cookies. (With the bridge installed, real-session work is a
  ghax job — see Lane 1 below.)

## Prerequisites

### 1. `ghax` on PATH

Verify with `which ghax`. On this machine it's symlinked as
`~/.local/bin/ghax → <repo>/dist/ghax`. If missing:

```bash
cd /Users/gr/Documents/DevOps/kepptic/products/open-source/ghax
bun run build && bun run install-link
```

### 2. Browser listening on CDP

Verify with:

```bash
curl -s http://127.0.0.1:9222/json/version | head -3
```

If nothing responds, follow the relaunch procedure below.

## Browser control model since Edge 150 / Chrome 136

**CDP on the default (real) profile is no longer possible.** Edge 150
and Chrome 136+ implement Chromium's remote-debugging hardening:
`--remote-debugging-port` is silently ignored unless `--user-data-dir`
points at a **non-default** directory. Verified 2026-07-12 on Edge
150.0.4078.65: no `DevToolsActivePort` file, nothing listens, no error
printed. There is no escape hatch — the `RemoteDebuggingAllowed` policy
does not bypass it, the `DevToolsDebuggingRestrictions` feature flag
has been removed, and cloning the real profile into a custom data dir
loses every cookie and saved password to per-data-dir encryption
(also verified 2026-07-12). Don't waste a session rediscovering any of
this.

### Quick decision guide — what to look for → what to do

| Situation / symptom | Do this |
|---|---|
| Need the user's **real logged-in session** (their open tabs, SSO, cookies) | **Lane 1** — `ghax attach --extension`. Install the bridge extension once (`edge://extensions` → Load unpacked → `extension/`). |
| `ghax attach` prints "No running browser found on CDP port" / nothing on `:9222` / no `DevToolsActivePort` file | Expected on the real profile since Edge 150. Do **not** relaunch the real Edge with `--remote-debugging-port` — it's silently ignored. Use Lane 1 (bridge) for the real session, or Lane 2 (`--launch`) for a scratch instance. |
| Tempted to **copy the real profile** into a non-default `--user-data-dir` to get CDP + logins | **Don't.** The copy gets extensions/settings but **zero logins** — cookies/passwords are encrypted per data-dir and won't decrypt in a copy (verified 2026-07-12). Use the bridge. |
| Clean-room / CI / extension dev / you explicitly don't want the real session | **Lane 2** — `ghax attach --launch` (scratch profile). |
| Bridge verb errors "not supported over the extension bridge yet" | That verb needs browser-context (viewport/responsive, qa, perf, gestures, the `ext` family). Switch to Lane 2 (`--launch`) for it. |
| Bridge connected but `goto`/commands return "Cannot attach to this target" | The controlled tab landed on a privileged page (`chrome://`, `edge://`, cert-error/`chrome-error://` interstitial) — `chrome.debugger` can't attach there. `goto` self-recovers via `chrome.tabs.update`; if stuck, `ghax bridge control --active` after navigating the tab to a normal page. |
| A scratch (`--user-data-dir`) Edge is the only Edge running and the user says extensions/sign-ins "vanished" | Dock-icon hijack, **not** data loss — check `ps aux | grep -i "Microsoft Edge" \| grep user-data-dir`; make sure their normal (no-flags) Edge is also running. |
| `attach --extension` exits with `BRIDGE_AMBIGUOUS` | More than one browser (or profile) has the bridge extension loaded and nothing said which to drive. Re-run with `--browser edge\|chrome\|<label>`, or keep the daemon and `ghax bridge use <id\|browser\|label>`. Never pick one at random: ask the user which browser if it isn't obvious. |
| Several browsers must be driven from one daemon (compare two profiles, copy between them) | `ghax attach --extension --browser all`. `ghax tabs` then lists every bound browser (`#1..N`; a silent browser appears as a `note:` row), `ghax tab '#n'` in another browser switches the active browser and clears refs, and `console`/`network` cover the active tab only (`--tab '#n'\|<id>` for another, `--all` for every tab). `ghax bridge instances` marks the active one. |
| `attach --extension` exits with `BRIDGE_NO_CANDIDATE` | Browsers connected but none matches `--browser` by the end of the attach timeout (attach keeps waiting until then). The error lists what it saw; fix the filter, or wait for the right browser (the daemon keeps running and binds it when it connects). |
| A command says "no daemon here, using the one attached from <dir>" | Expected: this cwd has no daemon, exactly one is registered in `~/.ghax/daemons/`, and ghax used it. If that's the wrong one, set the printed `GHAX_STATE_FILE`. With several running, the error lists each one's `GHAX_STATE_FILE`; set one, don't guess. |

So there are two lanes; pick by what the task needs.

### Lane 1 — the user's real session, via the ghax bridge (v0.5+)

ghax drives the real Edge/Chrome session itself through its own MV3
extension (`extension/`, "ghax bridge"), which relays CDP to a real tab
via `chrome.debugger` — the one API the socket restriction doesn't touch
— over a localhost WebSocket. This is the primary path for real auth,
SSO cookies, and the user's open tabs; it is local (no cloud relay) and
inside the ghax CLI.

```bash
# One-time install: edge://extensions → Developer mode → Load unpacked
#   → <repo>/extension  (persists in the profile; reload after ghax updates)
ghax attach --extension --control-active   # drives the active tab, no popup
ghax snapshot -i                            # then the full verb surface works
ghax bridge control [--active | --tab-id '#n'|<id> | --stop]   # (re)point mid-session
```

**Works over the bridge:** goto/back/forward/reload, eval/text/html,
snapshot (`@e`/`@c` refs), click/fill/press/type, screenshot/box, gestures,
tabs/tab/new-window/new-tab, wait, console/network, batch, cookies (+ `cookies delete <name>`), storage (never paste cookie values or storage output into chat, commits or logs), `auth export --out <file> --domain <d>` (Playwright storageState for headless suites; file is 0600, never printed, must be gitignored if inside a repo; replaces `scripts/save-auth-state.mjs`, which needs CDP). **Not (yet) over the
bridge** — these return a clear "not supported over the extension bridge
yet": viewport/responsive, qa/perf/profile,
and the `ext` family (SW/panel/hot-reload).

Bridge caveats:

- **Reload after updating ghax — no click needed.** The extension's
  service worker caches its own build-info at startup, so after a
  `git pull` + `npm run build` it keeps reporting stale (or no) provenance
  until it reloads. Run `ghax bridge reload` instead of clicking reload in
  `edge://extensions` — it asks the extension to reload itself and waits
  for it to reconnect. `npm run sync-local` runs the whole post-release
  loop (pull, rebuild, install, bridge reload) in one command. A reload
  drops every OTHER agent's `chrome.debugger` attachment on that browser
  too (one shared service worker, not per-agent sockets) — `ghax bridge
  reload` warns and needs `--force` when `ghax tabs` shows another agent's
  bridge port controlling a tab; each agent recovers automatically either
  way, same as an ordinary service-worker eviction.
- **Security (interim).** The bridge WS is localhost-only but currently
  has **no auth token** — while the daemon runs, any local process could
  connect and drive the browser. Acceptable on a single-user machine;
  a handshake token is the next hardening step. Treat
  `ghax attach --extension` as a deliberate foreground act, and prefer
  `bridge control --stop` / `ghax detach` when done.
- **Consent is visible.** Attaching shows Edge's persistent "ghax bridge
  is debugging this browser" banner — expected, not an error.
- **One controlled tab.** The bridge drives the tab you point it at
  (`--control-active` or `bridge control --tab-id`). `tabs` lists them.
- **Tab ids name the browser.** Bridge ids are `<brand>-<profile>:<chrome tab id>`
  (`edge-work:42`; `edge-3f2a1b:42` when the popup has no Profile name), because
  two browsers can both have a tab 42. Pick by `'#n'` from the last `tabs`
  or by full id. A bare `42` is refused when it matches more than one tab:
  read the listing it prints and choose, never guess.
- **Fallback:** if the bridge extension isn't installed and can't be, use
  the Claude-in-Chrome extension (same `chrome.debugger` mechanism, but
  slower cloud relay, outside ghax).

### Lane 2 — a fresh, empty CDP instance (scratch profile)

For clean-room work, extension dev/hot-reload, or when you explicitly do
NOT want the real session:

```bash
ghax attach --launch --browser edge   # scratch profile ~/.ghax/edge-profile
curl -s http://127.0.0.1:9222/json/version | head -3   # verify
```

The scratch profile persists but holds no personal data. `--data-dir
<path>` for a task-specific dir, `--load-extension` to pre-load an
unpacked extension for dev work.

Rules and caveats:

- **Never point CDP at the real profile and never give the daily-driver
  Edge a `--user-data-dir` it didn't have.** The real Edge stays
  flag-free; CDP scratch instances are always separate. (Real-session
  work goes through the bridge in Lane 1, not CDP.)
- **Launching a new CDP instance requires user approval** — it spawns a
  visible second browser. Ask unless told otherwise. (The bridge, by
  contrast, drives the browser they already have.)
- **Dock-icon hijack:** if a custom-data-dir instance is the only Edge
  running, the Dock icon and `open -a "Microsoft Edge"` open windows
  in the *automation* profile — to the user it looks like their
  extensions and sign-ins vanished (2026-07-12 `/tmp/edge-dag`
  incident). It isn't data loss. Check
  `ps aux | grep -i "Microsoft Edge" | grep user-data-dir` and make
  sure their normal (no-flags) Edge is running too.
- Quitting/killing any Edge instance closes its tabs — **ask first**.
- Custom data dirs must never live in `/tmp` (wiped on reboot).

## Command cheat sheet

```bash
# Connect — CDP (scratch profile)
ghax attach                              # reuses running browser on :9222
ghax attach --launch --browser edge      # launches a scratch-profile Edge
ghax attach --launch --load-extension ./my-ext --data-dir /tmp/dev-profile
                                         # launch with an unpacked extension
                                         # pre-loaded into an isolated profile
ghax status                              # tabs, targets, ext count
ghax detach                              # clean daemon shutdown

# Connect — bridge (the user's REAL session, via the ghax bridge extension)
ghax attach --extension --control-active # drive the active real tab, no popup
ghax attach --extension                  # connect only; then pick a tab:
ghax bridge control --active             #   control the current active tab
ghax bridge control --tab-id '#2'        #   control row 2 of the last `tabs`
ghax bridge control --stop               #   release the tab (banner clears)
ghax attach --extension --bridge-port N  # non-default WS port (default 9223)
ghax bridge reload                       # reload the extension, no edge://extensions click
ghax bridge reload --force               # also proceed if another agent has a tab claimed

# Tab work
ghax tabs                                # #n  id  "title"  Browser · Profile · win N  [active]  controlledBy=you|<name>|none
ghax tabs --json                         # + index, chromeTabId, browser, profile, window, windowId; controlledBy is {port,pid,name,cwd,self}|null
                                         # `active` = the window's foreground tab (not "my tab"); mine is controlledBy=you
ghax tab '#2'                            # row 2 of the last `tabs` (refused if it closed)
ghax tab edge-work:42                    # full id: <brand>-<profile>:<chrome tab id> on the bridge
ghax tab 42                              # only if exactly one tab has id 42, else refused
ghax tab '#2' --focus                    # also raise it (default: background, no focus)
ghax new-tab https://example.com         # background tab in the current window, now yours
ghax goto https://example.com
ghax text                                # clean page text
ghax html [<selector>]                   # innerHTML

# Snapshot + interact (the @ref workflow)
ghax snapshot -i                         # interactive-only a11y tree with @e refs
ghax snapshot -i -a -o /tmp/shot.png     # same, plus annotated screenshot
ghax snapshot -i -s '#main'              # narrow when the output ends "… N more refs omitted"
ghax snapshot -i --no-cap                # or lift the 250-ref / 32 KB default budget
ghax snapshot -i --grep 'Save|Cancel' --context 2   # only matching lines + ancestors + 2 after (before the cap; refs still resolve)
ghax screenshot --path-only              # prints just the file path
ghax eval '<js>' --timeout 120000        # raise the bridge's 30 s eval deadline
ghax eval '<js>' --no-wait               # fire-and-forget on a 0 ms timer; errors -> ghax console
ghax click @e3                           # click by ref (refuses covered/disabled targets)
ghax click @e3 --force                   # skip the actionability checks
ghax fill @e5 "hello"                    # React-safe input fill
ghax press Enter

# Extension work (the unique-to-ghax bit)
ghax ext list                            # all installed extensions
ghax ext sw <ext-id> eval "chrome.runtime.getManifest().version"
ghax ext storage <ext-id> local get      # dump chrome.storage.local
ghax ext storage <ext-id> local set myKey '{"a":1}'
ghax ext panel <ext-id> eval "document.title"

# Extension hot-reload — THE flagship for extension devs
ghax ext hot-reload <ext-id>             # reload SW + re-inject content scripts
ghax ext hot-reload <ext-id> --verbose   # per-tab injection report

# Real user gestures (for APIs that require them)
ghax gesture click 100,200               # real Input.dispatchMouseEvent
ghax gesture dblclick 100,200
ghax gesture scroll down 400             # mouseWheel event at viewport center
ghax gesture scroll down 400 --on @e7    # aim the wheel at an element (inner panel); works over the bridge too
ghax gesture key Enter

# Orchestrated QA pass
ghax qa --crawl https://example.com --depth 1 --out /tmp/qa.json

# Profiling (Performance.getMetrics + optional heap)
ghax profile --duration 5 --heap
ghax profile --extension <ext-id>

# Live tail (Server-Sent Events — Ctrl-C to stop)
ghax console --follow
ghax network --follow
ghax ext sw <ext-id> logs --follow

# Extra extension surfaces
ghax ext popup <ext-id> eval "document.title"
ghax ext options <ext-id> eval "chrome.storage.local.get()"
ghax ext message <ext-id> '{"type":"ping"}'

# Dev workflow helpers
ghax ship --message "fix foo"        # typecheck + build + commit + push + PR
ghax review                           # Claude-ready review prompt on stdout
ghax canary https://prod.example.com --interval 60 --fail-fast
ghax diff-state /tmp/before.json /tmp/after.json
ghax pair status                      # SSH-tunnel instructions

# Logs
ghax console --errors --last 50
ghax network --pattern 'api/tickets'

# Assertions + page storage
ghax is visible @e3                       # exit 0 if visible, 1 if not
ghax is enabled "button[type=submit]"
ghax storage local keys
ghax storage local get auth_token
ghax storage session set flash "hi"

# Responsive + diff
ghax viewport 375x667
ghax responsive /tmp/shot                # mobile + tablet + desktop
ghax diff https://prod.example.com https://staging.example.com

# Check a flow with no model in the loop (exit 1 on the first failed expect)
ghax expect --url 'dashboard' --timeout 3000
ghax expect --visible @e7
ghax batch '[{"cmd":"goto","args":["https://app.example.com"]},{"cmd":"expect","opts":{"title":"Sign in"}}]' --report /tmp/run.json

# Batch + record
echo '[{"cmd":"goto","args":["https://example.com"]},{"cmd":"snapshot","opts":{"interactive":true}}]' | ghax chain
ghax record start my-session
# ... do stuff ...
ghax record stop
ghax replay .ghax/recordings/my-session.json
ghax gif .ghax/recordings/my-session.json /tmp/run.gif
```

Add `--json` to any command for machine-parseable output.

## Critical recipes

### After `pnpm build` on an extension, push the new code without losing tabs

```bash
ghax ext hot-reload <ext-id>
```

This is the whole reason `ghax ext hot-reload` exists. Plain
`ghax ext reload` fires `chrome.runtime.reload()` — correct, but orphans
every content script already injected in open tabs (the DOM is still
there but the SW messaging port is dead). Hot-reload reads the manifest,
reloads, waits for the SW to restart, then re-injects each declared
`content_scripts` entry (JS + CSS, respecting `all_frames`) into every
matching tab. User's tabs + sidepanel + scroll position stay intact.

### Several sessions in one browser

Every session gets its own daemon and its own tab; nobody takes focus.

```bash
export GHAX_STATE_FILE=/tmp/ghax-mysession.json   # never share a state file
ghax attach --extension --browser edge --name mysession   # --name shows in others' `tabs`
ghax tabs                                # pick by '#n'; read controlledBy first, never take a tab that is not `none`
ghax new-tab https://target.example      # background tab, now yours, window not raised
# ... work; `active` rows are the user's foreground tabs, leave them alone ...
ghax detach
```

### Click by intent, not by selector

1. `ghax snapshot -i -a -o /tmp/shot.png` — get a11y tree with @refs and
   a visual overlay to confirm you're looking at the right element.
2. Decide which `@e<n>` you want.
3. `ghax click @e<n>` — the daemon resolves the ref against the last
   snapshot's locator map.

An element keeps its ref across re-snapshots of the same page (both
transports), so numbers are stable but sparse (`snapshot -i` may start at
`@e4`; never assume `@e1`). After a route change or when a dialog opens,
re-snapshot. A ref whose element is gone fails with "not found in the
latest snapshot": re-snapshot and pick again.

### Debug a Chrome extension's service worker live

```bash
# Does the SW think the token is valid?
ghax ext sw <ext-id> eval "await fetch('/me', {headers:{Authorization:'Bearer '+(await chrome.storage.local.get('token')).token}}).then(r=>r.status)"

# Clear a specific storage key
ghax ext storage <ext-id> local set someKey null
```

### Run a check as one batch with expects

When a flow is known, don't read every page to see whether it worked. Put the
checks in the plan; ghax runs it with no model in the loop and stops at the
first thing that is wrong.

```bash
ghax batch '[
  {"cmd":"goto","args":["https://app.example.com/login"]},
  {"cmd":"expect","opts":{"visible":"#email"}},
  {"cmd":"fill","args":["#email","qa@example.com"]},
  {"cmd":"fill","args":["#password","'"$QA_PASSWORD"'"]},
  {"cmd":"click","args":["button[type=submit]"]},
  {"cmd":"expect","opts":{"url":"/dashboard$","timeout":8000}},
  {"cmd":"expect","opts":{"text":"Welcome back","selector":"h1"}},
  {"cmd":"expect","opts":{"count":"table tbody tr","min":1}}
]' --report /tmp/login-check.json
echo $?   # 0 = every check held, 1 = an expect failed, 4 = a step errored or an expect could not run (EXPECT_ERROR)
```

- Checks: `url`/`title` (regex), `text` (substring, optional `selector`),
  `visible`/`hidden` (`@ref` or selector), `count` (`n` or `min`/`max`),
  `value` (+ `expected`), `eval` (truthy JS). Each polls until `timeout` ms
  (default 5000); `timeout: 0` looks once.
- On failure, read the failing step: `{step, expect, expected, actual,
  elapsedMs}`. Act on that and `/tmp/login-check.json`; only open a snapshot
  if `actual` doesn't explain it.
- The same steps work in `chain` and in a `replay` file, so a recording can be
  edited to carry its checks.

### Verify a deploy by diffing text against staging

```bash
ghax diff https://staging.example.com https://prod.example.com
```

## Shadow DOM

`ghax snapshot -i` (or `-C`) walks open shadow roots and emits `@c<n>`
refs with Playwright chain selectors (`host >> inner`). Click works
transparently: `ghax click @c3` resolves through both DOM trees.

Closed shadow roots are deliberately skipped — the DOM itself forbids
walking them and no automation tool can force entry.

## Gotchas

- **`fill`** uses a native value setter + `input`/`change` dispatch,
  because plain `page.fill()` trips controlled-input bugs in React. Prefer
  `ghax fill` over `ghax type` for form inputs.
- **Side-panel eval** requires the panel to be open. If closed,
  `ghax gesture click <x,y>` on the extension icon first.
- **`chrome.storage.local get`** returns JWT / OAuth tokens in plaintext.
  Don't pipe to shared chat / docs — treat like `localStorage.getItem`.
- **`hot-reload`** with `--wait` default 5s is fine for most extensions;
  bump it to 10+ on heavy SWs (large WASM modules, big codebases).
- Side panel URLs are usually `chrome-extension://<id>/sidepanel.html`
  but not always — check `ghax ext targets <ext-id>` if `ghax ext panel`
  can't find one.

## Exit codes

- `0` — success
- `1` — usage error, or an `expect` that did not hold (stdout has the result)
- `4` also covers an `expect` that could not run (`EXPECT_ERROR`: bridge disconnect, hung probe)
- `2` — not attached (run `ghax attach` first)
- `3` — target not found (wrong ext-id, wrong tab id)
- `4` — CDP error
- `5` — service worker didn't return after hot-reload (bump `--wait`)
- `6` — re-inject failed on some tabs (details in `--verbose` output)
- `10` — daemon failed to start

Typed errors print `ghax: <message>` then `hint: <next step>` on stderr
(exit 4). The ones worth branching on:

- `BRIDGE_REF_STALE` — the element behind `@eN` is gone (re-render or
  navigation). Re-snapshot and use a fresh ref.
- `BRIDGE_TARGET_NOT_ACTIONABLE` — `click`/`fill`/`upload` refused before
  acting. The message says why: `covered by <tag#id.class "text">` (a
  banner or overlay is on top; dismiss it or click that instead),
  `disabled` (native, `fieldset[disabled]`, or inherited `aria-disabled`),
  `inert`, `readonly` (fill), `hidden`/`offscreen`. `--force` skips the
  checks. Raised on both transports; the CDP path only pre-checks inherited
  `aria-disabled` and `inert` (Playwright handles the rest itself).

## Design principles (inherited from gstack, which is no longer installed; adapted)

1. **Real over sandbox.** Attach to what the dev already has.
2. **Daemon over one-shot.** Persistent background server, ~60-200ms
   per-command overhead.
3. **Compiled single binary.**
4. **`@ref`-driven snapshots.** LLMs click `@e3`, not fragile CSS.
5. **Zero-config happy path.** `ghax attach` figures it out.
6. **MIT licensed, open source.**

## Full reference

`ghax --help` prints the command surface.
[Source](https://github.com/kepptic/ghax) — see
`design/plan/03-commands.md` for the full planned surface and
`design/plan/04-roadmap.md` for what's shipped (`ghax ship`, `ghax qa`,
`ghax review`, `ghax canary`, `ghax profile`, `ghax pair` are all live;
roadmap tracks what's next).
