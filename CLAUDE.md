@AGENTS.md

# ghax — Claude Code notes

AGENTS.md (imported above) holds the project overview, the five hard
invariants, build/test commands and the add-a-verb steps. This file adds
only Claude-specific detail and workflow recipes. Humans: CONTRIBUTING.md.

## Invariant details AGENTS.md leaves out

- **#3 refs:** a smoke check asserts that a stale ref from tab A can't
  resolve against tab B.
- **#4 daemon restart:** `npm run build` runs `scripts/build-daemon.mjs`
  (esbuild JS API, stamps `{version, gitSha, buildDate}` via `define`) and
  writes `extension/build-info.js`, which the bridge extension imports at
  SW load (a stale worker keeps reporting its old version) as its only
  provenance. `ghax version --full` shows CLI, running daemon and bridge
  extension side by side and warns on a mismatch: the fast way to catch a
  stale daemon bundle or an extension not reloaded after a pull.

## Common workflows

### QA a site end-to-end

```bash
ghax attach
ghax qa --url https://example.com --out /tmp/report.json
# Produces {urlsAttempted, urlsOk, pages: [{url, refCount, consoleErrors, failedRequests, screenshotPath?}]}
```

### Debug why a page is slow

```bash
ghax goto https://target.com
ghax perf --wait 2000    # let SPA hydration settle
# Returns LCP (with size + URL), FCP, CLS, TTFB, longTaskCount, full navTiming
```

### Test a Chrome extension after rebuild

```bash
ghax attach
ghax ext list                  # find your ext-id
ghax ext hot-reload <ext-id>   # reload SW + re-inject content scripts
# Returns { ok, tabs: [...], swVersion, durationMs }
```

### Inject a CSS fix preview before editing source

```bash
ghax try --css '.wrapper { width: max-content }' \
         --measure 'document.querySelector(".wrapper").offsetWidth' \
         --shot /tmp/preview.png
# Returns { value: <new width>, shot: '/tmp/preview.png' }
# Revert by reloading the page.
```

### Run many commands fast (multi-turn agent sessions)

```bash
cat <<'EOF' | ghax shell
goto https://target.com
wait 500
snapshot -i
click @e3
text
perf
exit
EOF
```

One process, no per-command spawn cost. ~1.8x faster than separate
`ghax <cmd>` invocations. For interactive use (TTY), just `ghax shell`
and type commands at the prompt. `exit`/`quit`/Ctrl-D to leave. Blank
lines and `#` lines are ignored. Quoting works like a real shell:
`try --css 'body { color: red }'` passes the whole CSS intact.

### Run a plan in one round-trip (stable refs across the sequence)

```bash
ghax batch '[
  {"cmd":"goto","args":["https://app.example.com/settings"]},
  {"cmd":"snapshot","opts":{"interactive":true}},
  {"cmd":"click","args":["@e7"]},
  {"cmd":"wait","args":["200"]},
  {"cmd":"fill","args":["@e9","new-value"]},
  {"cmd":"click","args":["@e11"]}
]'
```

Unlike `chain` (reads stdin, N round-trips), `batch` ships the whole
plan in one RPC. Between steps that reference `@e<n>` refs, the
daemon auto-re-snapshots when the page changed (freshness marker), so
opening a combobox mid-plan doesn't reindex refs out from under you;
each such step reports `autoSnapshot: "skipped" | "taken"`. Pass `--no-auto-snapshot` for
strict one-shot semantics.

### Share the browser with a user who's actively working

```bash
# Agent side:
export GHAX_STATE_FILE=/tmp/ghax-agent.json
ghax attach
tab=$(ghax new-window https://target.com --json | jq -r .id)
# Work in $tab — user's other tabs/windows untouched, no focus steal.
```

### Multi-agent parallel work (two agents, two apps)

```bash
# Agent A (Setsail work)
GHAX_STATE_FILE=/tmp/ghax-setsail.json ghax attach
GHAX_STATE_FILE=/tmp/ghax-setsail.json ghax new-window https://setsail.app

# Agent B (Conduit work)
GHAX_STATE_FILE=/tmp/ghax-conduit.json ghax attach
GHAX_STATE_FILE=/tmp/ghax-conduit.json ghax new-window https://conduit-dash.dagtech.com
```

Each agent has its own daemon + window. They share the browser process
(same profile, same auth) but can't see each other's active-tab pointer.

### Multi-agent over the bridge (the user's REAL session)

```bash
# Agent A
GHAX_STATE_FILE=/tmp/ghax-a.json ghax attach --extension --control-active

# Agent B — port 9223 is taken, so this daemon auto-picks 9224 and prints it
GHAX_STATE_FILE=/tmp/ghax-b.json ghax attach --extension
GHAX_STATE_FILE=/tmp/ghax-b.json ghax new-window https://target.example
```

Same shape as above, over `chrome.debugger` instead of CDP. Two rules that
don't apply on the CDP transport:

- **One tab, one agent.** `ghax tab <id>` / `bridge control --tab-id` /
  `control --active` on a tab another agent drives is REFUSED, naming the
  owning bridge port. Read `controlledBy` in `ghax tabs` before pointing at
  a tab, or just use `new-window`.
- **The extension must be reloaded** in `edge://extensions` after a ghax
  update — a pre-v0.3 extension dials only the base port, so agent B's
  daemon waits forever for a connection it will never get.

See `design/plan/09-bridge-multi-agent.md`.

## Smoke-test browser

`npm run test:smoke` needs a Chromium browser on `--remote-debugging-port=9222`
WITH a non-default `--user-data-dir` (Edge 150+/Chrome 136+ ignore the port on
the default profile). `ghax attach --launch` does both. Bigger changes also run
`npm run test:cross-browser` and `npm run test:benchmark`.

## Before committing

1. Typecheck, lint, fmt, clippy and smoke pass.
2. Every new flag / verb / RPC has a smoke check.
3. `CHANGELOG.md` under `## [Unreleased]` has an entry for the change.
4. If the change is user-facing: `README.md` command surface reflects it.
5. If the change affects how to work in the codebase: `CONTRIBUTING.md`
   updated.
6. If the change is architectural: `ARCHITECTURE.md` updated, and maybe
   a note in `design/plan/04-roadmap.md`.
7. **Every merge to `main` that passes CI can cut a release** —
   `auto-release.yml` classifies your commits since the last tag (see
   `docs/release-automation.md`). So #3 above isn't just hygiene: an
   empty `[Unreleased]` blocks the release entirely (refuses rather than
   shipping headline-less notes), and your commit's Conventional-Commits
   type (`feat`/`fix`/`docs`/...) *is* the version-bump decision. Get the
   type right, or add a `Release-As: X.Y.Z` trailer / `[skip release]` in
   the subject to override it.

## What's intentionally NOT here

These were considered and deferred. Don't try to add them without a
design discussion:

- **Multi-tenant `ghax pair`** — bearer-token auth on a
  network-exposed daemon. Deferred because any RPC bug becomes remote
  code execution. The shipped SSH-tunnel mode covers the "me on
  another machine" case.
- **Skill acceptance eval harness** — scripted Claude API calls
  against the skills with tool-call assertions. Deferred indefinitely
  because the 95-check E2E smoke catches the same regressions at zero
  API cost.
- ~~Source-map resolution for stack frames.~~ Shipped — opt-in via
  `ghax console --source-maps`.
- ~~Request/response body capture.~~ Shipped — opt-in via
  `ghax attach --capture-bodies[=<glob>]`.
- ~~XPath surface + bounding-box command.~~ Shipped — `ghax xpath`,
  `ghax box`, plus `xpath=//...` prefix works on every selector arg.
- **CPU flame graph export**. `ghax profile` captures point-in-time
  metrics + heap snapshots, not CPU traces. No plans to add.

## Questions or blockers

For design-level questions, read the five docs under
[`design/plan/`](./design/plan/) in order. They're session-by-session
captures of the reasoning as the project evolved — not API reference,
but "why is it this way" documentation.

If a test fails that you can't explain, check the "Daemon restart
required" invariant above. It's the single most common source of
confusion.

