//! ghax — Rust CLI entry point. Dispatches argv to the daemon RPC, plus
//! the medium verbs (attach, canary, qa, review, ship) that layer multi-
//! RPC logic on top. SSE streaming lives in `sse`; the REPL in `shell`.

mod args;
mod attach;
mod canary;
mod dispatch;
mod help;
mod output;
mod qa;
mod review;
mod rpc;
mod shell;
mod ship;
mod small;
mod sse;
mod state;
mod time_util;

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
