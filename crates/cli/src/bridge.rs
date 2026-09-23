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

const USAGE: &str = "Usage: ghax bridge <control|instances|use|reload> [...]\n  \
control [--active | --tab-id <n> | --stop]   point the bridge at a tab\n  \
instances                                    list connected browsers (bound + parked)\n  \
use <instance-id|browser|label>              bind a different browser\n  \
reload [--timeout <ms>] [--force]            reload the bridge extension (no click in edge://extensions)";

/// Exit code for `bridge reload` refusing to proceed because another agent's
/// tab is at stake. Shares the numeric value of EXIT_NOT_ATTACHED (both are
/// "you need to do something before this can proceed"), not its identifier —
/// see the CLAUDE.md multi-agent rule this enforces.
const EXIT_RELOAD_NEEDS_FORCE: i32 = 2;

pub fn cmd_bridge(cfg: &Config, rest: &[String]) -> Result<i32> {
    let Some(sub) = rest.first() else {
        eprintln!("{USAGE}");
        return Ok(EXIT_USAGE);
    };
    match sub.as_str() {
        "control" => cmd_bridge_control(cfg, &args::parse(&rest[1..])),
        "instances" => cmd_bridge_instances(cfg, &args::parse(&rest[1..])),
        "use" => cmd_bridge_use(cfg, &args::parse(&rest[1..])),
        "reload" => cmd_bridge_reload(cfg, &args::parse(&rest[1..])),
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

/// `ghax bridge reload` — ask the connected extension to reload itself, so a
/// fresh `git pull` + `npm run build` takes effect with no click in
/// edge://extensions. See src/daemon.ts (`bridge.reload`) for the wait/ack
/// mechanics; this is the CLI-side multi-agent guard plus reporting.
fn cmd_bridge_reload(cfg: &Config, parsed: &Parsed) -> Result<i32> {
    let force = matches!(parsed.flags.get("force"), Some(Value::Bool(true)));
    let timeout_ms: u64 = parsed
        .flags
        .get("timeout")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(30_000);

    let port = state::require_daemon(cfg)?;

    // Own bridge port, so "controlledBy me" can be told from "controlledBy
    // some other agent's daemon" below. Also confirms bridge mode + a
    // connected extension up front, with the same error the daemon would
    // give anyway — surfaced before we've warned the user about anything.
    let instances = rpc::call(port, "bridge.instances", Value::Array(vec![]), json!({}))?;
    let own_port = instances.get("port").and_then(|v| v.as_u64());

    // Multi-agent guard (CLAUDE.md "Conduit" / ghax multi-agent rule): a
    // reload drops EVERY agent's chrome.debugger attachment on this browser —
    // the whole MV3 service worker dies, not just this daemon's connection to
    // it — so warn (and require --force) whenever another agent currently has
    // a tab claimed.
    let tabs = rpc::call(port, "tabs", Value::Array(vec![]), json!({}))?;
    let other_agent_tabs = tabs
        .as_array()
        .map(|arr| count_other_agent_tabs(arr, own_port))
        .unwrap_or(0);
    if other_agent_tabs > 0 && !force {
        eprintln!(
            "warning: {other_agent_tabs} tab(s) are controlled by another ghax agent on this browser."
        );
        eprintln!(
            "         reloading the bridge extension drops EVERY agent's chrome.debugger attachment, not just yours."
        );
        eprintln!("         re-run with --force to proceed anyway.");
        return Ok(EXIT_RELOAD_NEEDS_FORCE);
    }

    let started = std::time::Instant::now();
    let data = rpc::call(
        port,
        "bridge.reload",
        Value::Array(vec![]),
        json!({ "timeoutMs": timeout_ms }),
    )?;
    let duration_ms = data
        .get("durationMs")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| started.elapsed().as_millis() as u64);
    let before = data.get("before").cloned().unwrap_or(Value::Null);
    let after = data.get("after").cloned().unwrap_or(Value::Null);

    if parsed.json() {
        output::print(
            &json!({ "ok": true, "before": before, "after": after, "durationMs": duration_ms }),
            true,
        );
        return Ok(EXIT_OK);
    }

    println!("bridge extension reloaded: {}", format_extension_identity(&after));
    Ok(EXIT_OK)
}

fn format_extension_identity(info: &Value) -> String {
    let agent = info.get("agent").and_then(|v| v.as_str()).unwrap_or("ghax-ext");
    let version = info.get("version").and_then(|v| v.as_str()).unwrap_or("?");
    let sha = info.get("gitSha").and_then(|v| v.as_str());
    let date = info.get("buildDate").and_then(|v| v.as_str());
    let provenance = match (sha, date) {
        (Some(s), Some(d)) => format!(" ({s} {d})"),
        _ => String::new(),
    };
    format!("{agent} v{version}{provenance}")
}

/// Count tabs `controlledBy` some bridge port OTHER than `own_port`. A tab
/// with `controlledBy: null` is free; one with no field at all (non-bridge
/// `tabs` output) never counts. Pulled out as a pure function so the
/// multi-agent guard above — which the TS bridge simulators can't reach,
/// since it's Rust-CLI-only logic — has a `cargo test`.
fn count_other_agent_tabs(tabs: &[Value], own_port: Option<u64>) -> usize {
    tabs.iter()
        .filter(|t| {
            let controlled_by = t.get("controlledBy").and_then(|v| v.as_u64());
            match (controlled_by, own_port) {
                (Some(cb), Some(op)) => cb != op,
                (Some(_), None) => true,
                (None, _) => false,
            }
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_tabs_no_conflict() {
        assert_eq!(count_other_agent_tabs(&[], Some(9223)), 0);
    }

    #[test]
    fn own_tabs_and_free_tabs_do_not_count() {
        let tabs = vec![
            json!({ "id": "1", "controlledBy": 9223 }),
            json!({ "id": "2", "controlledBy": Value::Null }),
            json!({ "id": "3" }),
        ];
        assert_eq!(count_other_agent_tabs(&tabs, Some(9223)), 0);
    }

    #[test]
    fn another_agents_tab_counts() {
        let tabs = vec![
            json!({ "id": "1", "controlledBy": 9223 }),
            json!({ "id": "2", "controlledBy": 9224 }),
            json!({ "id": "3", "controlledBy": 9225 }),
        ];
        assert_eq!(count_other_agent_tabs(&tabs, Some(9223)), 2);
    }

    #[test]
    fn unknown_own_port_treats_any_claimed_tab_as_someone_elses() {
        let tabs = vec![json!({ "id": "1", "controlledBy": 9223 })];
        assert_eq!(count_other_agent_tabs(&tabs, None), 1);
    }

    #[test]
    fn format_extension_identity_includes_provenance_when_present() {
        let info = json!({ "agent": "ghax-ext", "version": "0.8.0", "gitSha": "abc1234", "buildDate": "2026-09-22" });
        assert_eq!(format_extension_identity(&info), "ghax-ext v0.8.0 (abc1234 2026-09-22)");
    }

    #[test]
    fn format_extension_identity_omits_parens_when_provenance_missing() {
        let info = json!({ "agent": "ghax-ext", "version": "0.8.0" });
        assert_eq!(format_extension_identity(&info), "ghax-ext v0.8.0");
    }
}
