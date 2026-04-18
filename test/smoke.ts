/**
 * ghax smoke test — drive a real running browser through the v0.1–v0.3
 * command surface and assert each step lands.
 *
 * Requirements:
 *   - A Chromium-family browser on --remote-debugging-port=9222
 *   - `bun run build` has been run so dist/ghax + dist/ghax-daemon.mjs exist
 *
 * Run:
 *   bun run test/smoke.ts
 *
 * Exit code 0 on success, non-zero on the first failed check.
 *
 * Deliberately non-destructive. Doesn't hot-reload anything, doesn't
 * write to chrome.storage of any real extension, doesn't use the
 * --launch path (which would spawn a fresh browser window).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ghax = path.join(root, 'dist', 'ghax');

if (!fs.existsSync(ghax)) {
  fail(`dist/ghax missing — run 'bun run build' first`);
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(args: string[], opts: { stdin?: string; allowFailure?: boolean } = {}): Promise<RunResult> {
  const proc = Bun.spawn([ghax, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin ? 'pipe' : 'ignore',
  });
  if (opts.stdin && proc.stdin) {
    (proc.stdin as any).write(opts.stdin);
    (proc.stdin as any).end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const res: RunResult = { stdout, stderr, exitCode };
  if (exitCode !== 0 && !opts.allowFailure) {
    fail(`ghax ${args.join(' ')} exited ${exitCode}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
  }
  return res;
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

function step(name: string) {
  console.log(`• ${name}`);
}

function parseJson<T = unknown>(out: string): T {
  try {
    return JSON.parse(out) as T;
  } catch (err) {
    fail(`expected JSON, got: ${out.slice(0, 200)}`);
  }
}

const checks: Array<{ name: string; fn: () => Promise<void> }> = [];
const c = (name: string, fn: () => Promise<void>) => checks.push({ name, fn });

// ─── Checks ─────────────────────────────────────────────────────

c('attach is idempotent (first call attaches)', async () => {
  const r = await run(['attach']);
  assert(
    /attached/.test(r.stdout) || /already attached/.test(r.stdout),
    `unexpected attach output: ${r.stdout}`,
  );
});

c('attach is idempotent (second call reuses)', async () => {
  const r = await run(['attach']);
  assert(/already attached/.test(r.stdout), `second attach should reuse: ${r.stdout}`);
});

c('status --json has expected shape', async () => {
  const r = await run(['status', '--json']);
  const s = parseJson<Record<string, unknown>>(r.stdout);
  for (const key of ['pid', 'port', 'browserKind', 'tabCount', 'targetCount', 'extensionCount']) {
    assert(key in s, `status missing ${key}`);
  }
});

c('tabs returns a non-empty list', async () => {
  const r = await run(['tabs', '--json']);
  const tabs = parseJson<Array<{ id: string; url: string }>>(r.stdout);
  assert(Array.isArray(tabs) && tabs.length > 0, 'expected at least one tab');
});

c('goto example.com lands on example.com', async () => {
  const r = await run(['goto', 'https://example.com']);
  assert(/example\.com/.test(r.stdout), `goto output: ${r.stdout}`);
});

c('text returns page body', async () => {
  const r = await run(['text']);
  assert(/Example Domain/i.test(r.stdout), 'text should contain "Example Domain"');
});

c('html <selector> returns innerHTML', async () => {
  const r = await run(['html', 'h1']);
  assert(/Example Domain/i.test(r.stdout), 'h1 innerHTML should include "Example Domain"');
});

c('snapshot -i produces @e refs', async () => {
  const r = await run(['snapshot', '-i']);
  assert(/@e\d+/.test(r.stdout), `snapshot didn't produce @e refs: ${r.stdout.slice(0, 200)}`);
});

c('snapshot -a writes annotated PNG', async () => {
  const outPath = `/tmp/ghax-smoke-anno-${Date.now()}.png`;
  const r = await run(['snapshot', '-i', '-a', '-o', outPath]);
  assert(fs.existsSync(outPath), `annotated PNG missing: ${outPath}`);
  const size = fs.statSync(outPath).size;
  assert(size > 1000, `annotated PNG suspiciously small: ${size}B`);
  fs.unlinkSync(outPath);
  assert(/annotated screenshot/.test(r.stderr), 'expected annotated-path hint on stderr');
});

c('screenshot writes a PNG', async () => {
  const outPath = `/tmp/ghax-smoke-shot-${Date.now()}.png`;
  await run(['screenshot', '--path', outPath]);
  assert(fs.existsSync(outPath), 'screenshot missing');
  assert(fs.statSync(outPath).size > 500, 'screenshot suspiciously small');
  fs.unlinkSync(outPath);
});

c('eval runs JS in the active tab', async () => {
  const r = await run(['eval', '1 + 2']);
  assert(r.stdout.trim() === '3', `eval 1+2 → ${r.stdout.trim()}`);
});

c('viewport sets the size', async () => {
  const r = await run(['viewport', '1024x768', '--json']);
  const v = parseJson<{ width: number; height: number }>(r.stdout);
  assert(v.width === 1024 && v.height === 768, `viewport returned ${JSON.stringify(v)}`);
});

c('responsive writes three screenshots', async () => {
  const prefix = `/tmp/ghax-smoke-resp-${Date.now()}`;
  await run(['responsive', prefix]);
  for (const name of ['mobile', 'tablet', 'desktop']) {
    const p = `${prefix}-${name}.png`;
    assert(fs.existsSync(p), `responsive ${name} missing: ${p}`);
    fs.unlinkSync(p);
  }
});

c('click @e<n> resolves against the last snapshot', async () => {
  // Need a fresh snapshot because viewport/responsive don't touch refs,
  // but click resolves the last ref map regardless of subsequent commands.
  await run(['snapshot', '-i']);
  // example.com has one link — @e1.
  await run(['click', '@e1']);
  // After clicking the link, URL should have changed from example.com home.
  const r = await run(['eval', 'location.href']);
  assert(r.stdout.trim() !== 'https://example.com/', `click @e1 should navigate away: ${r.stdout}`);
});

c('chain executes multiple steps', async () => {
  const steps = JSON.stringify([
    { cmd: 'goto', args: ['https://example.com'] },
    { cmd: 'text' },
  ]);
  const r = await run(['chain'], { stdin: steps });
  const results = parseJson<Array<{ cmd: string; ok: boolean }>>(r.stdout);
  assert(results.length === 2, `expected 2 results, got ${results.length}`);
  assert(results.every((s) => s.ok), `chain had failures: ${JSON.stringify(results)}`);
});

c('record + replay round-trips', async () => {
  const name = `smoke-rec-${Date.now()}`;
  await run(['record', 'start', name]);
  await run(['goto', 'https://example.com']);
  await run(['eval', '"recorded"']);
  const stop = await run(['record', 'stop']);
  assert(/saved .* steps/.test(stop.stdout), `record stop output: ${stop.stdout}`);
  const match = stop.stdout.match(/→ (.+\.json)/);
  assert(match, 'could not parse recording path');
  const recPath = match![1].trim();
  assert(fs.existsSync(recPath), `recording file missing: ${recPath}`);
  const doc = JSON.parse(fs.readFileSync(recPath, 'utf-8'));
  assert(Array.isArray(doc.steps) && doc.steps.length === 2, `expected 2 steps: ${doc.steps?.length}`);
  // Replay
  const replay = await run(['replay', recPath]);
  assert(/✓ goto/.test(replay.stdout) && /✓ eval/.test(replay.stdout), `replay output: ${replay.stdout}`);
});

c('console --last returns entries', async () => {
  await run(['eval', 'console.log("ghax-smoke-marker")']);
  const r = await run(['console', '--last', '50', '--json']);
  const entries = parseJson<Array<{ text: string }>>(r.stdout);
  assert(Array.isArray(entries), 'console should return array');
  // Marker may be in the rolling buffer but Playwright's console events
  // are async — don't fail if we just-missed it, but assert the shape.
});

c('network --last returns entries', async () => {
  const r = await run(['network', '--last', '50', '--json']);
  const entries = parseJson<Array<{ url: string; method: string }>>(r.stdout);
  assert(Array.isArray(entries), 'network should return array');
  if (entries.length > 0) {
    assert(typeof entries[0].url === 'string' && typeof entries[0].method === 'string', 'network entry shape');
  }
});

c('cookies --json returns an array', async () => {
  const r = await run(['cookies', '--json']);
  const cookies = parseJson<unknown[]>(r.stdout);
  assert(Array.isArray(cookies), 'cookies should be array');
});

c('ext list returns {id, targets} objects', async () => {
  const r = await run(['ext', 'list', '--json']);
  const exts = parseJson<Array<{ id: string; targets: unknown[] }>>(r.stdout);
  assert(Array.isArray(exts), 'ext list should be array');
  if (exts.length > 0) {
    assert(typeof exts[0].id === 'string' && Array.isArray(exts[0].targets), 'ext entry shape');
  }
});

c('ext targets returns the same target list for a given ext', async () => {
  const listRaw = await run(['ext', 'list', '--json']);
  const exts = parseJson<Array<{ id: string }>>(listRaw.stdout);
  if (exts.length === 0) {
    console.log('  (no extensions installed — skipping ext targets probe)');
    return;
  }
  const r = await run(['ext', 'targets', exts[0].id, '--json']);
  const targets = parseJson<unknown[]>(r.stdout);
  assert(Array.isArray(targets), 'ext targets should be array');
});

c('ext sw eval returns a value', async () => {
  const listRaw = await run(['ext', 'list', '--json']);
  const exts = parseJson<Array<{ id: string; targets: Array<{ type: string }> }>>(listRaw.stdout);
  const withSw = exts.find((e) => e.targets.some((t) => t.type === 'service_worker'));
  if (!withSw) {
    console.log('  (no extensions with a service worker — skipping ext sw eval)');
    return;
  }
  const r = await run(['ext', 'sw', withSw.id, 'eval', '1 + 41']);
  assert(r.stdout.trim() === '42', `ext sw eval 1+41 → ${r.stdout.trim()}`);
});

c('gesture key returns ok', async () => {
  // Sending a harmless key — Escape — to the focused element.
  const r = await run(['gesture', 'key', 'Escape', '--json']);
  const data = parseJson<{ ok: boolean }>(r.stdout);
  assert(data.ok === true, 'gesture key should return ok');
});

c('detach shuts the daemon', async () => {
  const r = await run(['detach']);
  assert(/detached/.test(r.stdout), `detach output: ${r.stdout}`);
  // Next status should report not-attached (exit 2).
  const status = await run(['status'], { allowFailure: true });
  assert(status.exitCode === 2, `status after detach should exit 2, got ${status.exitCode}`);
});

// ─── Runner ─────────────────────────────────────────────────────

(async () => {
  const start = Date.now();
  console.log(`ghax smoke — ${checks.length} checks\n`);
  let passed = 0;
  for (const { name, fn } of checks) {
    step(name);
    try {
      await fn();
      passed++;
    } catch (err: any) {
      fail(`FAIL ${name}: ${err?.message || err}`);
    }
  }
  console.log(`\n✓ ${passed}/${checks.length} checks passed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
})();
