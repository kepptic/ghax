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
//!
//! Discovery (`resolve_config_for_use`, plan 11 phase 1): when that state
//! file has no live daemon and GHAX_STATE_FILE is unset, the daemon registry
//! under `~/.ghax/daemons/` decides — exactly one live daemon is used (one
//! stderr line says which), more than one is refused with the list.

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
        return config_for_state_file(PathBuf::from(state_file));
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

/// A daemon's discovery entry, `~/.ghax/daemons/<pid>.json`. Written by the
/// daemon once it's listening (src/config.ts `registerDaemon`), removed on its
/// exit. A SIGKILLed daemon leaves its entry behind, so every reader prunes
/// entries whose pid is dead.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub pid: i32,
    pub port: u16,
    pub state_file: PathBuf,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub browser_kind: String,
    #[serde(default)]
    pub bridge_port: Option<u16>,
    #[serde(default)]
    pub started_at: String,
    /// `ghax attach --name` / GHAX_AGENT; absent from older daemons.
    #[serde(default)]
    pub name: Option<String>,
}

impl RegistryEntry {
    /// `cwd /x · edge · pid 123 · :54321 · bridge :9223` — the identity every
    /// discovery message prints.
    pub fn describe(&self) -> String {
        let bridge = self
            .bridge_port
            .map(|p| format!(" · bridge :{p}"))
            .unwrap_or_default();
        let kind = if self.browser_kind.is_empty() {
            "?"
        } else {
            &self.browser_kind
        };
        let name = self
            .name
            .as_deref()
            .filter(|n| !n.is_empty())
            .map(|n| format!("{n} · "))
            .unwrap_or_default();
        format!(
            "{name}cwd {} · {kind} · pid {} · :{}{bridge}",
            self.cwd, self.pid, self.port
        )
    }
}

/// `GHAX_DAEMON_REGISTRY` (tests) or `$HOME/.ghax/daemons`.
pub fn registry_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("GHAX_DAEMON_REGISTRY") {
        return Some(PathBuf::from(dir));
    }
    home_dir().map(|h| h.join(".ghax").join("daemons"))
}

/// Every registered daemon whose pid is alive, sorted by pid. Dead entries
/// are deleted on the way past. Entries that can't be read or parsed are
/// returned separately in `unreadable` when their pid (from the filename) is
/// alive: that may be a live daemon's entry in an unknown shape, so callers
/// must not conclude "exactly one daemon" while any exist. Unreadable entries
/// with a dead or unparsable-name pid are pruned (temp files are not `.json`).
pub struct RegistryScan {
    pub live: Vec<RegistryEntry>,
    pub unreadable: Vec<PathBuf>,
}

pub fn scan_registry(dir: &Path) -> RegistryScan {
    let mut scan = RegistryScan { live: Vec::new(), unreadable: Vec::new() };
    let Ok(read) = std::fs::read_dir(dir) else {
        return scan;
    };
    for item in read.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let parsed = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<RegistryEntry>(&raw).ok());
        match parsed {
            Some(entry) => {
                if is_process_alive(entry.pid) {
                    scan.live.push(entry);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
            }
            None => {
                let pid = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| s.parse::<i32>().ok());
                match pid {
                    Some(pid) if is_process_alive(pid) => scan.unreadable.push(path),
                    _ => {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
    scan.live.sort_by_key(|e| e.pid);
    scan.unreadable.sort();
    scan
}

/// Live, readable entries only (see `scan_registry` for the rest).
pub fn live_registered_daemons(dir: &Path) -> Vec<RegistryEntry> {
    scan_registry(dir).live
}

/// What a daemon-using verb should talk to.
#[derive(Debug, PartialEq)]
pub enum Discovery {
    /// The cwd's own state file has a live daemon (or GHAX_STATE_FILE is set).
    Own,
    /// No daemon here, nothing registered — today's "run ghax attach".
    NoneLive,
    /// No daemon here, exactly one live elsewhere: use it.
    Adopt(RegistryEntry),
    /// No daemon here, several elsewhere: refuse and list (never take [0]).
    Ambiguous(Vec<RegistryEntry>),
    /// A registry entry for a live pid can't be read: its daemon's shape is
    /// unknown, so adopting (or declaring "none") would be a guess.
    Unreadable(Vec<PathBuf>),
}

/// Pure core of discovery, separated so tests can point it at a temp
/// registry. `explicit` = GHAX_STATE_FILE or GHAX_GLOBAL=1 is set, which
/// always wins (the user chose the state file; no discovery).
pub fn discover(cfg: &Config, registry: Option<&Path>, explicit: bool) -> Discovery {
    if explicit {
        return Discovery::Own;
    }
    if read_state(cfg).is_some_and(|s| is_process_alive(s.pid)) {
        return Discovery::Own;
    }
    let (mut live, unreadable) = match registry.map(scan_registry) {
        Some(scan) => (scan.live, scan.unreadable),
        None => (Vec::new(), Vec::new()),
    };
    if !unreadable.is_empty() {
        return Discovery::Unreadable(unreadable);
    }
    match live.len() {
        0 => Discovery::NoneLive,
        1 => Discovery::Adopt(live.remove(0)),
        _ => Discovery::Ambiguous(live),
    }
}

/// The message for `Discovery::Ambiguous`, with the exact env var to set.
pub fn ambiguous_message(cfg: &Config, live: &[RegistryEntry]) -> String {
    let mut msg = format!(
        "no daemon state at {} and {} ghax daemons are running elsewhere. Pick one:",
        cfg.state_file.display(),
        live.len()
    );
    for e in live {
        msg.push_str(&format!(
            "\n  GHAX_STATE_FILE={}   ({})",
            e.state_file.display(),
            e.describe()
        ));
    }
    msg
}

/// The message for `Discovery::Unreadable`.
pub fn unreadable_message(files: &[PathBuf]) -> String {
    let mut msg = String::from(
        "a ghax daemon registry entry for a running process can't be read, so ghax won't guess which daemon to use:",
    );
    for f in files {
        msg.push_str(&format!("\n  {}", f.display()));
    }
    msg.push_str("\n  Set GHAX_STATE_FILE to the daemon you want, or delete the file if its daemon is gone.");
    msg
}

fn config_for_state_file(state_file: PathBuf) -> Config {
    let state_dir = state_file
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let project_dir = state_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| state_dir.clone());
    Config {
        project_dir,
        state_dir,
        state_file,
    }
}

/// `resolve_config` plus daemon discovery, for every verb that talks to an
/// existing daemon. `attach`/`detach`/`restart` must keep using plain
/// `resolve_config`: attach never adopts another directory's daemon.
pub fn resolve_config_for_use() -> Result<Config> {
    let (cfg, borrowed) = resolve_config_with_origin()?;
    if let Some(entry) = &borrowed {
        note_adoption(entry);
    }
    Ok(cfg)
}

/// `resolve_config_for_use` without the stderr note, plus the registry entry
/// when the daemon is BORROWED from another directory (discovery fallback),
/// so the caller can restrict what a borrowed daemon may be asked to do.
pub fn resolve_config_with_origin() -> Result<(Config, Option<RegistryEntry>)> {
    let cfg = resolve_config();
    let explicit = std::env::var_os("GHAX_STATE_FILE").is_some()
        || std::env::var("GHAX_GLOBAL").as_deref() == Ok("1");
    match discover(&cfg, registry_dir().as_deref(), explicit) {
        Discovery::Own | Discovery::NoneLive => Ok((cfg, None)),
        Discovery::Adopt(entry) => Ok((config_for_state_file(entry.state_file.clone()), Some(entry))),
        Discovery::Ambiguous(live) => Err(anyhow!(ambiguous_message(&cfg, &live))),
        Discovery::Unreadable(files) => Err(anyhow!(unreadable_message(&files))),
    }
}

/// The refusal for a verb that may not run on a borrowed daemon.
pub fn borrowed_refusal(verb: &str, entry: &RegistryEntry) -> String {
    format!(
        "{verb}: refused. There is no daemon for this directory; the only one running belongs to another session ({}). \
A borrowed daemon is read-only: status, tabs, version, bridge instances, console, network (no --har or --source-maps). \
Run 'ghax attach' here for your own daemon, or set GHAX_STATE_FILE={} to drive that one on purpose.",
        entry.describe(),
        entry.state_file.display()
    )
}

/// One stderr line per adopted daemon per process — `ghax shell` and the
/// multi-RPC verbs resolve more than once.
pub fn note_adoption(entry: &RegistryEntry) {
    static NOTED: std::sync::Mutex<Option<i32>> = std::sync::Mutex::new(None);
    let mut noted = NOTED.lock().unwrap_or_else(|p| p.into_inner());
    if *noted == Some(entry.pid) {
        return;
    }
    *noted = Some(entry.pid);
    eprintln!(
        "ghax: no daemon here, using the one attached from {} ({}, pid {}). Set GHAX_STATE_FILE={} to pin it.",
        entry.cwd,
        if entry.browser_kind.is_empty() { "?" } else { &entry.browser_kind },
        entry.pid,
        entry.state_file.display()
    );
}

pub(crate) fn home_dir() -> Option<PathBuf> {
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
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, sig: i32) -> i32 {
    // SAFETY: plain POSIX kill(2); the caller picks pid and signal.
    unsafe { kill(pid, sig) }
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
        // When state is missing but a ghax daemon is already alive on the
        // scan-range ports, tell the operator — `ghax attach` will pair
        // with it instead of launching a new one, which is almost
        // certainly what they want.
        let hint = probe_live_daemon_ports()
            .map(|p| format!(" (a ghax daemon is live on :{p} — `ghax attach` will pair with it)"))
            .unwrap_or_default();
        anyhow!(
            "no daemon state at {} — run `ghax attach` first{hint}",
            cfg.state_file.display()
        )
    })?;
    // /health is the authoritative liveness signal — but we also verify the
    // pid in the response matches state.pid. Otherwise a stale state file
    // pointing at a port now reused by a different ghax daemon (different
    // project, colliding port) would silently route RPCs to the wrong
    // browser session.
    match health_check(state.port, state.pid) {
        Ok(()) => return Ok(state.port),
        Err(e) if e.to_string().contains("stale state") => {
            // Explicit stale-state path: different daemon answered on our
            // port. Tell the user the exact fix.
            return Err(anyhow!(
                "{e} — run `ghax detach && ghax attach` to re-pair with the running browser"
            ));
        }
        Err(_) => {}
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

/// Scan 9222..=9230 for a live ghax daemon `/health` — used only to enrich
/// the "no daemon state" error with an auto-reattach hint. Returns the
/// first responsive port, or None.
fn probe_live_daemon_ports() -> Option<u16> {
    for port in 9222..=9230 {
        let url = format!("http://127.0.0.1:{port}/health");
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(200))
            .build()
            .ok()?;
        if let Ok(resp) = client.get(&url).send() {
            if resp.status().is_success() {
                if let Ok(body) = resp.json::<serde_json::Value>() {
                    if body.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                        return Some(port);
                    }
                }
            }
        }
    }
    None
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

// Unix-only: liveness is a real kill(pid, 0) there; the non-unix shim treats
// every pid as alive, so the prune cases can't hold.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ghax-discovery-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A pid that existed and has exited — reaped, so kill(pid, 0) fails.
    fn dead_pid() -> i32 {
        let mut child = Command::new("true").spawn().unwrap();
        let pid = child.id() as i32;
        child.wait().unwrap();
        pid
    }

    fn write_entry(dir: &Path, pid: i32, cwd: &str) -> PathBuf {
        let file = dir.join(format!("{pid}.json"));
        let body = serde_json::json!({
            "pid": pid, "port": 50000, "stateFile": format!("{cwd}/.ghax/ghax.json"),
            "cwd": cwd, "browserKind": "edge", "bridgePort": 9223,
            "startedAt": "2026-10-13T00:00:00.000Z",
        });
        std::fs::write(&file, body.to_string()).unwrap();
        file
    }

    fn empty_cfg(root: &Path) -> Config {
        config_for_state_file(root.join(".ghax").join("ghax.json"))
    }

    #[test]
    fn no_registered_daemon_is_none_live() {
        let root = temp_dir("none");
        let reg = root.join("daemons");
        assert_eq!(
            discover(&empty_cfg(&root), Some(&reg), false),
            Discovery::NoneLive
        );
        assert_eq!(
            discover(&empty_cfg(&root), None, false),
            Discovery::NoneLive
        );
    }

    #[test]
    fn exactly_one_live_daemon_is_adopted() {
        let root = temp_dir("one");
        let reg = root.join("daemons");
        std::fs::create_dir_all(&reg).unwrap();
        let me = std::process::id() as i32;
        write_entry(&reg, me, "/work/a");
        match discover(&empty_cfg(&root), Some(&reg), false) {
            Discovery::Adopt(e) => {
                assert_eq!(e.pid, me);
                assert_eq!(e.state_file, PathBuf::from("/work/a/.ghax/ghax.json"));
                assert_eq!(e.bridge_port, Some(9223));
            }
            other => panic!("expected Adopt, got {other:?}"),
        }
    }

    #[test]
    fn several_live_daemons_are_ambiguous_and_listed() {
        let root = temp_dir("many");
        let reg = root.join("daemons");
        std::fs::create_dir_all(&reg).unwrap();
        // Two distinct live pids: this test process and its parent (cargo's
        // test harness or the shell) — both alive for the test's duration.
        let me = std::process::id() as i32;
        let parent = std::os::unix::process::parent_id() as i32;
        write_entry(&reg, me, "/work/a");
        write_entry(&reg, parent, "/work/b");
        let cfg = empty_cfg(&root);
        match discover(&cfg, Some(&reg), false) {
            Discovery::Ambiguous(live) => {
                assert_eq!(live.len(), 2);
                let msg = ambiguous_message(&cfg, &live);
                assert!(msg.contains("2 ghax daemons"), "{msg}");
                assert!(
                    msg.contains("GHAX_STATE_FILE=/work/a/.ghax/ghax.json"),
                    "{msg}"
                );
                assert!(
                    msg.contains("GHAX_STATE_FILE=/work/b/.ghax/ghax.json"),
                    "{msg}"
                );
                assert!(msg.contains("cwd /work/b · edge"), "{msg}");
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn unreadable_entry_with_live_pid_refuses_adoption() {
        let root = temp_dir("unreadable-live");
        let reg = root.join("daemons");
        std::fs::create_dir_all(&reg).unwrap();
        let me = std::process::id() as i32;
        write_entry(&reg, me, "/work/a");
        let parent = std::os::unix::process::parent_id() as i32;
        let bad = reg.join(format!("{parent}.json"));
        std::fs::write(&bad, "{\"pid\": 12").unwrap();
        match discover(&empty_cfg(&root), Some(&reg), false) {
            Discovery::Unreadable(files) => {
                assert_eq!(files, vec![bad.clone()]);
                let msg = unreadable_message(&files);
                assert!(msg.contains(&bad.display().to_string()), "{msg}");
            }
            other => panic!("expected Unreadable, got {other:?}"),
        }
        assert!(bad.exists(), "a live pid's file must not be deleted");
    }

    #[test]
    fn unreadable_entry_with_dead_pid_is_pruned() {
        let root = temp_dir("unreadable-dead");
        let reg = root.join("daemons");
        std::fs::create_dir_all(&reg).unwrap();
        let me = std::process::id() as i32;
        write_entry(&reg, me, "/work/a");
        let bad = reg.join(format!("{}.json", dead_pid()));
        std::fs::write(&bad, "not json").unwrap();
        match discover(&empty_cfg(&root), Some(&reg), false) {
            Discovery::Adopt(e) => assert_eq!(e.pid, me),
            other => panic!("expected Adopt, got {other:?}"),
        }
        assert!(!bad.exists(), "dead unreadable entry should be pruned");
    }

    #[test]
    fn temp_files_in_registry_are_ignored() {
        let root = temp_dir("tmpfile");
        let reg = root.join("daemons");
        std::fs::create_dir_all(&reg).unwrap();
        std::fs::write(reg.join(".123.json.tmp"), "{").unwrap();
        assert_eq!(
            discover(&empty_cfg(&root), Some(&reg), false),
            Discovery::NoneLive
        );
    }

    #[test]
    fn ghax_global_disables_discovery() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let root = temp_dir("global");
        let reg = root.join("daemons");
        std::fs::create_dir_all(&reg).unwrap();
        write_entry(&reg, std::process::id() as i32, "/work/a");
        let prev_reg = std::env::var_os("GHAX_DAEMON_REGISTRY");
        let prev_state = std::env::var_os("GHAX_STATE_FILE");
        // SAFETY: every test that touches the environment holds ENV_LOCK.
        unsafe {
            std::env::set_var("GHAX_DAEMON_REGISTRY", &reg);
            std::env::remove_var("GHAX_STATE_FILE");
            std::env::set_var("GHAX_GLOBAL", "1");
        }
        let cfg = resolve_config_for_use().unwrap();
        // SAFETY: as above.
        unsafe {
            std::env::remove_var("GHAX_GLOBAL");
            match prev_reg {
                Some(v) => std::env::set_var("GHAX_DAEMON_REGISTRY", v),
                None => std::env::remove_var("GHAX_DAEMON_REGISTRY"),
            }
            if let Some(v) = prev_state {
                std::env::set_var("GHAX_STATE_FILE", v);
            }
        }
        assert!(
            cfg.state_file.ends_with(".ghax/ghax.json")
                && !cfg.state_file.starts_with("/work/a"),
            "GHAX_GLOBAL must not adopt the registered daemon: {}",
            cfg.state_file.display()
        );
    }

    #[test]
    fn dead_pid_entries_are_pruned() {
        let root = temp_dir("dead");
        let reg = root.join("daemons");
        std::fs::create_dir_all(&reg).unwrap();
        let dead = dead_pid();
        let dead_file = write_entry(&reg, dead, "/work/dead");
        let me = std::process::id() as i32;
        write_entry(&reg, me, "/work/live");
        // One dead + one live → the live one is adopted, not "ambiguous".
        match discover(&empty_cfg(&root), Some(&reg), false) {
            Discovery::Adopt(e) => assert_eq!(e.pid, me),
            other => panic!("expected Adopt, got {other:?}"),
        }
        assert!(!dead_file.exists(), "dead entry should be deleted");
        // Only dead entries → nothing live.
        let root2 = temp_dir("dead-only");
        let reg2 = root2.join("daemons");
        std::fs::create_dir_all(&reg2).unwrap();
        write_entry(&reg2, dead_pid(), "/work/dead");
        assert_eq!(
            discover(&empty_cfg(&root2), Some(&reg2), false),
            Discovery::NoneLive
        );
    }

    #[test]
    fn own_live_daemon_or_explicit_state_file_wins() {
        let root = temp_dir("own");
        let reg = root.join("daemons");
        std::fs::create_dir_all(&reg).unwrap();
        let me = std::process::id() as i32;
        write_entry(&reg, me, "/work/elsewhere");
        let cfg = empty_cfg(&root);
        std::fs::create_dir_all(&cfg.state_dir).unwrap();
        std::fs::write(&cfg.state_file, format!(r#"{{"pid":{me},"port":50001}}"#)).unwrap();
        assert_eq!(discover(&cfg, Some(&reg), false), Discovery::Own);
        // A dead own daemon falls through to the registry.
        std::fs::write(
            &cfg.state_file,
            format!(r#"{{"pid":{},"port":50001}}"#, dead_pid()),
        )
        .unwrap();
        assert!(matches!(
            discover(&cfg, Some(&reg), false),
            Discovery::Adopt(_)
        ));
        // GHAX_STATE_FILE set → never adopt.
        assert_eq!(discover(&cfg, Some(&reg), true), Discovery::Own);
    }
}
