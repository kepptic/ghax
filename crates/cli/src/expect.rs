//! `ghax expect` and the plumbing the plan runners (batch, chain, replay)
//! share for it: the failed-assertion exit code and the `--report` file.
//!
//! The checks themselves run in the daemon (`src/expect.ts`). A failed check
//! comes back as a result `{ok: false, ...}`, not as an RPC error, so the
//! structured `{expect, expected, actual, elapsedMs}` survives to the caller.

use crate::args::{self, Parsed};
use crate::dispatch::{EXIT_ASSERT, EXIT_CDP_ERROR, EXIT_NOT_ATTACHED, EXIT_OK, EXIT_USAGE};
use crate::output;
use crate::rpc;
use crate::state::{self, Config};
use anyhow::Result;
use serde_json::{json, Map, Value};
use std::time::Instant;

/// A failed expect found in an RPC reply.
#[derive(Debug, PartialEq)]
pub struct ExpectFail {
    /// `EXPECT_FAILED` (the page did not match) or `EXPECT_ERROR` (the check
    /// could not be made, e.g. the bridge dropped).
    pub code: &'static str,
    pub message: String,
    /// The object that carries expect/expected/actual/elapsedMs.
    detail: Value,
}

impl ExpectFail {
    pub fn exit(&self) -> i32 {
        if self.code == "EXPECT_ERROR" {
            EXIT_CDP_ERROR
        } else {
            EXIT_ASSERT
        }
    }
}

fn code_of(v: &Value) -> Option<&'static str> {
    match v.get("code").and_then(|c| c.as_str()) {
        Some("EXPECT_FAILED") => Some("EXPECT_FAILED"),
        Some("EXPECT_ERROR") => Some("EXPECT_ERROR"),
        _ => None,
    }
}

/// The failed expect in `data` (the reply to RPC `cmd`), if any: an `expect`
/// result with `ok: false`, or a `batch` result array with a step carrying
/// code `EXPECT_FAILED` / `EXPECT_ERROR` (nested batches carry it up).
pub fn failed_expect(cmd: &str, data: &Value) -> Option<ExpectFail> {
    match cmd {
        "expect" if data.get("ok").and_then(|v| v.as_bool()) == Some(false) => Some(ExpectFail {
            code: code_of(data).unwrap_or("EXPECT_FAILED"),
            message: data
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("expect failed")
                .to_string(),
            detail: data.clone(),
        }),
        "batch" => data.as_array()?.iter().find_map(|r| {
            code_of(r).map(|code| ExpectFail {
                code,
                message: r
                    .get("error")
                    .and_then(|m| m.as_str())
                    .unwrap_or("expect failed")
                    .to_string(),
                detail: r.clone(),
            })
        }),
        _ => None,
    }
}

/// A plan step's failed expect, shaped like the daemon's batch entry.
pub fn failed_expect_entry(cmd: &str, step: usize, f: &ExpectFail) -> Value {
    let d = &f.detail;
    let get = |k: &str| d.get(k).cloned().unwrap_or(Value::Null);
    json!({
        "cmd": cmd,
        "ok": false,
        "code": f.code,
        "error": f.message,
        "step": step,
        "expect": get("expect"),
        "expected": get("expected"),
        "actual": get("actual"),
        "elapsedMs": get("elapsedMs"),
    })
}

/// `--report` with no path is a usage error, not a silent no-op.
fn report_path(flags: &Map<String, Value>) -> Result<Option<String>, String> {
    match flags.get("report") {
        Some(Value::String(p)) if !p.is_empty() => Ok(Some(p.clone())),
        Some(_) => Err("--report needs a file path".to_string()),
        None => Ok(None),
    }
}

/// `--report <path>`: a JSON file with one entry per step that ran.
pub struct Report {
    path: Option<String>,
    steps: Vec<Value>,
    started: Instant,
}

impl Report {
    /// Err carries the exit code to return after the usage message is printed.
    pub fn from_flags(parsed: &Parsed) -> Result<Self, i32> {
        let path = report_path(&parsed.flags).map_err(|m| {
            eprintln!("ghax: {m}");
            EXIT_USAGE
        })?;
        Ok(Report {
            path,
            steps: Vec::new(),
            started: Instant::now(),
        })
    }

    /// Record a step this CLI ran itself (chain, replay, expect).
    pub fn push(
        &mut self,
        cmd: &str,
        ok: bool,
        ms: u128,
        data: Option<&Value>,
        error: Option<&str>,
    ) {
        let mut e = Map::new();
        e.insert("step".into(), json!(self.steps.len()));
        e.insert("cmd".into(), json!(cmd));
        e.insert("ok".into(), json!(ok));
        e.insert("ms".into(), json!(ms as u64));
        if cmd == "expect" {
            if let Some(d) = data {
                for k in ["expect", "expected", "actual"] {
                    if let Some(v) = d.get(k) {
                        e.insert(k.into(), v.clone());
                    }
                }
            }
        }
        if let Some(m) = error {
            e.insert("error".into(), json!(m));
        }
        self.steps.push(Value::Object(e));
    }

    /// Record the steps of a daemon `batch` reply.
    pub fn push_batch(&mut self, results: &Value) {
        let Some(arr) = results.as_array() else {
            return;
        };
        for r in arr {
            let cmd = r.get("cmd").and_then(|c| c.as_str()).unwrap_or("?");
            let ok = r.get("ok").and_then(|v| v.as_bool()) == Some(true);
            let ms = r.get("ms").and_then(|v| v.as_u64()).unwrap_or(0) as u128;
            let data = if ok { r.get("data") } else { Some(r) };
            let err = r.get("error").and_then(|m| m.as_str());
            self.push(cmd, ok, ms, data, err);
        }
    }

    /// Write the file. A failure to write warns but never changes the exit code.
    pub fn write(&self, exit: i32) {
        let Some(path) = &self.path else { return };
        let ok = exit == EXIT_OK;
        let body = json!({
            "ok": ok,
            "exit": exit,
            "totalMs": self.started.elapsed().as_millis() as u64,
            "steps": self.steps,
        });
        let text = serde_json::to_string_pretty(&body).unwrap_or_default();
        if let Err(e) = std::fs::write(path, format!("{text}\n")) {
            eprintln!("ghax: cannot write report {path}: {e}");
        }
    }
}

/// `ghax expect --url <re> | --title <re> | --text <s> [--selector <css>] |
/// --visible <t> | --hidden <t> | --count <css> --n N | --value <t> --expected <s> |
/// --eval <js>  [--timeout ms] [--report path]`. Exit 1 when the check fails.
pub fn cmd_expect(cfg: &Config, rest: &[String]) -> Result<i32> {
    let parsed = args::parse(rest);
    let mut report = match Report::from_flags(&parsed) {
        Ok(r) => r,
        Err(c) => return Ok(c),
    };
    let mut opts = parsed.opts_without_json();
    if let Value::Object(m) = &mut opts {
        m.remove("report");
    }
    if opts.as_object().map(|m| m.is_empty()).unwrap_or(true) {
        eprintln!("Usage: ghax expect --url <regex> | --title <regex> | --text <substring> [--selector <css>] |");
        eprintln!(
            "                   --visible <@ref|css> | --hidden <@ref|css> | --count <css> --n N |"
        );
        eprintln!("                   --value <@ref|css> --expected <text> | --eval <js>   [--timeout ms]");
        return Ok(EXIT_USAGE);
    }

    let port = match state::require_daemon(cfg) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ghax: {e}");
            return Ok(EXIT_NOT_ATTACHED);
        }
    };

    let t = Instant::now();
    let data = match rpc::call(port, "expect", Value::Array(vec![]), opts) {
        Ok(d) => d,
        Err(err) => {
            report.push(
                "expect",
                false,
                t.elapsed().as_millis(),
                None,
                Some(&err.to_string()),
            );
            let code = err
                .downcast_ref::<rpc::RpcError>()
                .and_then(|e| e.exit_code)
                .unwrap_or(crate::dispatch::EXIT_CDP_ERROR);
            report.write(code);
            return Err(err);
        }
    };
    output::print(&data, true);
    let failed = failed_expect("expect", &data);
    report.push(
        "expect",
        failed.is_none(),
        t.elapsed().as_millis(),
        Some(&data),
        failed.as_ref().map(|f| f.message.as_str()),
    );
    let code = if let Some(f) = &failed {
        eprintln!("ghax: {}", f.message);
        f.exit()
    } else {
        EXIT_OK
    };
    report.write(code);
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_expect_reads_both_shapes() {
        let ok = json!({ "ok": true, "expect": "url" });
        let bad = json!({ "ok": false, "message": "expect url failed" });
        assert_eq!(failed_expect("expect", &ok), None);
        assert_eq!(
            failed_expect("expect", &bad).map(|f| (f.code, f.exit())),
            Some(("EXPECT_FAILED", EXIT_ASSERT))
        );
        // A plain failure (not an assertion) is not an expect failure.
        let batch = json!([
            { "cmd": "click", "ok": false, "error": "boom" },
            { "cmd": "expect", "ok": false, "code": "EXPECT_FAILED", "error": "nope" },
        ]);
        assert_eq!(failed_expect("batch", &batch).unwrap().message, "nope");
        assert_eq!(
            failed_expect(
                "batch",
                &json!([{ "cmd": "click", "ok": false, "error": "boom" }])
            ),
            None
        );
        assert_eq!(failed_expect("click", &bad), None);
    }

    #[test]
    fn expect_error_maps_to_exit_4_everywhere() {
        let err = json!({ "ok": false, "code": "EXPECT_ERROR", "message": "bridge gone" });
        let f = failed_expect("expect", &err).unwrap();
        assert_eq!((f.code, f.exit()), ("EXPECT_ERROR", EXIT_CDP_ERROR));
        let batch = json!([{ "cmd": "expect", "ok": false, "code": "EXPECT_ERROR", "error": "bridge gone" }]);
        assert_eq!(failed_expect("batch", &batch).unwrap().exit(), 4);
        // A nested batch entry carries the code at its top level.
        let nested = json!([{ "cmd": "batch", "ok": false, "code": "EXPECT_FAILED", "error": "no", "data": [] }]);
        let f = failed_expect("batch", &nested).unwrap();
        assert_eq!(f.exit(), 1);
        let e = failed_expect_entry("batch", 3, &f);
        assert_eq!((e["cmd"].as_str(), e["code"].as_str(), e["step"].as_u64()), (Some("batch"), Some("EXPECT_FAILED"), Some(3)));
    }

    #[test]
    fn bare_report_is_a_usage_error() {
        let flags = |argv: &[&str]| args::parse(&argv.iter().map(|s| s.to_string()).collect::<Vec<_>>()).flags;
        assert_eq!(report_path(&flags(&["--report"])), Err("--report needs a file path".into()));
        assert_eq!(report_path(&flags(&["--report", "--timeout", "5"])), Err("--report needs a file path".into()));
        assert_eq!(report_path(&flags(&["--report", "/x.json"])), Ok(Some("/x.json".into())));
        assert_eq!(report_path(&flags(&[])), Ok(None));
        let p = args::parse(&["--report".to_string()]);
        assert_eq!(Report::from_flags(&p).err(), Some(EXIT_USAGE));
    }

    #[test]
    fn report_collects_batch_steps_with_actuals() {
        let mut r = Report {
            path: None,
            steps: vec![],
            started: Instant::now(),
        };
        r.push_batch(&json!([
            { "cmd": "goto", "ok": true, "ms": 12, "data": null },
            { "cmd": "expect", "ok": true, "ms": 40, "data": { "expect": "url", "actual": "http://x/dash" } },
            { "cmd": "expect", "ok": false, "ms": 5000, "code": "EXPECT_FAILED", "error": "no", "expect": "text", "actual": "hi" },
        ]));
        assert_eq!(r.steps.len(), 3);
        assert_eq!(r.steps[1]["actual"], "http://x/dash");
        assert_eq!(r.steps[2]["ok"], false);
        assert_eq!(r.steps[2]["actual"], "hi");
        assert_eq!(r.steps[2]["ms"], 5000);
    }
}
