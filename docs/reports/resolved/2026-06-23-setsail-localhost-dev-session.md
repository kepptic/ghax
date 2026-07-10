# 2026-06-23: "ghax couldn't hold the dev-login session" — investigation (verdict: not a ghax defect, but DX gaps)

## Context

QA of the Setsail admin app on `http://localhost:3021` (Next.js dev server) + Rust API on `:8000`. ghax attached to the user's real Edge (`--port 9222`). The app uses a dev-login bypass: `POST /api/auth/dev-login` mints a session and sets three **httpOnly, non-Secure, `SameSite=Strict`** cookies (`setsail_api_token`, `setsail_api_refresh`, `setsail.session_token`) + `setsail.session_data` (Lax).

**Symptom reported:** "ghax can't hold onto the dev session" — after driving the dev-login UI, pages kept redirecting back to `/login`, and `/manage-rank` showed "Something went wrong".

## What I checked (and the real story)

1. **The endpoint is fine.** `curl` → `POST /api/auth/dev-login` returns `200` and sets all cookies; a follow-up `curl -b jar /manage-rank` → `200` (authed). So the server works.

2. **The in-browser POST fails *intermittently*.** Driving the UI button, the page logged `Dev login error: TypeError: Failed to fetch` (the handler does `fetch('/api/auth/dev-login')` then `window.location.href`). Re-running the same POST in-page via `ghax eval` later returned `STATUS=200`. Same-origin GETs (`/login`) and even `http://localhost:8000/health` returned 200 from the browser — **no proxy block, localhost reachable.** The failures correlated with heavy concurrent load (multiple ACR builds + two browser tools hammering a 5-day-old `next dev` whose dev-login route does a ~4s server-side call to the Rust API). Transient, app/infra-side — not ghax.

3. **Once the POST succeeds, ghax holds the session perfectly.** After a `200`, `ghax cookies` showed the `localhost` setsail cookies stored, and `ghax goto /manage-rank` (CDP `Page.navigate`) **stayed authenticated** — i.e. **`SameSite=Strict` cookies ARE sent on ghax/CDP top-level navigations.** (This was my leading hypothesis and it was wrong — Strict did not break it.)

4. **`ghax eval` handles async correctly.** `1+1`→`2`, `(async()=>{await …; return 'x'})()`→`x`, `Promise.resolve('y')`→`y`. Earlier "empty" eval returns were my own overly-aggressive shell `grep`/`sed` filtering eating the output, not ghax.

5. **The "Something went wrong" was a real app crash, not a lost session.** Console: `Rendered fewer hooks than expected. This may be caused by an accidental early return statement.` — a React Rules-of-Hooks violation in the app (two hooks placed after an early `return`). It white-screened the page and *looked* like "not authenticated". Fixed app-side; page then rendered authed. (Good example of why headless/runtime testing earns its keep — typecheck + unit tests were green.)

## Verdict

**ghax is not at fault.** It attached, eval'd (sync/async/promise), stored cookies, and navigated with the session intact — including `SameSite=Strict` cookies over CDP navigation. The "can't hold the session" experience was the sum of: (a) intermittent app-side `Failed to fetch` on a slow dev-login route under load, and (b) an app render crash. A fresh dev server + a successful login = rock-solid session in ghax.

## Recommendations for ghax (DX — these would have made this 10x faster to diagnose)

1. **Scope `ghax cookies` to the current tab/app by default**, with `--all` to opt into the whole profile. Right now it dumps every cookie across every domain in the real Edge profile (setsail.today, conduit-dash, beam, freeze, scalar.com, 127.0.0.1 mitmproxy/jupyter…). I had to pipe it through Python to find the `localhost` ones. A `ghax cookies --url <current>` or `--domain localhost` filter is the single biggest win.
   - Bonus: **`ghax cookies --has <name>`** (exit 0/1) for scripting an auth assertion.
   - Privacy note: the full dump prints raw cookie *values* for all the user's logged-in sites — consider redacting values unless `--values` is passed.

2. **An auth/session sanity helper.** Something like `ghax is-authed --cookie <name>` or `ghax assert cookie <name>` so automation can confirm "login landed" instead of inferring from a redirect. The common failure mode here — `fetch()`-then-`window.location.href` login handlers where a flaky fetch silently leaves you on `/login` — is worth a documented pattern: *don't trust the click; assert the session cookie, then navigate.*

3. **Document the eval-await behavior** (it correctly awaits promises) so people don't suspect it like I briefly did.

4. **Retry/wait ergonomics for slow same-origin POSTs.** A `ghax eval --retry N` or a note that long-running app routes under load can throw `Failed to fetch` (and that ghax can't help that) would set expectations.

5. Unrelated but adjacent: the prior report `2026-06-06-edge-attach-daemon-not-persisting.md` (attach reports success but daemon attachment is lost) is a *different* failure and, if still open, is the more serious one — my attach stayed healthy across dozens of commands this session.

## One-line summary

Session loss was app-side (intermittent dev-login `Failed to fetch` + a React hooks-violation crash), **not ghax**; ghax persisted `SameSite=Strict` cookies fine over CDP nav. Biggest ghax DX gap: `ghax cookies` should scope to the current app, not dump the whole profile.
