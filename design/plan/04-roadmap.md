# ghax — roadmap

## v0.1 — minimum useful (flagship `ghax browse`)

Target: I can run the same extension QA I did on Beam in `ghax` commands
instead of hand-written Python.

- [ ] Repo scaffold (Bun workspace, tsconfig, package.json, bin wrapper)
- [ ] `ghax attach` — detect / launch Edge or Chrome with CDP
- [ ] `ghax status` / `ghax detach` / `ghax restart`
- [ ] Daemon HTTP server (Bun.serve on random localhost port)
- [ ] `.ghax/ghax.json` state file discovery
- [ ] CDP client: WebSocket pool keyed by target id, auto-reconnect
- [ ] `ghax tabs` / `ghax tab <id>` / `ghax goto`
- [ ] `ghax snapshot -i` (accessibility tree + `@e<n>` refs)
- [ ] `ghax click <@ref>` / `ghax fill <@ref> <value>` / `ghax eval`
- [ ] `ghax screenshot [path]` (tab viewport)
- [ ] `ghax console [--errors]` / `ghax network`
- [ ] `ghax ext list` / `ghax ext reload <id>`
- [ ] `ghax ext sw <id> eval <js>` + `logs`
- [ ] `ghax ext panel <id> [eval|screenshot]`
- [ ] `ghax ext storage <id> [get|set]`
- [ ] `ghax gesture click <x,y>` — real `Input.dispatchMouseEvent`
- [ ] `bun build --compile` single binary
- [ ] README with quickstart
- [ ] Dogfood against Beam — run the bug fixes I did this session

## v0.2 — QA ergonomics

- [ ] `ghax chain` JSON batch mode
- [ ] `ghax responsive`, `ghax viewport`, `ghax diff`
- [ ] `ghax record start/stop` + `ghax replay`
- [ ] `ghax gif` (ffmpeg wrapper)
- [ ] `--json` flag on all commands
- [ ] `ghax snapshot -a` annotated screenshot
- [ ] Shadow-DOM aware clicking (match gstack behavior)
- [ ] CircularBuffer console/network (match gstack pattern)

## v0.3 — Claude Code skills

- [ ] `skills/ghax-browse/SKILL.md` — invocable as `/ghax-browse`
- [ ] `skills/ghax/SKILL.md` — top-level router
- [ ] Auto-register into `~/.claude/skills/` via devops-skill-registry

## v1.0 — open source release

- [ ] LICENSE (MIT), CONTRIBUTING, CHANGELOG, CODE_OF_CONDUCT
- [ ] `bunx ghax` zero-install usage (publish to npm)
- [ ] GitHub Actions CI (bun test, bun build --compile for mac/linux/win)
- [ ] Docs site — `ghax.dev` or GitHub Pages
- [ ] Announce: HN, X, dev.to
- [ ] v1.0 tag

## Future tools in the `ghax` collection (no timeline)

- `ghax ship` — opinionated ship workflow (commit + push + PR + deploy hook)
- `ghax qa` — orchestrated QA pass on a web app (attach + walk flows + gif)
- `ghax review` — PR review against the diff
- `ghax canary` — attach + watch prod for regressions after deploy
- `ghax profile` — perf / memory snapshot of a page or extension
- `ghax pair` — share browser access with another agent (like gstack pair)
