//! `ghax review` — emit a Claude-ready review prompt wrapping the branch diff.
//!
//! Port of `cmdReview()` in `src/cli.ts`. No daemon needed; pure git shell-outs.
//!
//! Args:
//!   --base <ref>   base ref to diff against (default: origin/main)
//!   --diff         print the raw diff only, no prompt wrapper

use crate::args::Parsed;
use crate::dispatch::{EXIT_OK, EXIT_USAGE};
use anyhow::Result;
use std::process::Command;

pub fn cmd_review(parsed: &Parsed) -> Result<i32> {
    let base = parsed
        .flags
        .get("base")
        .and_then(|v| v.as_str())
        .unwrap_or("origin/main");

    // Verify we're inside a git repo.
    let root_out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()?;
    if !root_out.status.success() {
        eprintln!("ghax review: not inside a git repository");
        return Ok(EXIT_USAGE);
    }
    let repo_root = String::from_utf8_lossy(&root_out.stdout).trim().to_string();

    // Current branch name.
    let branch_out = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&repo_root)
        .output()?;
    let branch = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();

    // Diff between base and HEAD.
    let diff_out = Command::new("git")
        .args(["diff", &format!("{base}...HEAD")])
        .current_dir(&repo_root)
        .output()?;
    if !diff_out.status.success() {
        let stderr = String::from_utf8_lossy(&diff_out.stderr);
        eprintln!("{stderr}");
        return Ok(EXIT_USAGE);
    }
    let diff_text = String::from_utf8_lossy(&diff_out.stdout).to_string();
    if diff_text.trim().is_empty() {
        eprintln!("ghax review: no diff between {base} and {branch}");
        return Ok(EXIT_OK);
    }

    // One-line log of commits on this branch.
    let log_out = Command::new("git")
        .args(["log", "--oneline", &format!("{base}..HEAD")])
        .current_dir(&repo_root)
        .output()?;
    let log_text = String::from_utf8_lossy(&log_out.stdout).trim().to_string();

    // --diff: print raw diff only.
    if matches!(parsed.flags.get("diff"), Some(serde_json::Value::Bool(true))) {
        print!("{diff_text}");
        return Ok(EXIT_OK);
    }

    // Full Claude-ready prompt.
    let log_block = if log_text.is_empty() {
        "(no commits on this branch)".to_string()
    } else {
        log_text
    };

    println!("# Code review request");
    println!();
    println!("**Branch:** `{branch}` (base: `{base}`)");
    println!();
    println!("## Commits");
    println!();
    println!("```");
    println!("{log_block}");
    println!("```");
    println!();
    println!("## Instructions");
    println!();
    println!("Review the diff below. Call out:");
    println!();
    println!("- Correctness bugs — off-by-ones, null-deref, race conditions, wrong API usage.");
    println!("- Security — injection, path traversal, unsafe deserialisation, secret leakage.");
    println!("- Resource leaks — unclosed sockets, forgotten timers, unbounded caches.");
    println!("- API / contract changes that callers will need to adapt to.");
    println!("- Anything that looks intentionally hacky or temporary.");
    println!();
    println!("Do NOT pad the review with style nits unless they affect clarity.");
    println!("If the diff is clean, say so plainly.");
    println!();
    println!("## Diff");
    println!();
    println!("```diff");
    print!("{diff_text}");
    println!("```");

    Ok(EXIT_OK)
}
