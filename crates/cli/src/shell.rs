//! Shell-mode REPL — `ghax shell`.
//!
//! Reads commands from stdin via rustyline (readline-compatible with history
//! and Ctrl-C line-cancel semantics), tokenises each line with a minimal
//! shell-ish tokeniser, and dispatches to `crate::dispatch::run`.
//!
//! Behavioural parity with `cmdShell()` in `src/cli.ts`:
//!   - Single-quoted strings: literal, no escapes.
//!   - Double-quoted strings: backslash-escapes for `\"` and `\\` only.
//!   - Bare-word backslash escape: `\x` → `x`.
//!   - Blank lines and lines starting with `#` are skipped.
//!   - `exit`, `quit`, and Ctrl-D (EOF) terminate the REPL.
//!   - `shell` from inside the shell prints an error and continues.
//!   - Ctrl-C cancels the current input line only — does NOT exit.
//!   - History is saved to `~/.ghax/history` (best-effort).

use anyhow::Result;
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;
use std::path::PathBuf;

/// Entry point for `ghax shell`.
pub fn cmd_shell() -> Result<i32> {
    // --- history file setup (best-effort, never errors to the user) ---
    let history_path = history_file_path();
    if let Some(parent) = history_path.as_ref().and_then(|p| p.parent()) {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut rl = DefaultEditor::new()?;

    // Load history (silently ignore failure).
    if let Some(ref path) = history_path {
        let _ = rl.load_history(path);
    }

    let is_tty = atty::is(atty::Stream::Stdin);

    if is_tty {
        println!("ghax shell — type commands, `exit` to quit, Ctrl-D to EOF.");
    }

    loop {
        let prompt = if is_tty { "ghax> " } else { "" };
        let readline = rl.readline(prompt);
        match readline {
            Ok(raw_line) => {
                let line = raw_line.trim().to_string();

                // Skip blank lines and comments.
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }

                // Exit commands.
                if line == "exit" || line == "quit" {
                    break;
                }

                // Tokenise.
                let argv = tokenize_shell_line(&line);
                if argv.is_empty() {
                    continue;
                }

                // Guard against recursion.
                if argv[0] == "shell" {
                    eprintln!("ghax: already in shell mode");
                    continue;
                }

                // Add to history before dispatch so history is preserved even
                // if the command errors.
                let _ = rl.add_history_entry(&line);

                // Dispatch — mirrors `dispatch(argv)` in the TS implementation.
                let verb = argv[0].clone();
                let rest = argv[1..].to_vec();
                let code = crate::dispatch::run(&verb, &rest);

                // Non-interactive stdin: propagate failures (same logic as TS).
                if code != crate::dispatch::EXIT_OK && !is_tty {
                    // Save history before we leave.
                    if let Some(ref path) = history_path {
                        let _ = rl.save_history(path);
                    }
                    return Ok(code);
                }
            }

            // Ctrl-C: cancel current line, keep going.
            Err(ReadlineError::Interrupted) => {
                if is_tty {
                    println!("(type `exit` or press Ctrl-D to quit)");
                }
                continue;
            }

            // Ctrl-D / EOF: clean exit.
            Err(ReadlineError::Eof) => break,

            // Any other readline error: report and exit.
            Err(err) => {
                eprintln!("ghax: readline error: {err}");
                break;
            }
        }
    }

    // Save history on clean exit (best-effort).
    if let Some(ref path) = history_path {
        let _ = rl.save_history(path);
    }

    Ok(crate::dispatch::EXIT_OK)
}

/// Returns `~/.ghax/history`, or `None` if `HOME` is unset.
fn history_file_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    Some(home.join(".ghax").join("history"))
}

/// Tokenise a shell-ish command line into an argv vector.
///
/// Rules (ported directly from `tokenizeShellLine` in `src/cli.ts`):
///   - Single-quoted strings: literal content, no escapes.
///   - Double-quoted strings: `\"` and `\\` are the only escape sequences;
///     every other character (including bare backslashes) is literal.
///   - Bare-word backslash: `\x` emits `x`.
///   - Tokens are delimited by ASCII whitespace outside quotes.
///   - Adjacent quoted/bare segments are concatenated into one token
///     (e.g. `foo'bar'` → `foobar`).
///
/// Example:
/// ```text
/// try --css 'body { color: red }' --shot /tmp/x.png
/// → ["try", "--css", "body { color: red }", "--shot", "/tmp/x.png"]
/// ```
fn tokenize_shell_line(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        // Skip leading whitespace between tokens.
        while i < chars.len() && chars[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }

        // Collect one token (may be built from mixed bare/quoted segments).
        let mut token = String::new();

        while i < chars.len() && !chars[i].is_ascii_whitespace() {
            match chars[i] {
                // Single-quoted: literal until next `'`.
                '\'' => {
                    i += 1;
                    while i < chars.len() && chars[i] != '\'' {
                        token.push(chars[i]);
                        i += 1;
                    }
                    if i < chars.len() {
                        i += 1; // consume closing `'`
                    }
                }

                // Double-quoted: `\"` and `\\` are escape sequences.
                '"' => {
                    i += 1;
                    while i < chars.len() && chars[i] != '"' {
                        if chars[i] == '\\' && i + 1 < chars.len() {
                            token.push(chars[i + 1]);
                            i += 2;
                        } else {
                            token.push(chars[i]);
                            i += 1;
                        }
                    }
                    if i < chars.len() {
                        i += 1; // consume closing `"`
                    }
                }

                // Bare backslash: next character is literal.
                '\\' if i + 1 < chars.len() => {
                    token.push(chars[i + 1]);
                    i += 2;
                }

                // Ordinary bare-word character.
                c => {
                    token.push(c);
                    i += 1;
                }
            }
        }

        out.push(token);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::tokenize_shell_line;

    #[test]
    fn bare_words() {
        assert_eq!(tokenize_shell_line("goto https://example.com"), vec!["goto", "https://example.com"]);
    }

    #[test]
    fn single_quoted_with_spaces() {
        // "try --css 'body { color: red }'" → 4 tokens, not 6.
        let tokens = tokenize_shell_line("try --css 'body { color: red }' --shot /tmp/x.png");
        assert_eq!(tokens, vec!["try", "--css", "body { color: red }", "--shot", "/tmp/x.png"]);
    }

    #[test]
    fn double_quoted_backslash_escape() {
        let tokens = tokenize_shell_line(r#"eval "1 + \"2\"" "#);
        assert_eq!(tokens, vec!["eval", r#"1 + "2""#]);
    }

    #[test]
    fn bare_backslash_escape() {
        let tokens = tokenize_shell_line(r"fill @e1 hello\ world");
        assert_eq!(tokens, vec!["fill", "@e1", "hello world"]);
    }

    #[test]
    fn adjacent_quoted_segments() {
        // foo'bar' is one token: "foobar"
        let tokens = tokenize_shell_line("foo'bar'");
        assert_eq!(tokens, vec!["foobar"]);
    }

    #[test]
    fn empty_and_whitespace_lines() {
        assert!(tokenize_shell_line("").is_empty());
        assert!(tokenize_shell_line("   ").is_empty());
    }

    #[test]
    fn comment_lines_not_tokenised() {
        // The caller skips comment lines; tokeniser itself doesn't have to,
        // but confirm a bare `#` starts a token (not special in tokeniser).
        let tokens = tokenize_shell_line("# comment");
        assert_eq!(tokens[0], "#");
    }
}
