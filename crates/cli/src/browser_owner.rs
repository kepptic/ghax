//! Who is behind a CDP port: its `--user-data-dir` and whether another live
//! ghax daemon already drives it (TASK-021).
//!
//! Incident 2026-11-15: `attach --launch --data-dir X` with no `--port`
//! reused another session's scratch browser on :9222 and drove its sign-ins.
//! `/json/version` does not expose the profile, so we read the listening
//! process's command line (`lsof` + `ps`). Where that fails (Windows, no
//! lsof) the profile is "unknown" and only the daemon-ownership check runs.

use std::net::TcpListener;
use std::path::{Path, PathBuf};

use crate::state::{self, Config, DaemonState, RegistryEntry};

/// True when nothing is bound to 127.0.0.1:`port`. Stricter than "no CDP
/// answer": a bridge daemon on 9223 doesn't speak /json/version but still
/// owns the port.
pub fn port_is_bindable(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// First bindable port in `[start, start+count)`.
pub fn find_unbound_port(start: u16, count: u16) -> Option<u16> {
    (start..start.saturating_add(count)).find(|&p| port_is_bindable(p))
}

/// The `--user-data-dir` of the process listening on `port`.
/// `Some(None)` = found the process, it has no --user-data-dir (default
/// profile). `None` = couldn't tell.
pub fn user_data_dir_for_port(port: u16) -> Option<Option<PathBuf>> {
    let pid = listener_pid(port)?;
    let out = std::process::Command::new("ps")
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_user_data_dir(&String::from_utf8_lossy(&out.stdout)))
}

fn first_pid(args: &[&str]) -> Option<u32> {
    let out = std::process::Command::new("lsof")
        .args(args)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()
}

fn listener_pid(port: u16) -> Option<u32> {
    if cfg!(windows) {
        return None;
    }
    let tcp = format!("-iTCP:{port}");
    first_pid(&["-nP", &tcp, "-sTCP:LISTEN", "-t"])
}

/// Pull `--user-data-dir=<path>` out of a command line. Paths may contain
/// spaces (macOS "Application Support"), so take everything up to the next
/// ` --` flag.
pub fn parse_user_data_dir(cmdline: &str) -> Option<PathBuf> {
    let key = "--user-data-dir=";
    let start = cmdline.find(key)? + key.len();
    let rest = &cmdline[start..];
    // `ps` flattens argv with spaces, so a path with spaces and a following
    // positional URL look alike. Cut at the first space whose next token is
    // a flag or looks like a URL (`scheme:` with no `/` before the colon).
    let mut end = rest.len();
    for (i, _) in rest.match_indices(' ') {
        let next = rest[i + 1..].split(' ').next().unwrap_or("");
        if next.starts_with("--") || looks_like_url(next) {
            end = i;
            break;
        }
    }
    let v = rest[..end].trim().trim_matches('"');
    if v.is_empty() {
        None
    } else {
        Some(PathBuf::from(v))
    }
}

fn looks_like_url(tok: &str) -> bool {
    match tok.find(':') {
        Some(c) if c > 1 => tok[..c]
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '-' || ch == '.'),
        _ => false,
    }
}

/// Pid holding a Chromium profile's `SingletonLock` (a symlink to
/// `<host>-<pid>`), if that pid is alive. A launch into a locked profile is
/// handed to the running browser and our CDP port never opens.
pub fn profile_lock_holder(data_dir: &Path) -> Option<i32> {
    let target = std::fs::read_link(data_dir.join("SingletonLock")).ok()?;
    let pid: i32 = target.to_string_lossy().rsplit('-').next()?.parse().ok()?;
    state::is_process_alive(pid).then_some(pid)
}

/// True when the browser on `port` was started with `data_dir`. Guards
/// against a concurrent launch winning the port between probe and spawn.
pub fn port_serves_profile(port: u16, data_dir: &Path) -> bool {
    match user_data_dir_for_port(port) {
        Some(Some(have)) => normalize(&have) == normalize(data_dir),
        Some(None) => false,
        // Can't read process args here (no lsof): don't block the launch.
        None => true,
    }
}

fn daemon_answers(port: u16) -> bool {
    crate::http::local_client_builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
        .ok()
        .and_then(|c| c.get(format!("http://127.0.0.1:{port}/health")).send().ok())
        .is_some_and(|r| r.status().is_success())
}

/// Expand a leading `~/` and canonicalize when the path exists.
pub fn normalize(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    let expanded = match (s.strip_prefix("~/"), state::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => p.to_path_buf(),
    };
    std::fs::canonicalize(&expanded).unwrap_or(expanded)
}

/// Port from a state file's browser_url (`ws://127.0.0.1:9222/devtools/...`
/// or `http://127.0.0.1:9222`). Bridge URLs return None.
fn cdp_port_of(browser_url: &str) -> Option<u16> {
    let rest = browser_url
        .strip_prefix("ws://")
        .or_else(|| browser_url.strip_prefix("http://"))?;
    let hostport = rest.split('/').next()?;
    hostport.rsplit(':').next()?.parse().ok()
}

/// A live daemon other than ours (different state file) whose browser is on
/// `cdp_port`.
pub fn other_owner(cfg: &Config, cdp_port: u16) -> Option<RegistryEntry> {
    let dir = state::registry_dir()?;
    let mine = normalize(&cfg.state_file);
    state::live_registered_daemons(&dir).into_iter().find(|e| {
        if normalize(&e.state_file) == mine {
            return false;
        }
        std::fs::read_to_string(&e.state_file)
            .ok()
            .and_then(|s| serde_json::from_str::<DaemonState>(&s).ok())
            .and_then(|st| cdp_port_of(&st.browser_url))
            == Some(cdp_port)
            // A reused pid isn't a daemon: require /health on its port.
            && daemon_answers(e.port)
    })
}

/// Display form of a probed profile.
pub fn describe(dir: &Option<Option<PathBuf>>) -> String {
    match dir {
        Some(Some(p)) => p.display().to_string(),
        Some(None) => "(default profile)".to_string(),
        None => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_data_dir_with_spaces() {
        let c = "/Applications/Edge --remote-debugging-port=9222 --user-data-dir=/Users/x/Library/Application Support/p --no-first-run";
        assert_eq!(
            parse_user_data_dir(c),
            Some(PathBuf::from("/Users/x/Library/Application Support/p"))
        );
        assert_eq!(parse_user_data_dir("/bin/edge --foo"), None);
        assert_eq!(
            parse_user_data_dir("edge --user-data-dir=/tmp/a"),
            Some(PathBuf::from("/tmp/a"))
        );
    }

    #[test]
    fn user_data_dir_stops_at_positional_url() {
        assert_eq!(
            parse_user_data_dir("edge --user-data-dir=/tmp/profile https://example.com"),
            Some(PathBuf::from("/tmp/profile"))
        );
        assert_eq!(
            parse_user_data_dir("edge --user-data-dir=/a b/My Profile about:blank"),
            Some(PathBuf::from("/a b/My Profile"))
        );
        // A path segment with a colon but a slash first is not a URL.
        assert!(!looks_like_url("C:\\x"));
        assert!(looks_like_url("https://x"));
    }

    #[cfg(unix)]
    #[test]
    fn stale_lock_is_ignored_and_live_lock_reported() {
        let d = std::env::temp_dir().join(format!("ghax-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(profile_lock_holder(&d), None);
        let me = std::process::id() as i32;
        std::os::unix::fs::symlink(format!("host-{me}"), d.join("SingletonLock")).unwrap();
        assert_eq!(profile_lock_holder(&d), Some(me));
        std::fs::remove_file(d.join("SingletonLock")).unwrap();
        std::os::unix::fs::symlink("host-999999", d.join("SingletonLock")).unwrap();
        assert_eq!(profile_lock_holder(&d), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn dead_daemon_port_does_not_answer() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        drop(l);
        assert!(!daemon_answers(p));
    }

    #[test]
    fn cdp_port_parses_ws_and_rejects_bridge() {
        assert_eq!(
            cdp_port_of("ws://127.0.0.1:9224/devtools/browser/abc"),
            Some(9224)
        );
        assert_eq!(cdp_port_of("http://127.0.0.1:9222"), Some(9222));
        assert_eq!(cdp_port_of("bridge://127.0.0.1:9223"), None);
    }
}
