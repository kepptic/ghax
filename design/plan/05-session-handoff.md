# ghax — session handoff (2026-04-18, end of build session)

Start here when you pick this back up in a new session.

## Where we are

v0.1 + v0.2 shipped and pushed to https://github.com/kepptic/ghax (private).

- `main` @ `037899d` — "v0.2 — QA ergonomics: annotated snapshots, responsive,
  chain, record/replay"
- `main` @ `5533bca` — "Initial commit — ghax v0.1"

The flagship attach / drive / extension-introspection loop works end-to-end
against a live Edge session. Verified on the Beam extension
(`hligjpiaogkblpkobldladoohgknedge`): SW eval, `chrome.storage.local` dump,
interactive snapshot on the dashboard.

## Repo layout (as of this handoff)

```
ghax/
  bin/ghax                  shell shim (dist/ghax → fallback bun run src/cli.ts)
  src/
    cli.ts                  argv → daemon RPC, handles attach/detach specials
    daemon.ts               Node http server, Playwright + raw CDP, all handlers
    browser-launch.ts       browser detection + CDP probe + --launch scratch profile
    cdp-client.ts           /json/list + CdpTarget WebSocket pool
    config.ts               state dir resolution (git root → .ghax/ghax.json)
    buffers.ts              CircularBuffer<T> for console + network
    snapshot.ts             aria tree → @e<n> refs + cursor-interactive pass
  dist/
    ghax                    Bun-compiled CLI binary (~61 MB)
    ghax-daemon.mjs         Node ESM bundle (~38 KB, externalises playwright)
  design/plan/              vision, architecture, commands, roadmap, this file
  package.json              @ghax/cli, Bun 1.3.11, Playwright 1.59.1
  tsconfig.json             bundler moduleResolution, strict
```

## Key architectural decisions that already landed

- **CLI = Bun (compiled). Daemon = Node (ESM bundle).** Playwright's
  `connectOverCDP` hangs under Bun 1.3.x. Node runs it reliably. Build command:
  `bun build --compile src/cli.ts` + `bun build --target=node --format=esm src/daemon.ts`
  (Playwright is an external so it resolves from `node_modules/` at runtime).
- **Daemon HTTP server** uses Node's `http` module, not `Bun.serve` (the daemon
  runs under Node).
- **Handler registry** — each command is registered via `register('name', fn)`
  in `daemon.ts`. Adding a new command = one handler + one CLI case.
- **Recording** wraps the dispatcher: every cmd except the NEVER_RECORD set
  (meta, read-only queries) gets appended to `ctx.recording.steps`.
- **Annotated screenshots** inject an SVG overlay into the page (not absolute
  divs) to avoid triggering re-layout on React apps.
- **Extension ID discovery** uses CDP target grouping (parse
  `chrome-extension://<id>/` out of target URLs in `/json/list`). No
  `chrome://extensions` parsing needed.

## Gotchas discovered while building

- Bun's `Bun.spawnSync` / `Bun.spawn` are fine in the CLI; don't reach for them
  in the daemon.
- `Bun.serve`'s `server.port` type is `number | undefined` — we switched to
  `http.createServer` anyway, but worth remembering.
- `page.fill()` is unreliable on controlled React inputs. Our `fill` handler
  uses the native value setter + dispatched `input`/`change` events.
- Playwright doesn't expose side-panel pages via `browserContext.pages()`
  cleanly — we talk to them via raw CDP `Runtime.evaluate` from the
  `CdpPool`.
- `chrome.storage.local get` returns JWT / OAuth tokens in plaintext. Don't
  echo it into public logs.

## What's next (in priority order)

1. **`/ghax-browse` Claude Code skill.** The whole point of ghax is that it
   becomes the AI's browser hands. A `.claude/skills/ghax-browse.md` with a
   clear command cheat-sheet, plus auto-registration via
   `devops-skill-registry` (see `/Users/gr/Documents/DevOps/.claude-skills/`),
   is the single highest-leverage v0.3 item.

2. **`ghax gif <recording> [out.gif]`.** ffmpeg wrapper. Replay a recording
   while taking periodic screenshots, composite into a GIF. Turns QA sessions
   into shareable artefacts. ~1-2 hours.

3. **Shadow-DOM aware clicking.** Some component libraries (Shoelace, custom
   web components) put interactive elements inside `shadowRoot`. Playwright's
   `locator` handles open shadow DOM but our cursor-interactive scan doesn't
   pierce shadow boundaries. Adapt gstack's shadow-aware walk.

4. **Publish prep.** GitHub Actions matrix (mac/linux/win), CHANGELOG,
   CONTRIBUTING, flip to public, npm publish `@ghax/cli`.

5. **Tests.** A `test/smoke.ts` (attach → goto example.com → snapshot → detach)
   would catch regressions before they reach the build. Deferred during v0.2
   because dogfooding covered it manually.

## Things deliberately NOT done

- **Real-profile attach** (copy the user's live Edge profile into a
  --user-data-dir so cookies/extensions come along). Research required on
  keychain entitlements — deferred to v0.2+ track. For now, `--launch` uses a
  scratch profile under `~/.ghax/<kind>-profile/` and the intended flow is to
  have the user launch their real browser with `--remote-debugging-port=9222`.

- **Auth tokens on the daemon.** Single-user localhost — no token auth in v0.1
  or v0.2. Add scoped tokens (mirroring gstack's `token-registry.ts`) if we
  ever expose the daemon to remote agents.

- **Anti-bot stealth.** We're attaching to the user's real browser. Whatever
  their fingerprint is, it's already good.

## Reference reading

- `/tmp/ref-gstack/browse/src/cli.ts` — gstack's CLI (1008 lines, instructive
  for edge cases we haven't hit yet)
- `/tmp/ref-gstack/browse/src/server.ts` — gstack's daemon (2474 lines; we're
  ~800)
- `/tmp/ref-gstack/browse/src/snapshot.ts` — we ported the core of this

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
./dist/ghax detach
```
