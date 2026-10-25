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
        serde_json::from_value(json!({"a": {"required": true}, "b": {"default": "B"}}))
            .unwrap();
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
    // src/record-filter.ts is the source of truth. Skip when the crate is
    // built outside the repo tree.
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/record-filter.ts");
    let Ok(src) = std::fs::read_to_string(p) else {
        return;
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
    let s =
        clean_step(&json!({"cmd": "goto", "args": ["x"], "at": 12345, "note": "n"})).unwrap();
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
