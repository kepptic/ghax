# Field reports — status index

Agent-authored field reports about ghax in real sessions. Layout:

- **`open/`** — reports with at least one unresolved item.
- **`resolved/`** — every item in the report is fixed, shipped, or ruled
  not-a-ghax-bug. Reports move here (never deleted) so the repro detail
  stays greppable.
- Reports about *other* products get moved to that product's repo
  (e.g. the Conduit P2P QUIC report now lives in
  `kepptic/products/apps/conduit/docs/reports/`, resolved by conduit #59).

Report files are immutable history — per-item status lives in this index,
not in the reports (a short Resolution section appended to a resolved
report is fine).

Last audit: **2026-07-10** (full sweep of reports + claudectl session
history, followed by a five-agent fix wave; smoke 113/113 green after).

## Open items by report

### `open/FIELD-REPORT-2026-04-30-DATTO-RMM.md`

| Item | Status |
|------|--------|
| BUG-1 AntD `<Select>` won't open via `ghax click` | **FIXED 2026-07-10** — `ghax select` verb (native / React-fiber / portal-aware open-click cascade) |
| BUG-2 `:has-text()` hits wrong/hidden surface | **PARTIAL** — click + snapshot are modal-scoped since #11 / Bucket B dialog-scope; generic `--scope <@ref>` flag (FEAT-3) not shipped |
| BUG-3 `@e<n>` refs unstable across snapshots | **PARTIAL** — `ghax batch` auto-re-snapshots between ref steps (Bucket B); stable `@k:<hash>` keys not shipped |
| BUG-4 `ghax fill` can't write Monaco editors | **FIXED 2026-07-10** — fill auto-routes through `monaco.editor.getEditors()` |
| BUG-5 spurious `error sending request` RPC noise | **FIXED** — Bucket C: Rust CLI single-retries transient transport errors |
| BUG-6 tab IDs change across detach/re-attach | **OPEN** (low; workaround: re-discover via `tabs --filter`) |
| FEAT-1 capture request bodies (not just responses) | **FIXED 2026-07-10** — `requestBody` rides along with `--capture-bodies`; HAR `postData` |
| FEAT-2 first-class `ghax select` verb | **FIXED 2026-07-10** — see BUG-1 |
| FEAT-3 `--scope <@ref>` for click/fill | **OPEN** |
| FEAT-4 `ghax dismiss` | **OPEN** (low) |
| FEAT-5 Monaco-aware fill | **FIXED 2026-07-10** — see BUG-4 |
| FEAT-6 portal-aware selectors | **PARTIAL** — `ghax select` resolves portal-anchored dropdown options via `aria-controls`/`aria-owns`; general selector surface (click/fill) still portal-blind |

## Resolved / relocated

| Report | Where | Note |
|--------|-------|------|
| `2026-06-06-edge-attach-daemon-not-persisting.md` | `resolved/` | **FIXED 2026-07-10.** Daemon was spawned in the CLI's process group; harness/job-control group teardown killed it right after attach printed success, and its clean shutdown unlinked the state file. Now `setsid()`-detached; daemon log surfaced via `ghax status`. Resolution section in the report. |
| `2026-06-23-setsail-localhost-dev-session.md` | `resolved/` | Verdict was not-a-ghax-bug. DX recs shipped 2026-07-10: cookies scoped to active tab + redacted by default, `--all/--domain/--url/--values`, `--has <name>` exit-code assertion; README documents `eval`'s promise-awaiting. Residual: a general `eval --retry N` (Rec 4) wasn't added — Bucket C's nav-in-flight auto-retry covers the common case. |
| `CONDUIT-P2P-QUIC-BUG-2026-05-13.md` | moved to `conduit/docs/reports/` | Not a ghax issue. Resolved in conduit by removing the legacy direct-QUIC transport (#59). |

## Fixed without a report file (session-history finds, 2026-07-10)

| Item | Status |
|------|--------|
| Downloads in an attached browser landed in a temp dir as extension-less GUIDs (2026-05-23 PA session; misdiagnosed then as a server header issue) | **FIXED** — Playwright's `connectOverCDP` was hijacking `Browser.setDownloadBehavior`; daemon now re-asserts `behavior: 'allow'` into `~/Downloads` (or `--downloads-dir`), new `ghax downloads` verb |
| `ghax back`/`forward` hung ~30s on bfcache restores (found while greening the smoke suite) | **FIXED** — wait on `commit` instead of `domcontentloaded`, 15s backstop |
| Daemon died silently on stray async throws in CDP event handlers | **FIXED** — `unhandledRejection`/`uncaughtException` logged to daemon log, daemon survives |
| `ghax gif` crashed (exit 190) under ffmpeg 8.x when viewport size changed mid-recording | **FIXED** — frames letterboxed to first-frame dims via ffprobe before render; ffmpeg stderr tail now surfaced on failure |

## Filing a new report

Drop a dated markdown file in `open/` (`YYYY-MM-DD-<slug>.md`) with
Context / Repro / Expected / Notes sections, and add a row here. When the
last open item in a report ships, move the file to `resolved/` and update
this index.
