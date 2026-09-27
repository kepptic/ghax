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

import { WebSocket } from 'ws';
import {
  Bridge,
  BridgeInterrupted,
  BridgeTypedError,
  bridgeGuard,
  bridgeReleaseHandle,
  bridgeResolveHandle,
  bridgeSnapshot,
  isStaleContextError,
} from '../src/bridge';
import { RefRegistry, docIdOfMarker } from '../src/ref-registry';
import { applySnapshotBudget, budgetFromOpts, DEFAULT_MAX_REFS } from '../src/snapshot-budget';

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
  replies = new Map<string, (params: any) => unknown>();
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
      controlledTabId: 42,
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
  extraOpts: { pairCode?: string } = {},
): Promise<void> {
  const port = nextPort++;
  const logs: string[] = [];
  const bridge = new Bridge(port, (m) => logs.push(m), {
    graceMs: GRACE_MS,
    livenessMs: LIVENESS_MS,
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

    // The permanent case. It LOOKS like the transient one and is not: a page
    // holding another extension's frame never becomes attachable, so this must
    // stay distinguishable for the daemon to advise correctly (bridgeError).
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
      await bridgeResolveHandle(bridge, { backendNodeId: 77, role: 'button', name: 'Save' }, '@e3')
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
      const h = await bridgeResolveHandle(bridge, { backendNodeId: 5, role: 'button', name: 'Buy' }, '@e7');
      let caught: unknown = null;
      await bridgeGuard(bridge, h, '@e7', 'click', false).catch((e) => { caught = e; });
      bridgeReleaseHandle(bridge, h);
      assert(caught instanceof BridgeTypedError, `expected typed error, got ${caught}`);
      const e = caught as BridgeTypedError;
      assert(e.code === 'BRIDGE_TARGET_NOT_ACTIONABLE', `code ${e.code}`);
      assert(e.message.includes('div#overlay'), `message should name the coverer: ${e.message}`);
      assert(/--force/.test(e.hint) && e.hint.includes('div#overlay'), `hint: ${e.hint}`);
      assert(e.details?.reason === 'covered', `details: ${JSON.stringify(e.details)}`);
      await sleep(10);
      assert(
        ext.received.join(',') === 'DOM.resolveNode,Runtime.callFunctionOn,Runtime.releaseObject',
        `a guarded click costs resolve + one in-page call + release, got ${ext.received.join(',')}`,
      );
    });
  });

  await test('guard: disabled and detached map to the right codes', async () => {
    await withBridge(async (bridge, port) => {
      const ext = await guardedExt(port, { ok: false, reason: 'disabled' });
      await until(() => bridge.connected, 'bind');
      const h = await bridgeResolveHandle(bridge, { backendNodeId: 5, role: 'button', name: 'Go' }, '@e2');
      let caught: any = null;
      await bridgeGuard(bridge, h, '@e2', 'click', false).catch((e) => { caught = e; });
      assert(caught?.code === 'BRIDGE_TARGET_NOT_ACTIONABLE' && /disabled/.test(caught.hint), `disabled: ${caught?.hint}`);
      ext.replies.set('Runtime.callFunctionOn', () => ({ result: { value: { guard: { ok: false, reason: 'detached' } } } }));
      caught = null;
      await bridgeGuard(bridge, h, '@e2', 'fill', false).catch((e) => { caught = e; });
      assert(caught?.code === 'BRIDGE_REF_STALE', `detached should read as stale, got ${caught?.code}`);
    });
  });

  await test('guard: --force is carried into the in-page call', async () => {
    await withBridge(async (bridge, port) => {
      const ext = await guardedExt(port, { ok: true, x: 40, y: 20, width: 80, height: 40 });
      await until(() => bridge.connected, 'bind');
      const h = await bridgeResolveHandle(bridge, { backendNodeId: 5, role: 'button', name: 'Go' }, '@e1');
      const { guard } = await bridgeGuard(bridge, h, '@e1', 'click', true);
      assert(guard.x === 40 && guard.y === 20, `click point from the guard: ${JSON.stringify(guard)}`);
      const call = ext.sent.find((c) => c.method === 'Runtime.callFunctionOn');
      assert(call, 'no callFunctionOn sent');
      assert(call.params.arguments[0].value === 'click', `kind arg: ${JSON.stringify(call.params.arguments)}`);
      assert(call.params.arguments[1].value === true, 'force must reach the page');
      assert(/function actionability\(/.test(call.params.functionDeclaration), 'guard source must be inlined');
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
      if (expr.includes('window.__ghax?.nodes.get(')) {
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
      const snap = await bridgeSnapshot(bridge, { interactive: true });
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
      const snap = await bridgeSnapshot(bridge, { interactive: true });
      const c2 = snap.refs.get('c2')!;
      const h = await bridgeResolveHandle(bridge, c2, '@c2');
      assert(h.objectId === 'cursor-2', `resolved to ${h.objectId}`);
      liveCursor.delete(2);
      let caught: any = null;
      await bridgeResolveHandle(bridge, c2, '@c2').catch((e) => { caught = e; });
      assert(caught?.code === 'BRIDGE_REF_STALE', `gone cursor node should be stale, got ${caught?.code ?? caught}`);
    });
  });

  // ─── Snapshot budget (plan 10, C8) ────────────────────────────
  await test('budget: a 300-button bridge snapshot prints 250 refs and an omitted marker', async () => {
    await withBridge(async (bridge, port) => {
      const { ext } = snapshotExt(port, 300, 0);
      await ext.connect();
      await until(() => bridge.connected, 'bind');
      const snap = await bridgeSnapshot(bridge, { interactive: true });
      assert(snap.refs.size === 300, `ref map keeps every ref, got ${snap.refs.size}`);
      const b = applySnapshotBudget(snap.text.split('\n'), budgetFromOpts({}));
      assert(b.shownRefs === DEFAULT_MAX_REFS && b.totalRefs === 300, `shown ${b.shownRefs} / total ${b.totalRefs}`);
      const last = b.text.split('\n').at(-1) ?? '';
      assert(last === '… 50 more refs omitted (use --depth/--selector/--max-refs, or --no-cap)', `marker: ${last}`);
      assert(b.omittedRefs === 50 && b.omittedLines === 50, `omitted ${JSON.stringify(b)}`);
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
      const first = await bridgeSnapshot(bridge, { interactive: true, refs: identity });
      const save = refByName(first, 'Save');
      const cancel = refByName(first, 'Cancel');
      buttons.unshift({ id: 9, name: 'Inserted' });
      const second = await bridgeSnapshot(bridge, { interactive: true, refs: identity });
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
      const first = await bridgeSnapshot(bridge, { interactive: true, refs: identity });
      const save = refByName(first, 'Save');
      buttons[0].name = 'Saved';
      const second = await bridgeSnapshot(bridge, { interactive: true, refs: identity });
      assert(refByName(second, 'Saved') !== save, 'a renamed node must not keep its old ref');
      buttons[1].role = 'link';
      const third = await bridgeSnapshot(bridge, { refs: identity });
      assert(third.refs.get(refByName(first, 'Go')!) === undefined, 'a node whose role changed gets a new ref');
      buttons.splice(0, 1);
      const held = registry.size;
      await bridgeSnapshot(bridge, { refs: identity, selector: '#main' });
      assert(registry.size === held, '--selector snapshots never prune');
      await bridgeSnapshot(bridge, { refs: identity });
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
      const pageA = await bridgeSnapshot(bridge, { interactive: true, refs: registry.forDoc('doc-a') });
      const aRefs = [...pageA.refs.keys()];
      // Navigation: the daemon clears identities (clearSnapshotRefs) but the
      // new document reuses the SAME backend node ids and even the same names.
      registry.clear();
      buttons[0].name = 'Delete account';
      buttons[1].name = 'Buy';
      const pageB = await bridgeSnapshot(bridge, { interactive: true, refs: registry.forDoc('doc-b') });
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
      assert((await bridgeSnapshot(bridge, {})).scoped === false, 'a body-rooted snapshot is not scoped');
      assert((await bridgeSnapshot(bridge, { selector: '#form' })).scoped === true, '--selector is scoped');
      ext.replies.set('DOM.describeNode', () => ({ node: { backendNodeId: 1, nodeName: 'DIALOG' } }));
      assert((await bridgeSnapshot(bridge, {})).scoped === true, 'a modal-rooted snapshot is scoped');
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
