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
- [x] `test/smoke.ts` — live-browser harness. Runs locally only (CI has
      no browser); original scaffold at commit `e41ab7d`, extended to
      cover the full v0.4 surface + `ghax try` + attach ergonomics +
      background-window workflow + debugging tier 1 + shell/disconnect
      quality-of-life + source-map resolution + tier 3 finishers
      (xpath, box, capture-bodies) — 70/70 checks in ~34s.
- [x] `test/fixtures/test-extension/` — minimal MV3 fixture for
      hot-reload verification.
- [x] `ghax attach --launch --load-extension <path>` — scripted
      fixture loading without browser-UI steps.
- [x] `test/hot-reload-smoke.ts` — fully scripted hot-reload probe:
      launch scratch browser → load fixture → confirm SW → hot-reload
      → assert SW version bumps + content-script banner re-injects.
- [x] Shadow-DOM smoke check in `test/smoke.ts`.
- [x] v0.4 surface E2E coverage — back/forward/reload, press/type/fill,
      wait, `--help`, review (prompt + `--diff`), pair, qa (`--url` +
      `--crawl`), canary (1-2 cycles), ship (`--dry-run`), ext
      panel/options/message, gif (conditional on ffmpeg). +16 checks,
      closes the gap between v0.4 shipping and test coverage.
- [ ] Skill acceptance eval harness — deferred indefinitely. At current
      scale (solo maintainer, 2 skills, daily dogfooding), E2E coverage
      catches the same regressions without Anthropic API cost or TOS
      grey area. Revisit if skill count grows or repo flips public.

### Before public release — satisfaction gate

We won't publish until we're satisfied with what users download and
how they install it. Current blockers:

- [ ] **Rust CLI rewrite.** The 61MB Bun binary is the last
      distribution concern. A Rust CLI drops to ~10MB per platform,
      cold start to ~2-5ms, and gives us the standard `cargo-dist` +
      Homebrew + npm distribution story. Full plan:
      [`06-rust-cli-rewrite.md`](./06-rust-cli-rewrite.md). Scope: CLI
      only; daemon stays Node/Playwright. Estimated ~3-4 active dev
      days.
- [ ] Docs site — `ghax.dev` or GitHub Pages
- [ ] `@ghax/cli` npm publish + Homebrew tap
- [ ] v1.0 tag + announce (HN, X, dev.to)

### Deliberately not planned

- [ ] Flip repo public before satisfaction — we're not publishing
      something we're not proud of. Public comes after the Rust CLI
      lands and distribution works cleanly.

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
- [x] `ghax profile [--duration N] [--heap] [--extension <id>]` — CDP
      `Performance.getMetrics` snapshot for active tab or extension
      SW, optional heap dump, writes `.ghax/profiles/<ts>.json`.

### Unimplemented items from `03-commands.md` — all shipped

Re-read the original command surface doc; every item is now
implemented:

- [x] `ghax ext list` → `version`, `name`, `enabled` fields
- [x] `ghax storage [local|session] [get|set|remove|clear|keys] [key] [value]`
- [x] `ghax is <visible|hidden|enabled|disabled|checked|editable> <@ref|selector>`
- [x] `ghax ext message <ext-id> <json>` — sendMessage wrapper
- [x] `ghax gesture dblclick <x,y>` + `ghax gesture scroll <dir> [amount]`
- [x] `ghax console --follow` / `ghax network --follow` — SSE streaming
      (daemon `/sse/console`, `/sse/network`)
- [x] `ghax ext sw <id> logs [--follow]` — dedicated SW console buffer,
      auto-resubscribes after hot-reload
- [x] `ghax ext popup <id>` + `ghax ext options <id>` — shared
      eval-in-extension-page helper matches popup.html / options.html
- [x] `ghax diff-state <before.json> <after.json>` — RFC-6901-style
      JSON diff; added / removed / changed tags

## Future tools — shipped 2026-04-18

- [x] `ghax ship` — opinionated commit + push + PR workflow
      (typecheck + build gate, `--dry-run`, skippable stages)
- [x] `ghax review` — Claude-ready review prompt wrapping the diff;
      stdout only (pipe to `claude`)
- [x] `ghax canary <url>` — periodic prod health check; rolling log in
      `.ghax/canary-<host>.log`, structured JSON report on exit
- [x] `ghax pair` — v0 SSH-tunnel instructions (multi-tenant token-auth
      deferred to v0.5)
- [x] Tier 3 debugging finishers — XPath surface, bounding box,
      response-body capture.

      `ghax xpath <expression> [--limit N]` — query matches from the
      page's DOM with text preview + tag + box per hit. XPath already
      worked in selector args (via Playwright's `xpath=...` prefix);
      this is the dedicated *enumeration* form for previewing before
      acting.

      `ghax box <@ref|selector>` — returns `{x, y, width, height}`.
      Works on snapshot refs (`@e3`, `@c1`) and any selector form.

      `ghax attach --capture-bodies[=<glob>]` — opt-in response-body
      capture. Pattern is glob-ish (`*` → any): `--capture-bodies`
      alone captures everything JSON/text-like, `--capture-bodies='*/api/*'`
      only matching URLs. 32KB per-body cap with truncation marker.
      Daemon reads the pattern from `GHAX_CAPTURE_BODIES` env; zero
      runtime cost when the flag isn't passed. Captured bodies
      automatically flow into HAR export for Charles / devtools /
      WebPageTest consumption.

      Smoke 67 → 70 (xpath match shape, box on selector, box on
      ref). Cross-browser: Edge 70/70, Chrome 70/70.
- [x] `ghax console --source-maps` — source-map resolution for
      bundled stack frames. New `src/source-maps.ts` holds a
      `SourceMapCache` on the daemon ctx; per-frame resolution fetches
      the script, reads its sourceMappingURL (inline data URI or
      external file), parses the map, and returns the original
      position while preserving the bundled one as `{bundledUrl,
      bundledLine, bundledCol}`. Silent fallback on every failure mode
      (unreachable script, no map, parse error, out-of-range). Adds
      ~60KB to the daemon bundle; zero cost when the flag isn't
      passed. Verified end-to-end with a local fixture:
      `main.abc123.js:1:43` → `src/AuthForm.ts:2:5`.
- [x] `ghax shell` + disconnect recovery — quality-of-life tier.

      `ghax shell` — interactive REPL. Reads commands from stdin, tokenises
      them the same way a shell would (quoted strings, escapes), re-enters
      the main dispatch. One process for the whole session, so the
      per-command Bun spawn cost disappears. Measured: 10 commands in 1.38s
      (138ms/cmd) vs 2.47s across separate invocations (247ms/cmd) — 1.8x
      faster for multi-turn agent sessions, just by not re-spawning. Works
      both interactively (TTY, prompt, history) and as a scripted pipe.

      Disconnect recovery — daemon listens for `browser.on('disconnected')`
      (fires when the user closes their browser, or a scratch browser
      crashes). When it fires, the daemon self-shuts cleanly, clearing the
      state file. Next `ghax attach` starts fresh. CLI-side error handler
      catches "browser has been closed" / "Target page has been closed"
      messages and prints "browser has disconnected — run `ghax attach` to
      reconnect" instead of a raw Playwright stack trace.

      Smoke 64 → 66 (shell mode execution, shell tokenising with quoted
      CSS + measure). Edge 66/66 in 30.8s, Chrome 66/66 in 29.5s.
- [x] Debugging depth pass — tier 1. Closed the real-world "why is this
      slow / why did it break / what's actually going over the wire" gaps
      that dropped out of the initial audit.

      `ghax perf [--wait <ms>]` — Core Web Vitals (LCP, FCP, CLS, TTFB)
      plus navigation timing breakdown (DNS, TCP, TLS, TTFB, response,
      DOMInteractive, DOMContentLoaded, load) and long-task count. LCP /
      CLS / longtask entries are pulled via a buffered PerformanceObserver
      (the default timeline doesn't surface them). Example.com has no
      eligible LCP element so `lcp: null`; richer pages return real
      numbers (garryslist.org LCP = 500ms, the hero image).

      `ghax console [--dedup]` — groups repeated entries by (level, text),
      returning `[{level, text, count, firstAt, lastAt, url, source, stack}]`
      sorted by count desc. Turns "500 identical errors scrolling the
      terminal" into "1 entry with count=500". Captured-side: `pageerror`
      events now include a parsed `stack: [{fn, url, line, col}]` via a
      new V8 stack-trace parser in `buffers.ts`.

      `ghax network` enhancements:
        - `--status 4xx | 500 | 400-499` family/exact/range filter
        - request and response headers captured on every entry
        - `--har <path>` exports HAR 1.2 suitable for Charles,
          har-analyzer, WebPageTest

      Network bodies are still not captured (memory cost too high for a
      default rolling buffer). Source-map resolution, CPU flame graphs,
      and long-task detail are tier 2/3 and not planned for now.

      Smoke grew 59 → 64 (perf shape, dedup grouping, status filter, HAR
      export, stack parsing). Edge + Chrome both pass the full suite.
- [x] Threshold-enforced perf budget test (`test/perf-bench.ts` /
      `bun run test:perf`). Asserts P50 budgets on 13 critical ops +
      shell-mode fast path + cold workflow. FAILS on regression.

      Physical floor confirmed via measurement:
        Bun CLI cold spawn:      ~37ms (via `ghax --help`)
        HTTP RPC + dispatch:     ~5-10ms on top
        Single-cmd floor:        ~27-30ms (what every `ghax <cmd>` pays)
        Shell-mode floor:        ~4.4ms/cmd (no spawn, 6.1x compression)
        Cold workflow (7 cmds):  ~1.5s

      No innovation tokens needed — the stack is at its physical floor
      and still faster than every competitor (playwright-cli 476ms/cmd,
      agent-browser 178ms/cmd, gstack-browse 56ms/cmd). Shell mode is
      the innovation; already shipped.

      Budgets calibrated at measured steady-state + 30% margin. Asserts
      on P50 (catches real regression), prints P90/P95/max (shows tail
      behavior, not asserted — CDP WebSocket occasionally stalls
      200-500ms for one call, unactionable).
- [x] Headless CLI benchmark (`test/benchmark.ts` / `bun run test:benchmark`).
      Compares ghax against gstack browse, playwright-cli, and agent-browser
      on a 6-step workflow (launch → goto → text → js → screenshot →
      snapshot → close) against example.com. Claude in Chrome excluded —
      extension + per-turn API round-trip puts it in a different class
      (~5-10s/action).

      First baseline run (mac, 2026-04-19):

      Cold (end-to-end, launch+ops+teardown, median 3 runs):
        ghax            2004ms
        agent-browser   2008ms
        playwright-cli  3854ms
        gstack-browse   6405ms  (5s of that = gstack's `stop` quirk)

      Warm (session reused, 5-cmd loop × 3, per-command):
        gstack-browse    56ms/cmd
        ghax             65ms/cmd
        agent-browser   178ms/cmd
        playwright-cli  476ms/cmd

      Key finding: ghax and gstack-browse are in the same perf tier for
      steady-state agent work. playwright-cli has ~7x the per-invocation
      overhead — each CLI call re-attaches to its saved state. agent-browser
      is 3x slower per command. Projected 50-op session: ghax 3.2s,
      gstack 2.8s, agent-browser 9s, playwright-cli 24s, Claude in Chrome
      4-8 minutes.
- [x] Cross-browser smoke harness (`test/cross-browser.ts` / `bun run
      test:cross-browser`). Iterates every Chromium-family browser
      detectBrowsers() finds, launches each headless in a disposable
      scratch profile, runs the full 59-check smoke against it, tabulates.
      Arc is filtered out (no CDP support in its stock binary).
      First run (2026-04-19): Edge 59/59 in 21.7s, Chrome 59/59 in 21.0s.
      Confirms the abstraction is fully browser-agnostic within the
      Chromium family — zero browser-specific workarounds needed so far.
- [x] Background-window workflow — `find` / `new-window` / `tab --quiet`
      for the "user keeps browsing while agent works" case. Each agent
      gets its own window (same browser, same profile, so auth + extensions
      carry over) opened via `Target.createTarget({ newWindow: true,
      background: true })`. Zero focus steal, zero collision with the
      user's tabs. Multi-agent parallelism comes free via `GHAX_STATE_FILE`
      — each agent points at its own daemon state file, locks onto its
      own window, can't see the others. `new-window` auto-locks the new
      tab as the daemon's active tab so the caller doesn't need a separate
      `tab` step.
- [x] `ghax attach` ergonomics — auto-port fallback, headless launch,
      multi-CDP scan with picker. Changes:
      - No `--port` + no `--launch`: scan :9222-9230, attach to the one
        found. If multiple, show a numbered picker (non-TTY → first +
        warn). `--browser <kind>` filters the scan.
      - No `--port` + `--launch`: reuse-first (attach if a CDP of the
        requested kind is already up), else pick first free port in
        range. Prints "port 9222 in use — using :9223" on fallback.
      - `--headless` flag: adds `--headless=new` to the spawned browser.
        Only with `--launch` (scratch profile). Real-profile headless is
        explicitly NOT supported — user combines `--data-dir <path>`
        with the browser closed if they know what they're doing.
      - Clearer error when `--browser chrome` is asked for but only
        Edge is running ("only edge on :9222 running; pass --launch to
        start chrome").
- [x] `ghax try` — live-injection fix-preview verb. Composable wrapper
      over `page.evaluate` + `page.screenshot`. Surface:

      ```bash
      # JS form — wraps in IIFE, supports `return` at top level.
      ghax try 'wrapper.style.width = "max-content"; return wrapper.offsetWidth'

      # CSS form — appends a <style class="ghax-try"> tag to document.head.
      ghax try --css '.wrapper { width: max-content }'

      # Compose: apply + measure + shot in one call.
      ghax try --css '.wrapper { width: max-content }' \
               --measure 'document.querySelector(".wrapper").offsetWidth' \
               --shot /tmp/try.png

      # --selector binds document.querySelector(sel) as `el` in the IIFE.
      ghax try --selector '.wrapper' 'el.style.width = "max-content"'
      ```

      Output is JSON: `{ value, shot?: string }`. Revert semantics are
      trivial — reload the page; mutations that write to `localStorage`,
      `chrome.storage`, cookies, or the server are explicitly out of
      scope (user clears those manually).

      Motivation: during Setsail's data-table header bug (2026-04-18) the
      loop `ghax eval "wrapper.style.width = 'max-content'"` + `ghax
      screenshot` + visual confirm → only then edit source — turned a
      30-minute speculative source edit into a 2-minute verified fix.

## v0.5 — outstanding

- [ ] Multi-tenant `ghax pair` — bearer-token auth on the daemon, URL
      allowlist per token, bind to a scoped interface (Tailscale ts0 or
      0.0.0.0 with explicit opt-in). Defers because any bug on the RPC
      surface is remotely exploitable. **Not planned for solo use —
      v0 SSH-tunnel path covers the "me on another machine" case.**

(No other v0.5 work currently planned.)

## Known bugs

### BUG-001 · daemon bundle imports `playwright` but doesn't ship it — `ghax attach` fails on a fresh install — ✓ FIXED 2026-04-20 (ghax 0.4.2)

**Status:** Fixed in v0.4.2 via auto-bootstrap. The Rust CLI now detects the
`ERR_MODULE_NOT_FOUND` from the spawned daemon, runs `npm install` in the
daemon's parent dir (writing a minimal `package.json` first), and retries the
spawn — once. Transparent to the user; first attach is ~10s slower than
subsequent attaches (the npm install step). Three layers of fix landed:

1. **Auto-bootstrap in `attach.rs`** (`spawn_daemon_with_retry` +
   `bootstrap_daemon_runtime`) — primary fix, no manual user step.
2. **Daemon stderr surfacing** (`wait_for_daemon` + `daemon_failure`) — when
   the daemon crashes for any other reason, the user sees the actual stderr
   instead of "didn't become healthy, check log file that doesn't exist."
3. **`scripts/install-link.sh`** — bootstraps the same way for in-repo
   `bun run install-link` users, so dev installs don't need a first-attach
   to trigger the bootstrap.

Original bug report below for posterity.

---

**Reported:** 2026-04-19 · from Setsail `/qa` session (ISSUE-002 in the Setsail QA report that day).
**Severity:** blocker on fresh installs (prevents any `ghax attach` from succeeding).
**Affects:** `ghax 0.4.1-rc.3`. CLI (Rust, `~/.cargo/bin/ghax`) + daemon bundle at `/Users/gr/.local/share/ghax/ghax-daemon.mjs`. Probably affects every release since the Rust CLI rewrite landed.

**Repro**

```bash
# Edge already running with --remote-debugging-port=9222
export GHAX_DAEMON_BUNDLE=/Users/gr/.local/share/ghax/ghax-daemon.mjs
ghax attach
# → ghax: Daemon did not become healthy within 15s. Check .ghax/ghax-daemon.log.
```

No log file is written (`~/.ghax/ghax-daemon.log` doesn't exist after the failure — the daemon dies too early to open its logger).

Running the bundle directly surfaces the actual error:

```bash
$ node /Users/gr/.local/share/ghax/ghax-daemon.mjs
node:internal/modules/package_json_reader:255
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);

Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright'
  imported from /Users/gr/.local/share/ghax/ghax-daemon.mjs
```

**Root cause**

Line 2 of the compiled bundle: `import { chromium } from "playwright";`. The bundle is 2291 lines of inlined source + that one unresolved import. `/Users/gr/.local/share/ghax/` contains ONLY `ghax-daemon.mjs` — no `node_modules/`, no `package.json`. Node's ESM resolver looks for `playwright` in that dir's `node_modules` → parent dirs → fails.

Playwright is installed globally on this machine (`/Users/gr/.nvm/versions/node/v24.3.0/lib/node_modules/playwright/`), but Node ESM imports don't honour `NODE_PATH` for bare-specifier resolution the way CJS does, so a globally-installed playwright is not discoverable from an ad-hoc `.mjs` file dropped outside a package.

**Why the CLI doesn't give a useful error**

`ghax attach` spawns the daemon and waits 15s for a health check. When Node exits with the ERR_MODULE_NOT_FOUND before the daemon opens its log file, the CLI only sees "didn't become healthy" and points at a log file that was never created. The real stderr from the daemon child is discarded.

**Suggested fixes** (in priority order)

1. **Bundle playwright into the daemon mjs.** The daemon bundler should NOT mark `playwright` as external. Including playwright's JS (not the browsers — those are a separate install step) adds ~8-10MB to the bundle but makes the daemon self-contained and matches how the Rust CLI binary is shipped (single compiled binary, zero runtime deps). This is the cleanest fix and matches the "standalone install" promise the roadmap already makes for the CLI. Playwright browsers still need a one-time `npx playwright install chromium` for scratch-profile mode (`--launch`), but CDP-only `ghax attach` against an already-running Edge/Chrome should work without it.

2. **If bundling is rejected** (e.g. bundle size concern), ship an install script that creates `~/.local/share/ghax/package.json` + runs `npm i playwright` into a sibling `node_modules/`. Document it in the README as a postinstall step. Make the installer the distribution unit, not a raw .mjs file.

3. **In any case, plumb the daemon's stderr back through the CLI's failure path.** When the daemon exits with a non-zero code before the health port opens, the Rust CLI should print the child's stderr instead of the generic "did not become healthy" message. A proper error text would save every future debugger ~15 minutes of triage. The current behaviour also breaks the "check `.ghax/ghax-daemon.log`" advice, because the log file was never created.

**Workaround today (users who hit this)**

Install playwright into a node_modules beside the daemon:

```bash
cd ~/.local/share/ghax
echo '{"type":"module","dependencies":{"playwright":"*"}}' > package.json
npm i
# then retry ghax attach
```

This is ugly — users shouldn't have to know about ESM resolution quirks to run a CLI.

**Downstream impact**

On the reporter's machine (Setsail QA, 2026-04-19), `ghax attach` not working meant falling back to gstack browse CDP mode, which launched a new Chromium instead of reusing the existing authenticated Edge session — defeating the whole purpose of ghax. The user's stated memory preference ("Default to ghax for browser QA — skip the gstack-browse login dance") assumes `ghax attach` works on fresh installs. It doesn't.
