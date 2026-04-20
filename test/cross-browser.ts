/**
 * Cross-browser smoke runner.
 *
 * Iterates over every Chromium-family browser detected on this machine,
 * launches each one headless in an isolated scratch profile, and runs
 * test/smoke.ts against it. Per-browser results are tabulated at the end.
 *
 * Run:
 *   bun run test/cross-browser.ts
 *
 * Notes:
 *   - Requires `bun run build` beforehand so dist/ghax exists.
 *   - Uses GHAX_STATE_FILE + an explicit --port to keep each daemon in
 *     its own lane. That way we don't collide with whatever the user has
 *     running on :9222.
 *   - Skips any browser that fails to launch (e.g. Arc, which has no
 *     CDP support) and reports it.
 *   - A browser that's already running with CDP on the default port is
 *     still exercised fresh via --launch --headless, so results reflect
 *     the launch path, not the user's live session.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

// Browser detection used to live in src/browser-launch.ts (Bun CLI). With the
// Rust CLI rewrite that file is gone, so the test inlines a minimal macOS-only
// detection. Cross-browser CI on Linux/Windows can grow this when needed.
type BrowserKind = 'edge' | 'chrome' | 'chromium' | 'brave' | 'arc';
interface BrowserInfo { kind: BrowserKind; label: string; path: string }

function detectBrowsers(): BrowserInfo[] {
  const candidates: BrowserInfo[] = [
    { kind: 'edge',    label: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { kind: 'chrome',  label: 'Google Chrome',  path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { kind: 'brave',   label: 'Brave',          path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    { kind: 'arc',     label: 'Arc',            path: '/Applications/Arc.app/Contents/MacOS/Arc' },
  ];
  return candidates.filter((b) => fs.existsSync(b.path));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ghax = process.env.GHAX_BIN ?? path.join(root, 'target', 'release', 'ghax');
const smoke = path.join(root, 'test', 'smoke.ts');

if (!fs.existsSync(ghax)) {
  console.error(`ghax binary missing at ${ghax} — run 'bun run build:rust' first (or set GHAX_BIN)`);
  process.exit(1);
}

interface Result {
  kind: BrowserKind;
  label: string;
  ok: boolean;
  checks?: number;
  durationS?: number;
  error?: string;
}

async function runCmd(cmd: string[], env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [prog, ...args] = cmd;
  const proc = spawn(prog, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
  proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
  const exitCode = await new Promise<number>((resolve) => {
    proc.on('exit', (code) => resolve(code ?? 0));
  });
  return { stdout, stderr, exitCode };
}

async function runOne(kind: BrowserKind, label: string, port: number): Promise<Result> {
  const stateFile = `/tmp/ghax-cross-${kind}-${Date.now()}.json`;
  const env = { GHAX_STATE_FILE: stateFile };

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`▶ ${label} (${kind}) — headless on :${port}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Fresh scratch profile per run so no stale state bleeds across browsers.
  const profileDir = `/tmp/ghax-cross-profile-${kind}-${Date.now()}`;

  const attach = await runCmd(
    [ghax, 'attach', '--launch', '--headless', '--browser', kind, '--port', String(port), '--data-dir', profileDir],
    env,
  );
  if (attach.exitCode !== 0) {
    return {
      kind,
      label,
      ok: false,
      error: `attach failed (exit ${attach.exitCode}): ${attach.stderr.slice(-300) || attach.stdout.slice(-300)}`,
    };
  }
  console.log(attach.stdout.trim());

  const start = Date.now();
  const smokeRes = await runCmd(['tsx', smoke], env);
  const durationS = (Date.now() - start) / 1000;

  // Smoke's final check is `detach` so the daemon is gone by now. Best-effort
  // cleanup of the scratch browser process + profile dir.
  try {
    spawnSync('pkill', ['-f', profileDir], { stdio: 'ignore' });
  } catch {
    // ignore
  }
  try {
    fs.rmSync(stateFile, { force: true });
    // Leave profile dir to avoid racing with the killed browser flushing it;
    // /tmp is cleaned on reboot.
  } catch {
    // ignore
  }

  if (smokeRes.exitCode !== 0) {
    return {
      kind,
      label,
      ok: false,
      durationS,
      error: smokeRes.stderr.slice(-500) || smokeRes.stdout.slice(-500),
    };
  }
  const m = smokeRes.stdout.match(/✓ (\d+)\/(\d+) checks passed/);
  const checks = m ? Number(m[1]) : 0;
  console.log(smokeRes.stdout.split('\n').slice(-3).join('\n'));
  return { kind, label, ok: true, checks, durationS };
}

(async () => {
  const browsers = detectBrowsers();
  if (browsers.length === 0) {
    console.error('No supported browsers installed.');
    process.exit(1);
  }

  // Arc (when installed) doesn't expose CDP via the stock macOS binary — it
  // has its own launcher that strips the flag. Filter it out so the runner
  // doesn't spend 10s timing out on it.
  const chromiumFamily = browsers.filter((b) => b.kind !== 'arc');
  const arcSkipped = browsers.some((b) => b.kind === 'arc');

  console.log(`Detected ${chromiumFamily.length} Chromium-family browser(s):`);
  for (const b of chromiumFamily) console.log(`  • ${b.label} (${b.kind})`);
  if (arcSkipped) console.log(`  (skipping Arc — no CDP support)`);

  const results: Result[] = [];
  // Each browser gets its own port so partial failures don't block the next.
  let port = 9240;
  for (const b of chromiumFamily) {
    results.push(await runOne(b.kind, b.label, port++));
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`CROSS-BROWSER SUMMARY`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  const lines: string[] = [];
  for (const r of results) {
    if (r.ok) {
      lines.push(`  ✓ ${r.label.padEnd(20)} ${r.checks} checks  ${r.durationS?.toFixed(1)}s`);
    } else {
      lines.push(`  ✗ ${r.label.padEnd(20)} ${r.error?.split('\n')[0].slice(0, 80) ?? 'unknown error'}`);
    }
  }
  console.log(lines.join('\n'));

  const allOk = results.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
})();
