//! Phase 2B medium verbs.
//!
//! Each function is a self-contained port of the corresponding TS command in
//! `src/cli.ts`. They are `pub` so `dispatch.rs` can call them directly once
//! the Phase 2B wiring is added there.
//!
//! Verbs implemented here:
//!   status       → cmdStatus
//!   pair status  → cmd_pair_status
//!   diff-state   → cmd_diff_state
//!   chain        → cmd_chain
//!   replay       → cmd_replay
//!   gif          → cmd_gif

use crate::args;
use crate::dispatch::{EXIT_CDP_ERROR, EXIT_NOT_ATTACHED, EXIT_OK, EXIT_USAGE};
use crate::output;
use crate::rpc::{self, RpcError};
use crate::state::{self, read_state};
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::Read as _;

// ─── status ──────────────────────────────────────────────────────────────────

/// `ghax status` — mirrors `cmdStatus` in cli.ts.
///
/// If not attached (no state or daemon unreachable) prints "not attached" and
/// returns EXIT_NOT_ATTACHED.  Otherwise does RPC `status` and pretty-prints
/// tabs / targets / extensions / uptime, or `--json` for the raw object.
pub fn cmd_status(rest: &[String]) -> Result<i32> {
    let parsed = args::parse(rest);
    let cfg = state::resolve_config();
    let Some(daemon_state) = read_state(&cfg) else {
        println!("not attached");
        return Ok(EXIT_NOT_ATTACHED);
    };
    // Health-check the daemon; treat failure as "not attached".
    let port = match state::require_daemon(&cfg) {
        Ok(p) => p,
        Err(_) => {
            println!("not attached");
            return Ok(EXIT_NOT_ATTACHED);
        }
    };

    let data = rpc::call(port, "status", json!([]), json!({}))?;

    if parsed.json() {
        // Merge daemon state fields + RPC data — mirrors `{ ...state, ...data }`.
        let mut merged = serde_json::json!({
            "pid":         daemon_state.pid,
            "port":        daemon_state.port,
            "browserUrl":  daemon_state.browser_url,
            "browserKind": daemon_state.browser_kind,
            "attachedAt":  daemon_state.attached_at,
            "cwd":         daemon_state.cwd,
        });
        if let (Some(m), Some(data_obj)) = (merged.as_object_mut(), data.as_object()) {
            for (k, v) in data_obj {
                m.insert(k.clone(), v.clone());
            }
        }
        println!("{}", serde_json::to_string_pretty(&merged).unwrap_or_else(|_| "{}".into()));
    } else {
        let uptime_ms = data.get("uptimeMs").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let up_min = (uptime_ms / 60000.0).floor() as u64;
        // Mirror TS: strip everything from '/devtools/' onward.
        let browser_url_short = daemon_state
            .browser_url
            .split("/devtools/")
            .next()
            .unwrap_or(&daemon_state.browser_url);
        println!("attached    {} ({})", daemon_state.browser_kind, browser_url_short);
        println!("daemon      pid {}, port {}, up {}m", daemon_state.pid, daemon_state.port, up_min);
        println!("tabs        {}", data.get("tabCount").and_then(|v| v.as_u64()).unwrap_or(0));
        println!("targets     {}", data.get("targetCount").and_then(|v| v.as_u64()).unwrap_or(0));
        println!("extensions  {}", data.get("extensionCount").and_then(|v| v.as_u64()).unwrap_or(0));
        println!("cwd         {}", daemon_state.cwd);
    }
    Ok(EXIT_OK)
}

// ─── pair status ─────────────────────────────────────────────────────────────

/// `ghax pair status` — mirrors the `status`/`info` branch of `cmdPair`.
///
/// Only the `status` subcommand is shipped; the broader `pair` suite is
/// deferred as noted in CLAUDE.md.
pub fn cmd_pair(rest: &[String]) -> Result<i32> {
    let parsed = args::parse(rest);
    let sub = parsed.positional.first().map(|s| s.as_str()).unwrap_or("status");
    match sub {
        "status" | "info" => {
            let cfg = state::resolve_config();
            let Some(daemon_state) = read_state(&cfg) else {
                println!("not attached — run `ghax attach` first");
                return Ok(EXIT_NOT_ATTACHED);
            };
            // Mirror TS output verbatim.
            let user = std::env::var("USER").unwrap_or_else(|_| "$(whoami)".to_string());
            println!("ghax pair — v0 (SSH-tunnel mode)");
            println!();
            println!("Local daemon: 127.0.0.1:{} (pid {})", daemon_state.port, daemon_state.pid);
            println!("Browser:      {}", daemon_state.browser_kind);
            println!();
            println!("To share with a remote agent:");
            println!();
            println!("  # On the machine where the remote agent runs, tunnel in:");
            println!(
                "  ssh -N -L {p}:127.0.0.1:{p} {u}@<this-host>",
                p = daemon_state.port,
                u = user
            );
            println!();
            println!("  # Then on that remote agent's machine, point its ghax CLI at");
            println!("  # the tunneled port — standard localhost RPC, no auth changes.");
            println!();
            println!("A proper multi-tenant token-auth mode is deferred to v0.5.");
            println!("Raised because:");
            println!("  - RPC surface is large; any bug is now remotely exploitable.");
            println!("  - We need URL allowlists per token.");
            println!("  - Need to decide bind semantics (0.0.0.0 vs Tailscale ts0).");
            Ok(EXIT_OK)
        }
        other => {
            eprintln!("ghax pair: unknown sub-command {other}");
            eprintln!("       ghax pair status | info");
            Ok(EXIT_USAGE)
        }
    }
}

// ─── diff-state ──────────────────────────────────────────────────────────────

/// A diff entry produced by the recursive JSON walk.
struct DiffEntry {
    path: String,
    kind: DiffKind,
    before: Option<Value>,
    after: Option<Value>,
}

enum DiffKind {
    Added,
    Removed,
    Changed,
}

/// `ghax diff-state <before.json> <after.json>` — mirrors `cmdDiffState`.
///
/// Performs the JSON-Pointer-path recursive diff in Rust (no daemon RPC needed;
/// the TS implementation also did this entirely client-side).
pub fn cmd_diff_state(rest: &[String]) -> Result<i32> {
    let parsed = args::parse(rest);
    let before_path = match parsed.positional.first() {
        Some(p) => p.clone(),
        None => {
            eprintln!("Usage: ghax diff-state <before.json> <after.json> [--json]");
            return Ok(EXIT_USAGE);
        }
    };
    let after_path = match parsed.positional.get(1) {
        Some(p) => p.clone(),
        None => {
            eprintln!("Usage: ghax diff-state <before.json> <after.json> [--json]");
            return Ok(EXIT_USAGE);
        }
    };

    let before: Value = match std::fs::read_to_string(&before_path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!("ghax diff-state: cannot read {before_path}: {e}");
            return Ok(EXIT_USAGE);
        }
    };
    let after: Value = match std::fs::read_to_string(&after_path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!("ghax diff-state: cannot read {after_path}: {e}");
            return Ok(EXIT_USAGE);
        }
    };

    let mut diffs: Vec<DiffEntry> = Vec::new();
    diff_values("", &before, &after, &mut diffs);

    if parsed.json() {
        let added = diffs.iter().filter(|d| matches!(d.kind, DiffKind::Added)).count();
        let removed = diffs.iter().filter(|d| matches!(d.kind, DiffKind::Removed)).count();
        let changed = diffs.iter().filter(|d| matches!(d.kind, DiffKind::Changed)).count();
        let arr: Vec<Value> = diffs
            .iter()
            .map(|d| match d.kind {
                DiffKind::Added => json!({
                    "path": d.path,
                    "kind": "added",
                    "after": d.after,
                }),
                DiffKind::Removed => json!({
                    "path": d.path,
                    "kind": "removed",
                    "before": d.before,
                }),
                DiffKind::Changed => json!({
                    "path": d.path,
                    "kind": "changed",
                    "before": d.before,
                    "after": d.after,
                }),
            })
            .collect();
        let out = json!({
            "diffs": arr,
            "added": added,
            "removed": removed,
            "changed": changed,
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".into()));
    } else if diffs.is_empty() {
        println!("(no differences)");
    } else {
        for d in &diffs {
            let p = if d.path.is_empty() { "/" } else { &d.path };
            match d.kind {
                DiffKind::Added => {
                    println!(
                        "+ {} = {}",
                        p,
                        serde_json::to_string(d.after.as_ref().unwrap_or(&Value::Null))
                            .unwrap_or_default()
                    );
                }
                DiffKind::Removed => {
                    println!(
                        "- {} = {}",
                        p,
                        serde_json::to_string(d.before.as_ref().unwrap_or(&Value::Null))
                            .unwrap_or_default()
                    );
                }
                DiffKind::Changed => {
                    println!(
                        "~ {}: {} → {}",
                        p,
                        serde_json::to_string(d.before.as_ref().unwrap_or(&Value::Null))
                            .unwrap_or_default(),
                        serde_json::to_string(d.after.as_ref().unwrap_or(&Value::Null))
                            .unwrap_or_default()
                    );
                }
            }
        }
    }
    Ok(EXIT_OK)
}

/// Recursive JSON-Pointer-path diff, ported from `diffValues` in cli.ts.
fn diff_values(path: &str, a: &Value, b: &Value, out: &mut Vec<DiffEntry>) {
    if a == b {
        return;
    }
    match (a, b) {
        (Value::Object(ao), Value::Object(bo)) => {
            // Preserve insertion-order iteration where possible; use BTreeSet
            // only for the union-of-keys to guarantee deterministic ordering.
            let keys: BTreeSet<&str> =
                ao.keys().map(|s| s.as_str()).chain(bo.keys().map(|s| s.as_str())).collect();
            for k in keys {
                // JSON Pointer escaping: ~ → ~0, / → ~1.
                let escaped = k.replace('~', "~0").replace('/', "~1");
                let sub = format!("{path}/{escaped}");
                match (ao.get(k), bo.get(k)) {
                    (None, Some(bv)) => out.push(DiffEntry {
                        path: sub,
                        kind: DiffKind::Added,
                        before: None,
                        after: Some(bv.clone()),
                    }),
                    (Some(av), None) => out.push(DiffEntry {
                        path: sub,
                        kind: DiffKind::Removed,
                        before: Some(av.clone()),
                        after: None,
                    }),
                    (Some(av), Some(bv)) => diff_values(&sub, av, bv, out),
                    (None, None) => {}
                }
            }
        }
        (Value::Array(aa), Value::Array(ba)) => {
            let max = aa.len().max(ba.len());
            for i in 0..max {
                let sub = format!("{path}/{i}");
                match (aa.get(i), ba.get(i)) {
                    (None, Some(bv)) => out.push(DiffEntry {
                        path: sub,
                        kind: DiffKind::Added,
                        before: None,
                        after: Some(bv.clone()),
                    }),
                    (Some(av), None) => out.push(DiffEntry {
                        path: sub,
                        kind: DiffKind::Removed,
                        before: Some(av.clone()),
                        after: None,
                    }),
                    (Some(av), Some(bv)) => diff_values(&sub, av, bv, out),
                    (None, None) => {}
                }
            }
        }
        // Different types or different scalar values.
        _ => out.push(DiffEntry {
            path: path.to_string(),
            kind: DiffKind::Changed,
            before: Some(a.clone()),
            after: Some(b.clone()),
        }),
    }
}

// ─── chain ───────────────────────────────────────────────────────────────────

/// `ghax chain` — reads a JSON array of `{cmd, args?, opts?}` from stdin and
/// executes each step against the daemon in sequence. Mirrors `cmdChain`.
///
/// `chain` always prints results as JSON (the TS implementation hard-codes
/// `printResult(results, true)`). Returns EXIT_CDP_ERROR if any step failed.
pub fn cmd_chain(rest: &[String]) -> Result<i32> {
    let parsed = args::parse(rest);
    let stop_on_error = parsed
        .flags
        .get("stopOnError")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    // Read stdin. If stdin is a TTY (not piped), surface a usage hint and exit.
    let body = {
        let mut s = String::new();
        if let Err(e) = std::io::stdin().read_to_string(&mut s) {
            eprintln!("ghax chain: cannot read stdin: {e}");
            return Ok(EXIT_USAGE);
        }
        s
    };
    if body.trim().is_empty() {
        eprintln!("Usage: ghax chain < steps.json");
        return Ok(EXIT_USAGE);
    }

    let steps: Vec<Value> = match serde_json::from_str::<Value>(&body) {
        Ok(Value::Array(arr)) => arr,
        Ok(other) => vec![other],
        Err(e) => {
            eprintln!("ghax chain: invalid JSON — {e}");
            return Ok(EXIT_USAGE);
        }
    };

    let cfg = state::resolve_config();
    let port = match state::require_daemon(&cfg) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ghax: {e}");
            return Ok(EXIT_NOT_ATTACHED);
        }
    };

    let mut results: Vec<Value> = Vec::new();
    let mut any_failed = false;

    for step in &steps {
        let cmd = match step.get("cmd").and_then(|v| v.as_str()) {
            Some(c) => c.to_string(),
            None => {
                results.push(json!({ "cmd": "<missing>", "ok": false, "error": "step missing cmd" }));
                any_failed = true;
                if stop_on_error {
                    break;
                }
                continue;
            }
        };
        let args = step.get("args").cloned().unwrap_or(Value::Array(vec![]));
        let opts = step.get("opts").cloned().unwrap_or(json!({}));
        match rpc::call(port, &cmd, args, opts) {
            Ok(data) => {
                results.push(json!({ "cmd": cmd, "ok": true, "data": data }));
            }
            Err(err) => {
                let msg = if let Some(rpc_err) = err.downcast_ref::<RpcError>() {
                    rpc_err.message.clone()
                } else {
                    err.to_string()
                };
                results.push(json!({ "cmd": cmd, "ok": false, "error": msg }));
                any_failed = true;
                if stop_on_error {
                    break;
                }
            }
        }
    }

    // chain always outputs JSON (mirrors TS: `printResult(results, Boolean(parsed.flags.json) || true)`)
    output::print(&Value::Array(results), true);
    Ok(if any_failed { EXIT_CDP_ERROR } else { EXIT_OK })
}

// ─── replay ──────────────────────────────────────────────────────────────────

/// `ghax replay <file>` — mirrors `cmdReplay`.
///
/// Reads a recording file (JSON with a top-level `steps` array or a bare
/// array), executes each step in order, and prints `✓`/`✗` per step.
/// Aborts on the first failure.
pub fn cmd_replay(rest: &[String]) -> Result<i32> {
    let parsed = args::parse(rest);
    let file = match parsed.positional.first() {
        Some(f) => f.clone(),
        None => {
            eprintln!("Usage: ghax replay <file>");
            return Ok(EXIT_USAGE);
        }
    };

    let body = match std::fs::read_to_string(&file) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ghax replay: cannot read {file}: {e}");
            return Ok(EXIT_USAGE);
        }
    };
    let steps: Vec<Value> = match serde_json::from_str::<Value>(&body) {
        Ok(Value::Object(ref obj)) if obj.contains_key("steps") => {
            match obj.get("steps").cloned().unwrap_or(Value::Array(vec![])) {
                Value::Array(arr) => arr,
                _ => {
                    eprintln!("ghax replay: `steps` field is not an array");
                    return Ok(EXIT_USAGE);
                }
            }
        }
        Ok(Value::Array(arr)) => arr,
        Ok(_) => {
            eprintln!("ghax replay: invalid recording — expected array or {{steps: [...]}}");
            return Ok(EXIT_USAGE);
        }
        Err(e) => {
            eprintln!("ghax replay: invalid recording — {e}");
            return Ok(EXIT_USAGE);
        }
    };

    let cfg = state::resolve_config();
    let port = match state::require_daemon(&cfg) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ghax: {e}");
            return Ok(EXIT_NOT_ATTACHED);
        }
    };

    for step in &steps {
        let cmd = match step.get("cmd").and_then(|v| v.as_str()) {
            Some(c) => c.to_string(),
            None => {
                eprintln!("✗ <missing cmd> — step missing cmd field");
                return Ok(EXIT_CDP_ERROR);
            }
        };
        let args = step.get("args").cloned().unwrap_or(Value::Array(vec![]));
        let opts = step.get("opts").cloned().unwrap_or(json!({}));
        let args_display = if let Value::Array(ref arr) = args {
            if arr.is_empty() {
                String::new()
            } else {
                format!(" {}", serde_json::to_string(&args).unwrap_or_default())
            }
        } else {
            String::new()
        };
        match rpc::call(port, &cmd, args, opts) {
            Ok(_) => {
                println!("✓ {cmd}{args_display}");
            }
            Err(err) => {
                let msg = if let Some(rpc_err) = err.downcast_ref::<RpcError>() {
                    rpc_err.message.clone()
                } else {
                    err.to_string()
                };
                eprintln!("✗ {cmd} — {msg}");
                return Ok(EXIT_CDP_ERROR);
            }
        }
    }
    Ok(EXIT_OK)
}

// ─── gif ─────────────────────────────────────────────────────────────────────

/// `ghax gif <recording-file> [out.gif] [--delay ms] [--scale px]`
///
/// Mirrors `cmdGif`. Replays the recording step-by-step capturing a screenshot
/// after each step, then shells out to ffmpeg (2-pass palette) to produce the
/// output GIF.
///
/// Default delay: 1000ms, default scale: 800px.
/// Exit code 4 if ffmpeg is not on PATH.
pub fn cmd_gif(rest: &[String]) -> Result<i32> {
    let parsed = args::parse(rest);
    let rec_file = match parsed.positional.first() {
        Some(f) => f.clone(),
        None => {
            eprintln!("Usage: ghax gif <recording-file> [out.gif] [--delay ms] [--scale px]");
            return Ok(EXIT_USAGE);
        }
    };
    let out_gif = parsed
        .positional
        .get(1)
        .cloned()
        .unwrap_or_else(|| format!("/tmp/ghax-{}.gif", unix_ms()));
    let delay_ms: u64 = parsed
        .flags
        .get("delay")
        .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64()))
        .unwrap_or(1000);
    let scale: u64 = parsed
        .flags
        .get("scale")
        .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64()))
        .unwrap_or(800);
    let keep_frames = matches!(parsed.flags.get("keepFrames"), Some(Value::Bool(true)));

    // Fast-fail if ffmpeg is missing.
    if !ffmpeg_available() {
        eprintln!(
            "ghax gif: ffmpeg not found on PATH. \
             Install via `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux)."
        );
        return Ok(EXIT_CDP_ERROR);
    }

    // Parse recording.
    let body = match std::fs::read_to_string(&rec_file) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ghax gif: cannot read {rec_file}: {e}");
            return Ok(EXIT_USAGE);
        }
    };
    let steps: Vec<Value> = match serde_json::from_str::<Value>(&body) {
        Ok(Value::Object(ref obj)) if obj.contains_key("steps") => {
            match obj.get("steps").cloned().unwrap_or(Value::Array(vec![])) {
                Value::Array(arr) => arr,
                _ => {
                    eprintln!("ghax gif: invalid recording — `steps` is not an array");
                    return Ok(EXIT_USAGE);
                }
            }
        }
        Ok(Value::Array(arr)) => arr,
        Ok(_) => {
            eprintln!("ghax gif: invalid recording — expected array or {{steps: [...]}}");
            return Ok(EXIT_USAGE);
        }
        Err(e) => {
            eprintln!("ghax gif: invalid recording — {e}");
            return Ok(EXIT_USAGE);
        }
    };
    if steps.is_empty() {
        eprintln!("ghax gif: recording has no steps");
        return Ok(EXIT_USAGE);
    }

    // Create a tmp directory for frames.
    let tmp_dir = format!("/tmp/ghax-gif-{}", unix_ms());
    std::fs::create_dir_all(&tmp_dir)?;

    println!("rendering {} steps → {}", steps.len(), out_gif);

    let cfg = state::resolve_config();
    let port = match state::require_daemon(&cfg) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ghax: {e}");
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Ok(EXIT_NOT_ATTACHED);
        }
    };

    let mut frame: usize = 0;

    let frame_path = |n: usize| format!("{}/frame-{:04}.png", tmp_dir, n);

    // Capture initial state before any steps run.
    rpc::call(port, "screenshot", json!([]), json!({ "path": frame_path(frame), "fullPage": false }))?;
    frame += 1;

    for (i, step) in steps.iter().enumerate() {
        let cmd = match step.get("cmd").and_then(|v| v.as_str()) {
            Some(c) => c.to_string(),
            None => {
                eprintln!("step {} has no cmd field", i + 1);
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Ok(EXIT_CDP_ERROR);
            }
        };
        let args = step.get("args").cloned().unwrap_or(Value::Array(vec![]));
        let opts = step.get("opts").cloned().unwrap_or(json!({}));
        if let Err(err) = rpc::call(port, &cmd, args, opts) {
            let msg = if let Some(rpc_err) = err.downcast_ref::<RpcError>() {
                rpc_err.message.clone()
            } else {
                err.to_string()
            };
            eprintln!("step {} ({}) failed: {}", i + 1, cmd, msg);
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Ok(EXIT_CDP_ERROR);
        }
        // Let layout settle — mirrors the TS 250ms wait.
        std::thread::sleep(std::time::Duration::from_millis(250));
        rpc::call(port, "screenshot", json!([]), json!({ "path": frame_path(frame), "fullPage": false }))?;
        frame += 1;
    }

    // ffmpeg 2-pass palette GIF.
    let palette = format!("{tmp_dir}/palette.png");
    let frame_pattern = format!("{tmp_dir}/frame-%04d.png");
    let framerate = (1000_u64 / delay_ms.max(1)).max(1).to_string();
    let scale_str = format!("scale={scale}:-1:flags=lanczos");

    // Pass 1: generate palette.
    let palette_status = std::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-framerate", &framerate,
            "-i", &frame_pattern,
            "-vf", &format!("{scale_str},palettegen"),
            &palette,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .status();

    match palette_status {
        Ok(s) if s.success() => {}
        Ok(s) => {
            eprintln!("ffmpeg palettegen failed (exit {})", s.code().unwrap_or(-1));
            if !keep_frames {
                let _ = std::fs::remove_dir_all(&tmp_dir);
            }
            return Ok(EXIT_CDP_ERROR);
        }
        Err(e) => {
            eprintln!("ffmpeg palettegen error: {e}");
            if !keep_frames {
                let _ = std::fs::remove_dir_all(&tmp_dir);
            }
            return Ok(EXIT_CDP_ERROR);
        }
    }

    // Pass 2: render GIF using palette.
    let lavfi = format!("{scale_str} [x]; [x][1:v] paletteuse");
    let render_status = std::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-framerate", &framerate,
            "-i", &frame_pattern,
            "-i", &palette,
            "-lavfi", &lavfi,
            "-loop", "0",
            &out_gif,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .status();

    match render_status {
        Ok(s) if s.success() => {}
        Ok(s) => {
            eprintln!("ffmpeg render failed (exit {})", s.code().unwrap_or(-1));
            if !keep_frames {
                let _ = std::fs::remove_dir_all(&tmp_dir);
            }
            return Ok(EXIT_CDP_ERROR);
        }
        Err(e) => {
            eprintln!("ffmpeg render error: {e}");
            if !keep_frames {
                let _ = std::fs::remove_dir_all(&tmp_dir);
            }
            return Ok(EXIT_CDP_ERROR);
        }
    }

    // Cleanup temp frames unless --keep-frames.
    if !keep_frames {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    let size_kb = std::fs::metadata(&out_gif)
        .map(|m| m.len() / 1024)
        .unwrap_or(0);
    println!("✓ {} ({}KB, {} frames)", out_gif, size_kb, frame);
    Ok(EXIT_OK)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Returns current Unix time in milliseconds. Used for unique temp file names.
fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Probe for ffmpeg on PATH by running `ffmpeg -version`.
fn ffmpeg_available() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
