//! Help text — kept byte-equivalent with `HELP` in `src/cli.ts` so `--help`
//! parity tests don't drift between Bun and Rust.

pub const HELP: &str = r#"ghax — attach to your real Chrome/Edge via CDP and drive it.

Connection:
  attach [--port <n>] [--browser edge|chrome|chromium|brave|arc] [--launch]
  attach --extension [--control-active] [--browser <bind-filter>] [--pair[=code]]
                                  # drive your REAL session via the bridge ext;
                                  #   --pair requires a code typed into the popup
         [--headless] [--load-extension <path>] [--data-dir <path>]
         [--capture-bodies[=<url-glob>]] [--verbose]
         # Without --port, scans :9222-9230. Multiple running → picker.
         # With --launch and no --port, auto-picks first free port in range.
         # --capture-bodies records JSON/text response bodies (opt-in,
         #   32KB cap per body). Glob filters by URL (e.g. '*/api/*').
         #   Also captures POST/PUT/PATCH request bodies (requestBody)
         #   on network entries under the same glob + content-type +
         #   32KB-cap rules.
         # --verbose prints pid/port/browser on success (default: silent).
  status [--json]
  detach
  restart

Tab:
  tabs [--browser <id|edge|chrome|label>]
                                  # bridge: --browser lists another connected
                                  #   browser's tabs without taking it over
  tab <id> [--quiet]              # --quiet = don't bringToFront
  find <url-substring>            # list tabs matching (pipe into 'tab')
  new-window [url]                # new background window, same profile
  goto <url> [--stable]           # --stable also waits for the DOM to settle
  back | forward | reload
  eval <js>                       # auto-retries once past a nav-in-flight
                                  #   awaits Promises/async IIFEs automatically
  try [<js>] [--css <rules>] [--selector <sel>] [--measure <expr>] [--shot <path>]
  text
  html [<selector>]
  screenshot [<@ref|selector>] [--path <p>] [--full-page]

Snapshot & interact:
  snapshot [-i] [-c] [-d <N>] [-s <sel>] [-C] [-a] [-o <path>]
  click <@ref|selector>
  fill <@ref|selector> <value>              # Monaco-aware: routes into
                                             #   monaco.editor.getEditors() when
                                             #   the target is inside a Monaco editor
  select <@ref|selector> <value>            # by visible text, falling back to value attr
  select <@ref|selector> --index <n>        # by 0-based position
  select <@ref|selector> --by-value <val>   # explicit value semantics
         # cascade: native <select> → AntD <Select> (React fiber) → open+click
         #   (react-select/MUI/Headless UI/role=combobox, portal-aware)
  upload <@ref|selector> <path>[,<path>…]   # wraps setInputFiles
  press <key>
  type <text>
  wait <selector>                 # wait until selector appears (most common)
  wait <ms>                       # fixed delay in milliseconds
  wait --networkidle | --load     # wait for a navigation event
  wait --stable [--quiet <ms>] [--timeout <ms>] [--min-nodes <n>] [<selector>]
                                  #   wait for the DOM to stop changing (SPA hydration).
                                  #   Also available as --stable on goto/text/snapshot.
  viewport <WxH>
  responsive [prefix] [--fullPage]
  diff <url1> <url2>
  is <visible|hidden|enabled|disabled|checked|editable> <@ref|selector>
  xpath <expression> [--limit N]      # list matching elements with text + box
  box <@ref|selector>                 # bounding box {x, y, width, height}
  storage [local|session] [get|set|remove|clear|keys] [key] [value]

Logs:
  console [--errors] [--last N] [--since <epoch-ms>] [--dedup] [--source-maps]
         # --since filters to entries newer than the epoch-ms timestamp
         # --dedup groups repeats with count
         # --source-maps resolves bundled stack frames to original sources
  network [--pattern <re>] [--status 4xx|500|400-499] [--last N] [--since <epoch-ms>] [--har <path>]
  cookies [--domain <d>] [--url <u>] [--all] [--values] [--has <name>]
         # Default: cookies applicable to the active tab's URL only
         #   (Playwright's own domain/path/secure applicability match).
         # Values are redacted by default — pass --values for raw values.
         # --all = whole-profile dump (old default was `--all --values`).
         # --domain <d> filters the whole profile by domain substring/suffix.
         # --url <u> scopes applicability to an explicit URL instead of
         #   the active tab.
         # --has <name> exits 0 if a cookie with that name is in scope,
         #   1 otherwise — scripting primitive for "did login land?".

Extensions (MV3):
  ext list
  ext targets <ext-id>
  ext reload <ext-id>
  ext hot-reload <ext-id> [--wait N] [--no-inject] [--verbose]
  ext sw <ext-id> eval <js>
  ext panel <ext-id> eval <js>
  ext popup <ext-id> eval <js>
  ext options <ext-id> eval <js>
  ext storage <ext-id> [local|session|sync] [get|set|clear] [key] [value]
  ext message <ext-id> <json-payload>

Real user gestures:
  gesture click <x,y>
  gesture dblclick <x,y>
  gesture scroll <up|down|left|right> [amount]
  gesture key <key>

Batch / recording:
  chain < steps.json          (JSON array of {cmd, args?, opts?})
  batch '<json-array>'        (one round-trip; auto re-snapshots between
                               steps that use @e<n> refs)
  record start [name]
  record stop
  record status
  replay <file>

Orchestrated:
  qa --url <u> [--url <u> ...] [--urls a,b,c]
     [--crawl <root> [--depth N] [--limit N]]
     [--out report.json] [--screenshots <dir>] [--no-screenshots]
     [--annotate] [--gif <out.gif>]
  profile [--duration sec] [--heap] [--extension <ext-id>]
  perf [--wait <ms>]                  # Core Web Vitals + nav timing
  diff-state <before.json> <after.json>
  canary <url> [--interval 60] [--max 3600] [--out report.json] [--fail-fast]

Dev workflow:
  ship [--message "..."] [--no-check] [--no-build] [--no-pr] [--dry-run]
  review [--base origin/main] [--diff]
  pair [status]
  gif <recording> [out.gif] [--delay ms] [--scale px] [--keep-frames]
  shell                             # interactive REPL — skip per-command spawn cost
  version [--full]                  # CLI/daemon-bundle/extension identity (--full flags stale bundles)
  update [--check] [--to vX.Y.Z]    # install latest GitHub release (or check only)

Add --json for machine-readable output on any command.
"#;
