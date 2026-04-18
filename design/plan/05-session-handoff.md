# ghax — session handoff (2026-04-18)

Start here when you pick this back up in a new session.

## Context

This session was spent QA'ing Beam's Chrome extension + dashboard. During the
work, we hit a pattern that no existing skill supported: attach to the user's
**real** Edge browser via CDP to drive a Chrome extension whose sidepanel,
service worker, and content scripts all needed independent inspection.

I ended up writing Python scripts ad-hoc. The user asked whether this should
be a new skill. We concluded yes — and the scope is bigger than just extension
testing. The user has many web apps (Beam, Setsail, Conduit, client portals)
that need similar "attach-to-my-real-browser" QA.

The user's handle is **G** (historically "G Hacks" before they knew ghacks.net
existed). They want a collection of open-source tools under a single brand.
Name chosen: **`ghax`**. Style references gstack (Garry Tan's collection).

## What exists now (this folder)

- `README.md` — repo intro
- `design/plan/01-vision.md` — who/what/why
- `design/plan/02-architecture.md` — Bun + daemon + Playwright + raw CDP
- `design/plan/03-commands.md` — full command surface for v1
- `design/plan/04-roadmap.md` — v0.1 → v1.0 checklists
- `design/plan/05-session-handoff.md` — this file
- `docs/` — empty, for user-facing docs when we have them

## What does NOT exist yet

- Any code. Zero `.ts` files. Not scaffolded.
- `package.json`, `tsconfig.json`, `bun.lock`.
- `.ghax/` state folder convention (decision — not created).
- Git repo (this sits inside `kepptic/products/open-source/` which is its
  own thing; decision needed on whether `ghax` should be its own repo from
  day 1 or live in a monorepo until v1.0).

## Reference clone

gstack repo authorized by user: `https://github.com/garrytan/gstack.git`

Clone to `/tmp/ref-gstack/` and mine these files (read-only reference, do
NOT copy verbatim — rewrite with MIT attribution):

- `.claude/skills/gstack/browse/src/server.ts` — daemon shape
- `.claude/skills/gstack/browse/src/snapshot.ts` — a11y tree with `@refs`
- `.claude/skills/gstack/browse/src/buffers.ts` — CircularBuffer
- `.claude/skills/gstack/browse/src/config.ts` — state file discovery
- `.claude/skills/gstack/browse/src/cli.ts` — command dispatch style
- `.claude/skills/gstack/bin/chrome-cdp` — launches Chrome with CDP
  (adapt for Edge + make it not require quitting the real browser)

## Decisions needed before coding

1. **Monorepo or standalone git repo?** Right now `ghax/` lives under
   `kepptic/products/open-source/`. Should it be its own git repo from
   day 1 (cleaner for open-sourcing later) or stay in-tree until v0.1 is
   validated? My vote: standalone git repo at day 1, committed into the
   kepptic tree as a submodule until v1.0 ships.

2. **Edge vs Chrome for first target?** User works in Edge daily. Start
   with Edge (`/Applications/Microsoft Edge.app/...`) and add Chrome
   next. They share the same CDP protocol so it's mostly launcher detection.

3. **npm package name?** `ghax` might be available. `@ghax/cli` as
   scoped is safer. Decide before publishing v1.

4. **Bun version pin?** gstack pins Bun 1.3.10. Check current Bun.
   Likely 1.x compatible.

5. **Extension ID discovery for `ghax ext list`?** Chrome/Edge don't
   expose a stable API. We parse `chrome://extensions` page text, or
   use CDP `Target.getTargets` and group by `chrome-extension://<id>/`.
   Decision: use target grouping — simpler, works without opening
   chrome://extensions.

## Kickoff plan for next session

1. Decide monorepo-vs-standalone (question 1).
2. Clone gstack to `/tmp/ref-gstack/` for reference.
3. Scaffold `ghax/` with `package.json`, `tsconfig.json`, `src/`, `bin/`.
4. Write `src/cli.ts` dispatcher + `ghax attach` (just launcher + CDP
   connect + state file write). Get to "attached" output.
5. Write `src/daemon.ts` (Bun.serve) + `ghax status` + `ghax detach`.
6. Write `src/cdp-client.ts` with target discovery.
7. Implement `ghax tabs` + `ghax tab <id>` + `ghax goto` + `ghax eval`.
8. Implement `ghax snapshot -i` (port gstack's algorithm).
9. `ghax ext list` + `ghax ext sw <id> eval <js>`.
10. Test it against Beam — reproduce the bug-fix verifications I did
    this session using `ghax` commands instead of raw Python.

Target for v0.1: steps 1-10 in one focused session, maybe 2-3 hours.

## Open questions to revisit later

- Does Playwright's `chromium.connectOverCDP()` give us access to extension
  service worker targets? If yes, use it. If no, raw CDP for SW.
- How do we handle the "Edge refuses --remote-debugging-port on default
  profile" dance cleanly? gstack's `chrome-cdp` symlinks the real profile
  into a separate data dir — but that has caveats (LocalState, crypto
  keys for cookie decryption). Reproduce or find a cleaner way.
- Do we want a "pair agent" model eventually (like gstack-pair)? Matters
  for team / remote-agent scenarios. Not for v1.

## Links

- gstack: https://github.com/garrytan/gstack.git
- Chrome DevTools Protocol: https://chromedevtools.github.io/devtools-protocol/
- Playwright CDP connect: https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- Beam extension (first dogfood target):
  `/Users/gr/Documents/DevOps/kepptic/products/apps/beam/apps/extension/`
