//! `ghax shortcut` — named, parameterised plans saved under
//! `~/.ghax/shortcuts/<name>.json` (override: `GHAX_SHORTCUTS_DIR`).
//!
//! A shortcut is a recording (`{cmd, args?, opts?}` steps) plus `${var}`
//! placeholders in the string leaves of `args` and `opts`. `shortcut run`
//! substitutes them and hands the steps to `small::run_steps`, the same loop
//! `replay` uses. No daemon change: it is plain RPCs.
//!
//!   shortcut save <name> <file> [--var k=default]... [--desc <text>] [--force]
//!   shortcut list | show <name> | rm <name>
//!   shortcut run <name> [--var k=v]... [--report <path>] [--dry-run]
//!
//! `${k}` is a placeholder, `$${k}` is a literal `${k}`. Placeholders are
//! never substituted in `cmd`, and a missing value exits `EXIT_USAGE` before
//! any RPC is sent.

use crate::args::{self, Parsed};
use crate::dispatch::{EXIT_CDP_ERROR, EXIT_NOT_ATTACHED, EXIT_OK, EXIT_USAGE};
use crate::expect::Report;
use crate::qa::collect_repeated_flag;
use crate::small::{parse_steps, run_steps};
use crate::state::{self, Config};
use crate::time_util::iso_now;
use anyhow::Result;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

const USAGE: &str =
    "Usage: ghax shortcut save <name> <file> [--var k=default]... [--desc <text>] [--force]
       ghax shortcut list [--json] | show <name> | rm <name>
       ghax shortcut run <name> [--var k=v]... [--report <path>] [--dry-run]";

/// Steps a shortcut may not hold: the daemon's `NEVER_RECORD` set
/// (`src/record-filter.ts`). A unit test keeps the two lists in step.
const NEVER_SAVE: &[&str] = &[
    "record.start",
    "record.stop",
    "record.status",
    "status",
    "health",
    "tabs",
    "console",
    "network",
    "cookies",
    "text",
    "html",
    "auth.export",
    "find",
    "is",
    "perf",
    "xpath",
    "box",
    "findEl",
];

pub fn cmd_shortcut(cfg: &Config, rest: &[String]) -> Result<i32> {
    // `--json` and `--dry-run` are switches; take them out first so the
    // parser cannot swallow the token after them as their value.
    let json = rest.iter().any(|a| a == "--json");
    let dry_run = rest.iter().any(|a| a == "--dry-run");
    // `--force` is a switch of `save`: strip it before parsing so it cannot
    // swallow <name> or <file> as its value.
    let force = rest.first().is_some_and(|s| s == "save") && rest.iter().any(|a| a == "--force");
    let rest: Vec<String> = rest
        .iter()
        .filter(|a| *a != "--json" && *a != "--dry-run" && !(force && *a == "--force"))
        .cloned()
        .collect();
    let Some(sub) = rest.first() else {
        eprintln!("{USAGE}");
        return Ok(EXIT_USAGE);
    };
    let parsed = args::parse(&rest[1..]);
    match sub.as_str() {
        "save" => cmd_save(&parsed, force),
        "list" => cmd_list(json),
        "show" => cmd_show(&parsed),
        "rm" => cmd_rm(&parsed),
        "run" => cmd_run(cfg, &parsed, dry_run),
        other => {
            eprintln!("ghax shortcut: unknown subcommand '{other}'\n{USAGE}");
            Ok(EXIT_USAGE)
        }
    }
}

// ─── names and storage ───────────────────────────────────────────────────────

/// `^[a-z0-9][a-z0-9._-]{0,63}$`. Also what keeps a name from being a path.
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    let ok_first = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    ok_first
        && name.len() <= 64
        && chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

fn shortcuts_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("GHAX_SHORTCUTS_DIR") {
        return Some(PathBuf::from(dir));
    }
    state::home_dir().map(|h| h.join(".ghax").join("shortcuts"))
}

fn dir_or_err() -> Result<PathBuf, String> {
    shortcuts_dir()
        .ok_or_else(|| "cannot find a home directory — set GHAX_SHORTCUTS_DIR".to_string())
}

fn name_arg(parsed: &Parsed, what: &str) -> Result<String, i32> {
    let Some(name) = parsed.positional.first() else {
        eprintln!("ghax shortcut: {what} needs a <name>\n{USAGE}");
        return Err(EXIT_USAGE);
    };
    if !valid_name(name) {
        eprintln!(
            "ghax shortcut: invalid name '{name}' — use lowercase letters, digits, '.', '_' or '-' (max 64, starting with a letter or digit)"
        );
        return Err(EXIT_USAGE);
    }
    Ok(name.clone())
}

fn load(name: &str) -> Result<Value, String> {
    let path = shortcut_path(name)?;
    let body = std::fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("no shortcut named '{name}' (see 'ghax shortcut list')")
        } else {
            format!("cannot read {}: {e}", path.display())
        }
    })?;
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
    if v.get("version").and_then(|x| x.as_u64()) != Some(1) {
        return Err(format!(
            "{} has an unsupported version (this ghax reads version 1)",
            path.display()
        ));
    }
    if !v.get("steps").is_some_and(|s| s.is_array()) {
        return Err(format!("{} has no steps array", path.display()));
    }
    Ok(v)
}

/// True when the directory is ghax's own `~/.ghax/shortcuts`. A dir given
/// through `GHAX_SHORTCUTS_DIR` (a test hook) keeps whatever mode it has.
fn dir_is_default() -> bool {
    std::env::var_os("GHAX_SHORTCUTS_DIR").is_none()
}

fn shortcut_path(name: &str) -> Result<PathBuf, String> {
    Ok(dir_or_err()?.join(format!("{name}.json")))
}

/// Directory 0700 (the default dir is forced to 0700 even if it already
/// exists; an env-var dir keeps its mode unless we create it) and file 0600, written through an
/// exclusively created temp file so a planted symlink is never followed.
fn write_shortcut(name: &str, doc: &Value) -> Result<PathBuf, String> {
    let dir = dir_or_err()?;
    let fresh = !dir.exists();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    if fresh || dir_is_default() {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("cannot set mode 0700 on {}: {e}", dir.display()))?;
    }
    #[cfg(not(unix))]
    let _ = fresh;
    let path = dir.join(format!("{name}.json"));
    let body = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())? + "\n";
    write_private_atomic(&dir, name, &path, &body)?;
    Ok(path)
}

/// Unique, unpredictable-enough sibling name: pid + clock + counter.
fn tmp_path(dir: &std::path::Path, name: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    dir.join(format!(
        ".{name}.json.{}.{nanos:08x}.{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Create the temp file with O_EXCL (`create_new`, which also refuses to
/// follow a symlink at that path), 0600, write it, then rename over `path`.
/// The temp file is removed on any error after it was created.
fn write_private_atomic(
    dir: &std::path::Path,
    name: &str,
    path: &std::path::Path,
    body: &str,
) -> Result<(), String> {
    use std::io::Write as _;
    let tmp = tmp_path(dir, name);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    // Not ours until create_new succeeds, so a failure here removes nothing.
    let mut file = opts
        .open(&tmp)
        .map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
    let mut finish = || -> Result<(), String> {
        // The creation mode only applies to a new inode and is masked by the
        // umask; fchmod the open handle so 0600 is guaranteed.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("cannot set mode 0600 on {}: {e}", tmp.display()))?;
        }
        file.write_all(body.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("cannot write {}: {e}", path.display()))
    };
    let res = finish();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

// ─── placeholders ────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum Tok {
    Lit(String),
    Var(String),
}

/// `[A-Za-z_][A-Za-z0-9_]*`
fn is_ident(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `name}rest` with a plain identifier for `name` -> (name, rest).
fn split_ident(s: &str) -> Option<(&str, &str)> {
    let end = s.find('}')?;
    is_ident(&s[..end]).then(|| (&s[..end], &s[end + 1..]))
}

/// Split a string into literal text and `${name}` placeholders. `$${` yields
/// a literal `${`. A `${` that does not hold a plain identifier followed by
/// `}` (a JS template like `${a + b}`) stays literal text.
fn tokenize(s: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut lit = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('$') {
        lit.push_str(&rest[..i]);
        let tail = &rest[i..];
        if let Some(after) = tail.strip_prefix("$${") {
            lit.push_str("${");
            rest = after;
        } else if let Some((name, after)) = tail.strip_prefix("${").and_then(split_ident) {
            if !lit.is_empty() {
                out.push(Tok::Lit(std::mem::take(&mut lit)));
            }
            out.push(Tok::Var(name.to_string()));
            rest = after;
        } else {
            lit.push('$');
            rest = &tail[1..];
        }
    }
    lit.push_str(rest);
    if !lit.is_empty() {
        out.push(Tok::Lit(lit));
    }
    out
}

/// Apply `f` to every string leaf of the `args` and `opts` of a step,
/// recursing into the steps of a `batch`. `cmd` is never visited.
fn map_step_strings(step: &Value, f: &mut dyn FnMut(&str) -> String) -> Value {
    let Value::Object(obj) = step else {
        return step.clone();
    };
    let is_batch = obj.get("cmd").and_then(|c| c.as_str()) == Some("batch");
    let mut out = Map::new();
    for (k, v) in obj {
        let nv = match (k.as_str(), v) {
            ("args", Value::Array(a)) if is_batch => Value::Array(
                a.iter()
                    .enumerate()
                    .map(|(i, x)| match (i, x) {
                        (0, Value::Array(inner)) => {
                            Value::Array(inner.iter().map(|s| map_step_strings(s, f)).collect())
                        }
                        _ => map_leaves(x, f),
                    })
                    .collect(),
            ),
            ("args" | "opts", _) => map_leaves(v, f),
            _ => v.clone(),
        };
        out.insert(k.clone(), nv);
    }
    Value::Object(out)
}

fn map_leaves(v: &Value, f: &mut dyn FnMut(&str) -> String) -> Value {
    match v {
        Value::String(s) => Value::String(f(s)),
        Value::Array(a) => Value::Array(a.iter().map(|x| map_leaves(x, f)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), map_leaves(x, f)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Every `${name}` the steps refer to.
fn scan_vars(steps: &[Value]) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for step in steps {
        map_step_strings(step, &mut |s| {
            for t in tokenize(s) {
                if let Tok::Var(n) = t {
                    found.insert(n);
                }
            }
            String::new()
        });
    }
    found
}

/// The steps with every placeholder replaced; `$${` becomes a literal `${`.
/// Callers resolve first, so a name missing from `vars` is a bug here and
/// is returned in the Err rather than guessed.
fn substitute(steps: &[Value], vars: &BTreeMap<String, String>) -> Result<Vec<Value>, String> {
    let mut missing = BTreeSet::new();
    let out = steps
        .iter()
        .map(|step| {
            map_step_strings(step, &mut |s| {
                tokenize(s)
                    .into_iter()
                    .map(|t| match t {
                        Tok::Lit(l) => l,
                        Tok::Var(n) => match vars.get(&n) {
                            Some(v) => v.clone(),
                            None => {
                                missing.insert(n);
                                String::new()
                            }
                        },
                    })
                    .collect()
            })
        })
        .collect();
    if missing.is_empty() {
        Ok(out)
    } else {
        Err(format!(
            "no value for: {}",
            missing.into_iter().collect::<Vec<_>>().join(", ")
        ))
    }
}

/// The value of every variable of a shortcut: `--var` beats the stored
/// default. Variables come from the stored `vars` plus whatever the steps
/// reference (a hand-edited file may not list them).
fn resolve_vars(
    stored: &Map<String, Value>,
    scanned: &BTreeSet<String>,
    supplied: &[(String, String)],
) -> Result<BTreeMap<String, String>, String> {
    let names: BTreeSet<&String> = stored.keys().chain(scanned.iter()).collect();
    let unknown: Vec<&str> = supplied
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| !names.iter().any(|n| n.as_str() == *k))
        .collect();
    if !unknown.is_empty() {
        let known = names
            .iter()
            .map(|n| n.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "unknown --var {} (this shortcut takes: {})",
            unknown.join(", "),
            if known.is_empty() {
                "no variables"
            } else {
                &known
            }
        ));
    }
    let mut out = BTreeMap::new();
    let mut missing = Vec::new();
    for name in names {
        let given = supplied
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone());
        let default = stored
            .get(name)
            .and_then(|d| d.get("default"))
            .and_then(|d| d.as_str())
            .map(str::to_string);
        match given.or(default) {
            Some(v) => {
                out.insert(name.clone(), v);
            }
            None => missing.push(name.as_str()),
        }
    }
    if missing.is_empty() {
        Ok(out)
    } else {
        Err(format!(
            "missing value for {} — pass {}",
            missing.join(", "),
            missing
                .iter()
                .map(|m| format!("--var {m}=<value>"))
                .collect::<Vec<_>>()
                .join(" ")
        ))
    }
}

/// `--var k=v` pairs (repeatable). A bare `--var k` has no value.
fn var_pairs(parsed: &Parsed) -> Result<Vec<(String, Option<String>)>, String> {
    if matches!(parsed.flags.get("var"), Some(Value::Bool(true))) {
        return Err("--var needs k=value".to_string());
    }
    let mut out = Vec::new();
    for raw in collect_repeated_flag(&parsed.raw, "var") {
        let (k, v) = match raw.split_once('=') {
            Some((k, v)) => (k, Some(v.to_string())),
            None => (raw, None),
        };
        if !is_ident(k) {
            return Err(format!(
                "--var '{raw}': a variable name is letters, digits and '_', not starting with a digit"
            ));
        }
        out.push((k.to_string(), v));
    }
    Ok(out)
}

// ─── save-time checks ────────────────────────────────────────────────────────

/// `@e<n>` refs in string leaves, as (step index, cmd, ref). Refs do not
/// survive a navigation or a tab switch (invariant 3), so a saved one is
/// almost always dead on the next run.
fn find_refs(steps: &[Value]) -> Vec<(usize, String, String)> {
    let mut out = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        let cmd = step
            .get("cmd")
            .and_then(|c| c.as_str())
            .unwrap_or("?")
            .to_string();
        map_step_strings(step, &mut |s| {
            let b = s.as_bytes();
            let mut j = 0;
            while let Some(p) = s[j..].find("@e") {
                let at = j + p;
                let digits = b[at + 2..]
                    .iter()
                    .take_while(|c| c.is_ascii_digit())
                    .count();
                let before_ok = at == 0 || !b[at - 1].is_ascii_alphanumeric();
                let after_ok = b
                    .get(at + 2 + digits)
                    .map_or(true, |c| !c.is_ascii_alphanumeric());
                if digits > 0 && before_ok && after_ok {
                    out.push((i, cmd.clone(), s[at..at + 2 + digits].to_string()));
                }
                j = at + 2;
            }
            String::new()
        });
    }
    out
}

/// Commands in `steps` (including inside `batch`) that a shortcut refuses.
fn refused_cmds(steps: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    for step in steps {
        let cmd = step.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
        if NEVER_SAVE.contains(&cmd) {
            out.push(cmd.to_string());
        }
        if cmd == "batch" {
            if let Some(Value::Array(inner)) = step.get("args").and_then(|a| a.get(0)) {
                out.extend(refused_cmds(inner));
            }
        }
    }
    out
}

/// A step as stored: `cmd`, `args`, `opts` only (so a recording's `at` goes).
fn clean_step(step: &Value) -> Result<Value, String> {
    let cmd = step
        .get("cmd")
        .and_then(|c| c.as_str())
        .ok_or("a step has no `cmd` string")?;
    let mut m = Map::new();
    m.insert("cmd".into(), json!(cmd));
    if let Some(a) = step.get("args") {
        m.insert("args".into(), a.clone());
    }
    if let Some(o) = step.get("opts") {
        m.insert("opts".into(), o.clone());
    }
    Ok(Value::Object(m))
}

// ─── verbs ───────────────────────────────────────────────────────────────────

fn cmd_save(parsed: &Parsed, force: bool) -> Result<i32> {
    let name = match name_arg(parsed, "save") {
        Ok(n) => n,
        Err(c) => return Ok(c),
    };
    let Some(file) = parsed.positional.get(1) else {
        eprintln!("ghax shortcut: save needs a <file> (a recording or a steps array)\n{USAGE}");
        return Ok(EXIT_USAGE);
    };
    let desc = match parsed.flags.get("desc") {
        Some(Value::String(d)) => Some(d.clone()),
        Some(_) => {
            eprintln!("ghax shortcut: --desc needs text");
            return Ok(EXIT_USAGE);
        }
        None => None,
    };
    let body = match std::fs::read_to_string(file) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("ghax shortcut: cannot read {file}: {e}");
            return Ok(EXIT_USAGE);
        }
    };
    let raw_steps = match parse_steps(&body) {
        Ok(s) => s,
        Err(m) => {
            eprintln!("ghax shortcut: {m}");
            return Ok(EXIT_USAGE);
        }
    };
    let steps: Vec<Value> = match raw_steps.iter().map(clean_step).collect::<Result<_, _>>() {
        Ok(s) => s,
        Err(m) => {
            eprintln!("ghax shortcut: {m}");
            return Ok(EXIT_USAGE);
        }
    };
    if steps.is_empty() {
        eprintln!("ghax shortcut: {file} has no steps");
        return Ok(EXIT_USAGE);
    }
    let refused = refused_cmds(&steps);
    if !refused.is_empty() {
        let set: BTreeSet<_> = refused.into_iter().collect();
        eprintln!(
            "ghax shortcut: refusing to save {} — read-only or meta commands that a replay must not run (same list as 'record')",
            set.into_iter().collect::<Vec<_>>().join(", ")
        );
        return Ok(EXIT_USAGE);
    }
    let defaults = match var_pairs(parsed) {
        Ok(v) => v,
        Err(m) => {
            eprintln!("ghax shortcut: {m}");
            return Ok(EXIT_USAGE);
        }
    };

    let scanned = scan_vars(&steps);
    for (k, _) in &defaults {
        if !scanned.contains(k) {
            eprintln!(
                "ghax shortcut: warning: --var {k} is not used by any step (no ${{{k}}}); ignored"
            );
        }
    }
    let mut vars = Map::new();
    for v in &scanned {
        let default = defaults
            .iter()
            .rev()
            .find(|(k, _)| k == v)
            .and_then(|(_, d)| d.clone());
        let entry = match default {
            Some(d) => json!({ "default": d }),
            None => json!({ "required": true }),
        };
        vars.insert(v.clone(), entry);
    }

    for (i, cmd, r) in find_refs(&steps) {
        eprintln!(
            "ghax shortcut: warning: step {} ({cmd}) uses {r}; refs do not survive a navigation or tab switch. Use a CSS selector so the shortcut still works next run",
            i + 1
        );
    }

    let mut doc = Map::new();
    doc.insert("version".into(), json!(1));
    doc.insert("name".into(), json!(name));
    if let Some(d) = desc {
        doc.insert("description".into(), json!(d));
    }
    doc.insert("createdAt".into(), json!(iso_now()));
    doc.insert("source".into(), json!(file));
    doc.insert("vars".into(), Value::Object(vars));
    doc.insert("steps".into(), Value::Array(steps.clone()));
    let existing = match shortcut_path(&name) {
        Ok(p) => p,
        Err(m) => {
            eprintln!("ghax shortcut: {m}");
            return Ok(EXIT_USAGE);
        }
    };
    // symlink_metadata: a dangling symlink at the path counts as existing.
    // shortcut: check-then-rename, not atomic against a concurrent save of the
    // same name; upgrade to hard_link no-clobber if two writers ever matter.
    let replaced = if existing.symlink_metadata().is_ok() {
        if !force {
            eprintln!(
                "ghax shortcut: {} already exists — pass --force to replace it",
                existing.display()
            );
            return Ok(EXIT_USAGE);
        }
        Some(
            load(&name)
                .ok()
                .and_then(|v| v["steps"].as_array().map(Vec::len)),
        )
    } else {
        None
    };
    match write_shortcut(&name, &Value::Object(doc)) {
        Ok(path) => {
            if let Some(was) = replaced {
                match was {
                    Some(n) => println!("replaced shortcut {name} (was {n} steps)"),
                    None => println!("replaced shortcut {name} (previous file was unreadable)"),
                }
            }
            let var_list = scanned.iter().cloned().collect::<Vec<_>>().join(", ");
            println!(
                "saved shortcut {name} → {} ({} steps{})",
                path.display(),
                steps.len(),
                if var_list.is_empty() {
                    String::new()
                } else {
                    format!(", vars: {var_list}")
                }
            );
            Ok(EXIT_OK)
        }
        Err(m) => {
            eprintln!("ghax shortcut: {m}");
            Ok(EXIT_CDP_ERROR)
        }
    }
}

fn cmd_list(json: bool) -> Result<i32> {
    let dir = match dir_or_err() {
        Ok(d) => d,
        Err(m) => {
            eprintln!("ghax shortcut: {m}");
            return Ok(EXIT_USAGE);
        }
    };
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    e.file_name()
                        .to_str()
                        .and_then(|n| n.strip_suffix(".json"))
                        .map(str::to_string)
                })
                .filter(|n| valid_name(n))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let mut rows = Vec::new();
    for n in &names {
        match load(n) {
            Ok(v) => rows.push(json!({
                "name": n,
                "description": v.get("description").cloned().unwrap_or(Value::Null),
                "vars": v.get("vars").and_then(|x| x.as_object()).map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
                "steps": v.get("steps").and_then(|s| s.as_array()).map(|s| s.len()).unwrap_or(0),
            })),
            Err(m) => eprintln!("ghax shortcut: skipping {n}: {m}"),
        }
    }
    if json {
        crate::output::print(&Value::Array(rows), true);
        return Ok(EXIT_OK);
    }
    if rows.is_empty() {
        println!("no shortcuts in {}", dir.display());
    }
    for r in &rows {
        let vars: Vec<&str> = r["vars"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .collect();
        println!(
            "{}  {} steps{}{}",
            r["name"].as_str().unwrap_or(""),
            r["steps"],
            if vars.is_empty() {
                String::new()
            } else {
                format!("  vars: {}", vars.join(", "))
            },
            r["description"]
                .as_str()
                .map(|d| format!("  {d}"))
                .unwrap_or_default()
        );
    }
    Ok(EXIT_OK)
}

fn cmd_show(parsed: &Parsed) -> Result<i32> {
    let name = match name_arg(parsed, "show") {
        Ok(n) => n,
        Err(c) => return Ok(c),
    };
    match load(&name) {
        Ok(v) => {
            crate::output::print(&v, true);
            Ok(EXIT_OK)
        }
        Err(m) => {
            eprintln!("ghax shortcut: {m}");
            Ok(EXIT_USAGE)
        }
    }
}

fn cmd_rm(parsed: &Parsed) -> Result<i32> {
    let name = match name_arg(parsed, "rm") {
        Ok(n) => n,
        Err(c) => return Ok(c),
    };
    let dir = match dir_or_err() {
        Ok(d) => d,
        Err(m) => {
            eprintln!("ghax shortcut: {m}");
            return Ok(EXIT_USAGE);
        }
    };
    match std::fs::remove_file(dir.join(format!("{name}.json"))) {
        Ok(()) => {
            println!("removed shortcut {name}");
            Ok(EXIT_OK)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("ghax shortcut: no shortcut named '{name}'");
            Ok(EXIT_USAGE)
        }
        Err(e) => {
            eprintln!("ghax shortcut: cannot remove {name}: {e}");
            Ok(EXIT_CDP_ERROR)
        }
    }
}

fn cmd_run(cfg: &Config, parsed: &Parsed, dry_run: bool) -> Result<i32> {
    let name = match name_arg(parsed, "run") {
        Ok(n) => n,
        Err(c) => return Ok(c),
    };
    if parsed.positional.len() > 1 {
        eprintln!(
            "ghax shortcut: unexpected argument '{}' (pass variables as --var k=v)",
            parsed.positional[1]
        );
        return Ok(EXIT_USAGE);
    }
    let doc = match load(&name) {
        Ok(d) => d,
        Err(m) => {
            eprintln!("ghax shortcut: {m}");
            return Ok(EXIT_USAGE);
        }
    };
    let steps: Vec<Value> = doc["steps"].as_array().cloned().unwrap_or_default();
    let supplied = match var_pairs(parsed) {
        Ok(v) => v,
        Err(m) => {
            eprintln!("ghax shortcut: {m}");
            return Ok(EXIT_USAGE);
        }
    };
    let mut given = Vec::new();
    for (k, v) in supplied {
        match v {
            Some(v) => given.push((k, v)),
            None => {
                eprintln!("ghax shortcut: --var {k} needs a value (--var {k}=<value>)");
                return Ok(EXIT_USAGE);
            }
        }
    }
    let empty = Map::new();
    let stored = doc
        .get("vars")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty);
    // Everything that can fail on usage is settled before the first RPC.
    let values = match resolve_vars(stored, &scan_vars(&steps), &given) {
        Ok(v) => v,
        Err(m) => {
            eprintln!("ghax shortcut {name}: {m}");
            return Ok(EXIT_USAGE);
        }
    };
    let resolved = match substitute(&steps, &values) {
        Ok(s) => s,
        Err(m) => {
            eprintln!("ghax shortcut {name}: {m}");
            return Ok(EXIT_USAGE);
        }
    };
    let report = match Report::from_flags(parsed) {
        Ok(r) => r,
        Err(c) => return Ok(c),
    };
    if dry_run {
        crate::output::print(&json!({ "name": name, "steps": resolved }), true);
        return Ok(EXIT_OK);
    }
    let port = match state::require_daemon(cfg) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ghax: {e}");
            return Ok(EXIT_NOT_ATTACHED);
        }
    };
    Ok(run_steps(port, &resolved, report))
}

#[cfg(test)]
mod tests;
