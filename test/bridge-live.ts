/**
 * ghax bridge — LIVE end-to-end test over a real browser + the unpacked
 * extension. The counterpart to test/bridge-sim.ts (which needs no browser):
 * this exercises the actual CDP relay path that the simulator can only fake.
 *
 * It is opt-in and NOT part of the default suite, because it needs a human to
 * have loaded the extension and pointed it at a tab — which CI can't do:
 *
 *   1. Load extension/ unpacked in Edge/Chrome (edge://extensions).
 *   2. `GHAX_STATE_FILE=/tmp/ghax-live.json ghax attach --extension --control-active`
 *      (or click "Control this tab" in the popup).
 *   3. `GHAX_SMOKE_BRIDGE=1 GHAX_STATE_FILE=/tmp/ghax-live.json npm run test:bridge-live`
 *
 * It drives goto → wait --stable → snapshot → back/forward → eval over the
 * real bridge and asserts each lands. Non-destructive: it navigates to
 * example.com / example.org only.
 *
 * Exit 0 on success, non-zero on the first failure. Skips cleanly (exit 0)
 * unless GHAX_SMOKE_BRIDGE=1, so a bare `npm test` never trips on it.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ghax = process.env.GHAX_BIN ?? path.join(root, 'target', 'release', 'ghax');

if (process.env.GHAX_SMOKE_BRIDGE !== '1') {
  console.log('bridge-live: set GHAX_SMOKE_BRIDGE=1 to run (needs a real browser + the loaded extension). Skipping.');
  process.exit(0);
}

interface RunResult { stdout: string; stderr: string; code: number }

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(ghax, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('exit', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function parse<T>(s: string): T {
  const t = s.trim();
  const start = t.search(/[{[]/);
  return JSON.parse(start >= 0 ? t.slice(start) : t) as T;
}

let checks = 0, failures = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  checks++;
  try {
    await fn();
    console.log(`• ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n    ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log('bridge-live: driving the real extension bridge\n');

  // Confirm we're actually talking to a bridge daemon with a controlled tab.
  const status = await run(['status', '--json']);
  assert(status.code === 0, `status failed — is a bridge daemon attached? ${status.stderr}`);
  const st = parse<{ browserUrl?: string }>(status.stdout);
  assert(
    String(st.browserUrl ?? '').startsWith('bridge://'),
    `not a bridge daemon (browserUrl=${st.browserUrl}). See the header of this file.`,
  );

  await test('bridge instances shows a bound driver', async () => {
    const r = await run(['bridge', 'instances', '--json']);
    const data = parse<{ state: string; instances: Array<{ role: string }> }>(r.stdout);
    assert(data.state === 'BOUND', `expected BOUND, got ${data.state}`);
    assert(data.instances.some((i) => i.role === 'bound'), 'no bound instance');
  });

  await test('goto --stable navigates the real tab and settles', async () => {
    const r = await run(['goto', 'https://example.com', '--stable', '--json']);
    const g = parse<{ url: string; stable: boolean }>(r.stdout);
    assert(g.url.includes('example.com'), `url was ${g.url}`);
    assert(g.stable === true, 'example.com should settle');
  });

  await test('snapshot -i returns interactive refs over the bridge', async () => {
    const r = await run(['snapshot', '-i', '--json']);
    const snap = parse<{ count: number }>(r.stdout);
    assert(snap.count >= 1, `expected ≥1 ref, got ${snap.count}`);
  });

  await test('eval reads the live document via the pinned context', async () => {
    const r = await run(['eval', 'document.title']);
    assert(/example/i.test(r.stdout), `title should mention example, got ${r.stdout.trim()}`);
  });

  await test('back/forward reconcile-navigate the history', async () => {
    await run(['goto', 'https://example.org']);
    const back = await run(['back', '--json']);
    const b = parse<{ url: string; outcome?: string }>(back.stdout);
    assert(b.url.includes('example.com'), `back should return to example.com, got ${b.url}`);
    assert(b.outcome === 'succeeded', `outcome should be succeeded, got ${b.outcome}`);
    const fwd = await run(['forward', '--json']);
    const f = parse<{ url: string }>(fwd.stdout);
    assert(f.url.includes('example.org'), `forward should return to example.org, got ${f.url}`);
  });

  console.log();
  if (failures > 0) {
    console.error(`✗ ${failures}/${checks} checks failed`);
    process.exit(1);
  }
  console.log(`✓ ${checks}/${checks} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
