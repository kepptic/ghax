use super::*;

fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn names_are_validated() {
    for ok in ["a", "login-staging", "x.y_z", "0day", &"a".repeat(64)] {
        assert!(valid_name(ok), "{ok}");
    }
    for bad in [
        "",
        "-a",
        ".a",
        "_a",
        "A",
        "a b",
        "a/b",
        "../x",
        "a\\b",
        "é",
        &"a".repeat(65),
    ] {
        assert!(!valid_name(bad), "{bad}");
    }
}

#[test]
fn tokenizer_handles_vars_and_the_escape() {
    assert_eq!(
        tokenize("a${x}b"),
        vec![
            Tok::Lit("a".into()),
            Tok::Var("x".into()),
            Tok::Lit("b".into())
        ]
    );
    // `$${k}` is a literal `${k}`; it is not a var.
    assert_eq!(tokenize("$${k}"), vec![Tok::Lit("${k}".into())]);
    assert_eq!(
        tokenize("${a}$${b}${c}"),
        vec![
            Tok::Var("a".into()),
            Tok::Lit("${b}".into()),
            Tok::Var("c".into())
        ]
    );
    // Not an identifier, or unterminated: left alone (JS templates, prices).
    assert_eq!(
        tokenize("`${a + b}` $5 ${ x}${y"),
        vec![Tok::Lit("`${a + b}` $5 ${ x}${y".into())]
    );
    assert_eq!(tokenize("$"), vec![Tok::Lit("$".into())]);
}

#[test]
fn scan_and_substitute_only_touch_args_and_opts() {
    let steps = vec![
        json!({"cmd": "goto", "args": ["https://${host}/x"]}),
        json!({"cmd": "fill", "args": ["#q", "$${host}"], "opts": {"label": "${who}", "n": 3, "deep": ["${who}", {"k": "${host}"}]}}),
        // A var named like the cmd must not rewrite `cmd`.
        json!({"cmd": "${host}", "args": []}),
    ];
    let found: Vec<String> = scan_vars(&steps).into_iter().collect();
    assert_eq!(found, vec!["host", "who"]);
    let out = substitute(&steps, &vars(&[("host", "ex.com"), ("who", "ada")])).unwrap();
    assert_eq!(out[0]["args"][0], "https://ex.com/x");
    assert_eq!(out[1]["args"][1], "${host}");
    assert_eq!(out[1]["opts"]["label"], "ada");
    assert_eq!(out[1]["opts"]["n"], 3);
    assert_eq!(out[1]["opts"]["deep"][1]["k"], "ex.com");
    assert_eq!(out[2]["cmd"], "${host}");
}

#[test]
fn nested_batch_steps_are_scanned_and_substituted() {
    let steps = vec![json!({"cmd": "batch", "args": [[
        {"cmd": "goto", "args": ["${url}"]},
        {"cmd": "batch", "args": [[{"cmd": "fill", "args": ["#a", "${v}"]}]]},
        {"cmd": "${nope}", "args": []},
    ], "tail ${t}"]})];
    let found: Vec<String> = scan_vars(&steps).into_iter().collect();
    assert_eq!(found, vec!["t", "url", "v"]);
    let out = substitute(&steps, &vars(&[("url", "u"), ("v", "vv"), ("t", "tt")])).unwrap();
    assert_eq!(out[0]["args"][0][0]["args"][0], "u");
    assert_eq!(out[0]["args"][0][1]["args"][0][0]["args"][1], "vv");
    assert_eq!(out[0]["args"][0][2]["cmd"], "${nope}");
    assert_eq!(out[0]["args"][1], "tail tt");
}

#[test]
fn missing_vars_are_reported_together() {
    let stored: Map<String, Value> =
        serde_json::from_value(json!({"a": {"required": true}, "b": {"default": "B"}})).unwrap();
    let scanned: BTreeSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
    let err = resolve_vars(&stored, &scanned, &[]).unwrap_err();
    assert!(err.contains("missing value for a, c"), "{err}");
    assert!(err.contains("--var a=<value> --var c=<value>"), "{err}");
    // A supplied value beats the default; the last repeat wins.
    let given = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    };
    let ok = resolve_vars(
        &stored,
        &scanned,
        &given(&[("a", "1"), ("c", "2"), ("b", "x"), ("b", "y")]),
    )
    .unwrap();
    assert_eq!(ok, vars(&[("a", "1"), ("b", "y"), ("c", "2")]));
    // An empty value is a value.
    assert!(resolve_vars(&stored, &scanned, &given(&[("a", ""), ("c", "")])).is_ok());
    // A typo does not slip through as a no-op.
    let err = resolve_vars(&stored, &scanned, &given(&[("zz", "1")])).unwrap_err();
    assert!(err.contains("unknown --var zz"), "{err}");
}

#[test]
fn substitute_reports_a_name_nobody_resolved() {
    let steps = vec![json!({"cmd": "goto", "args": ["${x}"]})];
    assert!(substitute(&steps, &vars(&[])).unwrap_err().contains('x'));
}

#[test]
fn refs_are_found_with_their_step() {
    let steps = vec![
        json!({"cmd": "goto", "args": ["https://a.com/@e1x"]}),
        json!({"cmd": "click", "args": ["@e12"]}),
        json!({"cmd": "scroll", "opts": {"on": "x @e3, y"}, "args": ["mail@e5.com"]}),
        json!({"cmd": "click", "args": ["@c4", "@e"]}),
    ];
    assert_eq!(
        find_refs(&steps),
        vec![
            (1, "click".to_string(), "@e12".to_string()),
            (2, "scroll".to_string(), "@e3".to_string())
        ]
    );
}

#[test]
fn never_save_commands_are_refused_even_in_a_batch() {
    let steps = vec![
        json!({"cmd": "goto", "args": ["x"]}),
        json!({"cmd": "batch", "args": [[{"cmd": "batch", "args": [[{"cmd": "auth.export"}]]}]]}),
        json!({"cmd": "text"}),
    ];
    assert_eq!(refused_cmds(&steps), vec!["auth.export", "text"]);
}

#[test]
fn never_save_matches_the_daemon_never_record_set() {
    // src/record-filter.ts is the source of truth. A missing file is a failure
    // (a silent skip let the lists drift); only a vendored crate build, with
    // GHAX_VENDORED=1, may skip.
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/record-filter.ts");
    let src = match std::fs::read_to_string(&p) {
        Ok(src) => src,
        Err(_) if std::env::var_os("GHAX_VENDORED").is_some_and(|v| v == "1") => return,
        Err(e) => panic!(
            "cannot read {}: {e} — run from the repo tree, or set GHAX_VENDORED=1 for a vendored build",
            p.display()
        ),
    };
    let block = src
        .split("NEVER_RECORD = new Set([")
        .nth(1)
        .unwrap()
        .split("]);")
        .next()
        .unwrap();
    let mut ts: Vec<String> = block
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .flat_map(|l| {
            l.split('\'')
                .skip(1)
                .step_by(2)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect();
    ts.sort();
    let mut rs: Vec<String> = NEVER_SAVE.iter().map(|s| s.to_string()).collect();
    rs.sort();
    assert_eq!(rs, ts);
}

#[test]
fn steps_are_cleaned_to_cmd_args_opts() {
    let s = clean_step(&json!({"cmd": "goto", "args": ["x"], "at": 12345, "note": "n"})).unwrap();
    assert_eq!(s, json!({"cmd": "goto", "args": ["x"]}));
    assert!(clean_step(&json!({"args": []})).is_err());
}

#[test]
fn var_flags_are_recovered_from_raw_argv() {
    let argv: Vec<String> = ["n", "--var", "a=1", "--var=b=x=y", "--var", "c="]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let p = args::parse(&argv);
    assert_eq!(
        var_pairs(&p).unwrap(),
        vec![
            ("a".into(), Some("1".into())),
            ("b".into(), Some("x=y".into())),
            ("c".into(), Some("".into()))
        ]
    );
    let bad = args::parse(&["--var".to_string(), "9x=1".to_string()]);
    assert!(var_pairs(&bad).is_err());
}

fn scratch_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "ghax-shortcuts-test-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[cfg(unix)]
#[test]
fn temp_file_never_follows_a_planted_symlink() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = scratch_dir("symlink");
    let victim = dir.join("victim.txt");
    std::fs::write(&victim, "keep").unwrap();
    let path = dir.join("a.json");
    // Plant symlinks at the old fixed temp name and at a stale-looking one.
    symlink(&victim, dir.join(".a.json.tmp")).unwrap();
    write_private_atomic(&dir, "a", &path, "{}\n").unwrap();
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // The exclusive create itself refuses a path that already exists, even a
    // symlink, and leaves its target alone.
    let planted = dir.join("planted");
    symlink(&victim, &planted).unwrap();
    let r = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&planted);
    assert!(r.is_err());
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
    // No temp files are left behind besides the planted one.
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp") && n != ".a.json.tmp")
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn saving_over_a_0644_file_leaves_0600() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch_dir("mode");
    let path = dir.join("a.json");
    std::fs::write(&path, "old").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    write_private_atomic(&dir, "a", &path, "new").unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_rename_removes_the_temp_file() {
    let dir = scratch_dir("cleanup");
    // Renaming a file onto a non-empty directory fails.
    let target = dir.join("a.json");
    std::fs::create_dir_all(target.join("child")).unwrap();
    assert!(write_private_atomic(&dir, "a", &target, "x").is_err());
    let tmps = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(tmps, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn save_refuses_an_existing_name_until_forced() {
    // The only test that sets GHAX_SHORTCUTS_DIR; it is process-global, so it
    // takes the crate-wide env lock.
    let _env = crate::state::ENV_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let base = scratch_dir("save");
    let store = base.join("store");
    // SAFETY: `_env` holds ENV_LOCK, so no other test mutates the environment
    // while this one runs. Tests that only read it don't take the lock; none
    // in this module reads GHAX_SHORTCUTS_DIR (they pass explicit dirs).
    unsafe { std::env::set_var("GHAX_SHORTCUTS_DIR", &store) };
    let rec = base.join("rec.json");
    let argv = |n: &str| -> Parsed { args::parse(&[n.to_string(), rec.display().to_string()]) };

    std::fs::write(&rec, r#"[{"cmd":"goto","args":["a"]}]"#).unwrap();
    assert_eq!(cmd_save(&argv("one"), false).unwrap(), EXIT_OK);
    let f = store.join("one.json");
    let first = std::fs::read_to_string(&f).unwrap();

    std::fs::write(
        &rec,
        r#"[{"cmd":"goto","args":["a"]},{"cmd":"goto","args":["b"]}]"#,
    )
    .unwrap();
    assert_eq!(cmd_save(&argv("one"), false).unwrap(), EXIT_USAGE);
    assert_eq!(
        std::fs::read_to_string(&f).unwrap(),
        first,
        "refused save must not touch the file"
    );

    assert_eq!(cmd_save(&argv("one"), true).unwrap(), EXIT_OK);
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
    assert_eq!(doc["steps"].as_array().unwrap().len(), 2);

    // SAFETY: still holding `_env`, as for the set_var above.
    unsafe { std::env::remove_var("GHAX_SHORTCUTS_DIR") };
    let _ = std::fs::remove_dir_all(&base);
}
