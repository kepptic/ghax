//! State-file discovery and daemon liveness checks.
//!
//! Mirrors `src/config.ts`. Resolution order matches the TS implementation
//! exactly so a daemon spawned by either CLI is discovered by both during the
//! dual-maintenance window.
//!
//! Resolution:
//!   1. `GHAX_STATE_FILE` env → derive `state_dir` from parent
//!   2. `GHAX_GLOBAL=1` → `$HOME/.ghax/ghax.json`
//!   3. `git rev-parse --show-toplevel` → `<root>/.ghax/ghax.json`
//!   4. cwd fallback (non-git environments)

use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

// Phase 2 (attach) reads project_dir + state_dir to build the gitignore append
// path. browser_url/browser_kind/attached_at/cwd are surfaced by `ghax status`.
// Allow dead_code now so the build stays warning-free until those land.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Config {
    pub project_dir: PathBuf,
    pub state_dir: PathBuf,
    pub state_file: PathBuf,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonState {
    pub pid: i32,
    pub port: u16,
    #[serde(default)]
    pub browser_url: String,
    #[serde(default)]
    pub browser_kind: String,
    #[serde(default)]
    pub attached_at: String,
    #[serde(default)]
    pub cwd: String,
}

pub fn resolve_config() -> Config {
    if let Ok(state_file) = std::env::var("GHAX_STATE_FILE") {
        let state_file = PathBuf::from(state_file);
        let state_dir = state_file
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let project_dir = state_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| state_dir.clone());
        return Config { project_dir, state_dir, state_file };
    }

    if std::env::var("GHAX_GLOBAL").as_deref() == Ok("1") {
        let project_dir = home_dir().unwrap_or_else(|| PathBuf::from("."));
        let state_dir = project_dir.join(".ghax");
        let state_file = state_dir.join("ghax.json");
        return Config { project_dir, state_dir, state_file };
    }

    let project_dir = git_root().unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    });
    let state_dir = project_dir.join(".ghax");
    let state_file = state_dir.join("ghax.json");
    Config { project_dir, state_dir, state_file }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn git_root() -> Option<PathBuf> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

pub fn read_state(cfg: &Config) -> Option<DaemonState> {
    let raw = std::fs::read_to_string(&cfg.state_file).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Best-effort liveness check matching `process.kill(pid, 0)`.
pub fn is_process_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: kill(pid, 0) is a well-defined POSIX no-op signal probe.
    unsafe { libc_kill(pid, 0) == 0 }
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, sig: i32) -> i32 {
    kill(pid, sig)
}

#[cfg(not(unix))]
unsafe fn libc_kill(_pid: i32, _sig: i32) -> i32 {
    // On Windows the daemon spawn path lives in Phase 2; for now treat any
    // recorded PID as alive and let the HTTP /health probe arbitrate.
    0
}

/// Resolve daemon port + verify /health responds, otherwise error with the
/// standard "attach first" message that mirrors cli.ts.
pub fn require_daemon(cfg: &Config) -> Result<u16> {
    let state = read_state(cfg).ok_or_else(|| {
        anyhow!(
            "no daemon state at {} — run `ghax attach` first",
            cfg.state_file.display()
        )
    })?;
    // /health is the authoritative liveness signal — but we also verify the
    // pid in the response matches state.pid. Otherwise a stale state file
    // pointing at a port now reused by a different ghax daemon (different
    // project, colliding port) would silently route RPCs to the wrong
    // browser session.
    if health_check(state.port, state.pid).is_ok() {
        return Ok(state.port);
    }
    if !is_process_alive(state.pid) {
        return Err(anyhow!(
            "daemon (pid {}) is not running — run `ghax attach`",
            state.pid
        ));
    }
    Err(anyhow!(
        "daemon at :{} not responding to /health — run `ghax attach`",
        state.port
    ))
}

fn health_check(port: u16, expected_pid: i32) -> Result<()> {
    let url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()?;
    let resp = client.get(&url).send()?;
    if !resp.status().is_success() {
        return Err(anyhow!("health endpoint returned {}", resp.status()));
    }
    let body: serde_json::Value = resp.json()?;
    // Defense against port collision: the daemon on this port MUST be the
    // one recorded in our state file. If the pid disagrees, treat this
    // health response as unrelated.
    if let Some(pid) = body.get("pid").and_then(|v| v.as_i64()) {
        if pid != expected_pid as i64 {
            return Err(anyhow!(
                "port {} answered /health but with pid {} (expected {}) — stale state?",
                port,
                pid,
                expected_pid
            ));
        }
    }
    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(anyhow!("daemon reported unhealthy"));
    }
    Ok(())
}
