//! Injects the short git sha (GHAX_GIT_SHA) and the build date
//! (GHAX_BUILD_DATE) so `ghax version` / `ghax --version` can report which
//! commit and day the binary was built from. Best-effort: a source tarball
//! with no `.git` simply gets "unknown" for the sha (the const default in
//! version.rs handles the absent env var); the build date always resolves
//! since it doesn't depend on git.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    emit_git_sha();
    emit_build_date();
}

fn emit_git_sha() {
    println!("cargo:rerun-if-env-changed=GHAX_GIT_SHA");

    // Watch the ref(s) that actually move HEAD forward, not just the HEAD
    // symref itself. `.git/HEAD` (e.g. `ref: refs/heads/main`) only changes
    // on checkout/branch switch — a plain `git commit` on the current branch
    // leaves it untouched, so watching only HEAD lets a rebuild silently
    // keep reporting a stale sha. Watch the resolved ref file too (and
    // packed-refs, since a `git gc` can move a loose ref into it).
    let manifest_dir = PathBuf::from(env_or("CARGO_MANIFEST_DIR", "."));
    if let Some(git_dir) = find_git_dir(&manifest_dir) {
        let head = git_dir.join("HEAD");
        println!("cargo:rerun-if-changed={}", head.display());
        if let Ok(contents) = std::fs::read_to_string(&head) {
            if let Some(ref_path) = contents.trim().strip_prefix("ref: ") {
                println!("cargo:rerun-if-changed={}", git_dir.join(ref_path).display());
            }
        }
        println!("cargo:rerun-if-changed={}", git_dir.join("packed-refs").display());
    }

    // Respect an explicit override (e.g. a release pipeline that builds from
    // an exported tree) before shelling out to git.
    if std::env::var("GHAX_GIT_SHA").is_ok() {
        return;
    }

    if let Ok(out) = Command::new("git").args(["rev-parse", "--short", "HEAD"]).output() {
        if out.status.success() {
            if let Ok(sha) = String::from_utf8(out.stdout) {
                let sha = sha.trim();
                if !sha.is_empty() {
                    println!("cargo:rustc-env=GHAX_GIT_SHA={sha}");
                }
            }
        }
    }
}

fn emit_build_date() {
    // Reproducible builds (cargo-dist et al.) fix the timestamp via
    // SOURCE_DATE_EPOCH; honor it so two builds of the same commit produce
    // an identical banner. GHAX_BUILD_DATE is the direct override, same
    // shape as GHAX_GIT_SHA above.
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:rerun-if-env-changed=GHAX_BUILD_DATE");

    if let Ok(date) = std::env::var("GHAX_BUILD_DATE") {
        let date = date.trim();
        if !date.is_empty() {
            println!("cargo:rustc-env=GHAX_BUILD_DATE={date}");
            return;
        }
    }

    let epoch_secs: i64 = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or_else(now_epoch_secs);

    println!("cargo:rustc-env=GHAX_BUILD_DATE={}", format_date(epoch_secs));
}

fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn format_date(epoch_secs: i64) -> String {
    let days = epoch_secs.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's days-from-civil inverse: days-since-1970-01-01 -> (y, m,
/// d), in the proleptic Gregorian calendar. No external dependency needed
/// for a single UTC date stamp.
/// http://howardhinnant.github.io/date_algorithms.html#civil_from_days
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Best-effort `.git` discovery, walking up from `start` the way git itself
/// does. Handles the plain case (`.git/` is a real directory) and the
/// worktree/submodule case (`.git` is a file containing `gitdir: <path>`).
/// Returns None rather than panicking when nothing is found (source
/// tarballs, vendored copies).
fn find_git_dir(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start.to_path_buf());
    while let Some(d) = dir {
        let candidate = d.join(".git");
        if candidate.is_dir() {
            return Some(candidate);
        }
        if candidate.is_file() {
            if let Ok(contents) = std::fs::read_to_string(&candidate) {
                if let Some(rest) = contents.trim().strip_prefix("gitdir: ") {
                    let p = PathBuf::from(rest);
                    return Some(if p.is_absolute() { p } else { d.join(p) });
                }
            }
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    None
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
