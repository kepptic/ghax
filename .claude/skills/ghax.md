---
name: ghax
description: Router for the ghax open-source developer toolkit — a collection of CLI tools that attach to the user's REAL environment (real browser, real auth, real extensions) instead of sandboxing. Dispatch to the relevant sub-skill when the user asks "can ghax do X" or mentions ghax by name without specifying a sub-command. The flagship is `ghax browse` (use skill ghax-browse). Future: `ghax ship`, `ghax qa`, `ghax review`, `ghax canary`, `ghax profile`, `ghax pair`.
---

# Skill: ghax (top-level router)

`ghax` is G's open-source developer toolkit — a collection of CLI tools
(and Claude Code skills) that attach to the user's real working
environment rather than sandboxing. Think gstack's ethos, but
real-browser-first.

## Shipped tools

| Tool | Skill to invoke | What it does |
|------|----------------|--------------|
| `ghax browse` | [`ghax-browse`](./ghax-browse.md) | Drive user's real Chrome/Edge via CDP. Tabs, a11y snapshots with @refs, MV3 extension internals (SW eval, sidepanels, `chrome.storage`, hot-reload), real user gestures, console/network capture. |

## Planned tools (no timeline)

| Tool | What it will do |
|------|-----------------|
| `ghax ship` | Opinionated ship workflow (commit + push + PR + deploy hook). |
| `ghax qa` | Orchestrated QA pass on a web app (attach + walk flows + gif). |
| `ghax review` | PR review against the diff. |
| `ghax canary` | Attach + watch prod for regressions after deploy. |
| `ghax profile` | Perf / memory snapshot of a page or extension. |
| `ghax pair` | Share browser access with another agent (like gstack-pair). |

## How to route

If the user mentions `ghax` without a sub-command, ask what they want to
do, or infer from context:

- Anything browser / extension / QA related → **ghax-browse**.
- Anything else → not yet built; offer to file it as a future tool in
  `design/plan/04-roadmap.md`.

## Design principles (inherited from gstack, adapted)

1. **Real over sandbox.** Attach to what the dev already has.
2. **Daemon over one-shot.** Persistent background server, ~60-200ms
   per-command overhead.
3. **Compiled single binary.** Bun `build --compile`.
4. **`@ref`-driven snapshots.** LLMs click `@e3`, not fragile CSS.
5. **Zero-config happy path.** `ghax attach` figures it out.
6. **MIT licensed, open source.**

## Source + docs

[kepptic/ghax](https://github.com/kepptic/ghax) — see `README.md`,
`design/plan/`, and `CHANGELOG.md`.
