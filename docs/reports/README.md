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
not in the reports.

Last audit: **2026-07-10** (full sweep of reports + claudectl session history).

## Open items by report

### `open/2026-06-06-edge-attach-daemon-not-persisting.md` — CRITICAL

| Item | Status |
|------|--------|
| `ghax attach` reports success but daemon is immediately gone; follow-up commands fail with "daemon (pid N) is not running" | **OPEN** — reproduced twice on 2026-06-06, *after* the 0.4.3 attach fixes (XDG daemon resolution, `010182b`). Distinct failure. Fix in progress 2026-07-10. |

### `open/FIELD-REPORT-2026-04-30-DATTO-RMM.md`

| Item | Status |
|------|--------|
| BUG-1 AntD `<Select>` won't open via `ghax click` | **OPEN** — fix via FEAT-2 |
| BUG-2 `:has-text()` hits wrong/hidden surface | **PARTIAL** — click + snapshot are modal-scoped since #11 / Bucket B dialog-scope; generic `--scope <@ref>` flag (FEAT-3) not shipped |
| BUG-3 `@e<n>` refs unstable across snapshots | **PARTIAL** — `ghax batch` auto-re-snapshots between ref steps (Bucket B); stable `@k:<hash>` keys not shipped |
| BUG-4 `ghax fill` can't write Monaco editors | **OPEN** — fix in progress 2026-07-10 |
| BUG-5 spurious `error sending request` RPC noise | **FIXED** — Bucket C: Rust CLI single-retries transient transport errors |
| BUG-6 tab IDs change across detach/re-attach | **OPEN** (low; workaround: re-discover via `tabs --filter`) |
| FEAT-1 capture request bodies (not just responses) | **OPEN** — fix in progress 2026-07-10 |
| FEAT-2 first-class `ghax select` verb | **OPEN** — fix in progress 2026-07-10 |
| FEAT-3 `--scope <@ref>` for click/fill | **OPEN** |
| FEAT-4 `ghax dismiss` | **OPEN** (low) |
| FEAT-5 Monaco-aware fill | see BUG-4 |
| FEAT-6 portal-aware selectors | **OPEN** (medium) |

### `open/2026-06-23-setsail-localhost-dev-session.md`

Verdict was **not a ghax defect** (app-side fetch flake + React hooks crash);
the DX recommendations remain:

| Item | Status |
|------|--------|
| Rec-1 scope `ghax cookies` to current tab by default (`--all` opt-out), `--domain`/`--url` filters, redact values unless `--values` | **OPEN** — fix in progress 2026-07-10 |
| Rec-2 `ghax cookies --has <name>` (exit 0/1) auth assertion | **OPEN** — fix in progress 2026-07-10 |
| Rec-3 document that `ghax eval` awaits promises | **OPEN** — fix in progress 2026-07-10 |
| Rec-4 retry/wait ergonomics for slow same-origin POSTs | **PARTIAL** — Bucket C eval nav-in-flight auto-retry covers the nav case |

### Downloads misbehavior (no dedicated report file — from 2026-05-23 PA session + user report 2026-07-10) — CRITICAL

| Item | Status |
|------|--------|
| Downloads in a ghax-attached browser land in a temp dir with UUID filenames and no extension, instead of `~/Downloads` with the site-suggested name | **OPEN** — fix in progress 2026-07-10. Root cause: Playwright's `connectOverCDP` issues `Browser.setDownloadBehavior` pointing at its own artifacts dir with GUID naming, hijacking the profile's normal download flow. The 2026-05-23 session misdiagnosed this as a missing `Content-Disposition` header. |

## Resolved / relocated

| Report | Where | Note |
|--------|-------|------|
| `CONDUIT-P2P-QUIC-BUG-2026-05-13.md` | moved to `conduit/docs/reports/` | Not a ghax issue. Resolved in conduit by removing the legacy direct-QUIC transport (#59). |

## Filing a new report

Drop a dated markdown file in `open/` (`YYYY-MM-DD-<slug>.md`) with
Context / Repro / Expected / Notes sections, and add a row here. When the
last open item in a report ships, move the file to `resolved/` and update
this index.
