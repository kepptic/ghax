# Sprint: Bucket A — payload reduction + first-class upload

## Goal

Ship the six "high-ROI, same theme as item 10" items from the
2026-04-20 jnremache field report (see `plan.md` follow-up sprint
section, Bucket A). Every item cuts payload size sent to an LLM
operator, or removes a papercut the operator hand-rolled in
JavaScript during the field session.

All six are narrow, backend-facing changes: new daemon options +
thin CLI wiring. Each is verifiable with one smoke assertion.

## Tasks

1. [x] `screenshot --full-page` kebab alias (GHAX-FR-06). Currently
   only `--fullPage` works; the kebab form is the convention
   everywhere else in the CLI. Add the alias in the daemon's
   `screenshot` handler. Trivial.
2. [x] `tabs --filter <regex> --fields <csv>` (TOK-04). Server-side
   regex filter on URL + title, field projection on the returned
   objects. Cuts ~200 bytes per google-product tab when filtering.
3. [x] `eval --max-bytes <N>` (TOK-02). Server-side truncation on
   the stringified result. Protects LLM operators from accidental
   context blow-outs. Returns `{value, truncated: true, originalBytes}`
   when it trips.
4. [x] `text --selector <sel> --length <N> --skip <M>` (TOK-10).
   Scoped, paged page-text dumps. Replaces hand-rolled
   `document.body.innerText.substring(...)`.
5. [x] `upload <@ref|selector> <path>` (JNR-07). First-class file
   upload verb wrapping Playwright's `locator.setInputFiles`. Used
   5x in the field session via a hand-written shim.
6. [ ] `snapshot --compact` suppresses cursor-interactive pass
   (TOK-01). Today `--compact` only drops noise nodes from the
   ARIA tree; the cursor-interactive section still runs whenever
   `-i` is set and dominates the output on heavy SPAs. Gate the
   cursor pass on `!opts.compact` so `-i --compact` gives the
   interactive tree without the cursor bloat.

## Acceptance criteria

- Every new flag has a smoke check in `test/smoke.ts`.
- `npm run typecheck`, `npm run build`, `cargo build --release`,
  and `npm run test:smoke` all green against the Rust binary
  (`GHAX_BIN=$PWD/target/release/ghax npm run test:smoke`).
- `CHANGELOG.md` under `[Unreleased]` lists all six items.
- `README.md` command surface mentions each new flag.
- No new runtime deps (zero — all implementations are Playwright
  features already in the dep tree).

## Deferred

(Populated during the run if items slip scope.)

## Queued decisions

(Empty at plan time.)
