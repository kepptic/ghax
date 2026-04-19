//! `ghax canary` — long-running page health monitor.
//!
//! Mirrors `cmdCanary()` in `src/cli.ts` exactly. Every `--interval` seconds
//! the command:
//!   1. Navigates to the target URL via `goto` RPC.
//!   2. Waits 400 ms for SPA rendering (matches TS `setTimeout(r, 400)`).
//!   3. Samples console + network buffers, filtering to entries since the
//!      cycle started.
//!   4. Appends a `CanaryCycle` record to the in-memory log.
//!   5. Appends a human-readable line to `.ghax/canary-<host>.log`.
//!
//! On Ctrl-C (or when `--max` elapsed time is reached, or `--fail-fast` and
//! a cycle fails) the final report is written to `--out` if provided.
//!
//! Ctrl-C is handled via the `ctrlc` crate, which sets an `AtomicBool`. The
//! sleep between cycles polls this flag every 250 ms — the same granularity
//! used in the TS implementation (`setTimeout(r, Math.min(250, remaining))`).

use crate::args::Parsed;
use crate::dispatch::{EXIT_CDP_ERROR, EXIT_OK, EXIT_USAGE};
use crate::rpc;
use crate::state;
use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ── JSON report types ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanaryCycle {
    at: String,
    url: String,
    ok: bool,
    load_ms: u64,
    console_errors: usize,
    failed_requests: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanaryReport {
    url: String,
    started_at: String,
    ended_at: String,
    duration_ms: u64,
    cycles: Vec<CanaryCycle>,
    ok_cycles: usize,
    fail_cycles: usize,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

fn iso_now() -> String {
    let ms = now_ms();
    let secs = ms / 1000;
    let millis = ms % 1000;
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Extract hostname from a URL for the log filename.
/// Returns `"unknown"` on parse failure.
fn hostname_of(url: &str) -> String {
    // Find ://, then take everything up to the first / ? or end.
    let after_scheme = url.split_once("://").map(|(_, a)| a).unwrap_or(url);
    let host = after_scheme.split(&['/', '?', '#'][..]).next().unwrap_or(after_scheme);
    // Sanitise non-alphanumeric (matches TS `.replace(/[^a-z0-9.-]/gi, '_')`).
    host.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect()
}

// ── Main entry point ───────────────────────────────────────────────────────

pub fn cmd_canary(parsed: &Parsed) -> Result<i32> {
    let url = match parsed.positional.first() {
        Some(u) => u.clone(),
        None => {
            eprintln!("Usage: ghax canary <url> [--interval 60] [--max 3600] [--out <report.json>] [--fail-fast]");
            return Ok(EXIT_USAGE);
        }
    };

    let interval_sec: u64 = parsed.flags.get("interval")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let max_sec: u64 = parsed.flags.get("max")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(3600);
    let out_path = parsed.flags.get("out").and_then(|v| v.as_str()).map(str::to_string);
    let fail_fast = matches!(parsed.flags.get("fail-fast"), Some(Value::Bool(true)));

    // ── Daemon ──
    let cfg = state::resolve_config();
    let port = state::require_daemon(&cfg)?;

    // ── Log file path ──
    let log_path = {
        let host = hostname_of(&url);
        cfg.state_dir.join(format!("canary-{host}.log"))
    };
    // Ensure state dir exists (best-effort, mirrors TS `ensureStateDir`).
    std::fs::create_dir_all(&cfg.state_dir).ok();

    // ── Ctrl-C handling ──
    let aborted = Arc::new(AtomicBool::new(false));
    let aborted_clone = Arc::clone(&aborted);
    ctrlc::set_handler(move || {
        aborted_clone.store(true, Ordering::SeqCst);
        // Print the "interrupted" message that matches TS output.
        println!("\n(interrupted — writing partial report)");
    })
    .unwrap_or_else(|e| eprintln!("ghax canary: could not set Ctrl-C handler: {e}"));

    let started_ms = now_ms();
    let started_at = iso_now();
    let mut cycles: Vec<CanaryCycle> = Vec::new();

    // ── Poll loop ──
    while !aborted.load(Ordering::SeqCst) && now_ms() - started_ms < max_sec * 1000 {
        let cycle_start = now_ms();
        let cycle_at = iso_now();

        let mut load_ms: u64 = 0;
        let mut console_errors: usize = 0;
        let mut failed_requests: usize = 0;
        let mut notes: Option<Vec<String>> = None;
        // `nav_ok` tracks whether the goto RPC succeeded. Overwritten in Ok branch.
        let nav_ok: bool;

        match rpc::call(port, "goto", json!([url]), json!({})) {
            Err(e) => {
                nav_ok = false;
                notes = Some(vec![format!("rpc error: {e}")]);
            }
            Ok(nav) => {
                nav_ok = true;
                // 400 ms hydration wait (matches TS).
                std::thread::sleep(Duration::from_millis(400));
                load_ms = now_ms() - cycle_start;

                // Check for redirect (matches TS: `nav.url !== url && !nav.url.startsWith(url)`).
                let final_url = nav.get("url").and_then(|v| v.as_str()).unwrap_or(url.as_str()).to_string();
                if final_url != url && !final_url.starts_with(url.as_str()) {
                    notes = Some(vec![format!("redirected to {final_url}")]);
                }

                // Console errors since cycle start.
                let console_log = rpc::call(port, "console", json!([]), json!({ "last": 500 }))
                    .unwrap_or(Value::Array(vec![]));
                console_errors = console_log
                    .as_array()
                    .unwrap_or(&vec![])
                    .iter()
                    .filter(|e| {
                        e.get("level").and_then(|v| v.as_str()).unwrap_or("") == "error"
                            && e.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0) >= cycle_start
                    })
                    .count();

                // Failed network requests since cycle start.
                let net_log = rpc::call(port, "network", json!([]), json!({ "last": 500 }))
                    .unwrap_or(Value::Array(vec![]));
                failed_requests = net_log
                    .as_array()
                    .unwrap_or(&vec![])
                    .iter()
                    .filter(|e| {
                        let ts = e.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0);
                        let status = e.get("status").and_then(|v| v.as_u64()).unwrap_or(0);
                        ts >= cycle_start && status >= 400
                    })
                    .count();

            }
        }
        // ok = nav succeeded AND no console/net errors.
        let ok = nav_ok && console_errors == 0 && failed_requests == 0;

        let notes_suffix = match &notes {
            Some(n) => format!(" — {}", n.join(", ")),
            None => String::new(),
        };
        let line = format!(
            "[{cycle_at}] {} {url} load={load_ms}ms console={console_errors} net={failed_requests}{notes_suffix}",
            if ok { "OK" } else { "FAIL" }
        );
        println!("{line}");

        // Append to log file (best-effort, matching TS try/catch).
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            use std::io::Write;
            let _ = writeln!(f, "{line}");
        }

        cycles.push(CanaryCycle {
            at: cycle_at,
            url: url.clone(),
            ok,
            load_ms,
            console_errors,
            failed_requests,
            notes,
        });

        if !ok && fail_fast {
            break;
        }
        if aborted.load(Ordering::SeqCst) {
            break;
        }

        // Sleep in 250 ms ticks so Ctrl-C is responsive (matches TS 250 ms setTimeout).
        let sleep_until = now_ms() + interval_sec * 1000;
        while !aborted.load(Ordering::SeqCst) && now_ms() < sleep_until {
            let remaining = sleep_until.saturating_sub(now_ms());
            std::thread::sleep(Duration::from_millis(remaining.min(250)));
        }
    }

    // ── Final report ──
    let ended_at = iso_now();
    let duration_ms = now_ms() - started_ms;
    let ok_cycles = cycles.iter().filter(|c| c.ok).count();
    let fail_cycles = cycles.iter().filter(|c| !c.ok).count();

    let report = CanaryReport {
        url: url.clone(),
        started_at,
        ended_at,
        duration_ms,
        cycles,
        ok_cycles,
        fail_cycles,
    };

    if let Some(ref path) = out_path {
        let json_str = serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_string());
        std::fs::write(path, &json_str)?;
        println!("report → {path}");
    }
    println!("canary done — {ok_cycles}/{} cycles ok", report.cycles.len());

    Ok(if fail_cycles > 0 { EXIT_CDP_ERROR } else { EXIT_OK })
}
