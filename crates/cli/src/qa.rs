//! `ghax qa` — multi-URL quality-assurance runner.
//!
//! Mirrors `cmdQa()` in `src/cli.ts` exactly. For each URL the command:
//!   1. Navigates via the `goto` RPC.
//!   2. Waits 500 ms for SPA hydration.
//!   3. Takes a snapshot and counts refs.
//!   4. Optionally screenshots the page.
//!   5. Pulls the console + network buffers, filtering to entries since
//!      page-load started.
//!   6. Aggregates into a `QaReport` JSON that matches the TS shape
//!      byte-for-byte (so downstream tools that parse the report don't break).
//!
//! URL sources (in order, same as TS):
//!   1. `--urls a,b,c`     (comma-joined)
//!   2. `--url <u>`        (repeatable — recovered from `parsed.raw`)
//!   3. Positional args that look like URLs
//!   4. `--crawl <root>`   (sitemap.xml if present, else BFS link crawl)

use crate::args::Parsed;
use crate::dispatch::{EXIT_CDP_ERROR, EXIT_OK, EXIT_USAGE};
use crate::rpc;
use crate::state;
use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ── JSON report types ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsoleErrorEntry {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedRequestEntry {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    method: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QaPageReport {
    url: String,
    final_url: String,
    title: String,
    load_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    screenshot_path: Option<String>,
    ref_count: u64,
    console_errors: Vec<ConsoleErrorEntry>,
    failed_requests: Vec<FailedRequestEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QaReport {
    started_at: String,
    duration_ms: u64,
    urls_attempted: usize,
    urls_ok: usize,
    pages: Vec<QaPageReport>,
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Extract all values for a repeatable `--flag` from `raw` argv, matching
/// TS: `argv[i] === '--url' && argv[i+1]` plus `--url=<value>`.
fn collect_repeated_flag<'a>(raw: &'a [String], flag: &str) -> Vec<&'a str> {
    let long = format!("--{flag}");
    let prefix = format!("--{flag}=");
    let mut out = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == long {
            if let Some(val) = raw.get(i + 1) {
                if !val.starts_with('-') {
                    out.push(val.as_str());
                    i += 2;
                    continue;
                }
            }
        } else if let Some(val) = raw[i].strip_prefix(&prefix) {
            out.push(val);
        }
        i += 1;
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

fn iso_now() -> String {
    // Use chrono-free ISO-8601 formatting.
    // Format: 2006-01-02T15:04:05.000Z
    let ms = now_ms();
    let secs = ms / 1000;
    let millis = ms % 1000;
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400; // days since epoch
    // Compute year/month/day from days-since-epoch (Gregorian proleptic calendar).
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

/// Minimal Gregorian calendar conversion, days since 1970-01-01.
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Algorithm from https://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Sanitise a URL for use as a PNG filename (matches TS impl).
fn safe_filename(url: &str) -> String {
    let stripped = url.trim_start_matches("https://").trim_start_matches("http://");
    let sanitised: String = stripped
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect();
    sanitised.chars().take(80).collect()
}

/// Fetch and parse `<loc>...</loc>` entries from a sitemap.xml.
fn fetch_sitemap(url: &str) -> Vec<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default();
    let Ok(resp) = client.get(url).send() else { return vec![] };
    if !resp.status().is_success() {
        return vec![];
    }
    let Ok(body) = resp.text() else { return vec![] };
    // Regex-free extraction of <loc>...</loc> values (matches TS `body.matchAll`).
    let mut out = Vec::new();
    let mut rest = body.as_str();
    while let Some(start) = rest.find("<loc>") {
        rest = &rest[start + 5..];
        if let Some(end) = rest.find("</loc>") {
            let loc = rest[..end].trim();
            if !loc.is_empty() {
                out.push(loc.to_string());
            }
            rest = &rest[end + 6..];
        } else {
            break;
        }
    }
    out
}

/// BFS link crawl from `root`, staying within `origin`. Fallback when no sitemap.
fn scrape_links(url: &str, origin: &str) -> Vec<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("ghax-qa-crawler/0.4")
        .build()
        .unwrap_or_default();
    let Ok(resp) = client.get(url).send() else { return vec![] };
    if !resp.status().is_success() {
        return vec![];
    }
    let Ok(html) = resp.text() else { return vec![] };
    // Extract href= attributes from <a> tags.
    let mut hrefs: HashSet<String> = HashSet::new();
    let mut rest = html.as_str();
    while let Some(a_pos) = find_ci(rest, "<a ") {
        rest = &rest[a_pos + 3..];
        let tag_end = rest.find('>').unwrap_or(rest.len());
        let tag = &rest[..tag_end];
        if let Some(href) = extract_href(tag) {
            if !href.starts_with('#') {
                // Resolve relative href against base URL.
                if let Some(abs) = resolve_url(url, &href) {
                    // Only keep same-origin, strip fragments.
                    let no_frag = abs.split('#').next().unwrap_or(&abs).to_string();
                    if no_frag.starts_with(origin) {
                        hrefs.insert(no_frag);
                    }
                }
            }
        }
        rest = &rest[tag_end..];
    }
    hrefs.into_iter().collect()
}

fn find_ci(s: &str, needle: &str) -> Option<usize> {
    let s_lower = s.to_lowercase();
    let n_lower = needle.to_lowercase();
    s_lower.find(&n_lower)
}

fn extract_href(tag: &str) -> Option<String> {
    // Find href="..." or href='...'
    let lower = tag.to_lowercase();
    let pos = lower.find("href=")?;
    let after = &tag[pos + 5..];
    let (quote, after) = if after.starts_with('"') {
        ('"', &after[1..])
    } else if after.starts_with('\'') {
        ('\'', &after[1..])
    } else {
        return None;
    };
    let end = after.find(quote).unwrap_or(after.len());
    let href = after[..end].trim().to_string();
    if href.is_empty() { None } else { Some(href) }
}

/// Minimal URL resolution (absolute URLs pass through, relative paths are joined).
fn resolve_url(base: &str, href: &str) -> Option<String> {
    if href.starts_with("http://") || href.starts_with("https://") {
        return Some(href.to_string());
    }
    // Extract origin + path from base.
    let (scheme_end, _) = base.split_once("://")?;
    let full_prefix = format!("{scheme_end}://");
    let rest = &base[full_prefix.len()..];
    let slash = rest.find('/');
    let host = match slash {
        Some(i) => &rest[..i],
        None => rest,
    };
    let base_path = match slash {
        Some(i) => &rest[i..],
        None => "/",
    };
    if href.starts_with('/') {
        Some(format!("{full_prefix}{host}{href}"))
    } else {
        // Relative: resolve against directory of base_path.
        let dir = base_path.rfind('/').map_or("/", |i| &base_path[..=i]);
        Some(format!("{full_prefix}{host}{dir}{href}"))
    }
}

/// Crawl URLs under `root`: sitemap first, BFS fallback.
fn crawl_urls(root: &str, depth: usize, limit: usize) -> Vec<String> {
    // Derive origin (scheme + host) from root.
    let origin = {
        let Some((before, after)) = root.split_once("://") else {
            return vec![];
        };
        let host = after.split('/').next().unwrap_or(after);
        format!("{before}://{host}")
    };

    let sitemap_url = format!("{origin}/sitemap.xml");
    let sitemap = fetch_sitemap(&sitemap_url);
    if !sitemap.is_empty() {
        let mut found: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for u in sitemap {
            // Keep only same-origin URLs.
            if u.starts_with(&origin) {
                if seen.insert(u.clone()) {
                    found.push(u);
                }
            }
            if found.len() >= limit {
                break;
            }
        }
        return found;
    }

    // BFS fallback.
    struct QueueItem {
        url: String,
        d: usize,
    }
    let mut queue: std::collections::VecDeque<QueueItem> = std::collections::VecDeque::new();
    queue.push_back(QueueItem { url: root.to_string(), d: 0 });
    let mut visited: HashSet<String> = HashSet::new();
    let mut found: Vec<String> = Vec::new();

    while let Some(item) = queue.pop_front() {
        if found.len() >= limit {
            break;
        }
        if visited.contains(&item.url) {
            continue;
        }
        visited.insert(item.url.clone());
        found.push(item.url.clone());

        if item.d < depth {
            let links = scrape_links(&item.url, &origin);
            for link in links {
                if !visited.contains(&link) {
                    queue.push_back(QueueItem { url: link, d: item.d + 1 });
                }
                if found.len() + queue.len() >= limit {
                    break;
                }
            }
        }
    }
    found.into_iter().take(limit).collect()
}

// ── Main entry point ───────────────────────────────────────────────────────

pub fn cmd_qa(parsed: &Parsed) -> Result<i32> {
    // ── Collect URLs ──
    let mut urls: Vec<String> = Vec::new();

    // 1. --urls a,b,c
    if let Some(Value::String(s)) = parsed.flags.get("urls") {
        for part in s.split(',') {
            let trimmed = part.trim();
            if !trimmed.is_empty() {
                urls.push(trimmed.to_string());
            }
        }
    }

    // 2. Repeatable --url (recovered from raw argv).
    for val in collect_repeated_flag(&parsed.raw, "url") {
        urls.push(val.to_string());
    }

    // 3. Positional args that look like URLs.
    for p in &parsed.positional {
        if p.starts_with("http://") || p.starts_with("https://") {
            urls.push(p.clone());
        }
    }

    // 4. --crawl <root>
    let crawl_root = parsed.flags.get("crawl").and_then(|v| v.as_str()).map(str::to_string);
    let crawl_depth = parsed.flags.get("depth").and_then(|v| v.as_str()).and_then(|s| s.parse::<usize>().ok()).unwrap_or(1);
    let crawl_limit = parsed.flags.get("limit").and_then(|v| v.as_str()).and_then(|s| s.parse::<usize>().ok()).unwrap_or(20);

    if let Some(ref root) = crawl_root {
        let crawled = crawl_urls(root, crawl_depth, crawl_limit);
        eprintln!("crawl discovered {} URLs under {}", crawled.len(), root);
        urls.extend(crawled);
    }

    if urls.is_empty() {
        eprintln!("Usage: ghax qa --url <u> [--url <u> ...] [--out <report.json>] [--screenshots <dir>]");
        eprintln!("       ghax qa --urls a.com,b.com");
        eprintln!("       ghax qa --crawl https://example.com [--depth 1] [--limit 20]");
        return Ok(EXIT_USAGE);
    }

    // Dedupe while preserving order (mirrors TS Set + push pattern).
    let mut seen: HashSet<String> = HashSet::new();
    let urls: Vec<String> = urls
        .into_iter()
        .filter(|u| seen.insert(u.clone()))
        .collect();

    // ── Options ──
    let out_path = parsed.flags.get("out").and_then(|v| v.as_str()).unwrap_or("/tmp/ghax-qa-report.json").to_string();
    let no_screenshots = matches!(parsed.flags.get("no-screenshots"), Some(Value::Bool(true)));
    let shots_dir: Option<String> = if no_screenshots {
        None
    } else {
        Some(
            parsed.flags.get("screenshots")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("/tmp/ghax-qa-shots-{}", now_ms())),
        )
    };
    let annotate = matches!(parsed.flags.get("annotate"), Some(Value::Bool(true)));
    let gif_out = parsed.flags.get("gif").and_then(|v| v.as_str()).map(str::to_string);

    if let Some(ref dir) = shots_dir {
        std::fs::create_dir_all(dir).ok();
    }

    // ── Daemon ──
    let cfg = state::resolve_config();
    let port = state::require_daemon(&cfg)?;

    let started_ms = now_ms();
    let started_at = iso_now();
    let mut report = QaReport {
        started_at,
        duration_ms: 0,
        urls_attempted: urls.len(),
        urls_ok: 0,
        pages: Vec::new(),
    };

    for url in &urls {
        eprintln!("→ {url}");
        let page_start = now_ms();

        // ── Navigate ──
        let nav_result = rpc::call(port, "goto", json!([url]), json!({}));
        let page_entry = match nav_result {
            Err(e) => {
                eprintln!("  ✗ {}", e);
                QaPageReport {
                    url: url.clone(),
                    final_url: url.clone(),
                    title: String::new(),
                    load_ms: now_ms() - page_start,
                    screenshot_path: None,
                    ref_count: 0,
                    console_errors: vec![ConsoleErrorEntry { text: format!("[qa] {e}"), url: None }],
                    failed_requests: vec![],
                }
            }
            Ok(nav) => {
                // Wait 500 ms for SPA hydration (matches TS).
                std::thread::sleep(Duration::from_millis(500));

                let final_url = nav.get("url").and_then(|v| v.as_str()).unwrap_or(url.as_str()).to_string();
                let title = nav.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();

                // ── Snapshot ──
                let snap_opts = if annotate { json!({ "interactive": true, "annotate": true }) } else { json!({ "interactive": true }) };
                let snap_res = rpc::call(port, "snapshot", json!([]), snap_opts).unwrap_or(Value::Null);
                let ref_count = snap_res.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
                let annotated_path = snap_res.get("annotatedPath").and_then(|v| v.as_str()).map(str::to_string);

                // ── Screenshot ──
                let mut screenshot_path: Option<String> = None;
                if let Some(ref dir) = shots_dir {
                    let safe = safe_filename(url);
                    let path = if annotate {
                        annotated_path.clone().unwrap_or_else(|| format!("{dir}/{safe}.png"))
                    } else {
                        format!("{dir}/{safe}.png")
                    };
                    if !annotate {
                        let _ = rpc::call(port, "screenshot", json!([]), json!({ "path": path, "fullPage": true }));
                    }
                    screenshot_path = Some(path);
                }

                // ── Console errors ──
                let console_log = rpc::call(port, "console", json!([]), json!({ "last": 200 })).unwrap_or(Value::Array(vec![]));
                let console_errors: Vec<ConsoleErrorEntry> = console_log
                    .as_array()
                    .unwrap_or(&vec![])
                    .iter()
                    .filter(|e| {
                        let level = e.get("level").and_then(|v| v.as_str()).unwrap_or("");
                        let ts = e.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0);
                        level == "error" && ts >= page_start
                    })
                    .map(|e| ConsoleErrorEntry {
                        text: e.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        url: e.get("url").and_then(|v| v.as_str()).map(str::to_string),
                    })
                    .collect();

                // ── Failed network requests ──
                let net_log = rpc::call(port, "network", json!([]), json!({ "last": 500 })).unwrap_or(Value::Array(vec![]));
                let failed_requests: Vec<FailedRequestEntry> = net_log
                    .as_array()
                    .unwrap_or(&vec![])
                    .iter()
                    .filter(|e| {
                        let ts = e.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0);
                        let status = e.get("status").and_then(|v| v.as_u64()).unwrap_or(0);
                        ts >= page_start && status >= 400
                    })
                    .map(|e| FailedRequestEntry {
                        url: e.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        status: e.get("status").and_then(|v| v.as_u64()).map(|n| n as u16),
                        method: e.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_string(),
                    })
                    .collect();

                let err_tag = if console_errors.is_empty() { String::new() } else { format!(", {} console errors", console_errors.len()) };
                let net_tag = if failed_requests.is_empty() { String::new() } else { format!(", {} failed requests", failed_requests.len()) };
                eprintln!("  ✓ {ref_count} refs{err_tag}{net_tag}");

                QaPageReport {
                    url: url.clone(),
                    final_url,
                    title,
                    load_ms: now_ms() - page_start,
                    screenshot_path,
                    ref_count,
                    console_errors,
                    failed_requests,
                }
            }
        };

        // Mirror TS: `report.urlsOk++` inside the try block (only on nav success).
        // The error branch inserts a `[qa] <message>` console error — use that
        // as the sentinel, matching exactly what the TS `catch` block does.
        let had_nav_error = page_entry.console_errors.iter().any(|e| e.text.starts_with("[qa] "));
        if !had_nav_error {
            report.urls_ok += 1;
        }
        report.pages.push(page_entry);
    }

    report.duration_ms = now_ms() - started_ms;

    // ── Write report ──
    let json_str = serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(&out_path, &json_str)?;
    eprintln!("\nReport → {out_path}");
    eprintln!("  {}/{} pages ok, {}ms total", report.urls_ok, report.urls_attempted, report.duration_ms);
    let total_console = report.pages.iter().map(|p| p.console_errors.len()).sum::<usize>();
    let total_net = report.pages.iter().map(|p| p.failed_requests.len()).sum::<usize>();
    if total_console > 0 { eprintln!("  {total_console} console errors across all pages"); }
    if total_net > 0 { eprintln!("  {total_net} failed requests across all pages"); }

    // ── Optional GIF ──
    if let (Some(gif_path), Some(dir)) = (&gif_out, &shots_dir) {
        let ffmpeg_ok = Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ffmpeg_ok {
            eprintln!("  (skipping --gif: ffmpeg not on PATH)");
        } else {
                let pattern = format!("{dir}/*.png");
                let result = Command::new("ffmpeg")
                    .args([
                        "-y",
                        "-framerate", "1",
                        "-pattern_type", "glob",
                        "-i", &pattern,
                        "-vf", "scale=1024:-1:flags=lanczos",
                        "-loop", "0",
                        gif_path.as_str(),
                    ])
                    .output();
                match result {
                    Ok(out) if out.status.success() => eprintln!("  GIF → {gif_path}"),
                    Ok(out) => {
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ");
                        eprintln!("  ffmpeg failed: {tail}");
                    }
                    Err(e) => eprintln!("  ffmpeg error: {e}"),
                }
        }
    }

    Ok(if report.urls_ok == report.urls_attempted { EXIT_OK } else { EXIT_CDP_ERROR })
}
