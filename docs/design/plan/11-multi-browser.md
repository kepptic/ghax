# 11 — Multi-browser bridge, tab identity, daemon discovery

Status: approved by G 2026-10-13 ("do all of it"); the five open questions below were taken as recommended.
Design: Fable plan, 2026-10-13. Usage evidence: claudectl sweep, same day.

## Why

- G: "We should be able to control multiple browsers at the same time. And multiple
  sessions should be able to control different browsers at the same time."
- Measured: one daemon binds exactly one bridge peer (`src/bridge.ts:315` `boundId`);
  the first hello wins and later browsers park (`src/bridge.ts:777-789`). A field
  session got Chrome when it wanted Edge for that reason.
- Measured (claudectl, 2026-09-26 → 2026-10-13, outside this repo): "no daemon state"
  ~65 hits. The state file follows the cwd's git root (`crates/cli/src/state.rs`
  `resolve_config`), so a daemon attached from another directory is invisible.
- Org rule (target verification SOP): a target that resolves to 0 or >1 matches
  aborts and lists them. Never take [0].

## Decision

One daemon per agent (invariant 2 unchanged), and **one daemon may bind several
browsers**. Rejected: a shared fleet daemon serving many agents. `Ctx` is
single-session and tab ownership already lives in the extension's `tabOwners`
(plan 09), so a shared daemon would be a second place to get conflicts wrong.

Taken as recommended (G, 2026-10-13):
1. Tab ids on the bridge are always composite `<alias>:<chromeTabId>`.
2. More than one candidate browser and no `--browser` → refuse and list.
   `--browser all` binds every candidate.
3. Profile name = a user label set in the extension popup. No `chrome.identity`
   (it would expose the signed-in email). Unlabelled fallback: `<brand> · <short6>`.
4. `console` / `network` default to the active tab; `--tab <id>` / `--all` widen.
5. The `tabs` text layout is final only after phase 2 lands.

## Tab identity

`ghax tabs` prints, per tab:

    #3  edge-work:42  "Bank feeds - QuickBooks"  Edge · Work  controlledBy=:9224

- `#n`: index in the last listing (refused if that tab has since vanished).
- `edge-work:42`: daemon-minted id, unique across browsers. Chrome tab ids are
  per-browser integers, so two browsers can both have tab 42. The alias is
  `<brand>-<profile slug>`, else `<brand>-<short6 instanceId>`. Any alias two
  instances would share gets `-<short6>` (then a longer id prefix) until unique,
  and a live instance keeps its alias once minted (`src/tab-identity.ts`).
- Title, then browser brand and profile label.
- `tab <x>` accepts `#n`, the full id, or a bare integer only when it matches exactly
  one tab across bound browsers. Every refusal prints the full identity.

## Phases (each ships on its own)

1. **Routing + discovery.** Settle window after the first hello
   (`GHAX_BRIDGE_SETTLE_MS`, default 1500 ms); 0 candidates → `BRIDGE_NO_CANDIDATE`,
   >1 with no selector → `BRIDGE_AMBIGUOUS` listing browser · profile · instance ·
   port. Daemon discovery: when the cwd's state file is missing, find live daemons
   (registry under `~/.ghax/daemons/`); exactly one → use it and say so on stderr,
   more than one → refuse and list them with cwd, browser and port.
   Breaks: two browsers without `--browser` no longer bind silently.
2. **Tab identity.** Composite ids, `#n`, popup "Profile name", `hello.profile`,
   `list-tabs` ack adds `windowId`/`index`. Breaks: bridge tab ids are strings.
3. **Multi-bind.** `bound: Set<instanceId>`, per-peer session state (main frame,
   contexts, load time, network map), events tagged by peer and tab, refs cleared on
   any change of peer or tab (invariant 3). One DEGRADED peer must not stall another.
4. **Polish.** Persist policy in the state file, ARCHITECTURE.md, README.

Limit that stays: one extension connection holds one debugger attachment, so a
daemon drives one tab per browser at a time.

## Risks

- Settle window adds up to 1.5 s to `attach --extension`.
- Two unlabelled profiles of one brand are indistinguishable by `--browser edge` →
  refuse and ask for labels.
- Old extension + new daemon: single-browser mode works; identity falls back to
  brand · id. `ghax version --full` already warns on skew.
