/**
 * ghax bridge — MULTI-AGENT simulator. No browser required.
 *
 * The companion to test/bridge-sim.ts, which covers one daemon and its
 * reconnect/arbitration state machine. This file covers the other axis: several
 * daemons (one per agent, each with its own GHAX_STATE_FILE) sharing ONE
 * browser, which is what docs/design/plan/09-bridge-multi-agent.md added.
 *
 * Two things had to change for that to work, and both are tested here:
 *   1. Port allocation — every bridge used to demand 9223, so a second agent's
 *      daemon could never get an extension connection. `Bridge.create` now
 *      walks the scan window.
 *   2. Tab ownership — the extension used to be a singleton, so every relayed
 *      command landed on the one controlled tab. The `FakeExtension` below
 *      mirrors the new multiplexer: one connection per daemon, one shared
 *      tab-ownership registry, events routed by owning tab.
 *
 * Run: tsx test/bridge-multi-sim.ts   (or `npm run test:bridge-multi-sim`)
 * Exit 0 on success, non-zero if any check failed.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Bridge, BRIDGE_PORT_RANGE } from '../src/bridge';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const GRACE_MS = 400;
const LIVENESS_MS = 600;
/** Must match LEGACY_FALLBACK_MS in extension/background.js. */
const LEGACY_FALLBACK_MS = 1000;

let failures = 0;
let checks = 0;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, msg: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for: ${msg}`);
}

interface FakeTab {
  id: number;
  title: string;
  url: string;
}

/**
 * One browser's worth of extension: N daemon connections plus the shared
 * tab-ownership registry that keeps two agents off one tab. Mirrors the
 * module-level `tabOwners` map and `ownerOf` / `claimTab` helpers in
 * extension/background.js — if those semantics change, this must follow.
 */
class FakeExtension {
  readonly tabOwners = new Map<number, FakeConnection>();
  readonly connections: FakeConnection[] = [];
  /**
   * chrome.storage.local `controlledTabs`, keyed by port. The VALUE carries the
   * daemon id, which is the whole point: a port is a pool slot, so an entry
   * stamped with another daemon's id must not be restored.
   */
  readonly controlledTabs = new Map<number, { daemonId: string | null; tabId: number }>();
  tabs: FakeTab[] = [
    { id: 1, title: 'tab one', url: 'https://one.example' },
    { id: 2, title: 'tab two', url: 'https://two.example' },
    { id: 3, title: 'tab three', url: 'https://three.example' },
  ];

  /**
   * The port the extension is configured to dial; the rest of the scan window
   * sits above it. Only connections ON this port may take the legacy fallback.
   * Defaults to a port number that can never match, which is what every test
   * with a real daemon answering `hello` wants — those get a disposition.
   */
  constructor(readonly basePort: number = -1) {}

  async connect(port: number, instanceId = 'inst-browser'): Promise<FakeConnection> {
    const conn = new FakeConnection(this, port, instanceId);
    this.connections.push(conn);
    await conn.open();
    return conn;
  }

  ownerOf(tabId: number): FakeConnection | null {
    const owner = this.tabOwners.get(tabId);
    if (!owner) return null;
    if (owner.controlledTabId !== tabId) {
      this.tabOwners.delete(tabId);
      return null;
    }
    return owner;
  }

  claim(conn: FakeConnection, tabId: number): void {
    const owner = this.ownerOf(tabId);
    if (owner && owner !== conn) {
      throw new Error(
        `tab ${tabId} is already controlled by another ghax agent (bridge port ${owner.port}) — `
        + `pick another tab or run 'ghax bridge control --stop' there`,
      );
    }
    this.tabOwners.set(tabId, conn);
  }

  /** chrome.debugger.onEvent — delivered only to the tab's owner. */
  dispatchDebuggerEvent(tabId: number, method: string, params: Record<string, unknown>): void {
    const owner = this.ownerOf(tabId);
    if (!owner) return;
    owner.send({ type: 'event', method, params });
  }

  closeAll(): void {
    for (const conn of this.connections) conn.close();
  }
}

/** One daemon connection inside the fake extension. */
class FakeConnection {
  ws: WebSocket | null = null;
  role: string | null = null;
  controlledTabId: number | null = null;
  /** Identity of the daemon currently on this port, from `hello-ack`. */
  daemonId: string | null = null;
  /** CDP methods received on THIS connection — proves per-tab routing. */
  received: string[] = [];
  /** Control acks that failed, with their message — the conflict surface. */
  controlErrors: string[] = [];
  /** Set to leave a control request unanswered, so it stays pending. */
  swallowControl = false;
  /**
   * A PERMANENT chrome.debugger.attach failure to raise from the attach step of
   * switchControlTo — a target that will never become attachable, as opposed to
   * the transient cert-interstitial refusal that keeps the tab selected.
   */
  attachFailure: Error | null = null;
  /** The id of the last control request seen — lets a test forge an ack for it. */
  lastControlId: number | null = null;
  private legacyTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly ext: FakeExtension,
    readonly port: number,
    readonly instanceId: string,
  ) {}

  /**
   * Redial the port, keeping every scrap of in-memory state — which is exactly
   * what background.js does: `connections` is keyed by port, so a daemon
   * restart reuses the SAME connection object, tab and debugger attachment
   * included. Nothing detaches when a daemon exits.
   */
  async reopen(): Promise<void> {
    this.close();
    this.role = null;
    await this.open();
  }

  async open(): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (raw) => this.onMessage(String(raw)));
    this.send({
      type: 'hello',
      agent: 'ghax-ext',
      version: '0.3.0',
      // Install-wide identity: the SAME browser talks to every daemon, and each
      // daemon keeps its own peer registry, so sharing the id is correct.
      instanceId: this.instanceId,
      browser: 'edge',
      label: '',
      controlledTabId: this.controlledTabId,
    });
    // Mirrors the legacy fallback in extension/background.js: a daemon that
    // never answers `hello` is assumed pre-v2 and self-granted 'bound' — but
    // ONLY on the configured base port, because every other port in the scan
    // window is normally free and silence there identifies nothing.
    if (this.port === this.ext.basePort) {
      this.legacyTimer = setTimeout(() => {
        if (this.role === null && this.ws?.readyState === WebSocket.OPEN) this.role = 'bound';
      }, LEGACY_FALLBACK_MS);
      this.legacyTimer.unref?.();
    }
  }

  send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    if (this.legacyTimer) {
      clearTimeout(this.legacyTimer);
      this.legacyTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * Wipe the volatile half of the worker, the way an MV3 eviction does: the
   * connection objects and the tab-ownership registry are gone, but
   * chrome.storage.local (`ext.controlledTabs`) survives.
   */
  simulateWorkerRespawn(): void {
    if (this.controlledTabId != null) this.ext.tabOwners.delete(this.controlledTabId);
    this.controlledTabId = null;
    this.daemonId = null;
    this.role = null;
  }

  private setControlled(tabId: number | null): void {
    const previous = this.controlledTabId;
    if (previous != null && previous !== tabId && this.ext.tabOwners.get(previous) === this) {
      this.ext.tabOwners.delete(previous);
    }
    this.controlledTabId = tabId;
    if (tabId != null) {
      this.ext.tabOwners.set(tabId, this);
      this.ext.controlledTabs.set(this.port, { daemonId: this.daemonId, tabId });
    } else {
      this.ext.controlledTabs.delete(this.port);
    }
  }

  /**
   * Mirrors `applyRole` in extension/background.js: a daemon id that differs
   * from the one this connection last saw means a DIFFERENT agent holds the
   * port, so the tab goes back to the pool before we drive for the new one —
   * and the persisted entry is only restored for a matching id.
   */
  private applyRole(role: string, daemonId: unknown): void {
    const nextDaemonId = typeof daemonId === 'string' && daemonId ? daemonId : null;
    if (nextDaemonId !== this.daemonId) {
      if (this.controlledTabId != null && this.ext.tabOwners.get(this.controlledTabId) === this) {
        this.ext.tabOwners.delete(this.controlledTabId);
      }
      this.controlledTabId = null;
      this.daemonId = nextDaemonId;
    }
    this.role = role;
    if (role !== 'bound') return;
    this.restorePersistedTab();
    // Unconditional, so the daemon's view of the controlled tab is always the
    // extension's — including "none" after an identity change.
    this.send({ type: 'controlled', tabId: this.controlledTabId });
  }

  private restorePersistedTab(): void {
    if (this.controlledTabId != null || !this.daemonId) return;
    const saved = this.ext.controlledTabs.get(this.port);
    if (!saved || saved.daemonId !== this.daemonId) return;
    if (this.ext.ownerOf(saved.tabId)) return;
    this.controlledTabId = saved.tabId;
    this.ext.tabOwners.set(saved.tabId, this);
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'hello-ack' || msg.type === 'role') {
      this.applyRole(msg.role, msg.daemonId);
      return;
    }
    if (msg.type === 'ping' || msg.type === 'pong') return;
    if (msg.type === 'control') {
      this.onControl(msg);
      return;
    }
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      this.received.push(msg.method);
      this.send({ id: msg.id, result: { echoed: msg.method, tabId: this.controlledTabId } });
    }
  }

  /**
   * Mirrors switchControlTo in extension/background.js, minus the parts a
   * socket-level fake cannot have (there is no real chrome.debugger here). What
   * it DOES model is the ownership bookkeeping and the order it happens in,
   * which is where the defect lived: everything up to and including the claim
   * runs before the attach that can still refuse.
   */
  private switchControlTo(tabId: number): void {
    // assertBound — refused before any claim is recorded, or an instance that
    // drives nothing would take the tab out of the pool for the ones that do.
    if (this.role !== 'bound') {
      throw new Error(
        'this browser is parked — another browser is bound to the ghax daemon. '
        + 'Run `ghax bridge use <id|browser>` to switch.',
      );
    }
    const previousTabId = this.controlledTabId;
    this.ext.claim(this, tabId);
    this.setControlled(tabId);
    if (this.attachFailure) {
      // A permanent attach failure propagates as a FAILED control-ack, which
      // leaves the daemon on the old tab — so ownership has to go back too, or
      // the two disagree about which document the refs belong to.
      this.setControlled(previousTabId);
      throw this.attachFailure;
    }
  }

  private onControl(msg: any): void {
    const id = msg.id ?? null;
    if (typeof msg.id === 'number') this.lastControlId = msg.id;
    if (this.swallowControl) return; // never answered — the request stays pending
    try {
      if (msg.action === 'stop') {
        this.setControlled(null);
        this.send({ type: 'control-ack', id, ok: true, tabId: null });
        return;
      }
      if (msg.action === 'list-tabs') {
        this.send({
          type: 'control-ack', id, ok: true, tabId: this.controlledTabId,
          result: this.ext.tabs.map((tab) => {
            const owner = this.ext.ownerOf(tab.id);
            return {
              id: tab.id,
              title: tab.title,
              url: tab.url,
              active: tab.id === this.controlledTabId,
              controlledBy: owner ? owner.port : null,
            };
          }),
        });
        return;
      }
      let tabId: number;
      if (msg.action === 'control-active') {
        tabId = this.ext.tabs[0].id; // the "focused" tab
      } else if (msg.action === 'control-tab') {
        tabId = Number(msg.tabId);
      } else if (msg.action === 'new-window') {
        tabId = Math.max(...this.ext.tabs.map((t) => t.id)) + 1;
        this.ext.tabs.push({ id: tabId, title: 'new window', url: String(msg.url ?? 'about:blank') });
      } else {
        throw new Error(`unknown control action: ${msg.action}`);
      }
      this.switchControlTo(tabId);
      this.send({
        type: 'control-ack', id, ok: true, tabId,
        ...(msg.action === 'new-window'
          ? { result: { id: tabId, title: 'new window', url: String(msg.url ?? 'about:blank'), active: true } }
          : {}),
      });
      this.send({ type: 'controlled', tabId });
    } catch (err) {
      const message = (err as Error).message;
      this.controlErrors.push(message);
      this.send({ type: 'control-ack', id, ok: false, error: message });
    }
  }
}

let nextBase = 19500;
/** Reserve a fresh 2-port window per test so parallel binds can't collide. */
function reserveBase(): number {
  const base = nextBase;
  nextBase += BRIDGE_PORT_RANGE;
  return base;
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
  console.log('bridge multi-agent simulator — no browser required\n');

  await test('two daemons on one base port land on adjacent ports', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    try {
      assert(a.port === base, `first daemon should take the base port, got ${a.port}`);
      assert(b.port === base + 1, `second daemon should take the next port, got ${b.port}`);
    } finally {
      a.close();
      b.close();
      await sleep(20);
    }
  });

  // Without this, `--bridge-port 9223` would silently bind somewhere else and
  // the user's carefully-configured extension would dial an empty port.
  await test('an EXPLICIT port never scans — it binds or it errors', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    try {
      let caught: any;
      try {
        await Bridge.create(base, () => undefined, { scan: false });
      } catch (err) {
        caught = err;
      }
      assert(caught, 'a busy explicit port must reject');
      assert(
        String(caught.message).includes('omit --bridge-port'),
        `error should say how to fix it: ${caught?.message}`,
      );
    } finally {
      a.close();
      await sleep(20);
    }
  });

  await test('the whole port range busy fails with a clear error', async () => {
    const base = reserveBase();
    const bridges: Bridge[] = [];
    try {
      for (let i = 0; i < BRIDGE_PORT_RANGE; i++) {
        bridges.push(await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS }));
      }
      let caught: any;
      try {
        await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
      } catch (err) {
        caught = err;
      }
      assert(caught, 'a fully busy range must reject');
      assert(
        String(caught.message).includes('ghax detach'),
        `error should hint at freeing a port: ${caught?.message}`,
      );
    } finally {
      for (const b of bridges) b.close();
      await sleep(20);
    }
  });

  // The two runtimes can't share source (one's TS, the other's an unbuilt
  // MV3 content script), so the MUST-match comment in extension/background.js
  // is the only thing keeping its PORT_RANGE aligned with BRIDGE_PORT_RANGE.
  // Pin it here so drift fails loudly instead of silently stranding a daemon
  // outside the window the extension actually scans.
  await test('extension and daemon port-range constants agree', async () => {
    const source = readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
    const match = source.match(/const PORT_RANGE = (\d+)/);
    assert(match, 'could not find `const PORT_RANGE = <n>` in extension/background.js');
    const extensionRange = Number(match![1]);
    assert(
      extensionRange === BRIDGE_PORT_RANGE,
      `extension/background.js PORT_RANGE (${extensionRange}) must match BRIDGE_PORT_RANGE `
      + `(${BRIDGE_PORT_RANGE}) in src/bridge.ts`,
    );
  });

  await test('one extension, two daemons: each binds independently', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    try {
      const ca = await ext.connect(a.port);
      const cb = await ext.connect(b.port);
      await until(() => a.connected && b.connected, 'both daemons to bind');
      assert(ca.role === 'bound', `connection A should be bound, got ${ca.role}`);
      // The SAME instanceId reaches both daemons — each has its own registry,
      // so "one browser" must not read as "a rival to park".
      assert(cb.role === 'bound', `connection B should be bound too, got ${cb.role}`);

      await a.sendControl({ action: 'control-tab', tabId: 1 });
      await b.sendControl({ action: 'control-tab', tabId: 2 });
      assert(a.controlledTabId === 1, `daemon A should drive tab 1, got ${a.controlledTabId}`);
      assert(b.controlledTabId === 2, `daemon B should drive tab 2, got ${b.controlledTabId}`);

      // The original bug: every relayed command dispatched to one global tab id,
      // so "tab id is always the same" no matter which session asked.
      const ra = await a.send('Runtime.evaluate', { expression: '1' }) as { tabId?: number };
      const rb = await b.send('Runtime.evaluate', { expression: '2' }) as { tabId?: number };
      assert(ra.tabId === 1, `A's command should land on tab 1, got ${ra.tabId}`);
      assert(rb.tabId === 2, `B's command should land on tab 2, got ${rb.tabId}`);
    } finally {
      ext.closeAll();
      a.close();
      b.close();
      await sleep(20);
    }
  });

  await test('a tab owned by another agent is refused with a fix-it message', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    try {
      await ext.connect(a.port);
      const cb = await ext.connect(b.port);
      await until(() => a.connected && b.connected, 'both daemons to bind');

      await a.sendControl({ action: 'control-tab', tabId: 1 });
      let caught: any;
      try {
        await b.sendControl({ action: 'control-tab', tabId: 1 });
      } catch (err) {
        caught = err;
      }
      assert(caught, 'the second agent must be refused');
      assert(
        String(caught.message).includes('already controlled by another ghax agent'),
        `error should name the conflict: ${caught?.message}`,
      );
      assert(
        String(caught.message).includes(`bridge port ${a.port}`),
        `error should name the owning daemon's port: ${caught?.message}`,
      );
      // A refused claim must leave BOTH agents where they were.
      assert(a.controlledTabId === 1, `A should still own tab 1, got ${a.controlledTabId}`);
      assert(cb.controlledTabId === null, `B should own nothing, got ${cb.controlledTabId}`);
    } finally {
      ext.closeAll();
      a.close();
      b.close();
      await sleep(20);
    }
  });

  await test('stopping releases the tab so the other agent can take it', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    try {
      await ext.connect(a.port);
      await ext.connect(b.port);
      await until(() => a.connected && b.connected, 'both daemons to bind');

      await a.sendControl({ action: 'control-tab', tabId: 1 });
      await a.sendControl({ action: 'stop' });
      const ack = await b.sendControl({ action: 'control-tab', tabId: 1 });
      assert(ack.ok && ack.tabId === 1, `B should take the released tab, got ${JSON.stringify(ack)}`);
    } finally {
      ext.closeAll();
      a.close();
      b.close();
      await sleep(20);
    }
  });

  await test('list-tabs reports which agent owns each tab', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    try {
      await ext.connect(a.port);
      await ext.connect(b.port);
      await until(() => a.connected && b.connected, 'both daemons to bind');
      await a.sendControl({ action: 'control-tab', tabId: 1 });
      await b.sendControl({ action: 'control-tab', tabId: 2 });

      const ack = await a.sendControl({ action: 'list-tabs' });
      const tabs = ack.result as Array<{ id: number; active: boolean; controlledBy: number | null }>;
      const one = tabs.find((t) => t.id === 1)!;
      const two = tabs.find((t) => t.id === 2)!;
      const three = tabs.find((t) => t.id === 3)!;
      // `active` stays "mine"; `controlledBy` is what makes the OTHER agent's
      // territory visible instead of looking free.
      assert(one.active === true, 'the asking agent\'s own tab is the active one');
      assert(two.active === false, 'another agent\'s tab must not read as active');
      assert(one.controlledBy === a.port, `tab 1 should be owned by ${a.port}, got ${one.controlledBy}`);
      assert(two.controlledBy === b.port, `tab 2 should be owned by ${b.port}, got ${two.controlledBy}`);
      assert(three.controlledBy === null, `an unclaimed tab should be free, got ${three.controlledBy}`);
    } finally {
      ext.closeAll();
      a.close();
      b.close();
      await sleep(20);
    }
  });

  await test('a debugger event for one agent\'s tab reaches only that daemon', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    const seenA: string[] = [];
    const seenB: string[] = [];
    try {
      await ext.connect(a.port);
      await ext.connect(b.port);
      await until(() => a.connected && b.connected, 'both daemons to bind');
      a.onEvent((ev) => seenA.push(ev.method));
      b.onEvent((ev) => seenB.push(ev.method));

      await a.sendControl({ action: 'control-tab', tabId: 1 });
      await b.sendControl({ action: 'control-tab', tabId: 2 });

      ext.dispatchDebuggerEvent(1, 'Page.loadEventFired', {});
      await until(() => seenA.length === 1, 'daemon A to receive its tab\'s event');
      await sleep(50); // give a misrouted event time to show up
      assert(seenB.length === 0, `daemon B received ${seenB.length} events for a tab it does not own`);

      ext.dispatchDebuggerEvent(2, 'Page.frameNavigated', {});
      await until(() => seenB.length === 1, 'daemon B to receive its own tab\'s event');
      assert(seenA.length === 1, `daemon A should still have exactly 1 event, got ${seenA.length}`);
    } finally {
      ext.closeAll();
      a.close();
      b.close();
      await sleep(20);
    }
  });

  await test('control-active is refused when the focused tab is owned by another agent', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    try {
      await ext.connect(a.port);
      const cb = await ext.connect(b.port);
      await until(() => a.connected && b.connected, 'both daemons to bind');

      // tabs[0] (id 1) is the "focused" tab control-active always resolves to.
      await a.sendControl({ action: 'control-tab', tabId: 1 });
      let caught: any;
      try {
        await b.sendControl({ action: 'control-active' });
      } catch (err) {
        caught = err;
      }
      assert(caught, 'control-active must not steal a tab another agent owns');
      assert(
        String(caught.message).includes('already controlled by another ghax agent'),
        `error should name the conflict: ${caught?.message}`,
      );
      assert(a.controlledTabId === 1, `A should still own tab 1, got ${a.controlledTabId}`);
      assert(cb.controlledTabId === null, `B should own nothing, got ${cb.controlledTabId}`);
    } finally {
      ext.closeAll();
      a.close();
      b.close();
      await sleep(20);
    }
  });

  await test('a refused switch leaves an already-controlling agent on its own tab', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    try {
      await ext.connect(a.port);
      await ext.connect(b.port);
      await until(() => a.connected && b.connected, 'both daemons to bind');

      await a.sendControl({ action: 'control-tab', tabId: 1 });
      await b.sendControl({ action: 'control-tab', tabId: 2 });

      // A already drives tab 1 and tries to move to B's tab 2 — must be
      // refused, and must NOT leave A holding neither tab.
      let caught: any;
      try {
        await a.sendControl({ action: 'control-tab', tabId: 2 });
      } catch (err) {
        caught = err;
      }
      assert(caught, 'A must be refused when reaching for tab 2');
      assert(a.controlledTabId === 1, `A should still be on its own tab 1, got ${a.controlledTabId}`);
      assert(b.controlledTabId === 2, `B should be undisturbed on tab 2, got ${b.controlledTabId}`);
    } finally {
      ext.closeAll();
      a.close();
      b.close();
      await sleep(20);
    }
  });

  await test('new-window from two agents lands each on its own distinct tab', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    try {
      await ext.connect(a.port);
      await ext.connect(b.port);
      await until(() => a.connected && b.connected, 'both daemons to bind');

      const ackA = await a.sendControl({ action: 'new-window', url: 'https://a.example' });
      const ackB = await b.sendControl({ action: 'new-window', url: 'https://b.example' });
      assert(ackA.tabId !== ackB.tabId, `each new-window should get its own tab, got ${ackA.tabId} and ${ackB.tabId}`);
      assert(a.controlledTabId === ackA.tabId, 'A should now control the tab it just opened');
      assert(b.controlledTabId === ackB.tabId, 'B should now control the tab it just opened');

      // Original bug class: commands must route to the tab THIS connection
      // opened, not whichever new-window landed last.
      const ra = await a.send('Runtime.evaluate', { expression: '1' }) as { tabId?: number };
      const rb = await b.send('Runtime.evaluate', { expression: '2' }) as { tabId?: number };
      assert(ra.tabId === ackA.tabId, `A's command should land on its own new tab, got ${ra.tabId}`);
      assert(rb.tabId === ackB.tabId, `B's command should land on its own new tab, got ${rb.tabId}`);
    } finally {
      ext.closeAll();
      a.close();
      b.close();
      await sleep(20);
    }
  });

  await test('a legacy single-port extension still works when a second daemon has scanned past it', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    try {
      assert(b.port === a.port + 1, `second daemon should have landed on ${a.port + 1}, got ${b.port}`);
      // A pre-v0.3 extension dials only the configured base port — never the
      // scanned range — so only connect to `a` here.
      const ca = await ext.connect(a.port);
      await until(() => a.connected, 'the single connection to bind');
      assert(ca.role === 'bound', `the lone connection should bind, got ${ca.role}`);
      assert(!b.connected, 'daemon B should sit unreachable — a legacy extension never dials it');

      await a.sendControl({ action: 'control-tab', tabId: 1 });
      const result = await a.send('Runtime.evaluate', { expression: '1' }) as { tabId?: number };
      assert(result.tabId === 1, `A should still work normally end-to-end, got ${JSON.stringify(result)}`);
    } finally {
      ext.closeAll();
      a.close();
      b.close();
      await sleep(20);
    }
  });

  // The multiplexer turned nine normally-FREE localhost ports into ports the
  // extension dials unprompted. Anything can accept a socket there and stay
  // silent; if silence still promoted a connection to 'bound', that process
  // would inherit CDP over the user's real authenticated browser without ever
  // presenting a pairing code (a paired daemon answers `hello-reject`).
  await test('silence promotes only on the base port — a squatted scan port stays unbound', async () => {
    const base = reserveBase();
    // Servers that accept the connection and answer NOTHING — no hello-ack, no
    // hello-reject. Stands in for both a pre-v2 daemon and a port squatter.
    const onBase = new WebSocketServer({ port: base, host: '127.0.0.1' });
    const offBase = new WebSocketServer({ port: base + 1, host: '127.0.0.1' });
    const ext = new FakeExtension(base);
    try {
      const legacy = await ext.connect(base);
      const squatter = await ext.connect(base + 1);
      await until(
        () => legacy.role === 'bound',
        'the base-port connection to take the legacy fallback',
      );
      // Same silence, same elapsed time, one port over.
      await sleep(LEGACY_FALLBACK_MS + 300);
      assert(
        squatter.role === null,
        `a silent server on port ${base + 1} must never be granted a role, got ${squatter.role}`,
      );
    } finally {
      ext.closeAll();
      onBase.close();
      offBase.close();
      await sleep(20);
    }
  });

  // A bridge port is a POOL SLOT, not an agent. Nothing detaches when a daemon
  // exits, so without an identity check the next agent to land on a freed port
  // would silently inherit the previous agent's tab — and drive it.
  await test('a new daemon on a freed port does not inherit the previous agent\'s tab', async () => {
    const base = reserveBase();
    const first = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    let second: Bridge | null = null;
    try {
      const conn = await ext.connect(first.port);
      await until(() => conn.role === 'bound', 'agent A to bind');
      await first.sendControl({ action: 'control-tab', tabId: 1 });
      assert(conn.controlledTabId === 1, `A should be driving tab 1, got ${conn.controlledTabId}`);

      // `ghax detach`. The extension keeps the tab AND its debugger attachment:
      // a daemon exiting tears down nothing on the browser side.
      first.close();
      await sleep(60);
      assert(conn.controlledTabId === 1, 'the extension keeps its tab when the daemon exits');

      second = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
      assert(second.port === first.port, `the freed port should be reused, got ${second.port}`);
      await conn.reopen();
      await until(() => conn.role === 'bound', 'agent B to bind on the reused port');
      await until(
        () => second!.controlledTabId === null,
        'B\'s daemon to be told it has no controlled tab',
      );
      assert(conn.controlledTabId === null, `B must not inherit tab 1, got ${conn.controlledTabId}`);
      assert(ext.ownerOf(1) === null, 'the previous agent\'s tab must go back to the pool');
    } finally {
      ext.closeAll();
      first.close();
      second?.close();
      await sleep(20);
    }
  });

  await test('the SAME daemon returning re-adopts its tab and reports it', async () => {
    const base = reserveBase();
    const bridge = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    try {
      const conn = await ext.connect(bridge.port);
      await until(() => conn.role === 'bound', 'the daemon to bind');
      await bridge.sendControl({ action: 'control-tab', tabId: 2 });
      // Drop the daemon's own re-assert, so the ONLY thing that can restore the
      // tab here is the extension recognising the daemon id it persisted under.
      bridge.setDesiredControl({ action: 'stop' });

      conn.simulateWorkerRespawn();
      await conn.reopen();
      await until(() => conn.role === 'bound', 'the respawned worker to rebind');
      assert(conn.controlledTabId === 2, `the same daemon should re-adopt tab 2, got ${conn.controlledTabId}`);
      // The other half: a connection that never re-attaches must still tell the
      // daemon which tab it holds, or the daemon drives a tab it thinks is free.
      await until(() => bridge.controlledTabId === 2, 'the daemon to be told tab 2 is controlled');
    } finally {
      ext.closeAll();
      bridge.close();
      await sleep(20);
    }
  });

  // Ownership is registered per BROWSER (one `tabOwners` map per worker), so a
  // parked connection that recorded a claim would lock the tab against the
  // other agents that browser is legitimately driving.
  await test('a parked connection refuses control-tab without touching ownership', async () => {
    const base = reserveBase();
    const x = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const y = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const browserA = new FakeExtension();
    const browserB = new FakeExtension();
    try {
      const a = await browserA.connect(x.port, 'inst-a');
      await until(() => a.role === 'bound', 'browser A to take daemon X');
      const bParked = await browserB.connect(x.port, 'inst-b');
      await until(() => bParked.role === 'parked', 'browser B to park on daemon X');
      const bBound = await browserB.connect(y.port, 'inst-b');
      await until(() => bBound.role === 'bound', 'browser B to bind daemon Y');

      // Deliberately routing an attach-requiring action at a parked instance —
      // the refusal is the contract, and it must come before any bookkeeping.
      let caught: any;
      try {
        await x.sendControlToInstance('inst-b', { action: 'control-tab', tabId: 1 });
      } catch (err) {
        caught = err;
      }
      assert(caught, 'a parked connection must refuse control-tab');
      assert(String(caught.message).includes('parked'), `error should say why: ${caught?.message}`);
      assert(bParked.controlledTabId === null, `a refused switch must select nothing, got ${bParked.controlledTabId}`);
      assert(browserB.tabOwners.size === 0, 'a refused switch must record no ownership');

      // The proof that nothing was locked: browser B's real agent still gets it.
      const ack = await y.sendControl({ action: 'control-tab', tabId: 1 });
      assert(ack.ok && ack.tabId === 1, `the bound agent should still claim tab 1, got ${JSON.stringify(ack)}`);
    } finally {
      browserA.closeAll();
      browserB.closeAll();
      x.close();
      y.close();
      await sleep(20);
    }
  });

  // The ack the daemon gets back is `ok:false`, so it keeps believing the OLD
  // tab. If the extension moved anyway, the two disagree about which document
  // is under control and a `@e3` from the old page resolves against the new
  // one (CLAUDE.md invariant 3) — silently.
  await test('a switch that cannot attach is a no-op, not a half-move', async () => {
    const base = reserveBase();
    const x = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const y = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const ext = new FakeExtension();
    try {
      const cx = await ext.connect(x.port, 'inst-x');
      const cy = await ext.connect(y.port, 'inst-y');
      await until(() => x.connected && y.connected, 'both daemons to bind');
      await x.sendControl({ action: 'control-tab', tabId: 1 });

      cx.attachFailure = new Error('Cannot access a chrome-extension:// URL of different extension');
      let caught: any;
      try {
        await x.sendControl({ action: 'control-tab', tabId: 3 });
      } catch (err) {
        caught = err;
      }
      assert(caught, 'a permanently unattachable target must fail the switch');
      assert(cx.controlledTabId === 1, `the agent must stay on its own tab 1, got ${cx.controlledTabId}`);
      assert(x.controlledTabId === 1, `the daemon must still be told tab 1, got ${x.controlledTabId}`);
      assert(ext.ownerOf(3) === null, 'the tab it failed to take must go back to the pool');

      // And be genuinely free: another agent can take it.
      const ack = await y.sendControl({ action: 'control-tab', tabId: 3 });
      assert(ack.ok && ack.tabId === 3, `the other agent should claim tab 3, got ${JSON.stringify(ack)}`);
      assert(cy.controlledTabId === 3, `B should be driving tab 3, got ${cy.controlledTabId}`);
    } finally {
      ext.closeAll();
      x.close();
      y.close();
      await sleep(20);
    }
  });

  // The grace window exists to protect the incumbent through an MV3 respawn.
  // If a rival could bind while the session was merely DEGRADED, every routine
  // service-worker eviction was an opportunity for another install to seize it.
  await test('a rival parks during the grace window and binds only after it expires', async () => {
    const base = reserveBase();
    const bridge = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const browserA = new FakeExtension();
    const browserB = new FakeExtension();
    try {
      const a = await browserA.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      a.close(); // the worker was evicted mid-session
      await until(() => bridge.state === 'DEGRADED', 'the session to degrade');

      const b = await browserB.connect(bridge.port, 'inst-b');
      await until(() => b.role !== null, 'B to get a disposition');
      assert(b.role === 'parked', `a rival must park while the incumbent may return, got ${b.role}`);

      await until(() => bridge.state === 'EXPIRED', 'the grace window to expire');
      await b.reopen();
      await until(() => b.role !== null, 'B to get a post-expiry disposition');
      const afterExpiry: string | null = b.role;
      assert(afterExpiry === 'bound', `after the grace expires the rival may bind, got ${afterExpiry}`);
    } finally {
      browserA.closeAll();
      browserB.closeAll();
      bridge.close();
      await sleep(20);
    }
  });

  // Control ids are minted per daemon, not per peer, so correlating an ack by
  // id alone let ANY connected peer answer a request it never received.
  await test('a control-ack from another peer cannot answer the bound peer\'s request', async () => {
    const base = reserveBase();
    const bridge = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS });
    const browserA = new FakeExtension();
    const browserB = new FakeExtension();
    try {
      const bound = await browserA.connect(bridge.port, 'inst-bound');
      await until(() => bound.role === 'bound', 'A to bind');
      const parked = await browserB.connect(bridge.port, 'inst-parked');
      await until(() => parked.role === 'parked', 'B to park');

      bound.swallowControl = true;
      // Comfortably inside LIVENESS_MS: these fakes never ping, so a longer
      // timeout would be beaten by the daemon terminating the silent socket and
      // the check would pass for the wrong reason.
      const pending = bridge.sendControl({ action: 'list-tabs' }, 250);
      await until(() => bound.lastControlId !== null, 'the bound peer to receive the request');

      parked.send({
        type: 'control-ack',
        id: bound.lastControlId,
        ok: true,
        tabId: 99,
        result: [{ id: 99, title: 'a parked browser\'s tab', url: 'https://parked.example', active: true, controlledBy: null }],
      });

      let caught: any;
      try {
        await pending;
      } catch (err) {
        caught = err;
      }
      assert(caught, 'the parked peer\'s ack must not resolve the bound peer\'s request');
      assert(
        String(caught.message).includes('timed out'),
        `the request should stay unanswered: ${caught?.message}`,
      );
      assert(
        bridge.controlledTabId !== 99,
        `a forged ack must not set the controlled tab, got ${bridge.controlledTabId}`,
      );
    } finally {
      browserA.closeAll();
      browserB.closeAll();
      bridge.close();
      await sleep(20);
    }
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
