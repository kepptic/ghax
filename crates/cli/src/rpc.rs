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
    let url = format!("http://127.0.0.1:{port}/rpc");
    let body = Request { cmd, args: &args, opts: &opts };
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
