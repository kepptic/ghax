//! `ghax find-el "<description>"` and its optional `--rerank-cmd` model hook.
//!
//! The scoring runs in the daemon (`src/find-el.ts`) and makes no model call.
//! The hook lives here so the daemon stays model-free: the top 20 candidates
//! go to the command's stdin as `{query, candidates}`, and it prints back a
//! reordered `[{ref, score}]` on stdout. The command gets `--rerank-timeout`
//! seconds (default 60) for the whole exchange, then it is killed.

use crate::dispatch::{EXIT_OK, EXIT_USAGE, parse_switches};
use crate::output;
use crate::rpc;
use crate::state::{self, Config};
use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value, json};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// How many candidates a reranker sees (mirrors RERANK_POOL in src/find-el.ts).
const RERANK_POOL: usize = 20;
const DEFAULT_TOP: usize = 5;
const DEFAULT_RERANK_TIMEOUT_SECS: u64 = 60;

pub fn cmd_find_el(cfg: &Config, rest: &[String]) -> Result<i32> {
    let parsed = parse_switches(rest, &["json", "interactive-only"]);
    let json_out = parsed.json();

    let description = parsed.positional.join(" ");
    if description.trim().is_empty() {
        eprintln!(
            "Usage: ghax find-el \"<description>\" [--top 5] [--min-score 20] [--interactive-only] [--json] [--rerank-cmd <cmd>] [--rerank-timeout <secs>]"
        );
        return Ok(EXIT_USAGE);
    }
    let rerank_cmd = match parsed.flags.get("rerank-cmd") {
        None => None,
        Some(Value::String(c)) if !c.trim().is_empty() => Some(c.clone()),
        Some(_) => {
            eprintln!("ghax: find-el: --rerank-cmd needs a command");
            return Ok(EXIT_USAGE);
        }
    };
    let rerank_timeout = match parsed.flags.get("rerank-timeout") {
        None => Duration::from_secs(DEFAULT_RERANK_TIMEOUT_SECS),
        Some(Value::String(s)) => match s.trim().parse::<u64>() {
            Ok(n) if (1..=3600).contains(&n) => Duration::from_secs(n),
            _ => {
                eprintln!("ghax: find-el: --rerank-timeout must be 1-3600 seconds, got '{s}'");
                return Ok(EXIT_USAGE);
            }
        },
        Some(_) => {
            eprintln!("ghax: find-el: --rerank-timeout needs a number of seconds");
            return Ok(EXIT_USAGE);
        }
    };
    let top = match parsed.flags.get("top") {
        None => DEFAULT_TOP,
        Some(Value::String(s)) => match s.trim().parse::<usize>() {
            Ok(n) if (1..=100).contains(&n) => n,
            _ => {
                eprintln!("ghax: find-el: --top must be 1-100, got '{s}'");
                return Ok(EXIT_USAGE);
            }
        },
        Some(_) => {
            eprintln!("ghax: find-el: --top needs a number");
            return Ok(EXIT_USAGE);
        }
    };

    // The daemon validates --min-score; --top is asked for in full so the
    // reranker sees its pool and the cut happens after it.
    let mut opts = Map::new();
    opts.insert(
        "top".into(),
        json!(if rerank_cmd.is_some() {
            top.max(RERANK_POOL)
        } else {
            top
        }),
    );
    if let Some(v) = parsed.flags.get("min-score") {
        opts.insert("minScore".into(), v.clone());
    }
    if matches!(
        parsed.flags.get("interactive-only"),
        Some(Value::Bool(true))
    ) {
        opts.insert("interactiveOnly".into(), Value::Bool(true));
    }

    let port = state::require_daemon(cfg)?;
    let mut data = rpc::call(port, "findEl", json!([description]), Value::Object(opts))?;

    if let Some(cmd) = rerank_cmd {
        let results = data
            .get("results")
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default();
        let pool: Vec<Value> = results.iter().take(RERANK_POOL).cloned().collect();
        let reply = run_reranker(&cmd, &description, &pool, rerank_timeout)?;
        let reordered = finish_rerank(&results, &reply, top)
            .map_err(|e| anyhow!("find-el: --rerank-cmd: {e}"))?;
        data["results"] = Value::Array(reordered);
        data["reranked"] = Value::Bool(true);
    } else if let Some(arr) = data.get_mut("results").and_then(|r| r.as_array_mut()) {
        arr.truncate(top);
    }

    if json_out {
        output::print(&data, true);
    } else {
        for line in text_lines(&data) {
            println!("{line}");
        }
        if let Some(c) = data.get("confidence").and_then(|c| c.as_str()) {
            eprintln!("confidence: {c}");
        }
    }
    Ok(EXIT_OK)
}

/// `@e12  87  button "Save changes"  (name, role)`
fn text_lines(data: &Value) -> Vec<String> {
    let Some(results) = data.get("results").and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    results
        .iter()
        .map(|m| {
            let s = |k: &str| m.get(k).and_then(|v| v.as_str()).unwrap_or("");
            let name = s("name");
            let why: Vec<&str> = m
                .get("why")
                .and_then(|w| w.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            let mut line = format!(
                "{}  {}  {}",
                s("ref"),
                m.get("score").and_then(|v| v.as_i64()).unwrap_or(0),
                s("role")
            );
            if !name.is_empty() {
                line.push(' ');
                line.push_str(&serde_json::to_string(name).unwrap_or_default());
            }
            if !why.is_empty() {
                line.push_str(&format!("  ({})", why.join(", ")));
            }
            line
        })
        .collect()
}

/// Run the reranker: the command line is split on whitespace (no shell). The
/// deadline covers the stdin write and the output; past it the child is killed
/// and reaped. I/O runs on helper threads so a command that never reads its
/// stdin, or never closes its stdout, cannot hold this thread past the deadline.
fn run_reranker(cmdline: &str, query: &str, pool: &[Value], timeout: Duration) -> Result<Value> {
    let mut parts = cmdline.split_whitespace();
    let program = parts
        .next()
        .ok_or_else(|| anyhow!("find-el: --rerank-cmd is empty"))?;
    let mut child = Command::new(program)
        .args(parts)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("find-el: could not start --rerank-cmd '{program}'"))?;
    let deadline = Instant::now() + timeout;
    let payload = serde_json::to_vec(&json!({ "query": query, "candidates": pool }))?;
    if let Some(mut stdin) = child.stdin.take() {
        // A command that exits without reading is reported by its status below.
        thread::spawn(move || {
            let _ = stdin.write_all(&payload);
        });
    }
    let (tx, rx) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = tx.send(stdout.read_to_end(&mut buf).map(|_| buf));
        });
    }
    let timed_out = |child: &mut Child| {
        let _ = child.kill();
        let _ = child.wait();
        anyhow!(
            "find-el: --rerank-cmd '{program}' did not finish within {}s and was killed (raise --rerank-timeout, or check the command)",
            timeout.as_secs()
        )
    };
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            return Err(timed_out(&mut child));
        }
        thread::sleep(Duration::from_millis(10));
    };
    if !status.success() {
        return Err(anyhow!(
            "find-el: --rerank-cmd '{program}' exited {}",
            status
                .code()
                .map_or("by signal".to_string(), |c| c.to_string())
        ));
    }
    // The command is gone, but a grandchild may still hold the pipe open.
    let stdout = match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(read) => read
            .with_context(|| format!("find-el: could not read --rerank-cmd '{program}' output"))?,
        Err(_) => return Err(timed_out(&mut child)),
    };
    serde_json::from_slice(&stdout).map_err(|e| {
        anyhow!(
            "find-el: --rerank-cmd '{program}' did not print a JSON array of {{ref, score}}: {e}"
        )
    })
}

/// The reranked pool followed by the candidates the reranker never saw, cut to
/// `top`. The daemon returns up to `top` results; only the first RERANK_POOL
/// go to the command, and the rest keep their scorer order behind them.
fn finish_rerank(results: &[Value], reply: &Value, top: usize) -> Result<Vec<Value>, String> {
    let pool = &results[..results.len().min(RERANK_POOL)];
    let mut out = apply_rerank(pool, reply)?;
    out.extend(results[pool.len()..].iter().cloned());
    out.truncate(top);
    Ok(out)
}

/// The reranker's order, with its scores. Candidates it leaves out follow in
/// their original order; a ref it invents is an error, not a silent drop.
fn apply_rerank(pool: &[Value], reply: &Value) -> Result<Vec<Value>, String> {
    let items = reply
        .as_array()
        .ok_or("reply must be a JSON array of {ref, score}")?;
    let mut out: Vec<Value> = Vec::new();
    for item in items {
        let r = item
            .get("ref")
            .and_then(|v| v.as_str())
            .ok_or("every reply item needs a \"ref\"")?;
        let Some(orig) = pool
            .iter()
            .find(|c| c.get("ref").and_then(|v| v.as_str()) == Some(r))
        else {
            return Err(format!(
                "reply names {r}, which was not among the candidates"
            ));
        };
        if out
            .iter()
            .any(|o| o.get("ref").and_then(|v| v.as_str()) == Some(r))
        {
            continue;
        }
        let mut next = orig.clone();
        if let Some(score) = item.get("score").and_then(|v| v.as_f64()) {
            next["score"] = json!(score.round().clamp(0.0, 100.0) as i64);
        }
        out.push(next);
    }
    for c in pool {
        let r = c.get("ref").and_then(|v| v.as_str());
        if !out
            .iter()
            .any(|o| o.get("ref").and_then(|v| v.as_str()) == r)
        {
            out.push(c.clone());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool() -> Vec<Value> {
        vec![
            json!({"ref": "@e1", "score": 90, "role": "button", "name": "Save", "why": ["name", "role"]}),
            json!({"ref": "@e2", "score": 60, "role": "link", "name": "", "why": []}),
            json!({"ref": "@e3", "score": 30, "role": "button", "name": "Save as", "why": ["name"]}),
        ]
    }

    #[test]
    fn text_line_shape() {
        let d = json!({"results": pool()});
        let lines = text_lines(&d);
        assert_eq!(lines[0], "@e1  90  button \"Save\"  (name, role)");
        assert_eq!(lines[1], "@e2  60  link");
    }

    #[test]
    fn rerank_reorders_rescores_and_keeps_the_rest() {
        let reply = json!([{"ref": "@e3", "score": 99.6}, {"ref": "@e1"}]);
        let out = apply_rerank(&pool(), &reply).unwrap();
        let refs: Vec<&str> = out.iter().map(|v| v["ref"].as_str().unwrap()).collect();
        assert_eq!(refs, ["@e3", "@e1", "@e2"]);
        assert_eq!(out[0]["score"], 100);
        assert_eq!(
            out[1]["score"], 90,
            "no score in the reply keeps the original"
        );
    }

    #[test]
    fn rerank_rejects_an_invented_ref_and_a_non_array() {
        assert!(
            apply_rerank(&pool(), &json!([{"ref": "@e99"}]))
                .unwrap_err()
                .contains("@e99")
        );
        assert!(apply_rerank(&pool(), &json!({"ref": "@e1"})).is_err());
        assert!(apply_rerank(&pool(), &json!([{"score": 1}])).is_err());
    }

    fn many(n: usize) -> Vec<Value> {
        (1..=n)
            .map(|i| json!({"ref": format!("@e{i}"), "score": 100 - i as i64}))
            .collect()
    }

    #[test]
    fn rerank_keeps_the_unreranked_tail_so_top_beyond_the_pool_works() {
        let results = many(30);
        let reply: Vec<Value> = results[..RERANK_POOL]
            .iter()
            .rev()
            .map(|c| json!({"ref": c["ref"]}))
            .collect();
        let out = finish_rerank(&results, &Value::Array(reply), 25).unwrap();
        let refs: Vec<&str> = out.iter().map(|v| v["ref"].as_str().unwrap()).collect();
        assert_eq!(out.len(), 25);
        assert_eq!(&refs[..2], ["@e20", "@e19"], "pool reordered");
        assert_eq!(
            &refs[20..],
            ["@e21", "@e22", "@e23", "@e24", "@e25"],
            "tail follows in scorer order"
        );
        assert_eq!(
            finish_rerank(&results, &json!([]), 100).unwrap().len(),
            30,
            "top above what exists returns it all"
        );
        assert_eq!(
            finish_rerank(&results, &json!([]), 3).unwrap().len(),
            3,
            "top still cuts"
        );
        assert_eq!(
            finish_rerank(&many(5), &json!([]), 40).unwrap().len(),
            5,
            "a short list is not padded"
        );
    }

    #[test]
    fn a_hung_reranker_is_killed_at_the_deadline() {
        let t = Instant::now();
        let err = run_reranker("sleep 5", "q", &pool(), Duration::from_secs(1))
            .unwrap_err()
            .to_string();
        assert!(
            t.elapsed() < Duration::from_secs(4),
            "returned at the deadline, not after sleep: {:?}",
            t.elapsed()
        );
        assert!(
            err.contains("'sleep'") && err.contains("--rerank-timeout"),
            "{err}"
        );
    }

    #[test]
    fn a_reranker_inside_the_deadline_gets_its_stdin_and_answers() {
        let reply = run_reranker("cat", "find me", &pool(), Duration::from_secs(10)).unwrap();
        assert_eq!(reply["query"], "find me");
        assert_eq!(reply["candidates"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn rerank_ignores_a_repeated_ref() {
        let out = apply_rerank(
            &pool(),
            &json!([{"ref": "@e2"}, {"ref": "@e2", "score": 1}]),
        )
        .unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["score"], 60);
    }
}
