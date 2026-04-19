# Security

ghax is a developer tool that drives the user's real browser. Its
threat model is different from a server-side service. This doc explains
what we protect against, what we don't, and how to report a vulnerability.

## Threat model

**In scope:**
- Local privilege escalation via crafted CLI input (e.g. command
  injection, path traversal in `--data-dir`, `--out`, `--shot`).
- Cross-origin attacks against the daemon's HTTP RPC from another
  local process on the same machine.
- Unsafe handling of data read from extension storage, cookies, or
  network-capture output (leaks through logging, etc.).

**Out of scope:**
- Attacks from the browser the user explicitly attached ghax to.
  If your browser is compromised, CDP already gives an attacker
  everything. ghax doesn't widen that surface.
- Attacks that require local shell access to the user's account.
  Someone who can run commands as you can already do anything ghax
  can do.
- Remote network attacks. The daemon binds to `127.0.0.1` only and
  has no authentication because it doesn't need any — there's no
  network exposure.

## Security model

### Daemon binding

The ghax daemon listens on `127.0.0.1:<ephemeral port>`. It does NOT
listen on `0.0.0.0`, does NOT expose any TLS endpoint, and does NOT
accept inbound connections from outside the loopback interface. The
port is written to `.ghax/ghax.json` and read by the CLI.

**No auth token** is required to call the daemon because the attack
surface is "other local processes on this machine" — and anything
running as your user can already control your browser directly. The
daemon just exposes a slightly nicer interface to the same
capability.

### Code execution paths

ghax has two ways of running arbitrary JavaScript:

1. `ghax eval <js>` and the internal `page.evaluate()` call — runs in
   the attached browser page context. Equivalent to pasting into the
   DevTools console. The JS comes from the operator's own shell.
2. `ghax ext sw/popup/options/panel eval <js>` — same, but targeted
   at an extension's JS context. Same trust boundary.

There is **no path** for external (non-operator) input to reach
`page.evaluate()`. HTTP request bodies arrive at `/rpc`, are parsed
as JSON, and are dispatched by name to a registered handler. The
handlers never pass raw request data through to `page.evaluate()`;
the `eval` handler takes only the `js` field from the parsed body,
which is already local-process-authenticated by virtue of binding
to 127.0.0.1.

### Data exposure

ghax can read:
- Every tab's DOM, cookies, localStorage, sessionStorage.
- Every extension's `chrome.storage.*` (auth tokens often live here).
- Full console + network capture (5k rolling buffers each).
- Page errors including stack traces and source locations.

Anything ghax reads, the operator has already authorized by virtue of
being logged in. Treat `ghax ext storage` output the way you'd treat
`localStorage.getItem('auth_token')` — don't paste it into chat, don't
commit it, don't send it to an LLM without redaction.

### What ghax intentionally does NOT do

- **Store credentials.** No config file ever contains passwords, API
  keys, or session tokens. The browser profile is the source of
  truth, and ghax just reads through it.
- **Write to the user's real browser profile.** With `--launch`, ghax
  uses a scratch profile at `~/.ghax/<kind>-profile/`. Pointing at the
  real profile via `--data-dir <path>` is supported for power users
  but requires the real browser to be closed first (fragile otherwise,
  as the keychain lock conflicts).
- **Expose captured data over the network.** Everything stays on the
  machine. The daemon's SSE streams bind to 127.0.0.1.

### Multi-agent isolation

Each agent/session uses its own `GHAX_STATE_FILE=/tmp/ghax-<name>.json`
and gets its own daemon + window. Agents can't see each other's active
tabs or captured buffers. They do share the browser process (same
profile, same cookies) — that's the whole point, and it's on the
operator to decide which agents to give access to.

### `ghax pair` (remote agent)

The shipped `pair` mode prints SSH-tunnel setup instructions. The
remote agent reaches into `127.0.0.1:<port>` via an SSH `-L` forward,
and SSH handles authentication. The daemon doesn't change its
behavior — still localhost-bound, still no auth needed on the RPC.

**Multi-tenant `pair` with bearer tokens + non-localhost binding is
explicitly deferred** (see `design/plan/04-roadmap.md`). Exposing the
RPC surface to a real network dramatically enlarges the attack
surface: any input-validation bug becomes remote code execution on
your browser. Not shipping that without a dedicated security review.

## Reporting a vulnerability

This repo is private under `kepptic` at time of writing. If you're
reading this as an outside contributor after it goes public:

- **Do NOT open a public issue** for anything that looks like a
  security bug.
- Email the maintainer directly. Preferred subject line:
  `[ghax security] <brief description>`.
- Include steps to reproduce, impact assessment, and any suggested
  mitigation.

We'll acknowledge within 72 hours, assess within a week, and ship a
fix within 30 days for confirmed high-severity issues. Lower-severity
issues get fixed on the next normal release cycle.

## Dependency security

ghax runs under Bun (CLI binary) and Node (daemon bundle). Playwright
is the primary runtime dependency — we track upstream advisories and
bump on security releases.

Everything else (`fs`, `http`, `url`, etc.) is Node/Bun standard
library, not third-party. We do not depend on any package that
executes arbitrary code during install (no postinstall hooks, no
native bindings that compile).

Bundle sizes:
- `dist/ghax` — 61MB Mach-O (Bun compiled, includes the Bun runtime)
- `dist/ghax-daemon.mjs` — ~70KB Node ESM (Playwright marked external)

The daemon is reviewable in under an hour. Read it; you won't find
any shell-out paths that take untrusted input.
