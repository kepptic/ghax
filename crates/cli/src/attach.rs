//! `attach`, `detach`, and `restart` commands — Phase 2A.
//!
//! Ports `src/browser-launch.ts` + the `cmdAttach`/`spawnDaemon`/`cmdDetach`/
//! `cmdRestart`/`pickEndpoint` sections of `src/cli.ts` exactly.
//!
//! Wiring into dispatch.rs (human to do — do NOT auto-modify dispatch.rs):
//!
//!   In the first `match verb { … }` arm inside `dispatch_inner`, replace the
//!   existing stub lines for attach/detach/restart with:
//!
//!     "attach"  => crate::attach::cmd_attach(&args::parse(rest), &cfg),
//!     "detach"  => crate::attach::cmd_detach(&cfg),
//!     "restart" => crate::attach::cmd_restart(&args::parse(rest), &cfg),
//!
//!   Also add `mod attach;` to main.rs.

use anyhow::Result;
use serde::Deserialize;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::args::Parsed;
use crate::state::{self, Config, DaemonState};

// ── Exit codes (mirror dispatch.rs constants) ─────────────────────────────────

const EXIT_OK: i32 = 0;
const EXIT_NOT_ATTACHED: i32 = 2;
// const EXIT_DAEMON_FAILED: i32 = 10;  // used below in spawn error path

// ── Port range (mirrors PORT_BASE / PORT_RANGE in cli.ts) ────────────────────

const PORT_BASE: u16 = 9222;
const PORT_RANGE: u16 = 9; // probes 9222..=9230 inclusive

// ─────────────────────────────────────────────────────────────────────────────
// Browser types — mirror browser-launch.ts
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserKind {
    Edge,
    Chrome,
    Chromium,
    Brave,
    Arc,
}

impl BrowserKind {
    fn as_str(&self) -> &'static str {
        match self {
            BrowserKind::Edge => "edge",
            BrowserKind::Chrome => "chrome",
            BrowserKind::Chromium => "chromium",
            BrowserKind::Brave => "brave",
            BrowserKind::Arc => "arc",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "edge" => Some(BrowserKind::Edge),
            "chrome" => Some(BrowserKind::Chrome),
            "chromium" => Some(BrowserKind::Chromium),
            "brave" => Some(BrowserKind::Brave),
            "arc" => Some(BrowserKind::Arc),
            _ => None,
        }
    }

    fn label(&self) -> &'static str {
        match self {
            BrowserKind::Edge => "Microsoft Edge",
            BrowserKind::Chrome => "Google Chrome",
            BrowserKind::Chromium => "Chromium",
            BrowserKind::Brave => "Brave",
            BrowserKind::Arc => "Arc",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BrowserBinary {
    pub kind: BrowserKind,
    pub path: PathBuf,
    pub label: &'static str,
}

// ─────────────────────────────────────────────────────────────────────────────
// CDP endpoint types
// ─────────────────────────────────────────────────────────────────────────────

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CdpVersionInfo {
    pub browser: String,
    #[serde(rename = "Protocol-Version")]
    pub protocol_version: String,
    #[serde(rename = "User-Agent")]
    pub user_agent: String,
    #[serde(rename = "V8-Version")]
    pub v8_version: Option<String>,
    #[serde(rename = "WebKit-Version")]
    pub webkit_version: Option<String>,
    #[serde(rename = "webSocketDebuggerUrl")]
    pub web_socket_debugger_url: String,
}

#[derive(Debug, Clone)]
pub struct CdpEndpoint {
    /// ws://127.0.0.1:<port>/devtools/browser/<uuid>
    pub browser_url: String,
    /// http://127.0.0.1:<port>
    pub http_url: String,
    pub port: u16,
    pub version: CdpVersionInfo,
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser detection — mirrors browser-launch.ts
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn mac_binaries() -> Vec<(BrowserKind, &'static str)> {
    vec![
        (BrowserKind::Edge,     "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        (BrowserKind::Chrome,   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        (BrowserKind::Chromium, "/Applications/Chromium.app/Contents/MacOS/Chromium"),
        (BrowserKind::Brave,    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
        (BrowserKind::Arc,      "/Applications/Arc.app/Contents/MacOS/Arc"),
    ]
}

#[cfg(target_os = "linux")]
fn linux_binaries() -> Vec<(BrowserKind, Vec<&'static str>)> {
    vec![
        (BrowserKind::Edge,     vec!["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"]),
        (BrowserKind::Chrome,   vec!["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]),
        (BrowserKind::Chromium, vec!["/usr/bin/chromium", "/usr/bin/chromium-browser"]),
        (BrowserKind::Brave,    vec!["/usr/bin/brave-browser"]),
        (BrowserKind::Arc,      vec![]),
    ]
}

#[cfg(windows)]
fn win_binaries() -> Vec<(BrowserKind, Vec<&'static str>)> {
    vec![
        (BrowserKind::Edge, vec![
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]),
        (BrowserKind::Chrome, vec![
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]),
        (BrowserKind::Chromium, vec![]),
        (BrowserKind::Brave, vec![
            "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        ]),
        (BrowserKind::Arc, vec![]),
    ]
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.exists()
    }
}

/// Detect installed Chromium-family browsers on the current platform.
/// Mirrors `detectBrowsers()` in browser-launch.ts.
pub fn detect_browsers() -> Vec<BrowserBinary> {
    let mut found = Vec::new();

    #[cfg(target_os = "macos")]
    {
        for (kind, candidate) in mac_binaries() {
            let p = Path::new(candidate);
            if is_executable(p) {
                found.push(BrowserBinary { label: kind.label(), kind, path: p.to_path_buf() });
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        for (kind, candidates) in linux_binaries() {
            for candidate in candidates {
                let p = Path::new(candidate);
                if is_executable(p) {
                    found.push(BrowserBinary { label: kind.label(), kind: kind.clone(), path: p.to_path_buf() });
                    break; // first hit per kind
                }
            }
        }
        // Also try PATH via `which`-style lookup using std::process::Command
        // For each kind not yet found, try `which <name>`.
        let kinds_found: Vec<_> = found.iter().map(|b| b.kind.clone()).collect();
        let path_names = [
            (BrowserKind::Edge,     &["microsoft-edge", "microsoft-edge-stable"][..]),
            (BrowserKind::Chrome,   &["google-chrome", "google-chrome-stable"][..]),
            (BrowserKind::Chromium, &["chromium", "chromium-browser"][..]),
            (BrowserKind::Brave,    &["brave-browser"][..]),
        ];
        for (kind, names) in &path_names {
            if kinds_found.contains(kind) {
                continue;
            }
            for name in *names {
                if let Ok(out) = std::process::Command::new("which").arg(name).output() {
                    if out.status.success() {
                        let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string());
                        if is_executable(&path) {
                            found.push(BrowserBinary { label: kind.label(), kind: kind.clone(), path });
                            break;
                        }
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    {
        for (kind, candidates) in win_binaries() {
            for candidate in candidates {
                let p = Path::new(candidate);
                if p.exists() {
                    found.push(BrowserBinary { label: kind.label(), kind: kind.clone(), path: p.to_path_buf() });
                    break;
                }
            }
        }
    }

    found
}

// ─────────────────────────────────────────────────────────────────────────────
// CDP probe helpers — mirrors browser-launch.ts
// ─────────────────────────────────────────────────────────────────────────────

/// Probe a single port for a live CDP endpoint.
/// Returns `None` on any error or non-CDP response.
/// Mirrors `probeCdp()` in browser-launch.ts.
fn probe_cdp(port: u16) -> Option<CdpEndpoint> {
    let http_url = format!("http://127.0.0.1:{port}");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .ok()?;
    let resp = client.get(format!("{http_url}/json/version")).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let version: CdpVersionInfo = resp.json().ok()?;
    if version.web_socket_debugger_url.is_empty() {
        return None;
    }
    Some(CdpEndpoint {
        browser_url: version.web_socket_debugger_url.clone(),
        http_url,
        port,
        version,
    })
}

/// Scan `[start, start+count)` for live CDP endpoints.
/// Mirrors `scanCdpPorts()` in browser-launch.ts.
fn scan_cdp_ports(start: u16, count: u16) -> Vec<CdpEndpoint> {
    // TS does parallel probes with Promise.all; blocking reqwest can't trivially
    // parallelise without threads.  Sequentially probing 9 ports at 1.5s timeout
    // each would be 13.5s worst-case — too slow.  Use rayon if available, but
    // since rayon isn't in deps, spawn threads manually.  Each probe runs in a
    // short-lived thread; we collect in port order.
    let ports: Vec<u16> = (start..start + count).collect();
    let results: Vec<Option<CdpEndpoint>> = {
        use std::sync::{Arc, Mutex};
        let slots: Arc<Mutex<Vec<Option<CdpEndpoint>>>> =
            Arc::new(Mutex::new(vec![None; ports.len()]));
        let mut handles = Vec::new();
        for (i, &port) in ports.iter().enumerate() {
            let slots = Arc::clone(&slots);
            handles.push(std::thread::spawn(move || {
                let ep = probe_cdp(port);
                slots.lock().unwrap()[i] = ep;
            }));
        }
        for h in handles {
            let _ = h.join();
        }
        Arc::try_unwrap(slots).unwrap().into_inner().unwrap()
    };
    results.into_iter().flatten().collect()
}

/// Find the first port in `[start, start+count)` with no CDP answer.
/// Mirrors `findFreePort()` in browser-launch.ts.
fn find_free_port(start: u16, count: u16) -> Option<u16> {
    for i in 0..count {
        let port = start + i;
        if probe_cdp(port).is_none() {
            return Some(port);
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser kind inference — mirrors `inferKindFromVersion` in cli.ts
// ─────────────────────────────────────────────────────────────────────────────

fn infer_kind_from_ua(user_agent: &str) -> BrowserKind {
    let ua = user_agent.to_lowercase();
    if ua.contains("edg/") {
        BrowserKind::Edge
    } else if ua.contains("chrome/") {
        BrowserKind::Chrome
    } else {
        BrowserKind::Chromium
    }
}

fn describe_endpoint(ep: &CdpEndpoint) -> String {
    format!(
        "{} {} on :{}",
        infer_kind_from_ua(&ep.version.user_agent).as_str(),
        ep.version.browser,
        ep.port
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile dir — mirrors `profileDirFor` in browser-launch.ts
// ─────────────────────────────────────────────────────────────────────────────

fn profile_dir_for(kind: &BrowserKind) -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".ghax").join(format!("{}-profile", kind.as_str()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Launch instructions — mirrors `launchInstructions` in browser-launch.ts
// ─────────────────────────────────────────────────────────────────────────────

fn launch_instructions(port: u16, browsers: &[BrowserBinary]) -> String {
    #[cfg(target_os = "macos")]
    {
        let mut lines = vec![
            "No running browser found on CDP port.".to_string(),
            String::new(),
        ];
        for b in browsers {
            lines.push(format!("  # {}", b.label));
            lines.push(format!(
                "  \"{}\" --remote-debugging-port={} &",
                b.path.display(),
                port
            ));
            lines.push(String::new());
        }
        lines.push("Or run `ghax attach --launch [--browser edge|chrome]` to let ghax launch one in a scratch profile.".to_string());
        return lines.join("\n");
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = browsers; // silence unused warning on non-mac
        format!(
            "No running browser on :{port}. Launch Chrome/Edge with --remote-debugging-port={port}, or use 'ghax attach --launch'."
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser launch — mirrors `launchBrowser` in browser-launch.ts
// ─────────────────────────────────────────────────────────────────────────────

struct LaunchResult {
    // Logged in launch messages so the user can kill the right process if it hangs.
    #[allow(dead_code)]
    pid: u32,
    endpoint: CdpEndpoint,
    #[allow(dead_code)]
    data_dir: PathBuf,
}

fn launch_browser(
    binary: &BrowserBinary,
    port: u16,
    data_dir: Option<PathBuf>,
    headless: bool,
    load_extension: Option<&str>,
) -> Result<LaunchResult> {
    let data_dir = data_dir.unwrap_or_else(|| profile_dir_for(&binary.kind));
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| anyhow::anyhow!("cannot create profile dir {}: {e}", data_dir.display()))?;

    let mut args: Vec<String> = vec![
        format!("--remote-debugging-port={port}"),
        format!("--user-data-dir={}", data_dir.display()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-features=IsolateOrigins,site-per-process".to_string(),
    ];

    if headless {
        // Chromium 109+ only; --headless=new supports extensions.
        args.push("--headless=new".to_string());
    }

    if let Some(ext_path) = load_extension {
        let resolved = std::fs::canonicalize(ext_path)
            .unwrap_or_else(|_| PathBuf::from(ext_path));
        let manifest = resolved.join("manifest.json");
        if !manifest.exists() {
            return Err(anyhow::anyhow!(
                "--load-extension: no manifest.json in {}",
                resolved.display()
            ));
        }
        let joined = resolved.display().to_string();
        args.push(format!("--load-extension={joined}"));
        args.push(format!("--disable-extensions-except={joined}"));
    }

    let mut cmd = std::process::Command::new(&binary.path);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    let child = cmd.spawn().map_err(|e| {
        anyhow::anyhow!("Failed to launch {}: {e}", binary.path.display())
    })?;
    let pid = child.id();
    // `unref` equivalent — we intentionally don't wait on the child.
    drop(child);

    // Poll CDP up to 10s.
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(ep) = probe_cdp(port) {
            return Ok(LaunchResult { pid, endpoint: ep, data_dir });
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(anyhow::anyhow!(
        "Launched {} (pid {pid}) but CDP on :{port} never came up.",
        binary.label
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon bundle resolution — mirrors `resolveDaemonBundle` in cli.ts
//
// Precedence (per the Phase 2A spec):
//   1. GHAX_DAEMON_BUNDLE env var
//   2. Sibling of the CLI binary: <argv[0] dir>/ghax-daemon.mjs
//   3. Dev fallback: walk up from cwd looking for package.json with
//      "name": "@ghax/cli", then use <root>/dist/ghax-daemon.mjs
// ─────────────────────────────────────────────────────────────────────────────

fn resolve_daemon_bundle() -> Result<PathBuf> {
    // 1. Explicit env override.
    if let Ok(val) = std::env::var("GHAX_DAEMON_BUNDLE") {
        let p = PathBuf::from(&val);
        if p.exists() {
            return Ok(p);
        }
        return Err(anyhow::anyhow!(
            "GHAX_DAEMON_BUNDLE={val} does not exist"
        ));
    }

    // 2. Adjacent to the running binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let adjacent = dir.join("ghax-daemon.mjs");
            if adjacent.exists() {
                return Ok(adjacent);
            }
        }
    }

    // 3. Dev fallback — walk up from cwd looking for package.json with
    //    "name": "@ghax/cli", then expect dist/ghax-daemon.mjs there.
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = cwd.as_path();
        loop {
            let pkg = dir.join("package.json");
            if pkg.exists() {
                if let Ok(raw) = std::fs::read_to_string(&pkg) {
                    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
                    if v.get("name").and_then(|n| n.as_str()) == Some("@ghax/cli") {
                        let bundle = dir.join("dist").join("ghax-daemon.mjs");
                        if bundle.exists() {
                            return Ok(bundle);
                        }
                        return Err(anyhow::anyhow!(
                            "Found @ghax/cli at {} but dist/ghax-daemon.mjs is missing. Run `bun run build` first.",
                            dir.display()
                        ));
                    }
                }
            }
            match dir.parent() {
                Some(p) => dir = p,
                None => break,
            }
        }
    }

    Err(anyhow::anyhow!(
        "Cannot locate ghax-daemon.mjs. Set GHAX_DAEMON_BUNDLE, place it alongside the ghax binary, or run `bun run build` in the project root."
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// State-file helpers needed by attach (supplement state.rs)
// ─────────────────────────────────────────────────────────────────────────────

/// Create the state directory if it doesn't exist, and add `.ghax/` to
/// `.gitignore` if present but missing the entry. Mirrors `ensureStateDir`
/// in config.ts.
fn ensure_state_dir(cfg: &Config) -> Result<()> {
    std::fs::create_dir_all(&cfg.state_dir).map_err(|e| {
        anyhow::anyhow!("Cannot create {}: {e}", cfg.state_dir.display())
    })?;

    // Best-effort .gitignore append — same as the TS implementation.
    let gitignore = cfg.project_dir.join(".gitignore");
    if let Ok(content) = std::fs::read_to_string(&gitignore) {
        let has_entry = content.lines().any(|l| {
            let t = l.trim_end_matches('/');
            t == ".ghax"
        });
        if !has_entry {
            let sep = if content.ends_with('\n') { "" } else { "\n" };
            let _ = std::fs::OpenOptions::new()
                .append(true)
                .open(&gitignore)
                .and_then(|mut f| {
                    use std::io::Write;
                    write!(f, "{sep}.ghax/\n")
                });
        }
    }
    Ok(())
}

/// Clear the state file. Mirrors `clearState` in config.ts.
fn clear_state(cfg: &Config) {
    let _ = std::fs::remove_file(&cfg.state_file);
}

/// Poll state file + health until the daemon is live, mirroring `spawnDaemon`
/// in cli.ts: 100ms tick, 15s deadline.
///
/// `stderr_path` (optional): if the daemon dies before health, read its stderr
/// from this file and surface it in the error message — fix for BUG-001 where
/// the daemon's `Cannot find package 'playwright'` error was silently
/// discarded and the user got the unhelpful "didn't become healthy" message.
fn wait_for_daemon(
    cfg: &Config,
    expected_pid: u32,
    stderr_path: Option<&std::path::Path>,
) -> Result<DaemonState> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()?;

    while Instant::now() < deadline {
        if let Some(s) = state::read_state(cfg) {
            if s.pid == expected_pid as i32 {
                let url = format!("http://127.0.0.1:{}/health", s.port);
                if let Ok(resp) = client.get(&url).send() {
                    if resp.status().is_success() {
                        if let Ok(body) = resp.json::<serde_json::Value>() {
                            if body.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                                return Ok(s);
                            }
                        }
                    }
                }
            }
        }
        // Daemon died before becoming healthy — surface its stderr immediately
        // instead of waiting out the 15s deadline.
        if !state::is_process_alive(expected_pid as i32) {
            return Err(daemon_failure(stderr_path, "exited before becoming healthy"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(daemon_failure(stderr_path, "did not become healthy within 15s"))
}

/// Compose a daemon spawn-failure error. Reads stderr if available, includes
/// it in the message, and adds a hint for the BUG-001 playwright case.
fn daemon_failure(stderr_path: Option<&std::path::Path>, what: &str) -> anyhow::Error {
    let stderr = stderr_path
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut msg = format!("Daemon {what}.");
    if let Some(s) = &stderr {
        msg.push_str("\n\n--- daemon stderr ---\n");
        msg.push_str(s);
        msg.push_str("\n----------------------");
        if s.contains("Cannot find package 'playwright'")
            || s.contains("ERR_MODULE_NOT_FOUND")
        {
            msg.push_str(
                "\n\nThis is BUG-001 — the daemon needs a playwright runtime beside it.\nFix: cd ~/.local/share/ghax && npm install\n(or re-run `bun run install-link` from the ghax repo)",
            );
        }
    } else {
        msg.push_str(" (no stderr captured)");
    }
    anyhow::anyhow!(msg)
}

// ─────────────────────────────────────────────────────────────────────────────
// spawnDaemon — mirrors `spawnDaemon` in cli.ts
// ─────────────────────────────────────────────────────────────────────────────

fn spawn_daemon(
    cfg: &Config,
    endpoint: &CdpEndpoint,
    kind: &BrowserKind,
    capture_bodies: Option<&str>,
) -> Result<DaemonState> {
    ensure_state_dir(cfg)?;

    let bundle = resolve_daemon_bundle()?;

    // Capture stderr to a temp file so we can surface the daemon's last
    // words if it dies before becoming healthy. BUG-001 (2026-04-19) hid a
    // playwright resolution error behind a generic "didn't become healthy"
    // message because stderr was piped to /dev/null.
    let stderr_path = cfg.state_dir.join(format!("ghax-daemon-spawn-{}.stderr", std::process::id()));
    let stderr_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&stderr_path)
        .map_err(|e| anyhow::anyhow!("Failed to open daemon stderr capture file: {e}"))?;

    // Build the inherited environment plus ghax-specific overrides.
    // Mirror cli.ts: `{ ...process.env, GHAX_STATE_FILE, GHAX_CDP_HTTP_URL,
    //   GHAX_CDP_BROWSER_URL, GHAX_BROWSER_KIND [, GHAX_CAPTURE_BODIES] }`
    let mut cmd = std::process::Command::new("node");
    cmd.arg("--enable-source-maps")
        .arg(&bundle)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::from(stderr_file))
        .env("GHAX_STATE_FILE",       cfg.state_file.as_os_str())
        .env("GHAX_CDP_HTTP_URL",     &endpoint.http_url)
        .env("GHAX_CDP_BROWSER_URL",  &endpoint.browser_url)
        .env("GHAX_BROWSER_KIND",     kind.as_str());

    // --capture-bodies (three forms, matching cli.ts exactly):
    //   absent              → don't set env var
    //   --capture-bodies    → GHAX_CAPTURE_BODIES=*
    //   --capture-bodies='*/api/*' → GHAX_CAPTURE_BODIES=*/api/*
    if let Some(pattern) = capture_bodies {
        cmd.env("GHAX_CAPTURE_BODIES", pattern);
    }

    let child = cmd.spawn().map_err(|e| {
        anyhow::anyhow!("Failed to spawn daemon (node {bundle:?}): {e}")
    })?;
    let pid = child.id();
    // Don't wait — daemon runs independently.
    drop(child);

    let result = wait_for_daemon(cfg, pid, Some(&stderr_path));

    // BUG-001 auto-bootstrap: if the daemon failed because a bare-import
    // dep wasn't installed beside it, run `npm install` in the daemon's
    // parent dir and retry once. The bootstrap dir gets a minimal
    // package.json on the fly. Capped at one retry to prevent loops.
    spawn_daemon_with_retry(cfg, endpoint, kind, capture_bodies, &bundle, &stderr_path, result, false)
}

fn spawn_daemon_with_retry(
    cfg: &Config,
    endpoint: &CdpEndpoint,
    kind: &BrowserKind,
    capture_bodies: Option<&str>,
    bundle: &std::path::Path,
    stderr_path: &std::path::Path,
    result: Result<DaemonState>,
    already_retried: bool,
) -> Result<DaemonState> {
    match result {
        Ok(state) => {
            let _ = std::fs::remove_file(stderr_path);
            Ok(state)
        }
        Err(e) => {
            let stderr_text = std::fs::read_to_string(stderr_path).unwrap_or_default();
            let _ = std::fs::remove_file(stderr_path);

            let needs_bootstrap = !already_retried
                && (stderr_text.contains("ERR_MODULE_NOT_FOUND")
                    || stderr_text.contains("Cannot find package"));
            if !needs_bootstrap {
                return Err(e);
            }

            let Some(parent) = bundle.parent() else {
                return Err(e);
            };
            eprintln!(
                "ghax: daemon needs runtime deps — bootstrapping in {} (one-time, ~10s)...",
                parent.display()
            );
            bootstrap_daemon_runtime(parent)
                .map_err(|be| anyhow::anyhow!("{e}\n\nAuto-bootstrap also failed: {be}"))?;

            // One-shot retry: re-spawn and re-wait, but DO NOT recurse into
            // bootstrap a second time (already_retried = true).
            ensure_state_dir(cfg)?;
            let stderr_file = std::fs::OpenOptions::new()
                .create(true).write(true).truncate(true)
                .open(stderr_path)
                .map_err(|fe| anyhow::anyhow!("Failed to reopen stderr capture: {fe}"))?;
            let mut cmd = std::process::Command::new("node");
            cmd.arg("--enable-source-maps")
                .arg(bundle)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::from(stderr_file))
                .env("GHAX_STATE_FILE",      cfg.state_file.as_os_str())
                .env("GHAX_CDP_HTTP_URL",    &endpoint.http_url)
                .env("GHAX_CDP_BROWSER_URL", &endpoint.browser_url)
                .env("GHAX_BROWSER_KIND",    kind.as_str());
            if let Some(pattern) = capture_bodies {
                cmd.env("GHAX_CAPTURE_BODIES", pattern);
            }
            let child = cmd.spawn().map_err(|se| {
                anyhow::anyhow!("Failed to re-spawn daemon after bootstrap: {se}")
            })?;
            let pid = child.id();
            drop(child);
            let result = wait_for_daemon(cfg, pid, Some(stderr_path));
            spawn_daemon_with_retry(cfg, endpoint, kind, capture_bodies, bundle, stderr_path, result, true)
        }
    }
}

/// Drop a minimal package.json + run `npm install` in `dir`. Pulls in every
/// runtime dep marked external by the daemon's esbuild step (currently:
/// playwright + source-map). Used by the BUG-001 auto-bootstrap path.
fn bootstrap_daemon_runtime(dir: &std::path::Path) -> Result<()> {
    let pkg = r#"{
  "name": "ghax-daemon-runtime",
  "private": true,
  "type": "module",
  "description": "Sibling deps for ghax-daemon.mjs (auto-bootstrapped by ghax attach)",
  "dependencies": {
    "playwright": "^1.58.2",
    "source-map": "^0.7.6"
  }
}
"#;
    std::fs::write(dir.join("package.json"), pkg)
        .map_err(|e| anyhow::anyhow!("Failed to write package.json in {}: {e}", dir.display()))?;
    let status = std::process::Command::new("npm")
        .args(["install", "--silent", "--no-audit", "--no-fund", "--omit=dev"])
        .current_dir(dir)
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to run npm install in {}: {e}", dir.display()))?;
    if !status.success() {
        return Err(anyhow::anyhow!(
            "npm install in {} exited with {status}",
            dir.display()
        ));
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// pickEndpoint — mirrors `pickEndpoint` in cli.ts
// ─────────────────────────────────────────────────────────────────────────────

fn pick_endpoint(endpoints: Vec<CdpEndpoint>, prefer_kind: Option<&BrowserKind>) -> CdpEndpoint {
    let mut endpoints = endpoints;

    // Preference filter first.
    if let Some(kind) = prefer_kind {
        let matching: Vec<CdpEndpoint> = endpoints
            .iter()
            .filter(|ep| &infer_kind_from_ua(&ep.version.user_agent) == kind)
            .cloned()
            .collect();
        if matching.len() == 1 {
            return matching.into_iter().next().unwrap();
        }
        if matching.len() > 1 {
            endpoints = matching;
        }
    }

    // Check if stdin is a TTY.
    let is_tty = unsafe { libc_isatty(0) == 1 };

    if !is_tty {
        // Non-interactive: print note to stderr, return first.
        let descriptions: Vec<String> = endpoints.iter().map(describe_endpoint).collect();
        eprintln!("Found {} CDPs: {}.", endpoints.len(), descriptions.join(", "));
        eprintln!("  using {} (pass --port to override)", describe_endpoint(&endpoints[0]));
        return endpoints.into_iter().next().unwrap();
    }

    // Interactive picker.
    println!("Found {} CDP endpoints:", endpoints.len());
    for (i, ep) in endpoints.iter().enumerate() {
        println!("  [{}] {}", i + 1, describe_endpoint(ep));
    }
    print!("Choose [1-{}] (default 1): ", endpoints.len());
    let _ = io::stdout().flush();

    let mut line = String::new();
    let _ = io::stdin().read_line(&mut line);
    if let Ok(n) = line.trim().parse::<usize>() {
        if n >= 1 && n <= endpoints.len() {
            return endpoints.swap_remove(n - 1);
        }
    }
    endpoints.into_iter().next().unwrap()
}

#[cfg(unix)]
extern "C" {
    fn isatty(fd: i32) -> i32;
}

#[cfg(unix)]
unsafe fn libc_isatty(fd: i32) -> i32 {
    isatty(fd)
}

#[cfg(not(unix))]
unsafe fn libc_isatty(_fd: i32) -> i32 {
    // On Windows, fall through to non-interactive path.
    0
}

// ─────────────────────────────────────────────────────────────────────────────
// Public command entrypoints
// ─────────────────────────────────────────────────────────────────────────────

/// `ghax attach` — mirror of `cmdAttach` in cli.ts.
pub fn cmd_attach(parsed: &Parsed, cfg: &Config) -> Result<i32> {
    let explicit_port: Option<u16> = parsed
        .flags
        .get("port")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    let browser_opt: Option<BrowserKind> = parsed
        .flags
        .get("browser")
        .and_then(|v| v.as_str())
        .and_then(BrowserKind::from_str);

    let launch = matches!(parsed.flags.get("launch"), Some(serde_json::Value::Bool(true)));
    let headless = matches!(parsed.flags.get("headless"), Some(serde_json::Value::Bool(true)));

    // --capture-bodies forms:
    //   absent   → None
    //   (bool)   → Some("*")     captures everything
    //   (string) → Some(pattern) URL-filter
    let capture_bodies: Option<String> = match parsed.flags.get("capture-bodies") {
        None => None,
        Some(serde_json::Value::Bool(true)) => Some("*".to_string()),
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    let capture_bodies_ref: Option<&str> = capture_bodies.as_deref();

    // ── Already attached? Short-circuit. ────────────────────────────────────
    if let Some(existing) = state::read_state(cfg) {
        if state::is_process_alive(existing.pid) {
            // Quick health check.
            let url = format!("http://127.0.0.1:{}/health", existing.port);
            let alive = reqwest::blocking::Client::builder()
                .timeout(Duration::from_millis(1500))
                .build()
                .ok()
                .and_then(|c| c.get(&url).send().ok())
                .and_then(|r| r.json::<serde_json::Value>().ok())
                .and_then(|b| b.get("ok").and_then(|v| v.as_bool()))
                == Some(true);

            if alive {
                println!(
                    "already attached — pid {}, port {}, browser {}",
                    existing.pid, existing.port, existing.browser_kind
                );
                return Ok(EXIT_OK);
            }
        }
        // Stale state file.
        clear_state(cfg);
    }

    // ── Step 1: find an endpoint ─────────────────────────────────────────────
    let mut endpoint: Option<CdpEndpoint> = None;

    if let Some(port) = explicit_port {
        if let Some(hit) = probe_cdp(port) {
            let hit_kind = infer_kind_from_ua(&hit.version.user_agent);
            if browser_opt.is_none() || browser_opt.as_ref() == Some(&hit_kind) {
                endpoint = Some(hit);
            }
        }
    } else {
        let mut found = scan_cdp_ports(PORT_BASE, PORT_RANGE);
        if let Some(ref kind) = browser_opt {
            found.retain(|ep| &infer_kind_from_ua(&ep.version.user_agent) == kind);
        }
        if found.len() == 1 {
            endpoint = found.into_iter().next();
        } else if found.len() > 1 {
            endpoint = Some(pick_endpoint(found, browser_opt.as_ref()));
        }
    }

    let mut kind: BrowserKind = browser_opt.clone().unwrap_or(BrowserKind::Edge);

    if endpoint.is_none() {
        // ── Step 2: launch path ──────────────────────────────────────────────
        let browsers = detect_browsers();

        if !launch {
            // If --browser filtered out live CDPs, give a helpful error.
            if browser_opt.is_some() && explicit_port.is_none() {
                let any_running = scan_cdp_ports(PORT_BASE, PORT_RANGE);
                if !any_running.is_empty() {
                    let describe_list: Vec<String> = any_running
                        .iter()
                        .map(|ep| {
                            format!(
                                "{} on :{}",
                                infer_kind_from_ua(&ep.version.user_agent).as_str(),
                                ep.port
                            )
                        })
                        .collect();
                    eprintln!(
                        "--browser {} requested, but only {} running.\n  Pass --launch to start {}, or omit --browser to attach to a running one.",
                        browser_opt.as_ref().unwrap().as_str(),
                        describe_list.join(", "),
                        browser_opt.as_ref().unwrap().as_str(),
                    );
                    return Ok(EXIT_NOT_ATTACHED);
                }
            }
            eprintln!(
                "{}",
                launch_instructions(explicit_port.unwrap_or(PORT_BASE), &browsers)
            );
            return Ok(EXIT_NOT_ATTACHED);
        }

        if browsers.is_empty() {
            eprintln!("No supported browsers installed. Expected Edge, Chrome, Chromium, Brave, or Arc.");
            return Ok(EXIT_NOT_ATTACHED);
        }

        let target = if let Some(ref kind) = browser_opt {
            browsers.iter().find(|b| &b.kind == kind)
        } else {
            browsers
                .iter()
                .find(|b| b.kind == BrowserKind::Edge)
                .or_else(|| browsers.first())
        };

        let target = match target {
            Some(t) => t,
            None => {
                eprintln!(
                    "Browser {} not found. Installed: {}",
                    browser_opt.as_ref().unwrap().as_str(),
                    browsers.iter().map(|b| b.kind.as_str()).collect::<Vec<_>>().join(", ")
                );
                return Ok(EXIT_NOT_ATTACHED);
            }
        };

        // Pick the launch port.
        let launch_port: u16;
        if let Some(port) = explicit_port {
            launch_port = port;
            // Reuse-first invariant: re-check in case CDP appeared since scan.
            if let Some(inuse) = probe_cdp(port) {
                let inuse_kind = browser_opt
                    .clone()
                    .unwrap_or_else(|| infer_kind_from_ua(&inuse.version.user_agent));
                let state = spawn_daemon(cfg, &inuse, &inuse_kind, capture_bodies_ref)?;
                println!(
                    "attached (port race resolved) — pid {}, port {}, browser {}",
                    state.pid, state.port, state.browser_kind
                );
                return Ok(EXIT_OK);
            }
        } else {
            match find_free_port(PORT_BASE, PORT_RANGE) {
                Some(p) => {
                    if p != PORT_BASE {
                        println!(":{PORT_BASE} in use — using :{p}");
                    }
                    launch_port = p;
                }
                None => {
                    eprintln!(
                        "No free port in {PORT_BASE}..{} (all occupied). Pass --port to override.",
                        PORT_BASE + PORT_RANGE - 1
                    );
                    return Ok(EXIT_NOT_ATTACHED);
                }
            }
        }

        let load_ext = parsed.flags.get("load-extension").and_then(|v| v.as_str());
        let data_dir_opt = parsed
            .flags
            .get("data-dir")
            .and_then(|v| v.as_str())
            .map(PathBuf::from);

        let ext_note = load_ext
            .map(|e| format!(" with unpacked extension from {e}"))
            .unwrap_or_default();
        let profile_note = data_dir_opt
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| format!("~/.ghax/{}-profile", target.kind.as_str()));
        let headless_note = if headless { " [headless]" } else { "" };

        println!(
            "launching {}{} with CDP on :{launch_port} (profile: {profile_note}){ext_note}",
            target.label, headless_note
        );

        let launched = launch_browser(target, launch_port, data_dir_opt, headless, load_ext)?;
        endpoint = Some(launched.endpoint);
        kind = target.kind.clone();
    } else if let Some(ref ep) = endpoint {
        kind = browser_opt
            .clone()
            .unwrap_or_else(|| infer_kind_from_ua(&ep.version.user_agent));
    }

    let ep = endpoint.unwrap(); // always Some at this point
    let state = spawn_daemon(cfg, &ep, &kind, capture_bodies_ref)?;
    println!(
        "attached — pid {}, port {}, browser {}",
        state.pid, state.port, state.browser_kind
    );
    Ok(EXIT_OK)
}

/// `ghax detach` — mirror of `cmdDetach` in cli.ts.
pub fn cmd_detach(cfg: &Config) -> Result<i32> {
    let state = match state::read_state(cfg) {
        None => {
            println!("not attached");
            return Ok(EXIT_OK);
        }
        Some(s) => s,
    };

    if !state::is_process_alive(state.pid) {
        clear_state(cfg);
        println!("stale state file cleared");
        return Ok(EXIT_OK);
    }

    // POST /shutdown — ignore errors (fall through to SIGTERM).
    let _ = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .ok()
        .and_then(|c| {
            c.post(format!("http://127.0.0.1:{}/shutdown", state.port))
                .send()
                .ok()
        });

    // Poll up to 1s (20 × 50ms) for the process to exit.
    for _ in 0..20 {
        if !state::is_process_alive(state.pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    // SIGTERM if still running.
    if state::is_process_alive(state.pid) {
        #[cfg(unix)]
        unsafe {
            libc_kill(state.pid, 15); // SIGTERM = 15
        }
    }

    clear_state(cfg);
    println!("detached");
    Ok(EXIT_OK)
}

/// `ghax restart` — mirror of `cmdRestart` in cli.ts.
pub fn cmd_restart(parsed: &Parsed, cfg: &Config) -> Result<i32> {
    cmd_detach(cfg)?;
    cmd_attach(parsed, cfg)
}

// Reuse the kill shim from state.rs (already compiled in the same crate).
#[cfg(unix)]
unsafe fn libc_kill(pid: i32, sig: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, sig)
}

#[cfg(not(unix))]
#[allow(dead_code)]
unsafe fn libc_kill(_pid: i32, _sig: i32) -> i32 {
    0
}
