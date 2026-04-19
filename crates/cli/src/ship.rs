//! `ghax ship` — stage, commit, push, and open a PR in one step.
//!
//! Port of `cmdShip()` in `src/cli.ts`. No daemon needed; orchestrates
//! `git`, `bun run typecheck`, `bun run build`, and `gh pr create`.
//!
//! Args:
//!   --message <msg>  commit message (implies stage-all + commit if tree is dirty)
//!   --no-check       skip `bun run typecheck`
//!   --no-build       skip `bun run build`
//!   --no-pr          skip `gh pr create`
//!   --dry-run        print the plan and exit before any mutations

use crate::args::Parsed;
use crate::dispatch::{EXIT_CDP_ERROR, EXIT_OK, EXIT_USAGE};
use anyhow::Result;
use std::process::Command;

/// Run a command, capture stdout+stderr. Returns (success, stdout, stderr).
/// On non-zero exit with `silent_fail=false`, prints the standard failure
/// message that mirrors the TS `sh()` helper's error output.
fn sh(
    program: &str,
    args: &[&str],
    cwd: &str,
    silent_fail: bool,
) -> (bool, String, String) {
    let out = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output();
    match out {
        Err(e) => {
            if !silent_fail {
                eprintln!("ghax ship: {} {} failed: {e}", program, args.join(" "));
            }
            (false, String::new(), e.to_string())
        }
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            let ok = o.status.success();
            if !ok && !silent_fail {
                eprintln!("ghax ship: {} {} failed ({})", program, args.join(" "), o.status);
                if !stderr.is_empty() {
                    eprintln!("{stderr}");
                }
            }
            (ok, stdout, stderr)
        }
    }
}

/// Run a command, inheriting stdout/stderr so the user sees live output.
/// Returns true on success.
fn sh_stream(program: &str, args: &[&str], cwd: &str) -> bool {
    Command::new(program)
        .args(args)
        .current_dir(cwd)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn cmd_ship(parsed: &Parsed) -> Result<i32> {
    let msg = parsed
        .flags
        .get("message")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let skip_check = matches!(parsed.flags.get("no-check"), Some(serde_json::Value::Bool(true)));
    let skip_build = matches!(parsed.flags.get("no-build"), Some(serde_json::Value::Bool(true)));
    let skip_pr = matches!(parsed.flags.get("no-pr"), Some(serde_json::Value::Bool(true)));
    let dry = matches!(parsed.flags.get("dry-run"), Some(serde_json::Value::Bool(true)));

    // Locate repo root.
    let root_out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()?;
    if !root_out.status.success() {
        eprintln!("ghax ship: not inside a git repository");
        return Ok(EXIT_USAGE);
    }
    let repo_root = String::from_utf8_lossy(&root_out.stdout).trim().to_string();

    // Check working-tree status.
    let (status_ok, status_stdout, _) = sh("git", &["status", "--porcelain"], &repo_root, false);
    if !status_ok {
        return Ok(EXIT_CDP_ERROR);
    }
    let dirty = !status_stdout.trim().is_empty();

    if !dirty {
        println!("ghax ship: working tree clean — nothing to commit");
    } else {
        print!("{status_stdout}");
    }

    if dry {
        // Print the plan as a numbered list and exit.
        let mut step = 1usize;
        println!("Dry-run plan:");
        if dirty {
            println!(
                "  {step}. git add -A && git commit --message \"{}\"",
                msg.as_deref().unwrap_or(&format!(
                    "ghax ship {}",
                    chrono_like_ts()
                ))
            );
            step += 1;
        }
        if !skip_check {
            println!("  {step}. bun run typecheck");
            step += 1;
        }
        if !skip_build {
            println!("  {step}. bun run build");
            step += 1;
        }
        println!("  {step}. git push -u origin <branch>");
        step += 1;
        if !skip_pr {
            println!("  {step}. gh pr create --fill");
        }
        println!("(dry-run — stopping before git mutations)");
        return Ok(EXIT_OK);
    }

    // Typecheck (streaming — user sees compiler output in real time).
    if !skip_check {
        println!("→ typecheck");
        if !sh_stream("bun", &["run", "typecheck"], &repo_root) {
            return Ok(EXIT_USAGE);
        }
    }

    // Build (streaming).
    if !skip_build {
        println!("→ build");
        if !sh_stream("bun", &["run", "build"], &repo_root) {
            return Ok(EXIT_USAGE);
        }
    }

    // Stage + commit if dirty.
    if dirty {
        sh("git", &["add", "-A"], &repo_root, false);
        let commit_msg = msg
            .clone()
            .unwrap_or_else(|| format!("ghax ship {}", chrono_like_ts()));
        let (commit_ok, commit_stdout, commit_stderr) =
            sh("git", &["commit", "--message", &commit_msg], &repo_root, false);
        if !commit_ok {
            let out = if commit_stderr.is_empty() { &commit_stdout } else { &commit_stderr };
            eprintln!("{out}");
            return Ok(EXIT_USAGE);
        }
        // Print the first 3 lines of commit output (matches TS `.slice(0, 3)`).
        let first_lines: Vec<&str> = commit_stdout.lines().take(3).collect();
        println!("{}", first_lines.join("\n"));
    }

    // Current branch.
    let (_, branch_raw, _) = sh(
        "git",
        &["rev-parse", "--abbrev-ref", "HEAD"],
        &repo_root,
        false,
    );
    let branch = branch_raw.trim().to_string();
    let is_main = branch == "main" || branch == "master";

    // Push.
    println!("→ push origin {branch}");
    let (push_ok, push_stdout, push_stderr) =
        sh("git", &["push", "-u", "origin", &branch], &repo_root, false);
    if !push_ok {
        let out = if push_stderr.is_empty() { &push_stdout } else { &push_stderr };
        eprintln!("{out}");
        return Ok(EXIT_CDP_ERROR);
    }
    // git push writes progress to stderr; prefer stderr if non-empty.
    let push_output = if push_stderr.trim().is_empty() {
        push_stdout.trim().to_string()
    } else {
        push_stderr.trim().to_string()
    };
    println!("{push_output}");

    // PR creation (only off main/master, requires `gh`).
    if !skip_pr && !is_main {
        let (gh_ok, _, _) = sh("gh", &["--version"], &repo_root, true);
        if !gh_ok {
            eprintln!("ghax ship: gh CLI not found — skipping PR step (--no-pr to silence)");
        } else {
            println!("→ gh pr create --fill");
            let (pr_ok, pr_stdout, pr_stderr) =
                sh("gh", &["pr", "create", "--fill"], &repo_root, true);
            if !pr_ok {
                if pr_stderr.contains("already exists") || pr_stdout.contains("already exists") {
                    // Fetch and display the existing PR URL.
                    let (view_ok, view_stdout, _) = sh(
                        "gh",
                        &["pr", "view", "--json", "url", "--jq", ".url"],
                        &repo_root,
                        true,
                    );
                    if view_ok {
                        println!("PR already exists: {}", view_stdout.trim());
                    }
                } else {
                    let out = if pr_stderr.is_empty() { &pr_stdout } else { &pr_stderr };
                    eprintln!("{out}");
                    return Ok(EXIT_CDP_ERROR);
                }
            } else {
                println!("{}", pr_stdout.trim());
            }
        }
    }

    Ok(EXIT_OK)
}

/// Produce an ISO-8601-like timestamp string matching `new Date().toISOString()`
/// without pulling in a time crate. Uses the system time.
fn chrono_like_ts() -> String {
    // std::time gives us seconds + nanos since UNIX epoch; format manually.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple ISO 8601 UTC without a time crate: YYYY-MM-DDTHH:MM:SSZ
    let s = secs;
    let (sec, min, hr, day, mon, yr) = epoch_to_datetime(s);
    format!("{yr:04}-{mon:02}-{day:02}T{hr:02}:{min:02}:{sec:02}Z")
}

/// Minimal epoch→(sec,min,hr,day,month,year) conversion (UTC, no leap seconds).
fn epoch_to_datetime(epoch: u64) -> (u64, u64, u64, u64, u64, u64) {
    let sec = epoch % 60;
    let mins = epoch / 60;
    let min = mins % 60;
    let hrs = mins / 60;
    let hr = hrs % 24;
    let days = hrs / 24;

    // Days since 1970-01-01. Gregorian calendar.
    let mut y = 1970u64;
    let mut remaining = days;
    loop {
        let dy = days_in_year(y);
        if remaining < dy {
            break;
        }
        remaining -= dy;
        y += 1;
    }
    let mut m = 1u64;
    loop {
        let dm = days_in_month(m, y);
        if remaining < dm {
            break;
        }
        remaining -= dm;
        m += 1;
    }
    let d = remaining + 1;
    (sec, min, hr, d, m, y)
}

fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

fn days_in_year(y: u64) -> u64 {
    if is_leap(y) { 366 } else { 365 }
}

fn days_in_month(m: u64, y: u64) -> u64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap(y) { 29 } else { 28 },
        _ => 30,
    }
}
