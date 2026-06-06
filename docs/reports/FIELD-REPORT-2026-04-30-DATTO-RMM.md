# Field report — driving Datto RMM via ghax (2026-04-30)

**Reporter:** Claude (via Tao session, G's PA workspace)
**Target app:** Datto RMM (concord.rmm.datto.com — React + Apollo + AntD)
**ghax version:** 0.4.1 (pre-release / current `main`)
**Browser:** Edge 147 with `--remote-debugging-port=9222`
**Session goal:** create two Datto RMM components (a macOS monitor + a macOS remediation script) and a monitoring policy that wires them together, by intercepting Datto's internal Apollo GraphQL mutations.

This is a mix of bug reports and feature requests, drawn from a real session that produced two saved components and one captured GraphQL mutation (`saveComponent`). The policy creation step bogged down on UI-driving friction and was handed back to the user. Issues are ranked at the bottom by leverage (highest impact first).

---

## Summary

ghax was the right tool — there is no substitute for driving someone's real, logged-in Datto session. The session ultimately succeeded because of two escape hatches: `ghax network --pattern 'graphql'` to reverse-engineer the API, and `ghax eval` to traverse React fibers and call AntD `<Select>` `onChange` handlers directly.

Most of the time spent debugging was due to AntD's pointer-event handling not matching ghax's trusted-click semantics, refs shifting between snapshots, and `:has-text()` selectors hitting the wrong UI surface (popovers, side panels, search bars). Those frictions are addressable.

What's already excellent: `ghax network`, `ghax eval`, the network capture, screenshots, accessibility-tree snapshots. The escape hatches saved the session — but the path *to* the escape hatches is what needs work.

---

## Bug reports

### BUG-1 — `ghax click` does not open AntD `<Select>` dropdowns

**Repro:** Open any AntD-based React app with a `<Select>` (e.g., the Datto RMM Component create form, the Script Type dropdown that defaults to "Batch"). Get the `@e<num>` ref from `ghax snapshot -i`. Run `ghax click @e<num>`. The dropdown does not open. No options become visible. `ghax eval '(() => Array.from(document.querySelectorAll(".ant-select-item-option")).map(o=>o.textContent.trim()))()'` returns an empty array.

**Tried (all failed):**

- `ghax click @e<ref>` (the ARIA combobox ref)
- `ghax click '[id="variables_0_componentVariableType"]'` (the hidden input id)
- `ghax click '.ant-select:has(.ant-select-selection-item:text("Batch"))'` (parent select)
- Programmatic `dispatchEvent` of `pointerdown` / `mousedown` / `mouseup` / `click` at the bounding-box centre via `ghax eval`
- Focusing the input via `ghax eval` then `ghax press 'ArrowDown'`

**Workaround that worked:** Sometimes a click on the `.ant-select-selector` (CSS) opens it, sometimes not — non-deterministic. The reliable path is React fiber traversal:

```js
function setSelectByFiber(inputId, value) {
  const inp = document.querySelector(inputId);
  const sel = inp.closest('.ant-select');
  const fk = Object.keys(sel).find(k => k.startsWith('__reactFiber'));
  let f = sel[fk];
  while (f) {
    if (f.memoizedProps?.onChange) {
      f.memoizedProps.onChange(value);
      return true;
    }
    f = f.return;
  }
  return false;
}
```

This bypasses the dropdown UI entirely and writes directly into React state. AntD's controlled-Select pattern is well-defined, so the fiber path is robust across versions.

**Proposed fix:** Detect AntD `<Select>` markers (`.ant-select`, `.ant-select-selection-item`) inside `ghax click` and either (a) dispatch the specific event sequence AntD's pointer handler expects, or (b) expose a first-class `ghax select <ref> <value>` verb that uses the fiber traversal under the hood. Both behaviors are useful. The latter is also helpful for native `<select>`, `react-select`, Headless UI Listbox, etc.

**Priority:** High. AntD is in every enterprise admin UI we touch (Datto RMM, Splunk, internal MSP tooling). This is the single biggest blocker.

---

### BUG-2 — `:has-text()` matches first DOM occurrence, not the visible / active one

**Repro:** On the Datto RMM Component Library page, a global search bar in the page header has buttons with text "Select" inside its autocomplete popover. The Component create form also has buttons labeled "Select" for variable types and Monitor types. Running `ghax click 'button:has-text("Select")'` while a Component-Type picker is open in a side panel still hits the global-search popover button (which navigates away from the form).

**Workaround:** Capture `@e<num>` refs from `ghax snapshot -i` and click those — but they shift between snapshots (see BUG-3).

**Proposed fix:** `ghax click` should prefer (in order):

1. Elements inside the most-recently-focused modal/dialog/popover.
2. Elements within the viewport.
3. Elements not behind a backdrop / inert tree.

A `--scope <ref>` flag for `ghax click` and `ghax fill` that constrains the locator to descendants of `ref` would also fix this cleanly.

**Priority:** High. This was the proximate cause of two destructive-feeling navigations during the policy-creation attempt (form work was lost).

---

### BUG-3 — `@e<num>` refs from `ghax snapshot -i` are not stable across snapshots

**Repro:** `ghax snapshot -i` then click a button that changes the form (e.g., switch tab from Applications to Monitors). `ghax snapshot -i` again — every `@e<num>` may have shifted by one or more positions. Refs cached in a script become invalid.

**Workaround:** Re-snapshot before every click. Slow and fragile.

**Proposed fix:** Add a stable-key option (`@k:<hash>`) where the hash is derived from `(role, accessible-name, parent-role-chain)` — i.e., the same logical element gets the same key across snapshots. Existing `@e<num>` should remain (it's terse and convenient for one-shot lookups), but persistent scripts should be able to opt into stable keys.

**Priority:** Medium-high. Mitigatable but adds latency and complexity to every multi-step flow.

---

### BUG-4 — `ghax fill` does not work on Monaco editors

**Repro:** Datto's Component create form uses Monaco for the script editor. Snapshot shows it as `[textbox] "Editor content;Press Alt+F1 for Accessibility Options."`. `ghax fill @e<ref> 'some script'` — no effect. The editor stays empty.

**Workaround:** `ghax eval` with `monaco.editor.getEditors()[0].setValue(<source>)`. Works perfectly because Monaco's editor model API is stable.

**Proposed fix:** `ghax fill` should detect Monaco containers (`.monaco-editor` or `[data-mode-id]`) and route through `monaco.editor.getEditors()` automatically. Common in modern admin UIs — Datto, Splunk, Grafana, Postman, GitLab Web IDE all use Monaco.

**Priority:** Medium. Reliable workaround exists; abstracting it would still cut boilerplate.

---

### BUG-5 — Daemon RPC errors appear non-deterministically but commands succeed

**Repro:** Running any sequence of ghax commands in a single session, e.g.:

```bash
ghax click @e31
ghax fill @e28 'name'
ghax fill @e29 'description'
ghax click @e34
```

Roughly 30–50% of commands print `ghax: error sending request for url (http://127.0.0.1:65041/rpc)` to stderr, but stdout still shows the command's normal `{ ok: true }` and the action *did* take effect. The exit code is 0.

**Impact:** Hard to distinguish actual failures from this noise. Scripts that grep stderr for "error" will produce false alarms.

**Proposed fix:** Silent retry with backoff in the CLI's RPC layer (1–3 retries before surfacing). Or downgrade these to `--verbose`-only logs.

**Priority:** Low (cosmetic) but very visible.

---

### BUG-6 — Tab IDs change after `detach` then re-`attach` with different flags

**Repro:**

```bash
ghax attach
ghax tabs   # records tab T1 = "0F2A35..."
ghax detach
ghax attach --capture-bodies='*graphql*'
ghax tabs   # tab T1 is now "CEA9...", or completely missing
```

The user's actual browser tabs didn't change — only ghax's internal IDs. Saved tab references in scripts become stale.

**Proposed fix:** Stable tab IDs across re-attaches by hashing `(window-id, target-id, content-url)` so the same physical tab gets the same ID. Or persist the daemon state file across re-attaches when only flags change.

**Priority:** Medium. Annoying for stateful flows; trivially worked-around with `ghax tabs | grep <url>` re-discovery.

---

## Feature requests

### FEAT-1 — Capture GraphQL request bodies, not just responses

**Why:** `--capture-bodies` records JSON/text response bodies. To reverse-engineer an API mutation (mutation name + input variables) you also need the **request** payload. I had to read from `__APOLLO_CLIENT__.queryManager.mutationStore` via `ghax eval` to recover the variables — works for Apollo apps but is fragile and Apollo-specific.

**Proposed:** Add `--capture-requests` flag (or include `requestBody` field on records produced by `--capture-bodies`). Keep the 32 KB cap, opt-in only.

**Priority:** High. This is the difference between "capture once, replay forever" and "every replay needs a new capture round-trip."

---

### FEAT-2 — First-class `ghax select` verb (companion to `ghax fill`)

**Why:** Setting a value in a non-native dropdown (AntD `<Select>`, `react-select`, Headless UI Listbox, MUI `<Select>`, native `<select>`) is its own primitive. Today you do it via `ghax click` to open + `ghax click` on the option, which is fragile (BUG-1).

**Proposed:**

```
ghax select <@ref|selector> <value>            # set by visible text or by value attr
ghax select <@ref|selector> --index <n>        # by 0-indexed position
ghax select <@ref|selector> --by-value <val>   # explicit value semantics
```

Auto-detect the framework underneath and dispatch correctly. Same way `ghax click` already abstracts mousedown/mouseup/click.

**Priority:** High (overlaps with BUG-1 fix).

---

### FEAT-3 — `--scope <@ref>` flag for selectors

**Why:** Constrains `ghax click` / `ghax fill` / `ghax snapshot` to descendants of `<@ref>`, eliminating BUG-2 entirely.

**Example:**

```bash
ghax click 'button:has-text("Select")' --scope @e80   # only inside the picker panel
```

**Priority:** High.

---

### FEAT-4 — `ghax dismiss` for closing modals/popovers

**Why:** Sometimes you open a popover or modal and need to close it without a click target (the X button can be hard to address; pressing Escape is wired in some apps and not others). Today's options: `ghax press Escape`, navigate away, or click outside via coordinates.

**Proposed:** `ghax dismiss` heuristic that:

1. Tries Escape first.
2. Looks for a button labeled Cancel / Close / × inside the topmost dialog.
3. Clicks outside the dialog as a fallback.

**Priority:** Low–medium. Mostly comfort.

---

### FEAT-5 — Monaco-aware `ghax fill`

(See BUG-4. Listing here as the feature side of that bug.)

**Priority:** Medium.

---

### FEAT-6 — Cross-frame / portal-aware selectors

**Why:** AntD renders dropdown options, popovers, and `[role=grid]` autocompletes via React Portals — i.e., outside the parent form's DOM hierarchy, usually directly under `<body>`. This breaks selectors like `tbody tr:nth-of-type(N) .ant-select-item-option` because the options aren't inside the row.

Today the workaround is to query globally and rely on text matching, which collides with BUG-2 ("which `Select` button?").

**Proposed:** `ghax click` should understand portal targets — when looking for descendants of a referenced element, also walk through the portal-anchored elements that React rendered logically as children. Playwright already exposes some of this via `aria-controls` / `aria-owns`; ghax could surface the same.

**Priority:** Medium-high. AntD is common; this is the underlying cause of several BUG-2-style frustrations.

---

## What worked well (preserve)

- **`ghax network --pattern 'graphql'`** — was the single most valuable verb in this session. Without it, the `saveComponent` mutation discovery would have taken hours.
- **`ghax eval`** for React fiber traversal — the "always works" escape hatch.
- **`ghax screenshot --fullPage`** + the Read tool reading the PNG — fast iteration.
- **Apollo cache extraction** via `__APOLLO_CLIENT__.cache.extract()` for read-only inspection — fast and accurate.
- **`ghax snapshot -i`** producing the accessibility tree with `@e<num>` refs — great for first-pass orientation.
- **Body capture's `responseBody` field with the 32 KB cap** — exactly the right tradeoff for inspecting GraphQL responses without bloating logs.

---

## Priority-ranked take

If only two things changed, the high-leverage pair would be:

1. **AntD-aware select handling** (BUG-1 + FEAT-2) — unblocks every enterprise-admin UI.
2. **Request body capture** (FEAT-1) — turns "drive the UI once to learn the API" into a real workflow.

Together they would have cut this session's duration by an estimated 60–70%. The session still succeeded, but at the cost of significant context budget on workarounds.

---

## Session artifacts (for repro)

If the ghax agent wants to reproduce these against Datto RMM:

- The user must be signed into `https://concord.rmm.datto.com` in the attached Edge.
- The Component create form is at `/components` → click "Create Component".
- The Script Type dropdown (defaults to "Batch") is the AntD `<Select>` that triggered BUG-1 most reliably.
- The Component variable type column (also AntD `<Select>`, "Please select" → Selection / String / Date / Boolean) is where the React fiber escape was developed.
- The captured `saveComponent` mutation document and shape are documented in:
  `~/Documents/DevOps/kepptic/msp-automation/datto-rmm/.claude/skills/dattormm-graphql.md`
  (skill `kepptic-dattormm-graphql`).

The two components produced this session are both in DAG Tech's Datto RMM account: `Huntress + SentinelOne Migration Status [MAC]` (id 653796) and `SentinelOne | Uninstaller [MAC]` (id 653872). They survived the friction; the policy that wires them together did not, and is the test case for whether these fixes land.
