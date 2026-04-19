//! Verb dispatch table. Mirrors the `switch (verb)` block in `src/cli.ts`.
//!
//! Phase 1 scope: every "trivial" verb (45 of them) plus the ext/gesture/record
//! subcommand families. Medium verbs (attach/detach/status/restart/qa/canary/
//! review/ship/pair) and complex ones (shell, console --follow, network --follow)
//! are stubs that print a "phase 2/3" message and exit non-zero.

use crate::args::{self, Parsed};
use crate::output;
use crate::rpc::{self, RpcError};
use crate::state::{self, Config};
use anyhow::Result;
use serde_json::{json, Value};

pub const EXIT_OK: i32 = 0;
pub const EXIT_USAGE: i32 = 1;
pub const EXIT_NOT_ATTACHED: i32 = 2;
pub const EXIT_CDP_ERROR: i32 = 4;
pub const EXIT_PHASE_PENDING: i32 = 64;

pub fn run(verb: &str, rest: &[String]) -> i32 {
    let cfg = state::resolve_config();
    match dispatch_inner(&cfg, verb, rest) {
        Ok(code) => code,
        Err(err) => {
            if let Some(rpc_err) = err.downcast_ref::<RpcError>() {
                eprintln!("ghax: {}", rpc_err.message);
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

fn dispatch_inner(cfg: &Config, verb: &str, rest: &[String]) -> Result<i32> {
    match verb {
        "attach" | "detach" | "restart" | "status" => return Ok(stub(verb, "phase 2")),
        "qa" | "canary" | "review" | "ship" | "pair" | "gif" | "chain" | "replay"
        | "diff-state" => return Ok(stub(verb, "phase 2")),
        "shell" => return Ok(stub(verb, "phase 3")),
        _ => {}
    }

    match verb {
        "tabs" | "back" | "forward" | "reload" | "text" | "cookies" => {
            let parsed = args::parse(rest);
            simple(cfg, verb, parsed)
        }

        "tab" | "find" | "goto" | "try" | "xpath" | "box" | "click" | "press"
        | "type" | "html" | "screenshot" | "wait" | "viewport" | "responsive" | "diff"
        | "storage" | "perf" | "profile" => {
            let parsed = args::parse(rest);
            simple(cfg, verb, parsed)
        }

        // The "ev" verb (JS execution against the page) — daemon RPC name matches.
        "eval" => {
            let parsed = args::parse(rest);
            simple(cfg, "eval", parsed)
        }

        "snapshot" => {
            let parsed = args::parse_snapshot(rest);
            simple_no_args(cfg, "snapshot", parsed)
        }

        "new-window" => {
            let parsed = args::parse(rest);
            simple(cfg, "newWindow", parsed)
        }

        "fill" => {
            let parsed = args::parse(rest);
            if parsed.positional.len() < 2 {
                eprintln!("Usage: ghax fill <@ref|selector> <value>");
                return Ok(EXIT_USAGE);
            }
            simple(cfg, "fill", parsed)
        }

        "is" => {
            let parsed = args::parse(rest);
            let port = state::require_daemon(cfg)?;
            let data = rpc::call(port, "is", parsed.positional_value(), parsed.opts_without_json())?;
            let result = data.get("result").and_then(|v| v.as_bool()).unwrap_or(false);
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
                eprintln!("ghax: --follow streams over SSE (phase 3 — not yet ported to Rust). Use the Bun CLI for now.");
                return Ok(EXIT_PHASE_PENDING);
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
    let data = rpc::call(port, cmd, parsed.positional_value(), parsed.opts_without_json())?;
    output::print(&data, parsed.json());
    Ok(EXIT_OK)
}

fn simple_no_args(cfg: &Config, cmd: &str, parsed: Parsed) -> Result<i32> {
    let port = state::require_daemon(cfg)?;
    let data = rpc::call(port, cmd, Value::Array(vec![]), parsed.opts_without_json())?;
    output::print(&data, parsed.json());
    Ok(EXIT_OK)
}

fn stub(verb: &str, phase: &str) -> i32 {
    eprintln!(
        "ghax: `{verb}` not yet ported to the Rust CLI ({phase}). Use the Bun CLI for now (set GHAX_BIN=./dist/ghax)."
    );
    EXIT_PHASE_PENDING
}

fn dispatch_ext(cfg: &Config, rest: &[String]) -> Result<i32> {
    let Some(sub) = rest.first() else {
        eprintln!("Usage: ghax ext <list|targets|reload|sw|panel|popup|options|storage|message> [...]");
        return Ok(EXIT_USAGE);
    };
    let parsed = args::parse(&rest[1..]);

    match sub.as_str() {
        "list" => simple(cfg, "ext.list", parsed),
        "targets" => simple(cfg, "ext.targets", parsed),
        "reload" => {
            let port = state::require_daemon(cfg)?;
            let data = rpc::call(port, "ext.reload", parsed.positional_value(), parsed.opts_without_json())?;
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
        "message" => simple(cfg, "ext.message", parsed),
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
            let data = rpc::call(port, "ext.sw.eval", Value::Array(positional), parsed.opts_without_json())?;
            output::print(&data, parsed.json());
            Ok(EXIT_OK)
        }
        "logs" => {
            let parsed = args::parse(tail);
            if matches!(parsed.flags.get("follow"), Some(Value::Bool(true))) {
                eprintln!("ghax: ext sw logs --follow streams over SSE (phase 3 — not yet ported).");
                return Ok(EXIT_PHASE_PENDING);
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
    let data = rpc::call(port, &cmd, Value::Array(positional), parsed.opts_without_json())?;
    output::print(&data, parsed.json());
    Ok(EXIT_OK)
}

fn dispatch_gesture(cfg: &Config, rest: &[String]) -> Result<i32> {
    let Some(sub) = rest.first() else {
        eprintln!("Usage: ghax gesture <click|dblclick|scroll|key> [args...]");
        return Ok(EXIT_USAGE);
    };
    let parsed = args::parse(&rest[1..]);
    let cmd = match sub.as_str() {
        "click" => "gesture.click",
        "dblclick" => "gesture.dblclick",
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
    let cmd = match sub.as_str() {
        "start" => "record.start",
        "stop" => "record.stop",
        "status" => "record.status",
        other => {
            eprintln!("Unknown record subcommand: {other}");
            return Ok(EXIT_USAGE);
        }
    };
    simple(cfg, cmd, parsed)
}
