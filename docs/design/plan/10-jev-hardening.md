# 10 — Hardening from the jev-ultrafast + Playwright study (2026-09-27)

Source analysis: claudectl `docs/research/2026-09-27-jev-laya-graphify.md` ("### ghax" section).
References (read-only): `~/Documents/DevOps/kepptic/products/open-source/third-party/{jev-ultrafast,playwright}`.
Planned by Fable; decisions below settled by the orchestrator.

## Findings that shape the design

- The extension relays any `{id, method, params}` (`extension/background.js:927-942`); all methods used below are already relayed.
- A daemon-side retry-class table exists (`BRIDGE_RETRY_SAFE`, `src/daemon.ts:203-241`; `08-bridge-reliability.md` §2.3). The Rust half is missing.
- `select` isn't a bridge verb; bridge `press`/`type` take no target; no bridge `dblclick`/`hover`/`check`. The guard's surface is `click`, `fill`, `upload`.
- Constant-call tagging of AX refs is impossible (resolveNode/describeNode are per node). The constant-cost design stops stamping `data-ghax-ref` on AX refs (debug-only per `bridge.ts:1331-1337`) and resolves cursor refs lazily. `annotateBridgeScreenshot` uses `bridgeBox`, not the attribute.
- `scripts/bump-version.sh`: `feat` = minor; `fix|perf|refactor|revert|build|deps` = patch; `docs|chore|ci|test` = none.
- `test/bridge-sim.ts` FakeExt echoes `{echoed: method}`; add a `replies: Map<method, (params) => result>` hook so sims can drive snapshot and guard and assert relayed-call counts.

## Settled decisions (were open questions)

1. Snapshot caps: 250 refs / 32 KB for both `-i` and full mode.
2. `--trace`: stderr line only. No change to `--json` stdout.
3. Bridge `fill`: no visibility/hit test (keeps Monaco and hidden-but-scriptable inputs working). Check connected + disabled/aria-disabled/inert + readOnly/aria-readonly only.
4. Playwright-path parity: add a cheap pre-check in the Playwright `click`/`fill` branches that refuses inherited `aria-disabled="true"` / `inert` (walk ancestors incl. shadow hosts, as in Playwright `roleUtils.ts:1175-1220` `hasAriaDisabledInChain`), same typed error code, honours `--force`.
5. Bridge identity pruning: prune to the latest AX tree only for unscoped snapshots; `--selector`-scoped snapshots never prune.
6. The Playwright bump uses `deps:` (patch release).

## Commit sequence

Each commit passes `npm run typecheck && npm run build:all && cargo test --manifest-path crates/cli/Cargo.toml && npm run test:bridge-sim` and then `npm run test:bridge-multi-sim` (sequentially, NEVER concurrently: hardcoded ports). Live smoke (`GHAX_BIN=$PWD/target/release/ghax npm run test:smoke`) needs a CDP browser on :9222 and runs when one is available. Each commit carries its own CHANGELOG `[Unreleased]` / README / help.rs / ARCHITECTURE deltas.

### C0 `docs(plan): add 10-jev-hardening design doc`
This file, as `docs/design/plan/10-jev-hardening.md`.

### C1 `feat(bridge): per-method CDP counters, ghax bridge stats, and --trace`
- `src/bridge.ts` `Bridge.dispatch()` (~930): time each send; on settle upsert `stats: Map<method,{calls,errors,totalMs,maxMs}>` + `statsSince`. Count queued (DEGRADED) sends too. `stats()` / `resetStats()`.
- `src/daemon.ts`: `register('bridge.stats')` (add to `BRIDGE_SUPPORTED_COMMANDS`), `opts.reset`. In `/rpc` (~4493): if `opts.trace === true`, diff stats around `dispatch()` and add `trace: {transport, handlerMs, cdpCalls, cdpMs, byMethod}` as a sibling of `data`. On the Playwright transport, count calls through daemon-owned CDPSessions (`withCdpSession` ~3208, `ctx.browserSession`) via a `tracedSend`, and report `note: 'playwright-internal calls not counted'`. (Optional: if cheap and robust, count Playwright-internal traffic by hooking the `pw:protocol` debug logger — `playwright/packages/utils/debugLogger.ts`, wired for connectOverCDP in `server/chromium/chromium.ts:151,176`. Skip if it needs private API.)
- `crates/cli/src/rpc.rs` `call_once`: if `envelope.trace`, `eprintln!("trace: N cdp calls, X ms cdp, Y ms handler; top: Method xN ...")`.
- `crates/cli/src/bridge.rs`: `stats` subcommand (`--reset`, `--json`), sorted by totalMs; USAGE.
- `help.rs`: `Bridge:` group listing all bridge subcommands + stats; global `--trace` line.
- Tests: bridge-sim `stats: per-method counters and reset`; smoke `bridge stats errors clearly when not in bridge mode`, `--trace prints a trace line on stderr` (stdout unchanged).
- Docs: CHANGELOG Added; README observability; ARCHITECTURE "CDP instrumentation".

### C2 `fix(rust-cli): never retry a mutating verb after a lost response`
- `rpc.rs`: `retry_class(cmd) -> {Idempotent, Mutating}` + `should_retry(err, class)`. Mutating retries only on `is_connect()` (request provably never reached the daemon). Idempotent keeps `is_connect || is_timeout || is_request`. Idempotent allowlist: `status, tabs, find, text, html, snapshot, box, is, xpath, console, network, cookies, downloads, screenshot, wait, version, bridge.instances, bridge.stats, record.status, ext.list, ext.targets, ext.sw.logs` (verify names against dispatch.rs). Unknown verbs default Mutating. `batch` is Mutating as a whole.
- Unit tests in `rpc.rs`: classes; refused connection (`127.0.0.1:1`) retried for Mutating; `RpcError` never retried.
- Docs: CHANGELOG Fixed; `08-bridge-reliability.md` §2.3 Rust-side note; ARCHITECTURE "Disconnect recovery".

### C3 `fix(bridge): guard click/fill/upload with an in-page actionability check`
- `bridgeResolveHandle(bridge, ref) -> {objectId, backendNodeId}` wrapping `DOM.resolveNode`; maps `/no node with given id|could not find node|does not belong to the document/i` to typed `BRIDGE_REF_STALE` (exit 4, hint "the element behind @eN is gone (re-render or navigation). Run 'ghax snapshot -i' and use a fresh ref."). `bridgeCallOn`, `bridgeBox`, screenshot clip and `upload` route through it.
- `bridgeAssertActionable(bridge, handle, kind, {force})`: ONE `Runtime.callFunctionOn` doing guard + scroll + rect (replaces scrollIntoViewIfNeeded + getBoxModel on click, so call count doesn't grow). In-page logic (port the logic, not code, of Playwright `injectedScript.ts` `expectHitTarget` ~1023-1070 and `retarget` ~669-690, and jev `browser.py:126-164`):
  - always: `isConnected` else `detached`.
  - click: `:disabled`, inherited `aria-disabled="true"` / `inert` (composed ancestor walk), `checkVisibility({checkOpacity, checkVisibilityCSS})`, scroll center, zero-size/outside viewport → `offscreen`, hit test at center with shadow-including containment (walk hit up via parentElement/getRootNode().host; accept if it passes through target, or target's composed walk passes through hit) else `covered` with `coveredBy: '<tag#id.class role text[0..40]>'`.
  - fill: connected, disabled/aria-disabled/inert, readOnly/aria-readonly.
  - upload: connected only.
  - `force`: skip all but connected + rect.
- Typed `BRIDGE_TARGET_NOT_ACTIONABLE` with `reason`, `coveredBy?`, per-reason hints (covered → "something is on top of it (<coveredBy>): dismiss it, click that instead, or pass --force"; disabled → "it is disabled; wait for it to enable or pick another ref"; offscreen/hidden → "re-snapshot; it is not visible at its current position").
- `daemon.ts`: click bridge branch (~2028) uses the guard's x,y; fill (~2117) and upload (~2521) guard first; `opts.force` (works in batch step opts). `bridgeError()` passes typed errors through.
- Also decision 4 (Playwright path inherited aria-disabled/inert pre-check).
- Tests: bridge-sim with FakeExt replies: stale → REF_STALE; covered → NOT_ACTIONABLE naming `div#overlay`; force flag carried. `bridge-live.ts` (opt-in): overlay + disabled cases, `--force`. Smoke: Playwright-path aria-disabled refusal and `--force`.
- Docs: CHANGELOG Fixed (headline); help.rs `click <@ref|selector> [--force]`; README; ARCHITECTURE "Ref resolution"; `.claude/skills/ghax.md` error codes.

### C4 `perf(bridge): snapshot costs a constant number of relayed CDP calls`
- Delete `tagBackendNode` and its await; the walk becomes synchronous. Cursor pass keeps one evaluate but uses `window.__ghax = {ids: WeakMap, nodes: Map<number,Element>, next}` (jev `snapshot.js:3-8`), pruning disconnected entries; returns `{cursorId, text, reason}`. Delete the per-item `runtimeObjectFor` readback.
- `BridgeRef = {backendNodeId: number|null; cursorId?: number; role; name}`; `bridgeResolveHandle` gains the cursor branch (evaluate `window.__ghax?.nodes.get(N)` + `DOM.describeNode`); missing → REF_STALE.
- Remove the pre-snapshot attribute strip and `ghax-refs` object-group release.
- Budget: ~7 calls regardless of page size (was 9 + 4n).
- Tests: bridge-sim 40-node fixture → refs 40, relayed calls ≤ 10; cursor resolution lazy.
- Docs: CHANGELOG Changed (`data-ghax-ref` no longer stamped on @e refs; use `ghax box`); ARCHITECTURE. Put before/after `--trace` numbers in CHANGELOG if a live bridge run is possible.

### C5 `feat(snapshot): default ref/char budget with an in-band omitted marker`
- New `src/snapshot-budget.ts` `applySnapshotBudget(lines, refsInOrder, {maxRefs, maxChars})` shared by both transports; line-granular; last line `… N more refs omitted (use --depth/--selector/--max-refs, or --no-cap)`; cursor section after AX refs.
- Defaults 250 refs / 32768 chars; `--max-refs 0` or `--no-cap` disables. Ref map keeps ALL refs. JSON: `count` = shown, `totalRefs`, `omitted: {refs, lines}`.
- `batch` auto-snapshot passes `maxRefs: 0`. `qa.rs` reads `totalRefs ?? count`.
- Tests: smoke with a 300-button data: page (250 / 10 / 300 / max-chars cases, marker line); bridge-sim 300-node fixture.
- Docs: CHANGELOG Added; help.rs snapshot flags; README; skill.

### C6 `feat(bridge): stable @e refs across snapshots, and a freshness guard for batch`
- `ctx.bridgeIdentity = {byBackendNodeId: Map<number,string>, next}`; reuse ref for a known backendNodeId. Reset in `clearSnapshotRefs` and main-frame `Page.frameNavigated` (~559-571). Prune per decision 5.
- Freshness marker (both transports): once per document, `window.__ghaxMark = {docId, mut}` with a MutationObserver (childList, characterData, subtree, attributeFilter role/aria-label/aria-hidden/hidden/disabled/aria-disabled/open/aria-expanded). Marker `[docId, mut, location.href]` stored as `ctx.lastSnapshotMarker` at snapshot. `batch` (~979-988) reads the marker before a ref step and skips the auto-snapshot when unchanged; step result gets `autoSnapshot: 'skipped'|'taken'`.
- Tests: bridge-sim insertion keeps numbers; smoke batch skipped/taken.
- Docs: CHANGELOG (sparse numbering is visible); ARCHITECTURE; AGENTS.md + CLAUDE.md invariant 3 wording; README; skill.

### C7 `deps: bump playwright 1.59.1 to 1.63.0, use connectOverCDP noDefaults`
- `package.json` `^1.63.0` + lockfile via npm.
- Pass `noDefaults: true` to `chromium.connectOverCDP` (1.60; `server/chromium/chromium.ts:90,118,143,157`, `crPage.ts:551`): stops Playwright overriding download behavior / focus / media on the default context. Then simplify or remove the manual download-behavior re-assert workarounds (`src/daemon.ts` ~1223-1251, ~4294-4315) ONLY if smoke proves downloads still land where expected. Consider `artifactsDir` (1.61).
- Smoke risk points: `ariaSnapshot()` line format vs `parseLine` (`src/snapshot.ts:77-87`), `:visible` in `MODAL_SEL`, `>>` chains, `ARCHITECTURE.md` "as of Playwright 1.58+" wording.

### C8 `feat(snapshot): stable refs on the CDP transport via Playwright aria-ref`
- Playwright's `ariaSnapshot({mode:'ai'})` (present in 1.59+) mints refs cached ON the element (`injected/src/ariaSnapshot.ts:211-232`, `element._ariaRef`), so the same element keeps its `eN`. The `aria-ref=eN` selector engine (`injectedScript.ts` `_createAriaRefEngine` ~767) resolves only against the LAST snapshot per frame (`_lastAriaSnapshotForQuery`).
- Replace the `getByRole().nth()` reconstruction in `src/snapshot.ts` with `aria-ref=` locators (optionally parse `ariaSnapshotJSON()` from 1.63 instead of YAML). Handle: modal-scoped and `--selector`-scoped snapshots (does the engine resolve refs from a locator-scoped snapshot?), `-C` cursor refs (keep ghax's own), frames, and stale refs after a newer snapshot must fail with a typed stale error, never mis-target. The C6 freshness marker stays.
- This is semi-private engine behaviour: add smoke checks that pin it (same element keeps ref across re-snapshot; insertion above doesn't shift it; stale ref errors) so a future bump that changes it fails loudly. If it doesn't hold up, keep the fallback: locator-signature map (`role:name:nth → ref`) reset on navigation.

### Later (not in this batch)
`page.screencast` + `showActions()` for action receipts; `Locator.visible()`; `page.localStorage/sessionStorage`; frame-less `frameLocator()`.

## Risks
- Guard false positives (sticky headers, transparent click-catchers, iframes); `--force` escape hatch; error names the coverer.
- Sparse ref numbers after re-snapshot.
- `data-ghax-ref` gone on AX refs.
- Page globals `__ghax`/`__ghaxMark` missing → typed stale error, never a wrong click.
- `count` semantics change on large pages; qa moves to `totalRefs`.
- Mutations are no longer retried when the daemon accepted the connection but stalled (intended).
- Playwright 1.63 may reformat `ariaSnapshot()`; C7 is isolated for a one-commit revert.

---

## Amendment (2026-09-27, verified against Playwright v1.63.0)

Overrides the plan above where they differ. Final commit order for this batch: C0 design doc, C1 counters + --trace, C2 Rust retry classes, C3 Playwright bump, C4 noDefaults, C5 bridge guard, C6 bridge snapshot perf, C7 CDP-path aria-ref refs, C8 snapshot caps, C9 bridge identity + freshness. The plan's original C8 fallback (locator-signature map) is dropped.

Fold these into docs/design/plan/10-jev-hardening.md as an "Amendment" section. Commit ORDER: if you are already past C2, keep your order; otherwise preferred order is C0, C1, C2, bump, noDefaults, guard, bridge perf, CDP-path aria-ref refs, caps, bridge identity+freshness. Content below overrides the plan where they differ.

### Verified facts
- `noDefaults` is public on connectOverCDP (types.d.ts:25547). It sets acceptDownloads 'internal-browser-default' (server/chromium/chromium.ts:143) and CRBrowserContext.initialize then skips Browser.setDownloadBehavior entirely (crBrowser.ts:354-361). On default-context pages it also skips Emulation.setFocusEmulationEnabled and media emulation (crPage.ts:543-570). Not skipped: viewport, file chooser, geolocation.
- ariaSnapshot/ariaSnapshotJSON({mode:'ai', depth, boxes}) public on Page and Locator (client/locator.ts:337-343). mode 'ai' => refs:'interactable': any node with a visible box that receives pointer events gets a ref (injected/src/ariaSnapshot.ts:58-65, :223), so headings/text containers still get refs (box/screenshot @eN keep working).
- Ref identity: element._ariaRef caches {role,name,ref}; reused only if role+name unchanged (ariaSnapshot.ts:220-232). lastRef module-level (:38): monotonic per frame per document, resets on navigation.
- aria-ref= engine (injectedScript.ts:737-743) resolves only against _lastAriaSnapshotForQuery.info, requires isConnected, returns at most one element. EVERY ariaSnapshot/ariaSnapshotJSON call (any mode) overwrites that cache (:329). Scoped snapshots (locator.ariaSnapshot) set the cache to the subtree (server/page.ts:1116-1129). Iframe subtrees get f<seq>e<n> refs.
- AriaSnapshotJSON = AriaNodeJSON[] {role, name?, checked?, disabled?, expanded?, active?, level?, pressed?, selected?, ref?, cursor?:'pointer', url?, placeholder?, text?, children?: (AriaNodeJSON|string)[]} (packages/isomorphic/ariaSnapshot.ts:58-79). If not re-exported from 'playwright', declare a local structural type.
- pw:protocol hooking needs private utilsBundle: DO NOT do it. Count daemon-owned CDPSession sends only (withCdpSession, ctx.browserSession, pageTargetId session), report note 'playwright-internal protocol traffic not counted', and document the manual diagnostic `DEBUG=pw:protocol DEBUG_FILE=/tmp/pw-protocol.log ghax attach` in ARCHITECTURE (confirm attach.rs passes env through to the daemon; add passthrough for DEBUG/DEBUG_FILE if it scrubs env).

### Bump commit: `deps: bump playwright 1.59.1 to 1.63.0`
Pin EXACT "1.63.0" (not ^): the aria-ref engine semantics are undocumented. Regenerate package-lock.json with npm (CI bun install --frozen-lockfile reads it). No source change in this commit.

### New commit: `fix(daemon): pass noDefaults to connectOverCDP and drop the download-behaviour undo`
- connectOverCDP(url, { noDefaults: true }).
- Keep ctx.browserSession and wireDownloadEvents (downloads verb needs Browser.downloadWillBegin/Progress, which need eventsEnabled:true). Simplify assertDownloadBehavior to ONE call at attach: Browser.setDownloadBehavior { behavior: opts.downloadsDir ? 'allow' : 'default', downloadPath: opts.downloadsDir, eventsEnabled: true }. Delete the newWindow re-assert (~daemon.ts:1213-1218) and rewrite the "undo the hijack" comments/log line (~1224-1236, ~4294-4315).
- Smoke: if no downloads check exists, add one (data: page, <a download>, click, `downloads --json` finalPath ends with suggested filename).
- Risk: focus emulation off may make document.hasFocus() false on scratch browsers; if smoke shows it, fallback = noDefaults only when not --launch. Note it in the report.

### Guard (bridge) — replace jev-derived checks with Playwright's logic, in order
1. isConnected else detached.
2. Retarget ('button-link'): if element is not input/textarea/select/contenteditable and is inside button,[role=button],a,[role=link], hit-test that ancestor; report retargeted tag in errors.
3. Disabled (getAriaDisabled, roleUtils.ts:1175-1220): native disabled on BUTTON/INPUT/SELECT/TEXTAREA/OPTION/OPTGROUP; OPTION inside OPTGROUP[disabled]; inside FIELDSET[disabled] unless within its first LEGEND; inherited aria-disabled walking parentElement / getRootNode().host, stopping at first explicit "true"/"false", only for roles in kAriaDisabledRoles (roleUtils.ts:1176). Keep closest('[inert]').
4. fill only: readOnly / aria-readonly="true".
5. click only: checkVisibility({checkOpacity:true, checkVisibilityCSS:true}), scroll center, rect, in-viewport center.
6. click only, hit test (expectHitTarget, injectedScript.ts:1023-1085): chain of roots target→up (ShadowRoot hosts to Document); from document down, root.elementsFromPoint(x,y) per root; display:contents workaround (if root.elementFromPoint differs from elements[0] but is its child, unshift it); at each level innermost hit must be next root's host; at last level must be target or descendant. Else covered with coveredBy = innermost hit description.
7. force: skip 3-6.
Sim cases: fieldset[disabled], inherited aria-disabled wrapper, shadow-hosted target under overlay. Live (bridge-live) same three shapes.
Playwright-path parity: keep the cheap pre-check for [inert] and inherited aria-disabled (settled decision 4).

### CDP-path stable refs: `feat(snapshot): stable @e refs on the CDP transport via Playwright aria-ref`
- src/snapshot.ts: `rootLocator.ariaSnapshotJSON({mode:'ai', depth})`; root selection unchanged (--selector, else top-most MODAL_SEL, else body). Scoping becomes inherent, so drop modalScopeActive/locatorScope and the same-name-outside-modal workaround (snapshot.ts:94-99).
- Walk JSON, render ghax's own line format (`@e12 [button] "Save" [checked, expanded]`, indent, `: text` for strings) so existing smoke regexes hold. -i filters INTERACTIVE_ROLES; --compact as today. Drop parseLine/roleNameCounts/nth.
- RefEntry.locator = target.locator(`aria-ref=${ref}`). Register only /^e\d+$/; iframe refs render but are not registered. Nodes without ref render without @. Render `placeholder`, `[active]`; do not render url.
- Stale refs must error: in daemon resolveRef (~879) `if (await entry.locator.count() === 0) throw new Error(`Ref ${target} not found in the latest snapshot (element gone, renamed, or a newer snapshot replaced it). Run 'ghax snapshot' first.`)` — keep "Run 'ghax snapshot' first" (smoke regex ~1799).
- Code comment: any other ariaSnapshot call on the frame wipes the ref cache; keep a single call site.
- Cursor pass (@c refs) unchanged.
- Smoke: refs stable across snapshots (insert a button before the link; link's ref unchanged, new button new number); stale ref errors after removal (exit 4); modal-scoped refs don't resolve outside the modal (extend ~:600); -d depth honoured. Measure perf-bench snapshot -i P50 (100 ms gate); if it regresses, say so in CHANGELOG, don't loosen the gate.
- Docs: CHANGELOG headline (stable refs, sparse numbering); ARCHITECTURE Ref resolution (aria-ref, cache semantics, why exact pin); AGENTS.md + CLAUDE.md invariant 3 ("refs survive re-snapshots on the same document; not tab switches or navigation"); README; skill.
- This REPLACES the plan's C8 fallback: the locator-signature map is dropped.

### Bridge identity amendment
Store {ref, role, name} per backendNodeId and remint when role or name changed (mirror Playwright's rule).

### Caps
Implement on the new JSON renderer's line array and on bridgeSnapshot via shared src/snapshot-budget.ts.
