# Conduit P2P QUIC always fails — port mismatch (relay reports 443, agent listens on 51820)

**Filed:** 2026-05-13
**Conduit version observed:** 0.7.2 (CLI), production relay `conduit-dash.dagtech.com`
**Repo this belongs in:** `kepptic/products/apps/conduit` (not ghax — filing here per the docs/ request, but the fix lives in conduit-relay)

## Symptom

Every `conduit exec` and `conduit tunnel` invocation emits:

```
Trying P2P QUIC → <agent_public_ip>:443...
P2P QUIC connect failed, falling back to relay
```

This adds the 3-second QUIC connect timeout (`crates/cli/src/main.rs:397`) to every CLI call before the relay path kicks in. It also pollutes stderr on what would otherwise be quick commands.

## Repro

```
$ conduit --api-key $CONDUIT_API_KEY exec \
    --agent-id 5dc5a81b-a646-4c64-84f0-140a92b6dd41 \
    --command "echo hi"
Trying P2P QUIC → 76.79.111.98:443...
P2P QUIC connect failed, falling back to relay
hi
```

Reproduces on every call against any agent the CLI talks to. Agent in repro is `kali` at `LACCLB01` (public WAN `76.79.111.98`, behind SonicWall TZ470 with no UDP 443 forward).

## Root cause

Two facts:

1. **Agent binds UDP 51820 for P2P QUIC** —
   `crates/agent/src/connection.rs:558` → `P2PListener::new(51820)`,
   `crates/agent/src/installer.rs:581` adds the macOS firewall exception for "UDP 443" (already wrong / inconsistent comment, actual binding is 51820).

2. **CLI default `--p2p-port` is 51820** —
   `crates/cli/src/main.rs:62` → `#[arg(long, default_value = "51820")] p2p_port: u16`.

3. **`db.rs` says the relay should report `Some(51820)`** —
   `crates/relay/src/db.rs:1647` → `p2p_port: if supports_p2p { Some(51820) } else { None }`.

But the **deployed relay** is handing back `p2p_port=443`. The CLI obediently dials it:

```rust
// crates/cli/src/main.rs:384
if let (Some(ip), true) = (&conn_info.reported_ip, conn_info.supports_p2p) {
    Some((ip.clone(), conn_info.p2p_port.unwrap_or(p2p_port)))
}
```

So `conn_info.p2p_port = Some(443)` is overriding the 51820 default.

The 443 value isn't in `db.rs`'s code path, but **the prod relay binary appears older than the source on disk** — there are several other 443 literals scattered through the relay (`crates/relay/src/api.rs:1927 default_port: 443`, plus `crates/protocol/src/lib.rs:2587, 2611, 2632, 2649`) that look like an older convention where P2P was supposed to share the relay's 443. Either the deployed relay was never updated, or one of those `default_port: 443` paths is still feeding `AgentConnectionInfo.p2p_port` in production.

## Impact

- **Latency**: 3 s added to every CLI command. Aggregated over a session it's noticeable.
- **Noise**: every exec/tunnel prints two stderr lines that don't reflect anything actionable.
- **False-negative observability**: nobody using this CLI would deduce from the log that P2P is dialing the wrong port — they'd think their NAT is the problem.

## Suggested fixes

1. **Verify which `p2p_port` source the deployed relay is actually using** — `git log -- crates/relay/src/db.rs` + the actual deployed binary's version. If the binary's older than the source, rebuild/redeploy `conduit-relay`.
2. **Centralise the constant** — define `const P2P_PORT: u16 = 51820;` in `conduit_protocol::lib` and replace every literal 443/51820 across agent + relay + CLI with it.
3. **Have the agent re-register its P2P port on every connect** so the relay's stored `p2p_port` is always agent-truthful, never relay-defaulted.
4. **Demote the "Trying P2P QUIC" + "failed" lines to `tracing::debug`** so they only show up under `-v` / `RUST_LOG=debug`. Today they're `eprintln!` and noisy by default. (Lines 394 and 444 of `crates/cli/src/main.rs`.)
5. **Wrap with `--no-p2p` as the default for `exec`** until the port-mismatch is fixed, or auto-skip P2P when relay reports a port the CLI knows the agent can't be listening on.

## Side notes

- `crates/agent/src/installer.rs:581` opens a macOS firewall hole labelled "P2P QUIC (UDP 443)" but the listener is bound to 51820 — comment is wrong, but more importantly there's no exception for 51820 on macOS, so even if the port were correct, the firewall would block it on macOS agents.
- For most LACC-style deployments (agent behind enterprise SonicWall, no UDP-anything forwarded inbound), P2P will never succeed regardless of port — the relay fallback is the only viable path. Worth a `p2p_mode: AlwaysRelay` option per agent.

## Related files

- `kepptic/products/apps/conduit/crates/cli/src/main.rs` lines 376–446
- `kepptic/products/apps/conduit/crates/relay/src/db.rs` line 1647
- `kepptic/products/apps/conduit/crates/agent/src/connection.rs` line 558
- `kepptic/products/apps/conduit/crates/agent/src/installer.rs` line 581
- `kepptic/products/apps/conduit/crates/protocol/src/lib.rs` lines 2587, 2611, 2632, 2649 (legacy 443 literals)
