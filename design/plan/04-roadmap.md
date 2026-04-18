# ghax — roadmap

## v0.1 — minimum useful (flagship `ghax browse`) ✓ shipped 2026-04-18

Target: I can run the same extension QA I did on Beam in `ghax` commands
instead of hand-written Python.

- [x] Repo scaffold (Bun, tsconfig, package.json, bin wrapper) — `@ghax/cli`
- [x] `ghax attach` — probes CDP on :9222, optional `--launch` scratch profile
- [x] `ghax status` / `ghax detach` / `ghax restart`
- [x] Daemon HTTP server — started as `Bun.serve`, switched to Node's `http`
      because Playwright's `connectOverCDP` hangs under Bun
- [x] `.ghax/ghax.json` state file discovery (git root fallback)
- [x] Raw CDP client: WebSocket pool, target discovery via `/json/list`
- [x] `ghax tabs` / `ghax tab <id>` / `ghax goto` / `back` / `forward` / `reload`
- [x] `ghax snapshot -i` (aria tree + `@e<n>` refs + cursor-interactive pass)
- [x] `ghax click` / `ghax fill` (React-safe native setter) / `ghax press` /
      `ghax type` / `ghax eval` / `ghax wait`
- [x] `ghax screenshot` (viewport, element, or full-page)
- [x] `ghax text` / `ghax html` / `ghax cookies`
- [x] `ghax console [--errors] [--last N]` / `ghax network [--pattern] [--last]`
- [x] `ghax ext list` / `ghax ext targets` / `ghax ext reload`
- [x] `ghax ext sw <id> eval <js>`
- [x] `ghax ext panel <id> eval <js>`
- [x] `ghax ext storage <id> [local|session|sync] [get|set|clear]`
- [x] `ghax gesture click <x,y>` + `ghax gesture key <key>` via CDP Input.*
- [x] `--json` flag on every command
- [x] `bun build --compile` single binary for the CLI, Node ESM bundle for daemon
- [x] README with quickstart
- [x] Dogfood against the Beam Chrome extension (`hligjpiaogkblpkobldladoohgknedge`)
      — verified SW eval, storage dump, interactive snapshot on dashboard

### Decisions taken during v0.1

| Decision | Why |
|----------|-----|
| Standalone private GitHub repo (`kepptic/ghax`) from day 1 | Cleaner than submodule, no retroactive extraction |
| Edge as the default target | Matches the user's daily driver |
| `@ghax/cli` scoped npm name | Both `ghax` and `@ghax/cli` were free; scoped is safer long-term |
| CLI (Bun) + Daemon (Node) split | Bun+Playwright hangs; Node runs connectOverCDP reliably |
| Scratch profile in `~/.ghax/<kind>-profile/` for `--launch` | Real-profile copy is fragile (cookie keychain) — deferred to v0.2+ |
| SVG overlay for annotated screenshots | No re-layout risk on React pages |

## v0.2 — QA ergonomics ✓ shipped 2026-04-18

- [x] `ghax snapshot -a` annotated screenshot (SVG rects + @refs)
- [x] `ghax viewport <WxH>` + `ghax responsive [prefix]`
- [x] `ghax diff <url1> <url2>` — naive line-based text diff
- [x] `ghax chain` JSON batch mode from stdin
- [x] `ghax record start / stop / status` + `ghax replay <file>`
      (writes `.ghax/recordings/<name>.json`)
- [x] CircularBuffer console/network buffers (5k each)
- [ ] `ghax gif <recording> [out.gif]` — ffmpeg wrapper
- [ ] Shadow-DOM aware clicking (cross-shadow selector resolution)

## v0.3 — Claude Code skills

- [ ] `.claude/skills/ghax-browse.md` — invocable as `/ghax-browse`
- [ ] `.claude/skills/ghax.md` — top-level router skill
- [ ] Register under one of the devops-skill-registry namespace roots
      (or document manual install for external users)
- [ ] Skill acceptance eval — pointable at Beam / Setsail dashboards

## v1.0 — open source release

- [ ] Make repo public, re-export under a personal / kepptic org decision
- [ ] CONTRIBUTING, CHANGELOG, CODE_OF_CONDUCT
- [ ] `bunx ghax` zero-install usage (publish `@ghax/cli` to npm)
- [ ] GitHub Actions CI (bun test, compile matrix for mac/linux/win)
- [ ] Docs site — `ghax.dev` or GitHub Pages
- [ ] v1.0 tag + announce (HN, X, dev.to)

## Future tools in the `ghax` collection (no timeline)

- `ghax ship` — opinionated ship workflow (commit + push + PR + deploy hook)
- `ghax qa` — orchestrated QA pass on a web app (attach + walk flows + gif)
- `ghax review` — PR review against the diff
- `ghax canary` — attach + watch prod for regressions after deploy
- `ghax profile` — perf / memory snapshot of a page or extension
- `ghax pair` — share browser access with another agent (like gstack pair)
