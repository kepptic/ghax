/**
 * ghax smoke test — drive a real running browser through the v0.1–v0.4
 * command surface and assert each step lands.
 *
 * Requirements:
 *   - A Chromium-family browser on --remote-debugging-port=9222
 *     (or set GHAX_SMOKE_PORT=<port> to pin every attach to that port
 *     instead of auto-scanning 9222-9230)
 *   - `npm run build` has been run so dist/ghax + dist/ghax-daemon.mjs exist
 *
 * Run:
 *   tsx test/smoke.ts
 *
 * Exit code 0 on success, non-zero on the first failed check.
 *
 * Deliberately non-destructive. Doesn't hot-reload anything, doesn't
 * write to chrome.storage of any real extension, doesn't use the
 * --launch path (which would spawn a fresh browser window). `ship` is
 * exercised via --dry-run so no commits/pushes happen.
 *
 * Run against the Rust binary:
 *   npm run build:rust && GHAX_BIN=$PWD/target/release/ghax npm run test:smoke
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import type { AddressInfo } from 'net';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ghax = process.env.GHAX_BIN ?? path.join(root, 'dist', 'ghax');

// Unset: bare `attach` auto-scans 9222-9230 (default behaviour). Set: every
// attach the suite runs is pinned to this port, so it can't grab another
// agent's browser that happens to sit on a lower port.
const smokePort = process.env.GHAX_SMOKE_PORT;
const attachArgs = (...extra: string[]): string[] =>
  smokePort ? ['attach', '--port', smokePort, ...extra] : ['attach', ...extra];

if (!fs.existsSync(ghax)) {
  fail(`${ghax} missing — run 'npm run build:all' first (or set GHAX_BIN to the correct binary path)`);
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(args: string[], opts: { stdin?: string; allowFailure?: boolean } = {}): Promise<RunResult> {
  const proc = spawn(ghax, args, {
    stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (opts.stdin && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  let stdout = '', stderr = '';
  proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
  proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
  const exitCode = await new Promise<number>((resolve) => {
    proc.on('exit', (code) => resolve(code ?? 0));
  });
  const res: RunResult = { stdout, stderr, exitCode };
  if (exitCode !== 0 && !opts.allowFailure) {
    fail(`ghax ${args.join(' ')} exited ${exitCode}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
  }
  return res;
}

// fail() normally exits on the spot. The runner flips this on under
// GHAX_SMOKE_CONTINUE=1 so a failed check throws and the loop can go on.
let throwOnFail = false;
function fail(msg: string): never {
  if (throwOnFail) throw new Error(msg);
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
  } catch {
    fail(`expected JSON, got: ${out.slice(0, 200)}`);
  }
}

/**
 * The `@eN` ref printed for a role (and optional name) in snapshot output.
 * Refs are Playwright-minted and sparse since the aria-ref switch, so the
 * first interactive element is no longer guaranteed to be `@e1`.
 */
function refOf(snapshotText: string, role: string, name?: string): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`@(e\\d+) \\[${esc(role)}\\]${name === undefined ? '' : ` ${esc(JSON.stringify(name))}`}`);
  const m = re.exec(snapshotText);
  if (!m) fail(`no [${role}]${name ? ` "${name}"` : ''} ref in snapshot:\n${snapshotText.slice(0, 400)}`);
  return `@${m[1]}`;
}

async function snapRef(role: string, name?: string, extra: string[] = []): Promise<string> {
  const snap = await run(['snapshot', '-i', ...extra]);
  return refOf(snap.stdout, role, name);
}

// example.com dropped its <h1> and its link (2026-10): the body is now one
// <p> and only document.title says "Example Domain". Checks that need an
// h1 or a clickable link use these hermetic data: pages instead.
const H1_PAGE = `data:text/html,${encodeURIComponent('<!doctype html><title>Example Domain</title><h1>Example Domain</h1><p>fixture</p>')}`;
const LINK_PAGE = `data:text/html,${encodeURIComponent('<!doctype html><title>Link Fixture</title><h1>Example Domain</h1><a href="#next" onclick="document.title=\'clicked\'">next</a>')}`;

const checks: Array<{ name: string; fn: () => Promise<void> }> = [];
const c = (name: string, fn: () => Promise<void>) => checks.push({ name, fn });

// ─── Checks ─────────────────────────────────────────────────────

c('attach resolves daemon bundle from outside the project', async () => {
  // Regression guard: before the XDG resolver tier was added, running
  // `ghax attach` from a cwd outside the project root failed with
  // "Cannot locate ghax-daemon.mjs" even though install-link.sh had
  // populated ~/.local/share/ghax/ghax-daemon.mjs. Verify that the
  // installed location is now picked up regardless of cwd or env hints.
  spawnSync(ghax, ['detach'], { stdio: 'ignore' });
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GHAX_DAEMON_BUNDLE;
  const proc = spawn(ghax, attachArgs(), { cwd: '/tmp', env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
  proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
  const exitCode = await new Promise<number>((resolve) => proc.on('exit', (code) => resolve(code ?? 0)));
  assert(
    exitCode === 0,
    `attach from /tmp without GHAX_DAEMON_BUNDLE exited ${exitCode}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`,
  );
  assert(
    !/Cannot locate ghax-daemon\.mjs/.test(stderr),
    `bundle resolver reported missing daemon despite installer convention:\n${stderr}`,
  );
});

c('attach is idempotent (first call attaches)', async () => {
  const r = await run(attachArgs());
  // POSIX convention: fresh attach is silent on success (since TOK-07).
  // The idempotent re-attach still prints `already attached` because
  // that's informational — you asked to attach, we didn't.
  assert(
    r.stdout.trim() === '' || /attached/.test(r.stdout) || /already attached/.test(r.stdout),
    `unexpected attach output: ${r.stdout}`,
  );
});

c('attach is idempotent (second call reuses)', async () => {
  const r = await run(attachArgs());
  assert(/already attached/.test(r.stdout), `second attach should reuse: ${r.stdout}`);
});

c('daemon persists after a successful-looking attach (BUG 2026-06-06)', async () => {
  // Field regression: `ghax attach` printed "attached — pid X" then the very
  // next command reported "daemon (pid X) is not running". The daemon died
  // right after the health check passed. Lock in that a fresh attach is still
  // healthy a beat later — a genuine detach → attach → wait → status cycle.
  await run(['detach']);
  await run(attachArgs());
  await new Promise((r) => setTimeout(r, 1500));
  const r = await run(['status', '--json']);
  const s = parseJson<Record<string, unknown>>(r.stdout);
  assert(
    typeof s.pid === 'number' && typeof s.port === 'number',
    `daemon not attached 1.5s after a successful attach: ${r.stdout || r.stderr}`,
  );
});

c('daemon survives parent process-group teardown (setsid detach)', async () => {
  // Root cause of the 2026-06-06 bug: the daemon shared the CLI's process
  // group, so a harness (Claude Code Bash tool, CI, job-control shell) that
  // reaps the `ghax attach` command's group on exit swept the daemon up in
  // the SIGTERM/SIGHUP and it ran its clean shutdown() — clearing its own
  // state file. The fix spawns the daemon via setsid() into its own session.
  //
  // Prove it end-to-end: launch attach as its OWN process-group leader
  // (detached:true — the exact shape a harness gives a command it will reap),
  // kill that whole group hard, and assert the daemon is still alive. Without
  // setsid the daemon inherits the launcher's group and this kill takes it
  // down; with setsid it's in its own session and survives.
  const stateFile = `/tmp/ghax-smoke-setsid-${process.pid}.json`;
  const env: NodeJS.ProcessEnv = { ...process.env, GHAX_STATE_FILE: stateFile };
  try {
    const proc = spawn(ghax, ['attach', '--port', smokePort ?? '9222'], {
      env,
      detached: true, // child becomes a new session/group leader: pgid === pid
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const launcherPgid = proc.pid!;
    await new Promise<number>((resolve) => proc.on('exit', (code) => resolve(code ?? 0)));
    const st = parseJson<{ pid: number }>(fs.readFileSync(stateFile, 'utf-8'));
    assert(typeof st.pid === 'number', 'attach did not record a daemon pid');
    // Tear the launcher's process group down, hard.
    try { process.kill(-launcherPgid, 'SIGTERM'); } catch { /* group may be empty */ }
    try { process.kill(-launcherPgid, 'SIGKILL'); } catch { /* group may be empty */ }
    await new Promise((r) => setTimeout(r, 800));
    let alive = true;
    try { process.kill(st.pid, 0); } catch { alive = false; }
    assert(
      alive,
      `daemon (pid ${st.pid}) died with the launcher's process group — setsid detach missing`,
    );
    const status = spawnSync(ghax, ['status', '--json'], { env, encoding: 'utf-8' });
    assert(
      status.status === 0,
      `isolated daemon not answering after group kill: ${status.stdout}${status.stderr}`,
    );
  } finally {
    spawnSync(ghax, ['detach'], { env, stdio: 'ignore' });
    try { fs.unlinkSync(stateFile); } catch { /* best effort */ }
  }
});

c('status --json has expected shape', async () => {
  const r = await run(['status', '--json']);
  const s = parseJson<Record<string, unknown>>(r.stdout);
  for (const key of [
    'pid',
    'port',
    'browserKind',
    'tabCount',
    'targetCount',
    'extensionCount',
    'activeTabId',
    'activeTabTitle',
    'activeTabUrl',
    'daemonLog',
  ]) {
    assert(key in s, `status missing ${key}`);
  }
  // daemonLog must point at a real, discoverable file so field failures can
  // be self-diagnosed from `shutdown: <reason>` lines.
  assert(
    typeof s.daemonLog === 'string' && (s.daemonLog as string).endsWith('ghax-daemon.log'),
    `status daemonLog not a daemon log path: ${JSON.stringify(s.daemonLog)}`,
  );
});

// Banner shape: `ghax X.Y.Z (<7+ hex sha> <YYYY-MM-DD>)`. Either field may
// legitimately be "unknown" (a source tarball built with no .git), so the
// regex accepts that as an alternative in each slot.
const BANNER_RE = /^ghax \d+\.\d+\.\d+ \((?:[0-9a-f]{7,}|unknown) (?:\d{4}-\d{2}-\d{2}|unknown)\)$/;

c('version prints the CLI version banner (version + git sha + build date)', async () => {
  const r = await run(['version']);
  assert(BANNER_RE.test(r.stdout.trim()), `unexpected version output: ${r.stdout}`);
});

c('--version flag prints the identical banner as the version subcommand', async () => {
  const [viaFlag, viaSubcommand] = await Promise.all([run(['--version']), run(['version'])]);
  assert(BANNER_RE.test(viaFlag.stdout.trim()), `unexpected --version output: ${viaFlag.stdout}`);
  assert(
    viaFlag.stdout.trim() === viaSubcommand.stdout.trim(),
    `--version (${JSON.stringify(viaFlag.stdout.trim())}) diverged from version (${JSON.stringify(viaSubcommand.stdout.trim())})`,
  );
});

c('version --full --json reports resolved + running bundle and mismatch flag', async () => {
  const r = await run(['version', '--full', '--json']);
  const v = parseJson<{
    cli: { version: string; gitSha: string; buildDate: string };
    resolvedBundle: { path: string | null; tier: string; sha256: string };
    daemon: { bundleSha256?: string; bundlePath?: string; version?: string; gitSha?: string; buildDate?: string } | null;
    bundleMismatch: boolean;
    daemonVersionMismatch: boolean;
    extensionVersionMismatch: boolean;
  }>(r.stdout);
  assert(typeof v.cli?.version === 'string', 'version --full missing cli.version');
  assert(typeof v.cli?.buildDate === 'string', 'version --full missing cli.buildDate');
  assert(typeof v.resolvedBundle?.tier === 'string', 'version --full missing resolvedBundle.tier');
  // A daemon is attached in this suite, so it must report its running bundle.
  assert(v.daemon !== null, 'version --full saw no running daemon while attached');
  assert(
    typeof v.daemon?.bundleSha256 === 'string' && v.daemon.bundleSha256.length === 64,
    `daemon bundleSha256 not a sha256: ${JSON.stringify(v.daemon?.bundleSha256)}`,
  );
  assert(typeof v.bundleMismatch === 'boolean', 'version --full missing bundleMismatch');
  // Daemon and CLI are built from the same working tree in this suite (the
  // smoke run rebuilds the bundle before attaching), so they must report
  // the identical version/provenance — the whole point of the daemon
  // carrying provenance at all is to catch the case where they DON'T.
  assert(v.daemon?.version === v.cli.version, `daemon.version (${v.daemon?.version}) !== cli.version (${v.cli.version})`);
  assert(
    typeof v.daemon?.gitSha === 'string' && v.daemon.gitSha.length > 0,
    `daemon.gitSha missing/empty: ${JSON.stringify(v.daemon?.gitSha)}`,
  );
  assert(
    typeof v.daemon?.buildDate === 'string' && v.daemon.buildDate.length > 0,
    `daemon.buildDate missing/empty: ${JSON.stringify(v.daemon?.buildDate)}`,
  );
  assert(typeof v.daemonVersionMismatch === 'boolean', 'version --full missing daemonVersionMismatch');
  assert(v.daemonVersionMismatch === false, 'daemonVersionMismatch should be false when daemon and CLI share a build');
  assert(typeof v.extensionVersionMismatch === 'boolean', 'version --full missing extensionVersionMismatch');

  // scripts/build-daemon.mjs writes extension/build-info.json in the SAME
  // build step as dist/ghax-daemon.mjs — the bridge extension's only way to
  // report provenance (a service worker can't shell out to git). They must
  // agree, or the extension would report stale provenance for a fresh build.
  const buildInfoPath = path.join(root, 'extension', 'build-info.json');
  assert(fs.existsSync(buildInfoPath), `${buildInfoPath} missing — did 'npm run build' run before this suite?`);
  const extBuildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  assert(
    extBuildInfo.gitSha === v.daemon?.gitSha,
    `extension/build-info.json gitSha (${extBuildInfo.gitSha}) !== daemon-reported gitSha (${v.daemon?.gitSha})`,
  );
});

c('tabs returns a non-empty list', async () => {
  const r = await run(['tabs', '--json']);
  const tabs = parseJson<Array<{ id: string; url: string }>>(r.stdout);
  assert(Array.isArray(tabs) && tabs.length > 0, 'expected at least one tab');
});

c('tabs rows carry index, browser and profile (CDP)', async () => {
  const r = await run(['tabs', '--json']);
  const tabs = parseJson<Array<{ index: number; id: string; chromeTabId: unknown; browser: string; profile: string; windowId: unknown }>>(r.stdout);
  tabs.forEach((t, i) => {
    assert(t.index === i + 1, `row ${i} should have index ${i + 1}, got ${t.index}`);
    assert(typeof t.browser === 'string' && t.browser.length > 0, `browser missing: ${JSON.stringify(t)}`);
    // CDP has no profile name and no chrome tab id; the id is the target id.
    // windowId comes from Browser.getWindowForTarget.
    assert(t.profile === '—', `CDP profile should be '—', got ${t.profile}`);
    assert(t.chromeTabId === null && typeof t.windowId === 'number', `CDP rows: ${JSON.stringify(t)}`);
  });
  const text = (await run(['tabs'])).stdout.split('\n')[0];
  assert(/^#1  \S+  ".*"  \S+ · —/.test(text), `tabs text line should be '#1  <id>  "<title>"  <Browser> · —', got: ${text}`);
});

c('tab #1 switches to row 1 of the last tabs listing; a bad #n refuses', async () => {
  const tabs = parseJson<Array<{ id: string; active: boolean }>>((await run(['tabs', '--json'])).stdout);
  const before = tabs.find((t) => t.active)?.id;
  try {
    const r = await run(['tab', '#1', '--quiet', '--json']);
    const t = parseJson<{ id: string; index: number }>(r.stdout);
    assert(t.id === tabs[0].id && t.index === 1, `tab #1 should be ${tabs[0].id}, got ${JSON.stringify(t)}`);
    const bad = await run(['tab', `#${tabs.length + 50}`], { allowFailure: true });
    assert(bad.exitCode !== 0 && /no #\d+/.test(bad.stderr + bad.stdout), `out-of-range #n should refuse: ${bad.stderr || bad.stdout}`);
    const bare = await run(['tab', '987654'], { allowFailure: true });
    assert(bare.exitCode !== 0 && /No tab with id 987654/.test(bare.stderr + bare.stdout), `unknown id should refuse: ${bare.stderr || bare.stdout}`);
  } finally {
    if (before) await run(['tab', before, '--quiet'], { allowFailure: true });
  }
});

c('wait --stable reports a settled page as stable', async () => {
  await run(['goto', 'https://example.com']);
  const r = await run(['wait', '--stable', '--json']);
  const s = parseJson<{ stable: boolean; reason: string; nodes: number }>(r.stdout);
  assert(s.stable === true, `settled page should be stable, got ${JSON.stringify(s)}`);
  assert(s.reason === 'quiet', `reason should be 'quiet', got ${s.reason}`);
  assert(s.nodes > 0, 'should report a node count');
});

c('wait --stable reports an endlessly-mutating page as NOT stable (no hang)', async () => {
  // The whole point of the deadline: a ticker/live-chat page must get a
  // truthful "not stable, proceed anyway", never an infinite wait.
  await run(['eval', 'window.__ghaxChurn = setInterval(() => document.body.appendChild(document.createElement("div")), 30); 1']);
  try {
    const started = Date.now();
    const r = await run(['wait', '--stable', '--timeout', '1200', '--json']);
    const elapsed = Date.now() - started;
    const s = parseJson<{ stable: boolean; reason: string }>(r.stdout);
    assert(s.stable === false, `churning page should not be stable: ${JSON.stringify(s)}`);
    assert(s.reason === 'timeout', `reason should be 'timeout', got ${s.reason}`);
    assert(elapsed < 12_000, `should honour the deadline, took ${elapsed}ms`);
  } finally {
    await run(['eval', 'clearInterval(window.__ghaxChurn); 1']);
  }
});

c('wait --stable honours --min-nodes', async () => {
  const r = await run(['wait', '--stable', '--timeout', '1200', '--min-nodes', '999999', '--json']);
  const s = parseJson<{ stable: boolean; reason: string }>(r.stdout);
  assert(s.stable === false, 'an unreachable --min-nodes must not report stable');
});

c('wait --stable treats aria-busy as not-ready', async () => {
  await run(['eval', 'document.body.setAttribute("aria-busy", "true"); 1']);
  try {
    const r = await run(['wait', '--stable', '--timeout', '1000', '--json']);
    const s = parseJson<{ stable: boolean; busy: number }>(r.stdout);
    assert(s.stable === false, 'aria-busy=true must block stability');
    assert(s.busy >= 1, `should report the busy count, got ${s.busy}`);
  } finally {
    await run(['eval', 'document.body.removeAttribute("aria-busy"); 1']);
  }
});

c('goto --stable navigates and reports stability', async () => {
  const r = await run(['goto', 'https://example.com', '--stable', '--json']);
  const g = parseJson<{ url: string; stable: boolean }>(r.stdout);
  assert(g.url.includes('example.com'), `unexpected url ${g.url}`);
  assert(g.stable === true, 'example.com should settle');
});

c('tabs --filter matches by URL regex', async () => {
  // goto example.com first so we know a matching tab exists in the set.
  await run(['goto', 'https://example.com']);
  const r = await run(['tabs', '--filter', 'example\\.com', '--json']);
  const tabs = parseJson<Array<{ url: string }>>(r.stdout);
  assert(Array.isArray(tabs) && tabs.length > 0, 'expected at least one example.com tab');
  for (const t of tabs) {
    assert(/example\.com/i.test(t.url), `tab leaked past filter: ${t.url}`);
  }
});

c('tabs --fields projects only requested keys', async () => {
  const r = await run(['tabs', '--fields', 'id,url', '--json']);
  const tabs = parseJson<Array<Record<string, unknown>>>(r.stdout);
  assert(Array.isArray(tabs) && tabs.length > 0, 'expected at least one tab');
  for (const t of tabs) {
    const keys = Object.keys(t).sort();
    assert(JSON.stringify(keys) === JSON.stringify(['id', 'url']),
      `unexpected keys on projected tab: ${JSON.stringify(keys)}`);
  }
});

c('tabs --filter with invalid regex fails cleanly', async () => {
  const r = await run(['tabs', '--filter', '[unclosed'], { allowFailure: true });
  assert(r.exitCode !== 0, 'invalid regex should fail');
  assert(/invalid regex/i.test(r.stderr + r.stdout), `expected 'invalid regex' message, got: ${r.stderr || r.stdout}`);
});

c('goto example.com lands on example.com', async () => {
  const r = await run(['goto', 'https://example.com']);
  assert(/example\.com/.test(r.stdout), `goto output: ${r.stdout}`);
});

c('text returns page body', async () => {
  const r = await run(['text']);
  assert(/documentation examples/i.test(r.stdout), `text should contain "documentation examples", got: ${r.stdout.slice(0, 120)}`);
  const title = await run(['eval', 'document.title']);
  assert(title.stdout.trim() === 'Example Domain', `document.title: ${title.stdout}`);
});

c('text --selector scopes to one element', async () => {
  await run(['goto', H1_PAGE]);
  const r = await run(['text', '--selector', 'h1']);
  assert(/^\s*Example Domain\s*$/i.test(r.stdout), `expected only h1 text, got: ${r.stdout}`);
});

c('text --length paginates the output', async () => {
  const r = await run(['text', '--length', '10']);
  // stdout has a trailing newline from println; trim for the length check.
  assert(r.stdout.trim().length <= 10, `expected ≤10 chars, got ${r.stdout.trim().length}: ${r.stdout.trim()}`);
});

c('text --skip skips leading chars', async () => {
  const full = (await run(['text'])).stdout.trim();
  const skipped = (await run(['text', '--skip', '5'])).stdout.trim();
  assert(full.startsWith(full.slice(0, 5)), 'sanity check on full text');
  assert(skipped === full.slice(5), `--skip 5 mismatch: full=${full.slice(0, 20)}… skipped=${skipped.slice(0, 20)}…`);
});

c('html <selector> returns innerHTML', async () => {
  await run(['goto', H1_PAGE]);
  const r = await run(['html', 'h1']);
  assert(/Example Domain/i.test(r.stdout), 'h1 innerHTML should include "Example Domain"');
});

c('snapshot -i produces @e refs', async () => {
  await run(['goto', LINK_PAGE]);
  const r = await run(['snapshot', '-i']);
  assert(/@e\d+/.test(r.stdout), `snapshot didn't produce @e refs: ${r.stdout.slice(0, 200)}`);
});

c('snapshot -i --compact suppresses the cursor-interactive section', async () => {
  // Build a page with a cursor:pointer div so the cursor-scan has something
  // to emit when unsuppressed. Then verify -i alone emits the scan header
  // and -i --compact doesn't.
  const html = `
    <button>real button</button>
    <div style="cursor:pointer;width:100px;height:20px" onclick="void 0">cursor div</div>
  `;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  await run(['wait', '300']);
  const withScan = await run(['snapshot', '-i']);
  assert(
    /cursor-interactive/.test(withScan.stdout),
    `expected cursor-interactive header on -i: ${withScan.stdout.slice(0, 200)}`,
  );
  const compact = await run(['snapshot', '-i', '--compact']);
  assert(
    !/cursor-interactive/.test(compact.stdout),
    `expected no cursor-interactive section on -i --compact: ${compact.stdout.slice(0, 200)}`,
  );
  assert(
    compact.stdout.length < withScan.stdout.length,
    `compact output should be smaller (compact=${compact.stdout.length}, full=${withScan.stdout.length})`,
  );
});

c('snapshot -C overrides --compact to force the cursor pass', async () => {
  const html = `<div style="cursor:pointer" onclick="void 0">explicit</div>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  await run(['wait', '300']);
  const r = await run(['snapshot', '-C', '--compact']);
  assert(
    /cursor-interactive/.test(r.stdout),
    `expected cursor-interactive when -C is explicit, got: ${r.stdout.slice(0, 200)}`,
  );
});

c('snapshot -a writes annotated PNG', async () => {
  const outPath = `/tmp/ghax-smoke-anno-${Date.now()}.png`;
  await run(['goto', LINK_PAGE]);
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

c('screenshot --full-page kebab alias writes a PNG', async () => {
  const outPath = `/tmp/ghax-smoke-fp-${Date.now()}.png`;
  await run(['screenshot', '--path', outPath, '--full-page']);
  assert(fs.existsSync(outPath), 'full-page screenshot missing');
  assert(fs.statSync(outPath).size > 500, 'full-page screenshot suspiciously small');
  fs.unlinkSync(outPath);
});

c('eval runs JS in the active tab', async () => {
  const r = await run(['eval', '1 + 2']);
  assert(r.stdout.trim() === '3', `eval 1+2 → ${r.stdout.trim()}`);
});

c('eval --max-bytes truncates oversized strings', async () => {
  const r = await run(['eval', '"x".repeat(1000)', '--max-bytes', '50', '--json']);
  const v = parseJson<{ value: string; truncated: boolean; originalBytes: number }>(r.stdout);
  assert(v.truncated === true, 'expected truncated=true');
  assert(v.originalBytes === 1000, `expected originalBytes=1000, got ${v.originalBytes}`);
  assert(Buffer.byteLength(v.value, 'utf8') <= 50, `truncated value exceeds 50 bytes: ${Buffer.byteLength(v.value, 'utf8')}`);
});

c('eval --max-bytes pass-through when under cap', async () => {
  const r = await run(['eval', '"short"', '--max-bytes', '100', '--json']);
  const v = parseJson<unknown>(r.stdout);
  assert(v === 'short', `expected 'short', got ${JSON.stringify(v)}`);
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
  await run(['goto', LINK_PAGE]);
  const link = await snapRef('link');
  await run(['click', link]);
  // The fixture link's onclick sets document.title (a #hash jump is not
  // reliable on a data: URL).
  const r = await run(['eval', 'document.title']);
  assert(r.stdout.trim() === 'clicked', `click on the link should run its onclick: ${r.stdout}`);
});

c('click reports dialogDismissed when a modal closes', async () => {
  // Fixture: a [role=dialog] open at load with a button that hides itself.
  // Mirrors the HubSpot confirm-modal shape — synchronous dismissal so the
  // 300ms default budget catches it on the first poll.
  const html = `
    <div role="dialog" aria-modal="true" id="d">
      <button id="ok" onclick="document.getElementById('d').style.display='none'">OK</button>
    </div>
  `;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  await run(['wait', '200']);
  const r = await run(['click', await snapRef('button', 'OK'), '--json']);
  const data = parseJson<{ ok: boolean; dialogDismissed: boolean; preDialogCount: number; postDialogCount: number }>(r.stdout);
  assert(data.ok === true, 'click should return ok');
  assert(data.dialogDismissed === true, `expected dialogDismissed=true, got ${JSON.stringify(data)}`);
  assert(data.preDialogCount === 1 && data.postDialogCount === 0, `expected pre=1 post=0, got pre=${data.preDialogCount} post=${data.postDialogCount}`);
});

c('click reports dialogDismissed=false when nothing changes', async () => {
  // Inert button, no dialog on the page → both flags should be false and
  // pre/postDialogCount both 0. Lets agents distinguish "click landed,
  // nothing happened" from "click closed something."
  const html = `<button id="b" onclick="void 0">noop</button>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  await run(['wait', '200']);
  const r = await run(['click', await snapRef('button', 'noop'), '--observe-ms', '100', '--json']);
  const data = parseJson<{ ok: boolean; dialogDismissed: boolean; urlChanged: boolean }>(r.stdout);
  assert(data.ok === true, 'click should return ok');
  assert(data.dialogDismissed === false, `expected dialogDismissed=false, got ${JSON.stringify(data)}`);
  assert(data.urlChanged === false, `expected urlChanged=false, got ${JSON.stringify(data)}`);
});

c('click --no-observe skips post-click observation', async () => {
  // Opt-out path: caller wants raw `{ok:true}` (e.g. in benchmarks where
  // the extra count() round-trip is measurable). Verify no extra fields.
  const html = `<button>x</button>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  await run(['wait', '200']);
  const r = await run(['click', await snapRef('button', 'x'), '--no-observe', '--json']);
  const data = parseJson<Record<string, unknown>>(r.stdout);
  assert(data.ok === true, 'click should return ok');
  assert(!('dialogDismissed' in data) && !('urlChanged' in data), `expected no observation fields, got keys=${Object.keys(data)}`);
});

c('click refuses an inherited aria-disabled target fast, --force clicks it', async () => {
  // Playwright alone would wait out its 30 s action timeout here. The
  // precheck (src/actionability.ts, kind 'precheck') refuses immediately with
  // the same typed code the bridge guard uses.
  const html = `<div aria-disabled="true"><div role="button" id="b" onclick="window.__hit=(window.__hit||0)+1">Go</div></div>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const started = Date.now();
  const r = await run(['click', '#b'], { allowFailure: true });
  assert(r.exitCode === 4, `expected exit 4, got ${r.exitCode}: ${r.stderr}`);
  assert(Date.now() - started < 10_000, 'refusal should be immediate, not a Playwright timeout');
  assert(/not actionable \(disabled\)/.test(r.stderr), `expected a disabled refusal: ${r.stderr}`);
  assert(/hint: it is disabled/.test(r.stderr), `expected the disabled hint: ${r.stderr}`);
  const forced = await run(['click', '#b', '--force', '--json']);
  assert(parseJson<{ ok: boolean }>(forced.stdout).ok === true, `--force click should succeed: ${forced.stdout}`);
  const hit = await run(['eval', 'window.__hit || 0']);
  assert(hit.stdout.trim() === '1', `--force should have clicked once, __hit=${hit.stdout.trim()}`);
});

c('click refuses a target inside an inert subtree', async () => {
  const html = `<main inert><button id="b">Behind modal</button></main>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const r = await run(['click', '#b'], { allowFailure: true });
  assert(r.exitCode === 4, `expected exit 4, got ${r.exitCode}: ${r.stderr}`);
  assert(/not actionable \(inert\)/.test(r.stderr), `expected an inert refusal: ${r.stderr}`);
});

c('fill refuses an aria-disabled textbox unless --force', async () => {
  const html = `<div aria-disabled="true"><input id="t" aria-label="Name"></div>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const r = await run(['fill', '#t', 'x'], { allowFailure: true });
  assert(r.exitCode === 4 && /not actionable \(disabled\)/.test(r.stderr), `fill should refuse: ${r.stderr}`);
  await run(['fill', '#t', 'forced', '--force']);
  const v = await run(['eval', "document.getElementById('t').value"]);
  assert(v.stdout.trim() === 'forced', `--force fill should land, got ${v.stdout.trim()}`);
});

c('snapshot scopes locators to the auto-detected modal', async () => {
  // Two buttons named "Confirm": one in the modal, one outside (hidden by
  // an aria-hidden parent the way most React libs hide the page behind a
  // scrim). The snapshot's modal-scope walker shows only the modal's
  // button — but the OLD code built `getByRole` page-wide, so on a page
  // with a unique-named button it'd accidentally match the outside one.
  // Here both have the same accessible name, so a page-wide locator hits
  // strict-mode (2 matches) and click would error. With modal-scoped
  // locators, click resolves uniquely to the modal button and dismisses
  // the dialog.
  const html = `
    <div aria-hidden="true">
      <button id="outside" onclick="window.__outside=true">Confirm</button>
    </div>
    <div role="dialog" aria-modal="true" id="d">
      <button id="inside" onclick="window.__inside=true; document.getElementById('d').style.display='none'">Confirm</button>
    </div>
  `;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  await run(['wait', '200']);
  const r = await run(['click', await snapRef('button', 'Confirm'), '--json']);
  const data = parseJson<{ ok: boolean; dialogDismissed: boolean }>(r.stdout);
  assert(data.ok === true, `click should not error under strict-mode: ${JSON.stringify(data)}`);
  assert(data.dialogDismissed === true, `expected modal button to dismiss the dialog, got ${JSON.stringify(data)}`);
  // And confirm we hit the inside one, not the outside one.
  const which = await run(['eval', 'JSON.stringify({inside: !!window.__inside, outside: !!window.__outside})']);
  const flags = parseJson<{ inside: boolean; outside: boolean }>(which.stdout);
  assert(flags.inside === true && flags.outside === false, `expected inside-button click, got ${JSON.stringify(flags)}`);
});

c('modal-scoped refs do not resolve outside the modal', async () => {
  // A page-wide snapshot mints a ref for the outside button; a modal-scoped
  // snapshot then replaces both ghax's ref map and Playwright's aria-ref
  // cache, so the old ref must fail cleanly, never land on the page.
  const html = `
    <button id="outside" onclick="window.__outside=true">Outside</button>
    <div role="dialog" aria-modal="true"><button id="inside">Inside</button></div>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const outside = await snapRef('button', 'Outside', ['--no-dialog-scope']);
  const modalSnap = await run(['snapshot', '-i']);
  assert(!modalSnap.stdout.includes('"Outside"'), `modal scope should hide the outside button:\n${modalSnap.stdout}`);
  const r = await run(['click', outside], { allowFailure: true });
  assert(r.exitCode === 4 && /Run 'ghax snapshot' first/.test(r.stderr), `old ref should fail: exit=${r.exitCode} ${r.stderr}`);
  const flag = await run(['eval', 'String(!!window.__outside)']);
  assert(flag.stdout.trim() === 'false', 'the outside button must not have been clicked');
});

c('an -i or --depth snapshot does not renumber elements it did not print', async () => {
  const html = `<h2>Section title</h2><nav aria-label="Outer"><ul><li><a href="#d">Deep link</a></li></ul></nav>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const full = (await run(['snapshot'])).stdout;
  const heading = refOf(full, 'heading', 'Section title');
  const deep = refOf(full, 'link', 'Deep link');
  await run(['snapshot', '-i']);        // heading not printed
  await run(['snapshot', '-d', '0']);   // deep link not printed
  const again = (await run(['snapshot'])).stdout;
  assert(refOf(again, 'heading', 'Section title') === heading, `heading renumbered after -i: ${heading} -> ${refOf(again, 'heading', 'Section title')}`);
  assert(refOf(again, 'link', 'Deep link') === deep, `link renumbered after -d 0: ${deep} -> ${refOf(again, 'link', 'Deep link')}`);
});

c('refs are stable across snapshots: an insertion above does not shift them', async () => {
  // onclick flag, not a hash change: fragment navigation on a data: URL
  // leaves location untouched in Chromium.
  const html = `<div id="top"></div><a href="#x" id="link" onclick="window.__linked=1; return false">Target link</a>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const before = await snapRef('link', 'Target link');
  await run(['eval', `document.getElementById('top').innerHTML = '<button>Inserted</button>'; 'ok'`]);
  const snap = await run(['snapshot', '-i']);
  const after = refOf(snap.stdout, 'link', 'Target link');
  assert(after === before, `link ref moved from ${before} to ${after} after an insertion above it`);
  const inserted = refOf(snap.stdout, 'button', 'Inserted');
  assert(inserted !== before, 'the new button must get a new number');
  await run(['click', after]);
  const linked = await run(['eval', 'String(window.__linked || 0)']);
  assert(linked.stdout.trim() === '1', `stable ref should still click the link, __linked=${linked.stdout.trim()}`);
});

c('a ref whose element was removed fails as stale, exit 4', async () => {
  const html = `<button id="gone">Vanish</button><button>Stay</button>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const ref = await snapRef('button', 'Vanish');
  await run(['eval', `document.getElementById('gone').remove(); 'ok'`]);
  const started = Date.now();
  const r = await run(['click', ref], { allowFailure: true });
  assert(r.exitCode === 4, `expected exit 4, got ${r.exitCode}: ${r.stderr}`);
  assert(/not found in the latest snapshot/.test(r.stderr), `expected the stale-ref message: ${r.stderr}`);
  assert(Date.now() - started < 10_000, 'stale ref must fail fast, not wait out the action timeout');
});

c('snapshot -d limits depth', async () => {
  const html = `<nav aria-label="Outer"><ul><li><a href="#deep">Deep link</a></li></ul></nav>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const full = await run(['snapshot']);
  assert(/"Deep link"/.test(full.stdout), `full snapshot should include the deep link:\n${full.stdout}`);
  const shallow = await run(['snapshot', '-d', '0']);
  assert(/\[navigation\] "Outer"/.test(shallow.stdout), `depth 0 keeps the top level:\n${shallow.stdout}`);
  assert(!/"Deep link"/.test(shallow.stdout), `depth 0 must drop nested nodes:\n${shallow.stdout}`);
});

c('snapshot caps at 250 refs by default and says what it cut', async () => {
  const html = Array.from({ length: 300 }, (_, i) => `<button>btn ${i}</button>`).join('');
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  type Snap = { text: string; count: number; totalRefs: number; omitted?: { refs: number; lines: number } };
  const def = parseJson<Snap>((await run(['snapshot', '-i', '--json'])).stdout);
  assert(def.count === 250 && def.totalRefs === 300, `default: count ${def.count} total ${def.totalRefs}`);
  assert(def.omitted?.refs === 50, `omitted: ${JSON.stringify(def.omitted)}`);
  assert(def.text.endsWith('… 50 more refs omitted (use --depth/--selector/--max-refs, or --no-cap)'), 'marker is the last line');
  const ten = parseJson<Snap>((await run(['snapshot', '-i', '--max-refs', '10', '--json'])).stdout);
  assert(ten.count === 10 && ten.totalRefs === 300, `--max-refs 10: ${ten.count}`);
  const all = parseJson<Snap>((await run(['snapshot', '-i', '--no-cap', '--json'])).stdout);
  assert(all.count === 300 && !all.omitted, `--no-cap: ${all.count}`);
  const zero = parseJson<Snap>((await run(['snapshot', '-i', '--max-refs', '0', '--json'])).stdout);
  assert(zero.count === 300, `--max-refs 0: ${zero.count}`);
  const chars = parseJson<Snap>((await run(['snapshot', '-i', '--max-chars', '2000', '--json'])).stdout);
  assert(chars.text.split('\n').slice(0, -1).join('\n').length <= 2000, 'char cap honoured');
  // The ref map is never cut: a ref printed only by --no-cap still clicks.
  const last = refOf(all.text, 'button', 'btn 299');
  await run(['snapshot', '-i']);
  const click = await run(['click', last, '--json']);
  assert(parseJson<{ ok: boolean }>(click.stdout).ok, 'a ref beyond the printed cap must still resolve');
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

c('batch runs a step sequence in one round-trip', async () => {
  const steps = JSON.stringify([
    { cmd: 'goto', args: ['https://example.com'] },
    { cmd: 'wait', args: ['200'] },
    { cmd: 'text' },
  ]);
  const r = await run(['batch', steps]);
  const results = parseJson<Array<{ cmd: string; ok: boolean; data?: unknown }>>(r.stdout);
  assert(results.length === 3, `expected 3 results, got ${results.length}`);
  assert(results.every((s) => s.ok), `batch had failures: ${JSON.stringify(results)}`);
  const textStep = results[2];
  assert(typeof textStep.data === 'string' && (textStep.data as string).toLowerCase().includes('documentation examples'),
    `expected example.com text, got ${JSON.stringify(textStep.data).slice(0, 100)}`);
});

c('batch skips the auto re-snapshot when the page has not changed', async () => {
  // Freshness guard: a ref step re-snapshots only when the page marker
  // (document id, mutation count, URL) moved since the last snapshot.
  const html = `<button onclick="window.__n=(window.__n||0)+1">Count</button>
    <button onclick="document.body.insertAdjacentHTML('afterbegin','<p>grew</p>')">Grow</button>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const snap = await run(['snapshot', '-i']);
  const count = refOf(snap.stdout, 'button', 'Count');
  const grow = refOf(snap.stdout, 'button', 'Grow');
  type Step = { cmd: string; ok: boolean; autoSnapshot?: string };
  const quiet = parseJson<Step[]>((await run(['batch', JSON.stringify([
    { cmd: 'click', args: [count] },
    { cmd: 'click', args: [count] },
  ])])).stdout);
  assert(quiet.every((st) => st.ok), `batch failed: ${JSON.stringify(quiet)}`);
  assert(quiet[0].autoSnapshot === 'skipped' && quiet[1].autoSnapshot === 'skipped',
    `a click that changes no DOM should not force a re-snapshot: ${JSON.stringify(quiet)}`);
  const busy = parseJson<Step[]>((await run(['batch', JSON.stringify([
    { cmd: 'click', args: [grow] },
    { cmd: 'click', args: [count] },
  ])])).stdout);
  assert(busy[0].autoSnapshot === 'skipped', `first step: ${JSON.stringify(busy)}`);
  assert(busy[1].autoSnapshot === 'taken', `a DOM insertion must trigger a re-snapshot: ${JSON.stringify(busy)}`);
  const n = await run(['eval', 'window.__n || 0']);
  assert(n.stdout.trim() === '3', `Count should have been clicked 3 times, got ${n.stdout.trim()}`);
  // No-op steps carry no autoSnapshot field at all.
  const plain = parseJson<Step[]>((await run(['batch', JSON.stringify([{ cmd: 'wait', args: ['10'] }])])).stdout);
  assert(!('autoSnapshot' in plain[0]), 'steps without refs report nothing');
});

c('batch refuses a ref from a page the tab navigated away from (never clicks page B)', async () => {
  // Review finding 1: [snapshot, navigate, click old-ref] used to resolve the
  // old number against page B. Numbers are daemon-wide and never reused, and
  // a ref minted on another document fails as BRIDGE_REF_STALE.
  const pageA = `data:text/html,${encodeURIComponent('<button onclick="window.__a=1">Go</button><button>Other</button>')}`;
  const pageB = `data:text/html,${encodeURIComponent('<button>Other</button><button onclick="window.__b=1">Go</button>')}`;
  await run(['goto', pageA]);
  const oldRef = await snapRef('button', 'Go');
  const r = await run(['batch', JSON.stringify([
    { cmd: 'snapshot', opts: { interactive: true } },
    { cmd: 'goto', args: [pageB] },
    { cmd: 'click', args: [oldRef] },
  ])], { allowFailure: true });
  assert(r.exitCode === 4, `batch should exit 4, got ${r.exitCode}: ${r.stdout}`);
  const steps = parseJson<Array<{ ok: boolean; code?: string; error?: string }>>(r.stdout);
  assert(steps[2] && steps[2].ok === false && steps[2].code === 'BRIDGE_REF_STALE',
    `click of the old ref must fail as stale: ${JSON.stringify(steps[2])}`);
  const b = await run(['eval', 'String(window.__b || 0)']);
  assert(b.stdout.trim() === '0', 'page B\'s button must not have been clicked');
  const fresh = await snapRef('button', 'Go');
  assert(Number(fresh.slice(2)) > Number(oldRef.slice(2)), `page B must get a new number, got ${fresh} after ${oldRef}`);
});

c('batch re-snapshots after a --selector snapshot instead of skipping (finding 4)', async () => {
  const html = `<form id="f"><button type="button">Inside</button></form>
    <button onclick="window.__out=1">Outside</button>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const outside = await snapRef('button', 'Outside');
  await run(['snapshot', '-i', '-s', '#f']);   // ref map now holds the form only
  const r = await run(['batch', JSON.stringify([{ cmd: 'click', args: [outside] }])]);
  const steps = parseJson<Array<{ ok: boolean; autoSnapshot?: string; error?: string }>>(r.stdout);
  assert(steps[0].ok && steps[0].autoSnapshot === 'taken', `scoped snapshot must not vouch for the page: ${r.stdout}`);
  const v = await run(['eval', 'String(window.__out || 0)']);
  assert(v.stdout.trim() === '1', 'the outside button should have been clicked');
});

c('batch notices changes the old marker missed: shadow roots and name attributes (finding 5)', async () => {
  type Step = { cmd: string; ok: boolean; autoSnapshot?: string };
  // 1. A mutation inside an open shadow root now moves the marker.
  const shadow = `<div id="h"></div><button onclick="window.__k=(window.__k||0)+1">Keep</button>
    <script>document.getElementById('h').attachShadow({ mode: 'open' }).innerHTML = '<span>old</span>';</script>`;
  await run(['goto', `data:text/html,${encodeURIComponent(shadow)}`]);
  const keep = await snapRef('button', 'Keep');
  const s1 = parseJson<Step[]>((await run(['batch', JSON.stringify([
    { cmd: 'eval', args: ["document.getElementById('h').shadowRoot.innerHTML = '<button>new</button>'; 'ok'"] },
    { cmd: 'click', args: [keep] },
  ])])).stdout);
  assert(s1[1].autoSnapshot === 'taken', `a shadow-root mutation must force a re-snapshot: ${JSON.stringify(s1)}`);
  // 1b. No page prototype is patched (fingerprinting would see it), and a
  // shadow root attached AFTER the snapshot is still noticed (rescan on read).
  const native = await run(['eval', "String(Element.prototype.attachShadow.toString().includes('[native code]'))"]);
  assert(native.stdout.trim() === 'true', 'attachShadow must stay native after a snapshot');
  const late = parseJson<Step[]>((await run(['batch', JSON.stringify([
    { cmd: 'eval', args: ["const d = document.createElement('div'); document.body.prepend(d); 'ok'"] },
    { cmd: 'snapshot', opts: { interactive: true } },
    { cmd: 'eval', args: ["document.body.firstElementChild.attachShadow({ mode: 'open' }).innerHTML = '<b>x</b>'; 'ok'"] },
    { cmd: 'click', args: [keep] },
  ])])).stdout);
  assert(late[3].autoSnapshot === 'taken', `a shadow root attached after the snapshot must force a re-snapshot: ${JSON.stringify(late)}`);
  // 2. aria-pressed is now observed.
  const pressed = `<button id="p" aria-pressed="false">Toggle</button>`;
  await run(['goto', `data:text/html,${encodeURIComponent(pressed)}`]);
  const toggle = await snapRef('button', 'Toggle');
  const s2 = parseJson<Step[]>((await run(['batch', JSON.stringify([
    { cmd: 'eval', args: ["document.getElementById('p').setAttribute('aria-pressed', 'true'); 'ok'"] },
    { cmd: 'click', args: [toggle] },
  ])])).stdout);
  assert(s2[1].autoSnapshot === 'taken', `aria-pressed must move the marker: ${JSON.stringify(s2)}`);
  // 3. Belt and braces: an attribute the marker ignores (input type) changes
  // the role; the role+name recheck refuses to trust the old snapshot.
  const typed = `<input id="i" type="button" value="Go">`;
  await run(['goto', `data:text/html,${encodeURIComponent(typed)}`]);
  const go = await snapRef('button', 'Go');
  const s3 = parseJson<Step[]>((await run(['batch', JSON.stringify([
    { cmd: 'eval', args: ["document.getElementById('i').type = 'checkbox'; 'ok'"] },
    { cmd: 'click', args: [go] },
  ])], { allowFailure: true })).stdout);
  assert(s3[1].autoSnapshot === 'taken', `a role change must fail the recheck: ${JSON.stringify(s3)}`);
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

c('console/network output is unfiltered in CDP mode (tab scoping is bridge-only)', async () => {
  // Multi-bind scopes bridge-mode logs to the active tab. CDP mode has one
  // buffer for one browser: default, --all and a stray --tab must all agree.
  const tag = `ghax-smoke-scope-${Date.now().toString(36)}`;
  await run(['eval', `console.log(${JSON.stringify(tag)})`]);
  await run(['wait', '200']);
  const texts = async (extra: string[]) => {
    const r = await run(['console', '--last', '500', '--json', ...extra]);
    return parseJson<Array<{ text: string }>>(r.stdout).map((e) => e.text);
  };
  const plain = await texts([]);
  assert(plain.includes(tag), 'default console output should include the marker');
  assert(JSON.stringify(await texts(['--all'])) === JSON.stringify(plain), '--all must not change CDP console output');
  assert(JSON.stringify(await texts(['--tab', '#1'])) === JSON.stringify(plain), '--tab must not filter CDP console output');
  const net = async (extra: string[]) => parseJson<unknown[]>((await run(['network', '--last', '500', '--json', ...extra])).stdout).length;
  assert((await net(['--all'])) === (await net([])), '--all must not change CDP network output');
});

c('cookies --json returns an array', async () => {
  const r = await run(['cookies', '--json']);
  const cookies = parseJson<unknown[]>(r.stdout);
  assert(Array.isArray(cookies), 'cookies should be array');
});

c('cookies scopes to the active tab by default and redacts values', async () => {
  await run(['goto', 'https://example.com']);
  const rawValue = `ghax-smoke-${Date.now()}`;
  await run(['eval', `document.cookie = 'ghax_smoke_cookie=${rawValue}; path=/'`]);

  // Default scope: applicable to the active tab (example.com), value redacted.
  const scoped = await run(['cookies', '--json']);
  const cookies = parseJson<Array<{ name: string; domain: string; value: string }>>(scoped.stdout);
  const mine = cookies.find((cc) => cc.name === 'ghax_smoke_cookie');
  assert(mine, `expected ghax_smoke_cookie in default-scoped cookies, got: ${JSON.stringify(cookies).slice(0, 300)}`);
  assert(
    mine!.domain.replace(/^\./, '').includes('example.com'),
    `cookie domain should be example.com-scoped, got ${mine!.domain}`,
  );
  assert(
    mine!.value === `<redacted, ${rawValue.length} chars>`,
    `value should be redacted by default, got ${JSON.stringify(mine!.value)}`,
  );

  // --values opts into the raw value.
  const withValues = await run(['cookies', '--values', '--json']);
  const withValuesCookies = parseJson<Array<{ name: string; value: string }>>(withValues.stdout);
  const mineRaw = withValuesCookies.find((cc) => cc.name === 'ghax_smoke_cookie');
  assert(mineRaw && mineRaw.value === rawValue, `--values should show the raw value, got ${JSON.stringify(mineRaw)}`);

  // A different domain must not see example.com's cookie in the default scope,
  // but --domain reaches across the whole profile regardless of the active tab.
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body>ghax-smoke-cookies</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    await run(['goto', `http://127.0.0.1:${port}/`]);

    const otherScope = await run(['cookies', '--json']);
    const otherCookies = parseJson<Array<{ name: string }>>(otherScope.stdout);
    assert(
      !otherCookies.some((cc) => cc.name === 'ghax_smoke_cookie'),
      `example.com cookie leaked into 127.0.0.1's default scope: ${JSON.stringify(otherCookies)}`,
    );

    const domainFiltered = await run(['cookies', '--domain', 'example.com', '--json']);
    const domainCookies = parseJson<Array<{ name: string }>>(domainFiltered.stdout);
    assert(
      domainCookies.some((cc) => cc.name === 'ghax_smoke_cookie'),
      `--domain example.com should find the cookie despite active tab being 127.0.0.1: ${JSON.stringify(domainCookies)}`,
    );

    const all = await run(['cookies', '--all', '--json']);
    const allCookies = parseJson<Array<{ name: string }>>(all.stdout);
    assert(
      allCookies.some((cc) => cc.name === 'ghax_smoke_cookie'),
      `--all should dump the whole profile regardless of active tab: ${JSON.stringify(allCookies)}`,
    );
  } finally {
    await new Promise<void>((resolve) => {
      // Edge holds the page's HTTP/1.1 connection alive after navigation, and
      // `server.close()` waits for every open socket to drain — so without
      // forcibly dropping the keep-alive socket first, teardown blocks until
      // Edge's idle timeout (seconds to minutes), wedging the whole suite.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  await run(['goto', 'https://example.com']);
});

c('cookies --has exits 0 when in scope and 1 when not', async () => {
  await run(['goto', 'https://example.com']);
  await run(['eval', "document.cookie = 'ghax_smoke_has=present; path=/'"]);

  const hit = await run(['cookies', '--has', 'ghax_smoke_has'], { allowFailure: true });
  assert(hit.exitCode === 0, `expected exit 0 for a present cookie, got ${hit.exitCode}: ${hit.stdout}${hit.stderr}`);
  const hitJson = parseJson<{ name: string; exists: boolean }>(hit.stdout);
  assert(hitJson.exists === true, `expected exists:true, got ${hit.stdout}`);

  const miss = await run(['cookies', '--has', 'ghax_smoke_has_missing_xyz'], { allowFailure: true });
  assert(miss.exitCode === 1, `expected exit 1 for a missing cookie, got ${miss.exitCode}: ${miss.stdout}${miss.stderr}`);
  const missJson = parseJson<{ name: string; exists: boolean }>(miss.stdout);
  assert(missJson.exists === false, `expected exists:false, got ${miss.stdout}`);
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

// ─── Input verbs (hover, drag, right/triple click) ──────────────
const page = (body: string) => `data:text/html,${encodeURIComponent(`<!doctype html><title>input</title>${body}`)}`;
const HOVER_PAGE = page(`<style>#menu{display:none} #wrap:hover #menu{display:block}</style>
<div id="wrap" style="width:200px;height:60px;background:#eee"><button id="trigger">Menu</button><div id="menu">Settings</div></div>`);
const CLICKS_PAGE = page(`<p id="para" style="font:16px sans-serif;width:400px">alpha beta gamma delta</p>
<div id="ctx" style="width:120px;height:40px;background:#ccc">ctx</div>
<script>window.__ctx=0;window.__sel='';
document.getElementById('ctx').addEventListener('contextmenu',(e)=>{e.preventDefault();window.__ctx++;});
document.addEventListener('selectionchange',()=>{window.__sel=String(getSelection());});</script>`);
const DND_PAGE = page(`<div id="src" draggable="true" style="width:80px;height:40px;background:#9cf">card</div>
<div id="dst" style="margin-top:80px;width:160px;height:80px;background:#fc9">drop here</div>
<script>window.__dropped='';
document.getElementById('src').addEventListener('dragstart',(e)=>e.dataTransfer.setData('text/plain','card-1'));
const d=document.getElementById('dst');
d.addEventListener('dragover',(e)=>e.preventDefault());
d.addEventListener('drop',(e)=>{e.preventDefault();window.__dropped=e.dataTransfer.getData('text/plain');d.textContent='dropped:'+window.__dropped;});</script>`);
// dst starts just below the fold but shares a viewport with src once scrolled to.
const DND_BELOW_FOLD_PAGE = page(`<div id="src" draggable="true" style="margin-top:300px;width:80px;height:40px;background:#9cf">card</div>
<div id="dst" style="position:absolute;left:0;top:calc(100vh + 20px);width:160px;height:80px;background:#fc9">drop here</div>
<script>window.__dropped='';
document.getElementById('src').addEventListener('dragstart',(e)=>e.dataTransfer.setData('text/plain','card-1'));
const d=document.getElementById('dst');
d.addEventListener('dragover',(e)=>e.preventDefault());
d.addEventListener('drop',(e)=>{e.preventDefault();window.__dropped=e.dataTransfer.getData('text/plain');d.textContent='dropped:'+window.__dropped;});</script>`);
// dst is 2500px down: no viewport holds both ends.
const DND_FAR_PAGE = page(`<div id="src" draggable="true" style="width:80px;height:40px;background:#9cf">card</div>
<div id="dst" style="margin-top:2500px;width:160px;height:80px;background:#fc9">drop here</div>
<script>window.__dropped='';
document.getElementById('src').addEventListener('dragstart',(e)=>e.dataTransfer.setData('text/plain','card-1'));
const d=document.getElementById('dst');
d.addEventListener('dragover',(e)=>e.preventDefault());
d.addEventListener('drop',(e)=>{e.preventDefault();window.__dropped=e.dataTransfer.getData('text/plain');d.textContent='dropped:'+window.__dropped;});</script>`);
const MOUSE_DRAG_PAGE = page(`<div id="pad" style="width:300px;height:100px;background:#ddd"></div>
<script>window.__path=[];const p=document.getElementById('pad');
p.addEventListener('mousedown',(e)=>window.__path.push('down'));
p.addEventListener('mousemove',(e)=>{if(e.buttons===1)window.__path.push('move')});
p.addEventListener('mouseup',(e)=>window.__path.push('up:'+Math.round(e.clientX)));</script>`);
const evalJson = async <T,>(js: string): Promise<T> => parseJson<T>((await run(['eval', js, '--json'])).stdout);

c('hover reveals a CSS :hover menu and leaves it open', async () => {
  await run(['goto', HOVER_PAGE]);
  // `is` exits 1 when the check is false, so a negative check must allow it.
  // Exit 0 = visible, 1 = hidden; anything else is an error, not "hidden".
  const isVisible = async () => (await run(['is', 'visible', '#menu', '--json'], { allowFailure: true })).exitCode;
  assert(await isVisible() === 1, 'menu hidden before hover');
  const r = parseJson<{ ok: boolean; x: number; y: number }>((await run(['hover', '#trigger', '--json'])).stdout);
  assert(r.ok && r.x > 0 && r.y > 0, `hover result: ${JSON.stringify(r)}`);
  assert(await isVisible() === 0, 'menu visible after hover (no mouse-up)');
  // gesture hover elsewhere closes it again.
  await run(['gesture', 'hover', '600,400']);
  assert(await isVisible() === 1, 'gesture hover away closes the menu');
});

c('click --button right and gesture rightclick fire contextmenu', async () => {
  await run(['goto', CLICKS_PAGE]);
  await run(['click', '#ctx', '--button', 'right', '--no-observe']);
  const box = parseJson<{ x: number; y: number; width: number; height: number }>((await run(['box', '#ctx', '--json'])).stdout);
  await run(['gesture', 'rightclick', `${box.x + box.width / 2},${box.y + box.height / 2}`]);
  const n = await evalJson<number>('window.__ctx');
  assert(n === 2, `contextmenu fired twice, got ${n}`);
  const bad = await run(['click', '#ctx', '--button', 'back'], { allowFailure: true });
  assert(bad.exitCode !== 0 && /--button/.test(bad.stderr + bad.stdout), `bad --button refused: ${bad.stderr}`);
});

c('click --count 3 and gesture tripleclick select the paragraph', async () => {
  await run(['goto', CLICKS_PAGE]);
  await run(['click', '#para', '--count', '3', '--no-observe']);
  await run(['wait', '100']);
  let sel = await evalJson<string>('window.__sel');
  assert(/alpha beta gamma delta/.test(sel), `click --count 3 selected: ${JSON.stringify(sel)}`);
  await run(['eval', 'getSelection().removeAllRanges(); window.__sel=""; 1']);
  const box = parseJson<{ x: number; y: number }>((await run(['box', '#para', '--json'])).stdout);
  await run(['gesture', 'tripleclick', `${box.x + 10},${box.y + 8}`]);
  await run(['wait', '100']);
  sel = await evalJson<string>('window.__sel');
  assert(/alpha beta gamma delta/.test(sel), `gesture tripleclick selected: ${JSON.stringify(sel)}`);
});

c('drag finishes an HTML5 drag-and-drop with the drag data', async () => {
  await run(['goto', DND_PAGE]);
  const r = parseJson<{ ok: boolean; html5: boolean; mode: string }>((await run(['drag', '#src', '#dst', '--json'])).stdout);
  assert(r.ok && r.html5 === true && r.mode === 'auto', `drag result: ${JSON.stringify(r)}`);
  const dropped = await evalJson<string>('window.__dropped');
  assert(dropped === 'card-1', `drop received the dragstart data, got ${JSON.stringify(dropped)}`);
});

c('drag to a destination below the fold scrolls it in and drops on it', async () => {
  await run(['goto', DND_BELOW_FOLD_PAGE]);
  assert(await evalJson<number>('scrollY') === 0, 'page starts at the top');
  const r = parseJson<{ ok: boolean; html5: boolean; from: { y: number }; to: { y: number } }>((await run(['drag', '#src', '#dst', '--json'])).stdout);
  assert(r.ok && r.html5 === true, `drag result: ${JSON.stringify(r)}`);
  const h = await evalJson<number>('innerHeight');
  assert(r.to.y >= 0 && r.to.y < h && r.from.y >= 0 && r.from.y < h, `both points are in the viewport after the scroll: ${JSON.stringify(r)}`);
  assert(await evalJson<number>('scrollY') > 0, 'the destination was scrolled into view');
  assert(await evalJson<string>('window.__dropped') === 'card-1', 'the drop landed on the destination with the drag data');
  assert(await evalJson<string>("document.getElementById('dst').textContent") === 'dropped:card-1', 'dst, not another element, received the drop');
});

c('drag --mode synthetic with a below-the-fold destination drops on it', async () => {
  await run(['goto', DND_BELOW_FOLD_PAGE]);
  await run(['drag', '#src', '#dst', '--mode', 'synthetic']);
  assert(await evalJson<string>('window.__dropped') === 'card-1', 'synthetic drop reached the destination');
});

c('drag between ends that cannot share a viewport fails and presses nothing', async () => {
  await run(['goto', DND_FAR_PAGE]);
  await run(['eval', "window.__down=0; document.addEventListener('mousedown',()=>window.__down++,true); 1"]);
  for (const mode of ['auto', 'synthetic']) {
    const r = await run(['drag', '#src', '#dst', '--mode', mode], { allowFailure: true });
    assert(r.exitCode !== 0 && /cannot be scrolled into view together/.test(r.stderr + r.stdout), `${mode}: clear error: ${r.stderr}${r.stdout}`);
  }
  assert(await evalJson<string>('window.__dropped') === '', 'nothing dropped');
  assert(await evalJson<number>('window.__down') === 0, 'no mouse press was sent');
});

c('drag to an explicit off-screen point fails with a viewport error', async () => {
  await run(['goto', DND_PAGE]);
  const box = parseJson<{ x: number; y: number }>((await run(['box', '#src', '--json'])).stdout);
  const r = await run(['drag', `${Math.round(box.x + 10)},${Math.round(box.y + 10)}`, '10,99999'], { allowFailure: true });
  assert(r.exitCode !== 0 && /outside the \d+x\d+ viewport/.test(r.stderr + r.stdout), `off-screen point refused: ${r.stderr}${r.stdout}`);
  assert(await evalJson<string>('window.__dropped') === '', 'no drop happened');
  // The button was let go: a later plain click still works.
  await run(['click', '#src', '--no-observe']);
});

c('drag keeps its arguments in order with --force between them', async () => {
  await run(['goto', DND_PAGE]);
  const r = parseJson<{ ok: boolean; mode: string }>((await run(['drag', '#src', '--force', '#dst', '--json'])).stdout);
  assert(r.ok, `drag result: ${JSON.stringify(r)}`);
  assert(await evalJson<string>('window.__dropped') === 'card-1', '#src was the source and #dst the destination');
  await run(['goto', DND_PAGE]);
  await run(['drag', '--force', '#src', '#dst']);
  assert(await evalJson<string>('window.__dropped') === 'card-1', '--force first keeps the order too');
  await run(['goto', DND_PAGE]);
  await run(['drag', '#src', '#dst', '--force=true']);
  assert(await evalJson<string>('window.__dropped') === 'card-1', '--force=true still works');
});

c('drag --mode synthetic reaches DragEvent listeners', async () => {
  await run(['goto', DND_PAGE]);
  const r = parseJson<{ html5: boolean; mode: string }>((await run(['drag', '#src', '#dst', '--mode', 'synthetic', '--json'])).stdout);
  assert(r.mode === 'synthetic', `mode: ${JSON.stringify(r)}`);
  assert(await evalJson<string>('window.__dropped') === 'card-1', 'synthetic drop carried the data');
});

c('drag without an HTML5 drag is press, moves, release', async () => {
  await run(['goto', MOUSE_DRAG_PAGE]);
  const box = parseJson<{ x: number; y: number }>((await run(['box', '#pad', '--json'])).stdout);
  const y = Math.round(box.y + 50);
  const r = parseJson<{ html5: boolean }>((await run(['drag', `${Math.round(box.x + 20)},${y}`, `${Math.round(box.x + 220)},${y}`, '--steps', '5', '--json'])).stdout);
  assert(r.html5 === false, `plain mouse drag: ${JSON.stringify(r)}`);
  const pathSeen = await evalJson<string[]>('window.__path');
  assert(pathSeen[0] === 'down' && pathSeen.filter((p) => p === 'move').length >= 5, `moves with button held: ${JSON.stringify(pathSeen)}`);
  assert(pathSeen.at(-1) === `up:${Math.round(box.x + 220)}`, `released at to: ${JSON.stringify(pathSeen)}`);
});

c('xpath query returns matches with text + tag + box', async () => {
  await run(['goto', H1_PAGE]);
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
  await run(['goto', H1_PAGE]);
  await run(['wait', '200']);
  const r = await run(['box', 'h1', '--json']);
  const box = parseJson<{ x: number; y: number; width: number; height: number }>(r.stdout);
  assert(typeof box.x === 'number' && typeof box.y === 'number', 'box x/y numeric');
  assert(box.width > 0 && box.height > 0, `box should be laid out, got ${box.width}x${box.height}`);
});

c('box also resolves @e<n> refs from the last snapshot', async () => {
  await run(['goto', LINK_PAGE]);
  const r = await run(['box', await snapRef('link'), '--json']);
  const box = parseJson<{ width: number }>(r.stdout);
  assert(box.width > 0, 'ref box missing width');
});

c('is <check> asserts element state', async () => {
  await run(['goto', LINK_PAGE]);
  const r = await run(['is', 'visible', await snapRef('link'), '--json']);
  const data = parseJson<{ check: string; target: string; result: boolean }>(r.stdout);
  assert(data.check === 'visible' && data.result === true, `is visible <link ref> → ${JSON.stringify(data)}`);
});

c('cookies delete removes exactly one cookie and refuses ambiguity', async () => {
  await run(['goto', 'https://example.com']);
  const name = `ghax_smoke_del_${Date.now()}`;
  await run(['eval', `document.cookie = '${name}=SECRETv1zz; path=/'; document.cookie = '${name}=SECRETv2zz; path=/ghaxsub'`]);
  // Same name on two paths, only "/" applies to the tab URL; ask for the whole profile to see both.
  const amb = await run(['cookies', 'delete', name, '--all'], { allowFailure: true });
  assert(amb.exitCode !== 0, 'ambiguous delete should fail');
  assert(/matches 2 cookies/.test(amb.stderr + amb.stdout), `expected refusal, got: ${amb.stderr}${amb.stdout}`);
  assert(!/SECRETv/.test(amb.stderr + amb.stdout), 'refusal must not print values');
  const del = await run(['cookies', 'delete', name, '--all', '--path', '/', '--json']);
  const out = parseJson<{ deleted: Array<{ name: string; path: string }> }>(del.stdout);
  assert(out.deleted.length === 1 && out.deleted[0].path === '/', `unexpected delete report: ${del.stdout}`);
  const left = parseJson<Array<{ name: string; path: string }>>((await run(['cookies', '--all', '--json'])).stdout)
    .filter((cc) => cc.name === name);
  assert(left.length === 1 && left[0].path === '/ghaxsub', `expected only the /ghaxsub cookie left, got ${JSON.stringify(left)}`);
  await run(['cookies', 'delete', name, '--all']);
});

c('auth export writes a 0600 storageState that Playwright loads', async () => {
  await run(['goto', 'https://example.com']); // storage is disabled on data: URLs
  const name = `ghax_smoke_auth_${Date.now()}`;
  const raw = `SECRETauth${Date.now()}`;
  await run(['eval', `document.cookie = '${name}=${raw}; path=/; max-age=3600'; localStorage.setItem('${name}', '${raw}')`]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghax-smoke-auth-'));
  const out = path.join(dir, 'state.json');
  const exportArgs = ['auth', 'export', '--out', out, '--domain', 'example.com', '--origin', 'https://example.com', '--json'];
  try {
    const r = await run(exportArgs);
    assert(!(r.stdout + r.stderr).includes(raw), 'auth export printed a value');
    const meta = parseJson<{ path: string; cookiesByDomain: Record<string, number>; origins: number; localStorageKeys: number }>(r.stdout);
    assert(meta.cookiesByDomain['example.com'] >= 1 && meta.origins === 1 && meta.localStorageKeys >= 1, `unexpected report: ${r.stdout}`);
    assert((fs.statSync(out).mode & 0o777) === 0o600, `mode ${(fs.statSync(out).mode & 0o777).toString(8)}, want 600`);

    const again = await run(exportArgs, { allowFailure: true });
    assert(again.exitCode !== 0 && /already exists/.test(again.stderr), `existing file without --force should refuse: ${again.stderr}`);
    await run([...exportArgs, '--force']);
    const noDomain = await run(['auth', 'export', '--out', path.join(dir, 'x.json')], { allowFailure: true });
    assert(noDomain.exitCode !== 0 && !fs.existsSync(path.join(dir, 'x.json')), 'missing --domain should refuse');

    // The point of the verb: a fresh headless browser runs as the exported session.
    const { chromium } = await import('playwright');
    let browser: import('playwright').Browser | null = null;
    for (const channel of ['chrome', 'msedge', undefined]) {
      try { browser = await chromium.launch({ channel, headless: true }); break; } catch { /* try the next channel */ }
    }
    assert(browser, 'no Chromium for chromium.launch (tried chrome, msedge, bundled)');
    try {
      const context = await browser!.newContext({ storageState: out });
      const got = (await context.cookies('https://example.com')).find((cc) => cc.name === name);
      assert(got && got.value === raw, `cookie did not load from storageState: ${JSON.stringify(got ?? null).slice(0, 120)}`);
      const st = await context.storageState();
      const ls = st.origins.find((o) => o.origin === 'https://example.com')?.localStorage ?? [];
      assert(ls.some((i) => i.name === name && i.value === raw), 'localStorage did not load from storageState');
    } finally {
      await browser!.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await run(['cookies', 'delete', name, '--domain', 'example.com', '--path', '/'], { allowFailure: true });
    await run(['storage', 'local', 'remove', name], { allowFailure: true });
  }
});

c('storage local round-trips set/get/remove', async () => {
  await run(['goto', 'https://example.com']); // storage is disabled on data: URLs
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
  // Seed 5 identical errors + 1 unique one, then dedup. The console
  // buffer persists across smoke runs against the same daemon, so use
  // a per-run marker — re-running smoke against a warm daemon would
  // otherwise see 5 entries from the previous run plus 5 new ones and
  // fail with `expected count=5, got 10`.
  const tag = `ghax-smoke-${Date.now().toString(36)}`;
  const repeatText = `${tag}-repeat`;
  const uniqueText = `${tag}-unique`;
  await run(['eval', `for (let i = 0; i < 5; i++) { try { throw new Error(${JSON.stringify(repeatText)}); } catch (e) { console.error(e.message); } } console.error(${JSON.stringify(uniqueText)})`]);
  await run(['wait', '100']);
  const r = await run(['console', '--errors', '--dedup', '--last', '50', '--json']);
  const groups = parseJson<Array<{ text: string; count: number }>>(r.stdout);
  const repeat = groups.find((g) => g.text === repeatText);
  const unique = groups.find((g) => g.text === uniqueText);
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

  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><script src="bundle.js"></script></head><body>sm</body></html>');
    } else if (url.pathname === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(bundled);
    } else if (url.pathname === '/bundle.js.map') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(mapText);
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  try {
    const port = (server.address() as AddressInfo).port;
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
    await new Promise<void>((resolve) => {
      // Edge holds the page's HTTP/1.1 connection alive after navigation, and
      // `server.close()` waits for every open socket to drain — so without
      // forcibly dropping the keep-alive socket first, teardown blocks until
      // Edge's idle timeout (seconds to minutes), wedging the whole suite.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
});

c('source-maps: falls back silently when script has no map comment', async () => {
  // Serve a bundle with NO sourceMappingURL comment. Console --source-maps
  // should return the frame unchanged (no bundledUrl field).
  const bundled = 'throw new Error("ghax-sm-nomap");';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><script src="bundle.js"></script></body></html>');
    } else if (url.pathname === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(bundled);
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    await run(['goto', `http://127.0.0.1:${port}/`]);
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
    await new Promise<void>((resolve) => {
      // Edge holds the page's HTTP/1.1 connection alive after navigation, and
      // `server.close()` waits for every open socket to drain — so without
      // forcibly dropping the keep-alive socket first, teardown blocks until
      // Edge's idle timeout (seconds to minutes), wedging the whole suite.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
});

c('source-maps: falls back silently on invalid map JSON', async () => {
  const bundled = 'throw new Error("ghax-sm-badmap");\n//# sourceMappingURL=bundle.js.map';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><script src="bundle.js"></script></body></html>');
    } else if (url.pathname === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(bundled);
    } else if (url.pathname === '/bundle.js.map') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not valid json at all}');
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    await run(['goto', `http://127.0.0.1:${port}/`]);
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
    await new Promise<void>((resolve) => {
      // Edge holds the page's HTTP/1.1 connection alive after navigation, and
      // `server.close()` waits for every open socket to drain — so without
      // forcibly dropping the keep-alive socket first, teardown blocks until
      // Edge's idle timeout (seconds to minutes), wedging the whole suite.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
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
  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1`);
    if (url.pathname === '/missing') {
      res.writeHead(404); res.end('not found');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><img src="/missing"></body></html>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const server404Port = (server.address() as AddressInfo).port;
  try {
    await run(['goto', `http://127.0.0.1:${server404Port}/`]);
    await run(['wait', '500']);
    const r = await run(['network', '--status', '404', '--last', '50', '--json']);
    const entries = parseJson<Array<{ status: number; url: string }>>(r.stdout);
    assert(entries.length >= 1, `expected at least one 404, got ${entries.length}`);
    assert(entries.every((e) => e.status === 404), 'all entries should be 404');
  } finally {
    await new Promise<void>((resolve) => {
      // Edge holds the page's HTTP/1.1 connection alive after navigation, and
      // `server.close()` waits for every open socket to drain — so without
      // forcibly dropping the keep-alive socket first, teardown blocks until
      // Edge's idle timeout (seconds to minutes), wedging the whole suite.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
});

c('network --status 400-499 range matches 4xx', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1`);
    if (url.pathname === '/gone') {
      res.writeHead(410); res.end('gone');
    } else if (url.pathname === '/err') {
      res.writeHead(500); res.end('server err');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><img src="/gone"><img src="/err"></body></html>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const server4xxPort = (server.address() as AddressInfo).port;
  try {
    await run(['goto', `http://127.0.0.1:${server4xxPort}/`]);
    await run(['wait', '500']);
    const r = await run(['network', '--status', '400-499', '--last', '50', '--json']);
    const entries = parseJson<Array<{ status: number }>>(r.stdout);
    assert(entries.some((e) => e.status === 410), 'expected the 410 entry');
    assert(!entries.some((e) => e.status === 500), 'range 400-499 should NOT include 500');
  } finally {
    await new Promise<void>((resolve) => {
      // Edge holds the page's HTTP/1.1 connection alive after navigation, and
      // `server.close()` waits for every open socket to drain — so without
      // forcibly dropping the keep-alive socket first, teardown blocks until
      // Edge's idle timeout (seconds to minutes), wedging the whole suite.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
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
  try {
    const r = await run(attachArgs('--browser', 'chromium'), { allowFailure: true });
    const out = r.stderr + r.stdout;
    // With GHAX_SMOKE_PORT pinned, the filtered scan finds nothing on that
    // port and the CLI prints the generic launch instructions instead.
    assert(
      /only .* on :\d+ running|--browser chromium requested/i.test(out) ||
        (smokePort && /No running browser found on CDP port/.test(out)),
      `expected kind-mismatch error, got: ${out.slice(0, 300)}`,
    );
    assert(r.exitCode !== 0, 'kind-mismatch attach should exit non-zero');
  } finally {
    // Always restore the attach so the rest of the suite can run, even if the
    // assertion above failed (this test sits mid-suite).
    await run(attachArgs());
  }
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

c('upload sets a file onto a file input', async () => {
  const uploadPath = `/tmp/ghax-smoke-upload-${Date.now()}.txt`;
  fs.writeFileSync(uploadPath, 'smoke upload payload\n');
  try {
    await run(['goto', 'data:text/html,<input type=file id=up>']);
    await run(['wait', '300']);
    await run(['upload', '#up', uploadPath]);
    const r = await run(['eval', 'document.getElementById("up").files[0].name']);
    const name = r.stdout.trim().replace(/^"|"$/g, '');
    assert(name === path.basename(uploadPath), `upload name mismatch: ${name}`);
  } finally {
    fs.unlinkSync(uploadPath);
  }
});

c('upload rejects missing args', async () => {
  const r = await run(['upload', '#only-one-arg'], { allowFailure: true });
  assert(r.exitCode !== 0, 'upload should fail when path missing');
  assert(/Usage: ghax upload/.test(r.stderr + r.stdout), `expected usage hint, got: ${r.stderr || r.stdout}`);
});

c('fill routes into a Monaco editor via monaco.editor.getEditors()', async () => {
  // Minimal, hermetic stand-in for Monaco: no CDN, just a DOM shape
  // (.monaco-editor container) plus a fake `window.monaco.editor` API
  // shaped exactly like the real one's `getEditors()/getDomNode()/setValue()`
  // surface. This exercises the daemon's detection + editor-matching logic
  // without pulling in the real (multi-MB) Monaco bundle.
  const html = `<div class="monaco-editor" id="editor-root"><div class="view-lines" id="inner">stub</div></div>
<script>
  const root = document.getElementById('editor-root');
  let lastValue = '';
  window.monaco = {
    editor: {
      getEditors: () => [{
        getDomNode: () => root,
        setValue: (v) => { lastValue = v; root.setAttribute('data-monaco-value', v); },
      }],
    },
  };
</script>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  await run(['wait', '300']);
  const r = await run(['fill', '#inner', 'ghax-monaco-value', '--json']);
  const data = parseJson<{ ok: boolean; editor?: string }>(r.stdout);
  assert(data.ok === true && data.editor === 'monaco', `fill should report monaco editor, got ${JSON.stringify(data)}`);
  const val = (await run(['eval', 'document.getElementById("editor-root").getAttribute("data-monaco-value")']))
    .stdout.trim().replace(/^"|"$/g, '');
  assert(val === 'ghax-monaco-value', `monaco setValue should have fired, got ${JSON.stringify(val)}`);
});

c('select sets a native <select> by visible text (label), falling back to value', async () => {
  await run(['goto', 'data:text/html,<select id=s1><option value="a">Alpha</option><option value="b">Bravo</option></select>']);
  await run(['wait', '300']);
  const r = await run(['select', '#s1', 'Bravo', '--json']);
  const data = parseJson<{ ok: boolean; strategy: string; value: string[] }>(r.stdout);
  assert(data.ok === true, `select should succeed: ${JSON.stringify(data)}`);
  assert(data.strategy === 'native', `expected native strategy, got ${JSON.stringify(data)}`);
  const val = (await run(['eval', 'document.getElementById("s1").value'])).stdout.trim().replace(/^"|"$/g, '');
  assert(val === 'b', `expected value "b" (Bravo selected), got ${JSON.stringify(val)}`);
});

c('select --index picks a native <select> option by 0-based position', async () => {
  await run(['goto', 'data:text/html,<select id=s2><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select>']);
  await run(['wait', '300']);
  const r = await run(['select', '#s2', '--index', '2', '--json']);
  const data = parseJson<{ ok: boolean; strategy: string }>(r.stdout);
  assert(data.ok === true && data.strategy === 'native', `select --index result: ${JSON.stringify(data)}`);
  const val = (await run(['eval', 'document.getElementById("s2").value'])).stdout.trim().replace(/^"|"$/g, '');
  assert(val === 'z', `expected value "z" (index 2), got ${JSON.stringify(val)}`);
});

c('select --by-value sets a native <select> by option value attribute', async () => {
  await run(['goto', 'data:text/html,<select id=s3><option value="foo">Foo Label</option><option value="bar">Bar Label</option></select>']);
  await run(['wait', '300']);
  const r = await run(['select', '#s3', '--by-value', 'bar', '--json']);
  const data = parseJson<{ ok: boolean; strategy: string }>(r.stdout);
  assert(data.ok === true && data.strategy === 'native', `select --by-value result: ${JSON.stringify(data)}`);
  const val = (await run(['eval', 'document.getElementById("s3").value'])).stdout.trim().replace(/^"|"$/g, '');
  assert(val === 'bar', `expected value "bar", got ${JSON.stringify(val)}`);
});

c('select falls through the fiber traversal on a synthetic AntD-shaped fiber', async () => {
  // Not real React/AntD (no CDN, no multi-MB bundle) — a hand-built object
  // shaped exactly like what the daemon's traversal code walks: a DOM node
  // with a `.ant-select` class, an own property whose key starts with
  // `__reactFiber`, and a `.return` chain leading to a fiber whose
  // `memoizedProps.onChange` is a real function. This proves the traversal
  // + options-matching algorithm from BUG-1's field report, independent of
  // whether a real AntD bundle is present.
  const html = `<div class="ant-select" id="ant1"><span>Please select</span></div>
<script>
  const root = document.getElementById('ant1');
  window.__ghaxFiberCalls = [];
  const ownerFiber = {
    memoizedProps: {
      onChange: (v) => { window.__ghaxFiberCalls.push(v); },
      options: [{ value: 'v1', label: 'Label One' }, { value: 'v2', label: 'Label Two' }],
    },
    return: null,
  };
  root['__reactFiber$synthetic'] = { memoizedProps: {}, return: ownerFiber };
</script>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  await run(['wait', '300']);
  const r = await run(['select', '#ant1', 'Label Two', '--json']);
  const data = parseJson<{ ok: boolean; strategy: string; value: string }>(r.stdout);
  assert(data.ok === true && data.strategy === 'fiber', `select fiber result: ${JSON.stringify(data)}`);
  assert(data.value === 'v2', `expected matched option value "v2", got ${JSON.stringify(data)}`);
  const calls = parseJson<string[]>((await run(['eval', 'JSON.stringify(window.__ghaxFiberCalls)'])).stdout.trim());
  assert(calls.length === 1 && calls[0] === 'v2', `expected onChange called once with v2, got ${JSON.stringify(calls)}`);
});

c('select open-click strategy finds and clicks a portal-style custom dropdown option', async () => {
  // Minimal role=combobox + role=listbox custom dropdown. No framework —
  // exercises the generic open-click cascade step: click the trigger, wait
  // for the dropdown, find the option by visible text, click it.
  const html = `<button id="trigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="listbox1">Choose</button>
<ul id="listbox1" role="listbox" style="display:none">
  <li role="option" data-value="one">One</li>
  <li role="option" data-value="two">Two</li>
  <li role="option" data-value="three">Three</li>
</ul>
<span id="result"></span>
<script>
  const trigger = document.getElementById('trigger');
  const listbox = document.getElementById('listbox1');
  trigger.addEventListener('click', () => {
    const open = trigger.getAttribute('aria-expanded') === 'true';
    trigger.setAttribute('aria-expanded', open ? 'false' : 'true');
    listbox.style.display = open ? 'none' : 'block';
  });
  listbox.addEventListener('click', (e) => {
    const opt = e.target.closest('[role=option]');
    if (!opt) return;
    document.getElementById('result').textContent = opt.getAttribute('data-value');
    trigger.setAttribute('aria-expanded', 'false');
    listbox.style.display = 'none';
  });
</script>`;
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  await run(['wait', '300']);
  const r = await run(['select', '#trigger', 'Two', '--json']);
  const data = parseJson<{ ok: boolean; strategy: string }>(r.stdout);
  assert(data.ok === true && data.strategy === 'open-click', `select open-click result: ${JSON.stringify(data)}`);
  const resultText = (await run(['eval', 'document.getElementById("result").textContent'])).stdout.trim().replace(/^"|"$/g, '');
  assert(resultText === 'two', `expected option "Two" clicked (data-value=two), got ${JSON.stringify(resultText)}`);
});

c('select rejects missing value/index/by-value', async () => {
  await run(['goto', 'data:text/html,<select id=s4><option value="a">A</option></select>']);
  await run(['wait', '300']);
  const r = await run(['select', '#s4'], { allowFailure: true });
  assert(r.exitCode !== 0, 'select should fail when no value/index/by-value given');
  assert(
    /needs a value|Usage: ghax select/i.test(r.stderr + r.stdout),
    `expected a usage/value hint, got: ${r.stderr || r.stdout}`,
  );
});

c('select reports every strategy tried when none succeed', async () => {
  await run(['goto', 'data:text/html,<div id="plain">nothing interactive here</div>']);
  await run(['wait', '300']);
  const r = await run(['select', '#plain', 'whatever'], { allowFailure: true });
  assert(r.exitCode !== 0, 'select should fail on a plain, non-interactive element');
  const out = r.stderr + r.stdout;
  assert(/no strategy worked/i.test(out), `expected "no strategy worked" summary: ${out}`);
  assert(
    /native <select>/.test(out) && /AntD fiber/.test(out) && /open-click/.test(out),
    `expected all three strategies listed in the error: ${out}`,
  );
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
  const hasPrior = spawnSync('git', ['rev-parse', 'HEAD~1'], { stdio: 'ignore' }).status === 0;
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

c('new-tab opens a background tab, locks onto it, and tab --focus is a switch', async () => {
  const beforeTabs = parseJson<Array<{ id: string; active: boolean }>>((await run(['tabs', '--json'])).stdout);
  const beforeActive = beforeTabs.find((t) => t.active)?.id;
  const r = await run(['new-tab', 'data:text/html,<title>bg</title><p>bg tab</p>', '--json']);
  const created = parseJson<{ id: string; url: string; index: number }>(r.stdout);
  try {
    assert(typeof created.id === 'string' && created.id.length > 0, `new-tab should return an id: ${r.stdout}`);
    assert(created.index === 0 && created.url.startsWith('data:'), `new-tab shape: ${r.stdout}`);
    const afterTabs = parseJson<Array<{ id: string; active: boolean }>>((await run(['tabs', '--json'])).stdout);
    assert(afterTabs.length === beforeTabs.length + 1, `expected tab count +1, got ${afterTabs.length - beforeTabs.length}`);
    assert(afterTabs.find((t) => t.active)?.id === created.id, 'the new tab should be the daemon\'s active tab');
    const text = (await run(['text'])).stdout;
    assert(/bg tab/.test(text), `text should read the new tab, got: ${text.slice(0, 120)}`);
    // CDP's createTarget has no window parameter, so --window refuses there.
    const win = await run(['new-tab', 'about:blank', '--window', '1'], { allowFailure: true });
    assert(win.exitCode !== 0 && /bridge-only/.test(win.stderr + win.stdout), `--window over CDP should refuse: ${win.stderr || win.stdout}`);
    // --focus must not swallow the selector that follows it.
    const f = await run(['tab', '--focus', created.id, '--json']);
    assert(parseJson<{ id: string }>(f.stdout).id === created.id, `tab --focus <id>: ${f.stdout}`);
  } finally {
    await run(['eval', 'window.close()'], { allowFailure: true });
    if (beforeActive) await run(['tab', beforeActive], { allowFailure: true });
  }
});

c('refs cleared on tab switch (CLAUDE.md invariant)', async () => {
  // Need at least two tabs to exercise the switch path. If the smoke
  // session is running on a single-tab browser, spawn a second window
  // for the test and clean up at the end.
  let spawnedSecondary = false;
  let secondaryId: string | null = null;
  let originalId: string | null = null;

  const tabsBefore = parseJson<Array<{ id: string; active: boolean }>>((await run(['tabs', '--json'])).stdout);
  if (tabsBefore.length < 2) {
    const r = await run(['new-window', 'about:blank', '--json']);
    const created = parseJson<{ id: string }>(r.stdout);
    secondaryId = created.id;
    spawnedSecondary = true;
    originalId = tabsBefore.find((t) => t.active)?.id ?? null;
  } else {
    originalId = tabsBefore.find((t) => t.active)?.id ?? null;
    secondaryId = tabsBefore.find((t) => !t.active)?.id ?? null;
  }
  assert(!!originalId && !!secondaryId && originalId !== secondaryId, 'need two distinct tab ids');

  // Land on a page with a stable locator, snapshot, grab @e1.
  await run(['goto', LINK_PAGE]);
  await run(['wait', '300']);
  const snap = await run(['snapshot', '-i']);
  const firstRef = snap.stdout.match(/@(e\d+)/)?.[1];
  assert(!!firstRef, `snapshot should emit a ref: ${snap.stdout.slice(0, 200)}`);

  // Switch tabs — refs should be invalidated.
  await run(['tab', secondaryId!, '--quiet']);

  // Clicking the ref should fail with "not found" — the pre-switch
  // locator must NOT resolve against the new active page.
  const click = await run(['click', `@${firstRef}`], { allowFailure: true });
  const combined = click.stderr + click.stdout;
  assert(
    click.exitCode !== 0 && /not found|Run 'ghax snapshot' first/i.test(combined),
    `@${firstRef} should fail after tab switch — got exit=${click.exitCode}, out=${combined.slice(0, 200)}`,
  );

  // Restore active tab for downstream tests.
  if (originalId) await run(['tab', originalId, '--quiet'], { allowFailure: true });
  if (spawnedSecondary && secondaryId) {
    await run(['tab', secondaryId, '--quiet'], { allowFailure: true });
    await run(['eval', 'window.close()'], { allowFailure: true });
    if (originalId) await run(['tab', originalId, '--quiet'], { allowFailure: true });
  }
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
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ffmpeg.status !== 0) {
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

c('downloads land in --downloads-dir with the site-suggested name', async () => {
  // Regression guard for the old connectOverCDP download hijack (files
  // landing as extension-less GUIDs in /var/folders). The daemon now attaches
  // with `noDefaults: true`, so Playwright leaves download behaviour alone,
  // and sets `allow` + our downloadPath exactly once at attach. The
  // new-window below is deliberate: the old code re-asserted the behaviour
  // there, and this proves one attach-time call is enough.
  //
  // Runs on an ISOLATED daemon (own state file + own window) so it never
  // disturbs the shared suite daemon or the user's real ~/Downloads.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ghax-smoke-dl-'));
  const stateFile = path.join(scratch, 'state.json');
  const env: NodeJS.ProcessEnv = { ...process.env, GHAX_STATE_FILE: stateFile };
  const runIso = (args: string[]) =>
    new Promise<RunResult>((resolve) => {
      const proc = spawn(ghax, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
      proc.on('exit', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    });
  try {
    await runIso(attachArgs('--downloads-dir', scratch));
    await runIso(['new-window', 'about:blank']);
    // Hermetic: a blob download, no network.
    await runIso(['eval',
      'const b=new Blob(["a,b\\n1,2\\n"],{type:"text/csv"});' +
      'const u=URL.createObjectURL(b);const a=document.createElement("a");' +
      'a.href=u;a.download="smoke-report.csv";document.body.appendChild(a);a.click();"ok"']);
    // Poll for the file + a completed record.
    const want = path.join(scratch, 'smoke-report.csv');
    let record: any = null;
    for (let i = 0; i < 40; i++) {
      const r = await runIso(['downloads', '--last', '5', '--json']);
      const data = parseJson<{ downloadsDir: string; downloads: any[] }>(r.stdout);
      record = data.downloads.find((d) => d.filename === 'smoke-report.csv') ?? null;
      if (fs.existsSync(want) && record?.state === 'completed') break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert(fs.existsSync(want), `download did not land at ${want} (contents: ${fs.readdirSync(scratch).join(', ')})`);
    assert(record, 'downloads verb returned no record for smoke-report.csv');
    assert(record.state === 'completed', `download state should be completed, got ${record.state}`);
    assert(record.finalPath === want, `finalPath mismatch: ${record.finalPath} !== ${want}`);
    assert(record.filename === 'smoke-report.csv', `filename should keep extension, got ${record.filename}`);
    // Close the isolated window so we don't leave a stray tab behind.
    await runIso(['eval', 'window.close()']);
  } finally {
    await runIso(['detach']);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// The smoke suite runs on the CDP transport (no bridge extension involved),
// so this is the one bridge-reload check that belongs here: everything else
// about `ghax bridge reload` needs a real bridge connection and is covered by
// test/bridge-sim.ts + test/bridge-multi-sim.ts + the live reload test.
c('bridge reload errors clearly when the daemon is not in bridge mode', async () => {
  const r = await run(['bridge', 'reload'], { allowFailure: true });
  assert(r.exitCode !== 0, `expected a non-zero exit, got ${r.exitCode}`);
  assert(
    /requires bridge mode/i.test(r.stderr + r.stdout),
    `expected a clear bridge-mode error, got exit=${r.exitCode} stdout=${r.stdout} stderr=${r.stderr}`,
  );
});

c('bridge stats errors clearly when not in bridge mode', async () => {
  const r = await run(['bridge', 'stats'], { allowFailure: true });
  assert(r.exitCode === 2, `expected exit 2, got ${r.exitCode} stderr=${r.stderr}`);
  assert(
    /requires bridge mode/i.test(r.stderr) && /--trace/.test(r.stderr),
    `expected a bridge-mode error pointing at --trace, got: ${r.stderr}`,
  );
});

c('--trace prints a trace line on stderr and leaves stdout alone', async () => {
  const plain = await run(['eval', '1 + 1', '--json']);
  const traced = await run(['eval', '--trace', '1 + 1', '--json']);
  assert(traced.stdout === plain.stdout, `stdout changed under --trace: ${plain.stdout} vs ${traced.stdout}`);
  assert(
    /^trace: \d+ cdp calls, [\d.]+ ms cdp, [\d.]+ ms handler \(cdp\)/m.test(traced.stderr),
    `expected a trace line on stderr, got: ${traced.stderr}`,
  );
  assert(!/^trace:/m.test(plain.stderr), `no trace line expected without the flag: ${plain.stderr}`);
  // A leading global flag works too.
  const leading = await run(['--trace', 'tabs', '--json']);
  assert(/^trace: /m.test(leading.stderr), `leading --trace ignored: ${leading.stderr}`);
});

// ─── expect ─────────────────────────────────────────────────────

/** Serve a small page whose #late element appears 600 ms after load. */
async function withExpectPage(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Dash board</title><body>
      <h1>Welcome back</h1>
      <input id="name" value="ada">
      <ul><li>a</li><li>b</li><li>c</li></ul>
      <div id="gone" style="display:none">hidden thing</div>
      <button id="go">Go</button>
      <script>setTimeout(() => { const d = document.createElement('div'); d.id = 'late'; d.textContent = 'arrived'; document.body.append(d); }, 600);</script>
    </body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/dashboard`);
  } finally {
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  }
}

type ExpectOut = { ok: boolean; expect: string; actual: unknown; elapsedMs: number };

c('expect: every kind passes on a matching page, exit 0', async () => {
  await withExpectPage(async (url) => {
    await run(['goto', url]);
    const btn = await snapRef('button', 'Go');
    const ok = async (args: string[]) => {
      const r = await run(['expect', ...args, '--timeout', '2000']);
      const out = parseJson<ExpectOut>(r.stdout);
      assert(out.ok === true, `expect ${args.join(' ')} => ${r.stdout}`);
      return out;
    };
    assert((await ok(['--url', '/dash.*$'])).actual === url, 'url actual is the page url');
    await ok(['--title', '^Dash']);
    await ok(['--text', 'Welcome back']);
    await ok(['--text', 'Welcome', '--selector', 'h1']);
    await ok(['--visible', '#name']);
    await ok(['--visible', btn]);
    await ok(['--hidden', '#gone']);
    await ok(['--hidden', '#nope']);
    assert((await ok(['--count', 'li', '--n', '3'])).actual === 3, 'count actual');
    await ok(['--count', 'li', '--min', '2', '--max', '5']);
    await ok(['--value', '#name', '--expected', 'ada']);
    await ok(['--eval', 'document.querySelectorAll("li").length === 3']);
  });
});

c('expect: a failing check exits 1 with {expect, actual, elapsedMs}; --timeout bounds the poll', async () => {
  await withExpectPage(async (url) => {
    await run(['goto', url]);
    const started = Date.now();
    const r = await run(['expect', '--text', 'Goodbye', '--timeout', '700'], { allowFailure: true });
    const took = Date.now() - started;
    assert(r.exitCode === 1, `failed expect must exit 1, got ${r.exitCode}: ${r.stderr}`);
    const out = parseJson<ExpectOut>(r.stdout);
    assert(out.ok === false && out.expect === 'text', `result: ${r.stdout}`);
    assert(typeof out.actual === 'string' && (out.actual as string).includes('Welcome back'), `actual should show the page text: ${r.stdout}`);
    assert(out.elapsedMs >= 600 && out.elapsedMs < 3000, `polled for ~700 ms, elapsedMs=${out.elapsedMs}`);
    assert(took < 6000, `timeout not honoured: ${took} ms`);
    const count = await run(['expect', '--count', 'li', '--n', '9', '--timeout', '0'], { allowFailure: true });
    assert(count.exitCode === 1 && parseJson<ExpectOut>(count.stdout).actual === 3, `count failure: ${count.stdout}`);
    const usage = await run(['expect', '--url', 'a', '--title', 'b'], { allowFailure: true });
    assert(usage.exitCode === 1 && /one check per step/.test(usage.stderr), `two checks is a usage error: ${usage.stderr}`);
  });
});

c('expect: polls until an element that appears late is there', async () => {
  await withExpectPage(async (url) => {
    await run(['goto', url]);
    const r = await run(['expect', '--visible', '#late', '--timeout', '3000']);
    const out = parseJson<ExpectOut>(r.stdout);
    assert(out.ok && out.elapsedMs >= 200, `should have waited for #late, elapsedMs=${out.elapsedMs}`);
    // With no budget the same check is a single look and fails.
    await run(['goto', url]);
    const now = await run(['expect', '--visible', '#late', '--timeout', '0'], { allowFailure: true });
    assert(now.exitCode === 1, `timeout 0 is one look, got exit ${now.exitCode}`);
  });
});

c('expect in batch: first failure stops the plan, exit 1, --report lists every step', async () => {
  await withExpectPage(async (url) => {
    const report = `/tmp/ghax-expect-report-${process.pid}.json`;
    const plan = JSON.stringify([
      { cmd: 'goto', args: [url] },
      { cmd: 'expect', opts: { url: '/dashboard$', timeout: 2000 } },
      { cmd: 'expect', opts: { text: 'Never on this page', timeout: 300 } },
      { cmd: 'eval', args: ['window.__after = 1'] },
    ]);
    const r = await run(['batch', plan, '--report', report], { allowFailure: true });
    assert(r.exitCode === 1, `batch with a failed expect must exit 1, got ${r.exitCode}: ${r.stdout}`);
    const steps = parseJson<Array<{ cmd: string; ok: boolean; code?: string; step?: number; expect?: string; actual?: unknown; elapsedMs?: number }>>(r.stdout);
    assert(steps.length === 3, `plan must stop at the failed expect, got ${steps.length} results`);
    assert(steps[1].ok && steps[2].ok === false && steps[2].code === 'EXPECT_FAILED'
      && steps[2].step === 2 && steps[2].expect === 'text' && typeof steps[2].elapsedMs === 'number'
      && typeof steps[2].actual === 'string', `failed step: ${JSON.stringify(steps[2])}`);
    const after = await run(['eval', 'String(window.__after)']);
    assert(after.stdout.trim() === 'undefined', 'the step after the failed expect must not have run');
    const rep = parseJson<{ ok: boolean; exit: number; steps: Array<{ cmd: string; ok: boolean; ms: number; actual?: unknown }> }>(
      fs.readFileSync(report, 'utf8'));
    assert(rep.ok === false && rep.exit === 1 && rep.steps.length === 3, `report: ${JSON.stringify(rep)}`);
    assert(rep.steps.every((st) => typeof st.ms === 'number') && rep.steps[1].actual === url && rep.steps[2].ok === false, `report steps: ${JSON.stringify(rep.steps)}`);
    fs.rmSync(report, { force: true });
    // An unrelated step failure is still exit 4, not an assertion.
    const broken = await run(['batch', JSON.stringify([{ cmd: 'no-such-verb' }])], { allowFailure: true });
    assert(broken.exitCode === 4, `a non-expect failure keeps exit 4, got ${broken.exitCode}`);
  });
});

c('expect: nested batch failure stops the outer plan; bare --report is a usage error', async () => {
  await withExpectPage(async (url) => {
    const plan = JSON.stringify([
      { cmd: 'goto', args: [url] },
      { cmd: 'batch', args: [[{ cmd: 'expect', opts: { text: 'Never on this page', timeout: 200 } }]] },
      { cmd: 'eval', args: ['window.__after2 = 1'] },
    ]);
    const r = await run(['batch', plan], { allowFailure: true });
    assert(r.exitCode === 1, `nested failed expect must exit 1, got ${r.exitCode}: ${r.stdout}`);
    const steps = parseJson<Array<{ cmd: string; ok: boolean; code?: string }>>(r.stdout);
    assert(steps.length === 2 && steps[1].cmd === 'batch' && steps[1].code === 'EXPECT_FAILED', `outer plan stops: ${r.stdout}`);
    const after = await run(['eval', 'String(window.__after2)']);
    assert(after.stdout.trim() === 'undefined', 'step after the nested failure must not have run');
    const chain = await run(['chain'], { stdin: JSON.stringify([{ cmd: 'batch', args: [[{ cmd: 'expect', opts: { text: 'Never on this page', timeout: 200 } }]] }]), allowFailure: true });
    assert(chain.exitCode === 1 && parseJson<Array<{ code?: string }>>(chain.stdout)[0].code === 'EXPECT_FAILED', `chain nested: ${chain.exitCode} ${chain.stdout}`);
    for (const argv of [['expect', '--url', '.', '--report'], ['batch', '[]', '--report']]) {
      const bare = await run(argv, { allowFailure: true });
      assert(bare.exitCode === 1 && /--report needs a file path/.test(bare.stderr), `bare --report on ${argv[0]}: ${bare.exitCode} ${bare.stderr}`);
    }
  });
});

c('expect in chain and replay files: failure exits 1', async () => {
  await withExpectPage(async (url) => {
    const steps = [{ cmd: 'goto', args: [url] }, { cmd: 'expect', opts: { title: 'Nope', timeout: 200 } }, { cmd: 'text' }];
    const chain = await run(['chain'], { stdin: JSON.stringify(steps), allowFailure: true });
    assert(chain.exitCode === 1, `chain exit: ${chain.exitCode} ${chain.stdout}`);
    const res = parseJson<Array<{ cmd: string; code?: string }>>(chain.stdout);
    assert(res.length === 2 && res[1].code === 'EXPECT_FAILED', `chain stops at the failed expect: ${chain.stdout}`);
    const file = `/tmp/ghax-expect-replay-${process.pid}.json`;
    fs.writeFileSync(file, JSON.stringify({ steps }));
    const replay = await run(['replay', file], { allowFailure: true });
    assert(replay.exitCode === 1 && /✗ expect/.test(replay.stderr), `replay: ${replay.exitCode} ${replay.stderr}`);
    fs.writeFileSync(file, JSON.stringify({ steps: [steps[0], { cmd: 'expect', opts: { title: 'Dash', timeout: 1000 } }] }));
    const good = await run(['replay', file]);
    assert(/✓ expect/.test(good.stdout), `passing replay: ${good.stdout}`);
    fs.rmSync(file, { force: true });
  });
});

c('GHAX_RPC_TIMEOUT bounds a call that never answers', async () => {
  const prev = process.env.GHAX_RPC_TIMEOUT;
  process.env.GHAX_RPC_TIMEOUT = '2';
  try {
    const started = Date.now();
    const r = await run(['eval', 'new Promise(() => {})'], { allowFailure: true });
    assert(r.exitCode === 4, `expected exit 4, got ${r.exitCode}: ${r.stderr}`);
    assert(/did not answer `eval` within 2s/.test(r.stderr) && /GHAX_RPC_TIMEOUT/.test(r.stderr), `message: ${r.stderr}`);
    assert(Date.now() - started < 8000, 'should give up near the 2 s limit');
  } finally {
    if (prev === undefined) delete process.env.GHAX_RPC_TIMEOUT; else process.env.GHAX_RPC_TIMEOUT = prev;
  }
  // The daemon is still healthy afterwards.
  await run(['goto', 'https://example.com']);
});

c('-- ends flags, so --trace (or any dash value) can be passed literally (finding 7)', async () => {
  await run(['eval', 'window.__tv = 5; 1']);
  const r = await run(['eval', '--trace', '--', '--window.__tv']);
  assert(r.stdout.trim() === '4', `the value after -- must reach eval intact, got ${r.stdout.trim()}`);
  assert(/^trace: /m.test(r.stderr), `--trace before -- is still the flag: ${r.stderr}`);
  const lead = await run(['--trace', 'eval', '--', '--window.__tv']);
  assert(lead.stdout.trim() === '3' && /^trace: /m.test(lead.stderr), `leading --trace with a terminator: ${lead.stdout} ${lead.stderr}`);
});

c('eval --timeout gives up on a never-settling promise with a clear error', async () => {
  const started = Date.now();
  const r = await run(['eval', 'new Promise(() => {})', '--timeout', '1500'], { allowFailure: true });
  assert(r.exitCode === 4, `expected exit 4, got ${r.exitCode}: ${r.stderr}`);
  assert(/timed out after 1500ms/.test(r.stderr), `message: ${r.stderr}`);
  assert(Date.now() - started < 10000, 'should give up near the --timeout, not the 120 s default');
  const ok = await run(['eval', 'new Promise((r) => setTimeout(() => r(7), 200))', '--timeout', '5000']);
  assert(ok.stdout.trim() === '7', `a slow-but-in-budget eval still returns: ${ok.stdout}`);
  const bad = await run(['eval', '1', '--timeout', 'soon'], { allowFailure: true });
  assert(bad.exitCode === 2 && /positive number/.test(bad.stderr), `bad --timeout: ${bad.exitCode} ${bad.stderr}`);
  const bare = await run(['eval', '1', '--timeout'], { allowFailure: true });
  assert(bare.exitCode === 2 && /positive number/.test(bare.stderr), `bare --timeout: ${bare.exitCode} ${bare.stderr}`);
});

c('eval --no-wait returns at once, runs later, and logs errors to the console', async () => {
  await run(['goto', `data:text/html,${encodeURIComponent('<title>nowait</title><p>x</p>')}`]);
  await run(['eval', 'window.__nw = 0; 1']);
  // Flag before the code: the CLI must not read the code as the flag's value.
  const r = await run(['eval', '--no-wait', 'window.__nw = 41 + 1', '--json']);
  const data = parseJson<{ ok: boolean; dispatched: boolean }>(r.stdout);
  assert(data.ok === true && data.dispatched === true, `no-wait result: ${r.stdout}`);
  await run(['wait', '200']);
  const v = await run(['eval', 'window.__nw']);
  assert(v.stdout.trim() === '42', `the code ran on the timer: ${v.stdout}`);
  await run(['eval', 'throw new Error("nowait-boom")', '--no-wait']);
  await run(['wait', '200']);
  const con = await run(['console', '--json']);
  assert(/nowait-boom/.test(con.stdout), `the throw lands in the console buffer: ${con.stdout.slice(0, 300)}`);
});

c('gesture scroll --on aims the wheel at an element', async () => {
  const html = '<body style="margin:0"><div id="box" style="position:absolute;left:300px;top:100px;width:200px;height:150px;overflow:auto"><div style="height:2000px">tall</div></div><div style="height:3000px"></div></body>';
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const r = await run(['gesture', 'scroll', 'down', '200', '--on', '#box', '--json']);
  const data = parseJson<{ x: number; y: number; on: string }>(r.stdout);
  assert(Math.abs(data.x - 400) < 2 && Math.abs(data.y - 175) < 2, `wheel aimed at the box centre: ${r.stdout}`);
  await run(['wait', '200']);
  const top = await run(['eval', 'document.getElementById("box").scrollTop']);
  assert(Number(top.stdout.trim()) > 0, `the box scrolled, not the page: ${top.stdout}`);
  const page = await run(['eval', 'window.scrollY']);
  assert(Number(page.stdout.trim()) === 0, `the page did not scroll: ${page.stdout}`);
  const miss = await run(['gesture', 'scroll', 'down', '--on', ''], { allowFailure: true });
  assert(miss.exitCode === 2 && /target is empty/.test(miss.stderr), `empty --on: ${miss.exitCode} ${miss.stderr}`);
});

c('snapshot --grep keeps matches, their ancestors and --context lines', async () => {
  const html = '<main><nav><a href="#a">Alpha link</a><a href="#b">Beta link</a></nav><section><h2>Reports</h2><button>Export</button><button>Print</button></section></main>';
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  const all = await run(['snapshot', '-i']);
  const g = await run(['snapshot', '-i', '--grep', 'Beta']);
  assert(/Beta/.test(g.stdout) && !/Alpha/.test(g.stdout), `only Beta matches: ${g.stdout}`);
  assert(g.stdout.trim().split('\n').length < all.stdout.trim().split('\n').length, 'grep output is shorter than the full tree');
  const ctx = await run(['snapshot', '-i', '--grep=Export', '--context', '1']);
  assert(/Export/.test(ctx.stdout) && /Print/.test(ctx.stdout), `--context 1 includes the next line: ${ctx.stdout}`);
  // Refs from the full tree still resolve after a filtered print.
  const ref = /@e\d+/.exec(g.stdout)?.[0];
  assert(ref, `grep output has a ref: ${g.stdout}`);
  await run(['box', ref]);
  const none = await run(['snapshot', '-i', '--grep', 'zzz-no-such']);
  assert(/no snapshot line matches/.test(none.stdout), `a miss says so: ${none.stdout}`);
  const bad = await run(['snapshot', '--grep', '('], { allowFailure: true });
  assert(bad.exitCode === 2 && /not a valid regex/.test(bad.stderr), `bad regex: ${bad.exitCode} ${bad.stderr}`);
});

c('screenshot --path-only prints just the path', async () => {
  const out = path.join(os.tmpdir(), `ghax-pathonly-${Date.now()}.png`);
  const r = await run(['screenshot', '--path-only', '--path', out]);
  assert(r.stdout.trim() === out, `stdout is the bare path: ${JSON.stringify(r.stdout)}`);
  assert(fs.existsSync(out), 'file written');
  const r2 = await run(['screenshot', '--path', out, '--path-only']);
  assert(r2.stdout.trim() === out, `flag order does not matter: ${JSON.stringify(r2.stdout)}`);
  fs.unlinkSync(out);
});

c('an empty click/fill/select/upload target names the cause and exits 2', async () => {
  for (const argv of [['click', ''], ['click'], ['fill', '', 'x'], ['select', ''], ['upload', '', '/tmp/x'], ['box', '']]) {
    const r = await run(argv, { allowFailure: true });
    assert(r.exitCode === 2, `${argv.join(' ')} should exit 2, got ${r.exitCode}: ${r.stderr}`);
    assert(/target is empty — pass an @ref or selector \(unset shell variable\?\)/.test(r.stderr), `${argv.join(' ')}: ${r.stderr}`);
  }
});

// ─── shortcuts ──────────────────────────────────────────────────

async function withShortcutsDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghax-smoke-shortcuts-'));
  const dir = path.join(base, 'shortcuts'); // does not exist yet: save must create it 0700
  const prev = process.env.GHAX_SHORTCUTS_DIR;
  process.env.GHAX_SHORTCUTS_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.GHAX_SHORTCUTS_DIR; else process.env.GHAX_SHORTCUTS_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

c('shortcut save/list/show/rm: modes, vars, at stripped, bad input refused', async () => {
  await withShortcutsDir(async (dir) => {
    const file = path.join(path.dirname(dir), 'rec.json');
    fs.writeFileSync(file, JSON.stringify({ steps: [
      { cmd: 'goto', args: ['${url}'], at: 1 },
      { cmd: 'fill', args: ['#name', '${who}'], at: 2 },
    ] }));
    const save = await run(['shortcut', 'save', 'rename', file, '--var', 'who=grace', '--desc', 'rename the user']);
    assert(/saved shortcut rename .*2 steps, vars: url, who/.test(save.stdout), `save output: ${save.stdout}`);
    const f = path.join(dir, 'rename.json');
    assert((fs.statSync(dir).mode & 0o777) === 0o700, `dir mode ${(fs.statSync(dir).mode & 0o777).toString(8)}`);
    assert((fs.statSync(f).mode & 0o777) === 0o600, `file mode ${(fs.statSync(f).mode & 0o777).toString(8)}`);
    const doc = JSON.parse(fs.readFileSync(f, 'utf-8'));
    assert(doc.version === 1 && doc.description === 'rename the user', `doc: ${JSON.stringify(doc)}`);
    assert(doc.vars.who.default === 'grace' && doc.vars.url.required === true, `vars: ${JSON.stringify(doc.vars)}`);
    assert(doc.steps.every((st: Record<string, unknown>) => !('at' in st)), 'at stripped');
    const list = parseJson<Array<{ name: string; steps: number; vars: string[] }>>((await run(['shortcut', 'list', '--json'])).stdout);
    assert(list.length === 1 && list[0].name === 'rename' && list[0].steps === 2, `list: ${JSON.stringify(list)}`);
    assert(parseJson<{ name: string }>((await run(['shortcut', 'show', 'rename'])).stdout).name === 'rename', 'show');
    // Refused: bad name, a NEVER_RECORD step, a missing file.
    const badName = await run(['shortcut', 'save', '../x', file], { allowFailure: true });
    assert(badName.exitCode === 1 && /invalid name/.test(badName.stderr), `bad name: ${badName.exitCode} ${badName.stderr}`);
    fs.writeFileSync(file, JSON.stringify([{ cmd: 'goto', args: ['x'] }, { cmd: 'auth.export' }]));
    const never = await run(['shortcut', 'save', 'leaky', file], { allowFailure: true });
    assert(never.exitCode === 1 && /refusing to save auth\.export/.test(never.stderr), `never: ${never.exitCode} ${never.stderr}`);
    assert(!fs.existsSync(path.join(dir, 'leaky.json')), 'nothing written for a refused save');
    // @e refs warn but save.
    fs.writeFileSync(file, JSON.stringify([{ cmd: 'click', args: ['@e7'] }]));
    const ref = await run(['shortcut', 'save', 'refs', file]);
    assert(/warning: step 1 \(click\) uses @e7/.test(ref.stderr), `ref warning: ${ref.stderr}`);
    assert(/removed shortcut rename/.test((await run(['shortcut', 'rm', 'rename'])).stdout), 'rm');
    const gone = await run(['shortcut', 'rm', 'rename'], { allowFailure: true });
    assert(gone.exitCode === 1 && /no shortcut named/.test(gone.stderr), `rm twice: ${gone.exitCode} ${gone.stderr}`);
  });
});

c('shortcut save: refuses an existing name, --force replaces it and keeps the positionals', async () => {
  await withShortcutsDir(async (dir) => {
    const file = path.join(path.dirname(dir), 'rec.json');
    fs.writeFileSync(file, JSON.stringify([{ cmd: 'goto', args: ['a'] }]));
    await run(['shortcut', 'save', 'dup', file]);
    const f = path.join(dir, 'dup.json');
    const before = fs.readFileSync(f, 'utf-8');
    fs.writeFileSync(file, JSON.stringify([{ cmd: 'goto', args: ['a'] }, { cmd: 'goto', args: ['b'] }]));
    const refused = await run(['shortcut', 'save', 'dup', file], { allowFailure: true });
    assert(refused.exitCode === 1 && /dup\.json already exists/.test(refused.stderr) && /--force/.test(refused.stderr), `refuse: ${refused.exitCode} ${refused.stderr}`);
    assert(fs.readFileSync(f, 'utf-8') === before, 'a refused save leaves the file alone');
    // --force first and last: neither position may eat <name> or <file>.
    const forced = await run(['shortcut', 'save', '--force', 'dup', file]);
    assert(/replaced shortcut dup \(was 1 steps\)/.test(forced.stdout), `force: ${forced.stdout}`);
    assert(JSON.parse(fs.readFileSync(f, 'utf-8')).steps.length === 2, 'replaced');
    const forcedLast = await run(['shortcut', 'save', 'dup', file, '--force']);
    assert(/replaced shortcut dup \(was 2 steps\)/.test(forcedLast.stdout), `force last: ${forcedLast.stdout}`);
    assert((fs.statSync(f).mode & 0o777) === 0o600, 'mode stays 0600');
  });
});

c('shortcut run: substitutes vars, --var beats the default, $${k} stays literal', async () => {
  await withShortcutsDir(async (dir) => {
    await withExpectPage(async (url) => {
      const file = path.join(path.dirname(dir), 'rec.json');
      fs.writeFileSync(file, JSON.stringify([
        { cmd: 'goto', args: ['${url}'] },
        { cmd: 'fill', args: ['#name', '${who}'] },
        { cmd: 'eval', args: ['document.title = "$${who}"; 1'] },
      ]));
      await run(['shortcut', 'save', 'rename', file, '--var', 'who=grace']);
      const dry = parseJson<{ steps: Array<{ args: string[] }> }>((await run(['shortcut', 'run', 'rename', '--var', `url=${url}`, '--dry-run'])).stdout);
      assert(dry.steps[0].args[0] === url && dry.steps[1].args[1] === 'grace' && dry.steps[2].args[0].includes('"${who}"'), `dry-run: ${JSON.stringify(dry)}`);
      const r1 = await run(['shortcut', 'run', 'rename', '--var', `url=${url}`]);
      assert(/✓ goto/.test(r1.stdout) && /✓ fill/.test(r1.stdout) && /✓ eval/.test(r1.stdout), `run output: ${r1.stdout}`);
      assert(/grace/.test((await run(['eval', "document.getElementById('name').value"])).stdout), 'default var filled');
      assert(/\$\{who\}/.test((await run(['eval', 'document.title'])).stdout), 'escaped placeholder stayed literal');
      await run(['shortcut', 'run', 'rename', '--var', `url=${url}`, '--var', 'who=ada lovelace']);
      assert(/ada lovelace/.test((await run(['eval', "document.getElementById('name').value"])).stdout), '--var overrides the default');
      // --report is written like replay's.
      const rep = path.join(path.dirname(dir), 'report.json');
      await run(['shortcut', 'run', 'rename', '--var', `url=${url}`, '--report', rep]);
      const report = JSON.parse(fs.readFileSync(rep, 'utf-8'));
      assert(JSON.stringify(report).includes('"fill"'), `report: ${JSON.stringify(report).slice(0, 200)}`);
    });
  });
});

c('shortcut run: a missing var exits 1 before any RPC; a failing step exits 4', async () => {
  await withShortcutsDir(async (dir) => {
    const file = path.join(path.dirname(dir), 'rec.json');
    fs.writeFileSync(file, JSON.stringify([{ cmd: 'goto', args: ['${url}'] }, { cmd: 'click', args: ['#nope-${k}'] }]));
    await run(['shortcut', 'save', 'fails', file, '--var', 'k=x']);
    // A state file that points nowhere: any RPC attempt would exit 2 (not attached).
    const prev = process.env.GHAX_STATE_FILE;
    process.env.GHAX_STATE_FILE = path.join(path.dirname(dir), 'no-daemon.json');
    try {
      const missing = await run(['shortcut', 'run', 'fails'], { allowFailure: true });
      assert(missing.exitCode === 1 && /missing value for url/.test(missing.stderr), `missing var: ${missing.exitCode} ${missing.stderr}`);
      const typo = await run(['shortcut', 'run', 'fails', '--var', 'urll=x'], { allowFailure: true });
      assert(typo.exitCode === 1 && /unknown --var urll/.test(typo.stderr), `typo: ${typo.exitCode} ${typo.stderr}`);
    } finally {
      if (prev === undefined) delete process.env.GHAX_STATE_FILE; else process.env.GHAX_STATE_FILE = prev;
    }
    await withExpectPage(async (url) => {
      const bad = await run(['shortcut', 'run', 'fails', '--var', `url=${url}`], { allowFailure: true });
      assert(bad.exitCode === 4 && /✓ goto/.test(bad.stdout) && /✗ click/.test(bad.stderr), `failing step: ${bad.exitCode} ${bad.stdout} ${bad.stderr}`);
    });
  });
});

c('find-el: finds elements by description, refs click at once, ordinals, exit 4, --rerank-cmd', async () => {
  const html = '<title>fe</title><main><h1>Account</h1><label for="em">Email address</label><input id="em" placeholder="you@example.com">'
    + '<input id="q" placeholder="Search products"><button onclick="document.title=\'saved\'">Save</button><button>Save changes</button>'
    + '<button disabled>Submit</button><button>Submit</button><ul><li><button onclick="document.title=\'del1\'">Delete</button></li>'
    + '<li><button onclick="document.title=\'del2\'">Delete</button></li><li><button>Delete</button></li></ul>'
    + '<a href="#x" onclick="document.title=\'linked\'">Save</a></main>';
  await run(['goto', `data:text/html,${encodeURIComponent(html)}`]);
  type M = { ref: string; score: number; role: string; name: string; why: string[]; line: string };
  type R = { query: string; results: M[]; confidence: string };
  const find = async (q: string, ...extra: string[]) => parseJson<R>((await run(['find-el', q, '--json', ...extra])).stdout);

  let r = await find('save changes button');
  assert(r.results[0].name === 'Save changes' && r.results[0].role === 'button' && r.results[0].score === 100, `exact name: ${JSON.stringify(r.results[0])}`);
  assert(/^@e\d+$/.test(r.results[0].ref) && r.confidence === 'high', `ref shape and confidence: ${JSON.stringify(r)}`);

  // Role hint separates a button from a link with the same name; the ref clicks straight away.
  r = await find('save link');
  assert(r.results[0].role === 'link', `link hint: ${JSON.stringify(r.results[0])}`);
  await run(['click', r.results[0].ref]);
  assert((await run(['eval', 'document.title'])).stdout.includes('linked'), 'clicked the link by the ref find-el returned');
  r = await find('save button');
  assert(r.results[0].role === 'button' && r.results[0].name === 'Save', `button hint: ${JSON.stringify(r.results[0])}`);
  await run(['click', r.results[0].ref]);
  assert((await run(['eval', 'document.title'])).stdout.includes('saved'), 'clicked the button by the ref find-el returned');

  // Unnamed-by-label fields: placeholder, and the label text next to the field.
  r = await find('search products field');
  // Chromium exposes a lone placeholder as the accessible name, so the match
  // arrives via `name`. The placeholder-only path (name empty, placeholder in
  // props) is covered in test/find-el-unit.ts.
  assert(r.results[0].role === 'textbox' && r.results[0].name === 'Search products' && r.results[0].score === 100, `placeholder-as-name: ${JSON.stringify(r.results[0])}`);
  r = await find('email address field');
  assert(r.results[0].role === 'textbox' && r.results[0].ref !== (await find('search products field')).results[0].ref, `label text finds the email field: ${JSON.stringify(r.results[0])}`);

  // Disabled: the enabled Submit first, unless the description asks for disabled.
  r = await find('submit button');
  const [first, second] = r.results;
  assert(first.name === 'Submit' && second.name === 'Submit' && first.ref !== second.ref, 'two Submit buttons');
  const dis = await find('disabled submit button');
  assert(dis.results[0].ref === second.ref && first.ref !== second.ref, `disabled hint picks the other one: ${JSON.stringify(dis.results[0])}`);

  // Ordinals: the second Delete button is the one whose click sets title del2.
  r = await find('second delete button');
  await run(['click', r.results[0].ref]);
  assert((await run(['eval', 'document.title'])).stdout.includes('del2'), `ordinal picked the 2nd Delete: ${JSON.stringify(r.results[0])}`);

  // Text output line, --top, and the empty-result exit.
  const txt = await run(['find-el', 'delete button', '--top', '2']);
  const lines = txt.stdout.trim().split('\n');
  assert(lines.length === 2 && /^@e\d+  \d+  button "Delete"  \(/.test(lines[0]), `text lines: ${txt.stdout}`);
  assert(/confidence: /.test(txt.stderr), `confidence on stderr: ${txt.stderr}`);
  const none = await run(['find-el', 'zzzz qqqq'], { allowFailure: true });
  assert(none.exitCode === 4 && /no element matches/.test(none.stderr) && /snapshot -i/.test(none.stderr), `empty result: ${none.exitCode} ${none.stderr}`);
  const bad = await run(['find-el', 'save', '--top', '0'], { allowFailure: true });
  assert(bad.exitCode === 1 || bad.exitCode === 2, `bad --top is a usage error: ${bad.exitCode}`);

  // --rerank-cmd: a command that reverses the candidates it is given.
  const script = path.join(os.tmpdir(), `ghax-rerank-${Date.now()}.mjs`);
  fs.writeFileSync(script, "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(!j.query||!Array.isArray(j.candidates))process.exit(3);console.log(JSON.stringify(j.candidates.map(c=>({ref:c.ref,score:c.score})).reverse()))})");
  try {
    const plain = await find('delete button', '--top', '3');
    const rr = await find('delete button', '--top', '3', '--rerank-cmd', `${process.execPath} ${script}`);
    assert(plain.results.length === 3 && rr.results.length === 3, 'both return --top results');
    assert(rr.results[0].ref !== plain.results[0].ref, `reranker reordered: ${plain.results.map((m) => m.ref)} vs ${rr.results.map((m) => m.ref)}`);
    const failing = await run(['find-el', 'delete button', '--rerank-cmd', 'false'], { allowFailure: true });
    assert(failing.exitCode !== 0 && /rerank-cmd/.test(failing.stderr), `a failing reranker is an error: ${failing.exitCode} ${failing.stderr}`);
  } finally {
    fs.unlinkSync(script);
  }

  // find-el is read-only: a recording must not keep it.
  await run(['record', 'start', 'fe-rec']);
  await run(['find-el', 'save button']);
  const rec = await run(['record', 'stop']);
  assert(!/findEl|find-el/.test(rec.stdout), `find-el is not recorded: ${rec.stdout}`);

  // A cursor:pointer div (not in the ARIA tree) whose text has a line break and
  // quotes: the @c line is JSON-quoted on both transports, so it is still found
  // and its ref clicks.
  const cursorHtml = '<title>cur</title><main><div onclick="document.title=\'cursor-clicked\'" style="cursor:pointer">Open the<br>help "Billing" panel</div></main>';
  await run(['goto', `data:text/html,${encodeURIComponent(cursorHtml)}`]);
  r = await find('billing panel');
  assert(/^@c\d+$/.test(r.results[0]?.ref ?? '') && r.results[0].name.includes('help "Billing" panel') && r.results[0].name.includes('\n'),
    `a quoted multi-line cursor name is found: ${JSON.stringify(r.results[0])}`);
  await run(['click', r.results[0].ref]);
  assert((await run(['eval', 'document.title'])).stdout.includes('cursor-clicked'), 'clicked the @c ref find-el returned');

  // A hung reranker is killed at --rerank-timeout and named in the error.
  const hung = await run(['find-el', 'billing panel', '--rerank-cmd', 'sleep 30', '--rerank-timeout', '1'], { allowFailure: true });
  assert(hung.exitCode !== 0 && /'sleep'.*did not finish within 1s/.test(hung.stderr), `hung reranker: ${hung.exitCode} ${hung.stderr}`);
  const badTimeout = await run(['find-el', 'billing panel', '--rerank-timeout', '0'], { allowFailure: true });
  assert(badTimeout.exitCode === 1 || badTimeout.exitCode === 2, `bad --rerank-timeout is a usage error: ${badTimeout.exitCode}`);
});

// ─── PR D: screenshot --region/--scale, window size ─────────────

/** Width/height from the PNG IHDR (bytes 16-24). */
function pngDims(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/**
 * RGB of the top-left pixel. Row 0 is the one scanline whose filter never
 * reads a neighbour for its first pixel, so the bytes are raw whichever
 * filter the encoder picked.
 */
function pngFirstPixel(file: string): [number, number, number] {
  const b = fs.readFileSync(file);
  const bytesPerPixel = b[25] === 6 ? 4 : 3; // colour type 6 = RGBA, 2 = RGB
  const idat: Buffer[] = [];
  for (let off = 8; off < b.length;) {
    const len = b.readUInt32BE(off);
    if (b.toString('latin1', off + 4, off + 8) === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert(raw.length > 1 + bytesPerPixel, 'PNG has pixel data');
  return [raw[1], raw[2], raw[3]];
}

const REGION_PAGE = `data:text/html,${encodeURIComponent('<!doctype html><title>Region Fixture</title><body style="margin:0;background:#fff"><div style="height:3000px;position:relative"><div style="position:absolute;top:1000px;left:0;width:300px;height:200px;background:#f00"></div></div>')}`;

c('screenshot --region alone zooms to scale 2 and reports the frame', async () => {
  await run(['goto', REGION_PAGE]);
  const out = path.join(os.tmpdir(), `ghax-region-${Date.now()}.png`);
  const r = await run(['screenshot', '--region', '0,0,200,100', '--path', out, '--json']);
  const d = parseJson<{
    path: string; frame: string; scale: number; region: Record<string, number>;
    viewport: { width: number; height: number }; image: { width: number; height: number }; note: string;
  }>(r.stdout);
  assert(d.path === out && d.frame === 'viewport-css-px' && d.scale === 2, `shape: ${r.stdout}`);
  assert(d.region.x0 === 0 && d.region.y1 === 100, `region echoed: ${JSON.stringify(d.region)}`);
  assert(d.viewport.width > 0 && d.viewport.height > 0, 'viewport reported');
  assert(/x = x0 \+ px\/scale/.test(d.note), `coordinate note: ${d.note}`);
  const dims = pngDims(out);
  assert(dims.width === 400 && dims.height === 200, `PNG is ${dims.width}x${dims.height}, want 400x200`);
  assert(d.image.width === dims.width && d.image.height === dims.height, 'reported image size matches the PNG');
  fs.unlinkSync(out);
});

c('screenshot --region --scale overrides the zoom; --scale alone shrinks the viewport', async () => {
  const out = path.join(os.tmpdir(), `ghax-scale-${Date.now()}.png`);
  const r = await run(['screenshot', '--region', '0,0,400,200', '--scale', '0.5', '--path', out, '--json']);
  const d = parseJson<{ scale: number }>(r.stdout);
  const dims = pngDims(out);
  assert(d.scale === 0.5 && dims.width === 200 && dims.height === 100, `scale 0.5: ${d.scale} ${dims.width}x${dims.height}`);
  const v = await run(['screenshot', '--scale', '0.5', '--path', out, '--json']);
  const vd = parseJson<{ region: unknown; viewport: { width: number; height: number } }>(v.stdout);
  const vdims = pngDims(out);
  assert(vd.region === null, 'no region reported for a viewport shot');
  assert(vdims.width === Math.round(vd.viewport.width * 0.5), `viewport at 0.5: ${vdims.width} vs ${vd.viewport.width}`);
  fs.unlinkSync(out);
});

c('screenshot --region stays in the viewport frame after a scroll', async () => {
  await run(['goto', REGION_PAGE]);
  await run(['eval', 'window.scrollTo(0, 900)']);
  const out = path.join(os.tmpdir(), `ghax-region-scroll-${Date.now()}.png`);
  // The red block sits at document y=1000, so viewport y=100 once scrolled to 900.
  await run(['screenshot', '--region', '0,120,40,160', '--scale', '1', '--path', out]);
  const [r1, g1, b1] = pngFirstPixel(out);
  assert(r1 > 200 && g1 < 60 && b1 < 60, `region over the block should be red, got ${r1},${g1},${b1}`);
  await run(['screenshot', '--region', '0,0,40,40', '--scale', '1', '--path', out]);
  const [r2, g2, b2] = pngFirstPixel(out);
  assert(r2 > 240 && g2 > 240 && b2 > 240, `region above the block should be white, got ${r2},${g2},${b2}`);
  fs.unlinkSync(out);
  await run(['eval', 'window.scrollTo(0, 0)']);
});

c('screenshot --region/--scale reject bad combinations with exit 2', async () => {
  const bad: string[][] = [
    ['screenshot', '--region', '0,0,10,10', '--full-page'],
    ['screenshot', '--scale', '0.5', '--full-page'],
    ['screenshot', '#nope', '--region', '0,0,10,10'],
    ['screenshot', '--region', '10,10,5,5'],
    ['screenshot', '--region', '0,0,10'],
    ['screenshot', '--region', '0,0,99999,99999'],
    ['screenshot', '--scale', '2'],
    ['screenshot', '--region', '0,0,10,10', '--scale', '9'],
    ['screenshot', '--region', '0,0,10,10', '--scale', '0'],
  ];
  for (const argv of bad) {
    const r = await run(argv, { allowFailure: true });
    assert(r.exitCode === 2, `${argv.join(' ')} should exit 2, got ${r.exitCode}: ${r.stderr}`);
    assert(/screenshot:/.test(r.stderr), `${argv.join(' ')} names the verb: ${r.stderr}`);
  }
});

c('window size reads the bounds; sets them on a headed browser', async () => {
  const read = parseJson<{
    windowId: number; width: number; height: number; left: number; top: number;
    state: string; transport: string; viewport: { width: number; height: number };
  }>((await run(['window', 'size', '--json'])).stdout);
  for (const k of ['windowId', 'width', 'height', 'left', 'top'] as const) {
    assert(typeof read[k] === 'number', `window size ${k}: ${JSON.stringify(read)}`);
  }
  assert(typeof read.state === 'string' && read.transport === 'cdp', `state/transport: ${JSON.stringify(read)}`);
  assert(read.viewport.width > 0 && read.viewport.height > 0, 'inner size read from the page');
  const ua = (await run(['eval', 'navigator.userAgent'])).stdout;
  if (/Headless/i.test(ua)) {
    console.log('  (skipped the set half: a headless browser does not apply window bounds)');
    return;
  }
  const set = parseJson<{ width: number; height: number; viewport: { width: number } }>(
    (await run(['window', 'size', '900x700', '--json'])).stdout,
  );
  assert(set.width === 900 && set.height === 700, `set bounds: ${JSON.stringify(set)}`);
  assert(set.viewport.width <= 900, `inner width follows the window: ${JSON.stringify(set)}`);
  await run(['window', 'size', `${read.width}x${read.height}`]);
});

c('window size rejects a bad spec (exit 2) and an unknown subcommand (usage, exit 1)', async () => {
  for (const argv of [['window', 'size', '900'], ['window', 'size', '0x0'], ['window', 'size', 'big']]) {
    const r = await run(argv, { allowFailure: true });
    assert(r.exitCode === 2, `${argv.join(' ')} should exit 2, got ${r.exitCode}: ${r.stderr}`);
  }
  for (const argv of [['window'], ['window', 'move']]) {
    const r = await run(argv, { allowFailure: true });
    assert(r.exitCode === 1 && /Usage: ghax window size/.test(r.stderr), `${argv.join(' ')}: ${r.exitCode} ${r.stderr}`);
  }
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
  // Default: stop at the first failure. GHAX_SMOKE_CONTINUE=1 keeps going,
  // then prints every failure and exits 1 if any check failed.
  const keepGoing = process.env.GHAX_SMOKE_CONTINUE === '1';
  throwOnFail = keepGoing;
  let passed = 0;
  const failures: Array<{ name: string; msg: string }> = [];
  for (const { name, fn } of checks) {
    step(name);
    try {
      await fn();
      passed++;
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (!keepGoing) fail(`FAIL ${name}: ${msg}`);
      console.error(`\n✗ FAIL ${name}: ${msg}\n`);
      failures.push({ name, msg });
    }
  }
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  if (failures.length > 0) {
    console.error(`\n✗ ${passed}/${checks.length} checks passed, ${failures.length} failed in ${secs}s`);
    for (const f of failures) console.error(`  - ${f.name}`);
    process.exit(1);
  }
  console.log(`\n✓ ${passed}/${checks.length} checks passed in ${secs}s`);
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
