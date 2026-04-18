---
name: ghax-browse
description: Drive the user's real running Chrome or Edge via CDP — tabs, accessibility-tree snapshots with @ref clicks, MV3 extension internals (service workers, sidepanels, chrome.storage, hot-reload), real user gestures. Use when the user asks to QA a site, verify a deploy, test an extension they wrote, or interact with a SaaS dashboard that's already logged in. Triggers — "attach to my browser", "test the extension", "hot-reload", "click in edge", "snapshot the dashboard", "run this in the service worker", "read chrome.storage", and after `pnpm build` finishes on any extension target. Do NOT use for headless one-off testing — use gstack browse or playwright-cli for that.
---

# Skill: ghax browse

Attach to the user's real Chrome or Edge via CDP and drive it. Unlike
sandboxed browsers (gstack browse, playwright-cli), ghax reaches the
user's actual session — real auth, real extensions, real SSO cookies — and
exposes MV3 internals that no other tool surfaces cleanly.

## When to reach for ghax

- The user says **"attach"**, **"use my browser"**, **"real edge"**, or
  points at a SaaS dashboard that's already logged in.
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

- Quick one-off headless testing → use **gstack browse** (`$B`).
- Programmatic test suites, tracing, video → **playwright-cli**.
- The user doesn't have Edge/Chrome running with CDP enabled and doesn't
  want to relaunch → fall back to gstack browse with a saved-cookies
  import.

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

If nothing responds, either:
- Ask the user to relaunch: `/Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge --remote-debugging-port=9222 &`
- Or run `ghax attach --launch --browser edge` to use a scratch profile
  (loses the user's cookies; only good for clean-room tests).

## Command cheat sheet

```bash
# Connect
ghax attach                              # reuses running browser on :9222
ghax attach --launch --browser edge      # launches a scratch-profile Edge
ghax attach --launch --load-extension ./my-ext --data-dir /tmp/dev-profile
                                         # launch with an unpacked extension
                                         # pre-loaded into an isolated profile
ghax status                              # tabs, targets, ext count
ghax detach                              # clean daemon shutdown

# Tab work
ghax tabs                                # list {id, title, url, active}
ghax tab <id>                            # switch active tab
ghax goto https://example.com
ghax text                                # clean page text
ghax html [<selector>]                   # innerHTML

# Snapshot + interact (the @ref workflow)
ghax snapshot -i                         # interactive-only a11y tree with @e refs
ghax snapshot -i -a -o /tmp/shot.png     # same, plus annotated screenshot
ghax click @e3                           # click by ref
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

### Click by intent, not by selector

1. `ghax snapshot -i -a -o /tmp/shot.png` — get a11y tree with @refs and
   a visual overlay to confirm you're looking at the right element.
2. Decide which `@e<n>` you want.
3. `ghax click @e<n>` — the daemon resolves the ref against the last
   snapshot's locator map.

Refs survive until the next snapshot call; if the DOM changes underneath
you (route change, dialog opens), re-snapshot.

### Debug a Chrome extension's service worker live

```bash
# Does the SW think the token is valid?
ghax ext sw <ext-id> eval "await fetch('/me', {headers:{Authorization:'Bearer '+(await chrome.storage.local.get('token')).token}}).then(r=>r.status)"

# Clear a specific storage key
ghax ext storage <ext-id> local set someKey null
```

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
- `1` — usage error
- `2` — not attached (run `ghax attach` first)
- `3` — target not found (wrong ext-id, wrong tab id)
- `4` — CDP error
- `5` — service worker didn't return after hot-reload (bump `--wait`)
- `6` — re-inject failed on some tabs (details in `--verbose` output)
- `10` — daemon failed to start

## Full reference

`ghax --help` prints the command surface.
[Source](https://github.com/kepptic/ghax) — see
`design/plan/03-commands.md` for the full planned surface and
`design/plan/04-roadmap.md` for what's shipped.
