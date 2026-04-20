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

### 3. Daemon: `withCdpSession()` helper (6 call sites)

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
loop-registration

Three near-identical `register()` calls that differ only in a label +
filter regex. Register them in a loop.

**Accept:** three separate registers become one loop emitting three
handlers; smoke passes.

### 5. Rust CLI: shared time helpers (3 copies today)

`qa.rs`, `canary.rs`, and `ship.rs` each have their own
`now_ms()` / `iso_now()` / `days_to_ymd()` implementations. `ship.rs`
uses a different algorithm for the same problem.

- Add `crates/cli/src/time_util.rs` exposing `now_ms()`, `iso_now()`,
  and `days_to_ymd()`.
- Delete the duplicates from `qa.rs`, `canary.rs`, and `ship.rs`; have
  them import from `time_util`.

**Accept:** one implementation, three consumers; `cargo build`
clean; smoke passes.

### 6. Rust CLI: `qa.rs` / `canary.rs` shared "since cycle start" filter

Both files filter console entries on `level == "error" && ts >=
page_start` and failed-requests on `ts >= page_start && status >= 400`
against the same RPC results with the same shape.

- Add a small `qa_common.rs` with `ConsoleErrorEntry`,
  `FailedRequestEntry`, plus `console_errors_since(port, since_ms)`
  and `failed_requests_since(port, since_ms)`.
- Have `qa.rs` and `canary.rs` use them.

**Accept:** one implementation of each filter; smoke passes.

### 7. Rust CLI: `resolve_url` → `url::Url::join`

`qa.rs::resolve_url` reimplements relative→absolute URL resolution.
`url` crate is already transitively in the dep tree via `reqwest`.

- Replace `resolve_url` with `url::Url::parse(base)?.join(href)?`.
- Delete the hand-rolled function (~40 lines).

**Accept:** `qa --crawl` still resolves links correctly; smoke passes.

### 8. Rust CLI: `dispatch.rs::url_encode` → `urlencoding` crate

Hand-rolled percent-encoder with explicit byte table. `urlencoding` is
a 15-line zero-dep crate already used by `reqwest` adjacents.

- Add `urlencoding = "2"` to `crates/cli/Cargo.toml`.
- Replace `url_encode(ext_id)` with `urlencoding::encode(ext_id)`.
- Delete the hand-rolled function.

**Accept:** `ghax ext inspect <id>` still works; smoke passes.

### 9. Daemon: invariant fix — clear `ctx.refs` on tab switch

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

### 10. Daemon: `since:` filter on `console` + `network` RPCs

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

### 11. Rust CLI: `require_daemon` skip redundant checks

`state.rs::require_daemon` reads the state file, does a `kill(pid, 0)`
probe, then an HTTP `/health` round-trip. The `/health` call already
proves liveness; the kill probe is redundant when health succeeds.

- Skip the kill probe on the happy path; keep it only as a pre-HTTP
  guard for when `port` is missing or state is malformed.

**Accept:** `ghax status` shaves ~100µs + a syscall; smoke passes;
behavior on dead daemon unchanged (still gives the clean "not
attached" hint).

### 12. Snapshot: cache `getComputedStyle` in the cursor-interactive walk

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

## Queued decisions

(Empty at plan time. Populated during execution if a hard stop hits.)
