//! `ghax auth export` — write a Playwright storageState file (cookies for an
//! allow-listed set of domains, plus localStorage for open origins) so a
//! headless suite can reuse the operator's real login.
//!
//! The daemon reads the browser AND writes the file (src/auth-export.ts), so
//! session values never come back over the RPC socket and this process never
//! holds them. The CLI's jobs are the parts only it can do right: resolve a
//! relative `--out` against the operator's cwd (the daemon's cwd is wherever
//! it was spawned), and gather repeated `--domain` / `--origin` flags that
//! `args::parse` squashes into one key. The reply is metadata only.

use crate::args::Parsed;
use crate::dispatch::{EXIT_OK, EXIT_USAGE};
use crate::output;
use crate::qa::collect_repeated_flag;
use crate::rpc;
use crate::state::{self, Config};
use anyhow::Result;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

const USAGE: &str =
    "Usage: ghax auth export --out <path> --domain <d>[,<d>...] [--origin <url>...] [--force]";

pub fn cmd_auth(cfg: &Config, parsed: &Parsed) -> Result<i32> {
    if parsed.positional.first().map(String::as_str) != Some("export") {
        eprintln!("{USAGE}");
        return Ok(EXIT_USAGE);
    }
    let Some(opts) = build_opts(parsed, &std::env::current_dir()?) else {
        eprintln!("{USAGE}");
        return Ok(EXIT_USAGE);
    };
    let port = state::require_daemon(cfg)?;
    let data = rpc::call(port, "auth.export", Value::Array(vec![]), opts)?;
    output::print(&data, parsed.json());
    Ok(EXIT_OK)
}

/// The RPC opts, or None when --out or --domain is missing or valueless.
/// The daemon re-validates everything (domains, origins, path); this only
/// refuses what would otherwise send a meaningless request.
fn build_opts(parsed: &Parsed, cwd: &Path) -> Option<Value> {
    let out = match parsed.flags.get("out") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return None,
    };
    let domains = repeated(parsed, "domain");
    if domains.is_empty() {
        return None;
    }
    let mut m = Map::new();
    m.insert("out".into(), Value::String(absolute(&out, cwd)));
    m.insert("domain".into(), Value::Array(domains));
    let origins = repeated(parsed, "origin");
    if !origins.is_empty() {
        m.insert("origin".into(), Value::Array(origins));
    } else if parsed.flags.get("origin") == Some(&Value::Bool(true)) {
        // `--origin` with no value: let the daemon name the problem.
        m.insert("origin".into(), Value::Bool(true));
    }
    if parsed.flags.get("force") == Some(&Value::Bool(true)) {
        m.insert("force".into(), Value::Bool(true));
    }
    Some(Value::Object(m))
}

fn repeated(parsed: &Parsed, flag: &str) -> Vec<Value> {
    collect_repeated_flag(&parsed.raw, flag)
        .into_iter()
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.to_string()))
        .collect()
}

fn absolute(out: &str, cwd: &Path) -> String {
    let expanded = match out.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME").map(|h| PathBuf::from(h).join(rest)),
        None => None,
    };
    let p = expanded.unwrap_or_else(|| PathBuf::from(out));
    let abs = if p.is_absolute() { p } else { cwd.join(p) };
    abs.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::parse;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn out_and_domain_are_required() {
        let cwd = Path::new("/work");
        assert!(build_opts(&parse(&v(&["export", "--domain", "a.com"])), cwd).is_none());
        assert!(build_opts(&parse(&v(&["export", "--out", "x.json"])), cwd).is_none());
        assert!(build_opts(&parse(&v(&["export", "--out", "--domain", "a.com"])), cwd).is_none());
    }

    #[test]
    fn relative_out_resolves_against_cwd_and_flags_repeat() {
        let p = parse(&v(&[
            "export",
            "--out",
            "state/auth.json",
            "--domain",
            "a.com,b.com",
            "--domain=c.com",
            "--origin",
            "https://app.a.com",
            "--origin=https://b.com",
            "--force",
        ]));
        let o = build_opts(&p, Path::new("/work")).unwrap();
        assert_eq!(o["out"], "/work/state/auth.json");
        assert_eq!(o["domain"], serde_json::json!(["a.com,b.com", "c.com"]));
        assert_eq!(
            o["origin"],
            serde_json::json!(["https://app.a.com", "https://b.com"])
        );
        assert_eq!(o["force"], true);
    }

    #[test]
    fn absolute_out_is_kept() {
        let p = parse(&v(&["export", "--out", "/tmp/a.json", "--domain", "a.com"]));
        let o = build_opts(&p, Path::new("/work")).unwrap();
        assert_eq!(o["out"], "/tmp/a.json");
        assert!(o.get("force").is_none());
    }
}
