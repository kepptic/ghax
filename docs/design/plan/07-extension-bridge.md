# ghax — extension bridge (real-session control after the CDP block)

Session capture, 2026-07-13. Why ghax is growing a browser extension,
what it does, and how the transport is wired.

## The problem this solves

ghax's founding premise — "attach to the user's **real** running Chrome
or Edge via CDP" — was quietly invalidated by an upstream Chromium
security change:

- **Chrome 136** (Apr 2025) and **Edge 150** (shipped 150.0.4078.65 on
  2026-07-09) implement Chromium's remote-debugging hardening.
  `--remote-debugging-port` (and `--remote-debugging-pipe`) are
  **silently ignored** unless `--user-data-dir` points at a
  **non-default** directory.
- Verified empirically 2026-07-12 on Edge 150.0.4078.65: launch the real
  profile with the flag → no `DevToolsActivePort` file, nothing listens
  on the port, no error printed. Confirmed three ways (scripted quit,
  forced kill, cold flag-first launch) and a positive counter-test (the
  same flag works instantly with a non-default `--user-data-dir`).
- **No escape hatch.** The `RemoteDebuggingAllowed` policy can only
  further *disable* debugging, never re-enable it on the default
  profile. The `DevToolsDebuggingRestrictions` feature flag was removed.
  The gate is a path comparison in
  `chrome/browser/devtools/remote_debugging_server.cc`
  (`IsRemoteDebuggingAllowed(is_default_user_data_dir, ...)`), so even
  passing `--user-data-dir=<the real default path>` is refused — only a
  genuinely different directory passes. The only demonstrated bypass in
  the wild is patching that function and building Chromium from source.
- **Profile cloning doesn't rescue it.** A non-default data dir uses a
  different encryption key (App-Bound Encryption, per-directory). A
  byte-for-byte copy of the real profile keeps extensions, favorites,
  history, and settings, but every cookie and saved password is
  undecryptable in the copy (verified 2026-07-12).

Rationale, per the [Chrome blog](https://developer.chrome.com/blog/remote-debugging-port):
after App-Bound Encryption shipped, cookie-theft malware pivoted to
launching the user's own browser with `--remote-debugging-port` and
draining sessions over CDP. Blocking debugging on the default profile
closes that door; per-directory keys close the copy-the-profile hole.

Net effect for ghax: `chromium.connectOverCDP(cdpHttpUrl)` — the
daemon's one and only way to reach the browser — **can no longer touch
the user's real session.** It still works against a fresh
`ghax attach --launch` scratch profile (that's a non-default dir), but
that instance has none of the user's auth, extensions, or open tabs.

## The two lanes (interim, shipped in docs 2026-07-13)

1. **Real session** → drive it through a browser extension. Extensions
   use the `chrome.debugger` API, which lives *inside* the profile and
   is unaffected by the socket restriction. Claude-in-Chrome already
   proves the model works; it's just slow (every action round-trips
   through Anthropic's cloud relay + MCP).
2. **CDP automation** (a11y snapshots, extension hot-reload dev loops,
   perf, network capture, QA crawls) → `ghax attach --launch` a fresh,
   user-approved, empty instance. Existing Playwright path, unchanged.

The extension bridge below is how we make lane 1 a *first-class,
local, fast* ghax capability instead of an external tool.

## Why an extension, and why it fits ghax cleanly

The daemon already contains a raw CDP client (`src/cdp-client.ts`): one
WebSocket per target, `{id, method, params}` request → `{id, result |
error}` response, plus a `{method, params}` event stream. That is the
**exact** shape of `chrome.debugger.sendCommand(target, method, params)`
and `chrome.debugger.onEvent`. So the extension isn't a rewrite of the
automation engine — it's a **new transport** under machinery the daemon
already has. CDP commands that used to travel daemon → WebSocket → port
now travel daemon → WebSocket → extension → `chrome.debugger` → real tab.

```
┌────────────┐  HTTP RPC  ┌─────────────┐  WS :9223  ┌──────────────────┐
│  Rust CLI  │ ─────────► │   daemon    │ ◄────────► │  ghax bridge ext │
│  ghax ...  │            │  (bridge)   │  CDP relay │  (MV3, in real   │
└────────────┘            └─────────────┘            │   Edge/Chrome)   │
                                                     │  chrome.debugger │
                                                     │      ▼           │
                                                     │  user's real tab │
                                                     └──────────────────┘
```

The extension can only make **outbound** connections (MV3 can't host a
server socket), so the daemon is the WS **server** and the extension is
the **client**. That's why Playwright can't be reused for bridge mode —
`connectOverCDP` wants to *be* the connecting client against a
browser-level CDP server, and `chrome.debugger` is page-scoped with no
browser endpoint to emulate cheaply. Bridge mode therefore drives raw
CDP through `bridge.send()` directly, the same way `cdp-client.ts`
already does for service workers and gestures.

## Speed vs. Claude-in-Chrome

Claude-in-Chrome: action → Anthropic cloud → extension → browser, every
hop. ghax bridge: action → localhost WebSocket → extension → browser.
No cloud, no MCP framing, no per-call model round-trip. The transport is
a single local WS carrying CDP frames — structurally the fastest
real-session path available, and it stays inside the ghax CLI/skill
ergonomics the team already uses.

## Security posture

The bridge deliberately re-creates the capability Chromium locked down —
so the guardrails matter:

- **Consent is the install + activation.** The user installs an unpacked
  extension they can read, and `chrome.debugger.attach` triggers Chrome's
  persistent "ghax bridge is debugging this browser" banner. No silent
  attach.
- **Localhost only.** The bridge WS binds `127.0.0.1`. (Follow-up: a
  handshake token written to `.ghax/` so a random local process can't
  drive the bridge — the same threat model as any local daemon.)
- **Scoped attach.** The extension attaches to the tab the user picks in
  the popup, not blanket auto-attach to every tab.

## Prototype scope (walking skeleton, 2026-07-13) — verified live

First cut proves the round-trip and the transport is robust, not full
command parity:

- `extension/` — MV3, zero-dependency, load-unpacked. Background SW
  relays CDP over WS; popup picks the controlled tab and shows status.
- `src/bridge.ts` — daemon-side WS server on `127.0.0.1:9223`
  (`GHAX_BRIDGE_PORT` override), `send(method, params)` + event stream.
- Three verbs wired through the bridge: `goto` (`Page.navigate`),
  `eval` (`Runtime.evaluate`), `text` (`document.body.innerText`).
- `ghax attach --extension [--control-active]` — starts the daemon in
  bridge mode, waits for the extension, and (with `--control-active`)
  drives the browser's active tab immediately — no popup click needed.
  `ghax bridge control [--active | --tab-id N | --stop]` re-points later.

**Transport hardening (found and fixed during live verification):**

- **MV3 SW eviction.** The first cut had no keepalive: the background
  worker idled out, the WS dropped, and it never recovered. Fixed with a
  `chrome.alarms` keepalive (30s, wakes an evicted worker — a bare
  `setInterval` can't) plus a 15s app-level WS ping. The daemon remembers
  the desired control target and re-asserts it on every reconnect, so
  control survives an eviction with no user action.
- **Scriptable activation.** Control state is module-scoped in the SW, so
  nothing external could activate it — the popup click was the only path,
  which is a dealbreaker for a CLI. Fixed with a daemon→extension control
  channel (`{type:"control", action:"control-active"|"control-tab"|"stop"}`)
  distinct from CDP relay, driving the same attach path the popup uses.

Verified end-to-end against a real scratch Edge 150 (2026-07-13):
`attach --control-active` auto-drove the active tab; `goto`/`eval`/`text`
returned correct results; after a 60s idle the connection held and
commands still worked.

**Top remaining hardening item:** no handshake token yet — any local
process can reach the localhost bridge and drive the browser. Acceptable
for an experimental single-user prototype; needs a token (written to
`.ghax/`, checked at `hello`) before it's a daily default.

## Path to full parity (not yet built)

- Map the rest of the browse surface onto `bridge.send`: `snapshot -i`
  (inject the existing a11y-walker JS via `Runtime.evaluate`, or
  `Accessibility.getFullAXTree`), `click`/`fill`/`press` (`Input.*` +
  the React-safe setter), `screenshot` (`Page.captureScreenshot`),
  `console`/`network` (`Log`/`Network` domains via relayed events).
- Multi-tab / tab-switch semantics over the bridge (attach per tab; keep
  the ref-map-clears-on-tab-switch invariant from `CLAUDE.md`).
- Handshake token + reconnect hardening.
- Packaging: signed `.crx` / store listing vs. keep unpacked for the
  team. Decide once parity lands.

## Alternatives considered and rejected

| Option | Why not |
|--------|---------|
| Cookie import into an automation profile (rookiepy-style keychain read) | Solves auth, not "control my real browser" — no live session/tabs, cookies go stale, device-bound SSO won't transfer. Useful someday for seeding a scratch profile, not the primary answer. |
| Chrome for Testing | Exempt from the block, but it's a separate build with no real session. |
| Chrome DevTools MCP (official) | Same CDP limitation (still needs a debugging endpoint it can't get on the real profile) and MCP round-trip overhead — no faster than Claude-in-Chrome. |
| Patch + build Chromium from source | The only true socket bypass, but unshippable to a normal user. |
