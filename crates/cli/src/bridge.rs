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

pub fn cmd_bridge(cfg: &Config, rest: &[String]) -> Result<i32> {
    let Some(sub) = rest.first() else {
        eprintln!("Usage: ghax bridge control [--active | --tab-id <n> | --stop]");
        return Ok(EXIT_USAGE);
    };
    match sub.as_str() {
        "control" => cmd_bridge_control(cfg, &args::parse(&rest[1..])),
        other => {
            eprintln!("Unknown bridge subcommand: {other}\n\nUsage: ghax bridge control [--active | --tab-id <n> | --stop]");
            Ok(EXIT_USAGE)
        }
    }
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
