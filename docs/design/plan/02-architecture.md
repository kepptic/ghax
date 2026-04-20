# ghax — architecture

## Stack

- **Runtime**: Bun 1.x (same as gstack, for `build --compile` and speed)
- **Language**: TypeScript
- **Browser driver**: Playwright (for tab-level automation) + raw CDP
  WebSockets (for service workers, sidepanels, gestures, storage)
- **Transport**: localhost HTTP between CLI and daemon
- **State**: `.ghax/ghax.json` in the project root or `~/.ghax/` globally

## Process topology

```
┌──────────────────────────────┐
│ ghax CLI (Bun-compiled)      │   Started once per command, exits on return.
└──────────┬───────────────────┘   Startup: ~50-100ms.
           │ HTTP (localhost, random port)
           ▼
┌──────────────────────────────┐
│ ghax daemon (Bun.serve)      │   Persistent. Auto-shuts after 30min idle.
│  - CDP client pool           │   Owns the CDP connection to the browser.
│  - Command router            │   Buffers console/network/dialog in-memory.
│  - CircularBuffer logs       │
└──────────┬───────────────────┘
           │ CDP (WebSocket)
           ▼
┌──────────────────────────────┐
│ User's running Chrome / Edge │   Launched with --remote-debugging-port.
│  - tabs                      │   ghax attach discovers the port or launches.
│  - extension SWs             │
│  - extension sidepanels      │
│  - content scripts           │
└──────────────────────────────┘
```

## Why a daemon

Per-command, opening a fresh CDP WebSocket + discovering targets costs ~200ms.
Keeping the WebSocket warm in a long-lived daemon drops per-command overhead
to ~10-50ms. `gstack browse` uses the same model; first call is ~3s cold, the
rest are 60-200ms. We want the same feel.

## CDP target types (from experience with Beam)

```
/json/list buckets:
  - page             — regular tabs                  ← Playwright handles these
  - background_page  — MV2 extensions (legacy)
  - service_worker   — MV3 background                ← raw CDP
  - iframe           — sub-frames
  - webview          — some Edge-specific views
  - other            — Chrome-internal (newtab, devtools)
```

`sidepanel.html` opened via Chrome's side-panel pane shows up as `type=page`
at `chrome-extension://<id>/sidepanel.html` — but is NOT a tab in the tab
API. Playwright can't reach it via `browserContext.pages()` without tweaks.
We talk to it via raw CDP using the `webSocketDebuggerUrl` from `/json/list`.

## Why both Playwright AND raw CDP

Playwright is excellent for tab-level work: snapshots, accessibility tree,
auto-waits, element handles, frame navigation, screenshot clipping. We want
all of that for `ghax browse goto / click / fill / snapshot / screenshot`.

Playwright is weak at MV3 extension internals: it doesn't attach to service
workers cleanly, doesn't expose chrome.storage, doesn't help with
`Input.dispatchMouseEvent` for real-gesture APIs like `chrome.sidePanel.open()`.
We hand-roll raw CDP for those.

Split:
- **Tab commands** → Playwright's `BrowserContext.page()`
- **Extension SW / sidepanel / gesture** → raw CDP WebSocket to target
- **Both share** the same CDP port + target discovery

## Attach flow

```
ghax attach
  1. Check if .ghax/ghax.json exists and daemon is alive → reuse.
  2. Find a running browser listening on :9222 (or configured port).
     - If none: detect installed browsers, offer to relaunch one with
       --remote-debugging-port and --user-data-dir pointing at the real
       profile (gstack's chrome-cdp pattern).
  3. Start the ghax daemon on a random port.
  4. Daemon connects Playwright to the CDP endpoint.
  5. Daemon writes .ghax/ghax.json with its port + browser URL.
  6. CLI prints "attached".
```

## Storage & logs

- **State**: `<cwd>/.ghax/ghax.json` — daemon pid, http port, cdp browser-url,
  attached-at timestamp.
- **Logs**: `<cwd>/.ghax/ghax-{console,network,dialog}.log` — ring buffers
  flushed every few seconds. Daemon holds the in-memory buffer for fast reads.
- **Gitignore**: `.ghax/` by default.

## Security model

- Daemon binds to `127.0.0.1` only.
- Random port by default.
- No token auth in v1 (single-user, localhost). Add scoped tokens in v2 if we
  expose to remote agents (mirroring gstack's `token-registry.ts`).
- URL allowlist per-session if we ever do "remote agent" pairing.

## What we WON'T copy from gstack

- Anti-bot stealth. We're attaching to the user's real browser — whatever it
  does, it does. We don't need WebDriver camouflage.
- Sidebar chat extension. That's a gstack-specific UX. Out of scope.
- Design/shotgun skills. Those are gstack's design-tooling, separate concern.

## What we WILL mirror

- `src/server.ts` daemon shape
- `src/snapshot.ts` accessibility tree with `@e1/@e2…` refs
- `src/buffers.ts` CircularBuffer for console/network
- `src/config.ts` state file discovery
- `src/cli.ts` command dispatch style
