//! Injects the short git sha as GHAX_GIT_SHA so `ghax version --full` can
//! report which commit the binary was built from. Best-effort: a source
//! tarball with no `.git` simply gets "unknown" (the const default in
//! version.rs handles the absent env var).

use std::process::Command;

fn main() {
    // Rebuild when HEAD moves so the embedded sha stays truthful.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-env-changed=GHAX_GIT_SHA");

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
