# ghax — multi-agent extension bridge

Session capture, 2026-08-07. How several agents came to share one real
browser through the bridge, and why the design put the multiplexing in the
extension rather than in the daemon.

Prerequisite reading: [07-extension-bridge.md](./07-extension-bridge.md)
(why the bridge exists at all) and
[08-bridge-reliability.md](./08-bridge-reliability.md) (the reconnect /
arbitration state machine this must not disturb).

## The problem

ghax's multi-agent story on the CDP transport is settled and has been for a
while: each agent exports its own `GHAX_STATE_FILE`, gets its own daemon,
and calls `new-window` to claim a window. CLAUDE.md invariant 2 says it
plainly — one daemon per state file, never two daemons on one.

On the **bridge** transport that story did not work at all, for two
independent reasons.

**1. The extension was a singleton.** `extension/background.js` held one
`ws`, one `bridgeRole`, one `controlledTabId`, one `attached`. Every relayed
CDP command dispatched to `{tabId: controlledTabId}`. So even if a second
daemon somehow got a connection, both sessions' commands landed on the same
tab — the reported symptom was simply "tab id is always the same".

**2. Every bridge daemon demanded port 9223.** `GHAX_BRIDGE_PORT` defaulted
to 9223 and `new Bridge(port)` bound it synchronously. A second agent's
daemon — correctly spawned with its own state file — could not bind, so it
never received an extension connection at all. The `EADDRINUSE` surfaced
only as a logged `bridge: server error` line; the daemon then sat waiting
for a `hello` that could never arrive, and `ghax attach --extension` timed
out after 60s with advice about loading the extension, which was not the
problem.

Note that these are additive failures, not one failure seen twice. Fixing
the port would give agent B a socket that still drove agent A's tab; fixing
the singleton would give two well-separated sessions that could never both
be reached.

## The decision

**One daemon per agent (unchanged). The extension becomes a multiplexer.**

- The extension maintains one `BridgeConnection` per daemon, discovered by
  dialling ports `base .. base+9` (`PORT_RANGE`, mirrored as
  `BRIDGE_PORT_RANGE` in `src/bridge.ts`). Base is still
  `chrome.storage.local.bridgePort`, default 9223.
- Each connection owns everything that used to be a module global: socket,
  socket generation, role, dormancy, backoff, ping timer, controlled tab,
  attachment state, navigation flag.
- A module-level `tabOwners: Map<tabId, BridgeConnection>` registry keeps two
  agents off one tab.
- A daemon whose requested port is busy walks up the same window
  (`Bridge.create`), and the port it actually bound flows into the state
  file's `browserUrl` (`bridge://127.0.0.1:9224`), which is what `ghax
  attach --extension` prints.

### The rejected alternative: one shared multi-session daemon

The obvious-looking alternative is a single bridge daemon holding N logical
sessions, with agents multiplexing over its RPC port instead of each running
their own. It was rejected for three reasons:

1. **It contradicts the established isolation model.** Multi-agent isolation
   in ghax is "own state file → own daemon → own active-tab pointer". A
   shared daemon would make the bridge transport the one place where that
   rule inverts, so every agent recipe would need a bridge-specific variant.
2. **It moves shared mutable state into the hot path.** `Ctx` is
   single-session throughout `daemon.ts` — `activePageId`, `refs`,
   `bridgeRefs`, `bridgeContexts`, `bridgeNetworkRequests`, the console and
   network circular buffers. Making all of it per-session is a far larger,
   far riskier change than adding a connection object in the extension, and
   it puts one process's crash in the path of every agent.
3. **The conflict still has to be solved in the extension.** Tab ownership
   is enforced where `chrome.debugger.attach` is called, because that's the
   only place that knows an attachment already exists. A shared daemon does
   not remove that requirement; it just adds a second place to get it wrong.

The cost of the chosen design is that the extension dials up to ten ports.
A refused localhost connect fails in about a millisecond, and each
connection keeps the existing 500ms→8s backoff, so steady-state cost is
roughly one dial per second for a browser with no daemons at all.

## Wire-protocol deltas

Deliberately almost none — an old extension and a new daemon (or the
reverse) still speak the same language.

| Change | Direction | Notes |
|---|---|---|
| CDP frames (`{id,method,params}` / `{id,result}` / `{id,error}`) | both | **unchanged**. Each connection is a complete, independent instance of the existing protocol. |
| `list-tabs` ack entries gain `controlledBy: <port>\|null` | ext → daemon | New field. `active` keeps its old meaning — "the requesting connection's controlled tab" — so a second agent's tab never reads as active. Absent from pre-v0.3 extensions; the daemon defaults it to `null`. |
| `hello.instanceId` | ext → daemon | **unchanged and deliberately install-wide.** The same browser talks to every daemon, and each daemon keeps its own peer registry, so one id per browser is the truth they each need. |
| Pairing token | ext → daemon | Global, one code for all daemons of one user. Accepted for v1; per-daemon codes would need a per-port field in the popup for no security gain against the localhost threat model. |
| `hello-ack.daemonId` | daemon → ext | New. Identifies the daemon **process**, minted per `Bridge`. The extension keys its persisted control target on it, and hands the tab back when a port's daemon id changes — a port is a pool slot, so the next agent on it is a different agent. |
| `chrome.storage.local.controlledTabId` | — | Replaced by `controlledTabs: {"9223": {daemonId, tabId}}`. The legacy key migrates to the base port on first startup and is then removed; with no daemon id it is never restored. |

## Tab ownership

A connection may attach to a tab only if it is unowned or already owned by
itself. This is not a nicety: `attachTo()` swallows Chrome's "already
attached" error, which is correct for recovering a session the previous
service worker left live, and catastrophic for a tab another agent is
driving — B's attach would silently "succeed" and both agents would
dispatch into one page.

Enforcement points, all of which raise the same message:

```
tab 123 is already controlled by another ghax agent (bridge port 9224) —
pick another tab or run 'ghax bridge control --stop' there
```

- `switchControlTo()` — checked **before** anything is torn down, so a
  refused switch leaves the asking connection exactly where it was.
- `ensureAttached()` — the pre-dispatch path, which covers a tab claimed
  between control and command.
- `control-tab` — checked before the tab is focused, so a doomed request
  doesn't move the user's window first.
- `control-active` — the focused tab may well belong to another agent; it is
  refused the same way rather than stolen.

The daemon surfaces these verbatim (`bridgeError` leaves an unrecognised
message untouched), so `ghax tab <id>`, `ghax bridge control --tab-id`, and
`ghax new-window` all report the conflict as-is.

### Release rules

Ownership is deliberately **sticky across transient failure**. If a
reconnecting agent lost its tab on every service-worker eviction, a rival
would take it mid-session — the exact opposite of what the registry is for.

Released on:

- **Explicit stop** — `stopControl()` (popup Stop, `ghax bridge control
  --stop`).
- **Tab close** — `chrome.tabs.onRemoved`.
- **Dormancy** — the daemon rejected the connection (pairing/protocol). It
  is not coming back this session; holding the tab would strand it, and the
  debugger banner with it.
- **Daemon gone for good** — `DEAD_DIAL_THRESHOLD` (4) consecutive dials
  that never reach OPEN. At the keepalive cadence that's tens of seconds of
  a genuinely absent daemon, not a restart blip.

Not released on: a single socket drop, a service-worker respawn, the grace
window, or a demotion to `parked`.

The *desired* tab id survives every release, but only for the daemon that
asked for it. A returning daemon — same `daemonId` — reclaims its tab if
nobody took it; if someone did, `restorePersistedTab()` declines to steal it
back and the next explicit control action reports the conflict. A *different*
daemon arriving on the same port gets nothing: `applyRole` releases the tab
the moment the id changes, so agent B's first `goto` cannot land on agent A's
page.

## Port allocation

`Bridge.create(base, log, {scan})` binds the first free port in
`base .. base+BRIDGE_PORT_RANGE-1`. It exists as a static async factory
because `new WebSocketServer({port})` binds *asynchronously* — a constructor
can only log a bind failure it has already pretended to survive, which is
precisely how the original `EADDRINUSE` stayed invisible. `listenOn()`
resolves on `listening` and rejects on `error`, so the scan is
deterministic.

`scan: false` is set when the user passed `--bridge-port` explicitly. An
explicit port is a request, not a hint: it binds or it fails with

```
bridge: port 9223 is already in use (another ghax daemon?) —
omit --bridge-port to auto-pick a free one
```

The synchronous `new Bridge(port, ...)` constructor is retained for the
fixed-port case (and the simulators), and now accepts an already-listening
server via `opts.server`, which is how `create` hands over.

## What the operator sees

```bash
# Agent A
GHAX_STATE_FILE=/tmp/ghax-a.json ghax attach --extension --control-active
#   → ghax bridge: extension connected (ghax-ext v0.3.0), controlling tab 42
#     — pid 811, port 51204, bridge port 9223

# Agent B
GHAX_STATE_FILE=/tmp/ghax-b.json ghax attach --extension
#   → Port 9223 was busy (another ghax daemon?) — this one took 9224.
GHAX_STATE_FILE=/tmp/ghax-b.json ghax new-window https://target.example

# Either agent
ghax tabs
#   {"id":"42","title":"…","url":"…","active":true,"controlledBy":9223}
#   {"id":"57","title":"…","url":"…","active":false,"controlledBy":9224}
#   {"id":"12","title":"…","url":"…","active":false,"controlledBy":null}
```

No browser-side configuration: the extension already scans the window that
the daemons allocate from.

## Compatibility

| Extension | Daemon | Behaviour |
|---|---|---|
| new (v0.3+) | new | Full multi-agent. |
| new (v0.3+) | old (single port, 9223) | Works. The base port is just one of the ten scanned; the other nine find nothing and back off. |
| old (≤v0.2.3) | new | Works for ONE agent. The old extension dials only the base port, so it finds the first daemon and drives it exactly as before; `controlledBy` is absent and the daemon reports `null`. A second daemon binds 9224 and waits for a connection that this extension will never make — `ghax attach --extension` times out with its existing "reload the extension" guidance. |
| old | old | Unchanged. |

Reloading the unpacked extension in `edge://extensions` after updating ghax
was already required; it is what moves a profile from the third row to the
first.

## Security note — what the port scan actually exposes

State the capability plainly, because the token is the lesser half of it.

**Pairing authenticates the extension to the daemon. Nothing authenticates
the daemon to the extension.** So a local process that accepts a socket on a
scanned port and replies `{"type":"hello-ack","role":"bound"}` is treated as
a daemon: it can then send `control-active` and relay arbitrary CDP —
`Runtime.evaluate`, `Network.getAllCookies` — against whatever tab the user
is looking at, in their live authenticated session. It never needs the
pairing code. The code only matters for the *other* direction: impersonating
the browser to a genuinely paired daemon.

What the scan changes is the cost. Before, a rogue process had to **win a
race for 9223** against the daemon. Now `ensureConnections` dials all ten
ports persistently, whether or not ghax is running, so squatting an unused
port in 9223–9232 is not a race — it's a wait.

Partially closed here: the "no `hello-ack` within 1s ⇒ assume a pre-v2
daemon and bind" fallback now applies **only on the configured base port**.
Pre-v2 daemons predate the scan window and only ever listened there, so the
compatibility path is intact while silence on the nine auto-dialed ports no
longer counts as consent. An actively-lying listener is still accepted.

Still open, tracked in TODOS.md as the challenge–response handshake: the
daemon should prove it holds the pairing code (send a nonce, verify
`HMAC(code, nonce)`) so authentication runs **both** ways and the code
itself never travels. Until then, treat `ghax attach --extension` as a
deliberate foreground act on a machine you trust — the same posture
design/plan/07 already asks for, now with a wider window.

A lower-severity version of the same surface: squatting a port lets a rogue
`control-tab` arbitrary tabs purely to deny them to the real agent, and the
conflict message then names a bridge port the user never started.

## Tests

`test/bridge-multi-sim.ts` (`npm run test:bridge-multi-sim`) — the
browser-free counterpart to `test/bridge-sim.ts`, extended to a fake
extension that mirrors the multiplexer: N connections plus the shared
`tabOwners` registry. Covers adjacent-port allocation, explicit-port
refusal, two daemons bound through one extension with commands landing on
their own tabs, the ownership conflict and its message, release-on-stop,
`controlledBy` in `list-tabs`, and per-tab event routing.

Not smoke-tested: the smoke suite drives the CDP transport against one live
browser, and everything specific to this change needs either two daemons
plus a loaded extension or no browser at all. The simulator is the right
shape for it.
