//! `ghax cookies` — cookie inspection, scoped by default to the active
//! tab's URL, with values redacted unless `--values` is passed.
//!
//! Needs CLI-side logic (not a `simple()` verb) because `--has <name>`
//! turns the RPC's `{name, exists}` reply into a process exit code —
//! the scripting primitive for "did login land?" (see
//! docs/reports/open/2026-06-23-setsail-localhost-dev-session.md, Rec 1).
//! Mirrors the `is` verb's boolean→exit-code pattern in `dispatch.rs`.

use crate::args::Parsed;
use crate::dispatch::{EXIT_OK, EXIT_USAGE};
use crate::output;
use crate::rpc;
use crate::state::{self, Config};
use anyhow::Result;
use serde_json::json;

pub fn cmd_cookies(cfg: &Config, parsed: &Parsed) -> Result<i32> {
    let port = state::require_daemon(cfg)?;
    let data = rpc::call(port, "cookies", parsed.positional_value(), parsed.opts_without_json())?;

    if let Some(has_name) = parsed.flags.get("has").and_then(|v| v.as_str()) {
        let exists = data.get("exists").and_then(|v| v.as_bool()).unwrap_or(false);
        let line = json!({ "name": has_name, "exists": exists });
        println!("{}", serde_json::to_string(&line).unwrap_or_default());
        return Ok(if exists { EXIT_OK } else { EXIT_USAGE });
    }

    output::print(&data, parsed.json());
    Ok(EXIT_OK)
}
