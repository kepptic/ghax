//! Daemon RPC client. Mirrors the TS `rpc()` helper.
//!
//! All daemon traffic is HTTP+JSON to `127.0.0.1:<port>/rpc` with the body
//! `{cmd, args, opts}`. The daemon answers with `{ok, data?, error?, exitCode?}`.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

/// Set by the global `--trace` flag (stripped from argv in dispatch::run so
/// it can sit anywhere on the line without swallowing a positional).
static TRACE: AtomicBool = AtomicBool::new(false);

pub fn set_trace(on: bool) {
    TRACE.store(on, Ordering::Relaxed);
}

#[derive(Serialize)]
struct Request<'a> {
    cmd: &'a str,
    args: &'a Value,
    opts: &'a Value,
}

#[derive(Debug)]
pub struct RpcError {
    pub message: String,
    pub exit_code: Option<i32>,
    /// Recovery guidance from the daemon (bridge-mode typed errors). Printed on
    /// its own line by the dispatch error handler. See docs/design/plan/08 §2.7.
    pub hint: Option<String>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RpcError {}

pub fn call(port: u16, cmd: &str, args: Value, opts: Value) -> Result<Value> {
    // Single-retry shim for transient-looking errors — connection
    // refused/reset, broken pipe, request build failure — so a daemon
    // that's briefly unresponsive (post-spawn warm-up, GC pause,
    // mid-reload) doesn't bubble up a user-visible failure. Semantic
    // errors (daemon answered with ok:false) are NOT retried — those
    // are real command failures, not flake.
    match call_once(port, cmd, &args, &opts) {
        Ok(v) => Ok(v),
        Err(e) => {
            if is_transient(&e) {
                std::thread::sleep(std::time::Duration::from_millis(50));
                call_once(port, cmd, &args, &opts)
            } else {
                Err(e)
            }
        }
    }
}

fn call_once(port: u16, cmd: &str, args: &Value, opts: &Value) -> Result<Value> {
    let url = format!("http://127.0.0.1:{port}/rpc");
    let traced_opts;
    let opts = if TRACE.load(Ordering::Relaxed) {
        let mut m = opts.as_object().cloned().unwrap_or_default();
        m.insert("trace".into(), Value::Bool(true));
        traced_opts = Value::Object(m);
        &traced_opts
    } else {
        opts
    };
    let body = Request { cmd, args, opts };
    let client = reqwest::blocking::Client::builder()
        // No global timeout: long verbs (qa, perf, snapshot with --wait) can run for minutes.
        .build()?;
    let resp = client.post(&url).json(&body).send()?;
    let envelope: Value = resp.json()?;
    if let Some(trace) = envelope.get("trace") {
        eprintln!("{}", format_trace(trace));
    }

    let ok = envelope.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let message = envelope
            .get("error")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("RPC {cmd} failed"));
        let exit_code = envelope.get("exitCode").and_then(|v| v.as_i64()).map(|n| n as i32);
        let hint = envelope.get("hint").and_then(|v| v.as_str()).map(str::to_string);
        return Err(anyhow!(RpcError { message, exit_code, hint }));
    }
    Ok(envelope.get("data").cloned().unwrap_or(Value::Null))
}

/// Transient = transport-layer hiccup we'd retry. A daemon-side semantic
/// failure (wrapped in `RpcError`) is never transient — it ran, it failed.
fn is_transient(err: &anyhow::Error) -> bool {
    if err.downcast_ref::<RpcError>().is_some() {
        return false;
    }
    if let Some(re) = err.downcast_ref::<reqwest::Error>() {
        // Connection refused / reset / broken pipe / timeout all look
        // like the daemon blinked. `is_request` catches everything except
        // a completed response.
        return re.is_connect() || re.is_timeout() || re.is_request();
    }
    false
}

/// One stderr line summarising a `--trace` envelope. stdout stays exactly
/// what it would be without the flag, so `--json` consumers are unaffected.
pub fn format_trace(trace: &Value) -> String {
    let num = |k: &str| trace.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let calls = trace.get("cdpCalls").and_then(|v| v.as_u64()).unwrap_or(0);
    let transport = trace.get("transport").and_then(|v| v.as_str()).unwrap_or("?");
    let mut top: Vec<(String, u64, f64)> = trace
        .get("byMethod")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    let c = v.get("calls").and_then(|c| c.as_u64()).unwrap_or(0);
                    let ms = v.get("ms").and_then(|c| c.as_f64()).unwrap_or(0.0);
                    (k.clone(), c, ms)
                })
                .collect()
        })
        .unwrap_or_default();
    top.sort_by(|a, b| b.2.total_cmp(&a.2).then(b.1.cmp(&a.1)));
    let mut line = format!(
        "trace: {calls} cdp calls, {:.1} ms cdp, {:.1} ms handler ({transport})",
        num("cdpMs"),
        num("handlerMs"),
    );
    if !top.is_empty() {
        let parts: Vec<String> =
            top.iter().take(3).map(|(m, c, ms)| format!("{m} x{c} ({ms:.1} ms)")).collect();
        line.push_str("; top: ");
        line.push_str(&parts.join(", "));
    }
    if let Some(note) = trace.get("note").and_then(|v| v.as_str()) {
        line.push_str(&format!(" [{note}]"));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trace_line_names_top_methods_by_time() {
        let t = json!({
            "transport": "bridge", "handlerMs": 12.0, "cdpCalls": 4, "cdpMs": 9.5,
            "byMethod": {
                "DOM.resolveNode": { "calls": 3, "errors": 0, "ms": 1.5 },
                "Runtime.callFunctionOn": { "calls": 1, "errors": 0, "ms": 8.0 }
            }
        });
        let line = format_trace(&t);
        let head = "trace: 4 cdp calls, 9.5 ms cdp, 12.0 ms handler (bridge)";
        assert!(line.starts_with(head), "{line}");
        let top = "top: Runtime.callFunctionOn x1 (8.0 ms), DOM.resolveNode x3";
        assert!(line.contains(top), "{line}");
    }
}
