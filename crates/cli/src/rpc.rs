//! Daemon RPC client. Mirrors the TS `rpc()` helper.
//!
//! All daemon traffic is HTTP+JSON to `127.0.0.1:<port>/rpc` with the body
//! `{cmd, args, opts}`. The daemon answers with `{ok, data?, error?, exitCode?}`.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

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

/// Whether a verb may be sent a second time after a transport failure.
///
/// The daemon runs a verb to completion even when the CLI stops listening, so
/// "the response never arrived" does NOT mean "the command never ran". Only a
/// read can be repeated blindly. A mutation is re-sent only when the request
/// provably never reached the daemon (the TCP connect itself failed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryClass {
    Idempotent,
    Mutating,
}

/// Daemon RPC names safe to repeat. Anything absent, including verbs added
/// later, is Mutating by default: forgetting to list a read costs one retry;
/// wrongly listing a click costs a double click. `batch` is Mutating as a
/// whole because an arbitrary prefix of its steps may already have run.
/// `box` is left out on purpose: it scrolls before measuring, which can
/// trigger lazy loading (same call as BRIDGE_RETRY_SAFE in src/daemon.ts and
/// docs/design/plan/08-bridge-reliability.md §2.3).
const IDEMPOTENT: &[&str] = &[
    "status",
    "tabs",
    "find",
    "text",
    "html",
    "snapshot",
    "is",
    "xpath",
    "console",
    "network",
    "cookies",
    "downloads",
    "screenshot",
    "wait",
    "bridge.instances",
    "bridge.stats",
    "record.status",
    "ext.list",
    "ext.targets",
    "ext.sw.logs",
];

pub fn retry_class(cmd: &str) -> RetryClass {
    if IDEMPOTENT.contains(&cmd) {
        RetryClass::Idempotent
    } else {
        RetryClass::Mutating
    }
}

/// Default per-call budget. Long enough for any ordinary verb, short enough
/// that a page stuck on an alert or an `eval` of a never-settling promise
/// doesn't hang the CLI forever. Override with GHAX_RPC_TIMEOUT (seconds,
/// 0 = no limit).
const DEFAULT_RPC_TIMEOUT_SECS: u64 = 120;
/// Added to a verb's own `--timeout` so the daemon's answer (which may be a
/// truthful "timed out") arrives before the CLI gives up.
const OWN_TIMEOUT_MARGIN_SECS: u64 = 30;
/// Verbs whose run time is set by the user (durations, waits, whole plans),
/// so no default cap applies.
const UNBOUNDED: &[&str] = &["perf", "profile", "batch", "ext.hot-reload"];

/// The HTTP timeout for one call. `env` is GHAX_RPC_TIMEOUT's value.
pub fn timeout_for(cmd: &str, opts: &Value, env: Option<&str>) -> Option<Duration> {
    let own_ms = ["timeout", "timeoutMs"].iter().find_map(|k| match opts.get(*k) {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.trim().parse::<u64>().ok(),
        _ => None,
    });
    if let Some(ms) = own_ms {
        return Some(Duration::from_millis(ms) + Duration::from_secs(OWN_TIMEOUT_MARGIN_SECS));
    }
    if UNBOUNDED.contains(&cmd) {
        return None;
    }
    let secs = env
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_RPC_TIMEOUT_SECS);
    if secs == 0 {
        None
    } else {
        Some(Duration::from_secs(secs))
    }
}

pub fn call(port: u16, cmd: &str, args: Value, opts: Value) -> Result<Value> {
    let env = std::env::var("GHAX_RPC_TIMEOUT").ok();
    let timeout = timeout_for(cmd, &opts, env.as_deref());
    let client = reqwest::blocking::Client::builder().timeout(timeout).build()?;
    call_with(&client, port, cmd, &args, &opts).map_err(|e| explain_timeout(e, cmd, timeout))
}

/// Turn a bare reqwest timeout into an error that says what to do.
fn explain_timeout(err: anyhow::Error, cmd: &str, timeout: Option<Duration>) -> anyhow::Error {
    let timed_out = err.downcast_ref::<reqwest::Error>().map(|e| e.is_timeout()).unwrap_or(false);
    match (timed_out, timeout) {
        (true, Some(t)) => anyhow!(RpcError {
            message: format!("daemon did not answer `{cmd}` within {}s", t.as_secs()),
            exit_code: Some(4),
            hint: Some(
                "the page may be stuck on a dialog or a promise that never settles; the command \
                 may still be running. Raise the limit with GHAX_RPC_TIMEOUT=<seconds> (0 = none)."
                    .into(),
            ),
        }),
        _ => err,
    }
}

/// One retry for a transport hiccup (post-spawn warm-up, GC pause,
/// mid-reload), gated by the verb's retry class. Semantic errors (the daemon
/// answered ok:false) are never retried: the command ran and failed.
fn call_with(
    client: &reqwest::blocking::Client,
    port: u16,
    cmd: &str,
    args: &Value,
    opts: &Value,
) -> Result<Value> {
    match call_once(client, port, cmd, args, opts) {
        Ok(v) => Ok(v),
        Err(e) if should_retry(&e, retry_class(cmd)) => {
            std::thread::sleep(std::time::Duration::from_millis(50));
            call_once(client, port, cmd, args, opts)
        }
        Err(e) => Err(e),
    }
}

fn call_once(
    client: &reqwest::blocking::Client,
    port: u16,
    cmd: &str,
    args: &Value,
    opts: &Value,
) -> Result<Value> {
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

/// A daemon-side semantic failure (`RpcError`) is never retried. A transport
/// failure is retried when the class allows it: Idempotent on any connect,
/// timeout, or request error; Mutating only when the connect itself failed.
/// A timeout or a reset after the request was written is exactly the case
/// where a click may have landed with its reply lost.
fn should_retry(err: &anyhow::Error, class: RetryClass) -> bool {
    if err.downcast_ref::<RpcError>().is_some() {
        return false;
    }
    let Some(re) = err.downcast_ref::<reqwest::Error>() else {
        return false;
    };
    match class {
        RetryClass::Idempotent => re.is_connect() || re.is_timeout() || re.is_request(),
        RetryClass::Mutating => re.is_connect(),
    }
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
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    #[test]
    fn retry_classes() {
        for cmd in ["status", "tabs", "snapshot", "text", "bridge.stats", "ext.sw.logs"] {
            assert_eq!(retry_class(cmd), RetryClass::Idempotent, "{cmd}");
        }
        for cmd in ["click", "fill", "goto", "eval", "batch", "box", "press", "brand-new-verb"] {
            assert_eq!(retry_class(cmd), RetryClass::Mutating, "{cmd}");
        }
    }

    #[test]
    fn rpc_error_is_never_retried() {
        let err = anyhow!(RpcError { message: "nope".into(), exit_code: Some(4), hint: None });
        assert!(!should_retry(&err, RetryClass::Idempotent));
        assert!(!should_retry(&err, RetryClass::Mutating));
    }

    #[test]
    fn refused_connection_is_retried_even_for_a_mutation() {
        // Nothing listens on port 1, so the request provably never landed.
        let client = reqwest::blocking::Client::new();
        let err = call_once(&client, 1, "click", &json!([]), &json!({})).unwrap_err();
        assert!(should_retry(&err, RetryClass::Mutating), "{err:?}");
        assert!(should_retry(&err, RetryClass::Idempotent), "{err:?}");
    }

    /// A daemon that reads the request and never answers: the CLI times out
    /// after the command was delivered. Returns (port, connections accepted).
    fn silent_daemon() -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(AtomicUsize::new(0));
        let counter = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                counter.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut buf = [0u8; 4096];
                    while let Ok(n) = stream.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                    }
                });
            }
        });
        (port, seen)
    }

    #[test]
    fn timeouts_default_env_own_and_unbounded() {
        let none = json!({});
        assert_eq!(timeout_for("click", &none, None), Some(Duration::from_secs(120)));
        assert_eq!(timeout_for("eval", &none, Some("5")), Some(Duration::from_secs(5)));
        assert_eq!(timeout_for("eval", &none, Some("0")), None);
        assert_eq!(timeout_for("eval", &none, Some("junk")), Some(Duration::from_secs(120)));
        for cmd in ["perf", "profile", "batch", "ext.hot-reload"] {
            assert_eq!(timeout_for(cmd, &none, None), None, "{cmd}");
        }
        let own = json!({ "timeout": "600000" });
        assert_eq!(timeout_for("wait", &own, None), Some(Duration::from_secs(630)));
        let own_ms = json!({ "timeoutMs": 45000 });
        assert_eq!(timeout_for("bridge.reload", &own_ms, Some("1")), Some(Duration::from_secs(75)));
    }

    #[test]
    fn a_timed_out_mutation_is_not_retried_and_says_why() {
        let (port, seen) = silent_daemon();
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        let err = call_with(&client, port, "fill", &json!(["@e1", "x"]), &json!({})).unwrap_err();
        assert!(err.downcast_ref::<reqwest::Error>().map(|e| e.is_timeout()).unwrap_or(false));
        assert_eq!(seen.load(Ordering::SeqCst), 1, "a timed-out fill must not be re-sent");
        let explained = explain_timeout(err, "fill", Some(Duration::from_millis(200)));
        let rpc = explained.downcast_ref::<RpcError>().expect("typed timeout error");
        assert!(rpc.message.contains("did not answer `fill`"), "{}", rpc.message);
        assert!(rpc.hint.as_deref().unwrap_or("").contains("GHAX_RPC_TIMEOUT"));
    }

    #[test]
    fn a_mutation_is_sent_once_when_the_reply_is_lost() {
        let (port, seen) = silent_daemon();
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        let err = call_with(&client, port, "click", &json!(["@e1"]), &json!({})).unwrap_err();
        assert!(!should_retry(&err, RetryClass::Mutating), "{err:?}");
        assert_eq!(seen.load(Ordering::SeqCst), 1, "click must not be re-sent");
    }

    #[test]
    fn a_read_is_retried_once_when_the_reply_is_lost() {
        let (port, seen) = silent_daemon();
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        let _ = call_with(&client, port, "tabs", &json!([]), &json!({})).unwrap_err();
        assert_eq!(seen.load(Ordering::SeqCst), 2, "tabs gets exactly one retry");
    }

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
