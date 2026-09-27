//! Hand-rolled argv parser matching `parseArgs` in `src/cli.ts`.
//!
//! Behaviour preserved exactly:
//!   --foo=bar        →  flags["foo"] = "bar"
//!   --foo bar        →  flags["foo"] = "bar"   (when next token doesn't start with '-')
//!   --foo            →  flags["foo"] = true
//!   -x               →  flags["x"]   = true    (single short, always boolean)
//!   <token>          →  positional
//!   --               →  end of flags: every later token is positional, so
//!                       `ghax eval -- '--x'` can pass a value that starts
//!                       with dashes
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
        if a == "--" {
            positional.extend(argv[i + 1..].iter().cloned());
            break;
        }
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

/// Split off the global `--trace` flag. Only tokens before a `--`
/// terminator count; `--trace=...` and anything after `--` are left for the
/// verb. `args::parse` never consumes a dash-led token as another flag's
/// value, so a `--trace` token here is never an option value.
pub fn take_trace(rest: &[String]) -> (bool, Vec<String>) {
    let end = rest.iter().position(|a| a == "--").unwrap_or(rest.len());
    let traced = rest[..end].iter().any(|a| a == "--trace");
    if !traced {
        return (false, rest.to_vec());
    }
    let mut out: Vec<String> = rest[..end].iter().filter(|a| *a != "--trace").cloned().collect();
    out.extend(rest[end..].iter().cloned());
    (true, out)
}

/// Snapshot's short→long flag map, ported from `SNAPSHOT_SHORT` in cli.ts.
pub fn parse_snapshot(argv: &[String]) -> Parsed {
    let mut positional = Vec::new();
    let mut flags = Map::new();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if a == "--" {
            positional.extend(argv[i + 1..].iter().cloned());
            break;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn trace_is_taken_as_a_flag_anywhere_before_the_terminator() {
        assert_eq!(take_trace(&v(&["@e3", "--trace"])), (true, v(&["@e3"])));
        assert_eq!(take_trace(&v(&["--trace", "@e3", "x"])), (true, v(&["@e3", "x"])));
        assert_eq!(take_trace(&v(&["@e3", "x"])), (false, v(&["@e3", "x"])));
    }

    #[test]
    fn trace_after_the_terminator_is_a_value() {
        assert_eq!(take_trace(&v(&["--", "--trace"])), (false, v(&["--", "--trace"])));
        assert_eq!(take_trace(&v(&["--trace", "--", "--trace"])), (true, v(&["--", "--trace"])));
        let p = parse(&v(&["--", "--trace"]));
        assert_eq!(p.positional, v(&["--trace"]));
        assert!(p.flags.is_empty());
    }

    #[test]
    fn trace_with_a_value_form_is_left_alone() {
        assert_eq!(take_trace(&v(&["--trace=1"])), (false, v(&["--trace=1"])));
    }

    #[test]
    fn terminator_makes_dash_values_positional() {
        let p = parse(&v(&["@e3", "--json", "--", "--not-a-flag", "-x"]));
        assert_eq!(p.positional, v(&["@e3", "--not-a-flag", "-x"]));
        assert!(p.json());
        let s = parse_snapshot(&v(&["-i", "--", "-s"]));
        assert_eq!(s.positional, v(&["-s"]));
        assert!(s.flags.contains_key("interactive"));
    }
}
