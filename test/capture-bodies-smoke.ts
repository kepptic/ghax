/**
 * --capture-bodies smoke test.
 *
 * The main smoke suite (test/smoke.ts) runs against a pre-attached daemon
 * that wasn't started with `--capture-bodies`, so we can't exercise body
 * capture there. This file spins up a dedicated headless Chrome with the
 * flag set, runs a focused set of checks, then tears down.
 *
 * Requirements:
 *   - A Chrome install on this machine (not Edge — Edge is left alone so
 *     the user's daily-driver isn't touched).
 *   - `bun run build` has been run so dist/ghax + dist/ghax-daemon.mjs exist.
 *
 * Run:
 *   bun run test/capture-bodies-smoke.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ghax = path.join(root, 'dist', 'ghax');

if (!fs.existsSync(ghax)) {
  console.error("dist/ghax missing — run 'bun run build' first");
  process.exit(1);
}

// Dedicated state file + profile so this daemon coexists with any already-
// attached daemon on the default state file.
const stateFile = `/tmp/ghax-cb-state-${Date.now()}.json`;
const profileDir = `/tmp/ghax-cb-profile-${Date.now()}`;
const attachPort = '9272';

interface RunResult { stdout: string; stderr: string; exitCode: number; }

async function run(args: string[], opts: { allowFailure?: boolean; env?: Record<string, string> } = {}): Promise<RunResult> {
  const proc = Bun.spawn([ghax, ...args], {
    env: { ...process.env, GHAX_STATE_FILE: stateFile, ...(opts.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !opts.allowFailure) {
    fail(`${args.join(' ')} exited ${exitCode}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
  }
  return { stdout, stderr, exitCode };
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  try {
    Bun.spawnSync([ghax, 'detach'], { env: { ...process.env, GHAX_STATE_FILE: stateFile } });
  } catch {}
  try {
    Bun.spawnSync(['pkill', '-f', profileDir]);
  } catch {}
  try {
    fs.rmSync(stateFile, { force: true });
  } catch {}
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

// Fixture server: serves an HTML shell at / and two JSON endpoints.
function startFixture(bodyFor40kb: string): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,  // ephemeral
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/users') {
        return Response.json({ users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] });
      }
      if (url.pathname === '/api/big') {
        return new Response(bodyFor40kb, { headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname === '/skip-me') {
        return Response.json({ shouldNotBeCapturedByPattern: true });
      }
      if (url.pathname === '/') {
        return new Response(
          `<!doctype html><html><body><script>
            Promise.all([
              fetch('/api/users').then(r=>r.text()),
              fetch('/api/big').then(r=>r.text()),
              fetch('/skip-me').then(r=>r.text()),
            ]);
          </script></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      }
      return new Response('not found', { status: 404 });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error('Bun.serve did not assign a port');
  return { port, stop: () => server.stop() };
}

(async () => {
  // Generate a 40KB JSON body to test the truncation marker.
  const big = JSON.stringify({ data: 'x'.repeat(40_000) });
  const fixture = startFixture(big);

  console.log('--- capture-bodies smoke ---\n');

  // ── Check 1: capture with pattern glob ──
  console.log('• capture-bodies captures matching URLs');
  await run(['attach', '--launch', '--headless', '--browser', 'chrome', '--port', attachPort, '--data-dir', profileDir, '--capture-bodies=*api*']);
  try {
    await run(['goto', `http://127.0.0.1:${fixture.port}/`]);
    await run(['wait', '800']);
    const r = await run(['network', '--pattern', 'api/users', '--last', '20', '--json']);
    const entries = JSON.parse(r.stdout) as Array<{ url: string; responseBody?: string; responseBodyTruncated?: boolean }>;
    const ours = entries.find((e) => e.url.endsWith('/api/users'));
    assert(ours, 'did not capture /api/users entry');
    assert(ours.responseBody !== undefined, 'responseBody missing');
    assert(ours.responseBody.includes('"Alice"'), `responseBody did not contain Alice: ${ours.responseBody.slice(0, 100)}`);
    assert(!ours.responseBodyTruncated, 'small body should not be truncated');

    // ── Check 2: 40KB truncation ──
    console.log('• capture-bodies truncates large bodies at 32KB with marker');
    const r2 = await run(['network', '--pattern', 'api/big', '--last', '20', '--json']);
    const arr2 = JSON.parse(r2.stdout) as Array<{ url: string; responseBody?: string; responseBodyTruncated?: boolean }>;
    const big = arr2.find((e) => e.url.endsWith('/api/big'));
    assert(big, 'did not capture /api/big entry');
    assert(big.responseBody !== undefined, 'big responseBody missing');
    assert(big.responseBodyTruncated === true, 'responseBodyTruncated should be true');
    assert(big.responseBody.length <= 32 * 1024 + 100, `body too long: ${big.responseBody.length}`);
    assert(/truncated \d+ bytes/.test(big.responseBody), 'truncation marker missing');

    // ── Check 3: Non-matching URL skipped ──
    console.log('• capture-bodies skips URLs not matching the glob');
    const r3 = await run(['network', '--pattern', 'skip-me', '--last', '20', '--json']);
    const arr3 = JSON.parse(r3.stdout) as Array<{ url: string; responseBody?: string }>;
    const skip = arr3.find((e) => e.url.endsWith('/skip-me'));
    assert(skip, 'did not capture /skip-me request entry');
    assert(skip.responseBody === undefined, `/skip-me should not have body captured (glob *api* excludes it), got: ${skip.responseBody?.slice(0, 60)}`);
  } finally {
    await run(['detach'], { allowFailure: true });
    try { Bun.spawnSync(['pkill', '-f', profileDir]); } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── Check 4: zero capture when flag absent ──
  console.log('• no capture when --capture-bodies flag absent');
  await run(['attach', '--launch', '--headless', '--browser', 'chrome', '--port', attachPort, '--data-dir', `${profileDir}-2`]);
  try {
    await run(['goto', `http://127.0.0.1:${fixture.port}/`]);
    await run(['wait', '800']);
    const r = await run(['network', '--pattern', 'api/users', '--last', '20', '--json']);
    const entries = JSON.parse(r.stdout) as Array<{ url: string; responseBody?: string }>;
    const ours = entries.find((e) => e.url.endsWith('/api/users'));
    assert(ours, 'api/users entry should still be recorded (meta only)');
    assert(ours.responseBody === undefined, `no flag set, responseBody should be undefined, got: ${ours.responseBody?.slice(0, 60)}`);
  } finally {
    await run(['detach'], { allowFailure: true });
    try { Bun.spawnSync(['pkill', '-f', `${profileDir}-2`]); } catch {}
  }

  fixture.stop();
  cleanup();
  console.log('\n✓ 4/4 capture-bodies checks passed');
})().catch((err) => {
  console.error('capture-bodies smoke failed:', err);
  cleanup();
  process.exit(1);
});
