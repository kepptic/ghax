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

- A `chrome.alarms` keepalive (the `"alarms"` permission) resurrects an
  evicted worker and reconnects within one alarm period (~30s).
- While connected it sends `{type:"ping"}` every ~15s; the daemon replies
  `{type:"pong"}`. Active traffic extends the worker's lifetime.
- The controlled tab id is persisted in `chrome.storage.local`, so a
  respawned worker re-attaches to it, and the daemon re-asserts the desired
  control target on every reconnect. Net effect: leave it idle, come back,
    and page commands still work — no user action needed.

## How it fits together

```
ghax CLI (Rust)  --HTTP RPC-->  ghax daemon (Node)  --WebSocket-->  this extension  --chrome.debugger-->  your real tab
                                  (src/bridge.ts)         :9223         (background.js)
```

- The daemon opens a WebSocket server on `127.0.0.1:9223` (override via
  `GHAX_BRIDGE_PORT`, or set `bridgePort` in this extension's
  `chrome.storage.local` if you need a different port on the extension
  side too).
- The extension's background service worker connects to it, sends
  `{"type":"hello",...}`, then relays every `{id, method, params}` message
  as a `chrome.debugger.sendCommand` call against whichever tab the popup
  told it to control, replying `{id, result}` / `{id, error}`. CDP events
  (e.g. `Page.loadEventFired`) are relayed back as `{"type":"event",...}`.
- Only one extension connection is accepted at a time — reloading the
  extension (or opening the popup and clicking Control this tab again)
  replaces the old one; the daemon logs the replacement.

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
