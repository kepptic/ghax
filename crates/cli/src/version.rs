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
//!
//! Beyond bundle-bytes provenance, `--full` also shows the three shipped
//! components' *semver* side by side — CLI, running daemon
//! (`ghax-daemon X.Y.Z (<sha> <date>)`), and bridge extension
//! (`ghax-ext vX.Y.Z (<sha> <date>)`) — and warns on stderr when the daemon
//! or extension disagree with the CLI's own version. Those are the two
//! stale-component traps documented in the repo's CLAUDE.md invariant 4: a
//! daemon bundle built before the last `npm run build`, and a bridge
//! extension not reloaded in `edge://extensions` since. `--full --json`
//! exposes both as `daemonVersionMismatch` / `extensionVersionMismatch`.

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

/// Build-time date (UTC, YYYY-MM-DD), injected by build.rs; "unknown" only
/// if build.rs itself didn't run (it doesn't depend on git, so in practice
/// this always resolves).
const BUILD_DATE: &str = match option_env!("GHAX_BUILD_DATE") {
    Some(s) => s,
    None => "unknown",
};

/// `ghax X.Y.Z (<git short sha> <build date>)` — the single source of truth
/// for plain `ghax version`, `ghax --version`/`-V`, and the first line of
/// `--full`. Centralizing this closes the stale-binary trap: previously
/// `ghax --version` printed only `CARGO_PKG_VERSION`, which is identical
/// before and after a rebuild that changed nothing but the commit — you
/// couldn't tell a fresh binary from a week-old one without `--full`.
pub fn banner() -> String {
    format!("ghax {} ({GIT_SHA} {BUILD_DATE})", env!("CARGO_PKG_VERSION"))
}

pub fn cmd_version(parsed: &Parsed, cfg: &Config) -> Result<i32> {
    let cli_version = env!("CARGO_PKG_VERSION");
    let full = matches!(parsed.flags.get("full"), Some(Value::Bool(true)));

    if !full {
        if parsed.json() {
            output::print(
                &json!({ "version": cli_version, "gitSha": GIT_SHA, "buildDate": BUILD_DATE }),
                true,
            );
        } else {
            println!("{}", banner());
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

    // Component-version mismatch checks — the two stale-component traps
    // (see module doc comment): a daemon bundle built before the last
    // `npm run build`, or a bridge extension not reloaded in
    // edge://extensions since. Distinct from `bundleMismatch` above, which
    // is about the daemon's *executable bytes*, not the semver it reports.
    let daemon_version = daemon.as_ref().and_then(|d| d.get("version")).and_then(|v| v.as_str());
    let daemon_version_mismatch = daemon_version.is_some_and(|v| v != cli_version);
    let extension_info = daemon.as_ref().and_then(|d| d.get("extensionInfo"));
    let extension_version = extension_info.and_then(|e| e.get("version")).and_then(|v| v.as_str());
    let extension_version_mismatch = extension_version.is_some_and(|v| v != cli_version);

    if parsed.json() {
        output::print(
            &json!({
                "cli": { "version": cli_version, "gitSha": GIT_SHA, "buildDate": BUILD_DATE },
                "resolvedBundle": {
                    "path": resolved_path,
                    "tier": resolved_tier,
                    "sha256": resolved_sha,
                },
                "daemon": daemon,
                "bundleMismatch": mismatch,
                "daemonVersionMismatch": daemon_version_mismatch,
                "extensionVersionMismatch": extension_version_mismatch,
            }),
            true,
        );
        return Ok(EXIT_OK);
    }

    println!("{}", banner());
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
            if let Some(v) = daemon_version {
                let sha = d.get("gitSha").and_then(|v| v.as_str()).unwrap_or("unknown");
                let date = d.get("buildDate").and_then(|v| v.as_str()).unwrap_or("unknown");
                println!("  version ghax-daemon {v} ({sha} {date})");
            }
            if d.get("bridgeMode").and_then(|v| v.as_bool()) == Some(true) {
                let ext = extension_info;
                let ext_ver = ext.and_then(|e| e.get("version")).and_then(|v| v.as_str());
                let ext_agent = ext
                    .and_then(|e| e.get("agent"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match ext_ver {
                    Some(v) => {
                        let sha = ext.and_then(|e| e.get("gitSha")).and_then(|v| v.as_str());
                        let date = ext.and_then(|e| e.get("buildDate")).and_then(|v| v.as_str());
                        let provenance = match (sha, date) {
                            (Some(s), Some(d)) => format!(" ({s} {d})"),
                            _ => String::new(),
                        };
                        println!("  bridge extension: {ext_agent} v{v}{provenance}");
                    }
                    None => println!("  bridge extension: (not connected)"),
                }
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
    if daemon_version_mismatch {
        if let Some(v) = daemon_version {
            eprintln!();
            eprintln!(
                "WARNING: running daemon is v{v}, CLI is v{cli_version} — run 'ghax detach && ghax attach' (or reinstall) so they match."
            );
        }
    }
    if extension_version_mismatch {
        if let Some(v) = extension_version {
            eprintln!();
            eprintln!(
                "WARNING: bridge extension is v{v}, CLI is v{cli_version} — reload it in edge://extensions (or chrome://extensions)."
            );
        }
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
