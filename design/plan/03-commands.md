# ghax — command surface (v1)

Flat command structure. `ghax <verb> [args]`. No nesting deeper than two
levels unless a subcommand grows a lot of options.

## Connection

| Command | What it does |
|---------|-------------|
| `ghax attach [--port 9222] [--browser edge\|chrome]` | Connect to running browser. Launch it with CDP flag if not running. |
| `ghax status` | Show attached browser, extension list, open tab count, daemon uptime. |
| `ghax detach` | Shut down daemon. Doesn't close browser. |
| `ghax restart` | Bounce daemon, reconnect to same browser. |

## Tab QA (gstack-browse-compatible surface)

| Command | Notes |
|---------|-------|
| `ghax tabs` | List tabs (id, title, url) |
| `ghax tab <id>` | Switch active tab |
| `ghax goto <url>` | Navigate active tab |
| `ghax back` / `ghax forward` / `ghax reload` | History nav |
| `ghax snapshot [-i] [-a] [-o <path>] [-d <depth>]` | A11y tree with `@e<n>` refs. `-i` interactive only, `-a` annotated screenshot, `-C` cursor-interactive |
| `ghax click <@ref\|selector>` | Click (React-synthetic event) |
| `ghax fill <@ref\|selector> <value>` | Native setter + input event (React-safe) |
| `ghax type <text>` | Type into focused element |
| `ghax press <key>` | Enter, Tab, Escape, cmd+a, etc. |
| `ghax screenshot [@ref\|selector] [path]` | Viewport, element, or full-page |
| `ghax text` | Clean page text |
| `ghax html [selector]` | innerHTML |
| `ghax console [--errors] [--follow]` | Console messages |
| `ghax network [--pattern re]` | Network requests |
| `ghax cookies` / `ghax storage` | Cookies, localStorage, sessionStorage |
| `ghax eval <js>` | Evaluate JS in active tab |
| `ghax is <visible\|enabled\|checked\|...> <selector>` | Assertions |
| `ghax responsive [prefix]` | Mobile/tablet/desktop screenshots |
| `ghax viewport <WxH>` | Resize viewport |
| `ghax diff <url1> <url2>` | Text diff two pages |
| `ghax chain` | JSON batch from stdin |
| `ghax wait <sel\|--networkidle\|--load\|ms>` | Wait for condition |

## Real user gestures

For APIs that require a real gesture (`chrome.sidePanel.open()`, etc.) — uses
CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` which DO count as
user gestures. Plain JS `.click()` does not.

| Command | Notes |
|---------|-------|
| `ghax gesture click <@ref\|x,y>` | Real mouse down + up |
| `ghax gesture dblclick <@ref\|x,y>` | |
| `ghax gesture key <key>` | Real keydown + keyup |
| `ghax gesture scroll <dir> [amount]` | Real scroll-wheel event |

## MV3 extension internals (what's new vs gstack)

| Command | Notes |
|---------|-------|
| `ghax ext list` | All installed extensions with id, name, version, enabled |
| `ghax ext reload <ext-id>` | `chrome.runtime.reload()` |
| `ghax ext targets <ext-id>` | List SW / sidepanel / popup / options / content-script targets |
| `ghax ext sw <ext-id> eval <js>` | Evaluate in service worker context |
| `ghax ext sw <ext-id> logs [--follow]` | Tail SW console |
| `ghax ext panel <ext-id> [eval <js>\|screenshot\|click\|...]` | Interact with side panel as a tab |
| `ghax ext popup <ext-id> ...` | Same for browser-action popup |
| `ghax ext options <ext-id> ...` | Same for options page |
| `ghax ext storage <ext-id> [local\|session\|sync] [get\|set\|clear]` | Read/write `chrome.storage.*` from SW context |
| `ghax ext message <ext-id> <type> [data]` | `chrome.runtime.sendMessage` wrapper |

## QA workflow helpers

| Command | Notes |
|---------|-------|
| `ghax record start [name]` | Start recording commands |
| `ghax record stop` | Save to `.ghax/recordings/<name>.json` |
| `ghax replay <file>` | Execute recorded script |
| `ghax gif <recording> [out.gif]` | Render recording as GIF (ffmpeg) |
| `ghax diff-state <before> <after>` | Diff two snapshots (storage, console, etc.) |

## Exit codes

- `0` — success
- `1` — command error (bad args, element not found)
- `2` — browser not attached
- `3` — target not found (wrong ext id, wrong tab id)
- `4` — CDP error
- `10` — daemon not running (auto-start failed)

## Output format

- Default: human-readable text
- `--json` flag on any command for JSON output (for piping / LLM use)
