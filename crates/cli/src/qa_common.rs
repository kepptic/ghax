//! Shared QA-style log filters used by both `qa` (full crawl report) and
//! `canary` (post-deploy loop). Both reach into the daemon's console and
//! network ring buffers, discard anything older than a cycle-start
//! timestamp, and pluck out error-level console entries or 4xx/5xx
//! network entries. Centralising the filter keeps the two verbs honest
//! about what counts as a "cycle error".

use crate::rpc;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleErrorEntry {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedRequestEntry {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub method: String,
}

pub fn console_errors_since(port: u16, since_ms: u64, last: u64) -> Vec<ConsoleErrorEntry> {
    // Daemon-side filter on `since` keeps the payload small when the buffer
    // holds thousands of entries. `errors: true` lets the daemon drop
    // non-error levels before it ships the JSON; the client just collects.
    let log = rpc::call(
        port,
        "console",
        json!([]),
        json!({ "last": last, "since": since_ms, "errors": true }),
    )
    .unwrap_or(Value::Array(vec![]));
    log.as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|e| ConsoleErrorEntry {
            text: e.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            url: e.get("url").and_then(|v| v.as_str()).map(str::to_string),
        })
        .collect()
}

pub fn failed_requests_since(port: u16, since_ms: u64, last: u64) -> Vec<FailedRequestEntry> {
    let log = rpc::call(
        port,
        "network",
        json!([]),
        json!({ "last": last, "since": since_ms }),
    )
    .unwrap_or(Value::Array(vec![]));
    log.as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.get("status").and_then(|v| v.as_u64()).unwrap_or(0) >= 400)
        .map(|e| FailedRequestEntry {
            url: e.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            status: e.get("status").and_then(|v| v.as_u64()).map(|n| n as u16),
            method: e.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_string(),
        })
        .collect()
}
