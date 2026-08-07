# ghax bridge extension

Since Edge 150 / Chrome 136, `--remote-debugging-port` is silently ignored
on the browser's **default profile** — Playwright's `chromium.connectOverCDP`
(how the ghax daemon normally attaches) can no longer reach your real,
already-logged-in session. `chrome.debugger` is not subject to that
restriction, so this MV3 extension relays CDP commands from the ghax daemon
to your real tab through it.

The bridge covers the normal page-driving surface: tabs/windows, navigation,
HTML/text/eval, accessibility snapshots and `@ref` interactions, screenshots,
keyboard input, waits, console, and network capture. Commands that require a
browser-level CDP endpoint, including the `ext` family, return an explicit
"not supported over the extension bridge yet" error.

## Load it (unpacked)

1. Open `edge://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `extension/` directory.
4. Pin the "ghax bridge" icon to the toolbar if you want quick access.

## Use it

1. In a terminal: `ghax attach --extension`. It starts the daemon in bridge
   mode and waits (prints instructions + polls) for the extension to
   connect. Add `--control-active` to skip the popup entirely — the daemon
   drives the browser's **active tab** as soon as the extension connects.
2. If you did NOT pass `--control-active`: click the **ghax bridge** toolbar
   icon, then **Control this tab** on whichever real tab you want ghax to
   drive. (You can also re-point it any time with
   `ghax bridge control --active | --tab-id <n> | --stop`.)
3. Chrome/Edge will show a **persistent "\<extension\> is debugging this
   browser"** banner at the top of that tab. This is expected and is the
   point — it's the browser's built-in, always-visible consent indicator
   for anything using `chrome.debugger`. It disappears when you click
   **Stop** in the popup, run `ghax bridge control --stop`, close the tab,
   or close the browser.
4. Run normal page commands from another terminal. Start with
   `ghax snapshot -i`, then use its refs with commands such as
   `ghax click @e3` and `ghax fill @e7 'value'`.

### Staying connected (MV3 service-worker eviction)

MV3 service workers are evicted after ~30s idle. The bridge keeps itself
alive and self-healing so you don't have to babysit it:

- Two `chrome.alarms` keepalives (the `"alarms"` permission), phase-offset
  by 15s, resurrect an evicted worker. Chrome clamps repeating alarms to a
  30s floor, so a single alarm left a 30s worst-case gap; two halve it.
- While connected it sends `{type:"ping"}` every ~15s; the daemon replies
  `{type:"pong"}`. Active traffic extends the worker's lifetime.
- Each connection's controlled tab id is persisted in `chrome.storage.local`
  (`controlledTabs`, keyed by daemon port and stamped with the daemon's id),
  so a respawned worker re-attaches to them, and each daemon re-asserts its
  desired control target on every reconnect. A port is a pool slot, so an
  entry stamped with a *different* daemon id is discarded rather than
  restored — the next agent to bind that port never inherits the previous
  agent's tab.
- If the worker dies mid-session, the daemon holds the session open for a
  **grace window** (20s) rather than failing outright: commands issued during
  the gap queue and run on reconnect. Read-only commands interrupted in
  flight are replayed; anything that could have mutated the page reports
  "the action MAY have landed — verify with `ghax snapshot`" instead of
  risking a double-submit.

Net effect: leave it idle, come back, and page commands still work — no user
action needed.

## How it fits together

```
ghax CLI (Rust)  --HTTP RPC-->  ghax daemon (Node)  --WebSocket-->  this extension  --chrome.debugger-->  your real tab
                                  (src/bridge.ts)      :9223-9232       (background.js)
```

- The daemon opens a WebSocket server on the first free port from
  `127.0.0.1:9223` up to `:9232` (base overridable via `GHAX_BRIDGE_PORT` /
  `ghax attach --extension --bridge-port`, which pins it exactly instead of
  scanning). This extension dials all ten, so several daemons — one per agent
  — can drive this browser at once. Set `bridgePort` in this extension's
  `chrome.storage.local` (the popup's base-port field) to move the whole
  window.
- The extension's background service worker connects to it and sends
  `{"type":"hello", instanceId, browser, label, ...}`. The daemon answers
  with `{"type":"hello-ack", role}` — see **Multiple browsers** below — and
  only once it's granted the `bound` role does the extension attach
  `chrome.debugger`. It then relays every `{id, method, params}` message as
  a `chrome.debugger.sendCommand` call against the controlled tab, replying
  `{id, result}` / `{id, error}`. CDP events (e.g. `Page.loadEventFired`)
  come back as `{"type":"event",...}`.

## Multiple agents (one browser, one daemon each)

Several agents can drive this browser at the same time, each on its own tab.
Each agent runs its own daemon (its own `GHAX_STATE_FILE`); the daemons take
adjacent ports in the scan window, and this extension holds one connection
and one `chrome.debugger` attachment per daemon.

```bash
GHAX_STATE_FILE=/tmp/ghax-a.json ghax attach --extension --control-active
GHAX_STATE_FILE=/tmp/ghax-b.json ghax attach --extension   # takes :9224
```

The popup shows one row per daemon, each with its own **Control this tab** /
**Stop**. A tab may be driven by exactly one agent: pointing a second one at
it is refused, naming the bridge port to go stop it on. `ghax tabs` reports
`controlledBy` (the owning agent's port, or `null`) so an agent can pick a
free tab up front. Design notes:
`docs/design/plan/09-bridge-multi-agent.md`.

## Multiple browsers (or multiple profiles)

Because MV3 extensions are per-profile, loading this directory in Edge *and*
Chrome — or in two Edge profiles — means several service workers competing
for one daemon. (This is the other axis from multi-agent above: several
browsers per daemon, rather than several daemons per browser.)

The daemon keeps a **registry** rather than one anonymous socket:

- Exactly one instance is **bound** — it drives the tab.
- Every other healthy instance is **parked**: its socket stays open and
  pinging, it stays listed, but it holds no `chrome.debugger` attachment and
  receives no CDP.

Parking is what keeps things quiet. If the daemon closed the losing socket
instead, this extension's reconnect loop would immediately dial back in, and
two installs would evict each other indefinitely.

Each install mints a `instanceId` (a UUID in `chrome.storage.local`) the
first time it runs. `chrome.runtime.id` can't serve here — it's derived from
the unpacked path, so every profile loading this same directory reports an
identical id.

```bash
ghax bridge instances                 # who's connected, who's driving
ghax bridge use chrome                # rebind (by id, browser, or label)
ghax attach --extension --browser edge  # only Edge may bind; others park
```

If `ghax bridge instances` warns that ownership is *flapping*, an
older build of this extension is still loaded in another profile — reload it
there (or disable the copies you don't drive).

## Pairing (optional hardening)

The bridge WebSocket listens on `127.0.0.1` only, but by default any local
process could connect and drive your browser. To require a code:

```bash
ghax attach --extension --pair          # prints an 8-digit code
# → "⚷  Pairing required. In the ghax bridge popup, enter this code: 314159"
```

Open the popup, type the code into the **Pairing code** field, and this
browser connects. A wrong or missing code is rejected and the extension goes
*dormant* (a slow retry every few minutes, not a fast reconnect loop) until
you enter the right one. `--pair <code>` uses a code you choose instead of a
minted one. Leave `--pair` off and nothing changes.

## Bridge-capable commands

- Tabs/windows: `status`, `tabs`, `tab`, `find`, `new-window`.
- Navigation/content: `goto`, `back`, `forward`, `reload`, `eval`, `text`,
  `html`.
- Inspection/interaction: `snapshot` (`-i`, `-C`, selector/depth/compact,
  annotated screenshot), `box`, `screenshot`, `click`, `fill`, `press`,
  `type`, `wait` (milliseconds, visible selector, load, network idle).
- Diagnostics: `console`, `network`, including the existing filters and HAR
  output. Body capture follows the daemon's `--capture-bodies` setting.
- Local orchestration: `batch`, recording state, and `bridge control`.

The extension drives one tab at a time, but `tabs`, `tab <id>`, and
`new-window <url>` can enumerate and move that control. Switching control
invalidates all snapshot refs. The `ext` family and browser-level operations
such as cookies, storage, uploads, profiling, and viewport emulation remain on
the normal CDP-port transport and fail clearly in bridge mode.

Certificate interstitials can temporarily make a tab refuse
`chrome.debugger.attach`. Navigation falls back to `chrome.tabs.update`; the
extension retains the controlled tab and retries attach when it becomes
attachable again (for example after the user proceeds or navigates back).

## Known limits

- One controlled tab at a time; commands are not multiplexed across tabs.
- No fragmented-WebSocket-frame handling on the daemon side (see
  `src/bridge.ts`) — fine for the small JSON messages this bridge sends.
