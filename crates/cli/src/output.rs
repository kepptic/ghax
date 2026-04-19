//! Result rendering. Byte-equivalent with the TS `printResult` for the parity test.
//!
//! Rules (in order):
//!   --json           → pretty JSON, two-space indent
//!   null/undefined   → no output
//!   string           → println as-is
//!   number/boolean   → println of canonical form
//!   array            → one line per item; strings raw, others as compact JSON
//!   {text, ...}      → println text, then annotatedPath note to stderr if present
//!   anything else    → pretty JSON, two-space indent
//!
//! Broken-pipe handling: when stdout is closed (e.g. piped into `head`), Rust
//! panics by default. We catch it and exit silently like Bun does.

use serde_json::Value;
use std::io::{self, Write};

const SIGPIPE_EXIT: i32 = 141;

pub fn print(data: &Value, json: bool) {
    if let Err(e) = try_print(data, json) {
        if e.kind() == io::ErrorKind::BrokenPipe {
            std::process::exit(SIGPIPE_EXIT);
        }
        eprintln!("ghax: write failed: {e}");
        std::process::exit(1);
    }
}

fn try_print(data: &Value, json: bool) -> io::Result<()> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(data).unwrap_or_else(|_| "null".into()))?;
        return Ok(());
    }
    match data {
        Value::Null => {}
        Value::String(s) => writeln!(out, "{s}")?,
        Value::Bool(b) => writeln!(out, "{b}")?,
        Value::Number(n) => writeln!(out, "{n}")?,
        Value::Array(arr) => {
            for item in arr {
                match item {
                    Value::String(s) => writeln!(out, "{s}")?,
                    other => writeln!(out, "{}", serde_json::to_string(other).unwrap_or_default())?,
                }
            }
        }
        Value::Object(obj) => {
            if let Some(Value::String(text)) = obj.get("text") {
                writeln!(out, "{text}")?;
                if let Some(Value::String(p)) = obj.get("annotatedPath") {
                    eprintln!("\n(annotated screenshot → {p})");
                }
                return Ok(());
            }
            writeln!(out, "{}", serde_json::to_string_pretty(data).unwrap_or_else(|_| "{}".into()))?;
        }
    }
    Ok(())
}
