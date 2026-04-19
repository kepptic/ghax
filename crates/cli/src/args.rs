//! Hand-rolled argv parser matching `parseArgs` in `src/cli.ts`.
//!
//! Behaviour preserved exactly:
//!   --foo=bar        →  flags["foo"] = "bar"
//!   --foo bar        →  flags["foo"] = "bar"   (when next token doesn't start with '-')
//!   --foo            →  flags["foo"] = true
//!   -x               →  flags["x"]   = true    (single short, always boolean)
//!   <token>          →  positional
//!
//! Snapshot has its own short-flag expansion table; that lives in dispatch.rs.

use serde_json::{Map, Value};

#[derive(Debug, Default, Clone)]
pub struct Parsed {
    pub positional: Vec<String>,
    pub flags: Map<String, Value>, // string-or-bool, kept as JSON for direct passthrough
    // Phase 2 verbs (`qa`, `ship`) re-scan the original argv to recover repeated
    // flags like --url=a --url=b that get squashed into a single key by parse().
    #[allow(dead_code)]
    pub raw: Vec<String>,
}

impl Parsed {
    /// Strip presentation-only flags (currently `json`) and return the remainder
    /// as the daemon `opts` payload.
    pub fn opts_without_json(&self) -> Value {
        let mut m = self.flags.clone();
        m.remove("json");
        Value::Object(m)
    }

    pub fn json(&self) -> bool {
        matches!(self.flags.get("json"), Some(Value::Bool(true)))
    }

    pub fn positional_value(&self) -> Value {
        Value::Array(self.positional.iter().cloned().map(Value::String).collect())
    }
}

pub fn parse(argv: &[String]) -> Parsed {
    let mut positional = Vec::new();
    let mut flags = Map::new();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if let Some(rest) = a.strip_prefix("--") {
            if let Some(eq) = rest.find('=') {
                let key = &rest[..eq];
                let val = &rest[eq + 1..];
                flags.insert(key.to_string(), Value::String(val.to_string()));
            } else {
                let key = rest;
                if let Some(next) = argv.get(i + 1) {
                    if !next.starts_with('-') {
                        flags.insert(key.to_string(), Value::String(next.clone()));
                        i += 2;
                        continue;
                    }
                }
                flags.insert(key.to_string(), Value::Bool(true));
            }
        } else if a.starts_with('-') && a.len() == 2 {
            let key = &a[1..];
            flags.insert(key.to_string(), Value::Bool(true));
        } else {
            positional.push(a.clone());
        }
        i += 1;
    }
    Parsed { positional, flags, raw: argv.to_vec() }
}

/// Snapshot's short→long flag map, ported from `SNAPSHOT_SHORT` in cli.ts.
pub fn parse_snapshot(argv: &[String]) -> Parsed {
    let mut positional = Vec::new();
    let mut flags = Map::new();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if let Some(rest) = a.strip_prefix("--") {
            if let Some(eq) = rest.find('=') {
                flags.insert(rest[..eq].to_string(), Value::String(rest[eq + 1..].to_string()));
            } else {
                let key = rest.to_string();
                if let Some(next) = argv.get(i + 1) {
                    if !next.starts_with('-') {
                        flags.insert(key, Value::String(next.clone()));
                        i += 2;
                        continue;
                    }
                }
                flags.insert(key, Value::Bool(true));
            }
        } else if a.starts_with('-') && a.len() == 2 {
            let short = &a[1..];
            let long = match short {
                "i" => "interactive",
                "c" => "compact",
                "d" => "depth",
                "s" => "selector",
                "C" => "cursorInteractive",
                "a" => "annotate",
                "o" => "output",
                other => other,
            };
            if matches!(long, "depth" | "selector" | "output") {
                let next = argv.get(i + 1).cloned().unwrap_or_default();
                flags.insert(long.to_string(), Value::String(next));
                i += 2;
                continue;
            }
            flags.insert(long.to_string(), Value::Bool(true));
        } else {
            positional.push(a.clone());
        }
        i += 1;
    }
    Parsed { positional, flags, raw: argv.to_vec() }
}
