/**
 * ghax CLI — argv → daemon RPC.
 *
 * Flow:
 *   1. Read .ghax/ghax.json for daemon port.
 *   2. If daemon is not healthy, either:
 *        - on `ghax attach`: launch it.
 *        - on anything else: exit 2 with an "attach first" message.
 *   3. POST to /rpc.
 *   4. Render response as text (default) or JSON (--json).
 *
 * Only a few commands need special handling (attach/status/detach/restart).
 * The rest are a flat dispatch to daemon handler names.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveConfig, readState, clearState, ensureStateDir, isProcessAlive, type DaemonState } from './config';
import { probeCdp, detectBrowsers, launchBrowser, launchInstructions, type BrowserKind, type CdpEndpoint } from './browser-launch';

const EXIT = {
  OK: 0,
  USAGE: 1,
  NOT_ATTACHED: 2,
  TARGET_NOT_FOUND: 3,
  CDP_ERROR: 4,
  DAEMON_FAILED: 10,
} as const;

const cfg = resolveConfig();

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a.startsWith('-') && a.length === 2) {
      // Short flag, always boolean here; snapshot handles its own short flags.
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function rpc<T = unknown>(port: number, cmd: string, args: unknown[] = [], opts: Record<string, unknown> = {}): Promise<T> {
  const resp = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args, opts }),
  });
  const body = (await resp.json()) as { ok: boolean; data?: T; error?: string };
  if (!body.ok) {
    throw new Error(body.error || `RPC ${cmd} failed`);
  }
  return body.data as T;
}

async function daemonHealthy(state: DaemonState | null): Promise<boolean> {
  if (!state) return false;
  if (!isProcessAlive(state.pid)) return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${state.port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: boolean };
    return Boolean(body.ok);
  } catch {
    return false;
  }
}

/**
 * The daemon must run under Node (Playwright's connectOverCDP hangs under Bun
 * as of Bun 1.3.x). We build `dist/ghax-daemon.mjs` and spawn it with `node`.
 */
function resolveDaemonBundle(): string {
  // Dev: look for dist/ghax-daemon.mjs relative to the cli source.
  const dir = import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname);
  if (!dir.includes('$bunfs')) {
    const devBundle = path.resolve(dir, '..', 'dist', 'ghax-daemon.mjs');
    if (fs.existsSync(devBundle)) return devBundle;
  }
  // Compiled CLI: dist/ghax-daemon.mjs sits beside dist/ghax.
  const adjacent = path.resolve(path.dirname(process.execPath), 'ghax-daemon.mjs');
  if (fs.existsSync(adjacent)) return adjacent;
  throw new Error('Cannot locate dist/ghax-daemon.mjs. Run `bun run build` first.');
}

async function spawnDaemon(endpoint: CdpEndpoint, kind: BrowserKind): Promise<DaemonState> {
  ensureStateDir(cfg);
  const bundle = resolveDaemonBundle();
  const cmd = ['node', '--enable-source-maps', bundle];

  const proc = Bun.spawn(cmd, {
    env: {
      ...process.env,
      GHAX_STATE_FILE: cfg.stateFile,
      GHAX_CDP_HTTP_URL: endpoint.httpUrl,
      GHAX_CDP_BROWSER_URL: endpoint.browserUrl,
      GHAX_BROWSER_KIND: kind,
    },
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  proc.unref();

  // Poll for state file + health.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = readState(cfg);
    if (state && state.pid === proc.pid && (await daemonHealthy(state))) {
      return state;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Daemon did not become healthy within 15s. Check .ghax/ghax-daemon.log.');
}

// ─── Special commands ──────────────────────────────────────────

async function cmdAttach(parsed: ParsedArgs): Promise<number> {
  const port = parsed.flags.port ? Number(parsed.flags.port) : 9222;
  const browserOpt = (parsed.flags.browser as string | undefined) as BrowserKind | undefined;
  const launch = Boolean(parsed.flags.launch);

  // If already attached, short-circuit.
  const existing = readState(cfg);
  if (existing && (await daemonHealthy(existing))) {
    console.log(`already attached — pid ${existing.pid}, port ${existing.port}, browser ${existing.browserKind}`);
    return EXIT.OK;
  }
  if (existing) {
    // Stale state file.
    clearState(cfg);
  }

  let endpoint = await probeCdp(port);
  let kind: BrowserKind = browserOpt ?? 'edge';

  if (!endpoint) {
    const browsers = detectBrowsers();
    if (!launch) {
      console.error(launchInstructions(port, browsers));
      return EXIT.NOT_ATTACHED;
    }
    if (browsers.length === 0) {
      console.error('No supported browsers installed. Expected Edge, Chrome, Chromium, Brave, or Arc.');
      return EXIT.NOT_ATTACHED;
    }
    const target = browserOpt
      ? browsers.find((b) => b.kind === browserOpt)
      : (browsers.find((b) => b.kind === 'edge') ?? browsers[0]);
    if (!target) {
      console.error(`Browser ${browserOpt} not found. Installed: ${browsers.map((b) => b.kind).join(', ')}`);
      return EXIT.NOT_ATTACHED;
    }
    console.log(`launching ${target.label} with CDP on :${port} (scratch profile in ~/.ghax/${target.kind}-profile)`);
    const launched = await launchBrowser(target, { port });
    endpoint = launched.endpoint;
    kind = target.kind;
  } else {
    kind = browserOpt ?? inferKindFromVersion(endpoint.version['User-Agent']);
  }

  const state = await spawnDaemon(endpoint, kind);
  console.log(`attached — pid ${state.pid}, port ${state.port}, browser ${state.browserKind}`);
  return EXIT.OK;
}

function inferKindFromVersion(userAgent: string): BrowserKind {
  const ua = userAgent.toLowerCase();
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('chrome/')) return 'chrome';
  return 'chromium';
}

async function cmdDetach(): Promise<number> {
  const state = readState(cfg);
  if (!state) {
    console.log('not attached');
    return EXIT.OK;
  }
  if (!isProcessAlive(state.pid)) {
    clearState(cfg);
    console.log('stale state file cleared');
    return EXIT.OK;
  }
  try {
    await fetch(`http://127.0.0.1:${state.port}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Fall through to kill.
  }
  // Give it a moment.
  for (let i = 0; i < 20; i++) {
    if (!isProcessAlive(state.pid)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  clearState(cfg);
  console.log('detached');
  return EXIT.OK;
}

async function cmdStatus(parsed: ParsedArgs): Promise<number> {
  const state = readState(cfg);
  if (!state || !(await daemonHealthy(state))) {
    console.log('not attached');
    return EXIT.NOT_ATTACHED;
  }
  const data = (await rpc(state.port, 'status')) as Record<string, unknown>;
  if (parsed.flags.json) {
    console.log(JSON.stringify({ ...state, ...data }, null, 2));
  } else {
    const upMin = Math.floor(Number(data.uptimeMs ?? 0) / 60000);
    console.log(`attached    ${state.browserKind} (${state.browserUrl.split('/devtools/')[0]})`);
    console.log(`daemon      pid ${state.pid}, port ${state.port}, up ${upMin}m`);
    console.log(`tabs        ${data.tabCount}`);
    console.log(`targets     ${data.targetCount}`);
    console.log(`extensions  ${data.extensionCount}`);
    console.log(`cwd         ${state.cwd}`);
  }
  return EXIT.OK;
}

async function cmdRestart(parsed: ParsedArgs): Promise<number> {
  await cmdDetach();
  return cmdAttach(parsed);
}

// ─── Generic RPC commands ──────────────────────────────────────

async function withDaemon<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const state = readState(cfg);
  if (!state || !(await daemonHealthy(state))) {
    throw Object.assign(new Error('not attached — run `ghax attach` first'), { exit: EXIT.NOT_ATTACHED });
  }
  return fn(state.port);
}

function printResult(data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data === null || data === undefined) return;
  if (typeof data === 'string') {
    console.log(data);
    return;
  }
  if (typeof data === 'number' || typeof data === 'boolean') {
    console.log(String(data));
    return;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') console.log(item);
      else console.log(JSON.stringify(item));
    }
    return;
  }
  // Special case: snapshot returns {text, count, annotatedPath?}
  const obj = data as Record<string, unknown>;
  if (typeof obj.text === 'string') {
    console.log(obj.text);
    if (typeof obj.annotatedPath === 'string') {
      console.error(`\n(annotated screenshot → ${obj.annotatedPath})`);
    }
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

type Dispatch = (parsed: ParsedArgs) => Promise<number>;

function makeSimple(cmd: string, map?: (parsed: ParsedArgs) => { args: unknown[]; opts: Record<string, unknown> }): Dispatch {
  return async (parsed) => {
    const payload = map ? map(parsed) : { args: parsed.positional, opts: flagsToOpts(parsed.flags) };
    return withDaemon(async (port) => {
      const data = await rpc(port, cmd, payload.args, payload.opts);
      printResult(data, Boolean(parsed.flags.json));
      return EXIT.OK;
    });
  };
}

function flagsToOpts(flags: Record<string, string | boolean>): Record<string, unknown> {
  // Strip presentation flags (they don't go to the daemon).
  const { json, ...rest } = flags;
  return rest;
}

// ─── Snapshot flag expansion ───────────────────────────────────

const SNAPSHOT_SHORT: Record<string, string> = {
  i: 'interactive',
  c: 'compact',
  d: 'depth',
  s: 'selector',
  C: 'cursorInteractive',
  a: 'annotate',
  o: 'output',
};

function expandSnapshotFlags(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else flags[key] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const short = a.slice(1);
      const long = SNAPSHOT_SHORT[short] ?? short;
      if (long === 'depth' || long === 'selector' || long === 'output') {
        flags[long] = argv[++i] ?? '';
      } else {
        flags[long] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ─── Main dispatcher ───────────────────────────────────────────

const HELP = `ghax — attach to your real Chrome/Edge via CDP and drive it.

Connection:
  attach [--port 9222] [--browser edge|chrome] [--launch]
  status [--json]
  detach
  restart

Tab:
  tabs
  tab <id>
  goto <url>
  back | forward | reload
  eval <js>
  text
  html [<selector>]
  screenshot [<@ref|selector>] [--path <p>] [--fullPage]

Snapshot & interact:
  snapshot [-i] [-c] [-d <N>] [-s <sel>] [-C] [-a] [-o <path>]
  click <@ref|selector>
  fill <@ref|selector> <value>
  press <key>
  type <text>
  wait <selector|ms|--networkidle|--load>
  viewport <WxH>
  responsive [prefix] [--fullPage]
  diff <url1> <url2>

Logs:
  console [--errors] [--last N]
  network [--pattern <re>] [--last N]
  cookies

Extensions (MV3):
  ext list
  ext targets <ext-id>
  ext reload <ext-id>
  ext sw <ext-id> eval <js>
  ext panel <ext-id> eval <js>
  ext storage <ext-id> [local|session|sync] [get|set|clear] [key] [value]

Real user gestures:
  gesture click <x,y>
  gesture key <key>

Batch / recording:
  chain < steps.json          (JSON array of {cmd, args?, opts?})
  record start [name]
  record stop
  record status
  replay <file>

Add --json for machine-readable output on any command.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(HELP);
    return EXIT.OK;
  }

  const verb = argv[0];
  const rest = argv.slice(1);

  try {
    switch (verb) {
      case 'attach':
        return await cmdAttach(parseArgs(rest));
      case 'detach':
        return await cmdDetach();
      case 'status':
        return await cmdStatus(parseArgs(rest));
      case 'restart':
        return await cmdRestart(parseArgs(rest));

      case 'snapshot':
        return await makeSimple('snapshot', (parsed) => ({ args: [], opts: flagsToOpts(parsed.flags) }))(expandSnapshotFlags(rest));

      case 'tabs':
      case 'back':
      case 'forward':
      case 'reload':
      case 'text':
      case 'cookies':
        return await makeSimple(verb)(parseArgs(rest));

      case 'tab':
      case 'goto':
      case 'eval':
      case 'click':
      case 'press':
      case 'type':
      case 'html':
      case 'screenshot':
      case 'wait':
      case 'viewport':
      case 'responsive':
      case 'diff':
        return await makeSimple(verb)(parseArgs(rest));

      case 'fill': {
        const parsed = parseArgs(rest);
        if (parsed.positional.length < 2) {
          console.error('Usage: ghax fill <@ref|selector> <value>');
          return EXIT.USAGE;
        }
        return await withDaemon(async (port) => {
          const data = await rpc(port, 'fill', parsed.positional, flagsToOpts(parsed.flags));
          printResult(data, Boolean(parsed.flags.json));
          return EXIT.OK;
        });
      }

      case 'console':
      case 'network':
        return await makeSimple(verb)(parseArgs(rest));

      case 'ext':
        return await dispatchExt(rest);

      case 'gesture':
        return await dispatchGesture(rest);

      case 'chain':
        return await cmdChain(parseArgs(rest));

      case 'record':
        return await dispatchRecord(rest);

      case 'replay':
        return await cmdReplay(parseArgs(rest));

      default:
        console.error(`Unknown command: ${verb}\n\nRun 'ghax --help' for usage.`);
        return EXIT.USAGE;
    }
  } catch (err: any) {
    if (typeof err?.exit === 'number') {
      console.error(`ghax: ${err.message}`);
      return err.exit;
    }
    console.error(`ghax: ${err.message || err}`);
    return EXIT.CDP_ERROR;
  }
}

async function dispatchExt(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (!sub) {
    console.error('Usage: ghax ext <list|targets|reload|sw|panel|storage> [...]');
    return EXIT.USAGE;
  }
  const parsed = parseArgs(rest.slice(1));

  switch (sub) {
    case 'list':
      return makeSimple('ext.list')(parsed);
    case 'targets':
      return makeSimple('ext.targets')(parsed);
    case 'reload':
      return makeSimple('ext.reload')(parsed);
    case 'sw': {
      // ghax ext sw <ext-id> <op> [...]
      const extId = parsed.positional[0];
      const op = parsed.positional[1];
      if (!extId || !op) {
        console.error('Usage: ghax ext sw <ext-id> eval <js>');
        return EXIT.USAGE;
      }
      if (op === 'eval') {
        const js = parsed.positional.slice(2).join(' ');
        return withDaemon(async (port) => {
          const data = await rpc(port, 'ext.sw.eval', [extId, js], flagsToOpts(parsed.flags));
          printResult(data, Boolean(parsed.flags.json));
          return EXIT.OK;
        });
      }
      console.error(`Unknown ext sw op: ${op}`);
      return EXIT.USAGE;
    }
    case 'panel': {
      const extId = parsed.positional[0];
      const op = parsed.positional[1];
      if (!extId || !op) {
        console.error('Usage: ghax ext panel <ext-id> eval <js>');
        return EXIT.USAGE;
      }
      if (op === 'eval') {
        const js = parsed.positional.slice(2).join(' ');
        return withDaemon(async (port) => {
          const data = await rpc(port, 'ext.panel.eval', [extId, js], flagsToOpts(parsed.flags));
          printResult(data, Boolean(parsed.flags.json));
          return EXIT.OK;
        });
      }
      console.error(`Unknown ext panel op: ${op}`);
      return EXIT.USAGE;
    }
    case 'storage':
      // ghax ext storage <ext-id> <area> <op> [key] [value]
      return withDaemon(async (port) => {
        const data = await rpc(port, 'ext.storage', parsed.positional, flagsToOpts(parsed.flags));
        printResult(data, Boolean(parsed.flags.json));
        return EXIT.OK;
      });
    default:
      console.error(`Unknown ext sub: ${sub}`);
      return EXIT.USAGE;
  }
}

interface ChainStep {
  cmd: string;
  args?: unknown[];
  opts?: Record<string, unknown>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

async function cmdChain(parsed: ParsedArgs): Promise<number> {
  const stopOnError = Boolean(parsed.flags.stopOnError ?? true);
  const body = await readStdin();
  if (!body.trim()) {
    console.error('ghax chain: expected JSON on stdin');
    return EXIT.USAGE;
  }
  let steps: ChainStep[];
  try {
    const parsedBody = JSON.parse(body);
    steps = Array.isArray(parsedBody) ? (parsedBody as ChainStep[]) : [parsedBody as ChainStep];
  } catch (err: any) {
    console.error(`ghax chain: invalid JSON — ${err.message}`);
    return EXIT.USAGE;
  }

  return withDaemon(async (port) => {
    const results: Array<{ cmd: string; ok: boolean; data?: unknown; error?: string }> = [];
    for (const step of steps) {
      if (!step.cmd) {
        results.push({ cmd: '<missing>', ok: false, error: 'step missing cmd' });
        if (stopOnError) break;
        continue;
      }
      try {
        const data = await rpc(port, step.cmd, step.args ?? [], step.opts ?? {});
        results.push({ cmd: step.cmd, ok: true, data });
      } catch (err: any) {
        results.push({ cmd: step.cmd, ok: false, error: err.message });
        if (stopOnError) break;
      }
    }
    printResult(results, Boolean(parsed.flags.json) || true);
    return results.some((r) => !r.ok) ? EXIT.CDP_ERROR : EXIT.OK;
  });
}

async function dispatchRecord(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (!sub) {
    console.error('Usage: ghax record <start|stop> [name]');
    return EXIT.USAGE;
  }
  const parsed = parseArgs(rest.slice(1));
  switch (sub) {
    case 'start':
      return withDaemon(async (port) => {
        const name = parsed.positional[0] ?? `rec-${Date.now()}`;
        await rpc(port, 'record.start', [name]);
        console.log(`recording → ${name}`);
        return EXIT.OK;
      });
    case 'stop':
      return withDaemon(async (port) => {
        const data = (await rpc(port, 'record.stop')) as { name: string; path: string; steps: number };
        console.log(`saved ${data.steps} steps → ${data.path}`);
        return EXIT.OK;
      });
    case 'status':
      return withDaemon(async (port) => {
        const data = await rpc(port, 'record.status');
        printResult(data, Boolean(parsed.flags.json));
        return EXIT.OK;
      });
    default:
      console.error(`Unknown record sub: ${sub}`);
      return EXIT.USAGE;
  }
}

async function cmdReplay(parsed: ParsedArgs): Promise<number> {
  const file = parsed.positional[0];
  if (!file) {
    console.error('Usage: ghax replay <file>');
    return EXIT.USAGE;
  }
  const body = fs.readFileSync(file, 'utf-8');
  let steps: ChainStep[];
  try {
    const doc = JSON.parse(body);
    steps = (doc.steps ?? doc) as ChainStep[];
  } catch (err: any) {
    console.error(`ghax replay: invalid recording — ${err.message}`);
    return EXIT.USAGE;
  }
  return withDaemon(async (port) => {
    const results: Array<{ cmd: string; ok: boolean; error?: string }> = [];
    for (const step of steps) {
      try {
        await rpc(port, step.cmd, step.args ?? [], step.opts ?? {});
        results.push({ cmd: step.cmd, ok: true });
        console.log(`✓ ${step.cmd}${step.args?.length ? ' ' + JSON.stringify(step.args) : ''}`);
      } catch (err: any) {
        results.push({ cmd: step.cmd, ok: false, error: err.message });
        console.error(`✗ ${step.cmd} — ${err.message}`);
        return EXIT.CDP_ERROR;
      }
    }
    return EXIT.OK;
  });
}

async function dispatchGesture(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (!sub) {
    console.error('Usage: ghax gesture <click|key> ...');
    return EXIT.USAGE;
  }
  const parsed = parseArgs(rest.slice(1));
  switch (sub) {
    case 'click':
      return makeSimple('gesture.click')(parsed);
    case 'key':
      return makeSimple('gesture.key')(parsed);
    default:
      console.error(`Unknown gesture: ${sub}`);
      return EXIT.USAGE;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('ghax: fatal:', err);
    process.exit(EXIT.CDP_ERROR);
  });
