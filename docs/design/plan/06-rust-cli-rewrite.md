# Rust CLI rewrite — design + plan

**Status:** planned, not started. This doc is the source of truth for the
work when we're ready to pick it up.

**Decision date:** 2026-04-19. Driver: portability + binary size for
open-source distribution. We will not publish ghax until we're happy with
what users download. The current Bun-compiled 61MB universal blob is the
last remaining concern; a Rust binary cuts that to ~10MB per platform and
ships with no runtime dependency.

## Motivation

The v0.4 feature surface is complete and stress-tested (70-check smoke,
cross-browser, perf budgets, source-map resolution, shell mode, etc.).
What's left before a public release is **how it lands in a user's
machine.** Three concerns with the current distribution:

1. **Binary size.** `dist/ghax` is 61MB because Bun's `--compile` embeds
   the entire Bun runtime. Users downloading a CLI don't expect a 60MB
   blob. `brew install ghax` with a 10MB binary is a different
   experience than pointing at a 60MB release artifact.

2. **Per-platform shipping with Bun is awkward.** Bun supports
   `--target=linux-x64` etc., but each target is still ~30-40MB, and
   Bun's cross-compile story for Windows is weaker than Rust's.
   `cargo build --release --target <triple>` is the standard, well-worn
   path for cross-platform CLI distribution today.

3. **Cold start.** 37ms per invocation is the Bun CLI floor. For
   interactive humans it doesn't matter. For CI pipelines running ghax
   per-step, or agents not using shell mode, a Rust binary at 2-5ms cold
   start is a real improvement (saves ~3 seconds over 100 invocations).

Performance was not the primary reason — shell mode already gives us
4.4ms/cmd which beats every competitor. Rust is about **distribution +
perception + long-term maintainability** of a public tool.

## Scope

**In scope:**
- Rewrite the entire CLI (`src/cli.ts`, ~2,071 lines) in Rust.
- Match the current feature surface: every verb, every flag, every
  output format, `--json` behavior, exit codes.
- Produce platform-specific binaries via `cargo-dist` with GitHub
  Actions matrix builds.
- Dual-maintenance window: Bun CLI + Rust CLI both work during the
  transition. `bin/ghax` shim prefers Rust when present.

**NOT in scope:**
- The daemon stays Node/Playwright. `dist/ghax-daemon.mjs` is unchanged.
  Rewriting the daemon would mean replacing Playwright, which is a
  multi-month project and a different decision. Keep the working part
  of the stack.
- Direct-CDP implementation in Rust (skipping Playwright entirely). That
  is a future possibility if ghax becomes a flagship project and we
  want "Rust-native browser automation" as the pitch. Out of scope for
  this rewrite.
- Rust-native browser launch via `chromiumoxide` or similar. The
  daemon launches the browser today; Rust CLI just tells the daemon to.

## Architecture after rewrite

```
┌─────────────────────────────────────────────────────────┐
│  ghax CLI (Rust, ~10MB per platform, ~2-5ms cold start) │
│    clap argv  →  HTTP POST /rpc  →  print result        │
│    tokio for SSE streams and shell-mode REPL            │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTP (unchanged protocol)
                        ▼
┌─────────────────────────────────────────────────────────┐
│  ghax daemon (Node ESM bundle — unchanged from v0.4)    │
│    Playwright + raw CDP, exactly as today               │
└─────────────────────────────────────────────────────────┘
```

The HTTP RPC protocol is the clean language boundary. Rust talks to Node
over HTTP+JSON the same way the Bun CLI does today. Nothing about the
daemon needs to change.

## Dependency choices

Keep the dep list short. Each one earns its place.

| Crate | Purpose | Why this one |
|-------|---------|--------------|
| `clap` (derive API) | Argv parsing | Industry standard. Matches the verb + flag surface we have cleanly. Derive macros keep code readable. |
| `reqwest` (`blocking` + `stream` features) | HTTP client | Well-maintained, supports SSE via `bytes_stream()`. Use blocking API for most commands (one HTTP call each), async for SSE + REPL. |
| `tokio` (`rt-multi-thread`, `macros`) | Async runtime for SSE + shell | Required for `reqwest` async. Use blocking `reqwest::blocking` for simple commands to avoid async overhead on the hot path. |
| `serde` + `serde_json` | JSON encode/decode | Industry standard. Named types per RPC shape. |
| `rustyline` | Shell mode REPL | Readline-compatible: history, cursor movement, Ctrl-C handling. 1-2MB binary cost. |
| `anyhow` | Error handling | Pragmatic error propagation in a CLI. |
| `which` | Binary discovery (ffmpeg, git, gh, node) | Cross-platform PATH lookup. |

Deliberately NOT using:
- `async-std` (tokio is the default, single async runtime preferred)
- `hyper` directly (reqwest wraps it cleanly)
- `structopt` (superseded by clap derive)

## Feature parity matrix

Every current verb, grouped by implementation complexity. Items marked
**[complex]** have logic in the CLI itself (not just RPC + print) and
need careful porting.

### Trivial — pure RPC + print (45 verbs)

`tabs`, `tab`, `find`, `new-window`, `goto`, `back`, `forward`, `reload`,
`eval`, `try`, `text`, `html`, `screenshot`, `snapshot`, `click`, `fill`,
`press`, `type`, `wait`, `viewport`, `responsive`, `diff`, `is`,
`storage`, `cookies`, `console` (non-follow), `network` (non-follow),
`xpath`, `box`, `perf`, `profile`, `diff-state`, `ext list`, `ext
targets`, `ext reload`, `ext hot-reload`, `ext sw eval`, `ext panel
eval`, `ext popup eval`, `ext options eval`, `ext storage`, `ext
message`, `gesture click`, `gesture dblclick`, `gesture scroll`,
`gesture key`, `pair status`.

Pattern: parse argv → `reqwest::blocking::post` to /rpc → deserialize →
print (text or JSON). ~15 LOC per verb. Most will share a
`makeSimple()`-equivalent helper.

### Medium — has CLI-side logic (8 verbs)

| Verb | What it does | Rust plan |
|------|--------------|-----------|
| `attach` | Probes CDP ports, launches browser if `--launch`, spawns daemon subprocess | Port `browser-launch.ts` semantics. `std::process::Command` for browser launch. `reqwest` for CDP probe. Spawn daemon via `std::process::Command` with env vars for `GHAX_*`. |
| `detach` | POSTs shutdown, kills daemon if unresponsive | 3 LOC. |
| `restart` | `detach` + `attach` | 2 LOC. |
| `status` | RPC + pretty-print tabs/targets/extensions | ~30 LOC. |
| `qa` | URL list parsing, crawl via sitemap.xml, per-URL report aggregation | ~200 LOC. Shell out to daemon for per-URL work, aggregate in Rust. |
| `canary` | Long poll loop with SIGINT handling | ~100 LOC. Use `tokio::signal::ctrl_c()` for clean shutdown, async loop. |
| `review` | Shells out to `git` for diff + log, formats Claude-ready prompt | ~50 LOC. `std::process::Command::new("git")`. |
| `ship` | Shells out to `git` + `gh`, runs typecheck+build | ~150 LOC. Same shell-out pattern, multi-step orchestration. |

### Complex — SSE streaming + REPL (3 surfaces)

| Surface | Rust plan |
|---------|-----------|
| `console --follow` / `network --follow` | `reqwest` async stream from `/sse/console` et al. Parse `data:` lines, print each. `tokio::signal::ctrl_c()` for clean exit. |
| `ext sw <id> logs --follow` | Same pattern, different endpoint. |
| `shell` (REPL) | `rustyline::Editor` with history. Per line: tokenize (reuse the tokenizer logic — port directly), dispatch to argv parser, call command. `exit`/`quit`/Ctrl-D semantics preserved. |

### External tool integrations (stay as subprocess calls)

- `ffmpeg` (used by `gif` and `qa --gif`) — `std::process::Command`.
- `git` (used by `ship`, `review`) — same.
- `gh` (used by `ship`) — same.
- `pkill` (used by some cleanup paths) — same.

## Distribution plan

### Build pipeline

`cargo-dist` is the emerging standard for Rust CLI distribution. It
generates a GitHub Actions workflow that builds the matrix on tag push,
publishes to GitHub Releases with checksums, and emits Homebrew tap +
npm tarball wrappers.

Matrix targets:

| Target triple | Platform | Approx binary size (stripped) |
|---------------|----------|-------------------------------|
| `x86_64-apple-darwin` | Intel Mac | ~10MB |
| `aarch64-apple-darwin` | Apple Silicon | ~9MB |
| `x86_64-unknown-linux-gnu` | Linux x64 | ~11MB |
| `aarch64-unknown-linux-gnu` | Linux ARM | ~10MB |
| `x86_64-pc-windows-msvc` | Windows x64 | ~10MB |
| `aarch64-pc-windows-msvc` | Windows ARM | ~10MB |

Total 6 binaries per release, each ~10MB. Compare to the current 61MB
universal Bun blob — roughly 6x smaller per platform.

### Install paths

Users pick the one that fits them:

```bash
# Homebrew (macOS / Linux)
brew install kepptic/tap/ghax

# Cargo (for Rust folks)
cargo install ghax

# npm (pairs naturally with the daemon install)
npm install -g @ghax/cli

# Direct download
curl -L https://github.com/kepptic/ghax/releases/latest/download/ghax-$(uname -s)-$(uname -m).tar.gz | tar xz
```

### Daemon distribution

The daemon is still a Node ESM bundle. Options:

1. **Require Node, download daemon lazily on first run.** Rust CLI
   checks for `node` in PATH, prompts if missing. On first `ghax attach`,
   fetches the daemon bundle from GitHub Releases to
   `~/.ghax/daemon/<version>/ghax-daemon.mjs`. Subsequent runs use cached.

2. **Ship daemon alongside CLI in the release archive.** `ghax.tar.gz`
   contains both `ghax` and `ghax-daemon.mjs`. `brew install ghax` drops
   both into `/opt/homebrew/bin/` and `/opt/homebrew/share/ghax/`
   respectively. Rust CLI looks up daemon path relative to its own
   `argv[0]` location.

3. **npm-dual package.** `@ghax/cli` (npm) pulls in Rust binary from
   GitHub Releases on postinstall AND ships the daemon bundle in the
   same package. Standard pattern for cross-language CLIs (see
   @swc/core, esbuild).

Recommendation: **option 2 for Homebrew and direct-download, option 3
for npm.** Both approaches ship daemon bytes alongside CLI bytes so
there's no "download step on first use."

Node dependency: we require `node >= 20` for the daemon. This is a hard
dependency, documented clearly. Users of any Playwright-based tool
already have Node; we're not adding a new expectation.

## Phasing — incremental, never big-bang

Never replace the working Bun CLI until the Rust CLI has parity and has
been dogfooded. Strangler fig pattern.

### Phase 1 — Plumbing + trivial verbs (~3-4 days)

- `crates/cli/` workspace in the repo. `Cargo.toml`, `rustfmt.toml`,
  `.cargo/config.toml` for cross-compile targets.
- `clap` argv parser with all 60+ verbs enumerated (even if unimplemented).
- `reqwest::blocking` HTTP RPC client.
- `serde` types for every RPC shape (mirror the TS interfaces).
- Implement the ~45 trivial verbs.
- `cargo-dist` config for matrix builds.
- New smoke harness: `test/rust-smoke.ts` runs every smoke check against
  the Rust binary instead of `dist/ghax`.

**Exit criteria:** 45 verbs work end-to-end. `test:rust-smoke` passes
whatever subset of the 70 smoke checks don't depend on unimplemented
verbs.

### Phase 2 — Medium verbs with CLI-side logic (~1 week)

- Port `attach` (browser detection, probe, launch, daemon spawn).
- Port `qa` (URL parsing, crawl, report aggregation).
- Port `canary` (poll loop, SIGINT).
- Port `ship`, `review`, `pair`.
- Port shell-outs to `ffmpeg`, `git`, `gh`.

**Exit criteria:** 100% of verbs work. Full 70-check smoke passes
against Rust binary.

### Phase 3 — SSE + REPL (~3 days)

- Async `reqwest` stream parser for `/sse/console`, `/sse/network`,
  `/sse/ext-sw-logs/<id>`.
- `rustyline`-based `ghax shell` with history, tokenizer, Ctrl-C
  handling.

**Exit criteria:** `console --follow`, `network --follow`, `ghax shell`
all work against Rust binary. Shell-mode perf budget <15ms/cmd asserted.

### Phase 4 — Switch default + deprecate Bun CLI (~1 day)

- `bin/ghax` shim prefers `dist/ghax-rust` (the new binary) when
  present, falls back to `dist/ghax` (Bun).
- `bun run install-link` installs the Rust binary.
- CI build matrix adds Rust compile job.
- Smoke + cross-browser + perf all run against Rust binary by default.
- README + CLAUDE.md + ARCHITECTURE updated.
- `dist/ghax` (Bun binary) stays as fallback for 1 release, then
  removed.

**Exit criteria:** Rust binary is the ghax that users install. Bun build
artifacts deleted. Daemon bundle unchanged.

## Dual-maintenance window

During phases 1-3, every change to the CLI must land in both TS and
Rust. This is real cost. We mitigate by:

1. **Phase 1 moves fast** (~3-4 days) because 45 verbs are template
   code.
2. **No new CLI features during the rewrite window.** Freeze the Bun
   CLI feature set. Bug fixes only. New verbs wait for phase 4.
3. **Parity test** — a CI job that runs the same smoke suite against
   both binaries and diffs the outputs. Any divergence fails the
   build.

## Tests

### Smoke suite

The existing `test/smoke.ts` already works against `dist/ghax`. Add:

```typescript
// test/smoke.ts — single env var switch
const GHAX_BIN = process.env.GHAX_BIN ?? path.join(root, 'dist', 'ghax');
```

Then `GHAX_BIN=./target/release/ghax bun run test:smoke` runs the whole
suite against the Rust binary. CI matrix runs it against both.

### Parity diff test

`test/parity.ts` — runs each of the ~20 "deterministic" verbs (tabs,
status, text, eval '1+2', etc.) against both binaries and asserts
byte-equal output. Any format drift (extra whitespace, different JSON
key order) fails loud.

### Perf budget test

`test/perf-bench.ts` already exists. When Rust is ready:

- Expect `eval trivial` P50 to drop from ~30ms (Bun) to ~5-8ms (Rust).
- Update the P50 budget to enforce the Rust floor.
- Fail if a future change regresses back toward Bun-level cold start.

### Cross-browser

`test/cross-browser.ts` is unchanged — it drives the binary (Bun or
Rust) the same way.

## Risks + mitigations

| Risk | Mitigation |
|------|------------|
| Scope creep — touching daemon logic while rewriting CLI | Hard rule: daemon is off-limits during rewrite. Bug fixes to daemon go through the Bun path until rewrite is done. |
| Output format drift between TS and Rust CLI | Parity diff test catches it in CI. Breaks the build on any format change. |
| `reqwest` SSE parsing doesn't handle daemon's exact format | Daemon's SSE is standard `data: <json>\n\n` with `:ping\n\n` keepalives. Well-defined. Write a 50-LOC parser + unit tests against recorded daemon output. |
| `rustyline` vs Bun readline behavior differences (history file, prompt ANSI) | Document differences. `rustyline` is more capable than Node's readline, not less. |
| Cross-compile toolchain setup (Linux ARM on a Mac) | `cargo-dist` handles this via its own docker-based cross-compile. Standard pattern. |
| Dev-loop slows down — two languages to context-switch | Accepted cost of the rewrite window. Phase 4 ends it. |
| Feature drift during the rewrite window (new Bun CLI features land that Rust doesn't have) | Freeze new CLI features for the window. Document in TODOS.md. |

## Success criteria

Rust CLI ships when ALL of these are true:

1. `cargo build --release` produces binaries for 6 target triples, each
   <15MB stripped.
2. Full 70+ smoke suite passes against Rust binary on both Edge and
   Chrome.
3. `test/perf-bench.ts` shows Rust `eval trivial` P50 at or below 10ms
   (vs 30ms Bun). Demonstrates the cold-start win.
4. `test/parity.ts` — zero output divergence between Bun and Rust for
   the deterministic-verb set.
5. `bun run test:capture-bodies` passes against Rust.
6. `cargo-dist` GitHub Actions release workflow exists and has run
   successfully on a tag (can be a `-rc1` pre-release).
7. Homebrew formula works: `brew install ghax && ghax attach && ghax
   goto https://example.com` end-to-end on both macOS arches.
8. README + CLAUDE.md + ARCHITECTURE all updated to describe Rust CLI
   + Node daemon split.

When all 8 are green, flip `bin/ghax` to prefer the Rust binary, tag
`v1.0.0`, and we're ready to go public.

## What this doesn't change

- The daemon architecture, Playwright use, MV3 hot-reload, source-map
  resolution, capture buffers, SSE endpoints, the way `GHAX_STATE_FILE`
  enables multi-agent isolation. All of that is daemon-side and stays
  exactly as it is.
- The skill system (`/kepptic-ghax`, `/kepptic-ghax-browse`). Skills
  talk to `ghax` as a binary — doesn't matter what language it's in.
- The test surface, benchmark harness, cross-browser harness, perf
  budgets. Same tests, different binary underneath.

## Estimated timeline

With CC+gstack on active sessions:

| Phase | Scope | Active dev time |
|-------|-------|-----------------|
| Phase 1 | Plumbing + 45 trivial verbs | ~1 day |
| Phase 2 | 8 medium verbs | ~1-2 days |
| Phase 3 | SSE + REPL | ~0.5 day |
| Phase 4 | Switch + deprecate + docs | ~0.5 day |
| **Total** | Full rewrite + release | **~3-4 days active** |

Realistically spread over 2-3 weeks of calendar time with breaks and
dogfooding in between.

## Open questions

1. **Workspace layout** — new `crates/cli/` directory in the ghax repo,
   or a separate `kepptic/ghax-cli` repo? Monorepo is simpler for
   cross-language parity tests. Leaning monorepo.

2. **Minimum supported Rust version** — pin at stable `1.80+`? Reasonable.

3. **Daemon discovery path** — where does the Rust CLI look for the
   daemon bundle? Options: alongside the binary (Homebrew default),
   in a known location like `~/.ghax/daemon/ghax-daemon.mjs`, or via
   an env var `GHAX_DAEMON_BUNDLE`. Decision: all three, in that
   precedence order.

4. **Do we publish the Rust CLI to crates.io?** Probably yes when we
   ship `v1.0.0`. Name: `ghax` (available at time of writing).

5. **Post-rewrite: does the TypeScript CLI source stay in the repo?**
   Leaning toward delete after 1 release of Rust being default.
   Historical git tags preserve it if anyone needs to reference.
