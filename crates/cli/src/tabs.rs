//! `ghax tabs` text rendering. The daemon returns one object per tab with its
//! full identity (index, id, browser, profile, ...); `--json` prints that
//! as-is, and the default text form is one aligned-by-separator line per tab:
//!
//!     #3  edge-dag-tech:42  "Bank feeds"  Edge · DAG Tech · win 2  active  controlledBy=you
//!
//! Must match `formatTabLine` in src/tab-identity.ts. With `--fields` the rows
//! lack the identity keys, so they fall back to the generic printer.

use anyhow::Result;
use serde_json::Value;

use crate::args::Parsed;
use crate::dispatch::EXIT_OK;
use crate::state::{self, Config};
use crate::{output, rpc};

pub fn cmd_tabs(cfg: &Config, parsed: &Parsed) -> Result<i32> {
    let port = state::require_daemon(cfg)?;
    let data = rpc::call(
        port,
        "tabs",
        parsed.positional_value(),
        parsed.opts_without_json(),
    )?;
    if parsed.json() {
        output::print(&data, true);
        return Ok(EXIT_OK);
    }
    match render(&data) {
        Some(lines) => {
            for line in lines {
                output::print(&Value::String(line), false);
            }
        }
        None => output::print(&data, false),
    }
    Ok(EXIT_OK)
}

/// Text lines for a tab listing, or None when the rows aren't full identity
/// rows (e.g. `--fields id,url`).
fn render(data: &Value) -> Option<Vec<String>> {
    let rows = data.as_array()?;
    rows.iter().map(format_row).collect()
}

/// A multi-bind listing appends `{"note": "..."}` rows for browsers that did
/// not answer; everything else is a tab row.
fn format_row(t: &Value) -> Option<String> {
    if let Some(note) = t.get("note").and_then(Value::as_str) {
        return Some(format!("note: {note}"));
    }
    format_tab_line(t)
}

fn format_tab_line(t: &Value) -> Option<String> {
    let index = t.get("index")?.as_u64()?;
    let id = t.get("id")?.as_str()?;
    let title = t.get("title").and_then(Value::as_str).unwrap_or("");
    let browser = t
        .get("browser")
        .and_then(Value::as_str)
        .unwrap_or("Browser");
    let profile = t.get("profile").and_then(Value::as_str).unwrap_or("—");
    let mut place = format!("{browser} · {profile}");
    if let Some(w) = t.get("window").and_then(Value::as_u64) {
        place.push_str(&format!(" · win {w}"));
    }
    let mut parts = vec![
        format!("#{index}"),
        id.to_string(),
        serde_json::to_string(title).unwrap_or_default(),
        place,
    ];
    if t.get("active").and_then(Value::as_bool) == Some(true) {
        parts.push("active".to_string());
    }
    if let Some(c) = t.get("controlledBy") {
        parts.push(format!("controlledBy={}", owner_label(c)));
    }
    Some(parts.join("  "))
}

/// `you`, the agent's name, `<cwd basename>/<pid>`, else `:<port>`; `none`
/// for a free tab. A bare number is an older daemon's port-only owner. The
/// daemon already sends another agent's cwd as a cleaned basename
/// (`cwdLabel`); taking the basename again keeps older daemons' full paths
/// readable. Must match `ownerLabel` in src/tab-identity.ts.
fn owner_label(c: &Value) -> String {
    if c.is_null() {
        return "none".to_string();
    }
    if let Some(p) = c.as_u64() {
        return format!(":{p}");
    }
    if c.get("self").and_then(Value::as_bool) == Some(true) {
        return "you".to_string();
    }
    if let Some(name) = c.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) {
        return name.to_string();
    }
    let cwd = c.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty());
    let pid = c.get("pid").and_then(Value::as_u64);
    if let (Some(cwd), Some(pid)) = (cwd, pid) {
        let trimmed = cwd.trim_end_matches(['/', '\\']);
        let base = trimmed.rsplit(['/', '\\']).next().filter(|b| !b.is_empty()).unwrap_or(cwd);
        return format!("{base}/{pid}");
    }
    match c.get("port").and_then(Value::as_u64) {
        Some(p) => format!(":{p}"),
        None => "?".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bridge_row_has_full_identity() {
        let row = json!({
            "index": 3, "id": "edge-dag-tech:42", "chromeTabId": 42, "browser": "Edge", "profile": "DAG Tech",
            "windowId": 1016942846u64, "window": 2, "title": "Bank feeds - QuickBooks", "url": "https://x",
            "active": true,
            "controlledBy": {"port": 9224, "pid": 4589, "name": null, "cwd": "/tmp/ghax-sub", "self": false}
        });
        assert_eq!(
            format_tab_line(&row).unwrap(),
            "#3  edge-dag-tech:42  \"Bank feeds - QuickBooks\"  Edge · DAG Tech · win 2  active  controlledBy=ghax-sub/4589"
        );
    }

    #[test]
    fn owner_labels() {
        assert_eq!(owner_label(&Value::Null), "none");
        assert_eq!(owner_label(&json!(9223)), ":9223");
        assert_eq!(owner_label(&json!({"port": 9223, "pid": 1, "name": "x", "cwd": "/a", "self": true})), "you");
        assert_eq!(owner_label(&json!({"port": 9223, "pid": 1, "name": "claude-a", "cwd": "/a", "self": false})), "claude-a");
        assert_eq!(owner_label(&json!({"port": 9225, "pid": null, "name": null, "cwd": null, "self": false})), ":9225");
        // Current daemons send the basename already (cwdLabel); an older one
        // sends the full path. Both print `<basename>/<pid>`.
        assert_eq!(owner_label(&json!({"port": 9224, "pid": 7, "name": null, "cwd": "ghax", "self": false})), "ghax/7");
        assert_eq!(
            owner_label(&json!({"port": 9224, "pid": 7, "name": null,
                "cwd": "/Users/someone/Documents/a/very/long/path/that/exceeds/forty/chars/ghax/", "self": false})),
            "ghax/7"
        );
    }

    #[test]
    fn free_and_cdp_rows() {
        let free = json!({"index": 1, "id": "edge-1a2b3c:5", "title": "a", "browser": "Edge",
            "profile": "—", "window": 1, "controlledBy": null, "active": false});
        assert_eq!(
            format_tab_line(&free).unwrap(),
            "#1  edge-1a2b3c:5  \"a\"  Edge · — · win 1  controlledBy=none"
        );
        // CDP rows carry no controlledBy at all.
        let cdp =
            json!({"index": 2, "id": "ABCD", "title": "t", "browser": "Chrome", "profile": "—", "active": true});
        assert_eq!(
            format_tab_line(&cdp).unwrap(),
            "#2  ABCD  \"t\"  Chrome · —  active"
        );
    }

    #[test]
    fn note_rows_render_inline() {
        let rows = json!([
            {"index": 1, "id": "a:1", "title": "t", "browser": "Edge", "profile": "—"},
            {"note": "chrome-x: tabs unavailable"}
        ]);
        let lines = render(&rows).unwrap();
        assert_eq!(lines[1], "note: chrome-x: tabs unavailable");
    }

    #[test]
    fn fields_subset_falls_back() {
        assert!(render(&json!([{"id": "1", "url": "u"}])).is_none());
        assert_eq!(render(&json!([])).unwrap().len(), 0);
    }
}
