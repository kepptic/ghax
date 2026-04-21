# plan: close out the whole-codebase audit to 10/10

**Goal.** Land the high-ROI findings from the three-agent `/simplify`
audit that were skipped in the first pass because they were wider than
a mechanical cleanup. Every item here has a concrete target and a
single clear "why". Nothing speculative, nothing that needs a flag
debate.

**Non-goals (deferred on purpose).**

- `qa --concurrency N` for parallel URL crawling — API change, worth
  its own design discussion.
- `BrowserKind` enum parity between Rust and TS — wide TS change,
  low real payoff since the Rust side is already typed and the TS
  side only touches `browserKind` as an opaque string at the edges.
- `shell.rs` port + reqwest client reuse across REPL iterations —
  touches REPL lifecycle, wants its own bench to prove the win.
- RPC method-name constants in the Rust CLI — nice-to-have, but the
  smoke suite already catches typos at zero cost.
- Narrating WHAT-comment cleanup sweep — grepping for commit-drift
  comments is noisy and adds churn without changing behavior.

## Scope

### 1. Daemon: `evalInTarget()` helper (high impact, 9 call sites) — [x]

`Runtime.evaluate` with `awaitPromise: true, returnByValue: true` + the
`exceptionDetails` check is open-coded in nine places in `daemon.ts`
(roughly lines 1091, 1144, 1204, 1230, 1285, 1408, 1451, 1488, 1516).
Two of them (`ext.sw.eval`, `extViewEval`) also wrap the user JS in
`(async () => { return (${js}); })()` and throw on `exceptionDetails`.

- Add `async function evalInTarget(target, expr, opts?) -> unknown` in
  `daemon.ts` that owns: the evaluate call shape, `awaitPromise` /
  `returnByValue` flags, the `exceptionDetails` throw, and returning
  `.result.value` (or the raw result if not `returnByValue`).
- Collapse all nine sites to one-liners.

**Accept:** diff reduces daemon.ts by ~30-50 net lines; smoke passes.

### 2. Daemon: `getSwTarget()` helper (6 call sites) — [x]

`ext.reload`, `ext.hot-reload`, `ext.sw.eval`, `ext.storage`,
`ext.message`, and `ensureSwLogSubscription` all repeat:

```ts
const sws = await ctx.pool.findByExtensionId(extId, 'service_worker');
if (sws.length === 0) throw new DaemonError(`No SW for ${extId}`, 3);
const target = await ctx.pool.get(sws[0]);
await target.send('Runtime.enable');
```

- Add `async function getSwTarget(ctx, extId) -> CdpTarget`.
- Collapse all six call sites.

**Accept:** 6 sites shrink to one-liners; smoke passes.

### 3. Daemon: `withCdpSession()` helper (6 call sites) — [x]

Gesture + profile handlers all build `const session = await
page.context().newCDPSession(page); try { ... } finally { await
session.detach().catch(...); }` verbatim (`gesture.click`,
`gesture.dblclick`, `gesture.scroll`, `gesture.key`, `profile`,
`pageTargetId` indirectly).

- Add `async function withCdpSession<T>(page, fn) -> T` that owns the
  lifecycle.
- Collapse the six gesture/profile sites.
- Leave `pageTargetId` as-is — its error path (`catch → return null`)
  is semantically different and the helper is post-cache trivial.

**Accept:** six call sites shrink; smoke passes.

### 4. Daemon: `ext.panel.eval` / `ext.popup.eval` / `ext.options.eval`
loop-registration — [x]

Three near-identical `register()` calls that differ only in a label +
filter regex. Register them in a loop.

**Accept:** three separate registers become one loop emitting three
handlers; smoke passes.

### 5. Rust CLI: shared time helpers (3 copies today) — [x]

`qa.rs`, `canary.rs`, and `ship.rs` each have their own
`now_ms()` / `iso_now()` / `days_to_ymd()` implementations. `ship.rs`
uses a different algorithm for the same problem.

- Add `crates/cli/src/time_util.rs` exposing `now_ms()`, `iso_now()`,
  and `days_to_ymd()`.
- Delete the duplicates from `qa.rs`, `canary.rs`, and `ship.rs`; have
  them import from `time_util`.

**Accept:** one implementation, three consumers; `cargo build`
clean; smoke passes.

### 6. Rust CLI: `qa.rs` / `canary.rs` shared "since cycle start" filter — [x]

Both files filter console entries on `level == "error" && ts >=
page_start` and failed-requests on `ts >= page_start && status >= 400`
against the same RPC results with the same shape.

- Add a small `qa_common.rs` with `ConsoleErrorEntry`,
  `FailedRequestEntry`, plus `console_errors_since(port, since_ms)`
  and `failed_requests_since(port, since_ms)`.
- Have `qa.rs` and `canary.rs` use them.

**Accept:** one implementation of each filter; smoke passes.

### 7. Rust CLI: `resolve_url` → `url::Url::join` — [x]

`qa.rs::resolve_url` reimplements relative→absolute URL resolution.
`url` crate is already transitively in the dep tree via `reqwest`.

- Replace `resolve_url` with `url::Url::parse(base)?.join(href)?`.
- Delete the hand-rolled function (~40 lines).

**Accept:** `qa --crawl` still resolves links correctly; smoke passes.

### 8. Rust CLI: `dispatch.rs::url_encode` → `urlencoding` crate — [x]

Hand-rolled percent-encoder with explicit byte table. `urlencoding` is
a 15-line zero-dep crate already used by `reqwest` adjacents.

- Add `urlencoding = "2"` to `crates/cli/Cargo.toml`.
- Replace `url_encode(ext_id)` with `urlencoding::encode(ext_id)`.
- Delete the hand-rolled function.

**Accept:** `ghax ext inspect <id>` still works; smoke passes.

### 9. Daemon: invariant fix — clear `ctx.refs` on tab switch — [x]

The CLAUDE.md hard invariant says "Refs survive only until the next
snapshot." Today `ctx.refs` is a single global map; switching tabs via
`tab <id>` or `new-window` doesn't clear it, so `@e3` can resolve
against a stale tab's snapshot.

- In the `tab` handler: `ctx.refs.clear()` when the active page
  changes.
- In the `newWindow` handler: same.

**Accept:** the invariant holds after a tab switch; add a smoke check
that snapshotting tab A, switching to tab B, then clicking `@e1`
fails with a refs-expired error instead of resolving against A.

### 10. Daemon: `since:` filter on `console` + `network` RPCs — [x]

QA + canary both request `last:500` and then discard everything older
than `page_start` client-side. On a busy page that ships ~500 entries
over HTTP per page check.

- `console` handler: accept `since: <epochMs>` opt; filter inside the
  daemon.
- `network` handler: same.
- `qa.rs` + `canary.rs`: pass `since_ms` instead of `last: 500` in
  their per-page calls.

**Accept:** a page with 500 console entries returns only post-cycle
entries; smoke passes; QA output unchanged.

### 11. Rust CLI: `require_daemon` skip redundant checks — [x]

`state.rs::require_daemon` reads the state file, does a `kill(pid, 0)`
probe, then an HTTP `/health` round-trip. The `/health` call already
proves liveness; the kill probe is redundant when health succeeds.

- Skip the kill probe on the happy path; keep it only as a pre-HTTP
  guard for when `port` is missing or state is malformed.

**Accept:** `ghax status` shaves ~100µs + a syscall; smoke passes;
behavior on dead daemon unchanged (still gives the clean "not
attached" hint).

### 12. Snapshot: cache `getComputedStyle` in the cursor-interactive walk — [x]

`snapshot.ts::consider()` calls `getComputedStyle(el)` and
`isInFloating()` walks ancestors re-reading `getComputedStyle` for
each candidate. On a 5k-element SPA this is O(n · depth) style reads.

- Cache the `CSSStyleDeclaration` per element in a `WeakMap` that
  lives for the duration of one `walk()` call.
- `isInFloating` pulls from the cache instead of re-reading.

**Accept:** snapshot latency on a heavy SPA improves measurably
(track via `test/benchmark.ts`); smoke passes.

## Execution order

1, 2, 3, 4 (daemon DRY — single rebuild + smoke)
5, 6 (Rust DRY — single cargo build + smoke)
7, 8 (Rust dep swaps — single smoke)
9 (invariant fix — adds a smoke check)
10 (daemon + CLI — two-sided, one rebuild + smoke)
11 (state.rs only — unit-verifiable)
12 (snapshot.ts — rebuild + smoke + benchmark)

Each group commits atomically. After all groups land:

- Full smoke (`npm run test:smoke`)
- Benchmark run (`npm run test:benchmark`) to sanity-check item 12
- `/simplify` pass on the new helpers
- `/document-release` to sync README / ARCHITECTURE / CHANGELOG

## Acceptance criteria (overall)

- All three audit findings tiers that were in-scope on the first pass
  now closed (daemon DRY, Rust DRY, perf wins, invariant fix).
- `npm run typecheck`, `cargo build --release`, `npm run build`,
  `npm run test:smoke` all green.
- `npm run test:benchmark` shows no regression on existing commands
  and a measurable improvement on snapshot-heavy pages (item 12).
- CHANGELOG entry under `[Unreleased]` covers all items.
- No new external runtime deps except `urlencoding` (item 8).

## Deferred

(See "Non-goals" at the top — items explicitly out of scope.)

**Surfaced during run, not in this PR:**

- **Google anti-automation on sensitive flows.** Chrome/Edge launched
  with `--remote-debugging-port=9222` sets `navigator.webdriver = true`
  and related fingerprintable flags. Google's anti-bot on sensitive
  pages (Business Profile verification, Drive sharing consent, some
  auth challenges) refuses to render. Cheap mitigation: document
  adding `--disable-blink-features=AutomationControlled` to the
  user's Edge launch command in `CONTRIBUTING.md`. Also document the
  workaround pattern ("detach ghax → do the Google thing manually
  → re-attach") for flows where even the mitigation doesn't help.
  Full stealth-mode JS injection is out of scope — cat-and-mouse
  maintenance burden isn't worth it for a dev tool.

- **Download interception.** When ghax is attached, Playwright's
  `connectOverCDP` default flips `Browser.setDownloadBehavior` so
  downloads land in `/var/folders/.../T/playwright-artifacts-*/`
  under UUID filenames instead of `~/Downloads/` with the original
  filename. Fix: after `connectOverCDP`, open a root CDP session
  and `Browser.setDownloadBehavior { behavior: 'default' }` to
  restore native browser download handling. Smoke check: click a
  download link, assert file lands in `~/Downloads/` with the
  Content-Disposition filename. Split into its own PR — this one
  is already landing twelve items.

## Follow-up sprint (from 2026-04-20 jnremache field report)

The 8h operator-driven session logged in
`docs/sessions/2026-04-20-jnremache-field-report.md` surfaced
40+ data points grouped into triage buckets for the next sprint.

**Bucket A — high-ROI, same theme as item 10 (payload reduction):**

- `snapshot --compact` (TOK-01). Drop the cursor-interactive tree
  by default, one element per line. 50%+ token cut on snapshot.
- `eval --max-bytes N` (TOK-02). Server-side truncation to protect
  LLM operators from accidental context blow-outs.
- `text --length N --skip M --selector <sel>` (TOK-10). Scoped,
  paged page-text dumps. Replaces ~40 hand-rolled
  `document.body.innerText.substring(...)` in one session.
- `tabs --filter <regex> --fields id,title` (TOK-04). Server-side
  regex + field selection on the tab list. Cuts ~200 bytes of
  query-string noise per Google-product tab.
- `upload <@ref|selector> <path>` (JNR-07). First-class file upload
  verb that wraps CDP's `DOM.setFileInputFiles`. Used 5x in one
  session via a hand-written 30-line Node + ws shim.
- `--full-page` kebab alias for `--fullPage` (GHAX-FR-06). Trivial.

**Bucket B — architectural, own PR each:**

- Stable `@e` refs across DOM mutations within a tab (JNR-03).
  Currently refs shift mid-click-sequence on Material / React
  forms; the field report shows Saturday got toggled instead of
  Friday on Google Ads because comboboxes opened and reindexed the
  ARIA tree. Item 9 in this PR only handles the tab-boundary case.
  Real fix needs hash-based refs (role + name + nth-of-type)
  or semantic re-resolution on every interaction.
- React/Angular/Material `fill` fallback (JNR-04). Detect
  framework-managed inputs and use the native-setter +
  `dispatchEvent('input'/'change')` pattern instead of
  Playwright's `.fill()`.
- Dialog-aware ARIA walker (JNR-06). When a `[role=dialog]` is
  open, the snapshot should treat it as the new root instead of
  inheriting `aria-hidden="true"` from the outer app.
- Auto-reattach when state file stale but daemon alive (JNR-01).
  Or at minimum a more actionable error than "no daemon state".
- `ghax batch '[{"click":"@e7"},...]'` (TOK-09). One round-trip for
  a sequence of ops, with atomic snapshot between steps — also
  fixes the JNR-03 ref-shift naturally.

**Bucket C — papercuts, bundle into one PR:**

- RPC single-retry shim (JNR-02).
- Quiet `ghax attach` on success (TOK-07, POSIX convention).
- `ghax status` includes active tab id + title (GHAX-FR-04).
- `ghax wait --selector` more prominent in help (GHAX-FR-02).
- `ghax eval` auto-waits for navigation once before giving up
  (GHAX-FR-01).

**Bucket D — docs-only, goes with the google-antibot note:**

- Chrome default-profile CDP restriction (JNR-08). Chrome v113+
  blocks `--remote-debugging-port` on the default user-data-dir.
  Document the `--user-data-dir=<path>` workaround in
  CONTRIBUTING.md.
- Google Ads "disconnect" modal on rapid form submits (GHAX-FR-05).
  Known anti-bot pattern, not fixable, document as expected.

## Queued decisions

(Empty at plan time. Populated during execution if a hard stop hits.)
