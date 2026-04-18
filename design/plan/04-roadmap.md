# ghax — roadmap

## v0.1 — minimum useful (flagship `ghax browse`) ✓ shipped 2026-04-18

Target: I can run the same extension QA I did on Beam in `ghax` commands
instead of hand-written Python.

- [x] Repo scaffold (Bun, tsconfig, package.json, bin wrapper) — `@ghax/cli`
- [x] `ghax attach` — probes CDP on :9222, optional `--launch` scratch profile
- [x] `ghax status` / `ghax detach` / `ghax restart`
- [x] Daemon HTTP server — started as `Bun.serve`, switched to Node's `http`
      because Playwright's `connectOverCDP` hangs under Bun
- [x] `.ghax/ghax.json` state file discovery (git root fallback)
- [x] Raw CDP client: WebSocket pool, target discovery via `/json/list`
- [x] `ghax tabs` / `ghax tab <id>` / `ghax goto` / `back` / `forward` / `reload`
- [x] `ghax snapshot -i` (aria tree + `@e<n>` refs + cursor-interactive pass)
- [x] `ghax click` / `ghax fill` (React-safe native setter) / `ghax press` /
      `ghax type` / `ghax eval` / `ghax wait`
- [x] `ghax screenshot` (viewport, element, or full-page)
- [x] `ghax text` / `ghax html` / `ghax cookies`
- [x] `ghax console [--errors] [--last N]` / `ghax network [--pattern] [--last]`
- [x] `ghax ext list` / `ghax ext targets` / `ghax ext reload`
- [x] `ghax ext sw <id> eval <js>`
- [x] `ghax ext panel <id> eval <js>`
- [x] `ghax ext storage <id> [local|session|sync] [get|set|clear]`
- [x] `ghax gesture click <x,y>` + `ghax gesture key <key>` via CDP Input.*
- [x] `--json` flag on every command
- [x] `bun build --compile` single binary for the CLI, Node ESM bundle for daemon
- [x] README with quickstart
- [x] Dogfood against the Beam Chrome extension (`hligjpiaogkblpkobldladoohgknedge`)
      — verified SW eval, storage dump, interactive snapshot on dashboard

### Decisions taken during v0.1

| Decision | Why |
|----------|-----|
| Standalone private GitHub repo (`kepptic/ghax`) from day 1 | Cleaner than submodule, no retroactive extraction |
| Edge as the default target | Matches the user's daily driver |
| `@ghax/cli` scoped npm name | Both `ghax` and `@ghax/cli` were free; scoped is safer long-term |
| CLI (Bun) + Daemon (Node) split | Bun+Playwright hangs; Node runs connectOverCDP reliably |
| Scratch profile in `~/.ghax/<kind>-profile/` for `--launch` | Real-profile copy is fragile (cookie keychain) — deferred to v0.2+ |
| SVG overlay for annotated screenshots | No re-layout risk on React pages |

## v0.2 — QA ergonomics ✓ shipped 2026-04-18

- [x] `ghax snapshot -a` annotated screenshot (SVG rects + @refs)
- [x] `ghax viewport <WxH>` + `ghax responsive [prefix]`
- [x] `ghax diff <url1> <url2>` — naive line-based text diff
- [x] `ghax chain` JSON batch mode from stdin
- [x] `ghax record start / stop / status` + `ghax replay <file>`
      (writes `.ghax/recordings/<name>.json`)
- [x] CircularBuffer console/network buffers (5k each)
- [x] `ghax gif <recording> [out.gif]` — ffmpeg wrapper (2-pass palette)
- [x] Shadow-DOM aware clicking (cursor-interactive walks open shadow
      roots, emits `host >> inner` Playwright chain selectors)

## v0.3 — Claude Code skills + MV3 hot-reload ✓ shipped 2026-04-18

- [x] `.claude/skills/ghax-browse.md` — invocable as `/kepptic-ghax-browse`
- [x] `.claude/skills/ghax.md` — top-level router skill
      (`/kepptic-ghax`)
- [x] Auto-registered via `devops-skill-registry` under the `kepptic`
      namespace root
- [x] `ghax ext hot-reload` (see spec below) — shipped as part of v0.3
- [ ] Skill acceptance eval — pointable at Beam / Setsail dashboards
      (deferred — needs a dedicated eval session)

### New command: `ghax ext hot-reload <ext-id>` (MV3 seamless reload) ✓ shipped

**Why**: `ghax ext reload` today just calls `chrome.runtime.reload()`. That's
correct but kills the service worker AND orphans every content script already
running in open tabs — the tabs still show the DOM injected by the old script,
but the messaging port to the new SW is dead, so clicks / pings / storage
watchers silently fail. The user has to F5 every tab or close/reopen the
sidepanel to get things working again.

The flagship use case is "I just `pnpm build`'d the extension, push the new
code to my running Edge without disrupting the tabs I'm in." Hot-reload does
the full dance: reload SW, wait for restart, re-inject the content scripts
(same `files` list the manifest declares) into every tab whose URL matches the
declared `matches` patterns. User sees the new code running within ~5s with
their tabs, sidepanel, and scroll position intact.

**Exact spec** (copy-paste for whoever builds this):

```
ghax ext hot-reload <ext-id> [--wait <seconds>] [--no-inject] [--verbose]

Arguments:
  <ext-id>           extension id (as seen in `ghax ext list`)

Options:
  --wait <seconds>   how long to wait for the SW to restart after reload.
                     default: 5. increase on slower machines or large SWs.
  --no-inject        skip the content-script re-injection step — just reload
                     the extension. use this when the extension has no
                     content scripts, or when you specifically want to see
                     the orphaned-script state for debugging.
  --verbose          print each injection attempt per tab.

Exit codes:
  0  — SW reload confirmed, content scripts re-injected (or --no-inject)
  3  — extension id not found
  4  — CDP error talking to browser
  5  — SW didn't come back within --wait seconds
  6  — re-inject failed on >0 tabs (still exit 0 if all succeeded)
```

**Implementation steps** in `daemon.ts`:

1. Resolve `<ext-id>` against current `/json/list` — 404 (exit 3) if not found.
2. Connect to the SW target (`type=service_worker`, url contains `<ext-id>`).
3. Read the manifest via `chrome.runtime.getManifest()` BEFORE reloading.
   Remember `content_scripts[].js` file lists and `content_scripts[].matches`
   URL patterns (and optional `css` files).
4. Fire `chrome.runtime.reload()` via `Runtime.evaluate` without awaiting the
   promise — the SW disconnects us before it resolves. Catch the inevitable
   WebSocket close.
5. `sleep(wait * 1000)`.
6. Re-discover the SW target via `/json/list`. Retry every 500ms up to
   `wait * 2` seconds total. If still not present → exit 5.
7. For each entry in the remembered `content_scripts`:
   - `chrome.tabs.query({ url: matches })` to get matching tabs.
   - For each tab id, fire
     `chrome.scripting.executeScript({ target: { tabId }, files: js })`
     — catch-and-continue per tab (some tabs may be about:blank, crashed,
     or the content script may already be running — MV3 treats re-injection
     as idempotent for the `files` form).
   - If the manifest has `content_scripts[].css`, also fire
     `chrome.scripting.insertCSS({ target: { tabId }, files: css })`.
   - Count successes / failures.
8. If `--no-inject`: skip step 7.
9. Print a one-line summary: `re-injected into N of M tabs, SW version=<ver>`.
   `--json` flag returns `{ ok: true, tabs: [{id, status}], swVersion, durationMs }`.

**Reference implementation** (what this session did by hand, works today):

```python
# Reload
await ws.send({'method':'Runtime.evaluate','params':{
  'expression':'chrome.runtime.reload()'
}})
# (SW disconnects us — expected)
await sleep(5)

# Re-inject (fire-and-forget to avoid CDP awaitPromise hang)
await ws.send({'method':'Runtime.evaluate','params':{
  'expression':
    "chrome.tabs.query({url:'*://*.autotask.net/Mvc/ServiceDesk/*'})"
    ".then(ts=>Promise.all(ts.map(t=>"
    "chrome.scripting.executeScript({target:{tabId:t.id},"
    "files:['content-scripts/autotask-bubble.js']}).catch(e=>e.message)"
    ".then(()=>chrome.scripting.executeScript({target:{tabId:t.id},"
    "files:['content-scripts/autotask.js']}).catch(e=>e.message)))))",
  'returnByValue':true
}})
```

That's the exact pattern we used against the Beam extension in this session —
works reliably, no user interaction needed. The `ghax ext hot-reload` wrapper
reads the manifest instead of hardcoding file paths, so it works for any
extension.

**Also add to `ghax ext reload`**: print a deprecation hint if the extension
has `content_scripts` declared — "run `ghax ext hot-reload <id>` instead to
also refresh injected content scripts."

**Skill wiring** (in `.claude/skills/ghax-browse.md`): list `ghax ext
hot-reload` under "after modifying a Chrome extension" with the one-line
recipe `ghax ext hot-reload <id>`. Claude will reach for it the moment it
sees `pnpm --filter ... build` complete on an extension target.

## v1.0 — internal hardening (open source release paused)

Current stance (2026-04-18): **repo stays private under `kepptic`**, **no
npm publish**. Everything below is internal-use hardening; the public
release track is on hold.

- [x] CONTRIBUTING, CHANGELOG, CODE_OF_CONDUCT
- [x] GitHub Actions CI (typecheck + compile matrix for mac/linux/win)
- [x] `test/smoke.ts` — 24-check harness against a live browser. Runs
      locally only (CI has no browser); commit `e41ab7d`.
- [x] `test/fixtures/test-extension/` — minimal MV3 fixture for
      hot-reload verification.
- [x] `ghax attach --launch --load-extension <path>` — scripted
      fixture loading without browser-UI steps.
- [x] `test/hot-reload-smoke.ts` — fully scripted hot-reload probe:
      launch scratch browser → load fixture → confirm SW → hot-reload
      → assert SW version bumps + content-script banner re-injects.
- [x] Shadow-DOM smoke check in `test/smoke.ts` (25/25 checks pass).
- [ ] Skill acceptance eval harness (v0.3 carryover — needs Claude API
      integration, scoped for its own session).

### Paused (revisit when ready to open-source)

- [ ] Flip repo to public
- [ ] `bunx ghax` zero-install (`npm publish @ghax/cli`)
- [ ] Docs site — `ghax.dev` or GitHub Pages
- [ ] v1.0 tag + announce (HN, X, dev.to)

## v0.4 — beyond the browse primitive (in progress)

Flagship `ghax browse` is now solid. v0.4 starts layering orchestrated
tools on top of it. The MVP layout: each tool is a new top-level verb
that composes existing daemon handlers.

- [x] `ghax qa` — orchestrated QA pass. Flow: attach → goto each URL →
      `snapshot -i` → capture console errors + HTTP >=400 responses →
      emit `qa-report.json`. Flags: `--url` (repeatable), `--urls`
      (comma form), positional URLs, or JSON on stdin. `--out`,
      `--screenshots`, `--annotate`, `--gif`. First iteration — no
      smart nav inference (user provides URL list).
- [x] `ghax qa --crawl <root> [--depth N] [--limit N]` — sitemap.xml
      first, falls back to same-origin link scraping.
- [ ] `ghax profile [--duration N]` — perf / memory snapshot of the
      active tab or an extension target. Uses CDP `Performance.*` +
      `HeapProfiler.takeHeapSnapshot`. Writes `.ghax/profiles/<ts>.json`.

### Unimplemented items from `03-commands.md` (fill-in pass)

Re-read the original command surface doc: several items from the v1
design were never implemented. Grouped by leverage:

High leverage (shipped):

- [x] `ghax ext list` → `version`, `name`, `enabled` fields
- [x] `ghax storage [local|session] [get|set|remove|clear|keys] [key] [value]`
- [x] `ghax is <visible|hidden|enabled|disabled|checked|editable> <@ref|selector>`
- [x] `ghax ext message <ext-id> <json>` — sendMessage wrapper
- [x] `ghax gesture dblclick <x,y>` + `ghax gesture scroll <dir> [amount]`

Medium leverage:

- [ ] `ghax console --follow` / `ghax network --follow` — streaming
      tail mode (SSE or chunked HTTP from the daemon)
- [ ] `ghax ext sw <id> logs [--follow]` — dedicated SW console tail
- [ ] `ghax ext popup <id>` + `ghax ext options <id>` — interact with
      popup and options pages (mirrors `ghax ext panel`)

Lower leverage:

- [ ] `ghax diff-state <before> <after>` — diff two snapshots
      (storage, console, etc.). `chain` + `eval` already covers most
      of this use case.

## Future tools (no timeline)

- `ghax ship` — opinionated ship workflow (commit + push + PR + deploy hook)
- `ghax review` — PR review against the diff
- `ghax canary` — attach + watch prod for regressions after deploy
- `ghax pair` — share browser access with another agent (like gstack pair)
