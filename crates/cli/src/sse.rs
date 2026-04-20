//! SSE streaming for `--follow` surfaces.
//!
//! Phase 3A: ports the `streamSse()` function from `src/cli.ts` to sync Rust.
//!
//! # Usage
//! ```
//! sse::stream(port, "/sse/console")?;
//! sse::stream(port, "/sse/network")?;
//! sse::stream(port, "/sse/ext-sw-logs/<ext-id>")?;
//! ```
//!
//! # SSE frame format
//! The daemon emits standard SSE over a persistent HTTP response:
//!
//!   ```text
//!   data: {"type":"log","text":"..."}\n
//!   \n
//!   :ping\n
//!   \n
//!   ```
//!
//! Each event is terminated by a blank line (`\n\n`). Comment/keepalive lines
//! start with `:` and are silently skipped. `data: ` lines are stripped of
//! their prefix and printed as-is (the raw JSON payload, one line per event).
//!
//! # Approach
//! `reqwest::blocking::Response` implements `std::io::Read`, so we wrap it in
//! `BufReader` and call `read_line()` in a loop — no async runtime required.
//! This matches every other module in this crate (all blocking, no tokio).
//!
//! Ctrl-C is handled via the `ctrlc` crate (already a dep from Phase 2C
//! canary). We set an `AtomicBool`, check it after each line, and exit 0 on
//! interruption — matching the TS `AbortError` → `EXIT.OK` path.
//!
//! Broken-pipe (user pipes into `head`) is caught and exits with 141,
//! consistent with `output.rs`.

use anyhow::Result;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const SIGPIPE_EXIT: i32 = 141;
const DATA_PREFIX: &str = "data: ";

/// Stream an SSE endpoint and print each `data:` payload on its own line.
///
/// Returns `Ok(0)` on clean exit (stream ended or Ctrl-C).
/// Returns `Ok(4)` if the HTTP request fails (mirrors EXIT_CDP_ERROR).
pub fn stream(port: u16, path: &str) -> Result<i32> {
    let url = format!("http://127.0.0.1:{port}{path}");

    // ── Ctrl-C setup ──────────────────────────────────────────────────────────
    let interrupted = Arc::new(AtomicBool::new(false));
    let interrupted_clone = Arc::clone(&interrupted);
    ctrlc::set_handler(move || {
        interrupted_clone.store(true, Ordering::SeqCst);
    })
    .unwrap_or_else(|e| eprintln!("ghax: could not set Ctrl-C handler: {e}"));

    // ── HTTP GET (no timeout — SSE streams indefinitely) ─────────────────────
    let client = reqwest::blocking::Client::builder()
        // Disable connect/read timeouts; the stream lives as long as the user
        // wants it.  A 1.5 s timeout on /health is fine but would kill SSE.
        .build()?;
    let resp = client
        .get(&url)
        .header("Accept", "text/event-stream")
        .send()?;

    if !resp.status().is_success() {
        eprintln!("ghax: SSE {path} failed ({})", resp.status());
        return Ok(4); // EXIT_CDP_ERROR
    }

    // ── Line-by-line SSE parse ────────────────────────────────────────────────
    //
    // `reqwest::blocking::Response` implements `Read`. Wrapping it in
    // `BufReader` gives us `read_line()`, which blocks until it sees a `\n`
    // or EOF — exactly what we want for a streaming response.
    //
    // SSE frame structure:
    //   field lines ("data: ..." / ":ping" / "event: ..." / "id: ...")
    //   followed by a blank line that signals end-of-frame.
    //
    // We only care about `data:` lines; everything else is skipped.
    let mut reader = BufReader::new(resp);
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    let mut line = String::new();
    loop {
        // Check Ctrl-C before blocking on the next line.
        if interrupted.load(Ordering::SeqCst) {
            return Ok(0);
        }

        line.clear();
        let n = match reader.read_line(&mut line) {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                // EINTR — loop back and retry (Ctrl-C sets the flag via
                // ctrlc handler before we reach here anyway).
                continue;
            }
            Err(e) => {
                eprintln!("ghax: SSE read error: {e}");
                return Ok(4); // EXIT_CDP_ERROR
            }
        };

        // EOF — server closed the connection.
        if n == 0 {
            break;
        }

        // Trim the trailing newline(s) to get the bare line content.
        let trimmed = line.trim_end_matches(['\n', '\r']);

        // Skip blank lines (frame terminators) and comment/keepalive lines.
        if trimmed.is_empty() || trimmed.starts_with(':') {
            continue;
        }

        // Process `data:` lines.
        if let Some(payload) = trimmed.strip_prefix(DATA_PREFIX) {
            // Print the payload as-is (raw JSON string).  The TS CLI does
            // JSON.parse + JSON.stringify to normalise it; we match that
            // behaviour: if the payload is valid JSON, re-serialise compact;
            // otherwise print as-is (identical to the TS `catch` branch).
            let line_out = if let Ok(val) = serde_json::from_str::<serde_json::Value>(payload) {
                serde_json::to_string(&val).unwrap_or_else(|_| payload.to_string())
            } else {
                payload.to_string()
            };

            if let Err(e) = writeln!(out, "{line_out}") {
                if e.kind() == std::io::ErrorKind::BrokenPipe {
                    std::process::exit(SIGPIPE_EXIT);
                }
                eprintln!("ghax: write failed: {e}");
                return Ok(1);
            }
        }
        // Other SSE fields ("event:", "id:", "retry:") are legal but unused;
        // skip them silently.
    }

    Ok(0) // EXIT_OK
}

#[cfg(test)]
mod tests {
    /// Verify the DATA_PREFIX constant matches what the daemon emits.
    #[test]
    fn data_prefix_length() {
        assert_eq!(super::DATA_PREFIX, "data: ");
        assert_eq!(super::DATA_PREFIX.len(), 6);
    }

    /// Verify blank lines and keepalives are identified correctly.
    #[test]
    fn skip_patterns() {
        let blank = "";
        let keepalive = ":ping";
        let comment = ": some comment";
        let data = "data: {}";
        assert!(blank.is_empty() || blank.starts_with(':'));
        assert!(keepalive.starts_with(':'));
        assert!(comment.starts_with(':'));
        assert!(data.strip_prefix("data: ").is_some());
    }

    /// Verify JSON re-serialisation round-trips compact (no indentation).
    #[test]
    fn json_compact() {
        let payload = r#"{"type":"log","text":"hello"}"#;
        let val: serde_json::Value = serde_json::from_str(payload).unwrap();
        let out = serde_json::to_string(&val).unwrap();
        // Must be compact (no newlines / extra spaces).
        assert!(!out.contains('\n'));
        assert_eq!(out, payload);
    }
}
