//! ghax — Rust CLI entry point.
//!
//! Phase 1: argv → daemon RPC → print. Medium and complex verbs (attach,
//! qa, canary, ship, console --follow, shell) are stubs that route users
//! back to the Bun CLI for the duration of the rewrite window.

mod args;
mod dispatch;
mod help;
mod output;
mod rpc;
mod state;

use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() || matches!(argv[0].as_str(), "--help" | "-h" | "help") {
        print!("{}", help::HELP);
        return ExitCode::from(dispatch::EXIT_OK as u8);
    }
    if matches!(argv[0].as_str(), "--version" | "-V") {
        println!("ghax {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::from(dispatch::EXIT_OK as u8);
    }
    let verb = argv[0].clone();
    let rest = argv[1..].to_vec();
    let code = dispatch::run(&verb, &rest);
    ExitCode::from(code.clamp(0, 255) as u8)
}
