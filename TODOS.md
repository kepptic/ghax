# ghax — TODOs

Active, accepted-but-deferred work. Items here have been reviewed and
approved for future work but deliberately held out of the current commit
to keep diffs focused. When picking one up, the surrounding context is
recorded so you don't need to re-derive the reasoning.

Anything without enough context to restart cold in 3 months doesn't
belong here — either flesh it out or close it.

## Open

### Bridge robustness: five deferred findings from the multi-agent review (P2)

Found by adversarial review of the multi-agent bridge (2026-08-07,
design/plan/09). All are pre-existing or low-severity; the blocking ones
were fixed in that change. Each is independent — pick one off at a time.

1. **Anonymous sockets never time out.** `src/bridge.ts` `handleConnection`
   registers listeners and returns; a socket that never sends `hello` has no
   `Peer`, so `checkLiveness` (which starts `const peer = this.boundPeer`)
   never sees it. 25 silent sockets stayed open past 3× the liveness window
   in a probe, invisible to `ghax bridge instances` and every log line. Also
   reachable innocently: the extension opens the socket, then awaits four
   `chrome.storage` reads before sending `hello`, so an eviction in that
   window orphans it. Fix: arm a ~10s no-hello timer in `handleConnection`
   that `terminate()`s, plus a hard connection cap.

2. **A closed tab can produce an endless reattach loop.** `extension/errors.js`
   classifies `no tab with given id` as *temporarily* unattachable — correct
   for `relayCommand`, wrong for `scheduleReattach`, which reschedules itself
   forever (4s cap, no attempt budget, never clears `controlledTabId`).
   Reached when a tab closes while this connection is not its registered
   owner, since `chrome.tabs.onRemoved` only notifies `ownerOf(tabId)`. Fix:
   `chrome.tabs.get` first in the reattach path and `persistTab(null)` when
   the tab is gone.

3. **`DEAD_DIAL_THRESHOLD` fires at ~7.5s, not the "tens of seconds" its
   comment and design/plan/09 both claim.** `failedDials` only counts dials
   that never reach OPEN, and the backoff restarts from `RECONNECT_BASE_MS`
   after the last successful open: 500+1000+2000+4000 ≈ 7.5s. Any daemon
   restart slower than that drops the tab to a rival — the exact scenario the
   constant exists to prevent. Fix: raise the threshold (~8 gets a real ~30s)
   or correct the comment and the doc.

4. **`releaseControl()` leaves persistence claiming the tab.** It drops the
   `tabOwners` entry but keeps `controlledTabId` and never re-saves, so when
   a rival claims the tab its `persistTab` rebuilds the map from live
   connections and storage ends up with BOTH ports naming it. After a worker
   respawn `ensureConnections` walks ports ascending, so the lower port —
   the connection whose daemon was declared dead — wins. Fix: have
   persistence record ownership rather than desire, or clear the entry on
   release.

5. **`peers` is never pruned** (`src/bridge.ts`) — one `Peer` per distinct
   `instanceId`, including synthetic `legacy-N` ids, removed never. Ghosts
   accumulate in `ghax bridge instances`; unbounded if (1) is exploited.

Also noted, decide when touching this area: `bridgeStatus` in
`chrome.storage.local` is written on every failed dial (≈1.25 LevelDB
writes/sec with no daemon running) and has **no reader** — the popup uses
`chrome.runtime.sendMessage({action:'status'})`. Either delete the key or
stop writing it on dial failures.

### Bridge pairing: challenge–response handshake (P1)

**What:** Stop sending the pairing code itself in the extension's `hello`.
Daemon includes a random nonce in a pre-hello frame (or the extension
requests one); the extension answers `HMAC-SHA256(code, nonce)`; the daemon
verifies against its stored code. The code never travels the wire.

**Why:** Since the multi-agent port scan (2026-08-07, design/plan/09), the
extension sends its `hello` — pairing token included — to whatever answers
on any of ports 9223–9232, persistently. A rogue local process listening on
any scanned port captures the token and can impersonate the browser to a
genuinely paired daemon. Localhost-only and opt-in, so shipped with a
documented note (see the Security section of design/plan/09), but it
quietly weakens the exact threat model pairing was added for.

**Context to restart cold:** pairing gate lives in `src/bridge.ts`
(`handleHello`, `rejectPairing`, `timingSafeEqualStr`); the extension side
is the `hello` construction in `extension/background.js` `connect()`'s open
handler (`ghaxPairToken` from `chrome.storage.local`). Keep the brute-force
throttle and the dormancy-on-reject behavior; only the proof mechanism
changes. Needs a protocol-version dance so a new extension still pairs with
an old daemon (fall back to bare token only if the daemon never offers a
nonce). Add sim coverage in `test/bridge-sim.ts`.

### Split `src/daemon.ts` by domain


**What:** Extract handler groups into domain-specific files. Approved in
plan-eng-review on 2026-04-19.

- `src/daemon.ts` (2227 lines, 72 handlers) → split into:
  - `src/handlers/tab.ts` (tabs, tab, goto, back/forward/reload, find,
    new-window)
  - `src/handlers/snapshot.ts` (snapshot + cursor walker)
  - `src/handlers/interact.ts` (click, fill, press, type, wait, is)
  - `src/handlers/ext.ts` (every `ext.*` register call)
  - `src/handlers/capture.ts` (console, network, cookies, storage, HAR)
  - `src/handlers/orchestrated.ts` (qa, profile, diff-state, perf)
  - `src/handlers/util.ts` (eval, try, xpath, box, screenshot,
    viewport, responsive, diff)
  - `src/daemon.ts` keeps: Ctx interface, bootstrap, HTTP server,
    SSE endpoints, shutdown, recording dispatcher

> **Note:** `src/cli.ts` split was originally part of this TODO but
> has been dropped — the Rust CLI rewrite replaces `cli.ts` entirely,
> so splitting the TypeScript version first would be wasted work.

**Why:** At 2227 lines, navigation cost is real. A second contributor
would friction looking for "where does goto live." Today it's one file.
Future debugging sessions also benefit: smaller blast radius per edit,
cleaner git blame.

**Pros:**
- Maintainability gain for anyone who isn't the original author
- Makes future feature additions land in obvious files
- Smaller per-file compile units (marginal bundle-time improvement)
- Enables parallel PRs that don't collide on daemon.ts

**Cons:**
- One-time churn on every handler
- Import paths need updating across registered handlers
- Minor risk of subtle ordering issues (register() calls need to fire
  before HTTP server starts — verify the entry-point import chain
  triggers all handler files)

**Context:**
- The `register()` pattern in daemon.ts is the natural split boundary.
  Each handler file just imports from `./daemon` (for register + Ctx
  type) and calls register() at module top level. The bootstrap
  function in daemon.ts then imports the handler modules for side
  effects, triggering all register() calls.
- Cross-browser smoke already covers behavioral equivalence; after
  the split, `bun run test:smoke` + `bun run test:cross-browser`
  should catch any regression.

**Depends on / blocked by:** Nothing. Land the simplify and
plan-eng-review follow-ups first (already in main as of 6f42830),
then do this as its own focused PR.

**Effort:** ~30 min with CC, probably an hour to get right including
smoke re-verification.

## Completed

- **Rewrite the CLI in Rust (public-release gate)** — shipped across
  phases 1-4. `src/cli.ts` deleted in `b2748e7` (refactor: remove the
  Bun CLI source — Rust is the single source of truth). `bin/ghax`
  shim now prefers `target/release/ghax`; installed users run the
  Rust binary directly. Bun runtime fully removed in `8d1deb5`;
  esbuild bundles the daemon, tsx runs the tests. All 8 success
  gates green: ~2.6 MB stripped Apple Silicon binary (under the 10MB
  target), 70/70 smoke parity, cold-start floor hit, cross-browser
  green on Edge + Chrome, install-link/install-release flows live.
