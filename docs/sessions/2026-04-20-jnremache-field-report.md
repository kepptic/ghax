# Field report — ghax in heavy, long-running session (2026-04-20)

**Operator**: Claude (Opus 4.7) driving user's Edge for ~8h across Google Ads
setup, GBP verification, SEO audit, NY DOS corp lookup, and ad-campaign
management.

**Target project**: `web-projects/jnremache` (WP migration + SEO + marketing).

**Verdict**: ghax was indispensable for the real-browser tasks (Google Ads form
navigation, GBP claim flow) that headless tools would've failed on. But the
long session surfaced a bunch of papercuts + a few real bugs. Documenting here
so the maintainer can triage.

---

## 🐛 Bugs (reproducible)

### BUG-JNR-01 — Daemon state lost silently; cryptic error on next call

**Severity**: medium (very disruptive when it hits)

**Repro**:
1. `ghax attach` (success)
2. Work for a while, do ~20 `eval` / `click` / `fill` calls
3. User quits + relaunches Edge (for any reason — here it was to switch tabs / profile)
4. Next `ghax <anything>` → `ghax: no daemon state at /Users/.../.ghax/ghax.json — run 'ghax attach' first`

But the **daemon process is still alive** — `ps aux | grep ghax` shows PID,
`curl http://127.0.0.1:$PORT/rpc` might respond. The *state file* is gone or
out of date, but the daemon isn't.

**Impact**: Every `eval` I issued after a browser restart returned that error.
I had to manually `ghax attach` again, re-resolve tab IDs, etc. The daemon
connection tracker knows when CDP disconnected — it should either:

- Automatically re-attach on the next command (probe `:9222`, re-sync, move on), OR
- Surface a more actionable error: *"Edge was restarted; run `ghax attach` to reconnect"*

**Second occurrence**: same session, after user quit + relaunched Chrome for
the 0424AG profile, tabs for Edge at `:9222` were still valid but daemon died.

---

### BUG-JNR-02 — Occasional `error sending request for url http://127.0.0.1:$PORT/rpc` mid-session

**Severity**: medium (flaky)

Seen twice in an 8h session, always on `ghax click` against a Google Ads
dialog after ~50+ commands. Daemon still alive; next `ghax attach` reconnected
fine. No error in daemon stderr that I could find.

Possible cause: the daemon's HTTP pool timing out idle connections? Or the RPC
client not retrying. Adding a single retry in the CLI shim would mask this
for users.

---

### BUG-JNR-03 — `@e` refs shift between clicks when DOM mutates

**Severity**: high (caused a real bug in the campaign setup)

**Repro (concrete)**: Google Ads business-hours step. Initial snapshot:

```
@e7 [checkbox] "Monday Closed"
@e8 [checkbox] "Tuesday Closed"
...
@e12 [checkbox] "Saturday Closed"
```

Issued `ghax click @e7`, `ghax click @e8`, ..., `ghax click @e11` sequentially
expecting to toggle Mon–Fri. But each click inserted opens/closes comboboxes
into the DOM, **shifting the `@e` IDs** of all subsequent elements. By the time
`@e11` fired, it was pointing at what had been Saturday.

Result: Saturday got toggled "Open" with no hours, causing a form validation
block on Save.

**Mitigation I used**: Re-snapshot between each click (10x slower) or use
`eval` with semantic lookup (`textContent === "Saturday Open"`).

**Ideal fix**: `@e` refs should be stable across DOM mutations within the same
navigation. Either:

1. Hash-based refs tied to element identity (aria-label + role + nth-of-type), or
2. `ghax batch-click @e7 @e8 @e9 @e10 @e11` that snapshots once and resolves all refs up-front, or
3. At least a doc warning: **"@e refs are valid only for the snapshot they came from."**

---

### BUG-JNR-04 — `ghax fill` silently no-ops on custom inputs (Material/Angular)

**Severity**: medium (forced workaround)

On Google Ads' Material chip + custom-input combobox fields, `ghax fill`
reported `{"ok": true}` but the input value was unchanged. Only way to set
values was raw JS using the React native setter:

```js
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
setter.call(input, value);
input.dispatchEvent(new Event("input", { bubbles: true }));
input.dispatchEvent(new Event("change", { bubbles: true }));
```

ghax could detect framework-managed inputs (React/Angular/Material) and use
this pattern automatically for `fill`.

---

### BUG-JNR-05 — `ghax click` succeeds but doesn't register for Material custom-role elements

**Severity**: medium

On Google Ads, some `[role=radio]` elements are `material-radio` wrappers.
`ghax click @e38` where `@e38` is a `[role=radio] "Admin"` reports success,
but the ARIA checked state never flips. `.click()` on the wrapper doesn't
dispatch the right event.

Workaround: find `material-radio` element and click it (triggers the correct
internal handler).

---

### BUG-JNR-06 — `snapshot -i` omits modal dialog content from ARIA tree

**Severity**: medium

When Google Ads opens a dialog (e.g. "Add images" file picker, "Crop image"
editor), `ghax snapshot -i` sometimes shows only the background page's
interactive elements, not the dialog's buttons/inputs. The dialog exists in
DOM — `document.querySelector("[role=dialog]")` finds it — but ghax's ARIA
walker skips it.

Workaround: fall back to `ghax eval` with raw `querySelectorAll`.

Possible cause: the ARIA walker stops at `aria-hidden="true"` ancestors, and
Google Ads sometimes marks the main app hidden when a dialog opens. So the
dialog should become the new root.

---

### BUG-JNR-07 — No `upload` command; must drop to raw CDP

**Severity**: medium (common task)

To upload a file to an `input[type=file]`, I wrote a 30-line Node + `ws` script
to send `DOM.setFileInputFiles` via CDP directly. This worked but feels like
an obvious first-class command:

```bash
ghax upload @e17 /path/to/file.jpg              # by @ref
ghax upload 'input[type=file]' /path/to/file.jpg # by selector
```

Uploaded 5 files to Google Ads this way in this session.

---

### BUG-JNR-08 — Chrome default-profile CDP is blocked by Chrome itself (doc gap)

**Severity**: low (documentation)

Tried `ghax attach --browser-url http://127.0.0.1:9223` against Chrome launched
with `--remote-debugging-port=9223 --profile-directory="Profile 3"`.

Chrome logs: `"DevTools remote debugging requires a non-default data
directory. Specify this using --user-data-dir."`

This is Chrome's security mitigation (since ~v113) against malware using CDP
to hijack logged-in sessions. It's not a ghax bug but it bites users who
reasonably assume Chrome works the same as Edge. Would be great to have a
doc note + maybe a pre-flight check in `ghax attach --launch` that warns
about the default-dir restriction.

---

## 🪙 Token / context optimization (LLM-operator perspective)

This is specifically about ghax being driven by an LLM, where every byte of
output consumes context window and every call has a cost. ghax's current
output is tuned for humans — great for terminal review, wasteful for LLMs.

### TOK-01 — `snapshot -i` output is massive and hard to filter

On a page like Google Ads campaign settings, `ghax snapshot -i` returned
**~8 KB** of ARIA tree + cursor-interactive tree. In one session, ~30% of my
context was spent on snapshots where I only needed a handful of `@e` refs.

Typical usage became:

```bash
ghax snapshot -i 2>&1 | grep -E "checkbox|button.*Next|Save|Cancel" | head -15
```

Every snapshot call → piped through grep → tokens for the pipeline noise +
tokens for what grep dropped that I re-ran if my filter was wrong.

**Proposed flags**:

```bash
ghax snapshot --role checkbox,button,radio       # filter by ARIA role
ghax snapshot --text "Next|Save|Cancel"          # filter by text match
ghax snapshot --within '[role=dialog]'           # only elements inside dialog
ghax snapshot --limit 20                         # cap output
ghax snapshot --format compact                   # one element per line, drop @c refs unless asked
```

Even just `--format compact` that drops the cursor-interactive section by
default would cut snapshots in half. Most LLM-operators don't need both trees
in the same call.

### TOK-02 — `eval` returns un-truncated body; no built-in truncation

Pattern I used constantly:

```bash
ghax eval '({ body: document.body.innerText.substring(0, 1500) })'
```

Every single `eval` call that needed page content had a hand-coded
`.substring(0, N)`. Easy to forget — when I forgot, I got 50+ KB dumps that
blew my context budget.

**Proposed**: `ghax eval --max-bytes 4096 <js>` that truncates the JSON
response. Applies to any field — user's `body.innerText`, `document.title`,
etc. Also `--max-depth 3` for nested objects (React devtools-style).

### TOK-03 — Errors include multi-line stack traces + boilerplate

When `ghax click @e17` fails:

```
ghax: error sending request for url (http://127.0.0.1:59329/rpc)
{
  "url": "https://ads.google.com/aw/...",
  ...
}
```

The `"url"` field alone is often 200+ bytes of query-param noise. Adds up
across 400 commands/session. Consider an `--error-format compact` mode that
emits one line: `error: rpc-send-failed (url too long)`.

### TOK-04 — `ghax tabs` full URL dump ate tokens

User's Edge had 15+ tabs open. Each `ghax tabs` call returned:

```json
{"id":"FE69782F...","title":"J&N Remache Corp.","url":"https://www.jnremache.com/wp-admin/admin.php?page=rank-math&ocid=..."}
{"id":"DDA16C8B...","title":"Overview - 704-259-8127 - Google Ads","url":"https://ads.google.com/aw/overview?ocid=8183021726&euid=6484604306&__u=8714385794&uscid=8183021726&__c=2023875374&authuser=0"}
...
```

15 × ~250 bytes = 3.7 KB per call. I ran this ~20 times.

Every Google Ads URL has ~200 bytes of repeated query-string garbage
(`ocid`, `euid`, `__u`, `uscid`, `__c`, `authuser`). Workaround was always
`ghax tabs | python3 -c "import json,sys; ..."`.

**Proposed**:

```bash
ghax tabs --filter 'url~ads.google'              # regex filter server-side
ghax tabs --fields id,title                      # drop URL entirely when not needed
ghax find <pattern>                              # already exists — but returns URL too
```

Or `ghax tabs --compact` that shortens URLs to `<origin>/<path>?…`.

### TOK-05 — Screenshots round-trip via disk

Current flow for an LLM: `ghax screenshot --path /tmp/foo.png` → then Read
tool with that path → tokens for the path string, the "path" field in
response, the tool's ack, then the image. Four round-trips for one picture.

In Anthropic's tool API, images can be returned inline as content blocks.
ghax doesn't have to know about that directly — but a stdout-safe
base64/data-URL output option (`ghax screenshot --stdout base64`) would let
the harness (Claude Code, Cursor, etc.) inline the image without the disk
hop.

### TOK-06 — Pre-rendered dialogs in DOM inflate `eval` output

Google Ads pre-renders ~15 `[role=dialog]` templates in DOM, all with
contents. So:

```bash
ghax eval '({ dialogs: Array.from(document.querySelectorAll("[role=dialog]")).map(d => d.innerText.substring(0,300)) })'
```

returned **12 dialogs** — 11 of which were invisible pre-renders and
irrelevant. My filter `.filter(d => d && visible)` had to be hand-added.

Not strictly a ghax problem, but a snapshot option like `--visible-only`
(filter to `getClientRects().length > 0` + non-zero opacity + not `display:
none` ancestor) would cut noise on any React/Angular app.

### TOK-07 — `status`/`attach` call-overhead on every session boot

Every session:

```
$ ghax attach
already attached — pid 22001, port 59329, browser edge
```

That's ~60 tokens for a confirmation I don't need if I'm about to issue
commands anyway. Could be silent-on-success (POSIX convention) with
`--verbose` to opt in. Same with `status` — JSON dump is fine for tooling,
but the current human-readable format has ~10 lines I usually don't need.

### TOK-08 — No de-duplication between @e and @c refs

Same element often appears as `@e42 [checkbox] "Monday Open"` and then
again in cursor-interactive as `@c107 [cursor:pointer] "Monday"`. For LLM
operators this is ambiguity (which do I click?), not helpful redundancy.

**Proposed**: in `--format compact` mode, only emit the ARIA `@e` if the
element has a role; skip its `@c` entry.

### TOK-09 — No way to batch related operations

For setting hours on 5 weekdays:

```bash
ghax click @e7   # 1 round-trip
ghax click @e8   # 1 round-trip
...
```

That's 5 shell invocations × ~300 bytes response each = 1.5 KB of "ok"
replies.

```bash
ghax batch '[{"click":"@e7"},{"click":"@e8"},{"fill":["@e12","1.00"]}]'
```

One call, one response, atomic re-snapshot between steps (would also fix
BUG-JNR-03 naturally).

### TOK-10 — `text` command doesn't exist but would save eval calls

I typed `ghax eval 'document.body.innerText.substring(0, 500)'` ~40 times.
ghax has `text` and `html` commands already (per `--help`) — but they
returned the full page (unbounded). An implicit truncation default would
help:

```bash
ghax text                              # default: first 2000 chars
ghax text --length 500 --skip 1000     # slice control for LLM-friendly paging
ghax text '[role=main]'                # scoped to selector
```

---

### Summary of token cost for this session

Rough estimate for the 8h session:

| Source | Tokens |
|---|---|
| `ghax snapshot -i` output (unfiltered portions) | ~80 KB |
| `ghax tabs` URL dumps | ~20 KB |
| `ghax eval` un-truncated results | ~40 KB |
| RPC error responses / retries | ~8 KB |
| `ghax attach` confirmations | ~2 KB |
| **Total ghax I/O in context** | **~150 KB** (~37K tokens) |

Rough useful content from that: maybe 10%. The other 90% was scaffolding,
repeated URL query params, and dialog pre-renders.

At current LLM pricing that's a few dollars per long session, and the
*opportunity cost* — wasted context that could have held the user's
conversation — is the bigger deal.

**Low-hanging fruit**: default `--format compact` on snapshot, add
`--max-bytes` to eval, strip Google's query-param noise from tabs output.
These 3 would probably cut ghax's token footprint 50%+ without changing
any semantics.

---

## 💡 UX / wishlist

### GHAX-FR-01 — `ghax eval` navigation-safe by default

On navigation mid-`eval`, you get cryptic:

```
ghax: page.evaluate: Execution context was destroyed, most likely because of a navigation
```

The CLI exits non-zero. A one-line retry (wait for `load`, re-evaluate) would
make `window.location = "..."` + next `eval` work as a two-liner instead of
needing a manual `sleep 5`.

### GHAX-FR-02 — `ghax wait --selector ... --timeout ...` more prominent

I saw `wait` in help but kept falling back to `sleep 3`. A `wait` that polls
`querySelector` + returns when found (or timeout) would eliminate most
`sleep`s in my scripts. (Maybe it already does this — docs example would
help.)

### GHAX-FR-03 — Better `--help` for `attach`

Specifically call out:

- The `GHAX_DAEMON_BUNDLE` env var. I had to dig to find
  `/Users/.../.local/share/ghax/ghax-daemon.mjs` after an install.
- What happens when `:9222` port scan finds multiple browsers. (I got a picker
  once; worked fine, but it was a surprise.)

### GHAX-FR-04 — `ghax status` should include "tabs context"

After a long session, `ghax status` shows `tabs: 17`. I never know which is
"active" — the one my next `eval` will target — without running `ghax tabs`
and diffing. A one-line "active: `<id>` `<title>`" in `status` would help.

### GHAX-FR-05 — Rate-limit / recovery for Google's anti-automation

Google Ads has a "You got disconnected — To make sure your work is saved,
try signing in again on the next screen" modal that interrupts 2+ rapid form
submissions on high-risk operations (granting admin access, claiming
credit). It's effectively a soft block on automation.

Not really fixable in ghax, but worth noting in docs as a known class of
failure: **Google product form submissions that grant access / money rights
are anti-bot-hardened. Expect 2/5 attempts to trigger a disconnect modal;
user must click "Continue" once, then retry.**

### GHAX-FR-06 — `ghax screenshot` --full-page flag name

I typed `--fullPage` (camelCase) and it worked. Also tried `--full-page`
first — didn't work. Accepting both would match ghax's other flag style
which is mostly kebab.

---

## ✨ Things that worked great (credit where due)

- **`ghax attach` auto-scan** found Edge on `:9222` instantly. No config.
- **`@e` refs in snapshot** are the killer feature — way clearer than XPath
  for LLM-driven interaction. Even with BUG-JNR-03, the payoff is enormous.
- **Cursor-interactive `@c` refs** surfaced clickable divs that weren't in
  the ARIA tree (Google Ads has a lot of these). Saved me multiple times.
- **`ghax eval` handoff** to raw JS is pragmatic — when the high-level
  abstractions fail, you've always got the escape hatch.
- **`ghax goto <url>`** + auto-wait is rock solid. I navigated ~40 pages
  in this session without a single hang.
- **Persistent daemon** across commands meant `ghax eval` calls felt
  interactive; round-trip was ~100ms, not the multi-second startup of
  Playwright scripts.
- **`ghax tabs` JSON output** piped cleanly into Python — easy tab ID
  extraction for multi-tab Google workflows.

---

## 🔬 Session stats

- Commands issued: ~400+ (`ghax goto`, `eval`, `click`, `fill`, `snapshot`, `screenshot`, `tabs`, `tab`)
- Browsers driven: Edge (primary, :9222), Chrome (briefly — hit BUG-JNR-08)
- Products navigated: Google Ads, Google Business Profile, Search Console,
  Google Maps, Cloudflare dashboard, WordPress admin, Bizapedia,
  OpenCorporates, NYBizDB
- Files uploaded via raw CDP: 5 (to Google Ads image picker)
- Bugs hit that forced workaround: 4 (JNR-03, 04, 05, 07)
- Bugs that blocked entirely: 0 (every failure had an `eval` escape hatch)

---

## Repro commands for BUG-JNR-03 (most concrete)

```bash
# Start a fresh Edge with CDP
/Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge --remote-debugging-port=9222 &

export PATH="$HOME/.local/bin:$PATH"
export GHAX_DAEMON_BUNDLE=/Users/gr/.local/share/ghax/ghax-daemon.mjs
ghax attach
ghax goto "https://ads.google.com/aw/campaigns/new/express?..."  # business-hours step

# Snapshot — note current @e refs for Mon–Fri checkboxes
ghax snapshot -i | grep checkbox

# Click each in sequence — expect to toggle 5 days open
ghax click @e7   # Monday — works
ghax click @e8   # Tuesday — but now @e8 points to Tuesday's *open-time input*, not Tuesday checkbox
ghax click @e9   # ... refs have shifted further
...

# Observe: Saturday ends up toggled
ghax snapshot -i | grep "Saturday Open.*checked"
```

The fix is semantic resolution on every click — accept that @e refs are a
transient view of the tree, not a stable identifier.

---

## Suggested triage (maintainer's call)

| Bug | Severity | Effort | Note |
|---|---|---|---|
| JNR-03 (ref shifting) | high | medium | Biggest blocker for form workflows |
| JNR-07 (no upload) | medium | small | Common task; CDP code is straightforward |
| JNR-01 (daemon state lost) | medium | small | Auto-retry on state-file-missing |
| JNR-04 (fill on React) | medium | small | Detect-and-fall-back is well-documented pattern |
| JNR-06 (dialog ARIA walker) | medium | medium | Dialog-aware tree root |
| JNR-08 (Chrome default profile) | low | trivial | Doc note |
| JNR-02 (flaky RPC) | low | trivial | Single CLI-shim retry |
| JNR-05 (Material radio click) | low | small | Try inner click + outer fallback |
| **TOK-01** (compact snapshot format) | **high ROI** | small | Single flag, 50%+ token cut |
| **TOK-02** (eval --max-bytes) | **high ROI** | trivial | Protects against context blowouts |
| **TOK-04** (tabs --filter / --fields) | medium ROI | small | Server-side filter beats client-side grep |
| TOK-09 (batch op) | medium ROI | medium | Also fixes JNR-03 naturally |
| TOK-05 (screenshot stdout) | medium ROI | medium | Saves disk round-trip |
| TOK-07 (quiet attach) | low ROI | trivial | POSIX convention |

Happy to provide more repro details, minimal test cases, or PRs for any of
these if useful.
