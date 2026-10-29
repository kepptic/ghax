//! Verb dispatch table — every CLI verb routes through here.

use crate::args::{self, Parsed};
use crate::output;
use crate::rpc::{self, RpcError};
use crate::state::{self, Config};
use crate::{attach, canary, qa, review, ship, small, update};
use anyhow::Result;
use serde_json::{Value, json};

pub const EXIT_OK: i32 = 0;
pub const EXIT_USAGE: i32 = 1;
/// A plan's `expect` (or `ghax expect`) did not hold. Shares the value 1 with
/// usage errors on purpose: both mean "the check, not the browser, said no".
pub const EXIT_ASSERT: i32 = 1;
pub const EXIT_NOT_ATTACHED: i32 = 2;
pub const EXIT_CDP_ERROR: i32 = 4;
/// A verb that needs an element got an empty target; same code the daemon
/// uses for the same mistake.
pub const EXIT_BAD_TARGET: i32 = 2;

/// `Some(exit code)` after printing the empty-target message when the first
/// positional is missing or blank. The usual cause is an unset shell
/// variable (`ghax click "$REF"`), so the message says so.
fn empty_target(verb: &str, parsed: &Parsed) -> Option<i32> {
    match parsed.positional.first() {
        Some(t) if !t.trim().is_empty() => None,
        _ => {
            eprintln!(
                "ghax: {verb}: target is empty — pass an @ref or selector (unset shell variable?)"
            );
            Some(EXIT_BAD_TARGET)
        }
    }
}

/// Parse argv where `names` are switches (`--force`, `--no-wait`, ...).
/// `args::parse` hands a flag the next bare token as its value, so
/// `drag '#src' --force '#dst'` would eat `#dst`. A bare `--name` is pulled
/// out of argv before parsing, so every other token keeps its position, and
/// the flag becomes a plain true. `--name=true` / `--name=false` is the
/// flag's own value and becomes that bool. Tokens after a `--` terminator
/// are values and are never read as switches.
pub(crate) fn parse_switches(rest: &[String], names: &[&str]) -> Parsed {
    let end = rest.iter().position(|a| a == "--").unwrap_or(rest.len());
    let mut seen: Vec<&str> = Vec::new();
    let mut kept: Vec<String> = Vec::with_capacity(rest.len());
    for (i, tok) in rest.iter().enumerate() {
        let bare = tok
            .strip_prefix("--")
            .filter(|n| i < end && names.contains(n));
        match bare {
            Some(n) => seen.push(n),
            None => kept.push(tok.clone()),
        }
    }
    let mut parsed = args::parse(&kept);
    for name in names {
        match parsed.flags.get(*name).cloned() {
            Some(Value::String(v)) if v == "true" || v == "false" => {
                parsed
                    .flags
                    .insert((*name).to_string(), Value::Bool(v == "true"));
            }
            // `--name=x` with any other value, or a duplicate: leave it be.
            Some(_) => {}
            None if seen.contains(name) => {
                parsed.flags.insert((*name).to_string(), Value::Bool(true));
            }
            None => {}
        }
    }
    parsed
}

/// A switch the user turned on (bare, or `=true`).
fn switch_on(parsed: &Parsed, name: &str) -> bool {
    matches!(parsed.flags.get(name), Some(Value::Bool(true)))
}

pub fn run(verb: &str, rest: &[String]) -> i32 {
    let cfg = match resolve_for_verb(verb, rest) {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("ghax: {err}");
            return EXIT_NOT_ATTACHED;
        }
    };
    // `--trace` is global: pull it out before any per-verb parser sees it, so
    // `ghax click --trace @e3` can't read "@e3" as the flag's value. Tokens
    // after a `--` terminator are values and stay put (args::take_trace).
    let (traced, stripped) = args::take_trace(rest);
    rpc::set_trace(traced);
    let rest = &stripped[..];
    match dispatch_inner(&cfg, verb, rest) {
        Ok(code) => code,
        Err(err) => {
            if let Some(rpc_err) = err.downcast_ref::<RpcError>() {
                eprintln!("ghax: {}", rpc_err.message);
                if let Some(hint) = &rpc_err.hint {
                    eprintln!("hint: {hint}");
                }
                return rpc_err.exit_code.unwrap_or(EXIT_CDP_ERROR);
            }
            let msg = err.to_string();
            if msg.contains("browser has been closed")
                || msg.contains("Target page has been closed")
                || msg.contains("Target browser has been closed")
                || msg.contains("disconnected")
            {
                eprintln!("ghax: browser has disconnected. Run `ghax attach` to reconnect.");
                return EXIT_NOT_ATTACHED;
            }
            eprintln!("ghax: {msg}");
            EXIT_CDP_ERROR
        }
    }
}

/// Verbs that never talk to a daemon, so discovery (and its ambiguity /
/// unreadable-registry errors) has no business running for them: `diff-state`
/// compares two files on disk, and plain `version` prints the CLI banner
/// (only `version --full` looks for a daemon). `help`/`--help`/`--version`
/// return in main.rs before dispatch. Every other verb in `dispatch_inner`
/// calls `require_daemon` or reads daemon state.
fn is_local_only(verb: &str, rest: &[String]) -> bool {
    match verb {
        "diff-state" => true,
        "version" => !args::parse(rest).flags.contains_key("full"),
        _ => false,
    }
}

/// Which state file a verb talks to. `attach`/`restart` never adopt another
/// directory's daemon (they'd pair with it instead of starting their own), and
/// `detach` never stops one it wasn't pointed at. Local-only verbs never look
/// for a daemon. Everything else goes through discovery (state.rs
/// `resolve_config_for_use`).
fn resolve_for_verb(verb: &str, rest: &[String]) -> Result<Config> {
    if is_local_only(verb, rest) {
        return Ok(state::resolve_config());
    }
    match verb {
        "attach" | "restart" | "detach" | "review" | "ship" | "update" | "shell" => {
            Ok(state::resolve_config())
        }
        // `ghax version --full` must work with no daemon at all; an ambiguous
        // registry only costs it the daemon half.
        "version" => Ok(state::resolve_config_for_use().unwrap_or_else(|err| {
            eprintln!("ghax: {err}");
            state::resolve_config()
        })),
        _ => {
            let (cfg, borrowed) = state::resolve_config_with_origin()?;
            if let Some(entry) = borrowed {
                if !borrow_allowed(verb, rest) {
                    return Err(anyhow::anyhow!(state::borrowed_refusal(verb, &entry)));
                }
                state::note_adoption(&entry);
                // The daemon enforces the same allowlist and keeps its session
                // state (the `tab #n` listing) untouched for marked calls.
                crate::rpc::set_borrowed(true);
            }
            Ok(cfg)
        }
    }
}

/// What a daemon borrowed from another directory (discovery fallback) may be
/// asked: reads that change nothing in the browser or in the daemon's
/// session. Everything else belongs to whoever attached it, so it needs an
/// explicit `ghax attach` here or GHAX_STATE_FILE.
fn borrow_allowed(verb: &str, rest: &[String]) -> bool {
    match verb {
        "status" | "tabs" | "version" => true,
        // `network --har` writes a file; `--source-maps` fetches scripts and
        // fills the daemon's map cache. `--clear`/`--export` are refused up
        // front so a future flag of that kind can't slip through.
        "console" | "network" => !rest.iter().any(|a| {
            let flag = a.split('=').next().unwrap_or(a);
            BORROW_DENIED_FLAGS.contains(&flag)
        }),
        "bridge" => rest.first().map(String::as_str) == Some("instances"),
        _ => false,
    }
}

/// console/network flags that write a file or change daemon state. Must
/// match BORROW_DENIED_OPTS in src/daemon.ts.
const BORROW_DENIED_FLAGS: &[&str] = &["--har", "--source-maps", "--clear", "--export"];

#[cfg(test)]
mod local_only_tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn local_only_verbs_skip_discovery() {
        assert!(is_local_only("diff-state", &v(&["a.json", "b.json"])));
        assert!(is_local_only("version", &v(&[])));
        assert!(is_local_only("version", &v(&["--json"])));
        assert!(!is_local_only("version", &v(&["--full"])));
        assert!(!is_local_only("tabs", &v(&[])));
        assert!(!is_local_only("status", &v(&[])));
    }

    #[test]
    fn borrowed_daemons_are_read_only() {
        for verb in ["status", "tabs", "version", "console", "network"] {
            assert!(borrow_allowed(verb, &v(&[])), "{verb}");
        }
        assert!(borrow_allowed("bridge", &v(&["instances"])));
        assert!(!borrow_allowed("bridge", &v(&["use", "edge"])));
        assert!(!borrow_allowed("bridge", &v(&["reload"])));
        for verb in [
            "goto",
            "click",
            "tab",
            "new-tab",
            "close-tab",
            "eval",
            "batch",
            "cookies",
            "expect",
            "snapshot",
        ] {
            assert!(!borrow_allowed(verb, &v(&[])), "{verb}");
        }
    }

    #[test]
    fn borrowed_console_and_network_refuse_writing_flags() {
        assert!(!borrow_allowed("network", &v(&["--har", "/tmp/x.har"])));
        assert!(!borrow_allowed("network", &v(&["--har=/tmp/x.har"])));
        assert!(!borrow_allowed(
            "network",
            &v(&["--pattern", "api", "--export", "x"])
        ));
        assert!(!borrow_allowed("console", &v(&["--clear"])));
        assert!(!borrow_allowed("console", &v(&["--source-maps"])));
        assert!(borrow_allowed(
            "network",
            &v(&["--pattern", "api", "--last", "5"])
        ));
        assert!(borrow_allowed("console", &v(&["--errors", "--follow"])));
        // A value that merely mentions a flag is not that flag.
        assert!(borrow_allowed("network", &v(&["--pattern", "x--har"])));
    }
}

fn dispatch_inner(cfg: &Config, verb: &str, rest: &[String]) -> Result<i32> {
    match verb {
        "attach" => return attach::cmd_attach(&args::parse(rest), cfg),
        "detach" => return attach::cmd_detach(cfg),
        "restart" => return attach::cmd_restart(&args::parse(rest), cfg),
        "bridge" => return crate::bridge::cmd_bridge(cfg, rest),
        "status" => return small::cmd_status(cfg, rest),
        "pair" => return small::cmd_pair(cfg, rest),
        "diff-state" => return small::cmd_diff_state(rest),
        "chain" => return small::cmd_chain(cfg, rest),
        "batch" => return small::cmd_batch(cfg, rest),
        "replay" => return small::cmd_replay(cfg, rest),
        "shortcut" => return crate::shortcuts::cmd_shortcut(cfg, rest),
        "expect" => return crate::expect::cmd_expect(cfg, rest),
        "find-el" => return crate::find_el::cmd_find_el(cfg, rest),
        "gif" => return small::cmd_gif(cfg, rest),
        "qa" => return qa::cmd_qa(cfg, &args::parse(rest)),
        "canary" => return canary::cmd_canary(cfg, &args::parse(rest)),
        "review" => return review::cmd_review(&args::parse(rest)),
        "ship" => return ship::cmd_ship(&args::parse(rest)),
        "update" => return update::cmd_update(&args::parse(rest)),
        "shell" => return crate::shell::cmd_shell(),
        "version" => return crate::version::cmd_version(&args::parse(rest), cfg),
        _ => {}
    }

    match verb {
        "tabs" => crate::tabs::cmd_tabs(cfg, &args::parse(rest)),

        "back" | "forward" | "reload" | "text" | "downloads" => {
            let parsed = args::parse(rest);
            simple(cfg, verb, parsed)
        }

        "cookies" => {
            let parsed = args::parse(rest);
            crate::cookies::cmd_cookies(cfg, &parsed)
        }

        "auth" => {
            let parsed = args::parse(rest);
            crate::auth::cmd_auth(cfg, &parsed)
        }

        "tab" => {
            // `--focus` / `--quiet` are switches: `tab --focus '#2'` must not
            // swallow the selector as the flag's value.
            let parsed = parse_switches(rest, &["focus", "quiet"]);
            simple(cfg, "tab", parsed)
        }

        "find" | "goto" | "try" | "xpath" | "box" | "click" | "press" | "type" | "html"
        | "wait" | "viewport" | "responsive" | "diff" | "storage" | "perf" | "profile" => {
            let parsed = args::parse(rest);
            simple(cfg, verb, parsed)
        }

        // `--force` is a switch: `hover --force @e3` must not swallow the target.
        "hover" | "drag" => {
            let parsed = parse_switches(rest, &["force"]);
            simple(cfg, verb, parsed)
        }

        "eval" => {
            let parsed = parse_switches(rest, &["no-wait"]);
            simple(cfg, "eval", parsed)
        }

        "screenshot" => {
            let mut parsed = parse_switches(rest, &["path-only"]);
            let path_only = switch_on(&parsed, "path-only");
            parsed.flags.remove("path-only");
            if !path_only || parsed.json() {
                return simple(cfg, "screenshot", parsed);
            }
            let port = state::require_daemon(cfg)?;
            let data = rpc::call(
                port,
                "screenshot",
                parsed.positional_value(),
                parsed.opts_without_json(),
            )?;
            match data.get("path").and_then(|v| v.as_str()) {
                Some(p) => println!("{p}"),
                None => output::print(&data, false),
            }
            Ok(EXIT_OK)
        }

        "snapshot" => {
            let parsed = args::parse_snapshot(rest);
            simple_no_args(cfg, "snapshot", parsed)
        }

        "new-window" => {
            let parsed = args::parse(rest);
            simple(cfg, "newWindow", parsed)
        }

        "new-tab" => {
            let parsed = args::parse(rest);
            simple(cfg, "newTab", parsed)
        }

        "close-tab" => {
            let parsed = args::parse(rest);
            simple(cfg, "closeTab", parsed)
        }

        "window" => {
            let mut parsed = args::parse(rest);
            // `window size [<WxH>] [--window <id>]` is the only subcommand so
            // far; the RPC is `window.size` and takes the size alone.
            if parsed.positional.first().map(String::as_str) != Some("size") {
                eprintln!("Usage: ghax window size [<WxH>] [--window <windowId>]");
                return Ok(EXIT_USAGE);
            }
            parsed.positional.remove(0);
            simple(cfg, "window.size", parsed)
        }

        "fill" => {
            let parsed = args::parse(rest);
            if let Some(code) = empty_target("fill", &parsed) {
                return Ok(code);
            }
            if parsed.positional.len() < 2 {
                eprintln!("Usage: ghax fill <@ref|selector> <value>");
                return Ok(EXIT_USAGE);
            }
            simple(cfg, "fill", parsed)
        }

        "upload" => {
            let parsed = args::parse(rest);
            if let Some(code) = empty_target("upload", &parsed) {
                return Ok(code);
            }
            if parsed.positional.len() < 2 {
                eprintln!("Usage: ghax upload <@ref|selector> <path>[,<path>…]");
                return Ok(EXIT_USAGE);
            }
            simple(cfg, "upload", parsed)
        }

        "select" => {
            let parsed = args::parse(rest);
            if let Some(code) = empty_target("select", &parsed) {
                return Ok(code);
            }
            simple(cfg, "select", parsed)
        }

        "is" => {
            let parsed = args::parse(rest);
            let port = state::require_daemon(cfg)?;
            let data = rpc::call(
                port,
                "is",
                parsed.positional_value(),
                parsed.opts_without_json(),
            )?;
            let result = data
                .get("result")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if parsed.json() {
                output::print(&data, true);
            } else {
                println!("{}", if result { "true" } else { "false" });
            }
            Ok(if result { EXIT_OK } else { EXIT_USAGE })
        }

        "console" | "network" => {
            let parsed = args::parse(rest);
            if matches!(parsed.flags.get("follow"), Some(Value::Bool(true))) {
                let port = state::require_daemon(cfg)?;
                return crate::sse::stream(port, &format!("/sse/{verb}"));
            }
            simple(cfg, verb, parsed)
        }

        "ext" => dispatch_ext(cfg, rest),
        "gesture" => dispatch_gesture(cfg, rest),
        "record" => dispatch_record(cfg, rest),

        other => {
            eprintln!("Unknown command: {other}\n\nRun 'ghax --help' for usage.");
            Ok(EXIT_USAGE)
        }
    }
}

fn simple(cfg: &Config, cmd: &str, parsed: Parsed) -> Result<i32> {
    let port = state::require_daemon(cfg)?;
    let data = rpc::call(
        port,
        cmd,
        parsed.positional_value(),
        parsed.opts_without_json(),
    )?;
    output::print(&data, parsed.json());
    Ok(EXIT_OK)
}

fn simple_no_args(cfg: &Config, cmd: &str, parsed: Parsed) -> Result<i32> {
    let port = state::require_daemon(cfg)?;
    let data = rpc::call(port, cmd, Value::Array(vec![]), parsed.opts_without_json())?;
    output::print(&data, parsed.json());
    Ok(EXIT_OK)
}

fn dispatch_ext(cfg: &Config, rest: &[String]) -> Result<i32> {
    let Some(sub) = rest.first() else {
        eprintln!(
            "Usage: ghax ext <list|targets|reload|sw|panel|popup|options|storage|message> [...]"
        );
        return Ok(EXIT_USAGE);
    };
    let parsed = args::parse(&rest[1..]);

    match sub.as_str() {
        "list" => simple(cfg, "ext.list", parsed),
        "targets" => simple(cfg, "ext.targets", parsed),
        "reload" => {
            let port = state::require_daemon(cfg)?;
            let data = rpc::call(
                port,
                "ext.reload",
                parsed.positional_value(),
                parsed.opts_without_json(),
            )?;
            if parsed.json() {
                output::print(&data, true);
            } else {
                println!("reloaded");
                if let Some(Value::String(hint)) = data.get("hint") {
                    eprintln!("hint: {hint}");
                }
            }
            Ok(EXIT_OK)
        }
        "hot-reload" => simple(cfg, "ext.hot-reload", parsed),
        "sw" => dispatch_ext_sw(cfg, &rest[1..]),
        "panel" | "popup" | "options" => dispatch_ext_inner(cfg, sub, &rest[1..]),
        "storage" => simple(cfg, "ext.storage", parsed),
        "message" => {
            if parsed.positional.len() < 2 {
                eprintln!("Usage: ghax ext message <ext-id> <json-payload>");
                return Ok(EXIT_USAGE);
            }
            simple(cfg, "ext.message", parsed)
        }
        other => {
            eprintln!("Unknown ext subcommand: {other}");
            Ok(EXIT_USAGE)
        }
    }
}

fn dispatch_ext_sw(cfg: &Config, rest: &[String]) -> Result<i32> {
    if rest.len() < 2 {
        eprintln!("Usage: ghax ext sw <ext-id> <eval|logs> [args...]");
        return Ok(EXIT_USAGE);
    }
    let ext_id = &rest[0];
    let action = &rest[1];
    let tail = &rest[2..];
    match action.as_str() {
        "eval" => {
            let parsed = args::parse(tail);
            let port = state::require_daemon(cfg)?;
            let mut positional = vec![Value::String(ext_id.clone())];
            positional.extend(parsed.positional.iter().cloned().map(Value::String));
            let data = rpc::call(
                port,
                "ext.sw.eval",
                Value::Array(positional),
                parsed.opts_without_json(),
            )?;
            output::print(&data, parsed.json());
            Ok(EXIT_OK)
        }
        "logs" => {
            let parsed = args::parse(tail);
            if matches!(parsed.flags.get("follow"), Some(Value::Bool(true))) {
                let port = state::require_daemon(cfg)?;
                let encoded_id = urlencoding::encode(ext_id);
                return crate::sse::stream(port, &format!("/sse/ext-sw-logs/{encoded_id}"));
            }
            let port = state::require_daemon(cfg)?;
            let positional = json!([ext_id.clone()]);
            let data = rpc::call(port, "ext.sw.logs", positional, parsed.opts_without_json())?;
            output::print(&data, parsed.json());
            Ok(EXIT_OK)
        }
        other => {
            eprintln!("Unknown ext sw action: {other}");
            Ok(EXIT_USAGE)
        }
    }
}

fn dispatch_ext_inner(cfg: &Config, surface: &str, rest: &[String]) -> Result<i32> {
    if rest.len() < 3 || rest[1] != "eval" {
        eprintln!("Usage: ghax ext {surface} <ext-id> eval <js>");
        return Ok(EXIT_USAGE);
    }
    let ext_id = &rest[0];
    let js_and_rest = &rest[2..];
    let parsed = args::parse(js_and_rest);
    let port = state::require_daemon(cfg)?;
    let cmd = format!("ext.{surface}.eval");
    let mut positional = vec![Value::String(ext_id.clone())];
    positional.extend(parsed.positional.iter().cloned().map(Value::String));
    let data = rpc::call(
        port,
        &cmd,
        Value::Array(positional),
        parsed.opts_without_json(),
    )?;
    output::print(&data, parsed.json());
    Ok(EXIT_OK)
}

fn dispatch_gesture(cfg: &Config, rest: &[String]) -> Result<i32> {
    let Some(sub) = rest.first() else {
        eprintln!(
            "Usage: ghax gesture <click|dblclick|tripleclick|rightclick|hover|scroll|key> [args...]"
        );
        return Ok(EXIT_USAGE);
    };
    let parsed = args::parse(&rest[1..]);
    let cmd = match sub.as_str() {
        "click" => "gesture.click",
        "dblclick" => "gesture.dblclick",
        "tripleclick" => "gesture.tripleclick",
        "rightclick" => "gesture.rightclick",
        "hover" => "gesture.hover",
        "scroll" => "gesture.scroll",
        "key" => "gesture.key",
        other => {
            eprintln!("Unknown gesture: {other}");
            return Ok(EXIT_USAGE);
        }
    };
    simple(cfg, cmd, parsed)
}

fn dispatch_record(cfg: &Config, rest: &[String]) -> Result<i32> {
    let Some(sub) = rest.first() else {
        eprintln!("Usage: ghax record <start|stop|status> [name]");
        return Ok(EXIT_USAGE);
    };
    let parsed = args::parse(&rest[1..]);
    match sub.as_str() {
        "start" => {
            let port = state::require_daemon(cfg)?;
            let data = rpc::call(
                port,
                "record.start",
                parsed.positional_value(),
                parsed.opts_without_json(),
            )?;
            if parsed.json() {
                output::print(&data, true);
            } else {
                let name = data
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("recording");
                println!("recording → {name}");
            }
            Ok(EXIT_OK)
        }
        "stop" => {
            let port = state::require_daemon(cfg)?;
            let data = rpc::call(
                port,
                "record.stop",
                parsed.positional_value(),
                parsed.opts_without_json(),
            )?;
            if parsed.json() {
                output::print(&data, true);
            } else {
                let steps = data.get("steps").and_then(|v| v.as_u64()).unwrap_or(0);
                let rec_path = data.get("path").and_then(|v| v.as_str()).unwrap_or("");
                println!("saved {steps} steps → {rec_path}");
            }
            Ok(EXIT_OK)
        }
        "status" => simple(cfg, "record.status", parsed),
        other => {
            eprintln!("Unknown record subcommand: {other}");
            Ok(EXIT_USAGE)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(xs: &[&str]) -> Parsed {
        args::parse(&xs.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn switch_gives_a_swallowed_token_back() {
        let a = parse_switches(&v(&["--no-wait", "window.x = 1"]), &["no-wait"]);
        assert!(switch_on(&a, "no-wait"));
        assert_eq!(a.positional, v(&["window.x = 1"]));
        assert_eq!(a.flags.get("no-wait"), Some(&Value::Bool(true)));
        let b = parse_switches(&v(&["window.x = 1", "--no-wait"]), &["no-wait"]);
        assert!(switch_on(&b, "no-wait"));
        assert_eq!(b.positional.len(), 1);
        let c = parse_switches(&v(&["window.x = 1"]), &["no-wait"]);
        assert!(!switch_on(&c, "no-wait"));
        assert_eq!(c.flags.get("no-wait"), None);
    }

    #[test]
    fn switch_keeps_positional_order_wherever_it_sits() {
        for argv in [
            v(&["#src", "--force", "#dst"]),
            v(&["--force", "#src", "#dst"]),
            v(&["#src", "#dst", "--force"]),
        ] {
            let p = parse_switches(&argv, &["force"]);
            assert_eq!(p.positional, v(&["#src", "#dst"]), "argv {argv:?}");
            assert_eq!(p.flags.get("force"), Some(&Value::Bool(true)));
        }
    }

    #[test]
    fn switch_does_not_disturb_valued_flags() {
        let p = parse_switches(
            &v(&["#src", "--force", "#dst", "--steps", "5", "--mode=html5"]),
            &["force"],
        );
        assert_eq!(p.positional, v(&["#src", "#dst"]));
        assert_eq!(p.flags.get("steps"), Some(&Value::String("5".into())));
        assert_eq!(p.flags.get("mode"), Some(&Value::String("html5".into())));
    }

    #[test]
    fn switch_after_terminator_is_a_value() {
        let p = parse_switches(&v(&["--no-wait", "--", "--no-wait"]), &["no-wait"]);
        assert!(switch_on(&p, "no-wait"));
        assert_eq!(p.positional, v(&["--no-wait"]));
    }

    #[test]
    fn switch_reads_literal_true_false_as_the_value() {
        let a = parse_switches(&v(&["window.x=1", "--no-wait=true"]), &["no-wait"]);
        assert!(switch_on(&a, "no-wait"));
        assert_eq!(a.positional, v(&["window.x=1"]));
        let b = parse_switches(&v(&["window.x=1", "--no-wait=false"]), &["no-wait"]);
        assert!(!switch_on(&b, "no-wait"));
        assert_eq!(b.positional, v(&["window.x=1"]));
        assert_eq!(b.flags.get("no-wait"), Some(&Value::Bool(false)));
    }

    #[test]
    fn empty_target_catches_missing_and_blank() {
        assert_eq!(empty_target("click", &p(&[])), Some(EXIT_BAD_TARGET));
        assert_eq!(empty_target("click", &p(&[""])), Some(EXIT_BAD_TARGET));
        assert_eq!(empty_target("click", &p(&["@e3"])), None);
    }
}
