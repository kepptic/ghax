# ghax — session handoff (2026-04-18, end of v0.4 kick-off)

Start here when you pick this back up in a new session.

## Where we are

v0.1, v0.2, v0.3, v1.0-hardening, and the first half of v0.4 are
shipped + pushed to https://github.com/kepptic/ghax (private).

Recent commits (oldest → newest):

- `5533bca` — Initial commit — ghax v0.1
- `037899d` — v0.2 — QA ergonomics
- `5f93acf` — docs(plan): mark v0.1 + v0.2 shipped
- `277cadf` — v0.3 — hot-reload, shadow DOM, gif, skills, CI
- `ccacb05` — docs(plan): mark v0.3 shipped
- `b6834ce` — docs(plan): pause open-source track
- `e41ab7d` — test: smoke harness + MV3 fixture; doc cleanup
- (this session) — load-extension / data-dir pass-through, scripted
  hot-reload smoke, shadow-DOM selector fix, `ghax qa` v1

The flagship attach / drive / extension-introspection loop works end-to-end
against a live Edge session. Hot-reload, gif rendering, and shadow-DOM aware
cursor scan all land in v0.3. Claude Code skills are registered globally
as `kepptic-ghax-browse` and `kepptic-ghax`.

## Repo layout (as of this handoff)

```
ghax/
  bin/ghax                  shell shim (dist/ghax → fallback bun run src/cli.ts)
  src/
    cli.ts                  argv → daemon RPC, exit-code propagation
    daemon.ts               Node http server, Playwright + raw CDP, all handlers
    browser-launch.ts       browser detection + CDP probe + --launch scratch profile
    cdp-client.ts           /json/list + CdpTarget WebSocket pool
    config.ts               state dir resolution (git root → .ghax/ghax.json)
    buffers.ts              CircularBuffer<T> for console + network
    snapshot.ts             aria tree + @e<n> refs + shadow-DOM cursor pass
  dist/                     gitignored — bun run build to produce
  .claude/skills/
    ghax-browse.md          flagship skill (kepptic-ghax-browse)
    ghax.md                 top-level router (kepptic-ghax)
  .github/workflows/ci.yml  typecheck + compile matrix (mac/linux/win)
  design/plan/              vision, architecture, commands, roadmap, this file
  CHANGELOG.md              Keep-a-Changelog format, v0.1/v0.2/v0.3 + Unreleased
  CONTRIBUTING.md           repo layout, dev loop, architecture invariants
  CODE_OF_CONDUCT.md        Contributor Covenant v2.1
  LICENSE                   MIT (with gstack attribution)
  README.md                 quickstart + command surface
```

## What's shipped in v0.3 specifically

- **`ghax ext hot-reload <ext-id>` [--wait N] [--no-inject] [--verbose]** —
  reads the extension manifest via Runtime.evaluate, fires
  `chrome.runtime.reload()` fire-and-forget, sleeps `wait * 1000` ms,
  re-discovers the new SW target on `/json/list`, then runs a single
  chained `chrome.tabs.query + chrome.scripting.executeScript` call per
  `content_scripts` entry. Returns per-tab `{tabId, url, status, error?}`.
  Exit codes: 3 (ext not found), 4 (CDP error), 5 (SW timed out), 6 (>0
  re-inject failures).
- **Shadow-DOM aware cursor scan** — `snapshot.ts`'s cursor-interactive
  pass now recursively walks open shadow roots and emits Playwright
  Playwright chain selectors (`host >> inner`).
- **`ghax gif <recording> [out.gif]` [--delay ms] [--scale px]** — drives
  a replay, screenshots between steps, stitches via ffmpeg's 2-pass
  palette flow. Fails gracefully if ffmpeg isn't on PATH.
- **Deprecation hint on `ghax ext reload`** — when the extension declares
  `content_scripts`, prints a hint to use `hot-reload` instead.
- **Daemon → CLI exit-code propagation** — `new DaemonError(msg, code)`
  in the daemon sets `exitCode` on the RPC response; CLI's `rpc()` helper
  reads it and attaches to the thrown error for `main()` to honor.
- **Claude Code skills** — `.claude/skills/ghax-browse.md` and
  `.claude/skills/ghax.md`, auto-picked-up by
  `devops-skill-registry` (confirmed in `~/.claude/skill-audit.log`).
- **CHANGELOG + CONTRIBUTING + CODE_OF_CONDUCT + CI.**

## Things deliberately NOT done in v0.3

- **Skill acceptance eval.** We have the skills but no scripted eval
  pointed at Beam / Setsail. Next session could script a series of
  Claude prompts against each skill and assert tool-call outcomes.
  Deferred because eval scaffolding is its own rabbit hole.
- **Live smoke-test of `ghax ext hot-reload`.** Wasn't run against Beam
  in this session because it would disrupt the user's open Autotask /
  KaseyaOne / dashboard tabs. The daemon path is the exact pattern the
  user ran by hand earlier this session (referenced in the roadmap), so
  the confidence is high, but a one-shot verification on a throwaway
  extension is worth doing early in v1.0 polishing.
- **Real-profile attach.** Still deferred. `--launch` uses a scratch
  profile. Plan is to investigate LaunchServices + keychain entitlements
  on macOS before attempting to copy the real Edge profile.

## Direction locked in 2026-04-18

- **Repo stays private.** Remains under `kepptic` on GitHub.
- **Not publishing to npm yet.** Binary distribution via `bun run build`
  + the compiled `dist/ghax` is sufficient for internal use.

Open-source release (public repo, `@ghax/cli` on npm, docs site,
announce) is **paused**. The scaffolding we already laid down
(LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, CHANGELOG, CI) stays — it
makes the eventual flip cheap.

## What's next

The internal-hardening items from the previous handoff are done:

- [x] `test/smoke.ts` — 25 checks, runs locally in ~10s.
- [x] Live hot-reload verification — `test/hot-reload-smoke.ts`
      launches a scratch Edge with the fixture and verifies both the
      SW version bump AND the content-script banner refresh without a
      tab reload. Fully scripted, isolated from the user's daily Edge.
- [x] `ghax attach --launch --load-extension <path> --data-dir <path>`
      — enables scripted extension loading.

v0.4 is underway:

- [x] `ghax qa` v1 — orchestrated QA pass over an explicit URL list
      with optional screenshots, annotate, and gif.
- [ ] `ghax qa` v2 — auto-infer URLs from a root's sitemap or main
      nav. `--crawl <root> --depth N`.
- [ ] `ghax profile` — perf / memory snapshot of a page or extension.
- [ ] Real-profile attach — still on the wishlist.
- [ ] Skill acceptance eval harness — carryover from v0.3.

## How to get running in a new session

```bash
cd /Users/gr/Documents/DevOps/kepptic/products/open-source/ghax
# 1. Confirm Edge is on CDP :9222 (or launch it yourself / use --launch)
curl -s http://127.0.0.1:9222/json/version | head -5
# 2. Build + attach
bun install && bun run build
./dist/ghax attach
# 3. Drive
./dist/ghax tabs
./dist/ghax snapshot -i -a -o /tmp/shot.png
./dist/ghax ext list
./dist/ghax ext hot-reload <ext-id>          # the v0.3 flagship
./dist/ghax detach
```

## How to invoke ghax from Claude Code

Skills are already registered on this machine. In any session:

- `/kepptic-ghax-browse` — full skill with cheat sheet + recipes
- `/kepptic-ghax` — top-level router

Claude will also reach for them automatically whenever the user mentions
"attach", "real edge", "hot-reload", or runs `pnpm build` on an
extension.
