//! Shared time helpers. Prior to consolidation, `qa.rs`, `canary.rs`, and
//! `ship.rs` each had their own `now_ms`/`iso_now`/`days_to_ymd` — `ship.rs`
//! even used a slower year-by-year loop algorithm. This module is the one
//! place that knows how to spell "now" without a time crate.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

/// ISO-8601 UTC timestamp with millisecond precision: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso_now() -> String {
    let ms = now_ms();
    let (year, month, day, h, m, s) = epoch_ms_to_ymdhms(ms);
    let millis = ms % 1000;
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

/// ISO-8601 UTC timestamp without milliseconds: `YYYY-MM-DDTHH:MM:SSZ`.
/// Used by ship.rs for commit messages, where the extra precision is noise.
pub fn iso_now_no_ms() -> String {
    let ms = now_ms();
    let (year, month, day, h, m, s) = epoch_ms_to_ymdhms(ms);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

fn epoch_ms_to_ymdhms(ms: u64) -> (u64, u64, u64, u64, u64, u64) {
    let secs = ms / 1000;
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    let (year, month, day) = days_to_ymd(days);
    (year, month, day, h, m, s)
}

/// Gregorian calendar conversion from days-since-1970-01-01 to (year, month, day).
/// Algorithm: https://howardhinnant.github.io/date_algorithms.html — O(1), no loops.
pub fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
