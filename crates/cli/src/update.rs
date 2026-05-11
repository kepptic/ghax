//! Self-update: `ghax update` plus an attach-time banner that nudges users
//! when a newer GitHub release is published.
//!
//! Design choices:
//!   - The actual install reuses `scripts/install-release.sh`. We don't
//!     reimplement archive download + SHA-256 verification in Rust — that
//!     would be a second source of truth. If a local checkout exists,
//!     we use its script; otherwise we fetch from `main` and pipe to bash.
//!   - Version check is cached at `<share>/version-check.json` for 24h.
//!     `ghax attach` reads the cache synchronously (zero added latency)
//!     and prints a one-line banner if the cached tag is newer. If the
//!     cache is stale, it fork-detaches `ghax update --background-refresh`
//!     to repopulate it — the *next* attach picks it up.
//!   - No silent auto-install. A CLI swapping itself out mid-session
//!     breaks long-running workflows. Banner + manual command is safer.
//!   - Respects `GHAX_NO_UPDATE_CHECK=1` and skips the banner when stderr
//!     isn't a TTY (CI / piped output).

use crate::args::Parsed;
use crate::dispatch::{EXIT_CDP_ERROR, EXIT_OK};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const REPO_SLUG: &str = "kepptic/ghax";
const GITHUB_API_LATEST: &str = "https://api.github.com/repos/kepptic/ghax/releases/latest";
const INSTALL_SCRIPT_URL: &str =
    "https://raw.githubusercontent.com/kepptic/ghax/main/scripts/install-release.sh";
const CACHE_TTL_SECS: u64 = 24 * 3600;
const USER_AGENT: &str = concat!("ghax/", env!("CARGO_PKG_VERSION"));

#[derive(Serialize, Deserialize, Default)]
struct VersionCache {
    /// Unix epoch seconds of last successful check.
    checked_at: u64,
    /// Latest stable tag (e.g. "v0.4.3"). Empty if no release was found.
    latest: String,
}

fn cache_path() -> Option<PathBuf> {
    crate::attach::stable_share_dir().map(|d| d.join("version-check.json"))
}

fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn strip_v(v: &str) -> &str {
    v.strip_prefix('v').unwrap_or(v)
}

/// Parse "X.Y.Z" (ignoring any pre-release suffix) into a tuple. Returns
/// `None` for unparseable inputs — caller treats that as "don't nudge."
fn parse_semver(v: &str) -> Option<(u32, u32, u32)> {
    let core = strip_v(v).split('-').next().unwrap_or("");
    let mut it = core.split('.');
    let a: u32 = it.next()?.parse().ok()?;
    let b: u32 = it.next()?.parse().ok()?;
    let c: u32 = it.next()?.parse().ok()?;
    Some((a, b, c))
}

/// `latest` is strictly newer than `current` for our purposes.
fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_semver(latest), parse_semver(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API used by attach.rs
// ─────────────────────────────────────────────────────────────────────────────

/// Called at the start of `ghax attach`. Reads the cached latest version and
/// prints a one-line banner to stderr if it's newer than the running binary.
/// If the cache is missing or stale, kicks off a background refresh so the
/// *next* attach has fresh data. Never blocks the foreground.
pub fn maybe_show_banner() {
    if std::env::var("GHAX_NO_UPDATE_CHECK").ok().as_deref() == Some("1") {
        return;
    }
    if !atty::is(atty::Stream::Stderr) {
        return;
    }
    let needs_refresh = match read_cache() {
        Ok(Some(cache)) => {
            if !cache.latest.is_empty() && is_newer(&cache.latest, current_version()) {
                eprintln!(
                    "ghax: update available — {} → {}. Run `ghax update` to install. \
                     Set GHAX_NO_UPDATE_CHECK=1 to silence.",
                    current_version(),
                    cache.latest,
                );
            }
            epoch_secs().saturating_sub(cache.checked_at) > CACHE_TTL_SECS
        }
        _ => true,
    };
    if needs_refresh {
        spawn_background_refresh();
    }
}

fn read_cache() -> Result<Option<VersionCache>> {
    let Some(path) = cache_path() else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    let cache: VersionCache = serde_json::from_str(&raw)?;
    Ok(Some(cache))
}

fn write_cache(cache: &VersionCache) -> Result<()> {
    let Some(path) = cache_path() else {
        return Err(anyhow!("no HOME / XDG_DATA_HOME to write cache"));
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let body = serde_json::to_string_pretty(cache)?;
    fs::write(&path, body)?;
    Ok(())
}

fn spawn_background_refresh() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let _ = Command::new(exe)
        .arg("update")
        .arg("--background-refresh")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

// ─────────────────────────────────────────────────────────────────────────────
// `ghax update` dispatch
// ─────────────────────────────────────────────────────────────────────────────

pub fn cmd_update(parsed: &Parsed) -> Result<i32> {
    let background = matches!(parsed.flags.get("background-refresh"), Some(Value::Bool(true)));
    let check_only = matches!(parsed.flags.get("check"), Some(Value::Bool(true)));
    let to_version: Option<String> = parsed
        .flags
        .get("to")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if background {
        if let Ok(tag) = fetch_latest_tag() {
            let _ = write_cache(&VersionCache {
                checked_at: epoch_secs(),
                latest: tag,
            });
        }
        return Ok(EXIT_OK);
    }

    let latest = match fetch_latest_tag() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("ghax update: could not query GitHub for latest release: {e}");
            return Ok(EXIT_CDP_ERROR);
        }
    };
    let _ = write_cache(&VersionCache {
        checked_at: epoch_secs(),
        latest: latest.clone(),
    });

    let target = to_version.as_deref().unwrap_or(&latest);

    if check_only {
        if is_newer(target, current_version()) {
            println!("ghax {} → {} available", current_version(), target);
            println!("Run `ghax update` to install.");
        } else {
            println!("ghax {} is up to date (latest: {})", current_version(), latest);
        }
        return Ok(EXIT_OK);
    }

    if !is_newer(target, current_version()) && to_version.is_none() {
        println!("ghax {} is already up to date.", current_version());
        return Ok(EXIT_OK);
    }

    println!("ghax: installing {} (current: {})...", target, current_version());
    let status = run_install_release(target)?;
    if status == EXIT_OK {
        println!(
            "\nghax: update installed. If a daemon is running, run `ghax restart` to load the new bundle."
        );
    }
    Ok(status)
}

/// Locate and execute scripts/install-release.sh. Prefers a local checkout
/// (faster, no network for the script itself); falls back to fetching the
/// script from GitHub raw.
fn run_install_release(version: &str) -> Result<i32> {
    if let Some(local) = find_local_install_script() {
        let status = Command::new("bash").arg(&local).arg(version).status()?;
        return Ok(status.code().unwrap_or(EXIT_CDP_ERROR));
    }

    // No local checkout — fetch the script and pipe through bash. The
    // script itself does SHA-256 verification of the actual artifact, so
    // we're trusting GitHub's TLS for the script bytes (standard self-update
    // model).
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()?;
    let body = client
        .get(INSTALL_SCRIPT_URL)
        .send()?
        .error_for_status()?
        .text()?;
    let mut child = Command::new("bash")
        .arg("-s")
        .arg("--")
        .arg(version)
        .stdin(Stdio::piped())
        .spawn()?;
    {
        use std::io::Write;
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("bash stdin missing"))?;
        stdin.write_all(body.as_bytes())?;
    }
    let status = child.wait()?;
    Ok(status.code().unwrap_or(EXIT_CDP_ERROR))
}

fn find_local_install_script() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let mut dir = cwd.as_path();
    loop {
        let candidate = dir.join("scripts").join("install-release.sh");
        if candidate.exists() {
            // Only trust scripts inside a ghax checkout — gated on either
            // the Rust workspace's package name or the JS package name.
            let cargo = dir.join("Cargo.toml");
            if let Ok(raw) = fs::read_to_string(&cargo) {
                if raw.contains("name = \"ghax\"") {
                    return Some(candidate);
                }
            }
            let pkg = dir.join("package.json");
            if let Ok(raw) = fs::read_to_string(&pkg) {
                if raw.contains("\"@ghax/cli\"") {
                    return Some(candidate);
                }
            }
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_parsing_handles_v_prefix_and_prerelease() {
        assert_eq!(parse_semver("0.4.2"), Some((0, 4, 2)));
        assert_eq!(parse_semver("v0.4.2"), Some((0, 4, 2)));
        assert_eq!(parse_semver("v1.0.0-rc1"), Some((1, 0, 0)));
        assert_eq!(parse_semver("not-a-version"), None);
    }

    #[test]
    fn is_newer_rejects_equal_and_older() {
        assert!(is_newer("v0.4.3", "0.4.2"));
        assert!(is_newer("v1.0.0", "0.99.99"));
        assert!(!is_newer("v0.4.2", "0.4.2"));
        assert!(!is_newer("v0.4.1", "0.4.2"));
        assert!(!is_newer("garbage", "0.4.2"));
    }
}

fn fetch_latest_tag() -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(USER_AGENT)
        .build()?;
    let resp = client
        .get(GITHUB_API_LATEST)
        .header("Accept", "application/vnd.github+json")
        .send()?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "GitHub API {} returned {}",
            REPO_SLUG,
            resp.status(),
        ));
    }
    let body: Value = resp.json()?;
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("tag_name missing in GitHub response"))?;
    Ok(tag.to_string())
}
