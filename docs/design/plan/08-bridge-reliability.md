# 08 — Bridge reliability: identity, resume, and read correctness

Session capture, 2026-07-23. Follows
[`07-extension-bridge.md`](./07-extension-bridge.md), which shipped the
transport and full command parity. This one is about making it *hold up
under a real work session*.

Provenance: a live-fire bug report from a QBO/Autotask session where the
bridge churned on nearly every `goto`, `screenshot`, and re-attach; plus
two independent architecture consults (Fable, Codex) and direct
verification against HEAD.

---

## 0. What the field report got right, and what was stale

The report listed 11 items across 4 tiers. Verified against HEAD:

**Already fixed at HEAD — do not re-do:**

- `ghax bridge control --active|--tab-id|--stop` exists
  (`crates/cli/src/bridge.rs`, wired through the `bridge.control` RPC).
- `ghax tabs` already enumerates *all* browser tabs in bridge mode via
  the `list-tabs` control action → `chrome.tabs.query({})`
  (`daemon.ts:599`, `daemon.ts:762`), keyed on Chrome's real `tab.id`;
  `ghax tab <id>` switches control through `control-tab`.
- `wait <selector> | <ms> | --networkidle | --load` works over the
  bridge (`daemon.ts:2417`).
- MV3 keepalive partially exists: a `chrome.alarms` alarm at the 30s
  floor plus a 15s app-level ping; `controlledTabId` persists in
  `chrome.storage.local`; the SW re-attaches proactively on reconnect and
  the daemon re-asserts `desiredControl` on `hello` (`bridge.ts:210`).

**Why the report saw otherwise — and the real lesson.** `~/.local/bin/ghax`
is a *symlink* into `target/release/ghax` (`scripts/install-link.sh:22`),
and `Cargo.toml` still reads `0.4.4` because the bridge work is
unreleased. A `cargo clean` or a disk cleanup silently decapitates the
installed CLI, and a version string that doesn't move makes the damage
invisible. Report item #8 ("self-contained install") was filed as Tier 4
ergonomics; it is in fact the reason items #6 and #9 *appeared* broken.
**It ships first.**

**One item is mis-diagnosed.** Report item #5 asks to "pin the execution
context… wrong frame". `chrome.debugger.attach({tabId})` attaches to the
tab's top-level target, so `Runtime.evaluate` can never land on the wrong
frame — it can only ever see the top frame. Cross-origin iframes are not
reachable *at all* without `Target.setAutoAttach` + `sessionId` routing.
The observed partial reads are item #4 (pre-hydration timing). Context
pinning is still worth doing — for *staleness across navigations*, not
frame selection — and OOPIF support is a separate, unfiled gap.

**A gap nobody filed:** `test/` has **zero** bridge coverage. The 95-check
smoke suite runs entirely on the CDP path. Every fix below would ship
untested. §5 fixes that, and it is the release gate.

---

## 1. Root cause: `connection replaced` is a rivalry/race bug, not eviction

This is the reframing that reorders the whole plan.

The two daemon-side failure strings come from different places:

- SW eviction kills the socket → `ws.on('close')` (`bridge.ts:165-176`)
  → **"extension disconnected"**.
- **"new extension connection replacing existing one"**
  (`bridge.ts:151-153`) fires *only* when a second socket arrives while
  the first is still open, and it calls
  `rejectAllPending('bridge: extension connection replaced')` —
  nuking every in-flight command.

The reported symptom was the *second* string, repeatedly. Since Chrome
116, active WebSocket traffic resets the SW idle timer, and the extension
pings every 15s (`background.js:35`), so a *connected* SW should almost
never idle-evict. Eviction is the wrong suspect. There are two real
mechanisms, and the plan must fix both:

**(a) Two live extension installs racing one port.** Verified on this
machine: the same unpacked extension (id `kjkknpagkmdaakpecgaogiolfhiehkgf`
— deterministic from its path, so *identical* across installs) is
registered in three profiles: Edge Profile 1, Edge Profile 3, Chrome
Profile 1. All dial `127.0.0.1:9223`. Each connect evicts the incumbent;
the evicted one's `close` handler reschedules with backoff capped at 8s
(`background.js:34`, `:159-164`) — a self-sustaining ping-pong.

*Honest caveat:* a passive 100s listener on 9223 drew exactly **one**
client, so this was not reproduced in the current browser state. It is a
confirmed latent hazard, **not a confirmed history** — the plan treats it
as a hypothesis to be settled by telemetry (§5, TASK-006), not as
established fact. Note that `chrome.runtime.id` is path-derived and
therefore *identical* across all three installs — useless as a
discriminator. Identity must be minted, not derived; a
`crypto.randomUUID()` in `chrome.storage.local` is per-profile, so the
UUID *is* a profile identity. There is no profile-display-name API.

*Rollout hazard:* all three installs share one unpacked directory, so the
code updates together — but **each profile needs its own manual reload**
in `edge://extensions`. Until every profile is reloaded, legacy
(no-`instanceId`) clients still fight. The livelock detector in §2.4 is
what makes that residual churn visible instead of silent.

**(b) A single instance racing itself.** `connect()` returns early only
for `OPEN` and `CONNECTING` (`background.js:114`). When the socket is in
`CLOSING` (readyState 2) — which is exactly the state the daemon's own
eviction `close()` puts it in — `connect()` proceeds and opens a *second*
socket while the daemon still holds the first. That produces "connection
replaced" from one extension, with no rival present. This mechanism alone
can sustain churn, and it is a one-line guard fix.

Design consequence: **identity in the handshake + park the loser instead
of evicting it.** Parking satisfies the rival's reconnect loop rather
than retriggering it, which is what actually dissolves the churn.

---

## 2. Design

Synthesized from the two architecture consults, with the additions and
disagreements recorded in §3.

### 2.1 Handshake v2 (all additive; no flag day)

Each install mints once on `onInstalled` into `chrome.storage.local`:
`instanceId` (`crypto.randomUUID()` — the identity), `browserBrand`
(from `navigator.userAgentData.brands`, display only), and an optional
user-set `label`.

Per daemon session the daemon mints a `sessionToken` and returns it in a
new `hello-ack`. The extension stores it in **`chrome.storage.session`** —
survives SW respawn (what resume needs), dies with the browser (what
security wants). Token mismatch never blocks a bind; it only
distinguishes *resume* from *fresh*.

```jsonc
// ext → daemon (replaces background.js:145-150)
{ "type":"hello", "agent":"ghax-ext", "version":"0.2.0",
  "instanceId":"a3f9…", "browser":"edge", "label":"work-edge",
  "controlledTabId":123, "resumeToken":"9f2c…" }

// daemon → ext (NEW — today the daemon replies nothing)
{ "type":"hello-ack", "role":"bound"|"parked",
  "sessionToken":"9f2c…", "graceMs":20000 }
{ "type":"hello-reject", "reason":"protocol"|"auth", "message":"…" }

// daemon → ext (NEW) — demote/promote over a LIVE socket, so rebinding
// never requires a disconnect
{ "type":"role", "role":"bound"|"parked" }
```

A hello without `instanceId` (old extension) synthesizes
`instanceId:"legacy-<n>"` and logs a "reload the extension" warning. An
extension that never receives `hello-ack` (old daemon) behaves as today.

`role:"parked"` means: keep the socket open, keep pinging, remain
discoverable/selectable, hold **no** `chrome.debugger` attachment, and
receive no CDP commands. The popup shows "parked — another browser is
bound" plus the command to switch. **Parked clients never loop** — they
hold a satisfied, pinging socket. That is precisely the livelock cure.

**The daemon must retain every healthy socket.** If "parked" ever
degrades into "remember its metadata, close its socket", the extension's
reconnect loop (`background.js:159-178`) resumes and the problem has
simply moved. Holding the socket *is* the mechanism.

**The extension's startup order must change.** Today it restores and
attaches its persisted tab *before* sending hello
(`background.js:125-150`) — so a would-be parked peer grabs a debugger
attachment anyway. New order: connect → send identity → **receive
disposition** → attach only if granted the active lease. On an
active→parked transition, detach but keep the desired tab recorded so a
later selection can restore it.

**Rejected clients must not hot-loop either.** A client that receives
`hello-reject` (auth/protocol) enters **DORMANT**: close the socket,
cancel the reconnect timer, retry once via a 5-minute `chrome.alarms`,
popup shows the reject reason. The fast 500ms–8s backoff
(`background.js:34`) is retained **only** for socket-unreachable (daemon
down), where it is correct.

### 2.2 State machine

```
UNBOUND    ──hello(any)───────────────► BOUND
BOUND      ──close / liveness─────────► DEGRADED   [start graceTimer]
BOUND      ──hello(same instanceId)───► BOUND      (ext reload; resume in place)
DEGRADED   ──hello(same instanceId)───► BOUND      (resume sequence below)
DEGRADED   ──graceTimer──────────────► EXPIRED     [reject queue, typed error]
EXPIRED    ──hello(same instanceId)───► BOUND      (late recovery still allowed)
any        ──hello(different id)─────► unchanged   (rival PARKED, never adopted)
```

| Constant | Value | Meaning |
|---|---|---|
| `LIVENESS_MS` | 25 000 | No frame of any kind from the bound socket → `ws.terminate()` → DEGRADED. Kills the half-open case deterministically. The ext pings every 15s and `bridge.ts:220-224` already sees them — just track `lastFrameAt`. |
| `GRACE_MS` | 20 000 | DEGRADED → EXPIRED, i.e. how long the *session* survives. Covers the ≤8s reconnect backoff + attach + slack. `--bridge-grace <ms>`. |
| `RESUME_SETTLE_MS` | 5 000 | Max wait for control re-ack + domain re-enable before replaying. |
| Queue cap | 32 | `send()` while DEGRADED enqueues; overflow fails fast. |

**Session grace is not a command SLA.** A queued command still honours
its **own absolute deadline** — a 20s session grace must never turn a 5s
command into a 20s hang. Grace governs whether the *session* survives;
each command dies on its own timer regardless. (Codex argued for a flat
5s grace on the grounds that the recovery alarm isn't a user-facing SLA;
that concern is real but it's a *command-deadline* problem, and
decoupling the two solves it without shortening the window below the 8s
reconnect backoff it has to cover.)

**Commands during DEGRADED are queued, not rejected** — the caller sees
latency, not an error, if the extension returns inside the grace window.
In-flight commands move to a `parked` list instead of being rejected at
the two current `rejectAllPending` sites (`bridge.ts:153`, `:174`).

**Resume sequence (order matters):** adopt socket + ack → re-assert
`desiredControl` and **await** its control-ack (`bridge.ts:210-215`) →
re-run `enableBridgeDomains` (`daemon.ts:568-577`, idempotent) → replay
parked safe commands → flush the queue FIFO.

### 2.3 Retry classes — the safety-critical table

**Retry lives at the logical-operation layer, never on `Bridge.send()`.**
This corrects the first draft. `Bridge.send()` transports a *single* CDP
command (`bridge.ts:259-298`), but a user-visible verb spans many with
mutable intermediate state: `bridgeSnapshot` (`bridge.ts:532-613`)
enables domains, strips old `data-ghax-ref` tags, releases an object
group, reads the AX tree, then writes new tags. Resuming from an
interrupted *middle* command can splice together two documents or two ref
generations. Raw CDP method names are not evidence of idempotency.

The unit of retry is therefore the whole operation:

```ts
runBridgeOperation({ verb, retryClass, deadline }, operation)
```

A `safe` operation **restarts in full** against a freshly pinned browser,
tab, and document epoch. Default is `never`.

| Class | Verbs | Behaviour |
|---|---|---|
| **`safe`** — restart the whole operation once | `status`, `tabs`, `find`, `text`, `html`, `screenshot`, `snapshot`, `wait <selector>`, `wait --load`, `wait --networkidle`, `wait --stable` | Snapshot *does* mutate disposable ref tags, but a full restart is fine; a mid-operation resume is not. |
| **no bridge replay needed** | `console`, `network`, `record.status` | These read daemon-local buffers (`daemon.ts:456-565`); bridge events populate them. Nothing to re-send. |
| **reconcile, don't replay** | `tab <exact-id>`, `bridge control --tab-id`, `bridge control --stop`, `goto`, `reload`, `back`, `forward` | Re-read actual state and compare against intent (see below). |
| **`never`** — fail with `BRIDGE_OUTCOME_UNKNOWN` | `click` (`daemon.ts:1517-1519`), `fill`, `press`, `type` (`daemon.ts:1591-1620`, `:1957-1994`), `eval` (`daemon.ts:1003-1015`), `new-window`, `batch` (`daemon.ts:653-692` — an arbitrary prefix may already have run), `bridge control --active` (the active tab may have changed), `box` (`bridge.ts:694-708` — it scrolls before measuring, which can trigger lazy-loading) | *"connection lost mid-command; the action MAY have landed — verify with `ghax snapshot` before retrying."* |

**`back`/`forward` are NOT safe — the first draft had this wrong.**
Blindly restarting the verb re-reads `currentIndex` and can step *two*
entries (`daemon.ts:957-967`, `:974-984`). Retaining the original fixed
`entryId` helps, but re-navigating to an already-current entry can still
re-fire page lifecycle effects, so it isn't an unquestionable no-op
either. Correct handling on reconnect: retain the source and target entry
ids, call `Page.getNavigationHistory`, then — current == target → treat
the navigation as **succeeded**; current == source → report **outcome
unknown**; neither → report **concurrent navigation**. A future policy
could reissue the original target from an unchanged source; the first
reliability release should not.

**Auto-retry is the single easiest way to make this project worse.** The
table is the deliverable, not the retry machinery.

### 2.4 Multi-browser: one port, registry, parked rivals

Rejected: **port-per-browser** (the port is a `chrome.storage.local`
value with no UI — asking users to hand-configure ports to avoid a fight
they can't see is backwards, and it races on shared machines) and
**daemon-per-browser as the default** (a fresh install in a second
browser must not require configuration to avoid destroying the first
session). Daemon-per-browser survives as the power-user escape hatch via
`GHAX_STATE_FILE` + `--bridge-port`, consistent with the "single daemon
per state file" invariant.

Chosen: `Bridge` keeps `instances: Map<instanceId, {browser, label,
socket, lastHelloAt, helloCount, replacedCount, role}>`. Exactly one
**bound**, N **parked**.

**Arbitration rule — first-writer-wins, upgrading to identity-scoped the
moment a preference exists:**

1. **A bind filter exists** (`--browser`/`--instance`, or a previously
   persisted choice) → identity-scoped: non-matching hellos **park**.
2. **No filter** (first-ever attach) → first hello binds, later hellos
   park. Safe *because parking is non-destructive*.
3. **Takeover is always explicit** (`ghax bridge use`) and **persists**
   into `.ghax/ghax.json` as `bridgeBoundInstance` — so after one
   correction, identity-scoped applies forever.
4. **No auto-failover.** A DEGRADED/EXPIRED bound instance is never
   silently replaced by a parked one — different profiles mean different
   tabs, auth, and cookies. The error names the parked alternatives
   instead.

Pure identity-scoped-only was rejected: on first attach the daemon cannot
know which of three profiles the user means, and hard-rejecting the others
reintroduces the reconnect hot-loop.

**Livelock detector.** If bind ownership changes ≥3 times in a 5-minute
sliding window, `ghax status` and the daemon log emit: *"bridge ownership
is flapping — a pre-identity extension is still installed somewhere;
reload the ghax bridge extension in EVERY profile."* Every hello is logged
with its decision **and reason**:
`bridge: hello edge·a3f9c1 "work-edge" v0.2.0 → parked (edge·a3f9c1 is bound)`.

- `ghax bridge instances` — one line per instance: role marker, browser,
  short id, label, controlled tab + title, last hello, hello/replaced
  counts.
- `ghax bridge use <id|browser|label>` — rebind via the new `role`
  message, so **no disconnect is involved**; emits the existing
  `controlled` event so `daemon.ts:3600-3607` clears refs and the network
  map. Tab ids are per-browser, so refs **must** die on rebind — this
  reuses the invariant-3 machinery for free.
- `ghax status` gains: `bridge: bound edge·a3f9 (tab 123) · parked
  chrome·b7c2`. If the daemon has ever seen ≥2 distinct instanceIds it
  says so in plain text even when only one is connected. Churn becomes
  visible inventory instead of an anonymous log line.

**Composition with §2.2:** the state machine is the lifecycle of the
**bound** instance only; parked-socket churn is pure registry bookkeeping.
Identity answers *who may drive*; the state machine answers *what happens
when the driver blinks*. No duplication.

**Per-peer state partitioning — deferred to Phase 3, deliberately.** Bridge
refs, network requests, and console buffers are *global* daemon maps
(`daemon.ts:120-127`), cleared globally on any control change
(`daemon.ts:3600-3607`). The Codex consult called partitioning mandatory
"the moment the daemon holds N peers". On implementation that proved
stronger than needed for Phase 1: **a parked peer holds no debugger
attachment and receives no CDP**, so it generates no refs, no network
events, and no console entries. The global maps only ever contain the bound
peer's data, and `use()` clears them on rebind via the existing
`controlled` event. Partitioning becomes genuinely required in Phase 3,
when `ghax tabs --browser <parked>` starts querying a non-bound instance.
Recorded here so the deferral is a decision, not an oversight. Target shape
when it lands:

```
BridgeServer { peers: Map<instanceId, BridgePeer>, selectedPeerId }
BridgePeer   { socket/session state, desired + controlled tab, heartbeat,
               pending requests, document epoch, refs/network/console }
```

### 2.5 Execution-context pinning

Track, don't guess. On attach/rebind, `Page.getFrameTree` → `mainFrameId`.
Subscribe (events already flow through `wireBridgeEvents`,
`daemon.ts:456-566`) to `Runtime.executionContextCreated` /
`executionContextDestroyed` / `executionContextsCleared` and
`Page.frameNavigated`. Keep `Map<frameId, {uniqueId, id}>` for the
default context per frame. `bridgeEvaluate` (`bridge.ts:395-402`) passes
**`uniqueContextId`** (immune to numeric-id reuse).

Failure modes: context missing mid-navigation → wait ≤2s for
`executionContextCreated`, then fall back to unpinned + log — never
hard-fail a read because bookkeeping lagged. Stale context ("Cannot find
context with specified id") → clear map, `Runtime.disable`/`enable`, wait
for main-frame default, retry the evaluate **once** (safe regardless of
the caller's retry class, because the original never executed).

`--frame` selection is deferred; the map is keyed by `frameId` so it's a
flag + lookup later, not a redesign.

### 2.6 DOM stability — daemon-side, one awaited evaluate

**Where it lives:** daemon-side, as a single `Runtime.evaluate` with
`awaitPromise:true` that installs an in-page `MutationObserver` and
resolves when quiet or at deadline — the same shape the existing bridge
wait-selector already uses (`daemon.ts:2450-2464`). One round-trip.

Rejected: **extension-side** (version-locks the subtlest heuristic in the
codebase to a component that needs a manual `edge://extensions` reload
after every ghax update, does nothing for the CDP transport, and needs new
manifest permissions for zero latency benefit — the observer runs in-page
either way, only the result transport differs). Rejected: **daemon-side
poll loop** (10–30× the round-trips, coarser resolution, can interleave
with navigation).

**"Stable" means all of:** `readyState` is `interactive` or `complete`;
`document.body` (or the requested selector root) exists; **zero
significant mutations** for a quiet window (default 500ms); no visible
`[aria-busy="true"]`; two consecutive rAFs; optionally `--min-nodes N`.
Hard deadline (10s) resolves `{stable:false, reason:'timeout'}` —
**never throws**. Infinite-churn pages get a truthful "not stable,
proceeding anyway", not a hang.

"Significant" = `childList` + `characterData`, plus the specific
attributes `aria-busy` and `hidden`. General attribute churn is
deliberately ignored: spinners and class-toggling animations mutate
attributes forever, and a page with a spinning CSS loader *is* readable.
(The two consults split here — one wanted `characterData` ignored too,
one wanted it observed. Observed wins: a text-only content swap is
exactly the hydration this primitive exists to catch. The `aria-busy`
gate is the more valuable half of that disagreement.)

Returns diagnostics, not just a boolean: node count, text length, busy
count, elapsed, and quiet duration.

**Do not fold network-idle into stability.** A separate bridge
network-idle primitive already exists (`daemon.ts:2420-2433`); callers
compose the two. Merging them makes a page with a long-poll or an
analytics beacon permanently "unstable".

Navigation destroying the context rejects the promise — that's *signal*,
not an error ("the page navigated" is the opposite of stable): catch,
re-pin per §2.5, re-run, bounded to 2 re-runs.

**Flags:** `ghax wait --stable [--quiet N] [--timeout N] [--min-nodes N]`,
plus `--stable` sugar on `goto` / `text` / `snapshot`. All opt-in.

**"Suspiciously empty" (report item #10)** is detected at the *read
verbs*, not the wait, and only when BOTH: the yield is tiny (`text` < 40
visible chars, or `snapshot -i` refCount < 3) AND there is evidence of an
in-flight page (`readyState !== 'complete'`, or
`ctx.bridgeNetworkRequests.size > 0` (`daemon.ts:526`, `:563`), or load
fired < 2s ago). Then one silent bounded retry (~1.5s worst case); if
still tiny, return anyway with `"possiblyIncomplete": true` and a stderr
note.

**It only ever warns.** Turning a small read into a *failure* requires an
explicit `--min-nodes` — legitimately sparse, blank, media-only, and
redirect pages must not be reported as broken. Sparse pages cannot
false-positive into failure because nothing ever fails by default.
`--no-retry` opts out for benchmarking.

### 2.7 Typed errors (report item #10, second half)

Daemon RPC errors gain `{code, hint}`: `BRIDGE_NOT_CONNECTED`,
`BRIDGE_DEGRADED_TIMEOUT` (names the lost instance), `BRIDGE_RIVAL_INSTANCE`,
`BRIDGE_CMD_INTERRUPTED_UNSAFE`, `BRIDGE_TAB_UNATTACHABLE` — the last
wrapping the raw `chrome.debugger` strings (`background.js:192-194`, plus
"Cannot access a chrome-extension:// URL") with tab id, truncated title,
and the recovery verb. Rust side: teach the error path in
`rpc.rs`/`output.rs` to print `hint` on its own line.

---

## 3. Deltas from the consults

Additions and disagreements recorded here so the phases below are the
merged plan, not either consult verbatim.

1. **The `CLOSING` guard (§1b) is a distinct bug and a Phase 0 one-liner.**
   Both consults treated "replaced" as requiring a rival. It doesn't —
   `background.js:114` admits `readyState === CLOSING`, so a single
   instance can open a second socket while the daemon holds the first.
   Fix: treat `CLOSING` as "wait for `close`, then reconnect", and make
   the `close` handler not schedule a reconnect when a newer socket is
   already live.
2. **The multi-install hazard is real but unproven as this session's
   cause.** Recorded as verified-latent, not verified-historical. The
   `helloCount`/`replacedCount` telemetry in §5 is what will settle it.
3. **Report item #5 is mis-diagnosed** (§0). Context pinning stays, scoped
   to navigation staleness; OOPIF support is filed separately, unstarted.
4. **Screenshot chunking (item #11) is deferred indefinitely.**
   `Page.captureScreenshot` (`daemon.ts:1226-1233`) is read-only and
   therefore `safe`-class: once §2.2/§2.3 land, an interruption costs one
   transparent retry. Chunking buys wire-format complexity for a failure
   mode that mostly evaporates.
5. **Corrections from the Codex consult, adopted.** Retry moved from
   `Bridge.send()` to a whole-operation wrapper (§2.3) — the first draft
   said "classify at the verb layer" but then bolted the flag onto the
   per-CDP-command transport, which would have spliced ref generations
   inside `bridgeSnapshot`. `back`/`forward` demoted from `safe` to
   reconcile-only. `goto`/`reload`/`box`/`control-active` likewise removed
   from `safe`. `console`/`network` need no replay at all. The extension's
   attach-before-hello startup order (`background.js:125-150`) would have
   defeated parking. Per-peer state partitioning is mandatory, not
   incidental. And `install-release.sh` already copies — the first draft
   over-blamed the installer.
6. **Extension packaging is an unsolved gap.** Every install is unpacked
   from one working-tree path, which is why all three profiles share an
   id and why each needs a manual reload. There is no versioned
   distribution story for `extension/` at all. Filed, not scheduled.
7. **No offscreen document for keepalive.** It needs a store-review
   justification, is another process to manage, and is exactly what
   enterprise Edge `ExtensionSettings` policy breaks silently — for a hole
   the evidence says barely exists while connected. The residual real hole
   is *wake latency after a daemon restart*; fix it with two staggered 30s
   alarms (`-a`/`-b`, the second created with `when: Date.now()+15_000`)
   → worst-case wake ≈15s. Revisit only if post-Phase-1 telemetry shows
   idle evictions while connected.

---

## 4. Sequencing

**Phase 0 — stop the bleeding (~1 day, no wire changes).** This is what
actually bit the user, and it removes a whole class of stale-binary ghosts.
0. **Zero-code mitigation, available today:** disable the ghax bridge
   extension in the profiles that aren't driving (Edge Profile 3 and
   whichever of Edge/Chrome is unused). Costs nothing, and removes the
   rivalry hazard immediately while the real fix lands.
1. `scripts/install-link.sh:22-24` — **default to copy**, with `--link`
   as an opt-in for active development (where a symlink is genuinely
   useful: rebuild and the CLI updates in place). Correction to the first
   draft: `scripts/install-release.sh:81-95` **already copies** both the
   binary and the daemon bundle, so the release path was never broken.
   The actual failure was a *dev* installer being used as a daily-driver
   product install — which is why the fix is a safer default plus
   visibility (item 2), not deleting the symlink mode.
   *Discovered during implementation:* the bigger packaging bug was in
   `scripts/bootstrap-daemon-runtime.sh` — it installs `playwright` and
   `source-map` beside the bundle but **not `ws`**, which the bridge added
   as a runtime external. So every non-repo install hit
   `Cannot find package 'ws'` on the first `ghax attach --extension`; the
   bridge only ever worked from a repo checkout (which has `ws` in its dev
   `node_modules`). Fixed: `ws` is now bootstrapped, and its presence is
   part of the "needs install" check so pre-bridge installs self-repair.
   **[SHIPPED]**
2. `ghax version --full` — CLI version + build hash, resolved daemon
   bundle path **and content hash**, and (if a daemon is up) the running
   daemon's bundle hash + extension version/instanceId from the last
   hello. One command answers "what am I actually running". Pairs with the
   existing `GHAX_DAEMON_BUNDLE` resolution trap.
3. `ghax attach` logs which bundle path it resolved (XDG vs repo `dist/`)
   — the silent preference order is the trap.
4. The `CLOSING` guard fix + staggered second alarm (§3.1, §3.5).
5. `bridgeError()` helper + hint table + Rust hint printing.

**Phase 1 — identity + state machine (the root-cause fix). [SHIPPED]**
Multi-instance identity and arbitration belong here, **not** in a
deferred UX phase — they are the root-cause fix, not polish.
6. Hello v2, `hello-ack`/`hello-reject`/`role`, instanceId minting,
   `chrome.storage.session` resume token, DORMANT reject path. **[SHIPPED]**
7. Instance registry, bound/parked roles + arbitration rule, livelock
   detector, liveness timeout, DEGRADED queue, grace window, resume
   sequence, retry classes at the operation layer. **[SHIPPED]**
8. `test/bridge-sim.ts` — **release gate**, see §5. **[SHIPPED — 13 checks]**

*Deviations from plan, all recorded above:* per-peer state partitioning
deferred to Phase 3 with justification (§2.4); `bridgeBoundInstance`
persistence to `.ghax/ghax.json` deferred — the in-memory registry plus
`--browser` covers the arbitration cases, and persisting a bound instance
across daemon restarts is only meaningful once profiles are long-lived
enough to matter. `ghax bridge instances`/`use` shipped **early** (they were
Phase 3 in the plan) because they're how a human confirms the registry is
behaving — shipping arbitration without them would be untestable by hand.

**Phase 2 — read correctness (~2 days).**
9. Execution-context pinning (§2.5) — small; the events already flow.
10. `wait --stable`, `--min-nodes`, suspicious-empty auto-retry
    (default-on for `text`/`snapshot`, `--no-retry` escape).

**Phase 3 — multi-browser conveniences (~1-2 days).** Arbitration itself
ships in Phase 1; what remains here is surface polish.
11. `ghax bridge instances` / `ghax bridge use` CLI ergonomics, status
    line formatting, popup label + port field, `ghax tabs --browser`
    against a parked instance.

**Phase 4 / deferred.** Pairing auth token (the
[`07`](./07-extension-bridge.md) TODO — security, not reliability; the
`pairToken` field is reserved in hello now). `--frame` selection. OOPIF
sessions. `ghax tabs --browser <parked>`. Screenshot chunking and the
offscreen document only if evidence ever demands them.

---

## 5. Testing — the layer that makes this shippable

`test/` has zero bridge checks today. The enabling insight: `Bridge` is a
plain Node `ws` server, so **every state transition is testable with a
simulated extension** — a Node `ws` client speaking the wire protocol —
with no browser at all.

`test/bridge-sim.ts` (CI, headless, no Edge) must cover:

- **The literal livelock reproduction** — three fake extensions with
  distinct instanceIds and real backoff connect concurrently; assert
  exactly one bound, two parked, **zero daemon-initiated closes and zero
  re-hellos over 10s**. This is the test that proves the cure.
- A legacy pair (no `instanceId`) alternating until the livelock detector
  trips.
- `hello-reject` → asserts DORMANT (socket closed, no fast retry).
- Bind; parked rival not evicted; resume within grace (safe command
  replayed exactly once, unsafe rejected with
  `BRIDGE_CMD_INTERRUPTED_UNSAFE`); grace expiry (typed error names the
  instance); liveness timeout (silent socket terminated at 25s); legacy
  hello still binds; rebind via `bridge use` clears refs (invariant 3);
  and the `CLOSING`-race regression from §1b.

`test/smoke.ts` gains a live-bridge section gated on `GHAX_SMOKE_BRIDGE=1`
(needs a real browser with the unpacked extension): attach --extension,
control-active, goto/snapshot/click parity, then force a reconnect and
assert resume.

Telemetry that settles §1: per-instance `helloCount` / `replacedCount` in
the registry, dumped by `ghax status --json`.

---

## 6. Risk register

- **Auto-retry double-fire** — the top risk. Contained by default-`never`,
  the explicit class table (§2.3), and replay-only-after-control-ack
  ordering.
- **Grace window hiding a dead extension** — contained by `ghax status`
  showing DEGRADED with a countdown and EXPIRED errors naming the lost
  instance. Grace is 20s, not minutes.
- **Parked-rival surprise** — a user who wants Chrome finds Edge bound.
  Contained: parked state is visible in `status`, the popup says "parked",
  and `bridge use` is one command. Strictly better than today's silent
  fight.
- **`chrome.storage.session` unavailable** on an older Edge → resume
  degrades to fresh-bind (correct; only loses in-flight replay). No hard
  dependency.
- **`uniqueContextId` edge cases** (`about:blank`, sandboxed frames) →
  unpinned fallback keeps reads working.
- **Stability default-on retry skews benchmarks** → `--no-retry`, and the
  benchmark suite runs with it.

## 7. Invariants this adds

- The extension must be reloaded in `edge://extensions` after `extension/`
  changes. The daemon detects version skew via `hello` and warns — one
  line, but it belongs in CLAUDE.md alongside the daemon-restart
  invariant.
- Refs must die on rebind, not just on tab switch and re-snapshot: tab ids
  are per-browser-instance. Reuses the existing `controlled`-event path.
