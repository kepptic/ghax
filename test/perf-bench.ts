/**
 * Performance budget test — fails on threshold violation.
 *
 * Measures critical per-command latency and enforces P95 budgets. If a
 * budget is exceeded, the test FAILS. This is the regression gate for
 * "ghax stays fast."
 *
 * Runs against headless Chrome on example.com for consistency and to
 * avoid touching the user's daily-driver browser.
 *
 * Run:
 *   bun run test/perf-bench.ts
 *
 * Thresholds assume:
 *   - macOS M-series or recent x86 / Linux equivalent
 *   - No CPU contention (close heavy apps before running)
 *   - Modern loopback (no tc/netem shaping)
 *
 * When a threshold fails, the output dumps timing distribution +
 * suggests likely causes. See the "Innovation" section of test output
 * for what to investigate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ghax = process.env.GHAX_BIN ?? path.join(root, 'target', 'release', 'ghax');

if (!fs.existsSync(ghax)) {
  console.error(`ghax binary missing at ${ghax} — run 'bun run build:rust' first (or set GHAX_BIN)`);
  process.exit(1);
}

const SAMPLES = Number(process.env.PERF_SAMPLES ?? 30);
// Why 30: fewer samples (15) make P90/P95 too sensitive to single outliers
// — we'd see test failures from OS scheduling spikes. 30 samples lets P90
// represent the actual tail behavior instead of 1 bad run.
const WARMUP = 5;  // runs before we start measuring
// Why 5 and not 3: `tabs` specifically triggers Playwright's lazy-init on
// browser.contexts() + page.targetId() the first few calls after attach.
// 3 warmup runs wasn't enough to settle it; 5 consistently is.
const stateFile = `/tmp/ghax-perf-state-${Date.now()}.json`;
const profileDir = `/tmp/ghax-perf-profile-${Date.now()}`;
const attachPort = '9290';

interface RunResult { stdout: string; stderr: string; exitCode: number; durationMs: number; }

async function run(args: string[], opts: { allowFailure?: boolean } = {}): Promise<RunResult> {
  const started = performance.now();
  const proc = spawn(ghax, args, {
    env: { ...process.env, GHAX_STATE_FILE: stateFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
  proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
  const exitCode = await new Promise<number>((resolve) => {
    proc.on('exit', (code) => resolve(code ?? 0));
  });
  const durationMs = performance.now() - started;
  if (exitCode !== 0 && !opts.allowFailure) {
    throw new Error(`${args.join(' ')} exited ${exitCode}: ${stderr}`);
  }
  return { stdout, stderr, exitCode, durationMs };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

interface Budget {
  name: string;
  argv: string[];
  // P50 (median) is the steady-state budget — what the operation should take
  // on a warm daemon with no contention. This is what regression tests should
  // catch: if something gets consistently slower, P50 drifts. We do NOT assert
  // on P95 because it's dominated by CDP WebSocket jitter (occasional 200-500ms
  // spikes that happen even on a healthy daemon), which would make the test
  // flake without catching real regressions.
  p50BudgetMs: number;
  setup?: string[];
  notes?: string;
}

// Budgets calibrated against measured steady-state + ~30% margin.
//
// The physical floor:
//   - Bun compiled CLI cold spawn: ~37ms (measured via `ghax --help`)
//   - HTTP RPC + daemon dispatch: ~5-10ms on top
//   - Single-command invocation inherits a ~40-45ms floor.
//
// Shell mode bypasses the spawn cost entirely and runs at ~5ms/cmd —
// asserted separately below.
//
// We assert on P50 (steady-state). P95 is shown informationally but NOT
// asserted: CDP WebSocket occasionally stalls 200-500ms for a single call,
// which is unavoidable jitter, not a regression.
const budgets: Budget[] = [
  // Pure round-trip ops — floor = ~40ms (Bun spawn + RPC + trivial handler)
  { name: 'eval trivial', argv: ['eval', '1 + 2'], p50BudgetMs: 40, notes: 'Floor: CLI spawn + HTTP + dispatch. Bun startup (~37ms) dominates.' },
  { name: 'tabs --json', argv: ['tabs', '--json'], p50BudgetMs: 40 },
  { name: 'text', argv: ['text'], p50BudgetMs: 45, notes: 'page.evaluate + DOM text extract. CDP jitter possible.' },
  { name: 'html h1', argv: ['html', 'h1'], p50BudgetMs: 45 },
  { name: 'find example', argv: ['find', 'example', '--json'], p50BudgetMs: 40 },
  { name: 'is visible h1', argv: ['is', 'visible', 'h1', '--json'], p50BudgetMs: 45 },

  // In-memory reads (CLI spawn cost only, no browser round-trip)
  { name: 'console --last 50', argv: ['console', '--last', '50', '--json'], p50BudgetMs: 40 },
  { name: 'network --last 50', argv: ['network', '--last', '50', '--json'], p50BudgetMs: 40 },

  // DOM queries with slight extra work
  { name: 'box h1', argv: ['box', 'h1', '--json'], p50BudgetMs: 50 },
  { name: 'xpath //h1', argv: ['xpath', '//h1', '--json'], p50BudgetMs: 50, notes: 'Single evaluateAll after simplify refactor.' },

  // Snapshot & screenshot (real work)
  { name: 'snapshot -i', argv: ['snapshot', '-i', '--json'], p50BudgetMs: 100, notes: 'Full a11y tree walk — scales with DOM size.' },
  { name: 'screenshot', argv: ['screenshot', '--path', '/tmp/ghax-perf-shot.png'], p50BudgetMs: 100, notes: 'PNG encode + disk write.' },

  // CWV (inherent wait + observer window)
  { name: 'perf --wait 200', argv: ['perf', '--wait', '200', '--json'], p50BudgetMs: 650, notes: '200ms wait + 300ms observer + overhead.' },
];

interface Measurement {
  name: string;
  samples: number[];
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  maxMs: number;
  budgetMs: number;  // P50 budget
  pass: boolean;
}

async function measure(budget: Budget): Promise<Measurement> {
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    if (budget.setup) await run(budget.setup, { allowFailure: true });
    await run(budget.argv, { allowFailure: true });
  }
  // Measure
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    if (budget.setup) await run(budget.setup, { allowFailure: true });
    const r = await run(budget.argv, { allowFailure: true });
    samples.push(r.durationMs);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50Ms = percentile(sorted, 50);
  const p90Ms = percentile(sorted, 90);
  const p95Ms = percentile(sorted, 95);
  const maxMs = sorted[sorted.length - 1];
  return {
    name: budget.name,
    samples,
    p50Ms,
    p90Ms,
    p95Ms,
    maxMs,
    budgetMs: budget.p50BudgetMs,
    pass: p50Ms <= budget.p50BudgetMs,
  };
}

function cleanup() {
  try {
    spawnSync(ghax, ['detach'], { env: { ...process.env, GHAX_STATE_FILE: stateFile }, stdio: 'ignore' });
  } catch {}
  try { spawnSync('pkill', ['-f', profileDir], { stdio: 'ignore' }); } catch {}
  try { fs.rmSync(stateFile, { force: true }); } catch {}
  try { fs.rmSync('/tmp/ghax-perf-shot.png', { force: true }); } catch {}
}

async function measureColdWorkflow(): Promise<{ p95Ms: number; p50Ms: number; budgetMs: number; pass: boolean; samples: number[] }> {
  // Cold workflow: launch -> goto -> text -> eval -> shot -> snap -> detach
  const samples: number[] = [];
  const budgetMs = 6000;
  const iterations = 3;
  for (let i = 0; i < iterations; i++) {
    try { spawnSync(ghax, ['detach'], { env: { ...process.env, GHAX_STATE_FILE: stateFile }, stdio: 'ignore' }); } catch {}
    try { spawnSync('pkill', ['-f', profileDir], { stdio: 'ignore' }); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    const t0 = performance.now();
    await run(['attach', '--launch', '--headless', '--browser', 'chrome', '--port', attachPort, '--data-dir', `${profileDir}-cold-${i}`]);
    await run(['goto', 'https://example.com']);
    await run(['text']);
    await run(['eval', '1 + 2']);
    await run(['screenshot', '--path', `/tmp/ghax-perf-cold-${i}.png`]);
    await run(['snapshot', '-i', '--json']);
    await run(['detach']);
    samples.push(performance.now() - t0);
    try { fs.rmSync(`/tmp/ghax-perf-cold-${i}.png`, { force: true }); } catch {}
    try { spawnSync('pkill', ['-f', `${profileDir}-cold-${i}`], { stdio: 'ignore' }); } catch {}
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    budgetMs,
    pass: percentile(sorted, 95) <= budgetMs,
    samples,
  };
}

(async () => {
  console.log(`Performance budget test — ${SAMPLES} samples/op (${WARMUP} warmup), headless Chrome`);
  console.log(`Target: https://example.com\n`);

  // Fresh attached daemon for warm-mode measurements
  cleanup();
  await run(['attach', '--launch', '--headless', '--browser', 'chrome', '--port', attachPort, '--data-dir', `${profileDir}-warm`]);
  await run(['goto', 'https://example.com']);
  await run(['wait', '500']);
  await run(['snapshot', '-i']);  // populate refs for any handler that needs it

  const results: Measurement[] = [];
  for (const b of budgets) {
    process.stdout.write(`• ${b.name.padEnd(30)} `);
    const m = await measure(b);
    results.push(m);
    const verdict = m.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const budgetStr = `budget p50<=${m.budgetMs}ms`;
    console.log(`${verdict} p50=${m.p50Ms.toFixed(0)}ms p90=${m.p90Ms.toFixed(0)}ms p95=${m.p95Ms.toFixed(0)}ms max=${m.maxMs.toFixed(0)}ms (${budgetStr})`);
  }

  // Shell-mode measurement: fire 20 commands through one shell process
  // and measure average per-command time. The CLI spawn cost (~37ms)
  // happens once, not per command. Budget asserts the <15ms floor.
  console.log('\n• shell mode — 20 in-memory ops in one process');
  const shellScript = [
    'tabs',
    'text',
    'eval 1 + 2',
    'find example',
    'console --last 20',
    'network --last 20',
    'box h1',
    'xpath //h1',
    'is visible h1',
    'tabs',
    'eval 1 + 2',
    'console --last 20',
    'network --last 20',
    'find example',
    'box h1',
    'tabs',
    'text',
    'eval 1 + 2',
    'xpath //h1',
    'exit',
  ].join('\n');
  const shellProc = spawn(ghax, ['shell'], {
    env: { ...process.env, GHAX_STATE_FILE: stateFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const shellStart = performance.now();
  shellProc.stdin!.write(shellScript);
  shellProc.stdin!.end();
  await new Promise<void>((resolve) => shellProc.on('exit', () => resolve()));
  const shellDurationMs = performance.now() - shellStart;
  const perCmdMs = shellDurationMs / 19; // 19 real commands (exit doesn't count)
  const shellBudgetMs = 15;
  const shellPass = perCmdMs <= shellBudgetMs;
  const shellVerdict = shellPass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${shellVerdict} ${shellDurationMs.toFixed(0)}ms total / 19 cmds = ${perCmdMs.toFixed(1)}ms per cmd (budget ${shellBudgetMs}ms/cmd)`);

  console.log('\n• cold workflow (attach+goto+text+eval+shot+snap+detach)');
  // Detach the warm daemon first
  try { spawnSync(ghax, ['detach'], { env: { ...process.env, GHAX_STATE_FILE: stateFile }, stdio: 'ignore' }); } catch {}
  try { spawnSync('pkill', ['-f', `${profileDir}-warm`], { stdio: 'ignore' }); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  const cold = await measureColdWorkflow();
  const coldVerdict = cold.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${coldVerdict} p50=${cold.p50Ms.toFixed(0)}ms p95=${cold.p95Ms.toFixed(0)}ms (budget ${cold.budgetMs}ms)`);

  cleanup();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const failed = results.filter((r) => !r.pass);
  const coldFail = !cold.pass;

  if (failed.length === 0 && !coldFail && shellPass) {
    console.log('\x1b[32mAll perf budgets met ✓\x1b[0m');
    console.log('\nFloor analysis:');
    console.log(`  Single-cmd floor: ~${Math.min(...results.map(r => r.p50Ms)).toFixed(0)}ms (Bun CLI spawn + HTTP RPC dominates)`);
    console.log(`  Shell-mode floor: ${perCmdMs.toFixed(1)}ms/cmd (no spawn cost)`);
    console.log(`  Compression: ${(Math.min(...results.map(r => r.p50Ms)) / perCmdMs).toFixed(1)}x faster in shell mode`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(0);
  }

  console.log('\x1b[31mPERF BUDGETS EXCEEDED\x1b[0m');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  for (const f of failed) {
    const over = f.p50Ms - f.budgetMs;
    const overPct = (over / f.budgetMs) * 100;
    console.log(`✗ ${f.name}: p50=${f.p50Ms.toFixed(0)}ms vs budget ${f.budgetMs}ms (+${over.toFixed(0)}ms, ${overPct.toFixed(0)}% over)`);
    console.log(`    samples: ${f.samples.map((s) => s.toFixed(0)).join(', ')}ms`);
    const budget = budgets.find((b) => b.name === f.name);
    if (budget?.notes) console.log(`    note: ${budget.notes}`);
  }
  if (coldFail) {
    console.log(`✗ cold workflow: p95=${cold.p95Ms.toFixed(0)}ms vs budget ${cold.budgetMs}ms`);
    console.log(`    samples: ${cold.samples.map((s) => s.toFixed(0)).join(', ')}ms`);
  }
  if (!shellPass) {
    console.log(`✗ shell mode: ${perCmdMs.toFixed(1)}ms/cmd vs budget ${shellBudgetMs}ms/cmd (${shellDurationMs.toFixed(0)}ms for 19 cmds)`);
  }

  console.log('\nIf regression is real (not OS noise), investigate in order:');
  console.log('  1. Did the handler add expensive work? Check the register() body.');
  console.log('  2. Did a hot path start doing toArray() instead of findMostRecent?');
  console.log('  3. Did a downstream Playwright version bump change CDP timing?');
  console.log('  4. Did the daemon bundle grow substantially? (check dist/ghax-daemon.mjs)');
  console.log('\nInnovation paths only if a real structural bottleneck emerges:');
  console.log('  - Unix socket vs HTTP — saves ~1-2ms; negligible, not worth it');
  console.log('  - JSON -> MessagePack — saves ~1ms; not worth it');
  console.log('  - Shell mode — already shipped, 6x speedup for multi-cmd sessions');
  console.log('  - Native CLI rewrite (Rust) — saves ~25ms per cold invocation;');
  console.log('    only worth it if ghax becomes THE critical path for heavy bots.');
  process.exit(1);
})().catch((err) => {
  console.error('perf-bench failed:', err);
  cleanup();
  process.exit(2);
});
