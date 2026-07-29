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
import { Bridge, BridgeInterrupted, isStaleContextError } from '../src/bridge';

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
      if (this.swallow.has(msg.method)) return; // in flight forever
      this.send({ id: msg.id, result: { echoed: msg.method } });
    }
  }

  send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
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
      for (let i = 0; i < 4; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((r, j) => {
          ws.once('open', () => r());
          ws.once('error', j);
        });
        ws.send(JSON.stringify({ type: 'hello', agent: 'ghax-ext', version: '0.1.0' }));
        await sleep(60);
        ws.terminate();
        await sleep(60);
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
