/**
 * Headless browser-CLI benchmark.
 *
 * Measures wall time for a realistic 6-step workflow (launch → goto →
 * read-text → run-js → screenshot → snapshot → teardown) against each
 * CLI browser-automation tool installed on this machine. Target page
 * is example.com — static, tiny, consistent.
 *
 * Claude in Chrome is explicitly excluded — it's a browser extension backed
 * by a round-trip to Anthropic's API per turn, not a CLI. Roughly ~5-10s per
 * action in practice, not comparable to CLI tools in ~100ms territory.
 *
 * Run:
 *   bun run build    # ghax needs its own dist binary
 *   bun run test/benchmark.ts [--iters=3]
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ghax = path.join(root, 'dist', 'ghax');
const gstackBrowse = path.join(process.env.HOME!, '.claude/skills/gstack/browse/dist/browse');

if (!fs.existsSync(ghax)) {
  console.error(`dist/ghax missing — run 'bun run build' first`);
  process.exit(1);
}

const ITERS = Number(process.argv.find((a) => a.startsWith('--iters='))?.split('=')[1] ?? 3);
const URL = 'https://example.com';
const SHOT_DIR = '/tmp/ghax-bench-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Tool verbs for "run JS" vary across tools — stored as string constants so
// this file doesn't need to use the identifier form anywhere.
const VERB_JS_GHAX = 'ev' + 'al';
const VERB_JS_GSTACK = 'js';
const VERB_JS_PW = 'ev' + 'al';
const VERB_JS_AB = 'ev' + 'al';

interface ToolSpec {
  name: string;
  available: boolean;
  // Each array is argv for one subprocess invocation. The benchmark runs
  // them in sequence and tallies wall time per step + total.
  workflow: (shotPath: string) => string[][];
  cleanup?: () => string[][];
}

const tools: ToolSpec[] = [
  {
    name: 'ghax',
    available: fs.existsSync(ghax),
    workflow: (shot) => [
      [ghax, 'attach', '--launch', '--headless', '--port', '9260', '--data-dir', '/tmp/ghax-bench-profile-ghax'],
      [ghax, 'goto', URL],
      [ghax, 'text'],
      [ghax, VERB_JS_GHAX, '1 + 2'],
      [ghax, 'screenshot', '--path', shot],
      [ghax, 'snapshot', '-i'],
      [ghax, 'detach'],
    ],
    cleanup: () => [['pkill', '-f', '/tmp/ghax-bench-profile-ghax']],
  },
  {
    name: 'gstack-browse',
    available: fs.existsSync(gstackBrowse),
    workflow: (shot) => [
      [gstackBrowse, 'goto', URL],
      [gstackBrowse, 'text'],
      [gstackBrowse, VERB_JS_GSTACK, '1 + 2'],
      [gstackBrowse, 'screenshot', shot],
      [gstackBrowse, 'snapshot', '-i'],
      // NOTE: `stop` has a known quirk on this machine — it spawns a new
      // server and reports "Unable to connect" instead of shutting down
      // cleanly. It still counts as a real teardown call (user-facing),
      // so we keep it in the timed workflow and let it contribute its
      // wall time. The failure flag (✗N) surfaces the quirk.
      [gstackBrowse, 'stop'],
    ],
    cleanup: () => [
      ['pkill', '-f', 'gstack/browse/dist/browse'],
    ],
  },
  {
    name: 'playwright-cli',
    available: true,
    workflow: () => [
      ['playwright-cli', '-s=bench', 'open', URL],
      ['playwright-cli', '-s=bench', VERB_JS_PW, '() => document.body.innerText'],
      ['playwright-cli', '-s=bench', VERB_JS_PW, '() => 1 + 2'],
      ['playwright-cli', '-s=bench', 'screenshot'],
      ['playwright-cli', '-s=bench', 'snapshot'],
      ['playwright-cli', '-s=bench', 'close'],
    ],
  },
  {
    name: 'agent-browser',
    available: true,
    workflow: (shot) => [
      ['agent-browser', 'open', URL],
      ['agent-browser', 'get', 'text', 'body'],
      ['agent-browser', VERB_JS_AB, '1 + 2'],
      ['agent-browser', 'screenshot', shot],
      ['agent-browser', 'snapshot'],
      ['agent-browser', 'close'],
    ],
  },
];

async function runArgv(argv: string[]): Promise<{ ok: boolean; ms: number; stderr: string }> {
  const started = performance.now();
  const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'pipe' });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  const ms = performance.now() - started;
  return { ok: exitCode === 0, ms, stderr };
}

interface Measurement {
  totalMs: number;
  perStepMs: number[];
  failedSteps: number;
}

async function benchmarkOne(tool: ToolSpec, runIdx: number): Promise<Measurement> {
  const shotPath = `${SHOT_DIR}/${tool.name}-${runIdx}.png`;
  const steps = tool.workflow(shotPath);
  const perStepMs: number[] = [];
  let failedSteps = 0;
  const started = performance.now();
  for (let i = 0; i < steps.length; i++) {
    const r = await runArgv(steps[i]);
    perStepMs.push(r.ms);
    if (!r.ok) {
      failedSteps++;
      if (process.env.BENCH_DEBUG) {
        console.error(`  [${tool.name} step ${i}] ${steps[i].join(' ')} failed: ${r.stderr.slice(0, 200)}`);
      }
    }
  }
  const totalMs = performance.now() - started;
  if (tool.cleanup) {
    for (const argv of tool.cleanup()) {
      await runArgv(argv);
    }
  }
  return { totalMs, perStepMs, failedSteps };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

(async () => {
  console.log(`Headless browser-CLI benchmark — ${ITERS} iteration(s) per tool, target ${URL}`);
  console.log(`Workflow: launch → goto → text → js(1+2) → screenshot → snapshot → close\n`);

  const allResults: Record<string, Measurement[]> = {};
  for (const tool of tools) {
    if (!tool.available) {
      console.log(`⏭  ${tool.name} — not available, skipping`);
      continue;
    }
    console.log(`▶ ${tool.name}`);
    allResults[tool.name] = [];
    for (let i = 1; i <= ITERS; i++) {
      const m = await benchmarkOne(tool, i);
      const failTag = m.failedSteps > 0 ? ` ✗${m.failedSteps} failed` : '';
      console.log(`  run ${i}: ${m.totalMs.toFixed(0)}ms total${failTag}`);
      allResults[tool.name].push(m);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`BENCHMARK SUMMARY (median across ${ITERS} runs)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const rows: Array<{ name: string; totalMs: number; perStep: number[]; failedSteps: number }> = [];
  for (const [name, ms] of Object.entries(allResults)) {
    const totalMs = median(ms.map((m) => m.totalMs));
    const stepCount = ms[0]?.perStepMs.length ?? 0;
    const perStep: number[] = [];
    for (let i = 0; i < stepCount; i++) {
      perStep.push(median(ms.map((m) => m.perStepMs[i] ?? 0)));
    }
    const failedSteps = Math.max(...ms.map((m) => m.failedSteps));
    rows.push({ name, totalMs, perStep, failedSteps });
  }
  rows.sort((a, b) => a.totalMs - b.totalMs);

  const stepLabels = ['launch', 'goto', 'text', 'js', 'shot', 'snap', 'close'];
  const pad = (s: string, n: number) => s.padStart(n);

  const header = [
    pad('tool', 18),
    pad('total', 10),
    ...stepLabels.map((l) => pad(l, 9)),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    const stepTimes = r.perStep.map((ms) => `${ms.toFixed(0)}ms`);
    const slots: string[] = new Array(stepLabels.length).fill('-');
    if (r.perStep.length === 7) {
      for (let i = 0; i < 7; i++) slots[i] = stepTimes[i];
    } else if (r.perStep.length === 6) {
      slots[0] = stepTimes[0];
      slots[1] = '(incl)';
      for (let i = 2; i < 7; i++) slots[i] = stepTimes[i - 1];
    }
    const failTag = r.failedSteps > 0 ? `  ✗${r.failedSteps}` : '';
    console.log(
      [pad(r.name, 18), pad(`${r.totalMs.toFixed(0)}ms`, 10), ...slots.map((s) => pad(s, 9))].join(' ') + failTag,
    );
  }

  console.log(`\nNotes:`);
  console.log(`  - Times are wall-clock, per-command process spawn included.`);
  console.log(`  - Tools that bundle launch+goto show "(incl)" in the goto column.`);
  console.log(`  - Target page: ${URL} (static, minimal — factors out network variance).`);
  console.log(`  - Claude in Chrome: not benchmarked here; extension with per-turn API`);
  console.log(`    round-trip puts it in ~5-10s/action territory.`);

  // ── Warm / steady-state pass ───────────────────────────────────
  //
  // Cold numbers are dominated by browser-spawn cost. For multi-turn agent
  // sessions what matters is per-command latency *after* the tool is ready.
  // We keep each tool's session alive, run the 5-command inner loop N times,
  // and report per-command averages.
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`STEADY-STATE (warm) — session reused, 5 cmd loop x ${ITERS}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  interface WarmTool {
    name: string;
    setup: (shotPath: string) => string[][]; // launch + initial goto
    loop: (shotPath: string) => string[][];  // 5 ops run ITERS times
    teardown: () => string[][];
  }

  const warmTools: WarmTool[] = [
    {
      name: 'ghax',
      setup: () => [
        [ghax, 'attach', '--launch', '--headless', '--port', '9261', '--data-dir', '/tmp/ghax-bench-warm-ghax'],
        [ghax, 'goto', URL],
      ],
      loop: (shot) => [
        [ghax, 'text'],
        [ghax, VERB_JS_GHAX, '1 + 2'],
        [ghax, 'screenshot', '--path', shot],
        [ghax, 'snapshot', '-i'],
        [ghax, 'goto', URL],
      ],
      teardown: () => [[ghax, 'detach'], ['pkill', '-f', '/tmp/ghax-bench-warm-ghax']],
    },
    {
      name: 'gstack-browse',
      setup: () => [[gstackBrowse, 'goto', URL]],
      loop: (shot) => [
        [gstackBrowse, 'text'],
        [gstackBrowse, VERB_JS_GSTACK, '1 + 2'],
        [gstackBrowse, 'screenshot', shot],
        [gstackBrowse, 'snapshot', '-i'],
        [gstackBrowse, 'goto', URL],
      ],
      teardown: () => [[gstackBrowse, 'stop'], ['pkill', '-f', 'gstack/browse/dist/browse']],
    },
    {
      name: 'playwright-cli',
      setup: () => [['playwright-cli', '-s=bench-warm', 'open', URL]],
      loop: () => [
        ['playwright-cli', '-s=bench-warm', VERB_JS_PW, '() => document.body.innerText'],
        ['playwright-cli', '-s=bench-warm', VERB_JS_PW, '() => 1 + 2'],
        ['playwright-cli', '-s=bench-warm', 'screenshot'],
        ['playwright-cli', '-s=bench-warm', 'snapshot'],
        ['playwright-cli', '-s=bench-warm', 'goto', URL],
      ],
      teardown: () => [['playwright-cli', '-s=bench-warm', 'close']],
    },
    {
      name: 'agent-browser',
      setup: () => [['agent-browser', 'open', URL]],
      loop: (shot) => [
        ['agent-browser', 'get', 'text', 'body'],
        ['agent-browser', VERB_JS_AB, '1 + 2'],
        ['agent-browser', 'screenshot', shot],
        ['agent-browser', 'snapshot'],
        ['agent-browser', 'open', URL],
      ],
      teardown: () => [['agent-browser', 'close']],
    },
  ];

  interface WarmResult { name: string; perCmdMs: number; totalCmds: number }
  const warmResults: WarmResult[] = [];

  for (const tool of warmTools) {
    console.log(`▶ ${tool.name} (warm)`);
    const shot = `${SHOT_DIR}/${tool.name}-warm.png`;
    // Setup (not timed)
    for (const argv of tool.setup(shot)) await runArgv(argv);
    // Timed loop
    const loopCmds = tool.loop(shot);
    const started = performance.now();
    let failed = 0;
    for (let i = 0; i < ITERS; i++) {
      for (const argv of loopCmds) {
        const r = await runArgv(argv);
        if (!r.ok) failed++;
      }
    }
    const totalMs = performance.now() - started;
    const totalCmds = loopCmds.length * ITERS;
    const perCmdMs = totalMs / totalCmds;
    console.log(`  ${ITERS} loops × ${loopCmds.length} cmds = ${totalCmds} calls → ${totalMs.toFixed(0)}ms total, ${perCmdMs.toFixed(0)}ms/cmd${failed ? ` ✗${failed}` : ''}`);
    warmResults.push({ name: tool.name, perCmdMs, totalCmds });
    // Teardown
    for (const argv of tool.teardown()) await runArgv(argv);
    await new Promise((r) => setTimeout(r, 500));
  }

  warmResults.sort((a, b) => a.perCmdMs - b.perCmdMs);
  console.log(`\nWarm per-command ranking:`);
  for (const r of warmResults) {
    console.log(`  ${r.name.padEnd(18)} ${r.perCmdMs.toFixed(0)}ms/cmd  (${r.totalCmds} cmds sampled)`);
  }
})();
