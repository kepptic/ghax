# 2026-06-06: Edge attach reports success but daemon state is immediately lost

> **Status: RESOLVED (2026-07-10).** Root cause + fix below. See
> `CHANGELOG.md` → Unreleased → Fixed.

## Resolution (2026-07-10)

**Root cause.** `ghax attach` spawned the Node daemon with
`std::process::Command::spawn`, which places the child in the CLI's own
**process group and session**. `attach` returns the instant the daemon is
healthy, but the daemon keeps sharing that group. When `ghax attach` runs
under anything that reaps the command's process group on exit — Claude Code's
Bash tool, CI runners, or terminal job-control that SIGHUPs the foreground
group when the shell closes — the teardown signal (SIGTERM/SIGHUP) reaches the
daemon too. The daemon runs its normal `shutdown()` path, which **unlinks its
own state file**, then exits. That is why the *next* command sees either
`not attached` (state file already removed — repro 2's `ghax status → not
attached`) or `daemon (pid N) is not running` (process dying, state not yet
unlinked — repro 1/3). The high "control port" (`65154`, `64098`) was a red
herring: `server.listen(0)` legitimately binds a random ephemeral port.

This was environment-dependent, which is why it wasn't caught by the smoke
suite (attach + follow-ups run inside one long-lived process there) nor
reproducible in every shell — a plain interactive shell does not signal the
group, so the orphaned daemon simply reparents to init and survives.

**Fix.** The daemon is now spawned via `setsid()` (Rust `pre_exec` in
`crates/cli/src/attach.rs::build_daemon_cmd`) so it starts a **new session +
process group with no controlling terminal**. Group signals aimed at the
launcher's process group and terminal-close SIGHUP can no longer reach it.

**Diagnosability.** `ghax status` now prints the daemon log path
(`<state_dir>/ghax-daemon.log`) and, when no daemon is live, echoes the log's
last event — so a departed daemon self-reports `shutdown: SIGTERM` /
`shutdown: idle` / `browser disconnected …` instead of a mute `not attached`.

**Regression tests** (`test/smoke.ts`): (a) detach → attach → wait 1.5s →
`status` still attached; (b) launch attach as its own process-group leader,
`kill -KILL` that whole group, assert the daemon is still alive and answering.


## Context

While debugging Conduit remote-display sessions in Microsoft Edge, Edge was already running with CDP enabled on port `9222`.

Direct CDP was healthy:

```sh
curl -fsS http://127.0.0.1:9222/json/version
```

Returned browser metadata including:

```json
{
  "Browser": "Edg/148.0.3967.96",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/..."
}
```

## Repro

```sh
ghax attach --port 9222
ghax tab 360ECE029D944BF66CD42FB3A14D98AE
```

Observed:

```text
ghax: daemon (pid 82926) is not running — run `ghax attach`
```

After clearing stale state:

```sh
ghax restart
ghax attach --port 9222 --verbose
ghax status --json
```

Observed:

```text
stale state file cleared
attached — pid 86290, port 65154, browser edge
not attached
```

## Expected

After `ghax attach --port 9222`, subsequent `ghax status`, `ghax tab`, `ghax eval`, and `ghax network` commands should use the attached browser until `ghax detach` or `ghax restart`.

## Notes

- The browser target list was available through direct CDP at `http://127.0.0.1:9222/json/list`.
- Direct CDP evaluation against `ws://127.0.0.1:9222/devtools/page/<tab-id>` worked.
- `ghax attach --port 9222 --verbose` reported an unexpected control port (`65154`) and then no persisted attachment.
- This made `ghax network` and other follow-up commands unreliable during Conduit testing.

## Repro Again During Conduit Tile Artifact Hotpatch

Later the same day, after deploying the Conduit relay/dashboard web hotpatch, the
same attach persistence failure reproduced:

```sh
ghax status --json
# not attached

ghax attach --browser edge --port 9222 --verbose
# attached — pid 43179, port 64098, browser edge

ghax tabs
# ghax: daemon (pid 43179) is not running — run `ghax attach`
```

This blocked a post-deploy visual check of the Conduit remote tab through ghax.
