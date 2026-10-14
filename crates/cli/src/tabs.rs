//! `ghax tabs` text rendering. The daemon returns one object per tab with its
//! full identity (index, id, browser, profile, ...); `--json` prints that
//! as-is, and the default text form is one aligned-by-separator line per tab:
//!
//!     #3  work:42  "Bank feeds - QuickBooks"  Edge · Work  controlledBy=:9224
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
    let mut parts = vec![
        format!("#{index}"),
        id.to_string(),
        serde_json::to_string(title).unwrap_or_default(),
        format!("{browser} · {profile}"),
    ];
    if let Some(c) = t.get("controlledBy") {
        parts.push(match c.as_u64() {
            Some(p) => format!("controlledBy=:{p}"),
            None => "controlledBy=none".to_string(),
        });
    }
    if t.get("active").and_then(Value::as_bool) == Some(true) {
        parts.push("active".to_string());
    }
    Some(parts.join("  "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bridge_row_has_full_identity() {
        let row = json!({
            "index": 3, "id": "work:42", "chromeTabId": 42, "browser": "Edge", "profile": "Work",
            "windowId": 7, "title": "Bank feeds - QuickBooks", "url": "https://x", "active": false,
            "controlledBy": 9224
        });
        assert_eq!(
            format_tab_line(&row).unwrap(),
            "#3  work:42  \"Bank feeds - QuickBooks\"  Edge · Work  controlledBy=:9224"
        );
    }

    #[test]
    fn free_active_and_cdp_rows() {
        let free = json!({"index": 1, "id": "edge-1a2b3c:5", "title": "a", "browser": "Edge",
            "profile": "—", "controlledBy": null, "active": true});
        assert_eq!(
            format_tab_line(&free).unwrap(),
            "#1  edge-1a2b3c:5  \"a\"  Edge · —  controlledBy=none  active"
        );
        // CDP rows carry no controlledBy at all.
        let cdp =
            json!({"index": 2, "id": "ABCD", "title": "t", "browser": "Chrome", "profile": "—"});
        assert_eq!(
            format_tab_line(&cdp).unwrap(),
            "#2  ABCD  \"t\"  Chrome · —"
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
