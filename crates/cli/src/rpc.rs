//! Daemon RPC client. Mirrors the TS `rpc()` helper.
//!
//! All daemon traffic is HTTP+JSON to `127.0.0.1:<port>/rpc` with the body
//! `{cmd, args, opts}`. The daemon answers with `{ok, data?, error?, exitCode?}`.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;

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
    let body = Request { cmd, args, opts };
    let client = reqwest::blocking::Client::builder()
        // No global timeout: long verbs (qa, perf, snapshot with --wait) can run for minutes.
        .build()?;
    let resp = client.post(&url).json(&body).send()?;
    let envelope: Value = resp.json()?;

    let ok = envelope.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let message = envelope
            .get("error")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("RPC {cmd} failed"));
        let exit_code = envelope.get("exitCode").and_then(|v| v.as_i64()).map(|n| n as i32);
        return Err(anyhow!(RpcError { message, exit_code }));
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
