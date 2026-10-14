# 12 — Phase 3 multi-bind: implementation plan

Status: plan (Fable, 2026-10-14), approved under G's "do all of it" (2026-10-13).
Design: [11-multi-browser.md](./11-multi-browser.md) phase 3. Line numbers are against
`feat/tab-identity` @ 8625080.

## Step 0 — split peer handling out of bridge.ts (lands alone)

New `src/bridge-peers.ts`, `class PeerRegistry`. Moves from `src/bridge.ts`:

- Types `PeerRole`, `BridgeSelectionState`, `BridgeCandidate`, `BridgeSelection`,
  `BridgeInstance` (193-253) and `interface Peer` (301-321).
- `peers` Map and `socketPeer` WeakMap (377-378), `instances()` (601-619), `aliasOf`
  (626-645), `identityOf` (653-657), `describePeer`/`shortId` (736-744).
- `matchesFilter` (540-544) + `decideSelection` (551-586) as a pure
  `decide(filter, port): { selection, winners: Peer[] }`. Timer clearing stays in Bridge.
- The selector matching duplicated in `use()` (1230-1236) and `findPeer` (1356-1364)
  becomes one `match(selector): Peer[]`; `use()` keeps its 0/>1 refusal text.
- Hello intake (895-959) as `upsertFromHello(msg, ws): { peer, restarted }`.

Stays in Bridge: WS server, pairing, pending/controlPending, disposition (961-1023),
`bindPeer`, state machine, queue, dispatch, `close`. Public API unchanged, so both sims
run untouched. Add pure tests: `decide` refuses two candidates; `match` returns both on an
ambiguous label.

## Brief A — per-peer session inside Bridge

Single-peer state today (354-425): `boundId`, `_state`, `sessionToken`, `graceTimer`,
`queue`, `resumeWaiters`, `desiredControl`, `lastReloadRequestedAt`, plus `pending`.
Move into `class PeerSession` keyed by instanceId; `bound: Map<instanceId, PeerSession>`
replaces `boundId`; `activeId` names the peer whose tab is `ctx.activePageId`.
`cdpStats`, `nextId` stay global.

- `send`/`sendControl`/`waitForResume`/`setDesiredControl` take optional `{ peer }`;
  default = active.
- Events carry `instanceId` (+ `tabId` on `event`).
- Getters (`connected`, `state`, `controlledTabId`, `extensionInfo`, `boundInstanceId`)
  read the active session.
- `setBindFilter('all')`: `decide` returns every candidate, settle binds each, a late
  hello binds instead of parking. `use(x)` under `all` switches active, demotes nobody.
- Liveness, degrade and expiry are per session: one DEGRADED peer cannot stall another.
- `noteBindChange` must not count settle-close binds (else 3 browsers trip the livelock).

Done: two browsers + `all` → both bound; an echo to B while A's socket is closed resolves
within 100 ms; A's grace expiry rejects only A's queue; `use` under `all` sends no parked
frame to the other.

## Brief B — daemon per-peer page state

Per-peer today in `Ctx`: `bridgeNetworkRequests`, `bridgeMainFrameId`, `bridgeContexts`,
`bridgeLastLoadAt`; plus isolated-world `WorldState` (bridge.ts 1598-1615) → key by
instanceId, reset on that peer's `controlled`/`disconnect`. New
`ctx.bridgePeers: Map<instanceId, {...}>` + `peerState(ctx, id)`; `wireBridgeEvents`
switches on `ev.instanceId`. Daemon-wide stay: console/network buffers (entries gain
`tabId`), refs, `activePageId`, `lastTabListing`. The `controlled` handler and the
`Page.frameNavigated` ref clear act only when `instanceId === bridge.activeId`
(invariant 3).

Done: two fake peers emit console events, buffer shows both tagged; `frameNavigated` from
the non-active peer leaves refs intact.

## Brief C — surface

- `tabs` (no `--browser`): `list-tabs` to every bound peer, `Promise.allSettled`, 10 s
  each, re-indexed; a failed peer is a `note`, never a hang.
- `tab <x>`: if the alias names a non-active peer, switch active before `control-tab`.
- `console`/`network`: default to the active tab; `--tab <#n|id>`, `--all` widen.
- `bridge instances` adds `active`; `/bridge-status.connected` = any bound;
  `--browser all` flows through `GHAX_BRIDGE_BROWSER`.

Done: `tabs` over two peers numbers 1..N across both; `console --tab <id>` returns only
that tab; `--all` returns both.

## Risks

- Invariant 3: gate `controlled`/`frameNavigated` ref clears on `activeId`.
- Plan 09 ownership: `tabOwners` is per browser, so bound browsers never contend.
  Inferred: no extension change needed; confirm with `test/bridge-live.ts`.
- Retry layer: `BridgeInterrupted` carries `instanceId`; replay only if still active.
- `GHAX_BRIDGE_CONTROL=active` under `all`: first bound peer only.

## Phase 4

Persist bind policy in the state file, SSE per-tab filtering, `bridge unbind`,
ARCHITECTURE/README/llms.txt, cross-browser `batch`.
