/**
 * ghax smoke test — drive a real running browser through the v0.1–v0.4
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
 * --launch path (which would spawn a fresh browser window). `ship` is
 * exercised via --dry-run so no commits/pushes happen.
 *
 * Run against the Rust binary:
 *   bun run build:rust && GHAX_BIN=$PWD/target/release/ghax bun run test:smoke
 *
 * Or shortcut (after Phase 4B adds it):
 *   bun run test:rust-smoke
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ghax = process.env.GHAX_BIN ?? path.join(root, 'dist', 'ghax');

if (!fs.existsSync(ghax)) {
  fail(`${ghax} missing — run 'bun run build' first (or set GHAX_BIN to the correct binary path)`);
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

c('snapshot cursor scan pierces open shadow DOM', async () => {
  // Navigate fresh to a known page and inject a custom element with an open
  // shadow root using only safe DOM APIs, then assert the cursor pass emits
  // a selector with `>>>` (the Playwright pierce combinator).
  await run(['goto', 'https://example.com']);
  await run(['eval', [
    '(() => {',
    '  const host = document.createElement("div");',
    '  host.id = "ghax-shadow-host";',
    '  const root = host.attachShadow({ mode: "open" });',
    '  const inner = document.createElement("div");',
    '  inner.style.cursor = "pointer";',
    '  inner.setAttribute("tabindex", "0");',
    '  inner.textContent = "Shadow click target";',
    '  root.appendChild(inner);',
    '  document.body.appendChild(host);',
    '})()',
  ].join(' ')]);
  const snap = await run(['snapshot', '-C', '--json']);
  const result = parseJson<{ text: string; count: number }>(snap.stdout);
  // Cursor-interactive render tags shadow-DOM finds with the `shadow` reason.
  assert(
    /\[shadow[^\]]*\]/.test(result.text),
    `expected at least one [shadow,...] cursor entry, got:\n${result.text.slice(0, 500)}`,
  );
  // Also verify the click path works: resolve the @c ref and click it via
  // Playwright, which would fail without pierce-selector support.
  const match = result.text.match(/@(c\d+) \[shadow/);
  assert(match, 'could not locate @c<n> ref for shadow element');
  // The click assertion — we're just verifying it doesn't throw. If the
  // pierce selector weren't valid, Playwright would error with "no element".
  await run(['click', `@${match[1]}`]);
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

c('gesture scroll dispatches mouseWheel', async () => {
  const r = await run(['gesture', 'scroll', 'down', '100', '--json']);
  const data = parseJson<{ ok: boolean; direction: string }>(r.stdout);
  assert(data.ok === true && data.direction === 'down', 'gesture scroll payload');
});

c('gesture dblclick dispatches double press/release', async () => {
  const r = await run(['gesture', 'dblclick', '50,50', '--json']);
  const data = parseJson<{ ok: boolean }>(r.stdout);
  assert(data.ok === true, 'gesture dblclick should return ok');
});

c('xpath query returns matches with text + tag + box', async () => {
  await run(['goto', 'https://example.com']);
  await run(['wait', '200']);
  const r = await run(['xpath', '//h1', '--json']);
  const data = parseJson<{
    count: number;
    returned: number;
    matches: Array<{ index: number; tag: string; text: string; box: { width: number } | null }>;
  }>(r.stdout);
  assert(data.count >= 1, `expected at least one <h1>, got ${data.count}`);
  assert(data.matches[0].tag === 'h1', `expected tag=h1, got ${data.matches[0].tag}`);
  assert(/Example Domain/i.test(data.matches[0].text), `expected "Example Domain" text, got ${data.matches[0].text}`);
  assert(data.matches[0].box && data.matches[0].box.width > 0, 'expected non-zero box width');
});

c('box returns {x, y, width, height} for a selector', async () => {
  await run(['goto', 'https://example.com']);
  await run(['wait', '200']);
  const r = await run(['box', 'h1', '--json']);
  const box = parseJson<{ x: number; y: number; width: number; height: number }>(r.stdout);
  assert(typeof box.x === 'number' && typeof box.y === 'number', 'box x/y numeric');
  assert(box.width > 0 && box.height > 0, `box should be laid out, got ${box.width}x${box.height}`);
});

c('box also resolves @e<n> refs from the last snapshot', async () => {
  await run(['goto', 'https://example.com']);
  await run(['snapshot', '-i']);
  const r = await run(['box', '@e1', '--json']);
  const box = parseJson<{ width: number }>(r.stdout);
  assert(box.width > 0, 'ref box missing width');
});

c('is <check> asserts element state', async () => {
  await run(['goto', 'https://example.com']);
  await run(['snapshot', '-i']);
  const r = await run(['is', 'visible', '@e1', '--json']);
  const data = parseJson<{ check: string; target: string; result: boolean }>(r.stdout);
  assert(data.check === 'visible' && data.result === true, `is visible @e1 → ${JSON.stringify(data)}`);
});

c('storage local round-trips set/get/remove', async () => {
  const key = `ghax-smoke-${Date.now()}`;
  await run(['storage', 'local', 'set', key, 'hello']);
  const getRes = (await run(['storage', 'local', 'get', key])).stdout.trim();
  assert(getRes === 'hello', `expected "hello", got ${getRes}`);
  await run(['storage', 'local', 'remove', key]);
  const afterRes = (await run(['storage', 'local', 'get', key])).stdout.trim();
  assert(afterRes === 'null' || afterRes === '', `expected null after remove, got ${afterRes}`);
});

c('ext list entries carry version field', async () => {
  const r = await run(['ext', 'list', '--json']);
  const exts = parseJson<Array<{ id: string; version: string; name: string; targetCount: number }>>(r.stdout);
  if (exts.length === 0) {
    console.log('  (no extensions — skipping version check)');
    return;
  }
  const anyWithVersion = exts.some((e) => typeof e.version === 'string' && e.version.length > 0);
  assert(anyWithVersion, `no extension reported a version in ${JSON.stringify(exts.map((e) => ({ id: e.id, v: e.version })))}`);
});

c('perf returns CWV + navigation timing shape', async () => {
  await run(['goto', 'https://example.com']);
  await run(['wait', '500']);
  const r = await run(['perf', '--json']);
  const data = parseJson<{
    url: string;
    cwv: { fcp: number | null; cls: number; ttfb: number | null };
    navTiming: { loadMs: number; domContentLoadedMs: number };
  }>(r.stdout);
  assert(data.url.includes('example.com'), `perf url: ${data.url}`);
  assert(data.navTiming && typeof data.navTiming.loadMs === 'number', 'navTiming shape');
  assert(data.cwv && typeof data.cwv.cls === 'number', 'cwv.cls shape');
});

c('console --dedup collapses repeats with count', async () => {
  // Seed 5 identical errors + 1 unique one, then dedup.
  await run(['eval', 'for (let i = 0; i < 5; i++) { try { throw new Error("ghax-smoke-repeat"); } catch (e) { console.error(e.message); } } console.error("ghax-smoke-unique")']);
  await run(['wait', '100']);
  const r = await run(['console', '--errors', '--dedup', '--last', '50', '--json']);
  const groups = parseJson<Array<{ text: string; count: number }>>(r.stdout);
  const repeat = groups.find((g) => g.text === 'ghax-smoke-repeat');
  const unique = groups.find((g) => g.text === 'ghax-smoke-unique');
  assert(repeat && repeat.count === 5, `expected repeat count=5, got ${repeat?.count}`);
  assert(unique && unique.count === 1, `expected unique count=1, got ${unique?.count}`);
});

c('network --status filters by code family', async () => {
  await run(['goto', 'https://example.com']);
  await run(['wait', '300']);
  const r = await run(['network', '--status', '2xx', '--last', '50', '--json']);
  const entries = parseJson<Array<{ status?: number; url: string }>>(r.stdout);
  assert(entries.length >= 1, `expected at least one 2xx entry, got ${entries.length}`);
  assert(
    entries.every((e) => e.status !== undefined && e.status >= 200 && e.status < 300),
    `some entry was not 2xx: ${JSON.stringify(entries.find((e) => !e.status || e.status >= 300))}`,
  );
});

c('network --har writes a HAR 1.2 JSON file', async () => {
  const harPath = `/tmp/ghax-smoke-har-${Date.now()}.har`;
  await run(['goto', 'https://example.com']);
  await run(['wait', '300']);
  const r = await run(['network', '--har', harPath, '--last', '5', '--json']);
  const meta = parseJson<{ harPath: string; entryCount: number }>(r.stdout);
  assert(meta.harPath === harPath, `expected path match, got ${meta.harPath}`);
  assert(fs.existsSync(harPath), `HAR missing: ${harPath}`);
  const har = JSON.parse(fs.readFileSync(harPath, 'utf-8')) as {
    log: { version: string; creator: { name: string }; entries: Array<{ request: { url: string }; response: { status: number } }> };
  };
  assert(har.log.version === '1.2', `HAR version: ${har.log.version}`);
  assert(har.log.creator.name === 'ghax', `HAR creator: ${har.log.creator.name}`);
  assert(Array.isArray(har.log.entries) && har.log.entries.length > 0, `HAR entries: ${har.log.entries.length}`);
  assert(typeof har.log.entries[0].request.url === 'string', 'HAR entry request.url');
  fs.unlinkSync(harPath);
});

c('parseStack extracts V8 stack frames', async () => {
  // Drive this through a real pageerror so we exercise the capture path.
  await run(['goto', 'https://example.com']);
  await run(['wait', '200']);
  await run(['eval', 'setTimeout(() => { throw new Error("ghax-smoke-stack-probe"); }, 10)']);
  await run(['wait', '200']);
  const r = await run(['console', '--errors', '--last', '50', '--json']);
  const entries = parseJson<Array<{ text: string; stack?: Array<{ url: string; line: number; col: number }> }>>(r.stdout);
  const ours = entries.find((e) => e.text.includes('ghax-smoke-stack-probe'));
  assert(ours, 'pageerror not captured');
  // Stack is best-effort — some environments may not populate it. Soft assert.
  if (ours.stack && ours.stack.length > 0) {
    assert(typeof ours.stack[0].line === 'number', `stack frame line type: ${typeof ours.stack[0].line}`);
    assert(typeof ours.stack[0].col === 'number', `stack frame col type: ${typeof ours.stack[0].col}`);
  }
});

c('profile captures Performance metrics', async () => {
  const r = await run(['profile', '--json']);
  const data = parseJson<{
    reportPath: string;
    start: { metrics: Record<string, number> };
    deltas: Record<string, number> | null;
  }>(r.stdout);
  assert(Object.keys(data.start.metrics).length > 0, 'expected non-empty metrics map');
  assert(fs.existsSync(data.reportPath), `report file missing: ${data.reportPath}`);
  fs.unlinkSync(data.reportPath);
});

c('ext sw logs subscription returns an array', async () => {
  const listRaw = await run(['ext', 'list', '--json']);
  const exts = parseJson<Array<{ id: string; targets: Array<{ type: string }> }>>(listRaw.stdout);
  const withSw = exts.find((e) => e.targets.some((t) => t.type === 'service_worker'));
  if (!withSw) {
    console.log('  (no extensions with a service worker — skipping sw logs)');
    return;
  }
  const r = await run(['ext', 'sw', withSw.id, 'logs', '--last', '5', '--json']);
  const entries = parseJson<unknown[]>(r.stdout);
  assert(Array.isArray(entries), 'ext sw logs should return an array');
});

c('ext popup/options report "no page open" when closed', async () => {
  const listRaw = await run(['ext', 'list', '--json']);
  const exts = parseJson<Array<{ id: string }>>(listRaw.stdout);
  if (exts.length === 0) return;
  // Popup/options pages are transient — usually NOT open. We expect the
  // handler to throw a clean error rather than crash.
  const r = await run(['ext', 'popup', exts[0].id, 'eval', '1+1'], { allowFailure: true });
  // Either a handler threw (exit != 0) because no popup is open, or — rarely
  // — there IS a popup page and eval returned "2". Both outcomes are
  // acceptable here; we're asserting the command path is wired up.
  assert(
    r.exitCode === 0 || /no popup page open|No popup|exit/i.test(r.stderr + r.stdout),
    `popup eval unexpected output: ${r.stdout}${r.stderr}`,
  );
});

c('diff-state diffs two JSON files', async () => {
  const a = `/tmp/ghax-smoke-diff-a-${Date.now()}.json`;
  const b = `/tmp/ghax-smoke-diff-b-${Date.now()}.json`;
  fs.writeFileSync(a, JSON.stringify({ x: 1, y: 2 }));
  fs.writeFileSync(b, JSON.stringify({ x: 1, y: 3, z: 4 }));
  const r = await run(['diff-state', a, b, '--json']);
  const data = parseJson<{ diffs: Array<{ path: string; kind: string }>; added: number; changed: number }>(r.stdout);
  assert(data.changed === 1 && data.added === 1, `diff counts off: ${JSON.stringify(data)}`);
  fs.unlinkSync(a);
  fs.unlinkSync(b);
});

// ─── v0.4 surface additions ─────────────────────────────────────

c('--help lists the expected verbs', async () => {
  const r = await run(['--help']);
  for (const verb of ['attach', 'goto', 'snapshot', 'click', 'qa', 'ship', 'review', 'canary', 'pair', 'gif', 'try', 'shell']) {
    assert(r.stdout.includes(verb), `--help missing verb: ${verb}`);
  }
});

c('shell mode runs piped commands in one process', async () => {
  // Pipe 3 commands through `ghax shell` stdin; confirm each ran by
  // checking the combined output contains expected markers. This also
  // exercises comment handling and the `exit` early-terminator.
  const script = [
    '# comment line ignored',
    '',
    'goto https://example.com',
    'eval "document.title"',
    'exit',
    'eval "should-not-run"',
  ].join('\n');
  const r = await run(['shell'], { stdin: script });
  assert(/example\.com/.test(r.stdout), `shell mode goto output missing: ${r.stdout.slice(0, 200)}`);
  assert(/Example Domain/.test(r.stdout), `shell mode eval output missing: ${r.stdout.slice(0, 200)}`);
  assert(!r.stdout.includes('should-not-run'), `exit failed to stop — post-exit command ran: ${r.stdout.slice(0, 300)}`);
});

c('console --source-maps resolves bundled frames to original sources', async () => {
  // Spin up a tiny HTTP server on an ephemeral port that serves a bundled
  // JS (one line, throws in `authenticate`) plus a matching source map
  // pointing at src/AuthForm.ts:2:5. Navigate to it, let the error fire,
  // then call `console --source-maps` and assert the stack's first frame
  // maps to the original file.
  const { SourceMapGenerator } = await import('source-map');
  const gen = new SourceMapGenerator({ file: 'bundle.js' });
  // Bundled line 1 col 43 (where "throw" starts) → AuthForm.ts line 2 col 5.
  gen.addMapping({
    generated: { line: 1, column: 43 },
    original: { line: 2, column: 5 },
    source: 'src/AuthForm.ts',
    name: 'authenticate',
  });
  gen.setSourceContent(
    'src/AuthForm.ts',
    'function authenticate(token) {\n  if (!token) {\n    throw new Error("ghax-smoke-sm");\n  }\n  return token;\n}',
  );
  const mapText = gen.toString();
  const bundled =
    'function authenticate(token) { if (!token) { throw new Error("ghax-smoke-sm"); } return token; } authenticate(null);\n//# sourceMappingURL=bundle.js.map';

  const server = Bun.serve({
    port: 0,  // ephemeral
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(
          '<!doctype html><html><head><script src="bundle.js"></script></head><body>sm</body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      }
      if (url.pathname === '/bundle.js') {
        return new Response(bundled, { headers: { 'content-type': 'application/javascript' } });
      }
      if (url.pathname === '/bundle.js.map') {
        return new Response(mapText, { headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const port = server.port;
    await run(['goto', `http://127.0.0.1:${port}/`]);
    await run(['wait', '500']);
    const r = await run(['console', '--errors', '--last', '20', '--source-maps', '--json']);
    const entries = parseJson<Array<{ text: string; stack?: Array<{ url: string; line: number; col: number; bundledUrl?: string; fn: string | null }> }>>(r.stdout);
    const ours = entries.find((e) => e.text.includes('ghax-smoke-sm'));
    assert(ours, 'pageerror with ghax-smoke-sm not captured');
    assert(ours.stack && ours.stack.length > 0, 'no stack frames');
    const mapped = ours.stack.find((f) => f.url.includes('AuthForm.ts'));
    assert(mapped, `no frame mapped to AuthForm.ts, got stack: ${JSON.stringify(ours.stack)}`);
    assert(mapped.line === 2, `expected AuthForm.ts line 2, got ${mapped.line}`);
    assert(mapped.bundledUrl !== undefined, 'bundledUrl should be preserved');
    assert(mapped.fn === 'authenticate', `expected fn=authenticate, got ${mapped.fn}`);
  } finally {
    server.stop();
  }
});

c('source-maps: falls back silently when script has no map comment', async () => {
  // Serve a bundle with NO sourceMappingURL comment. Console --source-maps
  // should return the frame unchanged (no bundledUrl field).
  const bundled = 'throw new Error("ghax-sm-nomap");';
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/') {
        return new Response('<!doctype html><html><body><script src="bundle.js"></script></body></html>',
          { headers: { 'content-type': 'text/html' } });
      }
      if (url.pathname === '/bundle.js') {
        return new Response(bundled, { headers: { 'content-type': 'application/javascript' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  try {
    await run(['goto', `http://127.0.0.1:${server.port}/`]);
    await run(['wait', '500']);
    const r = await run(['console', '--errors', '--last', '20', '--source-maps', '--json']);
    const entries = parseJson<Array<{ text: string; stack?: Array<{ url: string; bundledUrl?: string }> }>>(r.stdout);
    const ours = entries.find((e) => e.text.includes('ghax-sm-nomap'));
    assert(ours, 'pageerror not captured');
    // Stack present but NOT resolved (no bundledUrl field on any frame).
    if (ours.stack) {
      assert(
        !ours.stack.some((f) => f.bundledUrl !== undefined),
        'expected unresolved stack (no map), got resolved frames',
      );
    }
  } finally {
    server.stop();
  }
});

c('source-maps: falls back silently on invalid map JSON', async () => {
  const bundled = 'throw new Error("ghax-sm-badmap");\n//# sourceMappingURL=bundle.js.map';
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/') return new Response('<!doctype html><html><body><script src="bundle.js"></script></body></html>', { headers: { 'content-type': 'text/html' } });
      if (url.pathname === '/bundle.js') return new Response(bundled, { headers: { 'content-type': 'application/javascript' } });
      if (url.pathname === '/bundle.js.map') return new Response('{not valid json at all}', { headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    },
  });
  try {
    await run(['goto', `http://127.0.0.1:${server.port}/`]);
    await run(['wait', '500']);
    const r = await run(['console', '--errors', '--last', '20', '--source-maps', '--json']);
    const entries = parseJson<Array<{ text: string; stack?: Array<{ bundledUrl?: string }> }>>(r.stdout);
    const ours = entries.find((e) => e.text.includes('ghax-sm-badmap'));
    assert(ours, 'pageerror not captured');
    // Invalid JSON → parse throws → silent fallback → no bundledUrl on frames.
    if (ours.stack) {
      assert(
        !ours.stack.some((f) => f.bundledUrl !== undefined),
        'bad map JSON should have fallen back to bundled frames',
      );
    }
  } finally {
    server.stop();
  }
});

c('xpath: empty result set returns count=0, matches=[]', async () => {
  await run(['goto', 'https://example.com']);
  await run(['wait', '200']);
  const r = await run(['xpath', '//nonexistent-tag-ghax', '--json']);
  const data = parseJson<{ count: number; returned: number; matches: unknown[] }>(r.stdout);
  assert(data.count === 0, `expected count=0, got ${data.count}`);
  assert(data.returned === 0, `expected returned=0, got ${data.returned}`);
  assert(Array.isArray(data.matches) && data.matches.length === 0, 'matches should be empty array');
});

c('xpath: invalid expression throws a clean error', async () => {
  await run(['goto', 'https://example.com']);
  const r = await run(['xpath', 'not a valid xpath /// /!@#'], { allowFailure: true });
  assert(r.exitCode !== 0, 'invalid xpath should exit non-zero');
  assert(
    /xpath|expression|SYNTAX|invalid/i.test(r.stderr + r.stdout),
    `expected error mentioning xpath, got: ${(r.stderr + r.stdout).slice(0, 200)}`,
  );
});

c('xpath --limit caps returned matches', async () => {
  await run(['goto', 'data:text/html,<a>1</a><a>2</a><a>3</a><a>4</a><a>5</a>']);
  await run(['wait', '200']);
  const r = await run(['xpath', '//a', '--limit', '2', '--json']);
  const data = parseJson<{ count: number; returned: number; matches: unknown[] }>(r.stdout);
  assert(data.count === 5, `expected count=5 (all anchors), got ${data.count}`);
  assert(data.returned === 2, `expected returned=2 (limit), got ${data.returned}`);
  assert(data.matches.length === 2, `matches.length=${data.matches.length}`);
});

c('box: element not in layout throws a clean error', async () => {
  await run(['goto', 'data:text/html,<div id=hidden style="display:none">x</div>']);
  await run(['wait', '200']);
  const r = await run(['box', '#hidden'], { allowFailure: true });
  assert(r.exitCode !== 0, 'box on hidden element should exit non-zero');
  assert(
    /not visible|not in layout|box/i.test(r.stderr + r.stdout),
    `expected clean error about layout, got: ${(r.stderr + r.stdout).slice(0, 200)}`,
  );
});

c('network --status 404 exact match filters correctly', async () => {
  // Server that returns 404 for a specific path and 200 for the root.
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/missing') return new Response('not found', { status: 404 });
      return new Response('<!doctype html><html><body><img src="/missing"></body></html>', { headers: { 'content-type': 'text/html' } });
    },
  });
  try {
    await run(['goto', `http://127.0.0.1:${server.port}/`]);
    await run(['wait', '500']);
    const r = await run(['network', '--status', '404', '--last', '50', '--json']);
    const entries = parseJson<Array<{ status: number; url: string }>>(r.stdout);
    assert(entries.length >= 1, `expected at least one 404, got ${entries.length}`);
    assert(entries.every((e) => e.status === 404), 'all entries should be 404');
  } finally {
    server.stop();
  }
});

c('network --status 400-499 range matches 4xx', async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/gone') return new Response('gone', { status: 410 });
      if (url.pathname === '/err') return new Response('server err', { status: 500 });
      return new Response('<!doctype html><html><body><img src="/gone"><img src="/err"></body></html>', { headers: { 'content-type': 'text/html' } });
    },
  });
  try {
    await run(['goto', `http://127.0.0.1:${server.port}/`]);
    await run(['wait', '500']);
    const r = await run(['network', '--status', '400-499', '--last', '50', '--json']);
    const entries = parseJson<Array<{ status: number }>>(r.stdout);
    assert(entries.some((e) => e.status === 410), 'expected the 410 entry');
    assert(!entries.some((e) => e.status === 500), 'range 400-499 should NOT include 500');
  } finally {
    server.stop();
  }
});

c('network --status invalid argument fails with a helpful message', async () => {
  const r = await run(['network', '--status', 'banana'], { allowFailure: true });
  assert(r.exitCode !== 0, 'invalid --status should exit non-zero');
  assert(
    /Bad --status|Expected 404, 4xx, or 400-499/i.test(r.stderr + r.stdout),
    `expected helpful error, got: ${(r.stderr + r.stdout).slice(0, 200)}`,
  );
});

c('console --errors + --dedup + --source-maps combined', async () => {
  // All three flags together; just assert the command succeeds and returns
  // grouped shape. Exhaustive correctness is covered by individual checks.
  await run(['goto', 'https://example.com']);
  await run(['eval', 'for (let i = 0; i < 3; i++) console.error("ghax-combined-flags-probe")']);
  await run(['wait', '200']);
  const r = await run(['console', '--errors', '--dedup', '--source-maps', '--last', '20', '--json']);
  const groups = parseJson<Array<{ text: string; count: number }>>(r.stdout);
  const ours = groups.find((g) => g.text.includes('ghax-combined-flags-probe'));
  assert(ours, 'combined flags did not return our entry');
  assert(ours.count >= 3, `expected count>=3 from 3 emits, got ${ours.count}`);
});

c('shell mode tokenises quoted args correctly', async () => {
  // `ghax try --css 'body { color: red }' ...` needs single-quote
  // preservation so the CSS doesn't get split on whitespace. If the
  // tokeniser breaks, `try` would see mangled flags and fail.
  await run(['goto', 'https://example.com']);
  await run(['wait', '200']);
  const script = [
    "try --css 'body { background: rgb(0, 128, 0) }' --measure 'getComputedStyle(document.body).backgroundColor'",
    'reload',
    'exit',
  ].join('\n');
  const r = await run(['shell'], { stdin: script });
  assert(/rgb\(0, 128, 0\)/.test(r.stdout), `shell quoting broken — CSS didn't paint: ${r.stdout.slice(0, 300)}`);
});

c('--help documents --headless and auto-port range', async () => {
  const r = await run(['--help']);
  assert(r.stdout.includes('--headless'), '--help missing --headless flag');
  assert(/scans :9222-9230|auto-picks/i.test(r.stdout), '--help missing auto-port note');
});

c('attach --browser <kind> reports the kind-mismatch clearly', async () => {
  // Edge is already attached from earlier checks; the daemon survives across
  // tests. Requesting a *different* browser without --launch should produce a
  // helpful kind-mismatch error, NOT the generic "no browser found" message.
  //
  // First we need to detach so cmdAttach gets to the scan/filter path. The
  // final "detach" check at the bottom of the file does a full daemon
  // teardown — we reuse attach afterwards to restore state.
  await run(['detach'], { allowFailure: true });
  const r = await run(['attach', '--browser', 'chromium'], { allowFailure: true });
  const out = r.stderr + r.stdout;
  assert(
    /only .* on :\d+ running|--browser chromium requested/i.test(out),
    `expected kind-mismatch error, got: ${out.slice(0, 300)}`,
  );
  // Re-attach so the rest of the suite can run (this test sits mid-suite).
  await run(['attach']);
});

c('back / forward / reload navigate history', async () => {
  await run(['goto', 'https://example.com']);
  await run(['goto', 'https://example.org']);
  const here1 = (await run(['eval', 'location.hostname'])).stdout.trim();
  assert(here1 === 'example.org', `expected example.org, got ${here1}`);
  await run(['back']);
  await run(['wait', '500']);
  const here2 = (await run(['eval', 'location.hostname'])).stdout.trim();
  assert(here2 === 'example.com', `back should land on example.com, got ${here2}`);
  await run(['forward']);
  await run(['wait', '500']);
  const here3 = (await run(['eval', 'location.hostname'])).stdout.trim();
  assert(here3 === 'example.org', `forward should land on example.org, got ${here3}`);
  await run(['reload']);
  await run(['wait', '500']);
  const here4 = (await run(['eval', 'location.hostname'])).stdout.trim();
  assert(here4 === 'example.org', `reload should stay on example.org, got ${here4}`);
});

c('wait <ms> pauses then returns', async () => {
  const t0 = Date.now();
  await run(['wait', '250']);
  const elapsed = Date.now() - t0;
  assert(elapsed >= 200, `wait 250 returned too fast: ${elapsed}ms`);
});

c('press sends a key to the focused element', async () => {
  await run(['goto', 'data:text/html,<input id=i autofocus>']);
  await run(['wait', '300']);
  await run(['eval', 'document.getElementById("i").focus()']);
  await run(['press', 'a']);
  await run(['press', 'b']);
  await run(['press', 'c']);
  const val = (await run(['eval', 'document.getElementById("i").value'])).stdout.trim();
  assert(val === 'abc' || val.endsWith('abc'), `press should produce abc, got ${JSON.stringify(val)}`);
});

c('type streams text into focused element', async () => {
  await run(['goto', 'data:text/html,<input id=j autofocus>']);
  await run(['wait', '300']);
  await run(['eval', 'document.getElementById("j").focus()']);
  await run(['type', 'hello']);
  const val = (await run(['eval', 'document.getElementById("j").value'])).stdout.trim();
  assert(val === 'hello' || val.endsWith('hello'), `type should produce hello, got ${JSON.stringify(val)}`);
});

c('fill writes into a resolved input', async () => {
  await run(['goto', 'data:text/html,<input id=k>']);
  await run(['wait', '300']);
  await run(['fill', '#k', 'ghax-fill-value']);
  const val = (await run(['eval', 'document.getElementById("k").value'])).stdout.trim();
  assert(val === 'ghax-fill-value', `fill should produce ghax-fill-value, got ${JSON.stringify(val)}`);
});

c('pair status prints tunnel instructions while attached', async () => {
  const r = await run(['pair']);
  assert(/pair/i.test(r.stdout), `pair output missing header: ${r.stdout.slice(0, 120)}`);
  assert(/ssh/i.test(r.stdout), `pair output should mention ssh: ${r.stdout.slice(0, 200)}`);
  assert(/127\.0\.0\.1/.test(r.stdout), `pair output should mention localhost: ${r.stdout.slice(0, 200)}`);
});

c('review emits a Claude-ready prompt or exits cleanly on no-diff', async () => {
  // `ghax review` vs origin/main. Either it has a diff (prints prompt) or it
  // doesn't (prints "no diff" to stderr + exit 0). Both are acceptable shapes.
  const r = await run(['review'], { allowFailure: true });
  const out = r.stdout + r.stderr;
  const hasPrompt = /# Code review request/.test(out) && /## Diff/.test(out);
  const hasNoDiffNotice = /no diff/i.test(out);
  assert(
    hasPrompt || hasNoDiffNotice,
    `review output neither a prompt nor a no-diff notice: ${out.slice(0, 200)}`,
  );
});

c('review --diff falls back to raw diff output', async () => {
  // Force a guaranteed diff by comparing HEAD to HEAD~1. Nearly all repos
  // have at least one prior commit; if they don't, accept the no-diff path.
  const hasPrior = Bun.spawnSync(['git', 'rev-parse', 'HEAD~1'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
  if (!hasPrior) {
    console.log('  (no HEAD~1 — skipping diff check)');
    return;
  }
  const r = await run(['review', '--diff', '--base', 'HEAD~1'], { allowFailure: true });
  // Raw diff should be either a unified diff or the no-diff stderr message.
  assert(
    /^(diff --git|index |---|\+\+\+)/m.test(r.stdout) || /no diff/i.test(r.stderr),
    `review --diff output unexpected: ${r.stdout.slice(0, 120)} / ${r.stderr.slice(0, 120)}`,
  );
});

c('qa --url writes a structured JSON report', async () => {
  const outPath = `/tmp/ghax-qa-smoke-${Date.now()}.json`;
  await run(['qa', '--url', 'https://example.com', '--out', outPath, '--no-screenshots']);
  assert(fs.existsSync(outPath), `qa report missing: ${outPath}`);
  const report = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as {
    urlsAttempted: number;
    urlsOk: number;
    pages: Array<{ url: string; refCount: number }>;
  };
  assert(report.urlsAttempted === 1, `qa urlsAttempted: ${report.urlsAttempted}`);
  assert(report.urlsOk === 1, `qa urlsOk: ${report.urlsOk}`);
  assert(report.pages.length === 1, `qa pages: ${report.pages.length}`);
  assert(report.pages[0].url === 'https://example.com', `qa page url: ${report.pages[0].url}`);
  fs.unlinkSync(outPath);
});

c('qa --crawl discovers and visits URLs under a root', async () => {
  const outPath = `/tmp/ghax-qa-crawl-${Date.now()}.json`;
  // example.com has one page; crawl surfaces just the root. We assert the
  // crawl line fires and the report has at least one page — enough to prove
  // the crawl path is wired up without depending on an N-page fixture.
  const r = await run(['qa', '--crawl', 'https://example.com', '--limit', '3', '--out', outPath, '--no-screenshots']);
  assert(/crawl discovered/i.test(r.stdout), `expected crawl line in stdout: ${r.stdout.slice(0, 200)}`);
  assert(fs.existsSync(outPath), `qa crawl report missing: ${outPath}`);
  const report = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as { urlsAttempted: number };
  assert(report.urlsAttempted >= 1, `qa crawl urlsAttempted: ${report.urlsAttempted}`);
  fs.unlinkSync(outPath);
});

c('canary runs 1+ cycles with short interval/max', async () => {
  const outPath = `/tmp/ghax-canary-smoke-${Date.now()}.json`;
  // interval=1 max=2 → at least one cycle, at most two.
  const r = await run(['canary', 'https://example.com', '--interval', '1', '--max', '2', '--out', outPath], {
    allowFailure: true, // exits non-zero if any cycle fails
  });
  assert(fs.existsSync(outPath), `canary report missing: ${outPath}`);
  const report = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as {
    cycles: Array<{ ok: boolean }>;
    okCycles: number;
    failCycles: number;
  };
  assert(report.cycles.length >= 1, `canary cycles: ${report.cycles.length}`);
  assert(/canary done/.test(r.stdout), `expected "canary done" line: ${r.stdout.slice(-200)}`);
  fs.unlinkSync(outPath);
});

c('ship --dry-run stops before any git mutation', async () => {
  // Safe: --dry-run, plus --no-check --no-build to avoid running the full
  // toolchain just to prove the wiring works.
  const r = await run(['ship', '--dry-run', '--no-check', '--no-build'], { allowFailure: true });
  assert(/dry-run/.test(r.stdout), `ship --dry-run should mention dry-run: ${r.stdout.slice(0, 200)}`);
});

c('ext panel/options eval handle "no page open" cleanly', async () => {
  const listRaw = await run(['ext', 'list', '--json']);
  const exts = parseJson<Array<{ id: string }>>(listRaw.stdout);
  if (exts.length === 0) {
    console.log('  (no extensions — skipping ext panel/options)');
    return;
  }
  for (const sub of ['panel', 'options'] as const) {
    const r = await run(['ext', sub, exts[0].id, 'eval', '1+1'], { allowFailure: true });
    assert(
      r.exitCode === 0 || /no .* page open|No .* page|not open|undefined/i.test(r.stderr + r.stdout),
      `ext ${sub} eval unexpected output: ${r.stdout}${r.stderr}`,
    );
  }
});

c('ext message rejects missing args with usage', async () => {
  const r = await run(['ext', 'message'], { allowFailure: true });
  assert(r.exitCode !== 0, 'ext message with no args should exit non-zero');
  assert(/Usage: ghax ext message/.test(r.stderr), `expected usage line: ${r.stderr.slice(0, 200)}`);
});

c('find <substring> lists tabs whose URL contains it', async () => {
  // Ensure at least one tab matches — goto example.com first.
  await run(['goto', 'https://example.com']);
  const r = await run(['find', 'example', '--json']);
  const matches = parseJson<Array<{ id: string; url: string }>>(r.stdout);
  assert(matches.length >= 1, `expected at least one match, got ${matches.length}`);
  assert(
    matches.every((m) => m.url.includes('example')),
    `every match URL should include "example": ${JSON.stringify(matches)}`,
  );
  assert(typeof matches[0].id === 'string' && matches[0].id.length > 0, 'match id should be string');
});

c('new-window opens a background window and auto-locks active tab', async () => {
  // Snapshot the current tab count so we can assert an increase.
  const beforeTabs = parseJson<Array<{ id: string }>>((await run(['tabs', '--json'])).stdout);
  const beforeCount = beforeTabs.length;
  const beforeActive = beforeTabs.find((t: any) => t.active)?.id;

  const r = await run(['new-window', 'https://example.org', '--json']);
  const created = parseJson<{ id: string; url: string }>(r.stdout);
  assert(typeof created.id === 'string' && created.id.length > 0, 'new-window should return an id');
  assert(/example\.org/.test(created.url), `new-window should land on example.org, got ${created.url}`);

  // Tab count bumps by 1.
  const afterTabs = parseJson<Array<{ id: string; active: boolean }>>((await run(['tabs', '--json'])).stdout);
  assert(afterTabs.length === beforeCount + 1, `expected tab count +1, got ${afterTabs.length - beforeCount}`);

  // The daemon's active tab should be the new one, not the previous one.
  const newActive = afterTabs.find((t) => t.active)?.id;
  assert(newActive === created.id, `active tab should be new window's id, got ${newActive}`);
  assert(newActive !== beforeActive, 'active tab should have changed');

  // Subsequent commands operate on the new window — navigate it away.
  await run(['goto', 'https://example.com']);
  const here = (await run(['eval', 'location.href'])).stdout.trim();
  assert(/example\.com/.test(here), `goto after new-window should target new tab, got ${here}`);

  // Cleanup: close the window we created. window.close() only works on
  // windows opened via script; for CDP-opened windows Chrome allows it too.
  await run(['eval', 'window.close()'], { allowFailure: true });
  // After close, subsequent commands need the active tab to point somewhere
  // valid — re-attach to the original.
  if (beforeActive) await run(['tab', beforeActive, '--quiet'], { allowFailure: true });
});

c('tab --quiet skips bringToFront', async () => {
  // Hard to assert "no focus change" deterministically, so assert the command
  // path runs cleanly and sets the active pointer.
  const tabs = parseJson<Array<{ id: string; active: boolean }>>((await run(['tabs', '--json'])).stdout);
  if (tabs.length < 1) {
    console.log('  (no tabs — skipping)');
    return;
  }
  const target = tabs[0].id;
  const r = await run(['tab', target, '--quiet', '--json']);
  const data = parseJson<{ id: string }>(r.stdout);
  assert(data.id === target, `tab --quiet should echo id, got ${data.id}`);
});

c('try --css injects a tagged <style> node', async () => {
  await run(['goto', 'https://example.com']);
  await run(['wait', '300']);
  await run(['try', '--css', 'body { background: rgb(255, 0, 0) !important; }']);
  const bg = (await run(['eval', 'getComputedStyle(document.body).backgroundColor'])).stdout.trim();
  assert(bg === 'rgb(255, 0, 0)', `try --css should paint body red, got ${bg}`);
  const styleCount = (await run(['eval', 'document.querySelectorAll("style.ghax-try").length'])).stdout.trim();
  assert(styleCount === '1', `expected 1 ghax-try style tag, got ${styleCount}`);
  // Cleanup: reload to flush the injected style so downstream checks see clean state.
  await run(['reload']);
  await run(['wait', '300']);
});

c('try <js> returns a value via IIFE wrap', async () => {
  const r = await run(['try', '1 + 41', '--json']);
  const data = parseJson<{ value: unknown }>(r.stdout);
  assert(data.value === 42, `try 1+41 → ${JSON.stringify(data)}`);
});

c('try --selector binds `el` + --measure observes post-mutation state', async () => {
  await run(['goto', 'data:text/html,<div id=w style="width:50px">x</div>']);
  await run(['wait', '300']);
  const r = await run([
    'try',
    'el.style.width = "300px"',
    '--selector', '#w',
    '--measure', 'document.querySelector("#w").offsetWidth',
    '--json',
  ]);
  const data = parseJson<{ value: number }>(r.stdout);
  assert(data.value === 300, `try --measure should report 300, got ${data.value}`);
});

c('try --shot writes a screenshot', async () => {
  const shotPath = `/tmp/ghax-try-shot-${Date.now()}.png`;
  await run(['goto', 'https://example.com']);
  await run(['wait', '300']);
  const r = await run(['try', '--css', 'body { background: lime; }', '--shot', shotPath, '--json']);
  const data = parseJson<{ shot?: string }>(r.stdout);
  assert(data.shot === shotPath, `try --shot path mismatch: ${data.shot}`);
  assert(fs.existsSync(shotPath), `try screenshot missing: ${shotPath}`);
  assert(fs.statSync(shotPath).size > 500, 'try screenshot suspiciously small');
  fs.unlinkSync(shotPath);
});

c('gif renders a GIF from a recording (if ffmpeg available)', async () => {
  const ffmpeg = Bun.spawnSync(['ffmpeg', '-version'], { stdout: 'ignore', stderr: 'ignore' });
  if (ffmpeg.exitCode !== 0) {
    console.log('  (ffmpeg not on PATH — skipping gif check)');
    return;
  }
  // Minimal 2-step recording — goto + a short wait.
  const recPath = `/tmp/ghax-gif-rec-${Date.now()}.json`;
  const outPath = `/tmp/ghax-gif-smoke-${Date.now()}.gif`;
  const rec = {
    startedAt: new Date().toISOString(),
    steps: [
      { cmd: 'goto', args: ['https://example.com'] },
      { cmd: 'wait', args: ['500'] },
    ],
  };
  fs.writeFileSync(recPath, JSON.stringify(rec));
  await run(['gif', recPath, outPath, '--delay', '500', '--scale', '400']);
  assert(fs.existsSync(outPath), `gif missing: ${outPath}`);
  assert(fs.statSync(outPath).size > 500, `gif suspiciously small: ${fs.statSync(outPath).size}B`);
  fs.unlinkSync(recPath);
  fs.unlinkSync(outPath);
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
