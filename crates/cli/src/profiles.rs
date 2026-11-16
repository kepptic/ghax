//! `ghax bridge profiles` — which browser profiles have the ghax bridge
//! extension installed (unpacked), whether or not a window is open.
//!
//! Local-only: reads each Chromium user-data dir's `Local State` and every
//! profile's `Preferences` / `Secure Preferences`. No daemon needed. An
//! extension counts as ghax's when its unpacked path holds a manifest named
//! "ghax bridge" (and, with `--ext-path`, lives at exactly that directory).
//! macOS only; elsewhere the list is empty.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::{Value, json};

use crate::args::Parsed;
use crate::dispatch::EXIT_OK;
use crate::output;

/// (brand, family, macOS app name, user-data dir under Application Support).
/// `family` is the key the bridge hello reports (`detectBrowser()` in
/// extension/background.js: edge, chrome, or chromium for everything else), so
/// Beta/Dev/Canary channels and Brave match their connected instance. Roots
/// mirror MAC in src/browser-profiles.ts.
const BROWSERS: &[(&str, &str, &str, &str)] = &[
    ("edge", "edge", "Microsoft Edge", "Microsoft Edge"),
    (
        "edge-beta",
        "edge",
        "Microsoft Edge Beta",
        "Microsoft Edge Beta",
    ),
    (
        "edge-dev",
        "edge",
        "Microsoft Edge Dev",
        "Microsoft Edge Dev",
    ),
    (
        "edge-canary",
        "edge",
        "Microsoft Edge Canary",
        "Microsoft Edge Canary",
    ),
    ("chrome", "chrome", "Google Chrome", "Google/Chrome"),
    (
        "chrome-beta",
        "chrome",
        "Google Chrome Beta",
        "Google/Chrome Beta",
    ),
    (
        "chrome-dev",
        "chrome",
        "Google Chrome Dev",
        "Google/Chrome Dev",
    ),
    (
        "chrome-canary",
        "chrome",
        "Google Chrome Canary",
        "Google/Chrome Canary",
    ),
    (
        "brave",
        "chromium",
        "Brave Browser",
        "BraveSoftware/Brave-Browser",
    ),
    ("chromium", "chromium", "Chromium", "Chromium"),
];

fn is_ghax_bridge(path: &Path, only: Option<&Path>) -> bool {
    if let Some(want) = only {
        let (a, b) = (path.canonicalize(), want.canonicalize());
        if a.is_err() || a.ok() != b.ok() {
            return false;
        }
    }
    std::fs::read_to_string(path.join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|m| {
            m.get("name")
                .and_then(|n| n.as_str())
                .map(|n| n.to_lowercase())
        })
        .is_some_and(|n| n.contains("ghax bridge"))
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// Paths of unpacked extensions registered in one profile.
fn ext_paths(profile_dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = vec![];
    for f in ["Secure Preferences", "Preferences"] {
        let Some(v) = read_json(&profile_dir.join(f)) else {
            continue;
        };
        let Some(settings) = v
            .pointer("/extensions/settings")
            .and_then(|s| s.as_object())
        else {
            continue;
        };
        for (id, e) in settings {
            if let Some(p) = e.get("path").and_then(|p| p.as_str()) {
                let p = PathBuf::from(p);
                if p.is_absolute() && !out.iter().any(|(i, _)| i == id) {
                    out.push((id.clone(), p));
                }
            }
        }
    }
    out
}

/// Discover profiles under `support` (the Application Support dir).
pub fn discover(support: &Path, only: Option<&Path>) -> Vec<Value> {
    let mut rows = vec![];
    for (brand, family, app, dir) in BROWSERS {
        let root = support.join(dir);
        let Some(state) = read_json(&root.join("Local State")) else {
            continue;
        };
        let Some(cache) = state
            .pointer("/profile/info_cache")
            .and_then(|c| c.as_object())
        else {
            continue;
        };
        for (pdir, info) in cache {
            let name = info.get("name").and_then(|n| n.as_str()).unwrap_or(pdir);
            for (id, p) in ext_paths(&root.join(pdir)) {
                if is_ghax_bridge(&p, only) {
                    rows.push(json!({
                        "browser": brand, "family": family, "app": app, "profileDir": pdir,
                        "profileName": name, "extensionId": id,
                        "extensionPath": p.to_string_lossy(),
                    }));
                    break;
                }
            }
        }
    }
    rows
}

pub fn cmd_bridge_profiles(parsed: &Parsed) -> Result<i32> {
    let support = if cfg!(target_os = "macos") {
        std::env::var_os("GHAX_BROWSER_SUPPORT_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|h| PathBuf::from(h).join("Library/Application Support"))
            })
    } else {
        std::env::var_os("GHAX_BROWSER_SUPPORT_DIR").map(PathBuf::from)
    };
    let only = parsed
        .flags
        .get("ext-path")
        .and_then(|v| v.as_str())
        .map(PathBuf::from);
    let rows = support
        .map(|s| discover(&s, only.as_deref()))
        .unwrap_or_default();
    if parsed.json() {
        output::print(&json!({ "profiles": rows }), true);
        return Ok(EXIT_OK);
    }
    if rows.is_empty() {
        println!(
            "(no browser profile with the ghax bridge extension found; discovery is macOS-only)"
        );
    }
    for r in &rows {
        let g = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or("");
        println!(
            "{:<12} {:<12} \"{}\"  {}",
            g("browser"),
            g("profileDir"),
            g("profileName"),
            g("extensionPath")
        );
    }
    Ok(EXIT_OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_unpacked_bridge_in_windowless_profile() {
        let t = std::env::temp_dir().join(format!("ghax-prof-{}", std::process::id()));
        let ext = t.join("repo/extension");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("manifest.json"), r#"{"name":"ghax bridge"}"#).unwrap();
        let root = t.join("Microsoft Edge");
        std::fs::create_dir_all(root.join("Profile 3")).unwrap();
        std::fs::write(
            root.join("Local State"),
            r#"{"profile":{"info_cache":{"Profile 3":{"name":"KEPPTIC"},"Default":{"name":"x"}}}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("Profile 3/Secure Preferences"),
            format!(
                r#"{{"extensions":{{"settings":{{"abc":{{"path":{:?}}}}}}}}}"#,
                ext.to_string_lossy()
            ),
        )
        .unwrap();
        // Chrome Beta and Edge Canary: own roots, family matches the hello.
        for (d, name) in [
            ("Google/Chrome Beta", "BETA"),
            ("Microsoft Edge Canary", "CAN"),
        ] {
            let r = t.join(d);
            std::fs::create_dir_all(r.join("Default")).unwrap();
            std::fs::write(
                r.join("Local State"),
                format!(r#"{{"profile":{{"info_cache":{{"Default":{{"name":"{name}"}}}}}}}}"#),
            )
            .unwrap();
            std::fs::write(
                r.join("Default/Preferences"),
                format!(
                    r#"{{"extensions":{{"settings":{{"abc":{{"path":{:?}}}}}}}}}"#,
                    ext.to_string_lossy()
                ),
            )
            .unwrap();
        }
        let all = discover(&t, Some(&ext));
        let fam = |n: &str| {
            all.iter().find(|r| r["profileName"] == n).map(|r| {
                (
                    r["browser"].as_str().unwrap().to_string(),
                    r["family"].as_str().unwrap().to_string(),
                )
            })
        };
        assert_eq!(fam("BETA"), Some(("chrome-beta".into(), "chrome".into())));
        assert_eq!(fam("CAN"), Some(("edge-canary".into(), "edge".into())));
        let rows: Vec<Value> = all
            .into_iter()
            .filter(|r| r["profileName"] == "KEPPTIC")
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["profileName"], "KEPPTIC");
        assert!(discover(&t, Some(&t.join("other"))).is_empty());
        let _ = std::fs::remove_dir_all(&t);
    }
}
