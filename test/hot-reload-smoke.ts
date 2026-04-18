/**
 * Hot-reload smoke test — fully scripted, isolated from the user's real
 * Edge session.
 *
 * Flow:
 *   1. Copy test/fixtures/test-extension/ into a scratch directory so we
 *      can mutate it without touching the repo.
 *   2. Launch a fresh Chromium-family browser on an unused CDP port, with
 *      the scratch extension loaded via --load-extension.
 *   3. Confirm `ghax ext list` sees the extension and its SW.
 *   4. Read manifest version through the SW — record as v1.
 *   5. Bump `version` in the scratch manifest + content.js.
 *   6. `ghax ext hot-reload <id>` — read the reported SW version.
 *   7. Assert the SW version changed from v1.
 *   8. Detach; confirm state file is cleaned up.
 *
 * Uses GHAX_STATE_FILE to isolate from the user's live daemon, and a
 * non-default CDP port (9334) to avoid colliding with a running Edge on
 * 9222.
 *
 * Exit 0 on pass, non-zero on first failure.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ghax = path.join(root, 'dist', 'ghax');
const fixture = path.join(here, 'fixtures', 'test-extension');
const CDP_PORT = 9334;

if (!fs.existsSync(ghax)) fail(`dist/ghax missing — run 'bun run build' first`);
if (!fs.existsSync(fixture)) fail(`fixture missing at ${fixture}`);

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghax-hotreload-'));
const scratchExt = path.join(scratchDir, 'test-extension');
const scratchProfile = path.join(scratchDir, 'profile');
const stateFile = path.join(scratchDir, 'ghax.json');

// Copy fixture into scratch so we can mutate it without touching the repo.
copyDir(fixture, scratchExt);
fs.mkdirSync(scratchProfile, { recursive: true });
console.log(`scratch extension at ${scratchExt}`);
console.log(`scratch profile at ${scratchProfile}`);

async function run(
  args: string[],
  opts: { allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([ghax, ...args], {
    env: { ...process.env, GHAX_STATE_FILE: stateFile },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const res = { stdout, stderr, exitCode };
  if (exitCode !== 0 && !opts.allowFailure) {
    fail(`ghax ${args.join(' ')} exited ${exitCode}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
  }
  return res;
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  // Best-effort cleanup.
  cleanup().finally(() => process.exit(1));
  throw new Error(msg); // for the type checker
}

async function cleanup() {
  try {
    await run(['detach'], { allowFailure: true });
  } catch {
    // best-effort
  }
  // Kill the launched Edge — ghax detach shuts the daemon but deliberately
  // leaves the browser running. We targeted the scratch profile dir on launch,
  // so pkill on that path is precise and non-destructive to the user's real Edge.
  try {
    Bun.spawnSync(['pkill', '-f', `user-data-dir=${scratchProfile}`], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
  } catch {
    // pkill not installed or no matches — best-effort
  }
  // Give the OS a moment to release file handles.
  await new Promise((r) => setTimeout(r, 200));
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function bumpVersion(version: string): string {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  parts[parts.length - 1]++;
  return parts.join('.');
}

function parseJson<T = unknown>(out: string): T {
  try {
    return JSON.parse(out) as T;
  } catch {
    fail(`expected JSON, got: ${out.slice(0, 200)}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────

try {
  console.log('• launching scratch browser with fixture extension');
  const attach = await run([
    'attach',
    '--launch',
    '--browser', 'edge',
    '--port', String(CDP_PORT),
    '--load-extension', scratchExt,
    '--data-dir', scratchProfile,
  ]);
  assert(/attached/.test(attach.stdout), `attach failed: ${attach.stdout}`);

  console.log('• finding the test extension');
  // Brief pause so the extension has time to register its SW + content script targets.
  await new Promise((r) => setTimeout(r, 2000));
  const list = parseJson<Array<{ id: string; name: string; targets: Array<{ type: string; url: string }> }>>(
    (await run(['ext', 'list', '--json'])).stdout,
  );
  // --load-extension assigns an ID derived from the path — unstable across
  // runs. Match by any target URL containing the extension's manifest or
  // background file path. The `name` field may also be blank if no `page`
  // target exists yet.
  const testExt = list.find((e) =>
    e.name === 'ghax test extension' ||
    e.targets.some((t) => t.url.includes('background.js') && t.url.includes('chrome-extension://')),
  );
  if (!testExt) {
    console.error('debug: extensions seen:');
    for (const e of list) {
      console.error(`  - ${e.id} (${e.name || '<no-name>'}) ${e.targets.length} targets`);
      for (const t of e.targets) console.error(`      ${t.type} ${t.url}`);
    }
    fail(`ghax test extension not found in ext list (${list.length} extensions seen)`);
  }
  assert(
    testExt.targets.some((t) => t.type === 'service_worker'),
    `test extension has no service_worker target`,
  );
  const extId = testExt.id;
  console.log(`  id: ${extId}`);

  console.log('• reading SW version via ext sw eval');
  const v1 = (await run(['ext', 'sw', extId, 'eval', 'chrome.runtime.getManifest().version'])).stdout.trim();
  assert(v1.length > 0, 'initial SW version empty');
  console.log(`  v1 = ${v1}`);

  console.log('• opening example.com so content script injects');
  await run(['goto', 'https://example.com']);
  // Let the content script finish injecting its banner.
  await new Promise((r) => setTimeout(r, 1500));
  const banner1 = (await run(['eval', 'document.getElementById("ghax-test-banner")?.textContent || ""'])).stdout.trim();
  assert(
    banner1.includes(`v${v1}`),
    `expected banner with v${v1}, got "${banner1}"`,
  );
  console.log(`  banner: ${banner1}`);

  console.log('• bumping manifest + content.js version');
  const manifestPath = path.join(scratchExt, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { version: string };
  const oldVersion = manifest.version;
  const newVersion = bumpVersion(oldVersion);
  manifest.version = newVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  // content.js reads the manifest at runtime via chrome.runtime.getManifest(),
  // so we don't need to edit that file — the version string it injects updates
  // automatically on re-inject.
  console.log(`  ${oldVersion} → ${newVersion}`);

  console.log('• running ghax ext hot-reload (this is the whole point)');
  const hotReload = await run(['ext', 'hot-reload', extId, '--wait', '4', '--verbose', '--json']);
  const report = parseJson<{
    ok: boolean;
    swVersion: string;
    previousVersion: string;
    reinjected: number;
    failed: number;
    durationMs: number;
  }>(hotReload.stdout);
  console.log(`  report: ${JSON.stringify(report, null, 2).replace(/\n/g, '\n  ')}`);
  assert(report.ok, `hot-reload reported not ok: ${JSON.stringify(report)}`);
  assert(report.swVersion === newVersion, `SW version expected ${newVersion}, got ${report.swVersion}`);
  assert(report.previousVersion === oldVersion, `previous version expected ${oldVersion}, got ${report.previousVersion}`);
  assert(report.failed === 0, `hot-reload had ${report.failed} failed tab(s)`);
  assert(report.reinjected >= 1, `expected >=1 tab re-injected (example.com is open), got ${report.reinjected}`);

  console.log('• confirming banner text reflects new version post-inject');
  const banner2 = (await run(['eval', 'document.getElementById("ghax-test-banner")?.textContent || ""'])).stdout.trim();
  assert(
    banner2.includes(`v${newVersion}`),
    `expected banner to carry v${newVersion} after re-inject, got "${banner2}"`,
  );
  console.log(`  banner: ${banner2}`);

  console.log('• confirming SW eval now reports bumped version');
  const v2 = (await run(['ext', 'sw', extId, 'eval', 'chrome.runtime.getManifest().version'])).stdout.trim();
  assert(v2 === newVersion, `post-reload SW version expected ${newVersion}, got ${v2}`);

  console.log('• detaching');
  const detach = await run(['detach']);
  assert(/detached/.test(detach.stdout), `detach failed: ${detach.stdout}`);
  assert(!fs.existsSync(stateFile), `state file lingered after detach: ${stateFile}`);

  console.log(`\n✓ hot-reload smoke passed (${oldVersion} → ${newVersion}, ${report.durationMs}ms reload)`);
  await cleanup();
  process.exit(0);
} catch (err: any) {
  await cleanup();
  console.error('hot-reload smoke crashed:', err?.message || err);
  process.exit(1);
}
