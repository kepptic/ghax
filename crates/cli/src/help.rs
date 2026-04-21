//! Help text — kept byte-equivalent with `HELP` in `src/cli.ts` so `--help`
//! parity tests don't drift between Bun and Rust.

pub const HELP: &str = r#"ghax — attach to your real Chrome/Edge via CDP and drive it.

Connection:
  attach [--port <n>] [--browser edge|chrome|chromium|brave|arc] [--launch]
         [--headless] [--load-extension <path>] [--data-dir <path>]
         [--capture-bodies[=<url-glob>]]
         # Without --port, scans :9222-9230. Multiple running → picker.
         # With --launch and no --port, auto-picks first free port in range.
         # --capture-bodies records JSON/text response bodies (opt-in,
         #   32KB cap per body). Glob filters by URL (e.g. '*/api/*').
  status [--json]
  detach
  restart

Tab:
  tabs
  tab <id> [--quiet]              # --quiet = don't bringToFront
  find <url-substring>            # list tabs matching (pipe into 'tab')
  new-window [url]                # new background window, same profile
  goto <url>
  back | forward | reload
  eval <js>
  try [<js>] [--css <rules>] [--selector <sel>] [--measure <expr>] [--shot <path>]
  text
  html [<selector>]
  screenshot [<@ref|selector>] [--path <p>] [--full-page]

Snapshot & interact:
  snapshot [-i] [-c] [-d <N>] [-s <sel>] [-C] [-a] [-o <path>]
  click <@ref|selector>
  fill <@ref|selector> <value>
  upload <@ref|selector> <path>[,<path>…]   # wraps setInputFiles
  press <key>
  type <text>
  wait <selector|ms|--networkidle|--load>
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
  cookies

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

Add --json for machine-readable output on any command.
"#;
