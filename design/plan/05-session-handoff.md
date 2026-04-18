# ghax — session handoff (2026-04-18, roadmap complete)

Start here when you pick this back up in a new session.

## Where we are

Every roadmap item not explicitly paused (public release) or deferred
(multi-tenant pair auth, skill-eval harness) is shipped.

- v0.1 — flagship `ghax browse` ✓
- v0.2 — QA ergonomics ✓
- v0.3 — hot-reload, shadow-DOM, gif, Claude Code skills, CI ✓
- v1.0 — internal hardening (smoke tests, hot-reload verification) ✓
- v0.4 — orchestrated layer (`qa`, `profile`, `diff-state`, `ship`,
  `canary`, `review`, `pair`) + SSE tail mode + spec gaps closed ✓

**34/34 smoke checks** pass in ~7s against a live Edge session.

## The full shipped surface

Every command in `design/plan/03-commands.md` is now live. Plus new
commands that weren't in the original spec:

| Command | What it does |
|---------|--------------|
| `ghax attach [--port N] [--browser edge\|chrome] [--launch] [--load-extension <path>] [--data-dir <path>]` | Connect to running browser or launch a scratch-profile one with an optional unpacked extension. |
| `ghax status / detach / restart` | Daemon lifecycle. |
| `ghax tabs / tab / goto / back / forward / reload / eval / text / html / cookies / wait` | Tab navigation + read. |
| `ghax snapshot [-i] [-c] [-d N] [-s <sel>] [-C] [-a] [-o <path>]` | a11y-tree + `@e<n>` refs + cursor-interactive + shadow-DOM + optional annotated PNG. |
| `ghax click / fill / press / type` | Interact by ref or selector. `fill` is React-safe (native setter + input event). |
| `ghax screenshot [<@ref\|selector>] [--path p] [--fullPage]` | Viewport, element, or full-page. |
| `ghax viewport <WxH>` / `ghax responsive [prefix]` | Resize + mobile/tablet/desktop triple-shot. |
| `ghax diff <url1> <url2>` | Text diff between two URLs. |
| `ghax is <visible\|hidden\|enabled\|disabled\|checked\|editable> <target>` | Assertion. Exit 0 on truthy. |
| `ghax storage [local\|session] [get\|set\|remove\|clear\|keys] [key] [value]` | Page-level localStorage / sessionStorage. |
| `ghax console [--errors] [--last N] [--follow]` / `ghax network [--pattern re] [--last N] [--follow]` | Rolling 5k buffer + SSE tail. |
| `ghax chain` / `ghax record start\|stop\|status` / `ghax replay <file>` / `ghax gif <recording> [out.gif]` | Batch + record + render. |
| `ghax ext list / targets / reload / hot-reload / sw eval / sw logs [--follow] / panel eval / popup eval / options eval / storage / message` | The MV3 surface. |
| `ghax gesture click / dblclick / scroll / key` | Real CDP input dispatch. |
| `ghax qa [--url <u> ...] [--urls a,b] [--crawl <root> [--depth N] [--limit N]] [--out report.json] [--screenshots <dir>] [--annotate] [--gif <out.gif>]` | Orchestrated QA pass with auto URL discovery. |
| `ghax profile [--duration sec] [--heap] [--extension <ext-id>]` | Performance metrics + optional heap snapshot. |
| `ghax diff-state <before.json> <after.json>` | Structural JSON diff. |
| `ghax ship [--message "..."] [--no-check] [--no-build] [--no-pr] [--dry-run]` | Typecheck + build + commit + push + PR. |
| `ghax canary <url> [--interval 60] [--max 3600] [--out r.json] [--fail-fast]` | Periodic prod health poller. |
| `ghax review [--base origin/main] [--diff]` | Claude-ready review prompt (stdout only). |
| `ghax pair [status]` | SSH-tunnel setup instructions (token auth deferred). |

All commands accept `--json` for machine-readable output.

## Architecture

```
ghax CLI (Bun-compiled single binary, 61 MB)
        │  HTTP RPC + SSE to 127.0.0.1:<random>
        ▼
ghax daemon (Node ESM bundle, ~61 KB, externalises Playwright)
        │  ├─ Playwright (chromium.connectOverCDP) — tab-level
        │  ├─ Raw CDP WebSocket pool — service workers, panels, gestures
        │  ├─ CircularBuffer<ConsoleEntry>, CircularBuffer<NetworkEntry>
        │  ├─ SSE listeners (console, network, per-ext SW logs)
        │  ├─ Ref map from last snapshot (for @e<n> resolution)
        │  ├─ Optional recording buffer (ghax record)
        │  └─ Per-extension SW log subscription (Runtime.consoleAPICalled)
        ▼
User's running Chrome / Edge (--remote-debugging-port=9222)
```

Why split CLI (Bun) and daemon (Node)? Playwright's `connectOverCDP`
hangs under Bun 1.3.x. Node runs it reliably. Compile takes ~140ms for
the CLI, ~20ms for the daemon bundle.

## What's next (v0.5+)

Two items were deliberately skipped this session because they need
their own focused sessions:

1. **Multi-tenant `ghax pair`.** Real bearer-token auth on the daemon
   + URL allowlist + scoped bind interface. The v0 shipped here just
   prints SSH-tunnel instructions. A proper token mode changes the
   daemon security surface — any RPC handler bug becomes remotely
   exploitable, so this gets a careful pass of its own.

2. **Skill acceptance eval harness.** Scripts Claude prompts against
   `/kepptic-ghax-browse` and asserts tool-call expectations. Needs
   Anthropic API integration + eval framework.

Everything else on `04-roadmap.md` is shipped. The "paused" items
(public release, npm publish, docs site, announce) remain paused per
the user's explicit decision.

## How to resume

```bash
cd /Users/gr/Documents/DevOps/kepptic/products/open-source/ghax
# 1. Confirm Edge is on CDP :9222 (or use --launch)
curl -s http://127.0.0.1:9222/json/version | head -5
# 2. Build
bun install && bun run build
# 3. Run smoke tests (requires live browser)
bun run test:smoke             # 34/34 checks, ~7s
bun run test/hot-reload-smoke.ts  # scripted hot-reload verification
# 4. Drive
./dist/ghax attach
./dist/ghax --help
```

## How to invoke ghax from Claude Code

Skills auto-registered via devops-skill-registry under the `kepptic`
namespace:

- `/kepptic-ghax-browse` — flagship skill with full recipe catalog
- `/kepptic-ghax` — top-level router

## Recent commits

- `5533bca` — Initial commit — ghax v0.1
- `037899d` — v0.2 — QA ergonomics
- `5f93acf` — docs(plan): mark v0.1 + v0.2 shipped
- `277cadf` — v0.3 — hot-reload, shadow-DOM, gif, skills, CI
- `ccacb05` — docs(plan): mark v0.3 shipped
- `b6834ce` — docs(plan): pause open-source track
- `e41ab7d` — test: smoke harness + MV3 fixture; doc cleanup
- `0498259` — v0.4 kickoff: ghax qa, scripted hot-reload, shadow-DOM fix
- `a7ebcfc` — spec gaps from 03-commands.md + qa --crawl
- (this session) — v0.4 complete: profile, SSE follow mode, ext popup/options, ext sw logs, diff-state, ship, canary, review, pair
