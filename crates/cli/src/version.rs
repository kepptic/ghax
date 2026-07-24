//! `ghax version [--full]` — identity and provenance.
//!
//! Plain `ghax version` (and `ghax --version` / `-V`) prints the CLI version,
//! same as before. `ghax version --full` answers the question the stale-binary
//! trap turns into a two-hour debugging session: *which binary, which daemon
//! bundle, and which extension am I actually running?* It reports the CLI
//! version + git sha, the daemon bundle that resolves NOW (path, tier, sha256
//! — WITHOUT triggering the self-heal download), and, if a daemon is live, the
//! bundle sha256 that the RUNNING daemon is executing plus the connected bridge
//! extension. A mismatch between the resolved and running bundle is flagged
//! loudly — that mismatch is exactly what a `cargo clean` or a stale symlink
//! produces. See docs/design/plan/08-bridge-reliability.md §6.

use anyhow::Result;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::args::Parsed;
use crate::attach;
use crate::dispatch::EXIT_OK;
use crate::output;
use crate::state::{self, Config};

/// Build-time git sha, injected by build.rs; "unknown" when git wasn't
/// available at build time (e.g. a source tarball).
const GIT_SHA: &str = match option_env!("GHAX_GIT_SHA") {
    Some(s) => s,
    None => "unknown",
};

pub fn cmd_version(parsed: &Parsed, cfg: &Config) -> Result<i32> {
    let cli_version = env!("CARGO_PKG_VERSION");
    let full = matches!(parsed.flags.get("full"), Some(Value::Bool(true)));

    if !full {
        if parsed.json() {
            output::print(&json!({ "version": cli_version, "gitSha": GIT_SHA }), true);
        } else {
            println!("ghax {cli_version}");
        }
        return Ok(EXIT_OK);
    }

    // Resolve the bundle WITHOUT self-heal (no network side effect from a
    // diagnostic command). Tier + sha tell you whether you're on a repo build,
    // an installed copy, or an env override.
    let (resolved_path, resolved_tier, resolved_sha) = match attach::locate_daemon_bundle() {
        Ok(Some((p, tier))) => {
            let sha = sha256_file(&p).unwrap_or_default();
            (Some(p.display().to_string()), tier, sha)
        }
        Ok(None) => (None, "unresolved", String::new()),
        Err(e) => (Some(format!("<error: {e}>")), "error", String::new()),
    };

    // Ask the running daemon (if any) what IT is executing. A live daemon on a
    // different bundle than what resolves now is the stale-binary smoking gun.
    let daemon = query_daemon(cfg);

    let mismatch = match &daemon {
        Some(d) => {
            let running = d.get("bundleSha256").and_then(|v| v.as_str()).unwrap_or("");
            !resolved_sha.is_empty() && !running.is_empty() && running != resolved_sha
        }
        None => false,
    };

    if parsed.json() {
        output::print(
            &json!({
                "cli": { "version": cli_version, "gitSha": GIT_SHA },
                "resolvedBundle": {
                    "path": resolved_path,
                    "tier": resolved_tier,
                    "sha256": resolved_sha,
                },
                "daemon": daemon,
                "bundleMismatch": mismatch,
            }),
            true,
        );
        return Ok(EXIT_OK);
    }

    println!("ghax {cli_version}  (git {GIT_SHA})");
    println!();
    println!("daemon bundle (resolves now):");
    println!("  path   {}", resolved_path.as_deref().unwrap_or("<none found>"));
    println!("  tier   {resolved_tier}");
    println!("  sha256 {}", short_sha(&resolved_sha));
    println!();
    match &daemon {
        None => println!("running daemon: none (no live daemon for this state file)"),
        Some(d) => {
            let running_sha = d.get("bundleSha256").and_then(|v| v.as_str()).unwrap_or("");
            let running_path = d.get("bundlePath").and_then(|v| v.as_str()).unwrap_or("");
            println!("running daemon:");
            println!("  path   {running_path}");
            println!("  sha256 {}", short_sha(running_sha));
            if d.get("bridgeMode").and_then(|v| v.as_bool()) == Some(true) {
                let ext = d.get("extensionInfo");
                let ext_ver = ext
                    .and_then(|e| e.get("version"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("(not connected)");
                let ext_agent = ext
                    .and_then(|e| e.get("agent"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                println!("  bridge extension: {ext_agent} v{ext_ver}");
            }
        }
    }
    if mismatch {
        eprintln!();
        eprintln!(
            "WARNING: the running daemon is executing a DIFFERENT bundle than what resolves now."
        );
        eprintln!(
            "         Run `ghax detach && ghax attach` to restart the daemon on the current bundle."
        );
    }

    Ok(EXIT_OK)
}

fn query_daemon(cfg: &Config) -> Option<Value> {
    let state = state::read_state(cfg)?;
    if !state::is_process_alive(state.pid) {
        return None;
    }
    let url = format!("http://127.0.0.1:{}/version", state.port);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .ok()?;
    let resp = client.get(&url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().ok()?;
    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    Some(body)
}

fn sha256_file(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Some(format!("{:x}", hasher.finalize()))
}

fn short_sha(sha: &str) -> String {
    if sha.is_empty() {
        "<unknown>".to_string()
    } else {
        sha.chars().take(12).collect()
    }
}
