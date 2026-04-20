# ghax browser-CLI benchmarks

Reproducible comparison of CLI browser-automation tools.

## Setup

- Hardware: Apple Silicon (M-series), macOS
- Date: 2026-04-19
- Edge running on `--remote-debugging-port=9222` (for ghax + gstack-browse CDP modes)
- Other tools launch their own Chromium each run

## Tools

| Tool             | Version              | Notes |
|------------------|----------------------|-------|
| ghax             | 0.4.1 (Rust)         | This project. Connects to user's real Edge via CDP |
| gstack-browse    | bun-compiled         | Sandboxed Chromium |
| playwright-cli   | 1.59.0-alpha         | Sandboxed Chromium, persistent state |
| agent-browser    | 0.21.2               | Sandboxed Chromium |

## Methodology

Run via `npx tsx test/benchmark.ts --iters=3`. Median of 3 iterations
reported. Two phases:

1. **Cold-start workflow**: launch → goto → text → js → screenshot → snapshot → close
2. **Warm steady-state**: session held open, 5-command loop × 3 iterations

## Results

### Target: `https://example.com` (trivial baseline, ~600 bytes)

```
              tool      total    launch      goto      text        js      shot      snap     close
---------------------------------------------------------------------------------------------------
              ghax     1560ms    1197ms     275ms      37ms      31ms      80ms      42ms      80ms
     agent-browser     3482ms    1533ms    (incl)     302ms     298ms     312ms     306ms     576ms
    playwright-cli     5126ms    2006ms    (incl)    1222ms    1214ms     247ms     196ms     237ms
     gstack-browse     6697ms    1370ms    (incl)      55ms      50ms      93ms      63ms    5094ms  ✗
```

Warm:
```
  ghax               49ms/cmd
  gstack-browse      58ms/cmd
  agent-browser     344ms/cmd
  playwright-cli    680ms/cmd
```

### Target: `https://en.wikipedia.org/wiki/JavaScript` (real-world, ~250 KB)

```
              tool      total    launch      goto      text        js      shot      snap     close
---------------------------------------------------------------------------------------------------
              ghax     3049ms    1907ms     542ms     154ms      32ms     102ms     215ms      77ms
     agent-browser     3561ms    1651ms    (incl)     323ms     293ms     336ms     477ms     438ms
    playwright-cli     6060ms    2478ms    (incl)    1404ms    1291ms     372ms     295ms     222ms
     gstack-browse     8595ms    1566ms    (incl)      65ms      58ms    1540ms     241ms    5090ms  ✗
```

Warm:
```
  ghax              117ms/cmd
  agent-browser     405ms/cmd
  gstack-browse     438ms/cmd
  playwright-cli    778ms/cmd
```

## Headlines

- **Cold start**: ghax wins both runs (1.6 / 3.0 s vs 3.5–8.6 s for the field).
- **Warm steady-state**: ghax is 3.5–6.6× faster per command than the
  sandboxed-Chromium tools because it reuses the user's already-open browser
  via CDP — no per-command launch tax.
- **Text extraction on real content**: ghax 154 ms vs playwright-cli 1404 ms
  on the Wikipedia article. 9× faster.
- **Bug spotted in gstack-browse**: close/teardown step takes ~5 s and
  reports failure on every run. Likely a leak in its `stop` command.

## Reproduce

```bash
git clone https://github.com/kepptic/ghax
cd ghax
bun run build:all                                            # build daemon + Rust CLI
npx tsx test/benchmark.ts --iters=3                          # vs Wikipedia (default)
npx tsx test/benchmark.ts --iters=3 --url=https://github.com # vs custom site
```

You need: Rust 1.80+, Node 20+. Plus whichever competitors you want to
compare against on PATH (`gstack-browse`, `playwright-cli`, `agent-browser`).
The script auto-skips any that aren't installed.

## Caveats

- ghax + gstack-browse (CDP mode) reuse the user's Edge, so they avoid
  the per-run Chromium launch cost. That's the architectural win, not
  cherry-picking — it's the whole reason these tools exist.
- agent-browser and playwright-cli launch a fresh Chromium per session.
- gstack-browse is the older Bun-compiled version; the team is working
  on its own Rust port. Numbers will shift.
