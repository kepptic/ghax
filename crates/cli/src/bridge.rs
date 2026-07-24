//! `ghax bridge control [--active | --tab-id <n> | --stop]` — (re)point the
//! MV3 bridge extension at a tab mid-session, without the popup.
//!
//! Only meaningful when the daemon is running in bridge mode
//! (`ghax attach --extension`). The daemon's `bridge.control` RPC handler
//! (src/daemon.ts) forwards the request to the extension over the control
//! channel and returns its `control-ack`. See extension/background.js for
//! the wire protocol.

use anyhow::Result;
use serde_json::{json, Value};

use crate::args::{self, Parsed};
use crate::dispatch::{EXIT_OK, EXIT_USAGE};
use crate::output;
use crate::rpc;
use crate::state::{self, Config};

const USAGE: &str = "Usage: ghax bridge <control|instances|use> [...]\n  \
control [--active | --tab-id <n> | --stop]   point the bridge at a tab\n  \
instances                                    list connected browsers (bound + parked)\n  \
use <instance-id|browser|label>              bind a different browser";

pub fn cmd_bridge(cfg: &Config, rest: &[String]) -> Result<i32> {
    let Some(sub) = rest.first() else {
        eprintln!("{USAGE}");
        return Ok(EXIT_USAGE);
    };
    match sub.as_str() {
        "control" => cmd_bridge_control(cfg, &args::parse(&rest[1..])),
        "instances" => cmd_bridge_instances(cfg, &args::parse(&rest[1..])),
        "use" => cmd_bridge_use(cfg, &args::parse(&rest[1..])),
        other => {
            eprintln!("Unknown bridge subcommand: {other}\n\n{USAGE}");
            Ok(EXIT_USAGE)
        }
    }
}

/// Render the instance inventory. This is the command that makes a
/// two-browsers-fighting situation obvious instead of silent.
fn cmd_bridge_instances(cfg: &Config, parsed: &Parsed) -> Result<i32> {
    let port = state::require_daemon(cfg)?;
    let data = rpc::call(port, "bridge.instances", Value::Array(vec![]), json!({}))?;
    if parsed.json() {
        output::print(&data, true);
        return Ok(EXIT_OK);
    }

    let state = data.get("state").and_then(|v| v.as_str()).unwrap_or("UNKNOWN");
    println!("session  {state}");
    let empty = vec![];
    let instances = data.get("instances").and_then(|v| v.as_array()).unwrap_or(&empty);
    if instances.is_empty() {
        println!("(no extension has connected yet)");
        return Ok(EXIT_OK);
    }
    for inst in instances {
        let role = inst.get("role").and_then(|v| v.as_str()).unwrap_or("?");
        let marker = if role == "bound" { "*" } else { " " };
        let browser = inst.get("browser").and_then(|v| v.as_str()).unwrap_or("browser");
        let id = inst.get("instanceId").and_then(|v| v.as_str()).unwrap_or("");
        let short: String = id.chars().take(6).collect();
        let label = inst.get("label").and_then(|v| v.as_str()).unwrap_or("");
        let connected = inst.get("connected").and_then(|v| v.as_bool()).unwrap_or(false);
        let tab = inst
            .get("controlledTabId")
            .and_then(|v| v.as_i64())
            .map(|t| format!("tab {t}"))
            .unwrap_or_else(|| "no tab".into());
        let hellos = inst.get("helloCount").and_then(|v| v.as_i64()).unwrap_or(0);
        let replaced = inst.get("replacedCount").and_then(|v| v.as_i64()).unwrap_or(0);
        let label_part = if label.is_empty() { String::new() } else { format!(" \"{label}\"") };
        println!(
            "{marker} {role:<6} {browser}·{short}{label_part}  {tab}  {}  hello×{hellos}{}",
            if connected { "connected" } else { "offline" },
            if replaced > 0 { format!(" replaced×{replaced}") } else { String::new() },
        );
    }
    if data.get("livelockSuspected").and_then(|v| v.as_bool()) == Some(true) {
        eprintln!();
        eprintln!("WARNING: bridge ownership has been flapping.");
        eprintln!("         A pre-identity ghax bridge extension is probably still installed in");
        eprintln!("         another profile. Reload the extension in edge://extensions in EVERY");
        eprintln!("         profile, or disable the ones you don't drive.");
    }
    Ok(EXIT_OK)
}

fn cmd_bridge_use(cfg: &Config, parsed: &Parsed) -> Result<i32> {
    let Some(selector) = parsed.positional.first() else {
        eprintln!("Usage: ghax bridge use <instance-id|browser|label>");
        return Ok(EXIT_USAGE);
    };
    let port = state::require_daemon(cfg)?;
    let data = rpc::call(
        port,
        "bridge.use",
        Value::Array(vec![Value::String(selector.clone())]),
        json!({}),
    )?;
    if parsed.json() {
        output::print(&data, true);
    } else {
        let browser = data.get("browser").and_then(|v| v.as_str()).unwrap_or("browser");
        let id = data.get("instanceId").and_then(|v| v.as_str()).unwrap_or("");
        let short: String = id.chars().take(6).collect();
        println!("bound → {browser}·{short}");
    }
    Ok(EXIT_OK)
}

fn cmd_bridge_control(cfg: &Config, parsed: &Parsed) -> Result<i32> {
    let stop = matches!(parsed.flags.get("stop"), Some(Value::Bool(true)));
    let tab_id: Option<i64> = parsed
        .flags
        .get("tab-id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    // Mode precedence: --stop, then --tab-id, then --active. With no target
    // flag we default to --active (the common "drive my current tab" case).
    let opts = if stop {
        json!({ "mode": "stop" })
    } else if let Some(id) = tab_id {
        json!({ "mode": "tab", "tabId": id })
    } else {
        json!({ "mode": "active" })
    };

    let port = state::require_daemon(cfg)?;
    let data = rpc::call(port, "bridge.control", Value::Array(vec![]), opts)?;
    output::print(&data, parsed.json());
    Ok(EXIT_OK)
}
