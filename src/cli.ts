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
import { probeCdp, scanCdpPorts, findFreePort, detectBrowsers, launchBrowser, launchInstructions, type BrowserKind, type CdpEndpoint } from './browser-launch';

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
  // Raw argv for this verb invocation (everything after the verb). Preserved
  // so handlers that care about duplicate flags (e.g. repeated `--url` on
  // `qa`) can rescan the original list instead of reading from process.argv,
  // which doesn't update in shell-mode REPL usage.
  raw: string[];
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
  return { positional, flags, raw: argv };
}

async function rpc<T = unknown>(port: number, cmd: string, args: unknown[] = [], opts: Record<string, unknown> = {}): Promise<T> {
  const resp = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args, opts }),
  });
  const body = (await resp.json()) as { ok: boolean; data?: T; error?: string; exitCode?: number };
  if (!body.ok) {
    const err: Error & { exit?: number } = new Error(body.error || `RPC ${cmd} failed`);
    if (typeof body.exitCode === 'number') err.exit = body.exitCode;
    throw err;
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

// Default range we scan for CDPs and auto-fallback port selection.
const PORT_BASE = 9222;
const PORT_RANGE = 9; // 9222..9230 inclusive

async function cmdAttach(parsed: ParsedArgs): Promise<number> {
  const explicitPort = parsed.flags.port ? Number(parsed.flags.port) : null;
  const browserOpt = (parsed.flags.browser as string | undefined) as BrowserKind | undefined;
  const launch = Boolean(parsed.flags.launch);
  const headless = Boolean(parsed.flags.headless);

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

  // ── Step 1: find an endpoint (attach path) ───────────────────────
  //
  // Reuse beats launch. If the user asked for a specific port, only probe
  // that. Otherwise scan PORT_BASE..+RANGE for any live CDP.
  //
  // When --browser <kind> is passed, treat it as a filter on what counts
  // as a valid reuse target: the user wants THAT browser. If nothing of
  // that kind is running, fall through to launch (assuming --launch).
  let endpoint: CdpEndpoint | null = null;
  if (explicitPort !== null) {
    const hit = await probeCdp(explicitPort);
    if (hit) {
      const hitKind = inferKindFromVersion(hit.version['User-Agent']);
      if (!browserOpt || hitKind === browserOpt) endpoint = hit;
    }
  } else {
    let found = await scanCdpPorts(PORT_BASE, PORT_RANGE);
    if (browserOpt) {
      found = found.filter((ep) => inferKindFromVersion(ep.version['User-Agent']) === browserOpt);
    }
    if (found.length === 1) {
      endpoint = found[0];
    } else if (found.length > 1) {
      // Multiple matching CDPs. Pick interactively if we have a TTY;
      // fall back to the first one with a note for scripted callers.
      endpoint = await pickEndpoint(found, browserOpt);
    }
  }

  let kind: BrowserKind = browserOpt ?? 'edge';

  if (!endpoint) {
    // ── Step 2: launch path ─────────────────────────────────────────
    const browsers = detectBrowsers();
    if (!launch) {
      // If --browser filtered out live CDPs, say so — it's a better error
      // than pretending nothing's running.
      if (browserOpt && explicitPort === null) {
        const anyRunning = await scanCdpPorts(PORT_BASE, PORT_RANGE);
        if (anyRunning.length > 0) {
          const describe = (ep: CdpEndpoint) =>
            `${inferKindFromVersion(ep.version['User-Agent'])} on :${ep.port}`;
          console.error(
            `--browser ${browserOpt} requested, but only ${anyRunning.map(describe).join(', ')} running.\n` +
              `  Pass --launch to start ${browserOpt}, or omit --browser to attach to a running one.`,
          );
          return EXIT.NOT_ATTACHED;
        }
      }
      console.error(launchInstructions(explicitPort ?? PORT_BASE, browsers));
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

    // Pick the port: explicit wins, else scan for a free one in range.
    let launchPort: number;
    if (explicitPort !== null) {
      launchPort = explicitPort;
      // Sanity check: explicit port in use (non-CDP) means launch will fail
      // anyway, but we can warn early if something's there.
      const inUse = await probeCdp(explicitPort);
      if (inUse) {
        // Reuse-first invariant: if it IS a CDP, we should have used it above.
        // Hitting this branch means the CDP disappeared between scan and now.
        // Unlikely, but attach to it rather than launch-collide.
        endpoint = inUse;
        kind = browserOpt ?? inferKindFromVersion(inUse.version['User-Agent']);
        const state = await spawnDaemon(endpoint, kind);
        console.log(`attached (port race resolved) — pid ${state.pid}, port ${state.port}, browser ${state.browserKind}`);
        return EXIT.OK;
      }
    } else {
      const free = await findFreePort(PORT_BASE, PORT_RANGE);
      if (free === null) {
        console.error(`No free port in ${PORT_BASE}..${PORT_BASE + PORT_RANGE - 1} (all occupied). Pass --port to override.`);
        return EXIT.NOT_ATTACHED;
      }
      launchPort = free;
      if (launchPort !== PORT_BASE) {
        console.log(`:${PORT_BASE} in use — using :${launchPort}`);
      }
    }

    const loadExt = parsed.flags['load-extension'] as string | undefined;
    const dataDir = parsed.flags['data-dir'] as string | undefined;
    const extNote = loadExt ? ` with unpacked extension from ${loadExt}` : '';
    const profileNote = dataDir ? dataDir : `~/.ghax/${target.kind}-profile`;
    const headlessNote = headless ? ' [headless]' : '';
    console.log(`launching ${target.label}${headlessNote} with CDP on :${launchPort} (profile: ${profileNote})${extNote}`);
    const launched = await launchBrowser(target, {
      port: launchPort,
      headless,
      ...(loadExt ? { loadExtension: loadExt } : {}),
      ...(dataDir ? { dataDir } : {}),
    });
    endpoint = launched.endpoint;
    kind = target.kind;
  } else {
    kind = browserOpt ?? inferKindFromVersion(endpoint.version['User-Agent']);
  }

  const state = await spawnDaemon(endpoint, kind);
  console.log(`attached — pid ${state.pid}, port ${state.port}, browser ${state.browserKind}`);
  return EXIT.OK;
}

/**
 * Multiple CDPs found in the scan range. If --browser was specified, prefer
 * that kind. Otherwise — if stdin is a TTY — show a picker. Non-interactive
 * callers (scripts, CI, pipes) get the first endpoint with a note.
 */
async function pickEndpoint(endpoints: CdpEndpoint[], preferKind: BrowserKind | undefined): Promise<CdpEndpoint> {
  // Preference filter first.
  if (preferKind) {
    const matching = endpoints.filter((ep) => inferKindFromVersion(ep.version['User-Agent']) === preferKind);
    if (matching.length === 1) return matching[0];
    if (matching.length > 1) endpoints = matching;
  }

  const describe = (ep: CdpEndpoint) =>
    `${inferKindFromVersion(ep.version['User-Agent'])} ${ep.version.Browser} on :${ep.port}`;

  if (!process.stdin.isTTY) {
    console.error(`Found ${endpoints.length} CDPs: ${endpoints.map(describe).join(', ')}.`);
    console.error(`  using ${describe(endpoints[0])} (pass --port to override)`);
    return endpoints[0];
  }

  console.log(`Found ${endpoints.length} CDP endpoints:`);
  for (let i = 0; i < endpoints.length; i++) {
    console.log(`  [${i + 1}] ${describe(endpoints[i])}`);
  }
  process.stdout.write(`Choose [1-${endpoints.length}] (default 1): `);
  const line = await readLine();
  const n = parseInt(line.trim(), 10);
  if (!isNaN(n) && n >= 1 && n <= endpoints.length) return endpoints[n - 1];
  return endpoints[0];
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(buf.toString('utf-8'));
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
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

/**
 * Stream Server-Sent Events from the daemon. One event per line, each line
 * a JSON payload. Returns exit code 0 on user interrupt (SIGINT / Ctrl-C),
 * non-zero on connection error.
 *
 * Daemon-side sends `:ping\n\n` every 15s; those lines start with `:` and
 * are skipped here.
 */
async function streamSse(port: number, path: string): Promise<number> {
  const controller = new AbortController();
  const handleSigint = () => controller.abort();
  process.on('SIGINT', handleSigint);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (!resp.ok || !resp.body) {
      console.error(`ghax: SSE ${path} failed (${resp.status})`);
      return EXIT.CDP_ERROR;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          try {
            const obj = JSON.parse(payload);
            console.log(JSON.stringify(obj));
          } catch {
            console.log(payload);
          }
        }
        idx = buf.indexOf('\n\n');
      }
    }
    return EXIT.OK;
  } catch (err: any) {
    if (err?.name === 'AbortError') return EXIT.OK;
    console.error(`ghax: SSE error: ${err.message}`);
    return EXIT.CDP_ERROR;
  } finally {
    process.removeListener('SIGINT', handleSigint);
  }
}

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
  return { positional, flags, raw: argv };
}

// ─── Main dispatcher ───────────────────────────────────────────

const HELP = `ghax — attach to your real Chrome/Edge via CDP and drive it.

Connection:
  attach [--port <n>] [--browser edge|chrome|chromium|brave|arc] [--launch]
         [--headless] [--load-extension <path>] [--data-dir <path>]
         # Without --port, scans :9222-9230. Multiple running → picker.
         # With --launch and no --port, auto-picks first free port in range.
  status [--json]
  detach
  restart

Tab:
  tabs
  tab <id> [--quiet]              # --quiet = don't bringToFront
  find <url-substring>            # list tabs matching (pipe into 'tab')
  new-window [url]                # new background window, same profile
  goto <url>
  back | forward | reload
  eval <js>
  try [<js>] [--css <rules>] [--selector <sel>] [--measure <expr>] [--shot <path>]
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
  is <visible|hidden|enabled|disabled|checked|editable> <@ref|selector>
  storage [local|session] [get|set|remove|clear|keys] [key] [value]

Logs:
  console [--errors] [--last N] [--dedup] [--source-maps]
         # --dedup groups repeats with count
         # --source-maps resolves bundled stack frames to original sources
  network [--pattern <re>] [--status 4xx|500|400-499] [--last N] [--har <path>]
  cookies

Extensions (MV3):
  ext list
  ext targets <ext-id>
  ext reload <ext-id>
  ext hot-reload <ext-id> [--wait N] [--no-inject] [--verbose]
  ext sw <ext-id> eval <js>
  ext panel <ext-id> eval <js>
  ext popup <ext-id> eval <js>
  ext options <ext-id> eval <js>
  ext storage <ext-id> [local|session|sync] [get|set|clear] [key] [value]
  ext message <ext-id> <json-payload>

Real user gestures:
  gesture click <x,y>
  gesture dblclick <x,y>
  gesture scroll <up|down|left|right> [amount]
  gesture key <key>

Batch / recording:
  chain < steps.json          (JSON array of {cmd, args?, opts?})
  record start [name]
  record stop
  record status
  replay <file>

Orchestrated:
  qa --url <u> [--url <u> ...] [--urls a,b,c]
     [--crawl <root> [--depth N] [--limit N]]
     [--out report.json] [--screenshots <dir>] [--no-screenshots]
     [--annotate] [--gif <out.gif>]
  profile [--duration sec] [--heap] [--extension <ext-id>]
  perf [--wait <ms>]                  # Core Web Vitals + nav timing
  diff-state <before.json> <after.json>
  canary <url> [--interval 60] [--max 3600] [--out report.json] [--fail-fast]

Dev workflow:
  ship [--message "..."] [--no-check] [--no-build] [--no-pr] [--dry-run]
  review [--base origin/main] [--diff]
  pair [status]
  gif <recording> [out.gif] [--delay ms] [--scale px] [--keep-frames]
  shell                             # interactive REPL — skip per-command spawn cost

Add --json for machine-readable output on any command.
`;

async function dispatch(argv: string[]): Promise<number> {
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
      case 'find':
      case 'goto':
      case 'eval':
      case 'try':
      case 'click':
      case 'press':
      case 'type':
      case 'html':
      case 'screenshot':
      case 'wait':
      case 'viewport':
      case 'responsive':
      case 'diff':
      case 'storage':
        return await makeSimple(verb)(parseArgs(rest));

      case 'is': {
        const parsed = parseArgs(rest);
        return await withDaemon(async (port) => {
          const data = (await rpc(port, 'is', parsed.positional, flagsToOpts(parsed.flags))) as {
            check: string; target: string; result: boolean;
          };
          if (parsed.flags.json) {
            console.log(JSON.stringify(data, null, 2));
          } else {
            console.log(data.result ? 'true' : 'false');
          }
          return data.result ? EXIT.OK : EXIT.USAGE;
        });
      }

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
      case 'network': {
        const parsed = parseArgs(rest);
        if (parsed.flags.follow) {
          return await withDaemon((port) => streamSse(port, `/sse/${verb}`));
        }
        return await makeSimple(verb)(parsed);
      }

      case 'new-window':
        return await makeSimple('newWindow')(parseArgs(rest));

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

      case 'gif':
        return await cmdGif(parseArgs(rest));

      case 'qa':
        return await cmdQa(parseArgs(rest));

      case 'profile':
        return await makeSimple('profile')(parseArgs(rest));

      case 'perf':
        return await makeSimple('perf')(parseArgs(rest));

      case 'diff-state':
        return await cmdDiffState(parseArgs(rest));

      case 'ship':
        return await cmdShip(parseArgs(rest));

      case 'canary':
        return await cmdCanary(parseArgs(rest));

      case 'review':
        return await cmdReview(parseArgs(rest));

      case 'pair':
        return await cmdPair(parseArgs(rest));

      case 'shell':
        return await cmdShell();

      default:
        console.error(`Unknown command: ${verb}\n\nRun 'ghax --help' for usage.`);
        return EXIT.USAGE;
    }
  } catch (err: any) {
    if (typeof err?.exit === 'number') {
      console.error(`ghax: ${err.message}`);
      return err.exit;
    }
    // Surface disconnect errors helpfully instead of as a raw stack trace.
    const msg = String(err?.message || err);
    if (/browser has been closed|Target (page|browser) has been closed|disconnected/i.test(msg)) {
      console.error('ghax: browser has disconnected. Run `ghax attach` to reconnect.');
      return EXIT.NOT_ATTACHED;
    }
    console.error(`ghax: ${msg}`);
    return EXIT.CDP_ERROR;
  }
}

async function main(): Promise<number> {
  return dispatch(process.argv.slice(2));
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
    case 'reload': {
      return withDaemon(async (port) => {
        const data = (await rpc(port, 'ext.reload', parsed.positional, flagsToOpts(parsed.flags))) as {
          ok?: boolean; hint?: string | null;
        };
        if (parsed.flags.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log('reloaded');
          if (data?.hint) console.error(`hint: ${data.hint}`);
        }
        return EXIT.OK;
      });
    }
    case 'hot-reload': {
      return withDaemon(async (port) => {
        const data = (await rpc(port, 'ext.hot-reload', parsed.positional, flagsToOpts(parsed.flags))) as {
          ok: boolean;
          swVersion: string;
          previousVersion: string;
          tabs: Array<{ tabId: number; url?: string; status: 'ok' | 'error'; error?: string }>;
          reinjected: number;
          failed: number;
          skipped: boolean;
          durationMs: number;
        };
        if (parsed.flags.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const vtag = data.swVersion && data.previousVersion && data.swVersion !== data.previousVersion
            ? `${data.previousVersion} → ${data.swVersion}`
            : (data.swVersion || 'unknown');
          if (data.skipped) {
            console.log(`reloaded (no content scripts or --no-inject), SW version=${vtag}, ${data.durationMs}ms`);
          } else {
            console.log(`re-injected into ${data.reinjected} of ${data.reinjected + data.failed} tabs, SW version=${vtag}, ${data.durationMs}ms`);
            if (parsed.flags.verbose) {
              for (const t of data.tabs) {
                const tag = t.status === 'ok' ? '✓' : '✗';
                console.log(`  ${tag} tab ${t.tabId}${t.url ? ` (${t.url})` : ''}${t.error ? ` — ${t.error}` : ''}`);
              }
            }
          }
        }
        return data.failed > 0 ? 6 : EXIT.OK;
      });
    }
    case 'sw': {
      // ghax ext sw <ext-id> <op> [...]
      const extId = parsed.positional[0];
      const op = parsed.positional[1];
      if (!extId || !op) {
        console.error('Usage: ghax ext sw <ext-id> eval <js>');
        console.error('       ghax ext sw <ext-id> logs [--last N] [--errors] [--follow]');
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
      if (op === 'logs') {
        if (parsed.flags.follow) {
          return withDaemon((port) => streamSse(port, `/sse/ext-sw-logs/${encodeURIComponent(extId)}`));
        }
        return withDaemon(async (port) => {
          const data = await rpc(port, 'ext.sw.logs', [extId], flagsToOpts(parsed.flags));
          printResult(data, Boolean(parsed.flags.json));
          return EXIT.OK;
        });
      }
      console.error(`Unknown ext sw op: ${op}`);
      return EXIT.USAGE;
    }
    case 'panel':
    case 'popup':
    case 'options': {
      const extId = parsed.positional[0];
      const op = parsed.positional[1];
      if (!extId || !op) {
        console.error(`Usage: ghax ext ${sub} <ext-id> eval <js>`);
        return EXIT.USAGE;
      }
      if (op === 'eval') {
        const js = parsed.positional.slice(2).join(' ');
        const handlerName = `ext.${sub}.eval`;
        return withDaemon(async (port) => {
          const data = await rpc(port, handlerName, [extId, js], flagsToOpts(parsed.flags));
          printResult(data, Boolean(parsed.flags.json));
          return EXIT.OK;
        });
      }
      console.error(`Unknown ext ${sub} op: ${op}`);
      return EXIT.USAGE;
    }
    case 'storage':
      // ghax ext storage <ext-id> <area> <op> [key] [value]
      return withDaemon(async (port) => {
        const data = await rpc(port, 'ext.storage', parsed.positional, flagsToOpts(parsed.flags));
        printResult(data, Boolean(parsed.flags.json));
        return EXIT.OK;
      });
    case 'message': {
      // ghax ext message <ext-id> <json-payload>
      const extId = parsed.positional[0];
      const payload = parsed.positional.slice(1).join(' ');
      if (!extId || !payload) {
        console.error('Usage: ghax ext message <ext-id> <json-payload>');
        return EXIT.USAGE;
      }
      return withDaemon(async (port) => {
        const data = await rpc(port, 'ext.message', [extId, payload], flagsToOpts(parsed.flags));
        printResult(data, Boolean(parsed.flags.json));
        return EXIT.OK;
      });
    }
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

interface QaPageReport {
  url: string;
  finalUrl: string;
  title: string;
  loadMs: number;
  screenshotPath?: string;
  refCount: number;
  consoleErrors: Array<{ text: string; url?: string }>;
  failedRequests: Array<{ url: string; status?: number; method: string }>;
}

interface QaReport {
  startedAt: string;
  durationMs: number;
  urlsAttempted: number;
  urlsOk: number;
  pages: QaPageReport[];
}

async function cmdQa(parsed: ParsedArgs): Promise<number> {
  // Accept URLs three ways:
  //   1. Multiple --url flags (argv parser collapses duplicates, so allow
  //      --urls comma-joined as the canonical form).
  //   2. Positional args.
  //   3. JSON array on stdin.
  const urls: string[] = [];
  if (parsed.flags.urls && typeof parsed.flags.urls === 'string') {
    urls.push(...parsed.flags.urls.split(',').map((s) => s.trim()).filter(Boolean));
  }
  // Repeatable --url: parseArgs collapses duplicate keys, so rescan the
  // verb's raw argv to catch every instance. We read parsed.raw rather than
  // process.argv so this works under `ghax shell` REPL mode too.
  const argv = parsed.raw;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) {
      urls.push(argv[i + 1]);
      i++;
    } else if (argv[i].startsWith('--url=')) {
      urls.push(argv[i].slice(6));
    }
  }
  for (const p of parsed.positional) {
    if (/^https?:\/\//.test(p)) urls.push(p);
  }
  if (urls.length === 0 && !process.stdin.isTTY) {
    const body = await readStdin();
    if (body.trim()) {
      try {
        const arr = JSON.parse(body);
        if (Array.isArray(arr)) urls.push(...arr.map((x) => String(x)));
      } catch {
        // Treat stdin as newline-separated.
        urls.push(...body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      }
    }
  }

  const crawlRoot = parsed.flags.crawl as string | undefined;
  const crawlDepth = parsed.flags.depth ? Number(parsed.flags.depth) : 1;
  const crawlLimit = parsed.flags.limit ? Number(parsed.flags.limit) : 20;

  if (crawlRoot) {
    const crawled = await crawlUrls(crawlRoot, { depth: crawlDepth, limit: crawlLimit });
    console.log(`crawl discovered ${crawled.length} URLs under ${crawlRoot}`);
    urls.push(...crawled);
  }

  if (urls.length === 0) {
    console.error('Usage: ghax qa --url <u> [--url <u> ...] [--out <report.json>] [--screenshots <dir>]');
    console.error('       ghax qa --urls a.com,b.com');
    console.error('       ghax qa --crawl https://example.com [--depth 1] [--limit 20]');
    console.error('       echo \'["a","b"]\' | ghax qa --out report.json');
    return EXIT.USAGE;
  }

  // Dedupe while preserving order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const u of urls) {
    if (!seen.has(u)) {
      seen.add(u);
      deduped.push(u);
    }
  }
  urls.length = 0;
  urls.push(...deduped);

  const outPath = (parsed.flags.out as string | undefined) || '/tmp/ghax-qa-report.json';
  const shotsDir = (parsed.flags.screenshots as string | undefined) || (parsed.flags['no-screenshots'] ? null : `/tmp/ghax-qa-shots-${Date.now()}`);
  const annotate = Boolean(parsed.flags.annotate);
  const gifOut = parsed.flags.gif as string | undefined;

  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

  return withDaemon(async (port) => {
    const startedAt = Date.now();
    const report: QaReport = {
      startedAt: new Date(startedAt).toISOString(),
      durationMs: 0,
      urlsAttempted: urls.length,
      urlsOk: 0,
      pages: [],
    };

    for (const url of urls) {
      console.log(`→ ${url}`);
      const pageStart = Date.now();
      try {
        const nav = (await rpc(port, 'goto', [url])) as { url: string; title: string };
        // Let rendering settle; most SPAs finish hydrating within ~500ms.
        await new Promise((r) => setTimeout(r, 500));

        const snapRes = (await rpc(port, 'snapshot', [], {
          interactive: true,
          ...(annotate ? { annotate: true } : {}),
        })) as { text: string; count: number; annotatedPath?: string };

        let screenshotPath: string | undefined;
        if (shotsDir) {
          const safe = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
          screenshotPath = annotate && snapRes.annotatedPath
            ? snapRes.annotatedPath
            : `${shotsDir}/${safe}.png`;
          if (!annotate) {
            await rpc(port, 'screenshot', [], { path: screenshotPath, fullPage: true });
          }
        }

        // Pull the console buffer slice that belongs to this page — ghax
        // exposes the tail of the rolling buffer, so filter to "since page
        // start" as a close-enough heuristic.
        const consoleLog = (await rpc(port, 'console', [], { last: 200 })) as Array<{
          timestamp: number;
          level: string;
          text: string;
          url?: string;
        }>;
        const consoleErrors = consoleLog
          .filter((e) => e.level === 'error' && e.timestamp >= pageStart)
          .map((e) => ({ text: e.text, url: e.url }));

        const netLog = (await rpc(port, 'network', [], { last: 500 })) as Array<{
          timestamp: number;
          url: string;
          method: string;
          status?: number;
        }>;
        const failedRequests = netLog
          .filter((e) => e.timestamp >= pageStart && e.status !== undefined && e.status >= 400)
          .map((e) => ({ url: e.url, status: e.status, method: e.method }));

        report.pages.push({
          url,
          finalUrl: nav.url,
          title: nav.title,
          loadMs: Date.now() - pageStart,
          ...(screenshotPath ? { screenshotPath } : {}),
          refCount: snapRes.count,
          consoleErrors,
          failedRequests,
        });
        report.urlsOk++;
        const errTag = consoleErrors.length > 0 ? `, ${consoleErrors.length} console errors` : '';
        const netTag = failedRequests.length > 0 ? `, ${failedRequests.length} failed requests` : '';
        console.log(`  ✓ ${snapRes.count} refs${errTag}${netTag}`);
      } catch (err: any) {
        console.log(`  ✗ ${err.message}`);
        report.pages.push({
          url,
          finalUrl: url,
          title: '',
          loadMs: Date.now() - pageStart,
          refCount: 0,
          consoleErrors: [{ text: `[qa] ${err.message}` }],
          failedRequests: [],
        });
      }
    }

    report.durationMs = Date.now() - startedAt;
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nReport → ${outPath}`);
    console.log(`  ${report.urlsOk}/${report.urlsAttempted} pages ok, ${report.durationMs}ms total`);
    const totalConsoleErrors = report.pages.reduce((n, p) => n + p.consoleErrors.length, 0);
    const totalNetFailures = report.pages.reduce((n, p) => n + p.failedRequests.length, 0);
    if (totalConsoleErrors > 0) console.log(`  ${totalConsoleErrors} console errors across all pages`);
    if (totalNetFailures > 0) console.log(`  ${totalNetFailures} failed requests across all pages`);

    // Optional GIF from the screenshots (if we took any).
    if (gifOut && shotsDir) {
      const probe = Bun.spawnSync(['ffmpeg', '-version'], { stdout: 'ignore', stderr: 'ignore' });
      if (probe.exitCode !== 0) {
        console.error(`  (skipping --gif: ffmpeg not on PATH)`);
      } else {
        // Stitch screenshots lexically. Users should name URLs so they sort
        // in the desired order, or we'd need another flag for ordering.
        const pattern = `${shotsDir}/*.png`;
        const render = Bun.spawnSync([
          'ffmpeg', '-y',
          '-framerate', '1',
          '-pattern_type', 'glob',
          '-i', pattern,
          '-vf', 'scale=1024:-1:flags=lanczos',
          '-loop', '0',
          gifOut,
        ], { stdout: 'ignore', stderr: 'pipe' });
        if (render.exitCode !== 0) {
          console.error(`  ffmpeg failed: ${render.stderr.toString().split('\n').slice(-3).join(' | ')}`);
        } else {
          console.log(`  GIF → ${gifOut}`);
        }
      }
    }

    return report.urlsOk === report.urlsAttempted ? EXIT.OK : EXIT.CDP_ERROR;
  });
}

/**
 * diff-state: structural JSON diff between two snapshot files.
 *
 * Walks both trees in parallel, emitting entries in JSON-pointer form
 * (RFC 6901-ish — slash-separated paths). Added / removed / changed
 * leaves are tagged; object-vs-object and array-vs-array recurse.
 * Arrays compare element-wise (no LCS) because snapshot diffs usually
 * want positional awareness.
 */
interface DiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

function diffValues(path: string, a: unknown, b: unknown, out: DiffEntry[]): void {
  if (a === b) return;
  const aKind = kindOf(a);
  const bKind = kindOf(b);
  if (aKind !== bKind) {
    out.push({ path, kind: 'changed', before: a, after: b });
    return;
  }
  if (aKind === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      const sub = `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!(k in ao)) out.push({ path: sub, kind: 'added', after: bo[k] });
      else if (!(k in bo)) out.push({ path: sub, kind: 'removed', before: ao[k] });
      else diffValues(sub, ao[k], bo[k], out);
    }
    return;
  }
  if (aKind === 'array') {
    const aa = a as unknown[];
    const ba = b as unknown[];
    const max = Math.max(aa.length, ba.length);
    for (let i = 0; i < max; i++) {
      const sub = `${path}/${i}`;
      if (i >= aa.length) out.push({ path: sub, kind: 'added', after: ba[i] });
      else if (i >= ba.length) out.push({ path: sub, kind: 'removed', before: aa[i] });
      else diffValues(sub, aa[i], ba[i], out);
    }
    return;
  }
  // Scalars: direct inequality = changed.
  if (a !== b) out.push({ path, kind: 'changed', before: a, after: b });
}

function kindOf(v: unknown): 'object' | 'array' | 'scalar' | 'null' | 'undefined' {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return 'scalar';
}

async function cmdDiffState(parsed: ParsedArgs): Promise<number> {
  const [beforePath, afterPath] = parsed.positional;
  if (!beforePath || !afterPath) {
    console.error('Usage: ghax diff-state <before.json> <after.json> [--json]');
    return EXIT.USAGE;
  }
  let before: unknown, after: unknown;
  try {
    before = JSON.parse(fs.readFileSync(beforePath, 'utf-8'));
  } catch (err: any) {
    console.error(`ghax diff-state: cannot read ${beforePath}: ${err.message}`);
    return EXIT.USAGE;
  }
  try {
    after = JSON.parse(fs.readFileSync(afterPath, 'utf-8'));
  } catch (err: any) {
    console.error(`ghax diff-state: cannot read ${afterPath}: ${err.message}`);
    return EXIT.USAGE;
  }
  const diffs: DiffEntry[] = [];
  diffValues('', before, after, diffs);
  if (parsed.flags.json) {
    console.log(JSON.stringify({ diffs, added: diffs.filter((d) => d.kind === 'added').length, removed: diffs.filter((d) => d.kind === 'removed').length, changed: diffs.filter((d) => d.kind === 'changed').length }, null, 2));
  } else if (diffs.length === 0) {
    console.log('(no differences)');
  } else {
    for (const d of diffs) {
      const p = d.path || '/';
      if (d.kind === 'added') console.log(`+ ${p} = ${JSON.stringify(d.after)}`);
      else if (d.kind === 'removed') console.log(`- ${p} = ${JSON.stringify(d.before)}`);
      else console.log(`~ ${p}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`);
    }
  }
  return diffs.length === 0 ? EXIT.OK : EXIT.OK;
}

// ─── ghax ship ────────────────────────────────────────────────
//
// Opinionated commit + push + PR. Each step is skippable via --no-<step>
// so power users can opt out. No --amend, no force push.

function sh(cmd: string[], opts: { cwd?: string; allowFailure?: boolean } = {}): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
  if (!out.ok && !opts.allowFailure) {
    console.error(`ghax ship: ${cmd.join(' ')} failed (${proc.exitCode})`);
    if (out.stderr) console.error(out.stderr);
  }
  return out;
}

async function cmdShip(parsed: ParsedArgs): Promise<number> {
  const msg = parsed.flags.message as string | undefined;
  const skipCheck = Boolean(parsed.flags['no-check']);
  const skipBuild = Boolean(parsed.flags['no-build']);
  const skipPr = Boolean(parsed.flags['no-pr']);
  const dry = Boolean(parsed.flags['dry-run']);

  // Verify we're in a clean-enough git repo.
  const root = sh(['git', 'rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!root.ok) {
    console.error('ghax ship: not inside a git repository');
    return EXIT.USAGE;
  }
  const repoRoot = root.stdout.trim();

  // Status check.
  const status = sh(['git', 'status', '--porcelain'], { cwd: repoRoot });
  if (!status.ok) return EXIT.CDP_ERROR;
  const dirty = status.stdout.trim().length > 0;

  if (!dirty) {
    console.log('ghax ship: working tree clean — nothing to commit');
  } else {
    console.log(status.stdout);
  }

  // Typecheck + build (skippable).
  if (!skipCheck) {
    console.log('→ typecheck');
    const tc = sh(['bun', 'run', 'typecheck'], { cwd: repoRoot });
    if (!tc.ok) {
      console.error(tc.stderr);
      return EXIT.USAGE;
    }
  }
  if (!skipBuild) {
    console.log('→ build');
    const bld = sh(['bun', 'run', 'build'], { cwd: repoRoot });
    if (!bld.ok) {
      console.error(bld.stderr);
      return EXIT.USAGE;
    }
  }

  if (dry) {
    console.log('(dry-run — stopping before git mutations)');
    return EXIT.OK;
  }

  // Stage + commit only if dirty.
  if (dirty) {
    sh(['git', 'add', '-A'], { cwd: repoRoot });
    const commitArgs = ['git', 'commit'];
    if (msg) commitArgs.push('--message', msg);
    else commitArgs.push('--message', `ghax ship ${new Date().toISOString()}`);
    const c = sh(commitArgs, { cwd: repoRoot });
    if (!c.ok) {
      console.error(c.stderr || c.stdout);
      return EXIT.USAGE;
    }
    console.log(c.stdout.split('\n').slice(0, 3).join('\n'));
  }

  // Determine current branch.
  const branch = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }).stdout.trim();
  const isMain = branch === 'main' || branch === 'master';

  // Push.
  console.log(`→ push origin ${branch}`);
  const push = sh(['git', 'push', '-u', 'origin', branch], { cwd: repoRoot });
  if (!push.ok) {
    console.error(push.stderr || push.stdout);
    return EXIT.CDP_ERROR;
  }
  console.log((push.stderr || push.stdout).trim());

  // PR creation (only off main, gh must be available).
  if (!skipPr && !isMain) {
    const ghProbe = sh(['gh', '--version'], { allowFailure: true });
    if (!ghProbe.ok) {
      console.error('ghax ship: gh CLI not found — skipping PR step (--no-pr to silence)');
    } else {
      console.log('→ gh pr create --fill');
      const pr = sh(['gh', 'pr', 'create', '--fill'], { cwd: repoRoot, allowFailure: true });
      if (!pr.ok) {
        if (/already exists/.test(pr.stderr)) {
          const view = sh(['gh', 'pr', 'view', '--json', 'url', '--jq', '.url'], { cwd: repoRoot, allowFailure: true });
          if (view.ok) console.log(`PR already exists: ${view.stdout.trim()}`);
        } else {
          console.error(pr.stderr || pr.stdout);
          return EXIT.CDP_ERROR;
        }
      } else {
        console.log(pr.stdout.trim());
      }
    }
  }

  return EXIT.OK;
}

// ─── ghax canary ──────────────────────────────────────────────
//
// Keep attaching, polling a URL every interval seconds. Each cycle
// snapshots, captures console errors, and records HTTP failures. Writes
// a rolling log to .ghax/canary-<host>.log, plus a structured JSON
// report on exit (or every --report-every cycles).

interface CanaryCycle {
  at: string;
  url: string;
  ok: boolean;
  loadMs: number;
  consoleErrors: number;
  failedRequests: number;
  notes?: string[];
}

async function cmdCanary(parsed: ParsedArgs): Promise<number> {
  const url = parsed.positional[0];
  if (!url) {
    console.error('Usage: ghax canary <url> [--interval 60] [--max 3600] [--out <report.json>]');
    return EXIT.USAGE;
  }
  const intervalSec = parsed.flags.interval ? Number(parsed.flags.interval) : 60;
  const maxSec = parsed.flags.max ? Number(parsed.flags.max) : 3600;
  const outPath = (parsed.flags.out as string | undefined) ?? null;
  const failFast = Boolean(parsed.flags['fail-fast']);
  const cfg = resolveConfig();
  const logPath = `${cfg.stateDir}/canary-${new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_')}.log`;

  return withDaemon(async (port) => {
    const startedAt = Date.now();
    const cycles: CanaryCycle[] = [];
    let aborted = false;
    const onInt = () => {
      aborted = true;
      console.log('\n(interrupted — writing partial report)');
    };
    process.on('SIGINT', onInt);

    ensureStateDir(cfg);

    while (!aborted && Date.now() - startedAt < maxSec * 1000) {
      const cycleStart = Date.now();
      const cycle: CanaryCycle = {
        at: new Date(cycleStart).toISOString(),
        url,
        ok: true,
        loadMs: 0,
        consoleErrors: 0,
        failedRequests: 0,
      };
      try {
        const nav = (await rpc(port, 'goto', [url])) as { url: string };
        await new Promise((r) => setTimeout(r, 400));
        cycle.loadMs = Date.now() - cycleStart;
        if (nav.url !== url && !nav.url.startsWith(url)) {
          cycle.notes = [`redirected to ${nav.url}`];
        }
        const cErr = (await rpc(port, 'console', [], { last: 500 })) as Array<{ level: string; timestamp: number }>;
        cycle.consoleErrors = cErr.filter((e) => e.level === 'error' && e.timestamp >= cycleStart).length;
        const nErr = (await rpc(port, 'network', [], { last: 500 })) as Array<{ status?: number; timestamp: number }>;
        cycle.failedRequests = nErr.filter((e) => e.timestamp >= cycleStart && e.status !== undefined && e.status >= 400).length;
        cycle.ok = cycle.consoleErrors === 0 && cycle.failedRequests === 0;
      } catch (err: any) {
        cycle.ok = false;
        cycle.notes = [`rpc error: ${err.message}`];
      }
      cycles.push(cycle);
      const line = `[${cycle.at}] ${cycle.ok ? 'OK' : 'FAIL'} ${url} load=${cycle.loadMs}ms console=${cycle.consoleErrors} net=${cycle.failedRequests}${cycle.notes ? ' — ' + cycle.notes.join(', ') : ''}`;
      console.log(line);
      try {
        fs.appendFileSync(logPath, line + '\n');
      } catch {
        // best-effort
      }
      if (!cycle.ok && failFast) {
        aborted = true;
        break;
      }
      if (aborted) break;
      // Sleep in small increments so SIGINT is responsive.
      const sleepUntil = Date.now() + intervalSec * 1000;
      while (!aborted && Date.now() < sleepUntil) {
        await new Promise((r) => setTimeout(r, Math.min(250, sleepUntil - Date.now())));
      }
    }

    process.removeListener('SIGINT', onInt);
    const report = {
      url,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      cycles,
      okCycles: cycles.filter((c) => c.ok).length,
      failCycles: cycles.filter((c) => !c.ok).length,
    };
    if (outPath) {
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.log(`report → ${outPath}`);
    }
    console.log(`canary done — ${report.okCycles}/${cycles.length} cycles ok`);
    return report.failCycles > 0 ? EXIT.CDP_ERROR : EXIT.OK;
  });
}

// ─── ghax review ──────────────────────────────────────────────
//
// Emit a Claude-ready review prompt wrapping the branch's diff vs a base.
// No API calls — stdout only, user pipes to claude or pastes.

async function cmdReview(parsed: ParsedArgs): Promise<number> {
  const base = (parsed.flags.base as string | undefined) ?? 'origin/main';
  const rootCmd = sh(['git', 'rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!rootCmd.ok) {
    console.error('ghax review: not inside a git repository');
    return EXIT.USAGE;
  }
  const repoRoot = rootCmd.stdout.trim();
  const branch = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }).stdout.trim();
  const diff = sh(['git', 'diff', `${base}...HEAD`], { cwd: repoRoot });
  if (!diff.ok) {
    console.error(diff.stderr);
    return EXIT.USAGE;
  }
  if (!diff.stdout.trim()) {
    console.error(`ghax review: no diff between ${base} and ${branch}`);
    return EXIT.OK;
  }

  const log = sh(['git', 'log', '--oneline', `${base}..HEAD`], { cwd: repoRoot });

  if (parsed.flags.diff) {
    console.log(diff.stdout);
    return EXIT.OK;
  }

  const lines = [
    `# Code review request`,
    ``,
    `**Branch:** \`${branch}\` (base: \`${base}\`)`,
    ``,
    `## Commits`,
    ``,
    '```',
    log.stdout.trim() || '(no commits on this branch)',
    '```',
    ``,
    `## Instructions`,
    ``,
    `Review the diff below. Call out:`,
    ``,
    `- Correctness bugs — off-by-ones, null-deref, race conditions, wrong API usage.`,
    `- Security — injection, path traversal, unsafe deserialisation, secret leakage.`,
    `- Resource leaks — unclosed sockets, forgotten timers, unbounded caches.`,
    `- API / contract changes that callers will need to adapt to.`,
    `- Anything that looks intentionally hacky or temporary.`,
    ``,
    `Do NOT pad the review with style nits unless they affect clarity.`,
    `If the diff is clean, say so plainly.`,
    ``,
    `## Diff`,
    ``,
    '```diff',
    diff.stdout,
    '```',
  ];
  console.log(lines.join('\n'));
  return EXIT.OK;
}

// ─── ghax pair ────────────────────────────────────────────────
//
// Share ghax with a remote agent. v0 is deliberately conservative:
// print setup instructions for the SSH-tunnel path (no auth changes
// required — the remote side reaches into localhost via a forwarded
// port). A proper multi-tenant token-auth mode is a v0.5 item and
// will alter the daemon's security surface, which wants its own
// careful session.
//
// For the SSH path, the user runs:
//
//   ssh -N -L <localport>:127.0.0.1:<daemonport> remote-host
//
// …then the remote agent talks to 127.0.0.1:<localport> on its side
// as if it were local. No daemon changes needed.

async function cmdPair(parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positional[0] ?? 'status';
  switch (sub) {
    case 'status':
    case 'info': {
      const state = readState(cfg);
      if (!state) {
        console.log('not attached — run `ghax attach` first');
        return EXIT.NOT_ATTACHED;
      }
      const lines = [
        'ghax pair — v0 (SSH-tunnel mode)',
        '',
        `Local daemon: 127.0.0.1:${state.port} (pid ${state.pid})`,
        `Browser:      ${state.browserKind}`,
        '',
        'To share with a remote agent:',
        '',
        `  # On the machine where the remote agent runs, tunnel in:`,
        `  ssh -N -L ${state.port}:127.0.0.1:${state.port} $(whoami)@<this-host>`,
        '',
        `  # Then on that remote agent's machine, point its ghax CLI at`,
        `  # the tunneled port — standard localhost RPC, no auth changes.`,
        '',
        'A proper multi-tenant token-auth mode is deferred to v0.5.',
        'Raised because:',
        '  - RPC surface is large; any bug is now remotely exploitable.',
        '  - We need URL allowlists per token.',
        '  - Need to decide bind semantics (0.0.0.0 vs Tailscale ts0).',
      ];
      console.log(lines.join('\n'));
      return EXIT.OK;
    }
    default:
      console.error(`ghax pair: unknown sub-command ${sub}`);
      console.error('       ghax pair status | info');
      return EXIT.USAGE;
  }
}

// ─── ghax shell ──────────────────────────────────────────────
//
// Interactive REPL. Reads one command per line from stdin, tokenises it the
// same way a shell would (quoted strings, escapes), and re-enters the main
// dispatch. Skips the per-invocation Bun spawn cost, so per-command latency
// drops from ~65ms to ~15-20ms. Meaningful for multi-turn agent sessions.
//
// Blank lines and lines starting with `#` are ignored. `exit` / `quit` leave
// the shell. Ctrl-D (EOF on stdin) exits cleanly.
//
// The shell does NOT recurse (calling `ghax shell` from inside the shell
// prints an error and continues) and does NOT intercept daemon state — it's
// just a loop around `dispatch()`.

async function cmdShell(): Promise<number> {
  const { createInterface } = await import('readline');
  const isTTY = Boolean(process.stdin.isTTY);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
    historySize: 500,
  });

  if (isTTY) {
    console.log('ghax shell — type commands, `exit` to quit, Ctrl-D to EOF.');
  }
  const prompt = () => {
    if (isTTY) rl.setPrompt('ghax> ');
    if (isTTY) rl.prompt();
  };
  prompt();

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      prompt();
      continue;
    }
    if (line === 'exit' || line === 'quit') break;
    const argv = tokenizeShellLine(line);
    if (argv.length === 0) {
      prompt();
      continue;
    }
    if (argv[0] === 'shell') {
      console.error('ghax: already in shell mode');
      prompt();
      continue;
    }
    try {
      const code = await dispatch(argv);
      if (code !== EXIT.OK && !isTTY) {
        // Non-interactive stdin (scripted): propagate failures so wrappers
        // can react. Interactive users just see the error message and keep
        // going.
        rl.close();
        return code;
      }
    } catch (err: any) {
      console.error(`ghax: ${err?.message || err}`);
    }
    prompt();
  }
  return EXIT.OK;
}

/**
 * Tokenise a shell-ish command line into an argv array. Handles
 *   - single-quoted strings (literal, no escapes)
 *   - double-quoted strings (backslash-escapes for \", \\)
 *   - bare words split on whitespace
 * Intentionally minimal: no env var expansion, no glob, no pipes. Users
 * who need those can exit the shell and use a real one.
 */
function tokenizeShellLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let token = '';
    while (i < line.length && !/\s/.test(line[i])) {
      const c = line[i];
      if (c === "'") {
        i++;
        while (i < line.length && line[i] !== "'") {
          token += line[i];
          i++;
        }
        if (i < line.length) i++;
      } else if (c === '"') {
        i++;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < line.length) {
            token += line[i + 1];
            i += 2;
          } else {
            token += line[i];
            i++;
          }
        }
        if (i < line.length) i++;
      } else if (c === '\\' && i + 1 < line.length) {
        token += line[i + 1];
        i += 2;
      } else {
        token += c;
        i++;
      }
    }
    out.push(token);
  }
  return out;
}

async function crawlUrls(root: string, opts: { depth: number; limit: number }): Promise<string[]> {
  const origin = new URL(root).origin;
  const found = new Set<string>();

  const fromSitemap = await fetchSitemap(`${origin}/sitemap.xml`);
  if (fromSitemap.length > 0) {
    for (const u of fromSitemap) {
      try {
        if (new URL(u).origin === origin) found.add(u);
      } catch {
        // ignore malformed
      }
      if (found.size >= opts.limit) break;
    }
    return Array.from(found);
  }

  const queue: Array<{ url: string; depth: number }> = [{ url: root, depth: 0 }];
  const visited = new Set<string>();
  while (queue.length > 0 && found.size < opts.limit) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    found.add(url);
    if (depth >= opts.depth) continue;
    const links = await scrapeLinks(url, origin);
    for (const link of links) {
      if (!visited.has(link)) queue.push({ url: link, depth: depth + 1 });
      if (found.size + queue.length >= opts.limit) break;
    }
  }
  return Array.from(found).slice(0, opts.limit);
}

async function fetchSitemap(url: string): Promise<string[]> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const body = await resp.text();
    const matches = body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g);
    const out: string[] = [];
    for (const m of matches) out.push(m[1].trim());
    return out;
  } catch {
    return [];
  }
}

async function scrapeLinks(url: string, origin: string): Promise<string[]> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'ghax-qa-crawler/0.4' },
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const hrefs = new Set<string>();
    const matches = html.matchAll(/<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>/gi);
    for (const m of matches) {
      try {
        const abs = new URL(m[1], url).href;
        if (new URL(abs).origin === origin) {
          hrefs.add(abs.split('#')[0]);
        }
      } catch {
        // skip malformed href
      }
    }
    return Array.from(hrefs);
  } catch {
    return [];
  }
}

async function cmdGif(parsed: ParsedArgs): Promise<number> {
  const recFile = parsed.positional[0];
  const outGif = parsed.positional[1] ?? `/tmp/ghax-${Date.now()}.gif`;
  const delayMs = parsed.flags.delay ? Number(parsed.flags.delay) : 1000;
  const scale = parsed.flags.scale ? Number(parsed.flags.scale) : 800;
  if (!recFile) {
    console.error('Usage: ghax gif <recording-file> [out.gif] [--delay ms] [--scale px]');
    return EXIT.USAGE;
  }
  // Fail fast if ffmpeg isn't on PATH — we'd otherwise rack up frames for nothing.
  const probe = Bun.spawnSync(['ffmpeg', '-version'], { stdout: 'ignore', stderr: 'ignore' });
  if (probe.exitCode !== 0) {
    console.error('ghax gif: ffmpeg not found on PATH. Install via `brew install ffmpeg` (macOS) or your distro equivalent.');
    return EXIT.CDP_ERROR;
  }

  let steps: ChainStep[];
  try {
    const doc = JSON.parse(fs.readFileSync(recFile, 'utf-8'));
    steps = (doc.steps ?? doc) as ChainStep[];
  } catch (err: any) {
    console.error(`ghax gif: invalid recording — ${err.message}`);
    return EXIT.USAGE;
  }
  if (steps.length === 0) {
    console.error('ghax gif: recording has no steps');
    return EXIT.USAGE;
  }

  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'ghax-gif-'));
  console.log(`rendering ${steps.length} steps → ${outGif}`);

  return withDaemon(async (port) => {
    let frame = 0;
    const frameFile = () => path.join(tmpDir, `frame-${String(frame).padStart(4, '0')}.png`);

    // Capture initial state.
    await rpc(port, 'screenshot', [], { path: frameFile(), fullPage: false });
    frame++;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      try {
        await rpc(port, step.cmd, step.args ?? [], step.opts ?? {});
      } catch (err: any) {
        console.error(`step ${i + 1} (${step.cmd}) failed: ${err.message}`);
        return EXIT.CDP_ERROR;
      }
      // Wait for layout to settle — most UI transitions finish within ~200ms,
      // but animations (Framer, Radix) can still be painting at the moment
      // executeScript returns.
      await new Promise((r) => setTimeout(r, 250));
      await rpc(port, 'screenshot', [], { path: frameFile(), fullPage: false });
      frame++;
    }

    // ffmpeg: 2-pass palette for clean GIF colors.
    const palette = path.join(tmpDir, 'palette.png');
    const framePattern = path.join(tmpDir, 'frame-%04d.png');
    const framerate = Math.max(1, Math.round(1000 / delayMs));
    const paletteGen = Bun.spawnSync([
      'ffmpeg', '-y',
      '-framerate', String(framerate),
      '-i', framePattern,
      '-vf', `scale=${scale}:-1:flags=lanczos,palettegen`,
      palette,
    ], { stdout: 'ignore', stderr: 'pipe' });
    if (paletteGen.exitCode !== 0) {
      console.error('ffmpeg palettegen failed:', paletteGen.stderr.toString().split('\n').slice(-5).join('\n'));
      return EXIT.CDP_ERROR;
    }
    const render = Bun.spawnSync([
      'ffmpeg', '-y',
      '-framerate', String(framerate),
      '-i', framePattern,
      '-i', palette,
      '-lavfi', `scale=${scale}:-1:flags=lanczos [x]; [x][1:v] paletteuse`,
      '-loop', '0',
      outGif,
    ], { stdout: 'ignore', stderr: 'pipe' });
    if (render.exitCode !== 0) {
      console.error('ffmpeg render failed:', render.stderr.toString().split('\n').slice(-5).join('\n'));
      return EXIT.CDP_ERROR;
    }

    // Cleanup temp frames unless --keep-frames for debugging.
    if (!parsed.flags.keepFrames) {
      try {
        for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
        fs.rmdirSync(tmpDir);
      } catch {
        // best-effort
      }
    }
    const stat = fs.statSync(outGif);
    console.log(`✓ ${outGif} (${Math.round(stat.size / 1024)}KB, ${frame} frames)`);
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
    case 'dblclick':
      return makeSimple('gesture.dblclick')(parsed);
    case 'key':
      return makeSimple('gesture.key')(parsed);
    case 'scroll':
      return makeSimple('gesture.scroll')(parsed);
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
