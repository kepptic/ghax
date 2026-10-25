/**
 * ghax bridge simulator — state-machine tests with NO browser.
 *
 * The extension bridge previously had zero test coverage: the 95-check smoke
 * suite drives the CDP transport end to end, but every bridge code path was
 * verified only by hand against a real Edge. That's the wrong shape for a
 * state machine with reconnects, grace windows, and multi-peer arbitration —
 * those transitions are slow, racy, and destructive to reproduce by hand.
 *
 * The enabling insight: `Bridge` is a plain Node `ws` server. A "fake
 * extension" is just a WebSocket client that speaks the documented wire
 * protocol, so every transition is testable in-process, in milliseconds.
 *
 * Run: tsx test/bridge-sim.ts   (or `npm run test:bridge-sim`)
 * Exit 0 on success, non-zero on the first failed check.
 *
 * Grace/liveness windows are compressed to milliseconds via Bridge's
 * constructor options (NOT env vars — ESM hoists imports above any
 * process.env assignment here, so the module would read the defaults).
 */

// Never read the real machine's browser profiles: names come from hello only.
process.env.GHAX_BROWSER_PROFILE_ROOTS = '';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerDaemon } from '../src/config';
import {
  Bridge,
  BridgeInterrupted,
  BridgeTypedError,
  bridgeEvaluate,
  bridgeGuard,
  bridgeReleaseHandle,
  bridgeResolveHandle,
  bridgeRefStillMatches,
  bridgeSnapshot,
  isStaleContextError,
} from '../src/bridge';
import { CookieDeleteError, CookieVerifyError, deleteCookie, fromCdpCookie, listCookies, type Cookie, type CookieBackend } from '../src/cookies';
import { AuthExportError, exportAuth, writeSecretFile, type AuthSource } from '../src/auth-export';
import { recordableStep } from '../src/record-filter';
import { bridgeInputIO, dragPath, registerInput, type InputDeps, type InputOn, type InputSend, type Point } from '../src/input';
import { spawnSync } from 'child_process';
import { RefRegistry, docIdOfMarker } from '../src/ref-registry';
import { applyGrep, applySnapshotBudget, budgetFromOpts, DEFAULT_MAX_REFS, grepSnapshotLines } from '../src/snapshot-budget';

const GRACE_MS = 400;
const LIVENESS_MS = 600;

let failures = 0;
let checks = 0;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until `pred()` is true, or throw after `timeout`. */
async function until(pred: () => boolean, msg: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for: ${msg}`);
}

/**
 * A fake ghax bridge extension. Speaks the same wire protocol as
 * extension/background.js, and records the dispositions it was handed so
 * tests can assert on parked/bound/rejected without a browser.
 */
class FakeExt {
  ws: WebSocket | null = null;
  role: string | null = null;
  roleHistory: string[] = [];
  helloAcks = 0;
  rejected: string | null = null;
  closes = 0;
  helloSends = 0;
  /** CDP methods received, in order — proves replay happened (or didn't). */
  received: string[] = [];
  /** Control actions received, in order. */
  controls: string[] = [];
  /** Methods to never answer, to simulate a command in flight at drop time. */
  swallow = new Set<string>();
  /** Methods to answer with an error reply, keyed by the `phase` to report. */
  failWithPhase = new Map<string, string>();
  /**
   * Scripted CDP answers: return value becomes `result`; a throw becomes an
   * error reply with that message. Lets sims drive snapshot/guard code paths
   * that need real-looking results, not `{echoed}`.
   */
  replies = new Map<string, (params: any) => unknown>([
    // ghax's isolated world (finding 6): one frame, one world per "document".
    ['Page.getFrameTree', () => ({ frameTree: { frame: { id: 'main-frame' } } })],
    ['Page.createIsolatedWorld', () => ({ executionContextId: 700 + (++this.worldsCreated) })],
  ]);
  /** How many isolated worlds this fake has created. */
  worldsCreated = 0;
  /** Params of every CDP command received, in order. */
  sent: Array<{ method: string; params: any }> = [];
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly port: number,
    readonly instanceId: string,
    readonly browser = 'edge',
    readonly label = '',
    /** Real extensions ping every 15s; silence is what liveness hunts for. */
    readonly autoPing = true,
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('close', () => {
      this.closes++;
      if (this.ws === ws) this.ws = null;
      this.role = null;
      this.stopPing();
    });
    this.sendHello();
    if (this.autoPing) {
      // Mirror background.js's keepalive, scaled to the sim's liveness window.
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), Math.floor(LIVENESS_MS / 4));
      this.pingTimer.unref?.();
    }
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Set to send a pairToken in hello (for the pairing tests). */
  pairToken: string | null = null;
  /** Set to send gitSha/buildDate in hello (provenance tests) — a real
   * extension omits both when extension/build-info.json isn't built yet. */
  gitSha: string | null = null;
  buildDate: string | null = null;
  /** Set to send `profile`/`brandVersion` in hello, as a tab-identity-aware
   * extension does. Left null, hello carries only `label` (older builds). */
  profile: string | null = null;
  /** Set to send `sessionNonce` in hello. */
  sessionNonce: string | null = null;
  /** Set to a control action this fake should silently ignore — never ack,
   * never act — simulating an extension too old to have a `control` handler
   * at all. */
  ignoreControlAction: string | null = null;
  /** Set to a control action this fake should immediately reject with
   * "unknown control action" — simulating an extension that already has
   * handleControl's catch-all `else` branch but predates this specific
   * action. Verified live against a real (very stale) bridge extension:
   * this is the failure shape that actually shows up, not a silent hang. */
  rejectControlAction: string | null = null;

  sendHello(): void {
    this.helloSends++;
    this.send({
      type: 'hello',
      agent: 'ghax-ext',
      version: '0.2.0',
      instanceId: this.instanceId,
      browser: this.browser,
      label: this.label,
      ...(this.profile !== null ? { profile: this.profile, brandVersion: '150' } : {}),
      controlledTabId: 42,
      ...(this.sessionNonce !== null ? { sessionNonce: this.sessionNonce } : {}),
      ...(this.pairToken ? { pairToken: this.pairToken } : {}),
      ...(this.gitSha && this.buildDate ? { gitSha: this.gitSha, buildDate: this.buildDate } : {}),
    });
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'hello-ack') {
      this.helloAcks++;
      this.role = msg.role;
      this.roleHistory.push(msg.role);
      return;
    }
    if (msg.type === 'role') {
      this.role = msg.role;
      this.roleHistory.push(msg.role);
      return;
    }
    if (msg.type === 'hello-reject') {
      this.rejected = msg.message ?? 'rejected';
      return;
    }
    if (msg.type === 'pong' || msg.type === 'ping') return;
    if (msg.type === 'control') {
      this.controls.push(String(msg.action));
      if (msg.action === this.ignoreControlAction) return; // "too old to understand this" — no ack at all
      if (msg.action === this.rejectControlAction) {
        this.send({ type: 'control-ack', id: msg.id, ok: false, error: `unknown control action: ${msg.action}` });
        return;
      }
      if (msg.action === 'list-tabs') {
        this.send({
          type: 'control-ack', id: msg.id, ok: true, tabId: 42,
          result: [{ id: 42, title: `${this.instanceId} tab`, url: 'https://example.com', active: true }],
        });
        return;
      }
      // Answer control immediately so the daemon's resume sequence completes.
      this.send({ type: 'control-ack', id: msg.id, ok: true, tabId: 42 });
      return;
    }
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      this.received.push(msg.method);
      this.sent.push({ method: msg.method, params: msg.params ?? {} });
      if (this.swallow.has(msg.method)) return; // in flight forever
      const reply = this.replies.get(msg.method);
      if (reply) {
        try {
          this.send({ id: msg.id, result: reply(msg.params ?? {}) });
        } catch (err) {
          this.send({ id: msg.id, error: { message: (err as Error).message, phase: 'dispatch' } });
        }
        return;
      }
      const phase = this.failWithPhase.get(msg.method);
      if (phase) {
        this.send({ id: msg.id, error: { message: 'Detached while handling command.', phase } });
        return;
      }
      this.send({ id: msg.id, result: { echoed: msg.method } });
    }
  }

  send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /**
   * Simulate `chrome.runtime.reload()`: the socket dies, then the extension's
   * own reconnect logic (background.js) brings it back on the SAME
   * instanceId — chrome.storage.local survives a reload, unlike an in-memory
   * worker. Callers update `gitSha`/`buildDate` beforehand to model a rebuilt
   * extension/build-info.json taking effect.
   */
  async simulateReload(): Promise<void> {
    this.kill();
    await sleep(30);
    await this.connect();
  }

  /** Hard-kill the socket, the way an evicted MV3 worker would. */
  kill(): void {
    this.stopPing();
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.role = null;
  }
}

let nextPort = 19400;
async function withBridge(
  fn: (b: Bridge, port: number, logs: string[]) => Promise<void>,
  extraOpts: { pairCode?: string; settleMs?: number } = {},
): Promise<void> {
  const port = nextPort++;
  const logs: string[] = [];
  const bridge = new Bridge(port, (m) => logs.push(m), {
    graceMs: GRACE_MS,
    livenessMs: LIVENESS_MS,
    // 0 = first hello binds, which most checks here assume. The settle-window
    // checks pass their own.
    settleMs: 0,
    ...extraOpts,
  });
  try {
    await fn(bridge, port, logs);
  } finally {
    bridge.close();
    await sleep(20);
  }
}

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
  console.log('bridge simulator — no browser required\n');

  // Cookie logic is shared by both transports; the backend here fakes the
  // bridge's Network.getCookies / deleteCookies replies (CDP shape).
  const fakeCookies = (
    extra: Array<Record<string, unknown>> = [],
    opt: { noop?: boolean; base?: boolean } = {},
  ): { be: CookieBackend; removed: Array<Record<string, unknown>>; jar: Cookie[] } => {
    const base = opt.base === false ? [] : [
      { name: 'access', domain: 'app.example.com', path: '/', secure: true, sameSite: 'Lax', sourceScheme: 'Secure', sourcePort: 443 },
      { name: 'dup', domain: 'app.example.com', path: '/', secure: false },
      { name: 'dup', domain: '.example.com', path: '/', secure: false },
      { name: 'dup', domain: 'app.example.com', path: '/api', secure: false },
    ];
    const jar: Cookie[] = [...base, ...extra].map((c) => fromCdpCookie({ value: 'SECRET-VALUE-123', expires: -1, httpOnly: true, ...c }));
    const removed: Array<Record<string, unknown>> = [];
    return {
      removed,
      jar,
      be: {
        activeUrl: async () => 'https://app.example.com/',
        // A URL-scoped read only returns cookies sent to that URL (origin-bound scheme), as the browser does.
        list: async (urls) => jar.filter((c) => !urls || c.sourceScheme === undefined
          || urls.some((u) => (new URL(u).protocol === 'https:') === (c.sourceScheme === 'Secure'))),
        // Mimics Chromium: filter is name+domain+path(+partitionKey); scheme/port ignored.
        // Without a partitionKey only unpartitioned cookies match (the "skips partitioned" reading).
        remove: async (c) => {
          removed.push({ ...c });
          if (opt.noop) return;
          for (let i = jar.length - 1; i >= 0; i--) {
            const j = jar[i];
            const keyMatch = c.partitionKey === undefined
              ? j.partitionKey === undefined
              : JSON.stringify(j.partitionKey) === JSON.stringify(c.partitionKey);
            if (j.name === c.name && j.domain === c.domain && j.path === c.path && keyMatch) jar.splice(i, 1);
          }
        },
      },
    };
  };

  await test('cookies list redacts values by default and --values shows them', async () => {
    const { be } = fakeCookies();
    const red = JSON.stringify(await listCookies(be, {}));
    assert(!red.includes('SECRET-VALUE-123'), 'default listing leaked a value');
    assert(red.includes('<redacted, 16 chars>'), 'expected redaction marker');
    assert(JSON.stringify(await listCookies(be, { values: true })).includes('SECRET-VALUE-123'), '--values should show');
    const has = (await listCookies(be, { has: 'access' })) as { exists: boolean };
    assert(has.exists === true, '--has should find access');
  });

  await test('cookies delete removes exactly one unambiguous cookie', async () => {
    const { be, removed } = fakeCookies();
    const r = await deleteCookie(be, 'access', {});
    assert(removed.length === 1 && removed[0].name === 'access' && removed[0].domain === 'app.example.com', 'wrong removal');
    assert(!JSON.stringify(r).includes('SECRET'), 'delete report leaked a value');
  });

  await test('cookies delete refuses an ambiguous name and lists candidates without values', async () => {
    const { be, removed } = fakeCookies();
    let msg = '';
    try { await deleteCookie(be, 'dup', {}); } catch (e) { assert(e instanceof CookieDeleteError, 'wrong error type'); msg = (e as Error).message; }
    assert(msg.includes('matches 3 cookies'), `expected refusal, got: ${msg}`);
    assert(msg.includes('domain=.example.com') && msg.includes('path=/api'), 'candidates not listed');
    assert(!msg.includes('SECRET'), 'refusal leaked a value');
    assert(removed.length === 0, 'must not delete when ambiguous');
  });

  await test('cookies delete narrows by --domain (exact) and --path', async () => {
    const { be, removed } = fakeCookies();
    await deleteCookie(be, 'dup', { domain: 'example.com', path: '/' });
    assert(removed.length === 1 && removed[0].domain === '.example.com', `expected the .example.com one, got ${JSON.stringify(removed)}`);
    let threw = false;
    try { await deleteCookie(fakeCookies().be, 'dup', { domain: 'app.example.com' }); } catch { threw = true; }
    assert(threw, 'domain app.example.com still matches two paths and must refuse');
    const f = fakeCookies();
    await deleteCookie(f.be, 'dup', { domain: 'app.example.com', path: '/api' });
    assert(f.removed.length === 1 && f.removed[0].path === '/api', 'path narrowing failed');
  });

  await test('cookies delete on a missing name errors', async () => {
    let threw = false;
    try { await deleteCookie(fakeCookies().be, 'nope', {}); } catch (e) { threw = e instanceof CookieDeleteError; }
    assert(threw, 'expected CookieDeleteError');
  });

  await test('cookies delete refuses http+https cookies sharing name/domain/path', async () => {
    const f = fakeCookies([
      { name: 'sid', domain: 'a.test', path: '/', sourceScheme: 'Secure', sourcePort: 443 },
      { name: 'sid', domain: 'a.test', path: '/', sourceScheme: 'NonSecure', sourcePort: 80 },
    ], { base: false });
    let msg = '';
    try { await deleteCookie(f.be, 'sid', { url: 'https://a.test/' }); } catch (e) { assert(e instanceof CookieDeleteError, 'wrong error type'); msg = (e as Error).message; }
    assert(msg.includes('cannot delete just one'), `expected collision refusal, got: ${msg}`);
    assert(msg.includes('scheme=NonSecure') && msg.includes('port=80') && msg.includes('scheme=Secure'), 'siblings not listed');
    assert(!msg.includes('SECRET'), 'refusal leaked a value');
    assert(f.removed.length === 0 && f.jar.length === 2, 'must not delete on collision');
  });

  await test('cookies delete passes partitionKey for a partitioned cookie and verifies', async () => {
    const pk = { topLevelSite: 'https://top.test', hasCrossSiteAncestor: false };
    const f = fakeCookies([{ name: 'chips', domain: 'emb.test', path: '/', partitionKey: pk, sourceScheme: 'Secure', sourcePort: 443 }], { base: false });
    const r = await deleteCookie(f.be, 'chips', { all: true });
    assert(f.removed.length === 1 && JSON.stringify(f.removed[0].partitionKey) === JSON.stringify(pk), `partitionKey not passed: ${JSON.stringify(f.removed)}`);
    assert(r.deleted.length === 1 && f.jar.length === 0, 'cookie should be gone');
    assert(!JSON.stringify(r).includes('SECRET'), 'report leaked a value');
  });

  await test('cookies delete refuses an unpartitioned target that shares its triple with a partitioned cookie', async () => {
    const f = fakeCookies([
      { name: 'p', domain: 'emb.test', path: '/', partitionKey: { topLevelSite: 'https://one.test' } },
      { name: 'p', domain: 'emb.test', path: '/' },
    ], { base: false });
    // Unpartitioned target with a partitioned sibling: refused, since a key-less delete is ambiguous.
    let threw = false;
    try { await deleteCookie(f.be, 'p', { all: true }); } catch (e) { threw = e instanceof CookieDeleteError; }
    assert(threw, 'unpartitioned target with a partitioned sibling must refuse');
    assert(f.removed.length === 0, 'must not delete');
  });

  await test('cookies delete errors when the browser ignores the delete', async () => {
    const f = fakeCookies([], { noop: true });
    let err: unknown;
    try { await deleteCookie(f.be, 'access', {}); } catch (e) { err = e; }
    assert(err instanceof CookieVerifyError, `expected CookieVerifyError, got ${String(err)}`);
    assert(!(err instanceof CookieDeleteError), 'verify failure must not map to exit 2');
    assert((err as Error).message.includes('browser did not delete'), (err as Error).message);
    assert(!(err as Error).message.includes('SECRET'), 'leaked a value');
  });

  // `auth export`: the bridge source is the same fake CDP jar, plus a fake
  // controlled tab for localStorage. Files go to a fresh tmp dir (no git).
  const authTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghax-auth-sim-'));
  const authJar = () => [
    { name: 'sid', domain: 'app.example.com', path: '/', expires: 2000000000, sameSite: 'None', secure: true },
    { name: 'parent', domain: '.example.com', path: '/', expires: 1900000000 },
    { name: 'sso', domain: '.login.example.com', path: '/' },
    { name: 'chips', domain: 'emb.example.com', path: '/', partitionKey: { topLevelSite: 'https://top.test', hasCrossSiteAncestor: true } },
    { name: 'lookalike', domain: 'notexample.com', path: '/' },
    { name: 'other', domain: 'evil.test', path: '/' },
  ].map((c) => fromCdpCookie({ value: 'SECRET-VALUE-123', httpOnly: true, ...c }));
  const authSrc = (opt: { tabOrigin?: string } = {}): AuthSource & { reads: number } => {
    const src = {
      reads: 0,
      cookies: async () => { src.reads++; return authJar(); },
      localStorage: async (origin: string) => {
        if (origin !== (opt.tabOrigin ?? 'https://app.example.com')) throw new AuthExportError(`no open tab at ${origin}.`);
        return [{ name: 'token', value: 'SECRET-LS-456' }];
      },
    };
    return src;
  };
  const refusal = async (src: AuthSource, opts: Record<string, unknown>): Promise<string> => {
    try { await exportAuth(src, opts); } catch (e) { assert(e instanceof AuthExportError, `wrong error type: ${String(e)}`); return (e as Error).message; }
    throw new Error(`expected a refusal for ${JSON.stringify(opts)}`);
  };

  await test('auth export keeps only allow-listed domains, writes 0600, prints no values', async () => {
    const out = path.join(authTmp, 'a.json');
    const r = await exportAuth(authSrc(), { out, domain: 'app.example.com,.login.example.com,emb.example.com', origin: ['https://app.example.com/some/path'] });
    const text = JSON.stringify(r);
    assert(!text.includes('SECRET'), `result leaked a value: ${text}`);
    assert(r.cookies === 3, `expected 3 cookies, got ${r.cookies}`);
    assert(r.cookiesByDomain['app.example.com'] === 1 && r.cookiesByDomain['login.example.com'] === 1, text);
    assert(r.origins === 1 && r.localStorageKeys === 1 && r.partitionedCookies === 1, text);
    assert(r.earliestExpiry === new Date(2000000000 * 1000).toISOString(), `earliestExpiry ${r.earliestExpiry}`);
    assert((fs.statSync(out).mode & 0o777) === 0o600, `mode ${(fs.statSync(out).mode & 0o777).toString(8)}`);
    const state = JSON.parse(fs.readFileSync(out, 'utf8'));
    const names = state.cookies.map((c: { name: string }) => c.name).sort();
    assert(JSON.stringify(names) === '["chips","sid","sso"]', `cookies in file: ${names}`);
    const chips = state.cookies.find((c: { name: string }) => c.name === 'chips');
    assert(chips.partitionKey === 'https://top.test' && chips._crHasCrossSiteAncestor === true, `partitionKey shape: ${JSON.stringify(chips)}`);
    assert(state.cookies.every((c: Record<string, unknown>) => c.value === 'SECRET-VALUE-123' && ['Strict', 'Lax', 'None'].includes(String(c.sameSite)) && !('sourceScheme' in c)), 'Playwright cookie shape');
    assert(state.origins[0].origin === 'https://app.example.com' && state.origins[0].localStorage[0].value === 'SECRET-LS-456', 'origins');

    // The parent domain pulls in .example.com and every subdomain, never the lookalike.
    const out2 = path.join(authTmp, 'b.json');
    const r2 = await exportAuth(authSrc(), { out: out2, domain: ['example.com'] });
    assert(r2.cookies === 4 && r2.cookiesByDomain['example.com'] === 4, `parent allow-list: ${JSON.stringify(r2)}`);
    assert(!fs.readFileSync(out2, 'utf8').includes('lookalike'), 'notexample.com matched example.com');
  });

  await test('auth export refuses missing --domain/--out before reading any cookie', async () => {
    const src = authSrc();
    assert((await refusal(src, { out: path.join(authTmp, 'x.json') })).includes('--domain is required'), 'missing --domain');
    assert((await refusal(src, { out: path.join(authTmp, 'x.json'), domain: true })).includes('--domain is required'), 'valueless --domain');
    assert((await refusal(src, { domain: 'example.com' })).includes('--out <path> is required'), 'missing --out');
    assert((await refusal(src, { out: 'rel.json', domain: 'example.com' })).includes('absolute'), 'relative --out');
    assert((await refusal(src, { out: path.join(authTmp, 'x.json'), domain: 'com' })).includes('bare label'), 'bare TLD');
    assert((await refusal(src, { out: path.join(authTmp, 'x.json'), domain: 'https://example.com' })).includes('not a hostname'), 'scheme in --domain');
    assert((await refusal(src, { out: path.join(authTmp, 'x.json'), domain: 'example.com', origin: 'https://evil.test' })).includes('outside the --domain allow-list'), 'origin outside allow-list');
    assert((await refusal(src, { out: path.join(authTmp, 'nope', 'x.json'), domain: 'example.com' })).includes('does not exist'), 'missing dir');
    assert(src.reads === 0, `cookies were read ${src.reads}x before refusing`);
    assert(!fs.existsSync(path.join(authTmp, 'x.json')), 'a refused export wrote a file');
  });

  await test('auth export refuses an existing file without --force, symlinks even with it', async () => {
    const out = path.join(authTmp, 'exists.json');
    fs.writeFileSync(out, 'old', { mode: 0o644 });
    assert((await refusal(authSrc(), { out, domain: 'example.com' })).includes('--force'), 'existing file');
    assert(fs.readFileSync(out, 'utf8') === 'old', 'refusal touched the file');
    await exportAuth(authSrc(), { out, domain: 'example.com', force: true });
    assert((fs.statSync(out).mode & 0o777) === 0o600, '--force must chmod 0600');
    assert(JSON.parse(fs.readFileSync(out, 'utf8')).cookies.length === 4, '--force overwrite content');

    const victim = path.join(authTmp, 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    const link = path.join(authTmp, 'link.json');
    fs.symlinkSync(victim, link);
    assert((await refusal(authSrc(), { out: link, domain: 'example.com' })).includes('already exists'), 'symlink without --force');
    assert((await refusal(authSrc(), { out: link, domain: 'example.com', force: true })).includes('symlink'), 'symlink with --force');
    assert(fs.readFileSync(victim, 'utf8') === 'keep', 'wrote through a symlink');
  });

  await test('auth export refuses an un-gitignored path in a git work tree', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghax-auth-git-'));
    if (spawnSync('git', ['init', '-q', repo]).status !== 0) { console.log('    (git missing — skipped)'); return; }
    const msg = await refusal(authSrc(), { out: path.join(repo, 'auth.json'), domain: 'example.com' });
    assert(msg.includes('not gitignored'), msg);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'auth.json\n');
    const r = await exportAuth(authSrc(), { out: path.join(repo, 'auth.json'), domain: 'example.com' });
    assert(r.cookies === 4, 'ignored path should export');
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const leftovers = (dir: string) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  const withCookieHook = (hook: () => void): AuthSource => ({ ...authSrc(), cookies: async () => { hook(); return authJar(); } });

  await test('auth export --force replaces by rename: an open reader of the old file keeps the old bytes', async () => {
    const out = path.join(authTmp, 'inode.json');
    fs.writeFileSync(out, 'old-secret', { mode: 0o644 });
    const reader = fs.openSync(out, 'r');
    const oldIno = fs.fstatSync(reader).ino;
    await exportAuth(authSrc(), { out, domain: 'example.com', force: true });
    const buf = Buffer.alloc(32);
    const n = fs.readSync(reader, buf, 0, 32, 0);
    fs.closeSync(reader);
    assert(buf.toString('utf8', 0, n) === 'old-secret', 'old inode was modified in place');
    assert(fs.statSync(out).ino !== oldIno, 'target was not replaced by a new inode');
    assert((fs.statSync(out).mode & 0o777) === 0o600, 'new file not 0600');
    assert(leftovers(authTmp).length === 0, 'temp file left behind');
  });

  await test('auth export without --force loses a create race with EEXIST and leaves the winner intact', async () => {
    const out = path.join(authTmp, 'race.json');
    const msg = await refusal(withCookieHook(() => fs.writeFileSync(out, 'winner')), { out, domain: 'example.com' });
    assert(msg.includes('already exists'), msg);
    assert(fs.readFileSync(out, 'utf8') === 'winner', 'racing file was clobbered');
    assert(leftovers(authTmp).length === 0, 'temp file left behind');
  });

  await test('auth export --force swapped to a symlink mid-export is refused, victim and old file untouched', async () => {
    const out = path.join(authTmp, 'swap.json');
    const victim = path.join(authTmp, 'victim2.txt');
    fs.writeFileSync(victim, 'keep');
    const msg = await refusal(withCookieHook(() => fs.symlinkSync(victim, out)), { out, domain: 'example.com', force: true });
    assert(msg.includes('symlink'), msg);
    assert(fs.readFileSync(victim, 'utf8') === 'keep', 'wrote through the symlink');
    assert(fs.lstatSync(out).isSymbolicLink(), 'symlink was removed');
    assert(leftovers(authTmp).length === 0, 'temp file left behind');
  });

  await test('writeSecretFile: a failed forced write leaves the old file byte-identical', async () => {
    const out = path.join(authTmp, 'keep.json');
    fs.writeFileSync(out, 'precious', { mode: 0o644 });
    const ino = fs.statSync(out).ino;
    let threw = false;
    try { writeSecretFile(out, 'new', true, () => { throw new Error('boom'); }); } catch { threw = true; }
    assert(threw, 'beforeCommit failure should propagate');
    assert(fs.readFileSync(out, 'utf8') === 'precious' && fs.statSync(out).ino === ino, 'old file touched');
    assert(leftovers(authTmp).length === 0, 'temp file left behind');
  });

  await test('auth export refuses when the parent directory is swapped during the cookie read', async () => {
    const real = path.join(authTmp, 'p'); const moved = path.join(authTmp, 'p-moved'); const elsewhere = path.join(authTmp, 'elsewhere');
    fs.mkdirSync(real); fs.mkdirSync(elsewhere);
    const msg = await refusal(withCookieHook(() => { fs.renameSync(real, moved); fs.symlinkSync(elsewhere, real); }), {
      out: path.join(real, 'x.json'), domain: 'example.com',
    });
    assert(msg.includes('changed while exporting'), msg);
    assert(fs.readdirSync(elsewhere).length === 0 && fs.readdirSync(moved).length === 0, 'something was written after the swap');
  });

  await test('auth export git check fails closed (dubious ownership) and never runs repo-config commands', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghax-auth-git2-'));
    if (spawnSync('git', ['init', '-q', repo]).status !== 0) { console.log('    (git missing — skipped)'); return; }
    fs.writeFileSync(path.join(repo, '.gitignore'), 'auth.json\n');
    const marker = path.join(repo, 'fsmonitor-ran');
    const hook = path.join(repo, 'fsm.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    spawnSync('git', ['-C', repo, 'config', 'core.fsmonitor', hook]);
    const r = await exportAuth(authSrc(), { out: path.join(repo, 'auth.json'), domain: 'example.com' });
    assert(r.cookies === 4, 'ignored path should export');
    assert(!fs.existsSync(marker), 'repo core.fsmonitor ran');
    fs.rmSync(path.join(repo, 'auth.json'));
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    try {
      const msg = await refusal(authSrc(), { out: path.join(repo, 'auth.json'), domain: 'example.com' });
      assert(msg.includes('git could not check'), msg);
    } finally {
      delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    }
    assert(!fs.existsSync(path.join(repo, 'auth.json')), 'fail-closed refusal still wrote');
    fs.rmSync(repo, { recursive: true, force: true });
  });

  await test('record: a batch never carries auth.export (or other NEVER_RECORD steps) into a recording', async () => {
    const exp = { cmd: 'auth.export', args: [], opts: { out: '/x' } };
    const click = { cmd: 'click', args: ['@e1'] };
    assert(recordableStep('auth.export', [], {}) === null, 'plain auth.export recorded');
    assert(recordableStep('batch', [[exp]], {}) === null, 'all-excluded batch recorded');
    const mixed = recordableStep('batch', [[click, exp, { cmd: 'batch', args: [[exp, click]] }]], {});
    const steps = (mixed?.args[0] as Array<{ cmd: string }>) ?? [];
    assert(JSON.stringify(mixed).includes('auth.export') === false, 'auth.export survived in a batch');
    assert(steps.length === 2 && steps[0].cmd === 'click' && steps[1].cmd === 'batch', 'kept steps wrong');
    assert(typeof mixed?.note === 'string' && mixed.note.includes('2'), 'no drop note');
    assert(recordableStep('batch', [[click]], {})?.note === undefined, 'clean batch got a note');
  });

  await test('auth export refuses an --origin with no open tab and names no value', async () => {
    const msg = await refusal(authSrc({ tabOrigin: 'https://other.example.com' }), {
      out: path.join(authTmp, 'o.json'), domain: 'example.com', origin: 'https://app.example.com',
    });
    assert(msg.includes('no open tab at https://app.example.com') && !msg.includes('SECRET'), msg);
    assert(!fs.existsSync(path.join(authTmp, 'o.json')), 'refused export wrote a file');
    fs.rmSync(authTmp, { recursive: true, force: true });
  });

  // Regression: the self-heal in bridgeEval is gated on this predicate, so a
  // string it fails to match is a silent post-navigation failure for the user.
  // `uniqueContextId not found` is what Chrome returns for the pin bridge
  // evals actually use, and it was missing — see isStaleContextError.
  await test('isStaleContextError matches every real stale-pin string', async () => {
    for (const msg of [
      'uniqueContextId not found',
      'Cannot find context with specified id',
      'Execution context was destroyed.',
      'No execution context with given id found',
    ]) {
      assert(isStaleContextError(new Error(msg)), `should match: ${msg}`);
    }
    // Must not swallow unrelated failures into a retry.
    for (const msg of ['SyntaxError: Unexpected token', 'Target closed']) {
      assert(!isStaleContextError(new Error(msg)), `should NOT match: ${msg}`);
    }
  });

  // The extension's own predicates. Imported dynamically because
  // extension/errors.js is plain browser JS outside the tsconfig `include`.
  await test('extension predicates classify real chrome.debugger strings', async () => {
    const errors = await import(
      new URL('../extension/errors.js', import.meta.url).href
    ) as {
      isTemporarilyUnattachable: (e: unknown) => boolean;
      isDetachedMidCommand: (e: unknown) => boolean;
    };

    // Transient — absorbed by a pre-dispatch attach retry. The last two are
    // the ones the original `(?:chrome|edge):\/\/` pattern missed.
    for (const msg of [
      'Cannot attach to this target.',
      'Cannot access a chrome:// URL',
      'Cannot access a chrome-extension:// URL of different extension',
      'Cannot access a chrome-error:// URL',
      'No tab with given id 42',
    ]) {
      assert(errors.isTemporarilyUnattachable(new Error(msg)), `should be transient: ${msg}`);
    }
    // A real page must never look unattachable, or every failure retries.
    for (const msg of ['SyntaxError: Unexpected token', 'Cannot access https://example.com']) {
      assert(!errors.isTemporarilyUnattachable(new Error(msg)), `should NOT be transient: ${msg}`);
    }

    // Mid-dispatch detach is the UNSAFE case — it must not be confused for a
    // transient refusal, or a click could be replayed after it already landed.
    assert(errors.isDetachedMidCommand(new Error('Detached while handling command.')), 'detach not classified');
    assert(
      !errors.isTemporarilyUnattachable(new Error('Detached while handling command.')),
      'a mid-dispatch detach must NOT be treated as a safe pre-dispatch retry',
    );

    // The foreign-frame case. It LOOKS like the transient one and is not
    // always: a page holding another extension's frame stays unattachable
    // until the bridge strips the frame, so this must stay distinguishable for
    // the strip path and for the daemon to advise correctly (bridgeError).
    const permanent = 'Cannot access a chrome-extension:// URL of different extension';
    assert(
      /chrome-extension:\/\/ URL of different extension/i.test(permanent),
      'the permanent-refusal string must stay distinct from "Cannot access chrome:// and edge:// URLs"',
    );
    assert(
      !/chrome-extension:\/\/ URL of different extension/i.test('Cannot access chrome:// and edge:// URLs'),
      'the browser-internal-page string must NOT match the extension-frame case',
    );
  });

  // Foreign extension frames (Hudu Assist on Autotask): the extension strips
  // them and retries the attach. background.js can't be imported in Node
  // (chrome.* at module scope), so these drive the exact helpers it calls.
  type StripErrors = {
    isForeignExtensionFrameError: (e: unknown) => boolean;
    attachStrippingForeignFrames: (o: {
      attach: () => Promise<unknown>;
      strip: () => Promise<string[]>;
      detach?: () => Promise<unknown> | unknown;
      stillWanted?: () => boolean;
      sleep?: (ms: number) => Promise<void>;
      log?: (hosts: string[]) => void;
      maxTries?: number;
    }) => Promise<unknown>;
    stripForeignExtensionFrames: (ownId: string) => string[];
  };
  const loadStrip = async (): Promise<StripErrors> => await import(
    new URL('../extension/errors.js', import.meta.url).href
  ) as StripErrors;
  const FRAME_ERR = 'Cannot access a chrome-extension:// URL of different extension';

  await test('foreign-frame predicate matches only the different-extension refusal', async () => {
    const e = await loadStrip();
    assert(e.isForeignExtensionFrameError(new Error(FRAME_ERR)), 'should match the refusal');
    for (const msg of ['Cannot access chrome:// and edge:// URLs', 'Cannot attach to this target.', 'Cannot access a chrome-error:// URL']) {
      assert(!e.isForeignExtensionFrameError(new Error(msg)), `should NOT match: ${msg}`);
    }
  });

  await test('foreign-frame refusal: strip, then the retried attach succeeds', async () => {
    const e = await loadStrip();
    let attaches = 0;
    let strips = 0;
    const sleeps: number[] = [];
    const logged: string[][] = [];
    const out = await e.attachStrippingForeignFrames({
      attach: async () => {
        attaches++;
        if (attaches === 1) throw new Error(FRAME_ERR);
        return 'attached';
      },
      strip: async () => { strips++; return ['hudu-assist-id']; },
      sleep: async (ms) => { sleeps.push(ms); },
      log: (hosts) => { logged.push(hosts); },
    });
    assert(out === 'attached', `attach result should pass through, got ${String(out)}`);
    assert(attaches === 2 && strips === 1, `want 2 attaches / 1 strip, got ${attaches} / ${strips}`);
    assert(JSON.stringify(sleeps) === '[75]', `want one 75 ms backoff, got ${JSON.stringify(sleeps)}`);
    assert(JSON.stringify(logged) === '[["hudu-assist-id"]]', `removed hosts should be logged, got ${JSON.stringify(logged)}`);
  });

  await test('foreign-frame refusal that persists surfaces the original error', async () => {
    const e = await loadStrip();
    const original = new Error(FRAME_ERR);
    let attaches = 0;
    let strips = 0;
    const sleeps: number[] = [];
    let caught: unknown = null;
    try {
      await e.attachStrippingForeignFrames({
        attach: async () => {
          attaches++;
          throw attaches === 1 ? original : new Error(FRAME_ERR);
        },
        strip: async () => { strips++; return ['hudu-assist-id']; },
        sleep: async (ms) => { sleeps.push(ms); },
      });
    } catch (err) {
      caught = err;
    }
    assert(caught === original, `the ORIGINAL refusal must surface, got ${String(caught)}`);
    assert(attaches === 5, `want 1 attach + 4 retries, got ${attaches}`);
    assert(strips === 4, `each refused retry but the last re-strips, want 4 strips, got ${strips}`);
    assert(JSON.stringify(sleeps) === '[75,150,225,300]', `want 75*(n+1) backoff, got ${JSON.stringify(sleeps)}`);

    // Nothing removed (kill switch, not our tab, no frame found): no retry.
    attaches = 0;
    caught = null;
    try {
      await e.attachStrippingForeignFrames({
        attach: async () => { attaches++; throw original; },
        strip: async () => [],
        sleep: async () => { throw new Error('must not back off when nothing was removed'); },
      });
    } catch (err) {
      caught = err;
    }
    assert(caught === original && attaches === 1, `nothing stripped must rethrow at once, got ${attaches} attaches`);

    // A strip that throws (executeScript refused) behaves like nothing removed.
    caught = null;
    try {
      await e.attachStrippingForeignFrames({
        attach: async () => { throw original; },
        strip: async () => { throw new Error('Cannot access contents of the page'); },
      });
    } catch (err) {
      caught = err;
    }
    assert(caught === original, 'a failed strip must surface the original refusal, not its own error');

    // Any other attach failure never triggers a strip.
    caught = null;
    try {
      await e.attachStrippingForeignFrames({
        attach: async () => { throw new Error('No tab with given id 7'); },
        strip: async () => { throw new Error('must not strip for an unrelated error'); },
      });
    } catch (err) {
      caught = err;
    }
    assert(/No tab with given id/.test(String(caught)), `unrelated error must pass through, got ${String(caught)}`);
  });

  await test('foreign-frame retry stops when the tab stops being wanted during the backoff', async () => {
    const e = await loadStrip();
    const original = new Error(FRAME_ERR);
    let attaches = 0;
    let strips = 0;
    let detaches = 0;
    let wanted = true;
    let caught: unknown = null;
    try {
      await e.attachStrippingForeignFrames({
        attach: async () => { attaches++; throw attaches === 1 ? original : new Error(FRAME_ERR); },
        strip: async () => { strips++; return ['hudu-assist-id']; },
        detach: async () => { detaches++; },
        // The connection gives the tab up while the first backoff sleeps.
        sleep: async () => { wanted = false; },
        stillWanted: () => wanted,
      });
    } catch (err) {
      caught = err;
    }
    assert(caught === original, `the ORIGINAL refusal must surface, got ${String(caught)}`);
    assert(attaches === 1, `no retry attach once the tab is not wanted, got ${attaches} attaches`);
    assert(strips === 1, `no strip after the tab is not wanted (only the first), got ${strips} strips`);
    assert(detaches === 0, `nothing was attached, so nothing to detach, got ${detaches}`);

    // Gives it up between a refused retry and the next strip: no further strip.
    attaches = 0;
    strips = 0;
    wanted = true;
    caught = null;
    try {
      await e.attachStrippingForeignFrames({
        attach: async () => {
          attaches++;
          if (attaches === 2) wanted = false;
          throw attaches === 1 ? original : new Error(FRAME_ERR);
        },
        strip: async () => { strips++; return ['hudu-assist-id']; },
        sleep: async () => undefined,
        stillWanted: () => wanted,
      });
    } catch (err) {
      caught = err;
    }
    assert(caught === original, `the ORIGINAL refusal must surface, got ${String(caught)}`);
    assert(attaches === 2 && strips === 1, `want 2 attaches / 1 strip, got ${attaches} / ${strips}`);

    // Not wanted before the first strip: the page is not touched at all.
    strips = 0;
    caught = null;
    try {
      await e.attachStrippingForeignFrames({
        attach: async () => { throw original; },
        strip: async () => { strips++; return ['hudu-assist-id']; },
        stillWanted: () => false,
      });
    } catch (err) {
      caught = err;
    }
    assert(caught === original && strips === 0, `an unwanted tab must not be stripped, got ${strips} strips`);
  });

  await test('foreign-frame retry that lands after the tab was given up is detached', async () => {
    const e = await loadStrip();
    const original = new Error(FRAME_ERR);
    let attaches = 0;
    let detaches = 0;
    let wanted = true;
    let caught: unknown = null;
    try {
      await e.attachStrippingForeignFrames({
        attach: async () => {
          attaches++;
          if (attaches === 1) throw original;
          // The retry succeeds, but the connection lost the tab while it ran.
          wanted = false;
        },
        strip: async () => ['hudu-assist-id'],
        detach: async () => { detaches++; },
        sleep: async () => undefined,
        stillWanted: () => wanted,
      });
    } catch (err) {
      caught = err;
    }
    assert(caught === original, `the ORIGINAL refusal must surface, got ${String(caught)}`);
    assert(attaches === 2, `want 1 attach + 1 successful retry, got ${attaches}`);
    assert(detaches === 1, `the orphaned session must be detached once, got ${detaches}`);

    // A detach that throws must not mask the original error.
    attaches = 0;
    wanted = true;
    caught = null;
    try {
      await e.attachStrippingForeignFrames({
        attach: async () => { attaches++; if (attaches === 1) throw original; wanted = false; },
        strip: async () => ['hudu-assist-id'],
        detach: async () => { throw new Error('No tab with given id'); },
        sleep: async () => undefined,
        stillWanted: () => wanted,
      });
    } catch (err) {
      caught = err;
    }
    assert(caught === original, `a failing detach must not replace the original error, got ${String(caught)}`);
  });

  await test('frame stripper removes other extensions\' iframes, incl. closed shadow roots', async () => {
    const e = await loadStrip();
    type El = { tagName: string; src?: string; removed: boolean; shadow?: Root; closed?: boolean;
      getAttribute: (n: string) => string | null; remove: () => void; shadowRoot: Root | null };
    type Root = { querySelectorAll: (sel: string) => El[] };
    const el = (tagName: string, opt: { src?: string; shadow?: Root; closed?: boolean } = {}): El => {
      const x: El = {
        tagName, src: opt.src, removed: false, shadow: opt.shadow, closed: opt.closed,
        getAttribute: (n) => (n === 'src' ? x.src ?? null : null),
        remove: () => { x.removed = true; },
        get shadowRoot() { return x.closed ? null : x.shadow ?? null; },
      };
      return x;
    };
    const root = (els: El[]): Root => ({ querySelectorAll: () => els });
    const foreignTop = el('IFRAME', { src: 'chrome-extension://huduassist/widget.html' });
    const own = el('IFRAME', { src: 'chrome-extension://ghaxself/x.html' });
    const web = el('IFRAME', { src: 'https://ww14.autotask.net/frame' });
    const relative = el('IFRAME', { src: '/relative' });
    const foreignClosed = el('IFRAME', { src: 'chrome-extension://otherext/panel.html' });
    const foreignOpen = el('IFRAME', { src: 'chrome-extension://thirdext/p.html' });
    const closedHost = el('HUDU-ASSIST', { shadow: root([foreignClosed]), closed: true });
    const openHost = el('DIV', { shadow: root([foreignOpen]) });
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, chrome: g.chrome, location: g.location };
    try {
      g.document = root([foreignTop, own, web, relative, closedHost, openHost]);
      g.location = { href: 'https://ww14.autotask.net/Mvc/Framework/Navigation.mvc' };
      g.chrome = { dom: { openOrClosedShadowRoot: (x: El) => x.shadow ?? null } };
      const hosts = e.stripForeignExtensionFrames('ghaxself');
      assert(JSON.stringify(hosts) === '["huduassist","otherext","thirdext"]', `removed hosts wrong: ${JSON.stringify(hosts)}`);
      assert(foreignTop.removed && foreignClosed.removed && foreignOpen.removed, 'every foreign extension frame must go');
      assert(!own.removed && !web.removed && !relative.removed, 'our own frame and web frames must stay');

      // Without chrome.dom, closed roots are out of reach; open ones still walk.
      foreignOpen.removed = false;
      foreignClosed.removed = false;
      foreignTop.removed = false;
      g.chrome = {};
      const fallback = e.stripForeignExtensionFrames('ghaxself');
      assert(JSON.stringify(fallback) === '["huduassist","thirdext"]', `fallback hosts wrong: ${JSON.stringify(fallback)}`);
      assert(!foreignClosed.removed, 'a closed root must be unreachable without chrome.dom');
    } finally {
      g.document = saved.document;
      g.chrome = saved.chrome;
      g.location = saved.location;
    }
  });

  // The `phase` field is only worth carrying if it changes what happens: a
  // dispatch-phase detach must arrive as BridgeInterrupted so daemon.ts's
  // retry-class table sees it, while an attach-phase failure must stay a
  // plain error (the command never ran — nothing ambiguous to report).
  await test('dispatch-detached maps to BridgeInterrupted, attach does not', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-a');
      await ext.connect();
      await until(() => bridge.connected, 'bridge to connect');

      ext.failWithPhase.set('Input.dispatchMouseEvent', 'dispatch-detached');
      let caught: unknown = null;
      try {
        await bridge.send('Input.dispatchMouseEvent', {});
      } catch (err) { caught = err; }
      assert(
        caught instanceof BridgeInterrupted,
        `dispatch-detached should be BridgeInterrupted, got ${caught}`,
      );

      ext.failWithPhase.set('DOM.getBoxModel', 'attach');
      caught = null;
      try {
        await bridge.send('DOM.getBoxModel', {});
      } catch (err) { caught = err; }
      assert(caught instanceof Error, 'attach phase should still reject');
      assert(
        !(caught instanceof BridgeInterrupted),
        'an attach-phase failure must NOT claim the action may have landed',
      );
    });
  });

  await test('stats: per-method counters and reset', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-stats');
      await ext.connect();
      await until(() => bridge.connected, 'bridge to connect');
      await bridge.send('DOM.resolveNode', {});
      await bridge.send('DOM.resolveNode', {});
      await bridge.send('Runtime.evaluate', {});
      ext.failWithPhase.set('DOM.getBoxModel', 'attach');
      await bridge.send('DOM.getBoxModel', {}).catch(() => undefined);
      await sleep(5);
      const s = bridge.stats();
      assert(s.methods['DOM.resolveNode']?.calls === 2, `resolveNode calls: ${JSON.stringify(s.methods)}`);
      assert(s.methods['Runtime.evaluate']?.calls === 1, 'evaluate counted once');
      assert(s.methods['DOM.getBoxModel']?.errors === 1, 'a failed call counts as an error');
      assert(s.methods['DOM.resolveNode'].totalMs >= 0 && s.methods['DOM.resolveNode'].maxMs >= 0, 'timings present');
      bridge.resetStats();
      const after = bridge.stats();
      assert(Object.keys(after.methods).length === 0, 'reset clears every method');
      assert(after.since >= s.since, 'reset moves the since marker');
    });
  });

  // ─── Actionability guard (plan 10, C5) ─────────────────────────
  // The in-page logic needs a real DOM (bridge-live covers it); these pin the
  // daemon side: CDP failure shapes map to typed errors, the guard verdict
  // becomes BRIDGE_TARGET_NOT_ACTIONABLE naming the coverer, --force is
  // carried into the page, and a guarded click stays at three relayed calls.
  const guardedExt = async (port: number, verdict: Record<string, unknown>) => {
    const ext = new FakeExt(port, 'inst-guard');
    ext.replies.set('DOM.resolveNode', () => ({ object: { objectId: 'obj-1' } }));
    ext.replies.set('Runtime.callFunctionOn', () => ({ result: { value: { guard: verdict } } }));
    ext.replies.set('Runtime.releaseObject', () => ({}));
    await ext.connect();
    return ext;
  };

  await test('guard: a gone backend node becomes BRIDGE_REF_STALE', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-stale');
      ext.replies.set('DOM.resolveNode', () => { throw new Error('No node with given id found'); });
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      let caught: unknown = null;
      await bridgeResolveHandle(bridge.pinned(), { backendNodeId: 77, role: 'button', name: 'Save' }, '@e3')
        .catch((e) => { caught = e; });
      assert(caught instanceof BridgeTypedError, `expected typed error, got ${caught}`);
      const e = caught as BridgeTypedError;
      assert(e.code === 'BRIDGE_REF_STALE', `code ${e.code}`);
      assert(/@e3 is gone/.test(e.hint) && /snapshot -i/.test(e.hint), `hint: ${e.hint}`);
    });
  });

  await test('guard: covered target names the coverer and suggests --force', async () => {
    await withBridge(async (bridge, port) => {
      const ext = await guardedExt(port, {
        ok: false, reason: 'covered', coveredBy: 'div#overlay "Accept cookies"', x: 10, y: 10, width: 5, height: 5,
      });
      await until(() => bridge.connected, 'bind');
      const h = await bridgeResolveHandle(bridge.pinned(), { backendNodeId: 5, role: 'button', name: 'Buy' }, '@e7');
      let caught: unknown = null;
      await bridgeGuard(bridge.pinned(), h, '@e7', 'click', false).catch((e) => { caught = e; });
      bridgeReleaseHandle(bridge.pinned(), h);
      assert(caught instanceof BridgeTypedError, `expected typed error, got ${caught}`);
      const e = caught as BridgeTypedError;
      assert(e.code === 'BRIDGE_TARGET_NOT_ACTIONABLE', `code ${e.code}`);
      assert(e.message.includes('div#overlay'), `message should name the coverer: ${e.message}`);
      assert(/--force/.test(e.hint) && e.hint.includes('div#overlay'), `hint: ${e.hint}`);
      assert(e.details?.reason === 'covered', `details: ${JSON.stringify(e.details)}`);
      await sleep(10);
      const worldSetup = new Set(['Page.getFrameTree', 'Page.createIsolatedWorld']);
      assert(
        ext.received.filter((m) => !worldSetup.has(m)).join(',') === 'DOM.resolveNode,Runtime.callFunctionOn,Runtime.releaseObject',
        `a guarded click costs resolve + one in-page call + release, got ${ext.received.join(',')}`,
      );
      const resolve = ext.sent.find((c) => c.method === 'DOM.resolveNode');
      assert(typeof resolve?.params.executionContextId === 'number', 'the guard handle must live in the ghax isolated world');
    });
  });

  await test('guard: disabled and detached map to the right codes', async () => {
    await withBridge(async (bridge, port) => {
      const ext = await guardedExt(port, { ok: false, reason: 'disabled' });
      await until(() => bridge.connected, 'bind');
      const h = await bridgeResolveHandle(bridge.pinned(), { backendNodeId: 5, role: 'button', name: 'Go' }, '@e2');
      let caught: any = null;
      await bridgeGuard(bridge.pinned(), h, '@e2', 'click', false).catch((e) => { caught = e; });
      assert(caught?.code === 'BRIDGE_TARGET_NOT_ACTIONABLE' && /disabled/.test(caught.hint), `disabled: ${caught?.hint}`);
      ext.replies.set('Runtime.callFunctionOn', () => ({ result: { value: { guard: { ok: false, reason: 'detached' } } } }));
      caught = null;
      await bridgeGuard(bridge.pinned(), h, '@e2', 'fill', false).catch((e) => { caught = e; });
      assert(caught?.code === 'BRIDGE_REF_STALE', `detached should read as stale, got ${caught?.code}`);
    });
  });

  await test('guard: --force is carried into the in-page call', async () => {
    await withBridge(async (bridge, port) => {
      const ext = await guardedExt(port, { ok: true, x: 40, y: 20, width: 80, height: 40 });
      await until(() => bridge.connected, 'bind');
      const h = await bridgeResolveHandle(bridge.pinned(), { backendNodeId: 5, role: 'button', name: 'Go' }, '@e1');
      const { guard } = await bridgeGuard(bridge.pinned(), h, '@e1', 'click', true);
      assert(guard.x === 40 && guard.y === 20, `click point from the guard: ${JSON.stringify(guard)}`);
      const call = ext.sent.find((c) => c.method === 'Runtime.callFunctionOn');
      assert(call, 'no callFunctionOn sent');
      assert(call.params.arguments[0].value === 'click', `kind arg: ${JSON.stringify(call.params.arguments)}`);
      assert(call.params.arguments[1].value === true, 'force must reach the page');
      assert(/function actionability\(/.test(call.params.functionDeclaration), 'guard source must be inlined');
    });
  });

  // ─── Input verbs (src/input.ts) over the bridge ───────────────
  /**
   * The real input.ts handlers, wired to a FakeExt the way daemon.ts wires
   * them: every send goes through the pinned peer, refs resolve to one fake
   * backend node.
   */
  const inputHandlers = (bridge: Bridge) => {
    const handlers = new Map<string, (ctx: { bridgeMode: boolean }, args: unknown[], opts: Record<string, unknown>) => Promise<unknown>>();
    const deps: InputDeps<{ bridgeMode: boolean }> = {
      register: (name, fn) => { handlers.set(name, fn); },
      withInput: (_ctx, fn) => { const io = bridgeInputIO(bridge.pinned()); return fn(io.send, io.on); },
      verbBridge: () => bridge.pinned(),
      resolveBridgeTarget: async () => ({ backendNodeId: 5, role: 'button', name: 'Go' }),
      resolveRef: async () => { throw new Error('CDP path not under test'); },
      activePage: async () => { throw new Error('CDP path not under test'); },
      requireTarget: (verb, target) => { if (!target) throw new Error(`${verb}: target is empty`); },
      parseGesturePoint: (spec) => { const [x, y] = spec.split(',').map(Number); return { x, y }; },
    };
    registerInput(deps);
    const run = (name: string, args: unknown[], opts: Record<string, unknown> = {}) => {
      const fn = handlers.get(name);
      if (!fn) throw new Error(`input.ts registered no ${name}`);
      return fn({ bridgeMode: true }, args, opts);
    };
    return { run };
  };
  const mouseEvents = (ext: FakeExt) => ext.sent.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params);

  await test('input: hover ends in exactly one mouseMoved at the guard point', async () => {
    await withBridge(async (bridge, port) => {
      const ext = await guardedExt(port, { ok: true, x: 40, y: 20, width: 80, height: 40 });
      await until(() => bridge.connected, 'bind');
      const out = await inputHandlers(bridge).run('hover', ['@e1']) as { ok: boolean; x: number; y: number };
      assert(out.ok && out.x === 40 && out.y === 20, `hover result: ${JSON.stringify(out)}`);
      const guard = ext.sent.find((c) => c.method === 'Runtime.callFunctionOn');
      assert(guard?.params.arguments[0].value === 'click', 'hover aims through the click guard');
      const ev = mouseEvents(ext);
      assert(ev.length === 1 && ev[0].type === 'mouseMoved' && ev[0].x === 40 && ev[0].y === 20,
        `one mouseMoved at 40,20, got ${JSON.stringify(ev)}`);
      assert(ev[0].button === undefined, 'hover presses no button');
      assert(ext.received.at(-1) === 'Input.dispatchMouseEvent', `nothing after the move: ${ext.received.join(',')}`);
    });
  });

  await test('input: gesture rightclick sends button right, tripleclick clickCount 1..3', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-input');
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const { run } = inputHandlers(bridge);
      await run('gesture.rightclick', ['10,20']);
      let ev = mouseEvents(ext);
      assert(ev.map((e) => e.type).join(',') === 'mouseMoved,mousePressed,mouseReleased', `rightclick: ${JSON.stringify(ev)}`);
      assert(ev[1].button === 'right' && ev[1].buttons === 2 && ev[2].button === 'right', `right button: ${JSON.stringify(ev)}`);
      ext.sent.length = 0;
      await run('gesture.tripleclick', ['10,20']);
      ev = mouseEvents(ext);
      const pressed = ev.filter((e) => e.type === 'mousePressed').map((e) => e.clickCount);
      const released = ev.filter((e) => e.type === 'mouseReleased').map((e) => e.clickCount);
      assert(pressed.join(',') === '1,2,3' && released.join(',') === '1,2,3', `clickCount 1..3: ${JSON.stringify(ev)}`);
      assert(ev.every((e) => e.type === 'mouseMoved' || e.button === 'left'), 'tripleclick is a left click');
      ext.sent.length = 0;
      // dblclick keeps its old sequence: move, then pressed/released with 1 then 2.
      await run('gesture.dblclick', ['10,20']);
      ev = mouseEvents(ext);
      assert(ev.map((e) => `${e.type}:${e.clickCount ?? ''}`).join(',') === 'mouseMoved:,mousePressed:1,mouseReleased:1,mousePressed:2,mouseReleased:2',
        `dblclick: ${JSON.stringify(ev)}`);
      let caught: any = null;
      await run('gesture.click', ['10,20'], { button: 'back' }).catch((e) => { caught = e; });
      assert(caught?.exitCode === 2 && /--button/.test(caught.message), `bad --button is a usage error: ${caught?.message}`);
    });
  });

  await test('input: drag finishes an intercepted HTML5 drag with drag events, then disables interception', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-drag');
      ext.replies.set('Runtime.evaluate', () => ({ result: { value: { w: 800, h: 600, sx: 0, sy: 0 } } }));
      let pressed = false;
      let emitted = false;
      ext.replies.set('Input.dispatchMouseEvent', (p) => {
        if (p.type === 'mousePressed') pressed = true;
        // Chromium starts the drag on the first move after the press. The
        // event goes out before the reply, as a real relay can order it.
        if (p.type === 'mouseMoved' && pressed && !emitted) {
          emitted = true;
          ext.send({ type: 'event', method: 'Input.dragIntercepted', params: { data: { items: [{ mimeType: 'text/plain', data: 'card-1' }], dragOperationsMask: 1 } } });
        }
        return {};
      });
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const out = await inputHandlers(bridge).run('drag', ['0,0', '100,50'], { steps: '4' }) as Record<string, any>;
      assert(out.ok && out.html5 === true && out.mode === 'auto', `drag result: ${JSON.stringify(out)}`);
      assert(out.to.x === 100 && out.to.y === 50, `to point: ${JSON.stringify(out.to)}`);
      const seq = ext.sent.filter((c) => c.method.startsWith('Input.')).map((c) =>
        c.method === 'Input.dispatchMouseEvent' ? c.params.type
          : c.method === 'Input.dispatchDragEvent' ? c.params.type
            : `intercept:${c.params.enabled}`);
      assert(seq.join(',') === 'intercept:true,mouseMoved,mousePressed,mouseMoved,dragEnter,dragOver,drop,intercept:false',
        `drag order: ${seq.join(',')}`);
      const drops = ext.sent.filter((c) => c.method === 'Input.dispatchDragEvent');
      assert(drops.every((c) => c.params.x === 100 && c.params.y === 50 && c.params.data?.items?.[0]?.data === 'card-1'),
        `drag events carry the intercepted data at 'to': ${JSON.stringify(drops.map((c) => c.params))}`);
    });
  });

  await test('input: drag with no intercept is a plain mouse drag; --mode html5 fails but still disables', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-drag2');
      ext.replies.set('Runtime.evaluate', () => ({ result: { value: { w: 800, h: 600, sx: 0, sy: 0 } } }));
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const { run } = inputHandlers(bridge);
      const out = await run('drag', ['0,0', '30,0'], { steps: '3' }) as Record<string, any>;
      assert(out.html5 === false, `no intercept = mouse drag: ${JSON.stringify(out)}`);
      const ev = mouseEvents(ext);
      assert(ev.map((e) => e.type).join(',') === 'mouseMoved,mousePressed,mouseMoved,mouseMoved,mouseMoved,mouseReleased', `mouse drag: ${JSON.stringify(ev)}`);
      assert(ev.slice(2, 5).every((e) => e.buttons === 1), 'moves carry the held button');
      assert(ev[5].x === 30 && ev[5].y === 0, 'release at to');
      assert(ext.received.at(-1) === 'Input.setInterceptDrags', `interception off last: ${ext.received.join(',')}`);
      ext.sent.length = 0;
      let caught: any = null;
      await run('drag', ['0,0', '30,0'], { mode: 'html5', steps: '1' }).catch((e) => { caught = e; });
      assert(caught && /no HTML5 drag/.test(caught.message), `html5 without intercept fails: ${caught?.message}`);
      const last = ext.sent.at(-1);
      assert(last?.method === 'Input.setInterceptDrags' && last.params.enabled === false, 'finally disables interception');
      assert(mouseEvents(ext).at(-1)?.type === 'mouseReleased', 'the button is released before failing');
      ext.sent.length = 0;
      await run('drag', ['0,0', '30,0'], { mode: 'mouse', steps: '1' });
      assert(!ext.sent.some((c) => c.method === 'Input.setInterceptDrags'), '--mode mouse never touches interception');
      caught = null;
      await run('drag', ['0,0', '30,0'], { mode: 'fling' }).catch((e) => { caught = e; });
      assert(caught?.exitCode === 2, `bad --mode is a usage error: ${caught?.message}`);
    });
  });

  await test('input: a send that throws after the press still releases the button, and the original error wins', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-drag-err');
      ext.replies.set('Runtime.evaluate', () => ({ result: { value: { w: 800, h: 600, sx: 0, sy: 0 } } }));
      let pressed = false;
      let failed = false;
      ext.replies.set('Input.dispatchMouseEvent', (p) => {
        if (p.type === 'mousePressed') pressed = true;
        // The first move after the press dies (a dropped relay, a closed tab).
        if (p.type === 'mouseMoved' && pressed && !failed) { failed = true; throw new Error('relay dropped mid-drag'); }
        return {};
      });
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      let caught: any = null;
      await inputHandlers(bridge).run('drag', ['0,0', '100,50'], { steps: '4', mode: 'mouse' }).catch((e) => { caught = e; });
      assert(caught && /relay dropped mid-drag/.test(caught.message), `the original error is rethrown: ${caught?.message}`);
      const ev = mouseEvents(ext);
      const rel = ev.at(-1);
      assert(rel?.type === 'mouseReleased' && rel.buttons === 0, `button released after the failure: ${JSON.stringify(ev.map((e) => e.type))}`);
    });
  });

  /** An in-memory sender for dragPath, logging every call in order. `page` is the scroll/viewport state it reports. */
  const dragRig = (page = { w: 800, h: 600, sx: 0, sy: 0 }, failOn: (method: string, params: any) => boolean = () => false) => {
    const log: string[] = [];
    const calls: Array<{ method: string; params: any }> = [];
    let emit: ((params: Record<string, unknown>) => void) | null = null;
    const send: InputSend = async (method, params) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return { result: { value: { ...page } } };
      log.push(method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchDragEvent' ? String(params.type) : method);
      if (failOn(method, params)) throw new Error(`boom on ${String(params.type ?? method)}`);
      return {};
    };
    const on: InputOn = (method, listener) => {
      if (method === 'Input.dragIntercepted') emit = listener;
      return () => undefined;
    };
    return { send, on, log, calls, page, intercept: () => emit?.({ data: { items: [{ mimeType: 'text/plain', data: 'card-1' }] } }) };
  };

  await test('input: drag resolves both ends before the press, so the press point is post-scroll', async () => {
    const rig = dragRig();
    const order: string[] = [];
    // to's guard "scrolls" the page: from moves from y=400 to y=20.
    let scrolled = false;
    const from = async (): Promise<Point> => { order.push('from'); return scrolled ? { x: 10, y: 20 } : { x: 10, y: 400 }; };
    const to = async (): Promise<Point> => { order.push('to'); scrolled = true; rig.page.sy = 200; return { x: 200, y: 100 }; };
    const out = await dragPath(rig.send, rig.on, from, to, { steps: 2, mode: 'mouse' });
    const press = rig.calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
    assert(order.join(',') === 'to,from', `to, then from, before any input: ${order.join(',')}`);
    assert(press?.params.x === 10 && press.params.y === 20, `press lands on the post-scroll from point: ${JSON.stringify(press?.params)}`);
    assert(out.from.y === 20 && out.to.x === 200 && out.to.y === 100, `result carries the resolved points: ${JSON.stringify(out)}`);
    assert(rig.log.at(-1) === 'mouseReleased', `release at the end: ${rig.log.join(',')}`);
  });

  await test('input: drag whose ends cannot share a viewport fails before pressing anything', async () => {
    const rig = dragRig();
    // Resolving to scrolls down; resolving from scrolls back up.
    const to = async (): Promise<Point> => { rig.page.sy = 1800; return { x: 100, y: 500 }; };
    const from = async (): Promise<Point> => { rig.page.sy = 0; return { x: 5, y: 5 }; };
    let caught: any = null;
    await dragPath(rig.send, rig.on, from, to, { mode: 'mouse' }).catch((e) => { caught = e; });
    assert(caught && /cannot be scrolled into view together/.test(caught.message), `clear error: ${caught?.message}`);
    assert(!rig.log.includes('mousePressed'), `nothing pressed: ${rig.log.join(',')}`);
  });

  await test('input: drag to an off-screen point fails clearly before pressing', async () => {
    const rig = dragRig({ w: 800, h: 600, sx: 0, sy: 0 });
    let caught: any = null;
    await dragPath(rig.send, rig.on, async () => ({ x: 10, y: 10 }), async () => ({ x: 100, y: 900 }), { mode: 'mouse' })
      .catch((e) => { caught = e; });
    assert(caught && /to point 100,900 is outside the 800x600 viewport/.test(caught.message), `clear viewport error: ${caught?.message}`);
    assert(!rig.log.includes('mousePressed') && !rig.log.includes('drop'), `no silent drag, nothing pressed: ${rig.log.join(',')}`);
    const rig2 = dragRig();
    caught = null;
    await dragPath(rig2.send, rig2.on, async () => ({ x: -5, y: 10 }), async () => ({ x: 1, y: 1 }), { mode: 'mouse' })
      .catch((e) => { caught = e; });
    assert(caught && /from point -5,10 is outside/.test(caught.message), `off-screen from is refused: ${caught?.message}`);
    assert(!rig2.log.includes('mousePressed'), `nothing pressed for an off-screen from: ${rig2.log.join(',')}`);
  });

  await test('input: an intercepted drag that fails mid-drop is cancelled, not left half-run', async () => {
    const rig = dragRig({ w: 800, h: 600, sx: 0, sy: 0 }, (_m, p) => p.type === 'dragOver');
    const sendWithIntercept: InputSend = async (m, p) => {
      const r = await rig.send(m, p);
      if (m === 'Input.dispatchMouseEvent' && p.type === 'mouseMoved' && p.buttons === 1) rig.intercept();
      return r;
    };
    let caught: any = null;
    await dragPath(sendWithIntercept, rig.on, async () => ({ x: 0, y: 0 }), async () => ({ x: 100, y: 50 }), { steps: 3 })
      .catch((e) => { caught = e; });
    assert(caught && /boom on dragOver/.test(caught.message), `original error rethrown: ${caught?.message}`);
    const cancel = rig.calls.find((c) => c.method === 'Input.dispatchDragEvent' && c.params.type === 'dragCancel');
    assert(cancel && cancel.params.data?.items?.[0]?.data === 'card-1', `dragCancel carries the data: ${JSON.stringify(cancel)}`);
    assert(!rig.log.includes('mouseReleased') && !rig.log.includes('drop'), `no release or drop after an intercept: ${rig.log.join(',')}`);
    assert(rig.log.at(-1) === 'Input.setInterceptDrags', 'interception is still switched off');
  });

  await test('input: synthetic drag refuses a pair that cannot share one viewport', async () => {
    const rig = dragRig();
    const to = async (): Promise<Point> => { rig.page.sy = 1800; return { x: 100, y: 500 }; };
    const from = async (): Promise<Point> => { rig.page.sy = 0; return { x: 5, y: 5 }; };
    let caught: any = null;
    await dragPath(rig.send, rig.on, from, to, { mode: 'synthetic' }).catch((e) => { caught = e; });
    assert(caught && /cannot be scrolled into view together/.test(caught.message), `clear error: ${caught?.message}`);
    assert(!rig.calls.some((c) => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('dragstart')), 'no drag events dispatched');
  });

  await test('input: another peer\'s dragIntercepted does not finish our drag', async () => {
    await withBridge(async (bridge) => {
      // No ext needed: the filter is pure. Emit on the bridge as a relay would.
      const io = bridgeInputIO({ ...bridge.pinned('inst-a'), bridge } as any);
      let seen = 0;
      const off = io.on('Input.dragIntercepted', () => { seen++; });
      bridge.emit('event', { method: 'Input.dragIntercepted', params: {}, instanceId: 'inst-b' });
      bridge.emit('event', { method: 'Input.dragIntercepted', params: {}, instanceId: 'inst-a' });
      off();
      bridge.emit('event', { method: 'Input.dragIntercepted', params: {}, instanceId: 'inst-a' });
      assert(seen === 1, `only inst-a's event, once, before unsubscribe: ${seen}`);
    });
  });

  // ─── Snapshot cost (plan 10, C6) ──────────────────────────────
  /** A fake page: body (backend 1) with `n` buttons (backend 100+i). */
  const snapshotExt = (port: number, n: number, cursorItems: number) => {
    const ext = new FakeExt(port, 'inst-snap');
    for (const m of ['Runtime.enable', 'DOM.enable', 'Accessibility.enable', 'Runtime.releaseObject']) {
      ext.replies.set(m, () => ({}));
    }
    const liveCursor = new Set<number>(Array.from({ length: cursorItems }, (_, i) => i + 1));
    ext.replies.set('Runtime.evaluate', (p) => {
      const expr = String(p.expression ?? '');
      if (expr.includes('nodes.get(')) {
        const id = Number(/nodes\.get\((\d+)\)/.exec(expr)?.[1]);
        return liveCursor.has(id)
          ? { result: { type: 'object', subtype: 'node', objectId: `cursor-${id}` } }
          : { result: { type: 'object', subtype: 'null', value: null } };
      }
      if (p.returnByValue === false) return { result: { type: 'object', subtype: 'node', objectId: 'root' } };
      // Cursor pass.
      return { result: { value: [...liveCursor].map((id) => ({ cursorId: id, text: `div ${id}`, reason: 'cursor:pointer' })) } };
    });
    ext.replies.set('DOM.describeNode', () => ({ node: { backendNodeId: 1, nodeName: 'BODY' } }));
    ext.replies.set('Accessibility.getFullAXTree', () => ({
      nodes: [
        { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['body'] },
        {
          nodeId: 'body', parentId: 'root', backendDOMNodeId: 1, role: { value: 'generic' },
          childIds: Array.from({ length: n }, (_, i) => `b${i}`),
        },
        ...Array.from({ length: n }, (_, i) => ({
          nodeId: `b${i}`, parentId: 'body', backendDOMNodeId: 100 + i,
          role: { value: 'button' }, name: { value: `Button ${i}` },
        })),
      ],
    }));
    return { ext, liveCursor };
  };

  await test('snapshot: a 40-button page costs a constant number of relayed calls', async () => {
    await withBridge(async (bridge, port) => {
      const { ext } = snapshotExt(port, 40, 3);
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      bridge.resetStats();
      const snap = await bridgeSnapshot(bridge.pinned(), { interactive: true });
      await sleep(10);
      const buttons = [...snap.refs.keys()].filter((k) => k.startsWith('e'));
      assert(buttons.length === 40, `expected 40 @e refs, got ${buttons.length}`);
      assert(snap.refs.get('c1')?.cursorId === 1, 'cursor refs carry the registry id');
      const calls = Object.values(bridge.stats().methods).reduce((n, m) => n + m.calls, 0);
      assert(calls <= 10, `snapshot should be <= 10 relayed calls, got ${calls}: ${ext.received.join(',')}`);
      assert(!ext.received.includes('DOM.resolveNode'), 'no per-ref resolveNode (no DOM tagging)');
      assert(ext.received.filter((m) => m === 'DOM.describeNode').length === 1, 'only the root is described');
    });
  });

  await test('snapshot: cursor refs resolve lazily, and a gone node is BRIDGE_REF_STALE', async () => {
    await withBridge(async (bridge, port) => {
      const { ext, liveCursor } = snapshotExt(port, 2, 2);
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const snap = await bridgeSnapshot(bridge.pinned(), { interactive: true });
      const c2 = snap.refs.get('c2')!;
      const h = await bridgeResolveHandle(bridge.pinned(), c2, '@c2');
      assert(h.objectId === 'cursor-2', `resolved to ${h.objectId}`);
      liveCursor.delete(2);
      let caught: any = null;
      await bridgeResolveHandle(bridge.pinned(), c2, '@c2').catch((e) => { caught = e; });
      assert(caught?.code === 'BRIDGE_REF_STALE', `gone cursor node should be stale, got ${caught?.code ?? caught}`);
    });
  });

  // ─── Snapshot budget (plan 10, C8) ────────────────────────────
  await test('budget: a 300-button bridge snapshot prints 250 refs and an omitted marker', async () => {
    await withBridge(async (bridge, port) => {
      const { ext } = snapshotExt(port, 300, 0);
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const snap = await bridgeSnapshot(bridge.pinned(), { interactive: true });
      assert(snap.refs.size === 300, `ref map keeps every ref, got ${snap.refs.size}`);
      const b = applySnapshotBudget(snap.text.split('\n'), budgetFromOpts({}));
      assert(b.shownRefs === DEFAULT_MAX_REFS && b.totalRefs === 300, `shown ${b.shownRefs} / total ${b.totalRefs}`);
      const last = b.text.split('\n').at(-1) ?? '';
      assert(last === '… 50 more refs omitted (use --depth/--selector/--max-refs, or --no-cap)', `marker: ${last}`);
      assert(b.omittedRefs === 50 && b.omittedLines === 50, `omitted ${JSON.stringify(b)}`);
    });
  });

  await test('grep: matches keep their ancestors and --context lines, and run before the cap', async () => {
    const tree = [
      '@e1 [navigation] "Main"',
      '  @e2 [link] "Alpha"',
      '  @e3 [link] "Beta"',
      '@e4 [dialog] "Settings"',
      '  @e5 [group] "Billing"',
      '    @e6 [button] "Save"',
      '    @e7 [button] "Cancel"',
    ];
    const hit = grepSnapshotLines(tree, /Save/);
    assert(hit.join('|') === '@e4 [dialog] "Settings"|  @e5 [group] "Billing"|    @e6 [button] "Save"', `ancestors only: ${hit.join('|')}`);
    const ctx = grepSnapshotLines(tree, /Alpha/, 1);
    assert(ctx.join('|') === '@e1 [navigation] "Main"|  @e2 [link] "Alpha"|  @e3 [link] "Beta"', `context after: ${ctx.join('|')}`);
    const two = grepSnapshotLines(tree, /Alpha|Cancel/);
    assert(two.length === 5 && two[0].startsWith('@e1') && !two.some((l) => l.includes('Beta')), `two hits, no dupes: ${two.join('|')}`);
    // The cap sees only the filtered lines, so 3 matches fit under --max-refs 3.
    const many = Array.from({ length: 50 }, (_, i) => `@e${i + 1} [button] "b${i}"`);
    const capped = applySnapshotBudget(applyGrep(many, { grep: 'b4[0-2]"' }), budgetFromOpts({ 'max-refs': '3' }));
    assert(capped.shownRefs === 3 && capped.omittedRefs === 0, `filter before cap: ${JSON.stringify(capped)}`);
    assert(applyGrep(many, { grep: 'nope' })[0].includes('no snapshot line matches'), 'a miss says so');
    for (const bad of [{ grep: '(' }, { grep: true }, { grep: 'a', context: '-1' }]) {
      let err: any;
      try { applyGrep(many, bad); } catch (e) { err = e; }
      assert(err && err.exitCode === 2, `bad input ${JSON.stringify(bad)} should throw with exitCode 2`);
    }
  });

  await test('eval timeout: bridgeEvaluate honours timeoutMs instead of the 30 s default', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-a');
      ext.swallow.add('Runtime.evaluate');
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const started = Date.now();
      let err: any;
      try { await bridgeEvaluate(bridge.pinned(), 'new Promise(() => {})', { timeoutMs: 400 }); } catch (e) { err = e; }
      assert(err && /Runtime\.evaluate timed out after 400ms/.test(String(err.message)), `message: ${err?.message}`);
      assert(Date.now() - started < 3000, 'gave up near 400 ms');
    });
  });

  await test('budget: --max-refs, --max-chars, --no-cap and --max-refs 0', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `@e${i + 1} [button] "b${i}"`);
    lines.push('', '── cursor-interactive (not in ARIA tree) ──', '@c1 [cursor:pointer] "x"');
    const ten = applySnapshotBudget(lines, budgetFromOpts({ 'max-refs': '10' }));
    assert(ten.shownRefs === 10 && ten.totalRefs === 301, `max-refs 10: ${ten.shownRefs}/${ten.totalRefs}`);
    assert(!ten.text.includes('cursor-interactive'), 'the cursor section comes after the AX refs, so it is cut first');
    const chars = applySnapshotBudget(lines, budgetFromOpts({ 'max-chars': '2000' }));
    const body = chars.text.split('\n').slice(0, -1).join('\n');
    assert(body.length <= 2000, `kept text ${body.length} > 2000`);
    assert(/more refs omitted/.test(chars.text), 'char cap also writes the marker');
    for (const opts of [{ 'no-cap': true }, { 'max-refs': '0' }, { maxRefs: 0 }]) {
      const all = applySnapshotBudget(lines, budgetFromOpts(opts));
      assert(all.shownRefs === 301 && all.omittedLines === 0, `${JSON.stringify(opts)} should not cap`);
      assert(!/omitted/.test(all.text), 'no marker when nothing was cut');
    }
    const small = applySnapshotBudget(['@e1 [link] "a"'], budgetFromOpts({}));
    assert(small.text === '@e1 [link] "a"' && small.omittedLines === 0, 'small pages are untouched');
  });

  // ─── Stable bridge refs (plan 10, C9) ─────────────────────────
  /** A page whose button list the test edits between snapshots. */
  const mutablePage = (port: number, buttons: Array<{ id: number; name: string; role?: string }>) => {
    const ext = new FakeExt(port, 'inst-ident');
    for (const m of ['Runtime.enable', 'DOM.enable', 'Accessibility.enable', 'Runtime.releaseObject']) {
      ext.replies.set(m, () => ({}));
    }
    ext.replies.set('Runtime.evaluate', (p) => (p.returnByValue === false
      ? { result: { type: 'object', subtype: 'node', objectId: 'root' } }
      : { result: { value: [] } }));
    ext.replies.set('DOM.describeNode', () => ({ node: { backendNodeId: 1, nodeName: 'BODY' } }));
    ext.replies.set('Accessibility.getFullAXTree', () => ({
      nodes: [
        { nodeId: 'body', backendDOMNodeId: 1, role: { value: 'generic' }, childIds: buttons.map((b) => `n${b.id}`) },
        ...buttons.map((b) => ({
          nodeId: `n${b.id}`, parentId: 'body', backendDOMNodeId: b.id,
          role: { value: b.role ?? 'button' }, name: { value: b.name },
        })),
      ],
    }));
    return ext;
  };
  const refByName = (snap: { refs: Map<string, { name: string }> }, name: string) =>
    [...snap.refs].find(([, r]) => r.name === name)?.[0];

  await test('identity: an insertion above keeps existing refs; the newcomer gets a new number', async () => {
    await withBridge(async (bridge, port) => {
      const buttons = [{ id: 10, name: 'Save' }, { id: 11, name: 'Cancel' }];
      const ext = mutablePage(port, buttons);
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const registry = new RefRegistry();
      const identity = registry.forDoc('doc-a');
      const first = await bridgeSnapshot(bridge.pinned(), { interactive: true, refs: identity });
      const save = refByName(first, 'Save');
      const cancel = refByName(first, 'Cancel');
      buttons.unshift({ id: 9, name: 'Inserted' });
      const second = await bridgeSnapshot(bridge.pinned(), { interactive: true, refs: identity });
      assert(refByName(second, 'Save') === save, `Save moved: ${save} -> ${refByName(second, 'Save')}`);
      assert(refByName(second, 'Cancel') === cancel, 'Cancel moved');
      const inserted = refByName(second, 'Inserted');
      assert(inserted && inserted !== save && inserted !== cancel, `newcomer ref ${inserted}`);
      assert(second.text.indexOf(`@${inserted}`) < second.text.indexOf(`@${save}`), 'document order is kept, numbers are sparse');
    });
  });

  await test('identity: a role or name change remints; removed nodes are pruned (unscoped only)', async () => {
    await withBridge(async (bridge, port) => {
      const buttons: Array<{ id: number; name: string; role?: string }> = [{ id: 10, name: 'Save' }, { id: 11, name: 'Go' }];
      const ext = mutablePage(port, buttons);
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const registry = new RefRegistry();
      const identity = registry.forDoc('doc-a');
      const first = await bridgeSnapshot(bridge.pinned(), { interactive: true, refs: identity });
      const save = refByName(first, 'Save');
      buttons[0].name = 'Saved';
      const second = await bridgeSnapshot(bridge.pinned(), { interactive: true, refs: identity });
      assert(refByName(second, 'Saved') !== save, 'a renamed node must not keep its old ref');
      buttons[1].role = 'link';
      const third = await bridgeSnapshot(bridge.pinned(), { refs: identity });
      assert(third.refs.get(refByName(first, 'Go')!) === undefined, 'a node whose role changed gets a new ref');
      buttons.splice(0, 1);
      const held = registry.size;
      await bridgeSnapshot(bridge.pinned(), { refs: identity, selector: '#main' });
      assert(registry.size === held, '--selector snapshots never prune');
      await bridgeSnapshot(bridge.pinned(), { refs: identity });
      assert(registry.size === held - 1, `an unscoped snapshot prunes nodes that left the page (${held} -> ${registry.size})`);
    });
  });

  await test('identity: numbers are never reused after a navigation (finding 1)', async () => {
    await withBridge(async (bridge, port) => {
      const buttons = [{ id: 10, name: 'Buy' }, { id: 11, name: 'Delete account' }];
      const ext = mutablePage(port, buttons);
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const registry = new RefRegistry();
      const pageA = await bridgeSnapshot(bridge.pinned(), { interactive: true, refs: registry.forDoc('doc-a') });
      const aRefs = [...pageA.refs.keys()];
      // Navigation: the daemon clears identities (clearSnapshotRefs) but the
      // new document reuses the SAME backend node ids and even the same names.
      registry.clear();
      buttons[0].name = 'Delete account';
      buttons[1].name = 'Buy';
      const pageB = await bridgeSnapshot(bridge.pinned(), { interactive: true, refs: registry.forDoc('doc-b') });
      const num = (r: string) => Number(r.slice(1));
      const maxA = Math.max(...aRefs.map(num));
      for (const r of pageB.refs.keys()) assert(num(r) > maxA, `page B reused ${r} (page A went up to e${maxA})`);
      for (const r of aRefs) {
        assert(!pageB.refs.has(r), `${r} from page A must not resolve on page B`);
        assert(registry.docOf(r) === 'doc-a', `${r} should remember it was minted on doc-a`);
      }
      assert(docIdOfMarker('doc-b|3|https://x/') === 'doc-b' && docIdOfMarker(null) === null, 'marker parsing');
    });
  });

  await test('snapshot: reports whether it covered the whole page (finding 4)', async () => {
    await withBridge(async (bridge, port) => {
      const ext = mutablePage(port, [{ id: 10, name: 'Save' }]);
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      assert((await bridgeSnapshot(bridge.pinned(), {})).scoped === false, 'a body-rooted snapshot is not scoped');
      assert((await bridgeSnapshot(bridge.pinned(), { selector: '#form' })).scoped === true, '--selector is scoped');
      ext.replies.set('DOM.describeNode', () => ({ node: { backendNodeId: 1, nodeName: 'DIALOG' } }));
      assert((await bridgeSnapshot(bridge.pinned(), {})).scoped === true, 'a modal-rooted snapshot is scoped');
    });
  });

  await test('recheck: a skipped snapshot is re-verified by role and name (finding 5)', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-recheck');
      let ax = { role: 'button', name: 'Save' };
      ext.replies.set('Accessibility.getPartialAXTree', (p) => ({
        nodes: [{ nodeId: 'n', backendDOMNodeId: p.backendNodeId, role: { value: ax.role }, name: { value: ax.name } }],
      }));
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const ref = { backendNodeId: 42, role: 'button', name: 'Save' };
      assert(await bridgeRefStillMatches(bridge.pinned(), ref), 'same role and name should match');
      ax = { role: 'button', name: 'Delete' };
      assert(!(await bridgeRefStillMatches(bridge.pinned(), ref)), 'a rename must not match');
      ax = { role: 'checkbox', name: 'Save' };
      assert(!(await bridgeRefStillMatches(bridge.pinned(), ref)), 'a role change must not match');
      assert(await bridgeRefStillMatches(bridge.pinned(), { backendNodeId: null, cursorId: 3, role: 'cursor-interactive', name: 'x' }), 'cursor refs are not rechecked');
    });
  });

  await test('isolated world: created once per document, re-created after navigation (finding 6)', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-world');
      ext.replies.set('DOM.resolveNode', () => ({ object: { objectId: 'o' } }));
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const ref = { backendNodeId: 5, role: 'button', name: 'Go' };
      await bridgeResolveHandle(bridge.pinned(), ref, '@e1');
      await bridgeResolveHandle(bridge.pinned(), ref, '@e1');
      assert(ext.worldsCreated === 1, `one world per document, got ${ext.worldsCreated}`);
      const ctxIds = ext.sent.filter((c) => c.method === 'DOM.resolveNode').map((c) => c.params.executionContextId);
      assert(ctxIds.every((id) => id === 701), `both resolves in world 701: ${ctxIds}`);
      // Main-frame navigation drops the world; the next use makes a new one.
      ext.send({ type: 'event', method: 'Page.frameNavigated', params: { frame: { id: 'main-frame' } } });
      await sleep(20);
      await bridgeResolveHandle(bridge.pinned(), ref, '@e1');
      assert(Number(ext.worldsCreated) === 2, 'navigation must re-create the world');
      // A main-world handle (fill) does not use the isolated world at all.
      await bridgeResolveHandle(bridge.pinned(), ref, '@e1', 'main');
      const last = ext.sent.filter((c) => c.method === 'DOM.resolveNode').at(-1);
      assert(last?.params.executionContextId === undefined, 'main-world resolve carries no context id');
      // A stale context is re-created once, transparently.
      let fail = true;
      ext.replies.set('DOM.resolveNode', (p) => {
        if (fail && p.executionContextId) { fail = false; throw new Error('Cannot find context with specified id'); }
        return { object: { objectId: 'o2' } };
      });
      const h = await bridgeResolveHandle(bridge.pinned(), ref, '@e1');
      assert(h.objectId === 'o2' && Number(ext.worldsCreated) === 3, `stale world should be rebuilt: ${ext.worldsCreated}`);
    });
  });

  await test('a single extension binds on hello', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-a');
      await ext.connect();
      await until(() => bridge.connected, 'bridge to report connected');
      assert(ext.role === 'bound', `expected bound, got ${ext.role}`);
      assert(bridge.state === 'BOUND', `state ${bridge.state}`);
      assert(bridge.controlledTabId === 42, `controlledTabId ${bridge.controlledTabId}`);
    });
  });

  // Provenance (gitSha/buildDate): one peer sends them (a built extension),
  // one doesn't (loaded before its first `npm run build`, or any
  // pre-provenance extension version) — both must still bind normally, and
  // extensionInfo/instances() must reflect exactly what each peer sent.
  await test('hello WITH gitSha/buildDate is reflected in extensionInfo and instances()', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-provenance');
      ext.gitSha = 'abc1234';
      ext.buildDate = '2026-09-21';
      await ext.connect();
      await until(() => bridge.connected, 'bridge to report connected');
      assert(bridge.extensionInfo?.gitSha === 'abc1234', `extensionInfo.gitSha: ${bridge.extensionInfo?.gitSha}`);
      assert(bridge.extensionInfo?.buildDate === '2026-09-21', `extensionInfo.buildDate: ${bridge.extensionInfo?.buildDate}`);
      const inst = bridge.instances().find((i) => i.instanceId === 'inst-provenance');
      assert(inst?.gitSha === 'abc1234', `instances() gitSha: ${inst?.gitSha}`);
      assert(inst?.buildDate === '2026-09-21', `instances() buildDate: ${inst?.buildDate}`);
    });
  });

  await test('hello WITHOUT gitSha/buildDate still binds; fields read as unknown/absent', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-no-provenance');
      // gitSha/buildDate left null — sendHello() omits them, same as a
      // pre-provenance extension build.
      await ext.connect();
      await until(() => bridge.connected, 'bridge to report connected');
      assert(ext.role === 'bound', `expected bound, got ${ext.role}`);
      assert(bridge.extensionInfo?.gitSha === undefined, `extensionInfo.gitSha should be absent, got ${bridge.extensionInfo?.gitSha}`);
      assert(bridge.extensionInfo?.buildDate === undefined, `extensionInfo.buildDate should be absent, got ${bridge.extensionInfo?.buildDate}`);
      const inst = bridge.instances().find((i) => i.instanceId === 'inst-no-provenance');
      assert(inst?.gitSha === 'unknown', `instances() gitSha should be 'unknown', got ${inst?.gitSha}`);
      assert(inst?.buildDate === 'unknown', `instances() buildDate should be 'unknown', got ${inst?.buildDate}`);
    });
  });

  // `ghax bridge reload` (src/daemon.ts `bridge.reload`) is a thin wrapper
  // around exactly this: sendControl({action:'reload'}) then wait for the
  // next 'hello'. Test the mechanism directly at the Bridge level, since
  // there's no HTTP daemon in this simulator to call the RPC through.
  await test('reload: extension acks then comes back with fresh gitSha/buildDate', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-reload-ok');
      ext.gitSha = 'aaa1111';
      ext.buildDate = '2026-09-01';
      await ext.connect();
      await until(() => bridge.connected, 'bound');
      const before = bridge.extensionInfo;
      assert(before?.gitSha === 'aaa1111', `before gitSha: ${before?.gitSha}`);

      const nextHello = new Promise<void>((resolve) => bridge.once('hello', () => resolve()));
      const ack = await bridge.sendControl({ action: 'reload' });
      assert(ack.ok, `reload control-ack should be ok, got ${JSON.stringify(ack)}`);

      // The extension "rebuilds": a fresh build-info.json, same instanceId
      // (chrome.storage.local survives a reload).
      ext.gitSha = 'bbb2222';
      ext.buildDate = '2026-09-22';
      await ext.simulateReload();
      await nextHello;
      await until(() => bridge.connected, 're-bound after reload');

      const after = bridge.extensionInfo;
      assert(after?.gitSha === 'bbb2222', `after gitSha: ${after?.gitSha}`);
      assert(after?.buildDate === '2026-09-22', `after buildDate: ${after?.buildDate}`);
    });
  });

  await test('reload against an extension too old to understand it → clean timeout, no hang', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-reload-old');
      ext.ignoreControlAction = 'reload';
      await ext.connect();
      await until(() => bridge.connected, 'bound');

      const startedAt = Date.now();
      let caught: any;
      try {
        await bridge.sendControl({ action: 'reload' }, 150);
      } catch (err) {
        caught = err;
      }
      assert(caught, 'sendControl(reload) against an old extension must reject, not hang forever');
      assert(/timed out/i.test(caught.message), `expected a timeout message, got: ${caught?.message}`);
      assert(Date.now() - startedAt < 2000, 'must fail close to the requested timeout, not hang');
      // The old extension is still there, unharmed — reload simply never ran.
      assert(bridge.connected, 'the (non-reloading) extension should still be connected');
    });
  });

  // Verified live against a real, long-stale bridge extension (v0.3.0):
  // rather than a silent timeout, it answered `reload` IMMEDIATELY via
  // handleControl's pre-existing catch-all — `{ok:false, error:"unknown
  // control action: reload"}` — because that error path predates the reload
  // feature itself. The daemon's bridge.reload RPC handler treats this the
  // same as a timeout (see the `/unknown control action/i` check there); this
  // test locks in the underlying Bridge-level rejection it depends on.
  await test('reload against a slightly-older extension → immediate clean rejection, not a hang', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-reload-rejects');
      ext.rejectControlAction = 'reload';
      await ext.connect();
      await until(() => bridge.connected, 'bound');

      let caught: any;
      try {
        await bridge.sendControl({ action: 'reload' }, 500);
      } catch (err) {
        caught = err;
      }
      assert(caught, 'sendControl(reload) against a rejecting extension must reject');
      assert(
        /unknown control action/i.test(caught.message),
        `expected the extension's own rejection message, got: ${caught?.message}`,
      );
    });
  });

  // THE headline check: the exact scenario that produced the reported churn.
  // Three installs of the same extension (three profiles) racing one port.
  await test('THE LIVELOCK REPRO: 3 rivals → 1 bound, 2 parked, no churn', async () => {
    await withBridge(async (bridge, port) => {
      const a = new FakeExt(port, 'inst-a', 'edge');
      const b = new FakeExt(port, 'inst-b', 'edge');
      const c = new FakeExt(port, 'inst-c', 'chrome');
      await a.connect();
      await until(() => a.role === 'bound', 'a to bind');
      await b.connect();
      await c.connect();
      await until(() => b.role !== null && c.role !== null, 'b and c to get a disposition');

      // Let it run: if the old evict-on-connect behaviour were still present,
      // the peers would ping-pong and rack up closes + re-hellos here.
      await sleep(800);

      const bound = [a, b, c].filter((e) => e.role === 'bound');
      const parked = [a, b, c].filter((e) => e.role === 'parked');
      assert(bound.length === 1, `expected exactly 1 bound, got ${bound.length}`);
      assert(parked.length === 2, `expected exactly 2 parked, got ${parked.length}`);
      assert(bound[0] === a, 'first connection should stay bound (first-writer-wins)');
      // The cure: parked sockets stay OPEN. If we closed them, the extension's
      // reconnect loop would fire and the ping-pong would simply move.
      assert(
        b.closes === 0 && c.closes === 0,
        `parked peers must keep their sockets (closes: b=${b.closes} c=${c.closes})`,
      );
      assert(
        a.helloSends === 1 && b.helloSends === 1 && c.helloSends === 1,
        `no peer should need to re-hello (${a.helloSends}/${b.helloSends}/${c.helloSends})`,
      );
      assert(bridge.instances().length === 3, `registry should hold 3 instances`);
    });
  });

  await test('a parked peer is never sent CDP commands', async () => {
    await withBridge(async (bridge, port) => {
      const a = new FakeExt(port, 'inst-a');
      const b = new FakeExt(port, 'inst-b');
      await a.connect();
      await until(() => a.role === 'bound', 'a to bind');
      await b.connect();
      await until(() => b.role === 'parked', 'b to park');
      await bridge.send('Runtime.evaluate', { expression: '1' });
      assert(a.received.length === 1, `bound peer should get the command`);
      assert(b.received.length === 0, `parked peer received ${b.received.length} commands`);
    });
  });

  await test('resume inside the grace window: session survives, queue flushes', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-a');
      await ext.connect();
      await until(() => bridge.connected, 'bind');

      ext.kill();
      await until(() => bridge.state === 'DEGRADED', 'to enter DEGRADED');

      // A command issued DURING the outage should queue, not fail.
      const queued = bridge.send('Runtime.evaluate', { expression: '2' }, 3000);

      const back = new FakeExt(port, 'inst-a'); // same identity = resume
      await back.connect();
      await until(() => bridge.state === 'BOUND', 'to resume');
      const result = await queued;
      assert(
        (result as any)?.echoed === 'Runtime.evaluate',
        `queued command should have run after resume, got ${JSON.stringify(result)}`,
      );
      assert(bridge.state === 'BOUND', 'should be BOUND after resume');
    });
  });

  await test('in-flight command at drop → BridgeInterrupted (never silently replayed)', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-a');
      ext.swallow.add('Input.dispatchMouseEvent');
      await ext.connect();
      await until(() => bridge.connected, 'bind');

      const inflight = bridge.send('Input.dispatchMouseEvent', {}, 5000);
      await sleep(50);
      ext.kill();

      let caught: unknown;
      try {
        await inflight;
      } catch (e) {
        caught = e;
      }
      assert(
        caught instanceof BridgeInterrupted,
        `expected BridgeInterrupted, got ${String(caught)}`,
      );
      // The daemon's verb layer decides replay-vs-report from this error type;
      // the transport must NOT decide on its own.
      assert((caught as BridgeInterrupted).method === 'Input.dispatchMouseEvent', 'method preserved');
    });
  });

  await test('grace expiry → EXPIRED, error names the lost instance', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-a', 'edge', 'work-edge');
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      ext.kill();
      await until(() => bridge.state === 'DEGRADED', 'DEGRADED');

      const queued = bridge.send('Runtime.evaluate', {}, 5000);
      let caught: any;
      try {
        await queued;
      } catch (e) {
        caught = e;
      }
      await until(() => bridge.state === 'EXPIRED', 'EXPIRED after grace');
      assert(caught, 'queued command should reject on expiry');
      assert(
        String(caught.message).includes('edge') && String(caught.message).includes('did not reconnect'),
        `error should name the instance: ${caught?.message}`,
      );
      assert(caught.code === 'BRIDGE_DEGRADED_TIMEOUT', `code was ${caught.code}`);
    });
  });

  await test('late reconnect after EXPIRED still rebinds', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-a');
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      ext.kill();
      await until(() => bridge.state === 'EXPIRED', 'EXPIRED');

      const back = new FakeExt(port, 'inst-a');
      await back.connect();
      await until(() => bridge.state === 'BOUND', 'rebind after expiry');
      assert(back.role === 'bound', `expected bound, got ${back.role}`);
    });
  });

  await test('liveness: a silent socket is terminated', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-a', 'edge', '', /* autoPing */ false);
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      // Send nothing at all — no pings. Liveness must notice and terminate, so
      // `close` fires deterministically instead of the socket hanging half-open.
      await until(() => bridge.state !== 'BOUND', 'liveness to fire', 4000);
      assert(ext.closes >= 1, 'socket should have been terminated');
    });
  });

  await test('a legacy hello (no instanceId) still binds', async () => {
    await withBridge(async (bridge, port, logs) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((r, j) => {
        ws.once('open', () => r());
        ws.once('error', j);
      });
      ws.send(JSON.stringify({ type: 'hello', agent: 'ghax-ext', version: '0.1.0' }));
      await until(() => bridge.connected, 'legacy client to bind');
      assert(
        logs.some((l) => l.includes('reload the ghax bridge extension')),
        'should warn about the pre-identity extension',
      );
      ws.close();
    });
  });

  await test('bind filter parks a non-matching browser even if it connects first', async () => {
    await withBridge(async (bridge, port) => {
      bridge.setBindFilter('chrome');
      const edge = new FakeExt(port, 'inst-edge', 'edge');
      await edge.connect();
      await until(() => edge.role !== null, 'edge disposition');
      assert(edge.role === 'parked', `edge should park under --browser chrome, got ${edge.role}`);

      const chrome = new FakeExt(port, 'inst-chrome', 'chrome');
      await chrome.connect();
      await until(() => chrome.role === 'bound', 'chrome to bind');
      assert(bridge.connected, 'bridge should be connected via chrome');
    });
  });

  // ─── First-bind selection (plan 11, phase 1) ────────────────────
  // Two browsers dialling one daemon used to race: first hello won. Now the
  // first hello opens a settle window and the daemon binds only when exactly
  // one connected instance matches.
  const SETTLE = 150;

  await test('settle: two browsers, no --browser → BRIDGE_AMBIGUOUS, nothing binds', async () => {
    await withBridge(async (bridge, port) => {
      const edge = new FakeExt(port, 'inst-edge', 'edge', 'Work');
      const chrome = new FakeExt(port, 'inst-chrome', 'chrome');
      await edge.connect();
      await chrome.connect();
      await until(() => edge.role === 'parked' && chrome.role === 'parked', 'both park while settling');
      assert(bridge.selection.state === 'settling', `selection ${bridge.selection.state}`);
      await until(() => bridge.selection.state !== 'settling', 'settle window to close');
      const sel = bridge.selection;
      assert(sel.state === 'ambiguous' && sel.code === 'BRIDGE_AMBIGUOUS', `got ${JSON.stringify(sel)}`);
      assert(sel.instances?.length === 2, 'both instances listed');
      assert(/edge · Work · inst-edge · :\d+/.test(sel.message ?? ''), `message lists edge: ${sel.message}`);
      assert(/chrome · - · inst-chrome/.test(sel.message ?? ''), `message lists chrome: ${sel.message}`);
      assert(!bridge.connected && bridge.state === 'UNBOUND', `must not bind, state ${bridge.state}`);
      assert(edge.role === 'parked' && chrome.role === 'parked', 'neither may be promoted');
      // A late hello while ambiguous parks too: [0] is never taken by arrival.
      const late = new FakeExt(port, 'inst-late', 'edge');
      await late.connect();
      await until(() => late.role !== null, 'late disposition');
      assert(late.role === 'parked' && bridge.state === 'UNBOUND', 'late hello must park while ambiguous');
      // The error a verb sees names the ambiguity, not "load the extension".
      let caught: any = null;
      try { await bridge.send('Runtime.evaluate', {}); } catch (e) { caught = e; }
      assert(/BRIDGE_AMBIGUOUS/.test(String(caught?.message)), `send error: ${caught?.message}`);
      // `bridge use` still resolves it.
      await bridge.use('chrome');
      await until(() => chrome.role === 'bound', 'use promotes chrome');
      assert((bridge.selection.state as string) === 'bound', `selection after use: ${bridge.selection.state}`);
    }, { settleMs: SETTLE });
  });

  await test('settle: --browser edge binds Edge, Chrome stays parked', async () => {
    await withBridge(async (bridge, port) => {
      bridge.setBindFilter('edge');
      const chrome = new FakeExt(port, 'inst-chrome', 'chrome');
      const edge = new FakeExt(port, 'inst-edge', 'edge');
      // Chrome first: under first-hello-wins with no filter it would have won.
      await chrome.connect();
      await edge.connect();
      await until(() => edge.role === 'bound', 'edge promoted after settle');
      assert(chrome.role === 'parked', `chrome should stay parked, got ${chrome.role}`);
      assert(edge.roleHistory.join(',') === 'parked,bound', `edge history ${edge.roleHistory}`);
      assert(bridge.selection.state === 'bound', `selection ${bridge.selection.state}`);
      await bridge.send('Runtime.evaluate', { expression: '1' });
      assert(edge.received.length === 1 && chrome.received.length === 0, 'CDP goes to edge only');
      // Late hellos after a bind keep the old park behaviour.
      const late = new FakeExt(port, 'inst-edge-2', 'edge');
      await late.connect();
      await until(() => late.role !== null, 'late disposition');
      assert(late.role === 'parked' && edge.role === 'bound', 'a late match parks; the bound one keeps the session');
    }, { settleMs: SETTLE });
  });

  await test('settle: nothing matches --browser → BRIDGE_NO_CANDIDATE naming what was seen', async () => {
    await withBridge(async (bridge, port) => {
      bridge.setBindFilter('firefox');
      const edge = new FakeExt(port, 'inst-edge', 'edge');
      const chrome = new FakeExt(port, 'inst-chrome', 'chrome', 'Personal');
      await edge.connect();
      await chrome.connect();
      await until(() => bridge.selection.state === 'no-candidate', 'window to close with no candidate');
      const sel = bridge.selection;
      assert(sel.code === 'BRIDGE_NO_CANDIDATE', `code ${sel.code}`);
      assert(sel.filter === 'firefox', `filter ${sel.filter}`);
      assert(sel.instances?.length === 2 && sel.instances.every((i) => !i.matches), 'both seen, neither matches');
      assert(/inst-edge/.test(sel.message ?? '') && /chrome · Personal · inst-chrome/.test(sel.message ?? ''), `message: ${sel.message}`);
      assert(bridge.state === 'UNBOUND', 'nothing binds');
      // A matching browser arriving later reopens the window and binds.
      const ff = new FakeExt(port, 'inst-ff', 'firefox');
      await ff.connect();
      await until(() => ff.role === 'bound', 'late match binds after its own settle');
      assert(edge.role === 'parked' && chrome.role === 'parked', 'non-matching stay parked');
    }, { settleMs: SETTLE });
  });

  await test('settle: a single browser binds once the window closes', async () => {
    await withBridge(async (bridge, port) => {
      const edge = new FakeExt(port, 'inst-edge', 'edge');
      const t0 = Date.now();
      await edge.connect();
      await until(() => edge.role === 'parked', 'parks first');
      await until(() => bridge.connected, 'binds after settle');
      assert(Date.now() - t0 >= SETTLE - 20, `bound too early (${Date.now() - t0}ms)`);
      // The bridge flips to connected before the fake has read the role frame.
      await until(() => edge.role === 'bound', 'edge to receive its bound role');
    }, { settleMs: SETTLE });
  });

  await test('bridge.use rebinds over live sockets (no disconnect) and clears refs', async () => {
    await withBridge(async (bridge, port) => {
      const a = new FakeExt(port, 'inst-a', 'edge');
      const b = new FakeExt(port, 'inst-b', 'chrome');
      await a.connect();
      await until(() => a.role === 'bound', 'a bound');
      await b.connect();
      await until(() => b.role === 'parked', 'b parked');

      let controlledEmitted = false;
      bridge.on('controlled', () => {
        controlledEmitted = true;
      });

      await bridge.use('chrome');
      await until(() => b.role === 'bound', 'b promoted');
      assert(a.role === 'parked', `a should be demoted, got ${a.role}`);
      // Tab ids are per-browser, so refs MUST die on rebind. The daemon hangs
      // its ref-clearing off this event (CLAUDE.md invariant 3).
      assert(controlledEmitted, 'rebind must emit controlled so refs clear');
      assert(a.closes === 0 && b.closes === 0, 'rebind must not disconnect either peer');
    });
  });

  await test('use(): ambiguous selector refuses and lists every match; a unique id prefix binds', async () => {
    await withBridge(async (bridge, port) => {
      const a = new FakeExt(port, 'aaa111-edge', 'edge', 'Work');
      await a.connect();
      await until(() => a.role === 'bound', 'a bound');
      const b = new FakeExt(port, 'bbb222-edge', 'edge', 'Home');
      await b.connect();
      await until(() => b.role === 'parked', 'b parked');
      let caught: any = null;
      try { await bridge.use('edge'); } catch (e) { caught = e; }
      const msg = String(caught?.message);
      assert(caught && /matches 2 instances/.test(msg), `use('edge') must refuse: ${msg}`);
      assert(/edge · Work · aaa111-edge · :/.test(msg) && /edge · Home · bbb222-edge · :/.test(msg), `must list both: ${msg}`);
      assert(a.role === 'bound' && (b.role as string) === 'parked', 'a refusal must not rebind');
      await bridge.use('bbb');
      await until(() => b.role === 'bound', 'unique id prefix binds');
      assert((a.role as string) === 'parked', `a demoted, got ${a.role}`);
    });
  });

  await test('registerDaemon writes via temp+rename: the visible file is never written in place', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghax-reg-'));
    const target = path.join(dir, '4242.json');
    const written: string[] = [];
    registerDaemon(
      { pid: 4242, port: 1, stateFile: '/x', cwd: '/x', browserKind: 'edge', bridgePort: null, startedAt: 'now' },
      dir,
      (f, data, opts) => { written.push(f); fs.writeFileSync(f, data, opts); },
    );
    assert(!written.includes(target), `entry written directly to ${target}`);
    assert(written.length === 1 && !written[0].endsWith('.json'), `temp name ${written}`);
    assert(JSON.parse(fs.readFileSync(target, 'utf8')).pid === 4242, 'final file parses');
    assert(fs.readdirSync(dir).join() === '4242.json', `leftovers: ${fs.readdirSync(dir)}`);
    fs.rmSync(dir, { recursive: true });
  });

  await test('same instance reconnecting is a resume, not a rival', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-a');
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      // A respawned worker racing its own close: connect again with the SAME
      // identity while the old socket is still registered.
      const again = new FakeExt(port, 'inst-a');
      await again.connect();
      await until(() => again.role === 'bound', 'same identity rebinds');
      assert(bridge.instances().length === 1, 'a resume must not create a second instance');
      assert(bridge.state === 'BOUND', `state ${bridge.state}`);
    });
  });

  await test('a parked instance can be queried without stealing the session', async () => {
    await withBridge(async (bridge, port) => {
      const a = new FakeExt(port, 'inst-a', 'edge');
      const b = new FakeExt(port, 'inst-b', 'chrome');
      await a.connect();
      await until(() => a.role === 'bound', 'a bound');
      await b.connect();
      await until(() => b.role === 'parked', 'b parked');

      // `ghax tabs --browser chrome` routes here. chrome.tabs.query needs no
      // debugger attachment, so a parked peer can answer it.
      const ack = await bridge.sendControlToInstance('chrome', { action: 'list-tabs' });
      const tabs = ack.result as Array<{ title: string }>;
      assert(Array.isArray(tabs) && tabs.length === 1, `expected 1 tab, got ${JSON.stringify(tabs)}`);
      assert(tabs[0].title.includes('inst-b'), `should be the PARKED peer's tabs, got ${tabs[0].title}`);
      assert(b.controls.includes('list-tabs'), 'parked peer should have received list-tabs');
      // Crucially, querying must not change who is driving.
      assert(a.role === 'bound' && b.role === 'parked', 'roles must be unchanged after a query');
      assert(bridge.controlledTabId === 42, 'bound peer still owns the session');
    });
  });

  await test('identity: hello.profile names the alias; label-only and unlabelled extensions fall back', async () => {
    await withBridge(async (bridge, port) => {
      const a = new FakeExt(port, 'inst-a', 'edge');
      a.profile = 'Work Laptop';
      await a.connect();
      await until(() => a.role === 'bound', 'a bound');
      const ia = bridge.instances().find((i) => i.instanceId === 'inst-a')!;
      assert(ia.profile === 'Work Laptop' && ia.alias === 'edge-work-laptop', `profile/alias: ${ia.profile} / ${ia.alias}`);
      assert(ia.brandVersion === '150', `brandVersion: ${ia.brandVersion}`);
      // An extension predating `profile` still names itself through `label`.
      const b = new FakeExt(port, 'inst-b', 'chrome', 'Home');
      await b.connect();
      await until(() => b.role === 'parked', 'b parked');
      const ib = bridge.instances().find((i) => i.instanceId === 'inst-b')!;
      assert(ib.profile === 'Home' && ib.alias === 'chrome-home' && ib.brandVersion === '', `label fallback: ${JSON.stringify(ib)}`);
      // No name at all: <brand>-<short6>.
      const c = new FakeExt(port, 'inst-c-123456', 'chrome');
      await c.connect();
      await until(() => c.role === 'parked', 'c parked');
      assert(bridge.aliasOf('inst-c-123456') === 'chrome-instc1', `fallback alias: ${bridge.aliasOf('inst-c-123456')}`);
      // The ack says who answered, so ids are minted with the right alias.
      const ack = await bridge.sendControlToInstance('chrome-home', { action: 'list-tabs' });
      assert(ack.instanceId === 'inst-b', `ack.instanceId: ${ack.instanceId}`);
      const own = await bridge.sendControl({ action: 'list-tabs' });
      assert(own.instanceId === 'inst-a', `bound ack.instanceId: ${own.instanceId}`);
    });
  });

  await test('alias: unlabelled edge-abcdef vs a profile named "abcdef" never share an alias', async () => {
    await withBridge(async (bridge, port) => {
      const a = new FakeExt(port, 'abcdef-unlabelled', 'edge');
      await a.connect();
      await until(() => a.role === 'bound', 'a bound');
      const b = new FakeExt(port, 'zzzzzz-named', 'edge');
      b.profile = 'abcdef';
      await b.connect();
      await until(() => b.role === 'parked', 'b parked');
      const x = bridge.aliasOf('abcdef-unlabelled'), y = bridge.aliasOf('zzzzzz-named');
      assert(x !== y, `aliases must differ: ${x} / ${y}`);
    });
  });

  await test('alias: a live peer keeps its alias when a same-name peer connects; a gone peer does not clash', async () => {
    await withBridge(async (bridge, port) => {
      const a = new FakeExt(port, 'aaaaaa-1', 'edge');
      a.profile = 'Work';
      await a.connect();
      await until(() => a.role === 'bound', 'a bound');
      assert(bridge.aliasOf('aaaaaa-1') === 'edge-work', `first: ${bridge.aliasOf('aaaaaa-1')}`);
      const b = new FakeExt(port, 'bbbbbb-2', 'edge');
      b.profile = 'Work';
      await b.connect();
      await until(() => b.role === 'parked', 'b parked');
      assert(bridge.aliasOf('aaaaaa-1') === 'edge-work', `a must not flip: ${bridge.aliasOf('aaaaaa-1')}`);
      assert(bridge.aliasOf('bbbbbb-2') === 'edge-work-bbbbbb', `b suffixed: ${bridge.aliasOf('bbbbbb-2')}`);
      // b leaves: a stays; b coming back alone gets the plain name only if a is gone too.
      (b as any).ws?.close();
      await until(() => bridge.instances().find((i) => i.instanceId === 'bbbbbb-2')!.connected === false, 'b gone');
      assert(bridge.aliasOf('aaaaaa-1') === 'edge-work', 'a stable after b leaves');
    });
  });

  await test('hello profile is sanitized at intake: controls stripped, 40 chars max', async () => {
    await withBridge(async (bridge, port) => {
      const a = new FakeExt(port, 'inst-san', 'edge');
      a.profile = 'Evil\n#9  fake:1  "x"\u202e' + 'y'.repeat(60);
      await a.connect();
      await until(() => a.role === 'bound', 'a bound');
      const i = bridge.instances().find((x) => x.instanceId === 'inst-san')!;
      assert(!/[\n\u202e]/.test(i.profile) && i.profile.length <= 40, `profile: ${JSON.stringify(i.profile)}`);
    });
  });

  await test('peer-restart fires when the session nonce changes, not on a same-nonce respawn', async () => {
    await withBridge(async (bridge, port) => {
      const events: string[] = [];
      bridge.on('peer-restart', (id: string) => events.push(id));
      const a = new FakeExt(port, 'inst-n', 'edge');
      a.sessionNonce = 'n1';
      await a.connect();
      await until(() => a.role === 'bound', 'a bound');
      assert(events.length === 0, 'first hello is not a restart');
      assert(bridge.identityOf('inst-n')!.nonce === 'n1', 'nonce recorded');
      a.sendHello();
      await sleep(80);
      assert(events.length === 0, `same nonce is a respawn, not a restart: ${events}`);
      a.sessionNonce = 'n2';
      a.sendHello();
      await until(() => events.length === 1, 'restart event on nonce change');
      assert(bridge.identityOf('inst-n')!.nonce === 'n2', 'nonce updated');
    });
  });

  await test('an unknown --browser selector errors with the known instances', async () => {
    await withBridge(async (bridge, port) => {
      const a = new FakeExt(port, 'inst-a', 'edge');
      await a.connect();
      await until(() => a.role === 'bound', 'a bound');
      let caught: any;
      try {
        await bridge.sendControlToInstance('firefox', { action: 'list-tabs' });
      } catch (e) {
        caught = e;
      }
      assert(caught, 'should reject an unknown selector');
      assert(
        String(caught.message).includes('edge'),
        `error should list known instances: ${caught?.message}`,
      );
    });
  });

  await test('pairing: a correct code binds, a wrong code is rejected (not bound)', async () => {
    await withBridge(async (bridge, port) => {
      const wrong = new FakeExt(port, 'inst-wrong');
      wrong.pairToken = '000000';
      await wrong.connect();
      await until(() => wrong.rejected !== null, 'wrong code to be rejected');
      assert(!bridge.connected, 'a wrong code must not bind');
      assert(String(wrong.rejected).includes('pairing'), `reject should mention pairing: ${wrong.rejected}`);

      const right = new FakeExt(port, 'inst-right');
      right.pairToken = '424242';
      await right.connect();
      await until(() => bridge.connected, 'correct code to bind');
      assert(right.role === 'bound', `correct code should bind, got ${right.role}`);
    }, { pairCode: '424242' });
  });

  await test('pairing: a missing code is rejected when pairing is required', async () => {
    await withBridge(async (bridge, port) => {
      const ext = new FakeExt(port, 'inst-a'); // no pairToken
      await ext.connect();
      await until(() => ext.rejected !== null, 'missing code to be rejected');
      assert(!bridge.connected, 'no code must not bind when pairing is required');
    }, { pairCode: '424242' });
  });

  await test('pairing throttle never locks out the legit browser', async () => {
    // The security-relevant invariant: an attacker spraying wrong codes must
    // not be able to DoS the real extension. A correct code is checked first
    // and never throttled, so it binds promptly even under a burst of failures.
    await withBridge(async (bridge, port) => {
      for (let i = 0; i < 12; i++) {
        const bad = new FakeExt(port, `bad-${i}`);
        bad.pairToken = String(100000 + i);
        await bad.connect();
        await until(() => bad.rejected !== null, `bad attempt ${i} rejected`, 4000);
        bad.kill();
      }
      assert(!bridge.connected, 'no wrong code should ever bind');
      const good = new FakeExt(port, 'inst-good');
      good.pairToken = '424242';
      await good.connect();
      await until(() => bridge.connected, 'correct code binds despite the burst', 4000);
      assert(good.role === 'bound', `legit browser must bind, got ${good.role}`);
    }, { pairCode: '424242' });
  });

  await test('waitForResume resolves immediately when already bound, rejects when unbound', async () => {
    await withBridge(async (bridge, port) => {
      // Unbound: history-nav reconcile relies on this rejecting, not hanging.
      let rejected = false;
      await bridge.waitForResume().catch(() => { rejected = true; });
      assert(rejected, 'waitForResume must reject when nothing is bound');

      const ext = new FakeExt(port, 'inst-a');
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      // Bound: resolves without waiting — the reconcile fast-path.
      await bridge.waitForResume();
    });
  });

  await test('livelock detector trips on repeated ownership changes', async () => {
    await withBridge(async (bridge, port, logs) => {
      // Legacy clients get a fresh synthetic id each hello, so alternating
      // them is exactly the pre-identity fight the detector exists to name.
      //
      // Each cycle waits out the GRACE WINDOW, because that is now the only
      // thing that can hand the session to a different instance: a rival
      // arriving while the incumbent is merely DEGRADED parks instead of
      // taking over (see `boundGone` in handleHello). Ownership flapping is
      // therefore slower than it used to be — and still exactly what the
      // detector is looking for.
      for (let i = 0; i < 4; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((r, j) => {
          ws.once('open', () => r());
          ws.once('error', j);
        });
        ws.send(JSON.stringify({ type: 'hello', agent: 'ghax-ext', version: '0.1.0' }));
        await sleep(60);
        ws.terminate();
        await until(() => bridge.state === 'DEGRADED', 'the incumbent to drop', 2000);
        await until(() => bridge.state === 'EXPIRED', 'the grace window to expire', 2000);
      }
      await until(
        () => bridge.livelockSuspected,
        'livelock detector to trip',
        3000,
      );
      assert(
        logs.some((l) => l.includes('ownership is flapping')),
        'should log the flapping warning',
      );
    });
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
