//! Help text — kept byte-equivalent with `HELP` in `src/cli.ts` so `--help`
//! parity tests don't drift between Bun and Rust.

pub const HELP: &str = r#"ghax — attach to your real Chrome/Edge via CDP and drive it.

Connection:
  attach [--port <n>] [--browser edge|chrome|chromium|brave|arc] [--launch]
  attach --extension [--control-active] [--browser <bind-filter>] [--pair[=code]]
                                  # drive your REAL session via the bridge ext;
                                  #   --pair requires a code typed into the popup
                                  #   Waits GHAX_BRIDGE_SETTLE_MS (1500) after the
                                  #   first browser connects, then binds only if
                                  #   exactly one matches --browser. More than one
                                  #   exits 2 with BRIDGE_AMBIGUOUS. None matching keeps
                                  #   waiting for one to connect, then exits 2 with
                                  #   BRIDGE_NO_CANDIDATE at the attach timeout.
                                  #   Both list each browser seen.
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

Bridge (after attach --extension):
  bridge control [--active | --tab-id <#n|id> | --stop]
                                      # point the bridge at a tab (same ids as 'tab')
  bridge instances                    # connected browsers, bound + parked
  bridge use <instance-id|browser|label>
                                      # bind a different browser
  bridge reload [--timeout <ms>] [--force]
                                      # reload the extension, no click needed
  bridge stats [--reset]              # relayed CDP calls per method since attach

Tab:
  tabs [--browser <id|edge|chrome|label>]
                                  # one line per tab:
                                  #   #n  id  "title"  Browser · Profile  controlledBy=…
                                  # bridge ids are <brand>-<profile>:<chrome tab id>,
                                  #   e.g. edge-work:42 (profile = popup "Profile name")
                                  # bridge: --browser lists another connected
                                  #   browser's tabs without taking it over
                                  # --browser all daemon: every bound browser,
                                  #   numbered #1..N; a silent one is a `note:` row
  tab <'#n' | id | n> [--quiet]   # '#n' = row n of the last 'tabs' (quote the #);
                                  #   n alone only if exactly one tab has that
                                  #   chrome tab id. --quiet = don't bringToFront
                                  #   a tab in another bound browser makes it active
  find <url-substring>            # list tabs matching (pipe into 'tab')
  new-window [url]                # new background window, same profile
  goto <url> [--stable]           # --stable also waits for the DOM to settle
  back | forward | reload
  eval <js> [--timeout <ms>] [--no-wait]
                                  # auto-retries once past a nav-in-flight
                                  #   awaits Promises/async IIFEs automatically
                                  #   --timeout: per-call deadline (bridge default 30 s)
                                  #   --no-wait: run on a 0 ms timer, return at once
                                  #     ({ok,dispatched}); errors go to `ghax console`
  try [<js>] [--css <rules>] [--selector <sel>] [--measure <expr>] [--shot <path>]
  text
  html [<selector>]
  screenshot [<@ref|selector>] [--path <p>] [--full-page] [--path-only]
                                  # --path-only prints just the file path

Snapshot & interact:
  snapshot [-i] [-c] [-d <N>] [-s <sel>] [-C] [-a] [-o <path>]
           [--max-refs <n>] [--max-chars <n>] [--no-cap]
           [--grep <regex> [--context <N>]]
                                  # print only matching lines, their ancestors, and
                                  #   N lines after each; applied before the cap.
                                  #   Refs still all resolve. Use --grep=<re> for
                                  #   a pattern that starts with a dash.
                                  # prints at most 250 refs / 32 KB by default and
                                  #   ends with "… N more refs omitted"; every ref
                                  #   stays clickable. --max-refs 0 = --no-cap.
  click <@ref|selector> [--force]           # refuses covered, disabled, inert,
                                             #   hidden targets; --force skips that
  fill <@ref|selector> <value> [--force]    # Monaco-aware: routes into
                                             #   monaco.editor.getEditors() when
                                             #   the target is inside a Monaco editor.
                                             #   Refuses disabled/read-only fields.
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
  console [--errors] [--last N] [--since <epoch-ms>] [--dedup] [--source-maps] [--tab <#n|id>] [--all]
         # bridge mode: the active tab only; --tab <#n|id> picks another tab,
         #   --all lifts the filter (every tab of every bound browser);
         #   no active tab is an error, not an empty list. --last N counts
         #   the selected tab's entries. --follow is NOT tab-filtered yet:
         #   it streams every bound browser's entries
         # --since filters to entries newer than the epoch-ms timestamp
         # --dedup groups repeats with count
         # --source-maps resolves bundled stack frames to original sources
  network [--pattern <re>] [--status 4xx|500|400-499] [--last N] [--since <epoch-ms>] [--har <path>] [--tab <#n|id>] [--all]
         # bridge mode: same tab scoping as console (and --follow caveat)
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
  cookies delete <name> [--domain <d>] [--url <u>] [--path <p>]
         # Works on CDP and over the bridge. Deletes exactly one cookie:
         #   scope is the active tab (or --all/--domain/--url); if the name
         #   matches more than one domain/path it refuses and lists them
         #   (name, domain, path; never values). --domain must equal the
         #   cookie's domain, --path must equal its path.
  auth export --out <path> --domain <d>[,<d>...] [--origin <url>...] [--force]
         # Writes a Playwright storageState file (newContext({storageState}))
         #   from the attached browser. Works on CDP and over the bridge.
         # --domain is required: cookies whose domain equals a listed domain
         #   or is a subdomain of it (list example.com to get .example.com).
         # --origin adds that origin's localStorage, read from a tab already
         #   open there (bridge: the controlled tab). Never navigates.
         # The file is created 0600 and never printed. Refuses an existing
         #   file without --force, a symlink, and an un-gitignored path in a
         #   git work tree. Prints counts, path and earliest expiry only
         #   (and the file mode on POSIX; Windows has none).
         # --domain matches literally, public suffixes included: co.uk or
         #   github.io would export every site under them. Name the site.

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
  gesture scroll <up|down|left|right> [amount] [--on <@ref|selector>]
                                  # --on aims the wheel at that element (scrolled into view)
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
Each call to the daemon times out after 120 s (GHAX_RPC_TIMEOUT=<seconds>,
  0 = none); verbs with their own --timeout get that plus 30 s; batch gets
  120 s per step.
Put -- before a value that starts with a dash (ghax eval -- '--i').
No daemon for this directory? If exactly one ghax daemon is running anywhere
  (registered in ~/.ghax/daemons/), commands use it and say so on stderr. More
  than one: the error lists each with the GHAX_STATE_FILE to set. attach never
  reuses another directory's daemon.
Add --trace to any command for a one-line CDP call summary on stderr
  (count, time, heaviest methods). stdout is unchanged.
"#;
