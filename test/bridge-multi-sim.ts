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

// Never read the real machine's browser profiles: names come from hello only.
process.env.GHAX_BROWSER_PROFILE_ROOTS = '';
import { WebSocket, WebSocketServer } from 'ws';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Bridge, BridgeInterrupted, BRIDGE_PORT_RANGE } from '../src/bridge';
import { PeerRegistry } from '../src/bridge-peers';
import { waitForTargetPage } from '../src/target-match';
import { CircularBuffer, type ConsoleEntry, type NetworkEntry } from '../src/buffers';
import {
  activePeerState, pickMainFrameContext, wireBridgePageEvents, type BridgePageSink,
} from '../src/bridge-page-state';
import {
  bridgeRowsToIdentities, cwdLabel, displayBrand, formatTabLine, mintAliases, ownerLabel, resolveTabSelector, sanitizeLabel, TabResolveError, type TabIdentity, type TabOwner,
} from '../src/tab-identity';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const GRACE_MS = 400;
const LIVENESS_MS = 600;
/** One browser per daemon here, so first-hello-wins is the behaviour under
 * test; the settle window is bridge-sim's business. */
const SETTLE_MS = 0;
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
  /** Tab id shown in the (single) fake window; null = the first tab. */
  foregroundTabId: number | null = null;
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

  /** `hello.browser`. */
  browser = 'edge';
  /**
   * The popup "Profile name". null = an extension predating tab identity: no
   * `profile` / `brandVersion` in hello and `label` empty, so the daemon must
   * fall back to `<brand>-<short6>`.
   */
  profile: string | null = null;
  /** `hello.sessionNonce`; null = an extension predating it. */
  sessionNonce: string | null = null;

  async connect(port: number, instanceId = 'inst-browser'): Promise<FakeConnection> {
    const conn = new FakeConnection(this, port, instanceId);
    this.connections.push(conn);
    await conn.open();
    return conn;
  }

  /**
   * chrome.runtime.reload(): kills the WHOLE service worker, not just the
   * connection that asked for it — every daemon sharing this browser drops
   * and reconnects independently, on its own reconnect loop. Mirrors the
   * `reload` branch of handleControl in extension/background.js: each
   * connection's in-memory tab claim is wiped first (simulateWorkerRespawn),
   * same as an ordinary MV3 eviction, then every socket closes and reopens.
   * This is the multi-agent fact `ghax bridge reload --force` exists to warn
   * about at the CLI layer (Rust-only logic, exercised instead by
   * `cargo test` and the live reload test — see docs/release-automation.md
   * adjacent test plan).
   */
  async reload(): Promise<void> {
    const conns = [...this.connections];
    for (const conn of conns) conn.simulateWorkerRespawn();
    for (const conn of conns) conn.close();
    await new Promise<void>((r) => setTimeout(r, 30));
    for (const conn of conns) await conn.open();
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
  /** Set to leave CDP commands unanswered, so they stay in flight. */
  swallowCdp = false;
  /**
   * A PERMANENT chrome.debugger.attach failure to raise from the attach step of
   * switchControlTo — a target that will never become attachable, as opposed to
   * the transient cert-interstitial refusal that keeps the tab selected.
   */
  attachFailure: Error | null = null;
  /** The id of the last control request seen — lets a test forge an ack for it. */
  lastControlId: number | null = null;
  /** The last control message received, whole (focus/quiet flags included). */
  lastControl: any = null;
  /**
   * Answer (or hold) a CDP command instead of the default echo. Return true
   * when handled; `reply` may be called later to release a held command.
   */
  onCdp: ((method: string, params: any, reply: (result: unknown) => void) => boolean) | null = null;
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
      browser: this.ext.browser,
      label: this.ext.profile ?? '',
      ...(this.ext.profile !== null ? { profile: this.ext.profile, brandVersion: '150' } : {}),
      ...(this.ext.sessionNonce !== null ? { sessionNonce: this.ext.sessionNonce } : {}),
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
      if (this.swallowCdp) return;
      if (this.onCdp?.(msg.method, msg.params, (result) => this.send({ id: msg.id, result }))) return;
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
    this.lastControl = msg;
    if (this.swallowControl) return; // never answered — the request stays pending
    try {
      if (msg.action === 'reload') {
        // Ack first — same as extension/background.js — then bring down the
        // whole shared worker, taking every OTHER daemon's connection with it.
        this.send({ type: 'control-ack', id, ok: true });
        setTimeout(() => { void this.ext.reload(); }, 20);
        return;
      }
      if (msg.action === 'stop') {
        this.setControlled(null);
        this.send({ type: 'control-ack', id, ok: true, tabId: null });
        return;
      }
      if (msg.action === 'close-tab') {
        // Mirrors extension/background.js: refuse another agent's tab, release
        // our own controlled tab first, then remove it.
        const tabId = Number(msg.tabId);
        const owner = this.ext.ownerOf(tabId);
        if (owner && owner !== this) this.ext.claim(this, tabId); // throws the conflict
        if (this.controlledTabId === tabId) {
          this.setControlled(null);
          this.send({ type: 'controlled', tabId: null });
        }
        this.ext.tabs = this.ext.tabs.filter((t) => t.id !== tabId);
        this.send({ type: 'control-ack', id, ok: true, tabId: this.controlledTabId, result: { closed: tabId } });
        return;
      }
      if (msg.action === 'list-tabs') {
        this.send({
          type: 'control-ack', id, ok: true, tabId: this.controlledTabId,
          result: this.ext.tabs.map((tab, i) => {
            const owner = this.ext.ownerOf(tab.id);
            return {
              id: tab.id,
              title: tab.title,
              url: tab.url,
              active: tab.id === this.controlledTabId,
              // The window's foreground tab; the first tab unless a test moves it.
              windowActive: tab.id === (this.ext.foregroundTabId ?? this.ext.tabs[0]?.id),
              controlledBy: owner ? owner.port : null,
              // Only extensions with tab identity report placement.
              ...(this.ext.profile !== null ? { windowId: 1, index: i } : {}),
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
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
        bridges.push(await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS }));
      }
      let caught: any;
      try {
        await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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

  // The Rust CLI's --force gate (crates/cli/src/bridge.rs) can't be reached
  // from this browser-free TS simulator — it's argv parsing + an RPC round
  // trip. What IS testable here is the fact that gate exists to warn about:
  // a reload is a shared, browser-wide event. One agent asking for it drops
  // every OTHER agent's connection too, and each agent reclaims exactly the
  // tab it was driving before — same as any other MV3 service-worker
  // eviction — with no operator action needed.
  await test('reload broadcasts to every agent sharing the browser; each reclaims its own tab', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const ext = new FakeExtension();
    try {
      const ca = await ext.connect(a.port);
      await ext.connect(b.port);
      await until(() => a.connected && b.connected, 'both daemons to bind');

      // Agent A is driving tab 1 when agent B (a different agent, on this
      // same shared browser) asks the extension to reload.
      await a.sendControl({ action: 'control-tab', tabId: 1 });
      assert(ca.controlledTabId === 1, 'A should own tab 1 before the reload');

      let aDisconnected = false;
      a.once('disconnect', () => { aDisconnected = true; });

      const ack = await b.sendControl({ action: 'reload' });
      assert(ack.ok, `reload control-ack should be ok, got ${JSON.stringify(ack)}`);

      // chrome.runtime.reload() kills the WHOLE worker — A's own connection
      // sees this as a disconnect too, even though A never asked for it.
      await until(() => aDisconnected, "agent A's connection to drop from B's reload");

      // Same browser instanceId + same (unchanged) daemonId on each side, so
      // both agents reclaim exactly the tab they were driving, unattended.
      await until(() => a.connected && b.connected, 'both agents to reconnect after the shared reload');
      assert(a.controlledTabId === 1, `A should reclaim tab 1 after the reload, got ${a.controlledTabId}`);
    } finally {
      ext.closeAll();
      a.close();
      b.close();
      await sleep(20);
    }
  });

  await test('stopping releases the tab so the other agent can take it', async () => {
    const base = reserveBase();
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const a = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const b = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const first = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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

      second = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const bridge = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const x = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const y = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const x = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const y = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const bridge = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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
    const bridge = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
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


  // ─── Tab identity (docs/design/plan/11-multi-browser.md, phase 2) ───

  /** Two browsers, both with a tab 42, one bound and one parked. */
  async function twoBrowsersWithTab42(
    fn: (bridge: Bridge, work: TabIdentity[], home: TabIdentity[]) => Promise<void>,
    profiles: [string | null, string | null] = ['Work', null],
  ): Promise<void> {
    const base = reserveBase();
    const bridge = await Bridge.create(base, () => undefined, { graceMs: GRACE_MS, livenessMs: LIVENESS_MS, settleMs: SETTLE_MS });
    const edge = new FakeExtension();
    const chrome = new FakeExtension();
    edge.browser = 'edge';
    edge.profile = profiles[0];
    chrome.browser = 'chrome';
    chrome.profile = profiles[1];
    edge.tabs = [
      { id: 7, title: 'Inbox', url: 'https://mail.example' },
      { id: 42, title: 'Bank feeds - QuickBooks', url: 'https://qbo.example' },
    ];
    chrome.tabs = [{ id: 42, title: 'Recipes', url: 'https://food.example' }];
    try {
      const a = await edge.connect(bridge.port, 'aaaaaa-edge-instance');
      await until(() => a.role === 'bound', 'edge to bind');
      const b = await chrome.connect(bridge.port, 'bbbbbb-chrome-instance');
      await until(() => b.role === 'parked', 'chrome to park');
      // What the daemon's listBridgeTabs does: list each instance, mint with
      // the alias of whoever answered.
      const list = async (sel: string): Promise<TabIdentity[]> => {
        const ack = await bridge.sendControlToInstance(sel, { action: 'list-tabs' });
        const who = bridge.identityOf(ack.instanceId!)!;
        return bridgeRowsToIdentities(ack.result as unknown[], {
          alias: who.alias, browser: displayBrand(who.browser), profile: who.profile, nonce: who.nonce || undefined,
        });
      };
      await fn(bridge, await list('aaaaaa'), await list('bbbbbb'));
    } finally {
      edge.closeAll();
      chrome.closeAll();
      bridge.close();
      await sleep(20);
    }
  }

  /** Phase-3 shape: both browsers' tabs in one numbered listing. */
  function combined(...lists: TabIdentity[][]): TabIdentity[] {
    return lists.flat().map((t, i) => ({ ...t, index: i + 1 }));
  }

  function refusal(fn: () => unknown): TabResolveError {
    try {
      fn();
    } catch (err) {
      if (err instanceof TabResolveError) return err;
      throw err;
    }
    throw new Error('expected a refusal, got a match');
  }

  await test('two browsers with a tab 42 each get distinct ids naming browser and profile', async () => {
    await twoBrowsersWithTab42(async (_bridge, work, home) => {
      const w42 = work.find((t) => t.chromeTabId === 42)!;
      const h42 = home.find((t) => t.chromeTabId === 42)!;
      assert(w42.id === 'edge-work:42', `labelled profile → slug alias, got ${w42.id}`);
      // No profile name (old extension) → <brand>-<short6>.
      assert(h42.id === 'chrome-bbbbbb:42', `unlabelled → brand-short6, got ${h42.id}`);
      assert(w42.browser === 'Edge' && w42.profile === 'Work', `edge identity: ${w42.browser} · ${w42.profile}`);
      assert(h42.browser === 'Chrome' && h42.profile === '—', `chrome identity: ${h42.browser} · ${h42.profile}`);
      assert(w42.windowId === 1 && h42.windowId === null, `windowId only from new extensions: ${w42.windowId}/${h42.windowId}`);
      assert(w42.index === 2, `index is the row number, got ${w42.index}`);
      const line = formatTabLine(w42);
      assert(
        line === '#2  edge-work:42  "Bank feeds - QuickBooks"  Edge · Work  controlledBy=none',
        `tabs text line: ${line}`,
      );
      // The window's foreground tab (first tab of the fake) gets the `active` word.
      const fg = formatTabLine(work.find((t) => t.chromeTabId === 7)!);
      assert(/^#1  edge-work:7  "Inbox"  Edge · Work( · win \d+)?  active  controlledBy=none$/.test(fg), `foreground line: ${fg}`);
    });
  });

  await test('tab 42 matching two browsers is refused, listing both with full identity', async () => {
    await twoBrowsersWithTab42(async (_bridge, work, home) => {
      const all = combined(work, home);
      const err = refusal(() => resolveTabSelector('42', all, all));
      assert(err.code === 'TAB_AMBIGUOUS', `code ${err.code}`);
      for (const want of ['edge-work:42', 'chrome-bbbbbb:42', 'Edge · Work', 'Chrome · —', 'Bank feeds', 'Recipes']) {
        assert(err.message.includes(want), `refusal should name ${want}: ${err.message}`);
      }
      // Never [0] of several, but one match is fine.
      assert(resolveTabSelector('7', all, all).id === 'edge-work:7', 'an unambiguous bare id resolves');
      assert(resolveTabSelector('chrome-bbbbbb:42', all, all).title === 'Recipes', 'the full id resolves');
      assert(refusal(() => resolveTabSelector('99', all, all)).code === 'TAB_NOT_FOUND', 'no match refuses');
    });
  });

  await test('tab #2 resolves against the last listing; a vanished #n is refused', async () => {
    await twoBrowsersWithTab42(async (_bridge, work) => {
      const last = work;
      const picked = resolveTabSelector('#2', work, last);
      assert(picked.id === 'edge-work:42', `#2 should be work:42, got ${picked.id}`);
      assert(refusal(() => resolveTabSelector('#2', work, null)).code === 'TAB_NO_LISTING', 'no listing yet refuses');
      assert(refusal(() => resolveTabSelector('#9', work, last)).code === 'TAB_NOT_FOUND', 'out of range refuses');
      // Tab 42 closes; the row that is now #2 must NOT be picked instead.
      const now = work.filter((t) => t.chromeTabId !== 42);
      const gone = refusal(() => resolveTabSelector('#2', now, last));
      assert(gone.code === 'TAB_VANISHED', `code ${gone.code}`);
      assert(gone.message.includes('edge-work:42') && gone.message.includes('Bank feeds'), `names the gone tab: ${gone.message}`);
    });
  });

  await test('an id from the parked browser is refused with a bridge use hint', async () => {
    await twoBrowsersWithTab42(async (_bridge, work, home) => {
      // `tabs --browser chrome` listed the parked one; the bound one is Edge.
      const err = refusal(() => resolveTabSelector('#1', work, home));
      assert(err.message.includes('another browser') && err.message.includes('bridge use chrome-bbbbbb'), err.message);
      const full = refusal(() => resolveTabSelector('chrome-bbbbbb:42', work, work));
      assert(full.message.includes('bridge use chrome-bbbbbb'), full.message);
    });
  });

  await test('same profile name in two brands stays distinct; bridge use takes an alias', async () => {
    await twoBrowsersWithTab42(async (bridge, work, home) => {
      const a = work.find((t) => t.chromeTabId === 42)!.id;
      const b = home.find((t) => t.chromeTabId === 42)!.id;
      assert(a === 'edge-work:42' && b === 'chrome-work:42', `brand prefix keeps them apart: ${a}, ${b}`);
      const inst = await bridge.use('chrome-work');
      assert(inst.instanceId === 'bbbbbb-chrome-instance', `bridge use <alias> binds it, got ${inst.instanceId}`);
      assert(inst.profile === 'work' && inst.brandVersion === '150', `instances() carries profile/brandVersion: ${JSON.stringify(inst)}`);
    }, ['Work', 'work']);
  });

  await test('bare 42 refuses when the last listing showed 42 in another browser', async () => {
    await twoBrowsersWithTab42(async (_bridge, work, home) => {
      // `tabs --browser chrome` listed chrome's 42; Edge is bound and has a 42.
      const err = refusal(() => resolveTabSelector('42', work, home));
      assert(err.code === 'TAB_AMBIGUOUS', `code ${err.code}`);
      assert(err.message.includes('edge-work:42') && err.message.includes('chrome-bbbbbb:42'), err.message);
      // A listing of the bound browser itself is no rival.
      assert(resolveTabSelector('42', work, work).id === 'edge-work:42', 'own listing resolves');
      assert(resolveTabSelector('42', work, null).id === 'edge-work:42', 'no listing resolves');
    });
  });

  await test('#n is refused after the browser restarts (nonce), and heuristically without a nonce', async () => {
    const row = (nonce: string | undefined, title = 'Bank', url = 'https://a'): TabIdentity => ({
      index: 1, id: 'edge-work:42', chromeTabId: 42, browser: 'Edge', profile: 'Work', windowId: 1,
      title, url, active: false, controlledBy: null, ...(nonce ? { nonce } : {}),
    });
    assert(resolveTabSelector('#1', [row('n1')], [row('n1')]).id === 'edge-work:42', 'same session resolves');
    const e1 = refusal(() => resolveTabSelector('#1', [row('n2', 'Other', 'https://b')], [row('n1')]));
    assert(e1.code === 'TAB_VANISHED' && e1.message.includes('restarted'), e1.message);
    // Same page under a new nonce is still refused: the number was reassigned.
    assert(refusal(() => resolveTabSelector('#1', [row('n2')], [row('n1')])).code === 'TAB_VANISHED', 'nonce change refuses');
    // Old extension: refuse only when url AND title both differ.
    assert(refusal(() => resolveTabSelector('#1', [row(undefined, 'Other', 'https://b')], [row(undefined)])).code === 'TAB_VANISHED', 'both differ refuses');
    assert(resolveTabSelector('#1', [row(undefined, 'Bank (2)', 'https://a')], [row(undefined)]).id === 'edge-work:42', 'title-only change resolves');
    assert(resolveTabSelector('#1', [row(undefined, 'Bank', 'https://a/x')], [row(undefined)]).id === 'edge-work:42', 'url-only change resolves');
  });

  await test('mintAliases: the unlabelled-vs-named collision stays unique', async () => {
    // Unlabelled Edge `abcdef…` falls back to edge-abcdef; a profile named
    // "abcdef" slugs to the same thing.
    const unlabelled = { instanceId: 'abcdef-1111', browser: 'edge', profile: '' };
    const named = { instanceId: 'zzzzzz-2222', browser: 'edge', profile: 'abcdef' };
    const m = mintAliases([unlabelled, named]);
    const a = m.get('abcdef-1111')!, b = m.get('zzzzzz-2222')!;
    assert(a !== b, `must differ: ${a} / ${b}`);
    assert(new Set(m.values()).size === 2, 'unique');
    // Pathological: same short6 prefix AND same names → longer prefixes.
    const x = { instanceId: 'abcdef-1', browser: 'edge', profile: 'w' };
    const y = { instanceId: 'abcdef-2', browser: 'edge', profile: 'w' };
    const mm = mintAliases([x, y]);
    assert(new Set(mm.values()).size === 2, `longer prefix until unique: ${[...mm.values()]}`);
    // Pinned aliases are kept; the newcomer moves.
    const mp = mintAliases([x, y], new Map([['abcdef-1', 'edge-w']]));
    assert(mp.get('abcdef-1') === 'edge-w' && mp.get('abcdef-2') !== 'edge-w', `pinned wins: ${[...mp.values()]}`);
  });

  await test('sanitizeLabel strips controls and newlines, caps at 40', async () => {
    const s = sanitizeLabel('Wo\nrk\x00\u202e\u200b ' + 'x'.repeat(80));
    // The control characters are the point: this asserts they are stripped.
    // oxlint-disable-next-line no-control-regex
    assert(!/[\n\x00\u202e\u200b]/.test(s) && s.length <= 40 && s.startsWith('Work x'), JSON.stringify(s));
    assert(sanitizeLabel('Zoë') === 'Zoë', 'letters survive');
  });

  await test('cwdLabel takes the basename before capping, so a long path keeps its last segment', async () => {
    const long = '/Users/someone/Documents/DevOps/kepptic/products/open-source/kepptic/ghax/';
    assert(sanitizeLabel(long).split('/').pop() !== 'ghax', 'premise: capping first loses the basename');
    assert(cwdLabel(long) === 'ghax', `cwdLabel: ${cwdLabel(long)}`);
    assert(cwdLabel('C:\\work\\repo') === 'repo', 'windows separators');
    assert(cwdLabel('/a/b\nc\u202e') === 'bc', `controls stripped after the split: ${JSON.stringify(cwdLabel('/a/b\nc\u202e'))}`);
    const owner: TabOwner = { port: 9224, pid: 7, name: null, cwd: cwdLabel(long), self: false };
    assert(ownerLabel(owner) === 'ghax/7', `ownerLabel: ${ownerLabel(owner)}`);
  });

  await test('CDP new-tab takes the page whose target id createTarget returned, not the first new page', async () => {
    // Another agent's tab lands first; ours arrives 30 ms later.
    const pages: string[] = ['existing'];
    let wake: (() => void) | null = null;
    const add = (id: string) => { pages.push(id); wake?.(); };
    setTimeout(() => add('rival'), 5);
    setTimeout(() => add('mine'), 30);
    const got = await waitForTargetPage({
      pages: () => [...pages],
      targetIdOf: async (p) => p,
      nextPage: (ms) => new Promise<void>((r) => { wake = r; setTimeout(r, ms); }),
    }, 'mine', 2000, 20);
    assert(got === 'mine', `matched ${got}`);
    const t0 = Date.now();
    let err = '';
    try {
      await waitForTargetPage({ pages: () => ['rival'], targetIdOf: async (p) => p, nextPage: (ms) => sleep(ms) }, 'never', 120, 20);
    } catch (e) { err = String((e as Error).message); }
    assert(/did not appear within 120 ms/.test(err) && Date.now() - t0 < 1000, `timeout: ${err}`);
  });

  await test('PeerRegistry.decide refuses two candidates (pure)', async () => {
    const reg = new PeerRegistry(() => {});
    const fakeWs = () => ({ readyState: WebSocket.OPEN, close() {} }) as unknown as WebSocket;
    reg.upsertFromHello({ instanceId: 'aaaaaa-1', browser: 'edge', label: 'Work' }, fakeWs());
    const one = reg.decide(null, 9223);
    assert(one.selection.state === 'bound' && one.winners.length === 1, 'one candidate binds');
    reg.upsertFromHello({ instanceId: 'bbbbbb-2', browser: 'chrome', label: 'Home' }, fakeWs());
    const two = reg.decide(null, 9223);
    assert(two.selection.state === 'ambiguous' && two.selection.code === 'BRIDGE_AMBIGUOUS', two.selection.state);
    assert(two.winners.length === 0, 'two candidates: no winner, never [0]');
    assert(reg.decide('edge', 9223).winners.length === 1, 'filter narrows to one');
    assert(reg.decide('firefox', 9223).selection.code === 'BRIDGE_NO_CANDIDATE', 'no match refuses');
  });

  await test('PeerRegistry.match returns both on an ambiguous label (pure)', async () => {
    const reg = new PeerRegistry(() => {});
    const fakeWs = () => ({ readyState: WebSocket.OPEN, close() {} }) as unknown as WebSocket;
    reg.upsertFromHello({ instanceId: 'aaaaaa-1', browser: 'edge', label: 'Work' }, fakeWs());
    reg.upsertFromHello({ instanceId: 'bbbbbb-2', browser: 'chrome', label: 'Work' }, fakeWs());
    assert(reg.match('work').length === 2, 'ambiguous label matches both');
    assert(reg.match('bbbbbb').length === 1 && reg.match('bbbbbb')[0].instanceId === 'bbbbbb-2', 'id prefix is unique');
    assert(reg.match('nope').length === 0, 'no match is empty');
  });

  // ─── Multi-bind (docs/design/plan/12-multi-bind-plan.md, brief A) ───

  /** Generous liveness: these fakes never ping, and a terminated socket would
   * make a per-session check pass or fail for the wrong reason. */
  const MULTI_LIVENESS_MS = 10_000;

  async function withBindAll(
    fn: (bridge: Bridge, browsers: FakeExtension[], logs: string[]) => Promise<void>,
    opts: { settleMs?: number; browsers?: string[] } = {},
  ): Promise<void> {
    const logs: string[] = [];
    const bridge = await Bridge.create(reserveBase(), (m) => logs.push(m), {
      graceMs: GRACE_MS, livenessMs: MULTI_LIVENESS_MS, settleMs: opts.settleMs ?? SETTLE_MS,
    });
    bridge.setBindFilter('all');
    const browsers = (opts.browsers ?? ['edge', 'chrome']).map((b) => {
      const ext = new FakeExtension();
      ext.browser = b;
      return ext;
    });
    try {
      await fn(bridge, browsers, logs);
    } finally {
      for (const b of browsers) b.closeAll();
      bridge.close();
      await sleep(20);
    }
  }

  await test('all: three browsers bind at settle close, a late one joins, no livelock warning', async () => {
    await withBindAll(async (bridge, [edge, chrome, brave, arc]) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      const b = await chrome.connect(bridge.port, 'inst-b');
      const c = await brave.connect(bridge.port, 'inst-c');
      await until(() => a.role === 'parked' && b.role === 'parked' && c.role === 'parked', 'all three to park while settling');
      await until(() => a.role === 'bound' && b.role === 'bound' && c.role === 'bound', 'all three to bind at settle close');
      assert(bridge.boundIds.length === 3, `bound: ${bridge.boundIds}`);
      assert(bridge.boundInstanceId === bridge.boundIds[0], 'the active peer is listed first');
      assert(!bridge.livelockSuspected, 'settle-close binds must not count as ownership flapping');
      const d = await arc.connect(bridge.port, 'inst-d');
      await until(() => d.role !== null, 'the late browser to get a disposition');
      assert(d.role === 'bound', `a late hello under all binds instead of parking, got ${d.role}`);
      const total: number = bridge.boundIds.length;
      assert(total === 4 && !bridge.livelockSuspected, `bound: ${bridge.boundIds}`);
    }, { settleMs: 120, browsers: ['edge', 'chrome', 'brave', 'arc'] });
  });

  await test('all: an echo to B while A\'s socket is closed resolves within 100 ms', async () => {
    await withBindAll(async (bridge, [edge, chrome]) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await chrome.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'bound', 'B to bind alongside A');
      const dropped: string[] = [];
      bridge.on('disconnect', (id: string) => dropped.push(id));
      a.close();
      await until(() => dropped.includes('inst-a'), 'A to degrade');
      assert(bridge.state === 'DEGRADED', `the active (A) session degrades: ${bridge.state}`);
      const t0 = Date.now();
      const r = await bridge.send('Runtime.evaluate', {}, 2000, { peer: 'inst-b' }) as { echoed: string };
      const ms = Date.now() - t0;
      assert(r.echoed === 'Runtime.evaluate', `B echoed ${JSON.stringify(r)}`);
      assert(ms < 100, `B must not wait on A's grace window: ${ms}ms`);
      assert(dropped.length === 1, `only A dropped: ${dropped}`);
    });
  });

  await test('all: A\'s grace expiry rejects only A\'s queue; B\'s queue flushes on its resume', async () => {
    await withBindAll(async (bridge, [edge, chrome]) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await chrome.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'bound', 'B to bind');
      const expired: string[] = [];
      bridge.on('expired', (id: string) => expired.push(id));
      const dropped: string[] = [];
      bridge.on('disconnect', (id: string) => dropped.push(id));

      a.close();
      await until(() => dropped.includes('inst-a'), 'A to degrade');
      const qa = bridge.send('Page.reload', {}, 5000, { peer: 'inst-a' }).then(
        () => 'resolved', (e: any) => String(e.code ?? e.message));
      b.close();
      await until(() => dropped.includes('inst-b'), 'B to degrade');
      const qb = bridge.send('Page.getNavigationHistory', {}, 5000, { peer: 'inst-b' });
      await b.reopen();
      const rb = await qb as { echoed: string };
      assert(rb.echoed === 'Page.getNavigationHistory', `B's queued command flushes on resume: ${JSON.stringify(rb)}`);

      assert(await qa === 'BRIDGE_DEGRADED_TIMEOUT', `A's queue rejects at expiry, got ${await qa}`);
      assert(expired.length === 1 && expired[0] === 'inst-a', `only A expired: ${expired}`);
      const after = await bridge.send('Runtime.evaluate', {}, 1000, { peer: 'inst-b' }) as { echoed: string };
      assert(after.echoed === 'Runtime.evaluate', 'B still drives after A expired');
    });
  });

  await test('all: use switches the active peer without a parked frame; events carry instanceId + tabId', async () => {
    await withBindAll(async (bridge, [edge, chrome]) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await chrome.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'bound', 'B to bind');
      assert(bridge.boundInstanceId === 'inst-a', `first bound is active: ${bridge.boundInstanceId}`);
      const frames: any[] = [];
      for (const c of [a, b]) c.ws!.on('message', (raw) => frames.push({ to: c.instanceId, ...JSON.parse(String(raw)) }));
      const controlled: Array<[number | null, string]> = [];
      bridge.on('controlled', (tabId: number | null, id: string) => controlled.push([tabId, id]));

      const inst = await bridge.use('inst-b');
      const active: string | null = bridge.boundInstanceId;
      assert(inst.instanceId === 'inst-b' && active === 'inst-b', `active: ${active}`);
      await sleep(30);
      const roleFrames = frames.filter((f) => f.type === 'role');
      assert(roleFrames.length === 0, `use under all sends no role frame: ${JSON.stringify(roleFrames)}`);
      assert(a.role === 'bound' && b.role === 'bound', `nobody demoted: a=${a.role} b=${b.role}`);
      assert(controlled.some(([, id]) => id === 'inst-b'), 'the switch emits controlled for B (ref clear)');

      // The default peer is now B.
      await bridge.send('DOM.getDocument');
      assert(b.received.includes('DOM.getDocument') && !a.received.includes('DOM.getDocument'), 'default send goes to the active peer');

      const ack = await bridge.sendControl({ action: 'control-tab', tabId: 2 }, 1000, { peer: 'inst-a' });
      assert(ack.ok && ack.tabId === 2 && ack.instanceId === 'inst-a', `control A by name: ${JSON.stringify(ack)}`);
      const events: any[] = [];
      const off = bridge.onEvent((ev) => events.push(ev));
      a.send({ type: 'event', method: 'Page.loadEventFired', params: {} });
      await until(() => events.length === 1, 'the event to arrive');
      off();
      assert(events[0].instanceId === 'inst-a' && events[0].tabId === 2, `event tags: ${JSON.stringify(events[0])}`);
    });
  });

  // ─── Round-1 review fixes (plan 12, brief A) ───

  await test('all: a safe verb in flight on A, then use(B), then A drops: no replay on B', async () => {
    await withBindAll(async (bridge, [edge, chrome]) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await chrome.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'bound', 'B to bind');
      a.swallowCdp = true;
      const inflight = bridge.send('Accessibility.getFullAXTree').then(() => null, (e) => e);
      await until(() => a.received.includes('Accessibility.getFullAXTree'), 'the read to reach A');
      await bridge.use('inst-b');
      a.close();
      const err = await inflight;
      assert(err instanceof BridgeInterrupted, `A's drop interrupts the read: ${String(err)}`);
      assert(err.instanceId === 'inst-a', `the interruption names A: ${err.instanceId}`);
      let replayAllowed = false;
      let refusal: any = null;
      try {
        await bridge.waitForResumeOf(err, 'snapshot');
        replayAllowed = true;
      } catch (e) {
        refusal = e;
      }
      assert(!replayAllowed, 'the replay gate opened with B active: the read would re-run on the wrong browser');
      const msg = String(refusal?.message);
      assert(msg.includes('snapshot') && msg.includes('edge'), `the refusal names the verb and A's browser: ${msg}`);
    });
  });

  await test('single: use(B) interrupting A\'s in-flight read does not replay it on B', async () => {
    const bridge = await Bridge.create(reserveBase(), () => undefined, { graceMs: GRACE_MS, livenessMs: MULTI_LIVENESS_MS, settleMs: SETTLE_MS });
    const one = new FakeExtension();
    const two = new FakeExtension();
    two.browser = 'chrome';
    try {
      const a = await one.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await two.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'parked', 'B to park');
      a.swallowCdp = true;
      const inflight = bridge.send('DOM.getDocument').then(() => null, (e) => e);
      await until(() => a.received.includes('DOM.getDocument'), 'the read to reach A');
      await bridge.use('inst-b');
      const err = await inflight;
      assert(err instanceof BridgeInterrupted && err.instanceId === 'inst-a', `interrupted on A: ${String(err)}`);
      const gate = await bridge.waitForResumeOf(err, 'text').then(() => 'replay', (e) => String(e.message));
      assert(gate !== 'replay', 'the replay gate opened on B');
    } finally {
      one.closeAll();
      two.closeAll();
      bridge.close();
      await sleep(20);
    }
  });

  await test('all: an interrupted read on the active A replays once A resumes', async () => {
    await withBindAll(async (bridge, [edge, chrome]) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await chrome.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'bound', 'B to bind');
      a.swallowCdp = true;
      const inflight = bridge.send('DOM.getDocument').then(() => null, (e) => e);
      await until(() => a.received.includes('DOM.getDocument'), 'the read to reach A');
      a.close();
      const err = await inflight;
      assert(err instanceof BridgeInterrupted, `interrupted: ${String(err)}`);
      a.swallowCdp = false;
      const gate = bridge.waitForResumeOf(err, 'text');
      await a.reopen();
      await gate;
    });
  });

  await test('all: a non-active peer\'s event, controlled and hello never reach active-session listeners', async () => {
    await withBindAll(async (bridge, [edge, chrome]) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await chrome.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'bound', 'B to bind');
      assert(bridge.boundInstanceId === 'inst-a', 'A is active');
      const got: Array<[string, string]> = [];
      const offs = [
        bridge.onActive('event', (ev: any) => got.push(['event', ev.instanceId])),
        bridge.onActive('controlled', (_t: number | null, id: string) => got.push(['controlled', id])),
        bridge.onActive('hello', (_i: unknown, id: string) => got.push(['hello', id])),
      ];
      b.send({ type: 'event', method: 'Page.frameNavigated', params: { frame: { id: 'B-main' } } });
      b.send({ type: 'event', method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [] } });
      b.send({ type: 'controlled', tabId: 3 });
      await b.reopen();
      await until(() => b.role === 'bound', 'B to resume');
      a.send({ type: 'event', method: 'Page.loadEventFired', params: {} });
      await until(() => got.some(([k, id]) => k === 'event' && id === 'inst-a'), 'A\'s event (sentinel)');
      const leaked = got.filter(([, id]) => id !== 'inst-a');
      assert(leaked.length === 0, `B's traffic reached the active session: ${JSON.stringify(leaked)}`);
      await bridge.use('inst-b');
      assert(got.some(([k, id]) => k === 'controlled' && id === 'inst-b'), 'use(B) still delivers B\'s controlled (ref clear)');
      for (const off of offs) off();
    });
  });

  await test('all: waitForHello (bridge reload) ignores another peer\'s hello', async () => {
    await withBindAll(async (bridge, [edge, chrome]) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await chrome.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'bound', 'B to bind');
      let settled: string | null = null;
      const w = bridge.waitForHello('inst-a', 2000).then(() => { settled = 'a-hello'; }, () => { settled = 'timeout'; });
      await b.reopen();
      await until(() => b.role === 'bound', 'B to resume');
      await sleep(50);
      assert(settled === null, `B's hello resolved A's reload wait: ${settled}`);
      await a.reopen();
      await w;
      assert(settled === 'a-hello', `A's hello resolves it: ${settled}`);
    });
  });

  await test('a named peer that is not bound: setDesiredControl and sendControl refuse', async () => {
    const bridge = await Bridge.create(reserveBase(), () => undefined, { graceMs: GRACE_MS, livenessMs: MULTI_LIVENESS_MS, settleMs: SETTLE_MS });
    const one = new FakeExtension();
    const two = new FakeExtension();
    two.browser = 'chrome';
    try {
      const a = await one.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await two.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'parked', 'B to park');
      let thrown: any = null;
      try {
        bridge.setDesiredControl({ action: 'control-active' }, { peer: 'inst-b' });
      } catch (e) {
        thrown = e;
      }
      assert(thrown && /is not bound/.test(String(thrown.message)), `setDesiredControl on a parked peer: ${String(thrown?.message)}`);
      const sent = await bridge.sendControl({ action: 'control-tab', tabId: 2 }, 500, { peer: 'inst-b' })
        .then(() => 'ok', (e) => String(e.message));
      assert(/is not bound/.test(sent), `sendControl on a parked peer: ${sent}`);
      assert(b.lastControlId === null, 'nothing reached the parked browser');
    } finally {
      one.closeAll();
      two.closeAll();
      bridge.close();
      await sleep(20);
    }
  });

  await test('all: an EXPIRED peer leaves the bound set', async () => {
    await withBindAll(async (bridge, [edge, chrome]) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await chrome.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'bound', 'B to bind');
      const expired: string[] = [];
      bridge.on('expired', (id: string) => expired.push(id));
      b.close();
      await until(() => expired.includes('inst-b'), 'B to expire', GRACE_MS * 4);
      assert(!bridge.boundIds.includes('inst-b'), `B still bound after expiry: ${bridge.boundIds}`);
      assert(bridge.boundIds.length === 1 && bridge.boundInstanceId === 'inst-a', `A unaffected: ${bridge.boundIds}`);
      await b.reopen();
      await until(() => b.role === 'bound', 'B rejoins');
      const r = await bridge.send('DOM.getDocument', {}, 1000, { peer: 'inst-b' }) as { echoed: string };
      assert(r.echoed === 'DOM.getDocument', 'the rejoined B drives');
    });
  });

  await test('all: a legacy (no instanceId) hello is refused, not bound', async () => {
    await withBindAll(async (bridge, [edge, chrome], logs) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const legacy = await chrome.connect(bridge.port, '');
      await until(() => legacy.role !== null, 'the legacy hello to get a disposition');
      assert(legacy.role === 'parked', `a legacy hello under all must park, got ${legacy.role}`);
      assert(bridge.boundIds.length === 1, `bound: ${bridge.boundIds}`);
      assert(logs.some((l) => /legacy|no instanceId/i.test(l) && /reload/i.test(l) && /all/.test(l)), `a reload hint is logged: ${logs.join(' | ')}`);
    });
  });

  await test('all: a legacy hello as the first peer is refused too', async () => {
    await withBindAll(async (bridge, [edge]) => {
      const legacy = await edge.connect(bridge.port, '');
      await until(() => legacy.role !== null, 'a disposition');
      assert(legacy.role === 'parked' && bridge.boundIds.length === 0, `legacy first-bind: ${legacy.role} ${bridge.boundIds}`);
    });
  });

  await test('sendControlToInstance refuses an ambiguous selector instead of taking the first match', async () => {
    const bridge = await Bridge.create(reserveBase(), () => undefined, { graceMs: GRACE_MS, livenessMs: MULTI_LIVENESS_MS, settleMs: SETTLE_MS });
    const one = new FakeExtension();
    const two = new FakeExtension();
    one.browser = 'edge';
    two.browser = 'edge';
    try {
      const a = await one.connect(bridge.port, 'aaaaaa-edge-1');
      await until(() => a.role === 'bound', 'the first edge to bind');
      const b = await two.connect(bridge.port, 'bbbbbb-edge-2');
      await until(() => b.role === 'parked', 'the second edge to park');
      let caught: any;
      try {
        await bridge.sendControlToInstance('edge', { action: 'list-tabs' });
      } catch (err) {
        caught = err;
      }
      assert(caught, 'two edges must refuse, never route to [0]');
      const msg = String(caught.message);
      assert(msg.includes('matches 2 instances') && msg.includes('aaaaaa-edge-1') && msg.includes('bbbbbb-edge-2'), msg);
      assert(a.lastControlId === null && b.lastControlId === null, 'nothing was sent to either browser');
      const ack = await bridge.sendControlToInstance('bbbbbb', { action: 'list-tabs' });
      assert(ack.instanceId === 'bbbbbb-edge-2', `a unique prefix still routes: ${ack.instanceId}`);
    } finally {
      one.closeAll();
      two.closeAll();
      bridge.close();
      await sleep(20);
    }
  });

  // ─── Per-peer page state (plan 12, brief B) ───

  /** Two bound peers (A active on tab 1, B on tab 2) wired the way the daemon wires them. */
  async function withPageState(
    fn: (h: {
      bridge: Bridge; a: FakeConnection; b: FakeConnection; sink: BridgePageSink; refClears: () => number;
    }) => Promise<void>,
  ): Promise<void> {
    await withBindAll(async (bridge, [edge, chrome]) => {
      let clears = 0;
      const sink: BridgePageSink = {
        bridgePeers: new Map(),
        consoleBuf: new CircularBuffer<ConsoleEntry>(100),
        networkBuf: new CircularBuffer<NetworkEntry>(100),
        consoleListeners: new Set(),
        networkListeners: new Set(),
        captureBodiesRe: null,
      };
      wireBridgePageEvents(bridge, sink, {
        tabIdOf: (id, tab) => `${id}:${tab}`,
        onActiveMainFrameNavigated: () => { clears++; },
      });
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await chrome.connect(bridge.port, 'inst-b');
      await until(() => b.role === 'bound', 'B to bind');
      a.send({ type: 'controlled', tabId: 1 });
      b.send({ type: 'controlled', tabId: 2 });
      // A sentinel per peer, so the controlled frames above have landed.
      a.send({ type: 'event', method: 'Page.loadEventFired', params: {} });
      b.send({ type: 'event', method: 'Page.loadEventFired', params: {} });
      await until(() => sink.bridgePeers.size === 2, 'both peers to have state');
      assert(bridge.boundInstanceId === 'inst-a', 'A is active');
      await fn({ bridge, a, b, sink, refClears: () => clears });
    });
  }

  const ctxCreated = (frameId: string, uniqueId: string, id: number) => ({
    type: 'event', method: 'Runtime.executionContextCreated',
    params: { context: { id, uniqueId, auxData: { isDefault: true, frameId } } },
  });

  await test('all: both peers\' console events land in the buffer, each tagged with its tab id', async () => {
    await withPageState(async ({ a, b, sink }) => {
      a.send({ type: 'event', method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: 'from-a' }] } });
      b.send({ type: 'event', method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ value: 'from-b' }] } });
      b.send({ type: 'event', method: 'Network.requestWillBeSent', params: { requestId: 'r1', request: { url: 'https://b.test/' } } });
      await until(() => sink.consoleBuf.toArray().length === 2 && sink.networkBuf.toArray().length === 1, 'entries to arrive');
      const byText = Object.fromEntries(sink.consoleBuf.toArray().map((e) => [e.text, e.tabId]));
      assert(byText['from-a'] === 'inst-a:1' && byText['from-b'] === 'inst-b:2', `console tags: ${JSON.stringify(byText)}`);
      assert(sink.networkBuf.toArray()[0].tabId === 'inst-b:2', `network tag: ${sink.networkBuf.toArray()[0].tabId}`);
    });
  });

  await test('all: a non-active peer\'s frameNavigated leaves refs and A\'s state alone; A\'s clears refs', async () => {
    await withPageState(async ({ bridge, a, b, sink, refClears }) => {
      a.send({ type: 'event', method: 'Page.frameNavigated', params: { frame: { id: 'A-main' } } });
      a.send(ctxCreated('A-main', 'ctx-a', 1));
      b.send({ type: 'event', method: 'Network.requestWillBeSent', params: { requestId: 'rb', request: { url: 'https://b.test/' } } });
      await until(() => pickMainFrameContext(activePeerState(sink, bridge)) === 'ctx-a', 'A\'s context');
      assert(refClears() === 1, `A's navigation clears refs once: ${refClears()}`);
      assert(activePeerState(sink, bridge).networkRequests.size === 0, 'B\'s in-flight request is not A\'s');

      b.send({ type: 'event', method: 'Page.frameNavigated', params: { frame: { id: 'B-main' } } });
      b.send(ctxCreated('B-main', 'ctx-b', 1));
      await until(() => sink.bridgePeers.get('inst-b')?.mainFrameId === 'B-main' && sink.bridgePeers.get('inst-b')!.contexts.size === 1, 'B\'s nav');
      assert(refClears() === 1, `B's navigation must not clear refs: ${refClears()}`);
      const stA = activePeerState(sink, bridge);
      assert(stA.mainFrameId === 'A-main', `A's main frame intact: ${stA.mainFrameId}`);
      // Same numeric context id on both peers: per-peer maps keep them apart.
      assert(pickMainFrameContext(stA) === 'ctx-a', `A's context after B navigated: ${pickMainFrameContext(stA)}`);
      b.send({ type: 'event', method: 'Runtime.executionContextsCleared', params: {} });
      await until(() => sink.bridgePeers.get('inst-b')!.contexts.size === 0, 'B\'s contexts cleared');
      assert(pickMainFrameContext(activePeerState(sink, bridge)) === 'ctx-a', 'B\'s clear does not reach A');

      a.send({ type: 'event', method: 'Page.frameNavigated', params: { frame: { id: 'A-main' } } });
      await until(() => refClears() === 2, 'A\'s second navigation to clear refs');
    });
  });

  await test('all: a peer\'s disconnect drops only its state; boundInstanceId is null once the active peer expires', async () => {
    await withPageState(async ({ bridge, a, b, sink }) => {
      a.send(ctxCreated('A-main', 'ctx-a', 1));
      await until(() => sink.bridgePeers.get('inst-a')!.contexts.size === 1, 'A\'s context');
      b.close();
      await until(() => !sink.bridgePeers.has('inst-b'), 'B\'s state to drop');
      assert(sink.bridgePeers.get('inst-a')?.contexts.size === 1, 'A\'s state survives B\'s disconnect');

      const expired: string[] = [];
      bridge.on('expired', (id: string) => expired.push(id));
      a.close();
      await until(() => expired.includes('inst-a'), 'A to expire', GRACE_MS * 4);
      assert(!sink.bridgePeers.has('inst-a'), 'A\'s state drops at expiry');
      assert(bridge.boundInstanceId === null, `an expired active peer is not bound: ${bridge.boundInstanceId}`);
    });
  });

  await test('all: joins and expiry-returns never count as ownership flapping', async () => {
    await withBindAll(async (bridge, [edge, chrome], logs) => {
      const a = await edge.connect(bridge.port, 'inst-a');
      await until(() => a.role === 'bound', 'A to bind');
      const b = await chrome.connect(bridge.port, 'inst-b');
      const expired: string[] = [];
      bridge.on('expired', (id: string) => expired.push(id));
      for (let i = 0; i < 3; i++) {
        await until(() => b.role === 'bound', 'B to bind');
        b.close();
        await until(() => expired.length === i + 1, 'B to expire', GRACE_MS * 4);
        await b.reopen();
      }
      await until(() => b.role === 'bound', 'B to rejoin');
      assert(!bridge.livelockSuspected, 'three expiry-returns under all tripped the livelock warning');
      assert(!logs.some((l) => /flapping/.test(l)), `flapping logged: ${logs.filter((l) => /flapping/.test(l))}`);
    });
  });

  // ─── Multi-bind surface (plan 12, brief C): a REAL daemon, two fake browsers ───

  interface DaemonHarness {
    rpc: (cmd: string, args?: unknown[], opts?: Record<string, unknown>) => Promise<{ ok: boolean; data?: any; error?: string }>;
    bridgePort: number;
    edge: FakeConnection;
    chrome: FakeConnection;
    edgeExt: FakeExtension;
    chromeExt: FakeExtension;
    alias: (instanceId: string) => Promise<string>;
  }

  /** `bind: false` starts the daemon with no browser connected; the test connects them via edgeExt/chromeExt. */
  async function withDaemon(fn: (h: DaemonHarness) => Promise<void>, { bind = true } = {}): Promise<void> {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ghax-multi-'));
    const bridgePort = reserveBase();
    const child: ChildProcess = spawn(process.execPath, [path.join(root, 'dist/ghax-daemon.mjs')], {
      env: {
        ...process.env,
        HOME: dir,
        GHAX_STATE_FILE: path.join(dir, 'ghax.json'),
        GHAX_BRIDGE: '1',
        GHAX_BRIDGE_PORT: String(bridgePort),
        GHAX_BRIDGE_PORT_EXPLICIT: '1',
        GHAX_BRIDGE_BROWSER: 'all',
        GHAX_BRIDGE_SETTLE_MS: '50',
        GHAX_BROWSER_KIND: 'chrome',
      },
      stdio: 'ignore',
    });
    const edgeExt = new FakeExtension();
    const chromeExt = new FakeExtension();
    chromeExt.browser = 'chrome';
    edgeExt.profile = 'Work';
    chromeExt.profile = 'Home';
    try {
      let httpPort = 0;
      await until(() => {
        try { httpPort = JSON.parse(readFileSync(path.join(dir, 'ghax.json'), 'utf8')).port; } catch { /* not yet */ }
        return httpPort > 0;
      }, 'daemon state file', 15000);
      const rpc: DaemonHarness['rpc'] = async (cmd, args = [], opts = {}) => {
        const res = await fetch(`http://127.0.0.1:${httpPort}/rpc`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, args, opts }),
        });
        return (await res.json()) as any;
      };
      const edge = bind ? await edgeExt.connect(bridgePort, 'inst-edge') : (null as unknown as FakeConnection);
      const chrome = bind ? await chromeExt.connect(bridgePort, 'inst-chrome') : (null as unknown as FakeConnection);
      if (bind) await until(() => edge.role === 'bound' && chrome.role === 'bound', 'both browsers bound', 15000);
      const alias = async (id: string) => (await rpc('bridge.instances')).data.instances.find((i: any) => i.instanceId === id).alias;
      await fn({ rpc, bridgePort, edge, chrome, edgeExt, chromeExt, alias });
    } finally {
      edgeExt.closeAll();
      chromeExt.closeAll();
      child.kill('SIGTERM');
      await sleep(100);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  await test('daemon, all: tabs numbers 1..N across both browsers; tab on the other browser switches active; instances marks one', async () => {
    await withDaemon(async ({ rpc, alias }) => {
      const ea = await alias('inst-edge');
      const ca = await alias('inst-chrome');
      const tabs = await rpc('tabs');
      assert(tabs.ok && tabs.data.length === 6, `tabs: ${JSON.stringify(tabs)}`);
      assert(tabs.data.map((t: any) => t.index).join() === '1,2,3,4,5,6', `indexes: ${tabs.data.map((t: any) => t.index)}`);
      assert(tabs.data.filter((t: any) => t.id.startsWith(`${ea}:`)).length === 3 && tabs.data.filter((t: any) => t.id.startsWith(`${ca}:`)).length === 3, 'three tabs from each browser');
      const before = (await rpc('bridge.instances')).data.instances;
      assert(before.filter((i: any) => i.active).length === 1, `one active before: ${JSON.stringify(before.map((i: any) => i.active))}`);
      const activeBefore = before.find((i: any) => i.active).instanceId;
      const other = tabs.data.find((t: any) => !before.find((i: any) => i.active && i.alias === t.id.split(':')[0]));
      const sw = await rpc('tab', [`#${other.index}`]);
      assert(sw.ok && sw.data.id === other.id, `tab: ${JSON.stringify(sw)}`);
      const after = (await rpc('bridge.instances')).data.instances;
      const act = after.filter((i: any) => i.active);
      assert(act.length === 1 && act[0].instanceId !== activeBefore && act[0].alias === other.id.split(':')[0], `active after: ${JSON.stringify(act)}`);
      // A full id in a browser that is not bound is refused with the hint.
      const bad = await rpc('tab', ['ghost-browser:7']);
      assert(!bad.ok, 'unbound browser refused');
    });
  });

  await test('daemon, all: a hung browser shows a note within the timeout, the other browser\'s tabs still list', async () => {
    await withDaemon(async ({ rpc, chrome, alias }) => {
      const ca = await alias('inst-chrome');
      chrome.swallowControl = true;
      const t0 = Date.now();
      const tabs = await rpc('tabs');
      const took = Date.now() - t0;
      assert(tabs.ok, JSON.stringify(tabs));
      const rows = tabs.data.filter((t: any) => t.id);
      const notes = tabs.data.filter((t: any) => t.note);
      assert(rows.length === 3 && rows.map((t: any) => t.index).join() === '1,2,3', `rows: ${JSON.stringify(rows)}`);
      assert(notes.length === 1 && notes[0].note.includes(ca), `notes: ${JSON.stringify(notes)}`);
      assert(took < 14000, `listing took ${took}ms`);
    });
  });

  await test('daemon, all: console defaults to the active tab, --tab picks one, --all lifts the filter', async () => {
    await withDaemon(async ({ rpc, edge, chrome }) => {
      const tabs = (await rpc('tabs')).data;
      const first = tabs[0];
      const chromeTab = tabs.find((t: any) => t.index === 4);
      assert((await rpc('tab', [`#${first.index}`])).ok, 'control first');
      assert((await rpc('tab', [`#${chromeTab.index}`])).ok, 'control chrome tab');
      assert((await rpc('tab', [`#${first.index}`])).ok, 'back to first');
      edge.send({ type: 'event', method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: 'from-edge' }] } });
      chrome.send({ type: 'event', method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: 'from-chrome' }] } });
      await sleep(200);
      const text = (r: any) => r.data.map((e: any) => e.text).sort().join();
      const def = await rpc('console');
      assert(def.ok && text(def) === 'from-edge', `default: ${JSON.stringify(def)}`);
      const one = await rpc('console', [], { tab: chromeTab.id });
      assert(one.ok && text(one) === 'from-chrome', `--tab id: ${JSON.stringify(one)}`);
      const byIndex = await rpc('console', [], { tab: `#${chromeTab.index}` });
      assert(byIndex.ok && text(byIndex) === 'from-chrome', `--tab #n: ${JSON.stringify(byIndex)}`);
      const all = await rpc('console', [], { all: true });
      assert(all.ok && text(all) === 'from-chrome,from-edge', `--all: ${JSON.stringify(all)}`);
      const net = await rpc('network');
      assert(net.ok && Array.isArray(net.data), `network: ${JSON.stringify(net)}`);
    });
  });

  /** The daemon's active and other bound connection, by instances(). */
  async function activeAndOther(h: DaemonHarness): Promise<{ active: FakeConnection; other: FakeConnection }> {
    const insts = (await h.rpc('bridge.instances')).data.instances;
    const activeId = insts.find((i: any) => i.active)?.instanceId;
    assert(activeId === 'inst-edge' || activeId === 'inst-chrome', `active: ${activeId}`);
    return activeId === 'inst-edge' ? { active: h.edge, other: h.chrome } : { active: h.chrome, other: h.edge };
  }

  /** List tabs, then drive edge's tab 1; returns chrome's tab 2 row too. */
  async function driveEdgeTab1(h: DaemonHarness): Promise<{ chromeTab: any }> {
    const ea = await h.alias('inst-edge');
    const ca = await h.alias('inst-chrome');
    const tabs = (await h.rpc('tabs')).data;
    const r = await h.rpc('tab', [`${ea}:1`]);
    assert(r.ok, `drive edge tab 1: ${JSON.stringify(r)}`);
    return { chromeTab: tabs.find((t: any) => t.id === `${ca}:2`) };
  }

  const activeInstance = async (h: DaemonHarness) => (await h.rpc('bridge.instances')).data.instances.find((i: any) => i.active)?.instanceId;

  await test('daemon, all: a verb in flight on one browser never sends to the other after a concurrent tab switch', async () => {
    await withDaemon(async (h) => {
      const { rpc, edge, chrome } = h;
      const { chromeTab } = await driveEdgeTab1(h);
      const held: { release: (() => void) | null } = { release: null };
      edge.onCdp = (method, _p, reply) => {
        if (method === 'Page.getFrameTree') { reply({ frameTree: { frame: { id: 'F' } } }); return true; }
        if (method === 'Page.createIsolatedWorld') { held.release = () => reply({ executionContextId: 77 }); return true; }
        return false;
      };
      const pending = rpc('box', ['#target']);
      await until(() => held.release !== null, 'isolated-world creation in flight on edge');
      assert((await rpc('tab', [chromeTab.id])).ok, 'switch to the chrome tab');
      assert(await activeInstance(h) === 'inst-chrome', 'chrome is active');
      chrome.received.length = 0;
      const edgeFrom = edge.received.length;
      held.release!();
      await pending;
      assert(!chrome.received.includes('Runtime.evaluate'), `edge's world context id reached chrome: ${chrome.received}`);
      assert(edge.received.slice(edgeFrom).includes('Runtime.evaluate'), `the verb's evaluate stays on edge: ${edge.received.slice(edgeFrom)}`);
    });
  });

  await test('daemon, all: a refused tab/control on the other browser leaves the active browser unchanged', async () => {
    await withDaemon(async (h) => {
      const { rpc, chrome } = h;
      const { chromeTab } = await driveEdgeTab1(h);
      assert(await activeInstance(h) === 'inst-edge', 'edge active');
      chrome.attachFailure = new Error('cannot attach to this tab');
      const r = await rpc('tab', [chromeTab.id]);
      assert(!r.ok, `refused: ${JSON.stringify(r)}`);
      assert(await activeInstance(h) === 'inst-edge', `a refused tab moved the daemon to ${await activeInstance(h)}`);
      const c = await rpc('bridge.control', [], { mode: 'tab', tabId: chromeTab.id });
      assert(!c.ok, `control refused: ${JSON.stringify(c)}`);
      assert(await activeInstance(h) === 'inst-edge', `a refused bridge control moved the daemon to ${await activeInstance(h)}`);
      const st = await rpc('console');
      assert(st.ok, `edge tab is still the active tab: ${JSON.stringify(st)}`);
    });
  });

  await test('daemon, all: console/network --last N counts only the selected tab\'s entries', async () => {
    await withDaemon(async (h) => {
      const { rpc, edge, chrome } = h;
      await driveEdgeTab1(h);
      for (let i = 0; i < 3; i++) edge.send({ type: 'event', method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: `edge-${i}` }] } });
      for (let i = 0; i < 2; i++) edge.send({ type: 'event', method: 'Network.requestWillBeSent', params: { requestId: `e${i}`, request: { url: `https://edge.test/${i}` } } });
      await sleep(100);
      for (let i = 0; i < 5; i++) chrome.send({ type: 'event', method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: `chrome-${i}` }] } });
      for (let i = 0; i < 5; i++) chrome.send({ type: 'event', method: 'Network.requestWillBeSent', params: { requestId: `c${i}`, request: { url: `https://chrome.test/${i}` } } });
      await sleep(200);
      const con = await rpc('console', [], { last: 3 });
      assert(con.ok && con.data.map((e: any) => e.text).join() === 'edge-0,edge-1,edge-2', `console --last 3: ${JSON.stringify(con)}`);
      const net = await rpc('network', [], { last: 2 });
      assert(net.ok && net.data.length === 2 && net.data.every((e: any) => e.url.startsWith('https://edge.test/')), `network --last 2: ${JSON.stringify(net)}`);
    });
  });

  await test('daemon, all: a never-active browser gets Runtime/Network/Log enabled once it controls a tab', async () => {
    await withDaemon(async (h) => {
      const { other } = await activeAndOther(h);
      other.received.length = 0;
      other.controlledTabId = 2;
      other.send({ type: 'controlled', tabId: 2 });
      await until(
        () => ['Runtime.enable', 'Network.enable', 'Log.enable'].every((m) => other.received.includes(m)),
        `domains enabled on the non-active browser (got ${other.received})`,
      );
    });
  });

  await test('daemon, all: switching browsers keeps the destination\'s in-flight requests', async () => {
    await withDaemon(async (h) => {
      const { rpc } = h;
      const { other } = await activeAndOther(h);
      other.controlledTabId = 2;
      other.send({ type: 'controlled', tabId: 2 });
      await sleep(50);
      other.send({ type: 'event', method: 'Network.requestWillBeSent', params: { requestId: 'r1', request: { url: 'https://inflight.test/' } } });
      await sleep(100);
      assert((await rpc('bridge.use', [other.instanceId])).ok, 'switch to the other browser');
      other.send({ type: 'event', method: 'Network.responseReceived', params: { requestId: 'r1', response: { status: 201, statusText: 'Created' } } });
      await sleep(150);
      const net = await rpc('network', [], { all: true });
      const row = net.data?.find((e: any) => e.url === 'https://inflight.test/');
      assert(row && row.status === 201, `the switch dropped the request's response: ${JSON.stringify(row)}`);
    });
  });

  await test('daemon, all: tabs `active` is each browser\'s foreground tab, not the daemon-active one', async () => {
    await withDaemon(async (h) => {
      const { rpc, chrome, edgeExt, alias } = h;
      await driveEdgeTab1(h);
      chrome.controlledTabId = 2; // the other browser drives a background tab of its own
      edgeExt.foregroundTabId = 3;
      const tabs = await rpc('tabs');
      const ea = await alias('inst-edge');
      const ca = await alias('inst-chrome');
      const act = tabs.data.filter((t: any) => t.active).map((t: any) => t.id).sort();
      const want = [`${ea}:3`, `${ca}:1`].sort();
      assert(JSON.stringify(act) === JSON.stringify(want), `foreground rows ${JSON.stringify(want)}, got ${JSON.stringify(act)}`);
      const driven = tabs.data.find((t: any) => t.id === `${ea}:1`);
      assert(driven && !driven.active, 'the tab the daemon drives is not active when it is in the background');
    });
  });

  await test('daemon, all: a verb started with nothing bound pins to the first browser it sends to', async () => {
    await withDaemon(async (h) => {
      const { rpc, edgeExt, chromeExt, bridgePort } = h;
      // eval waits briefly for a page context before its first send: that is
      // when both browsers bind, with nothing bound at verb start.
      const pending = rpc('eval', ['1']);
      const edge = await edgeExt.connect(bridgePort, 'inst-edge');
      const chrome = await chromeExt.connect(bridgePort, 'inst-chrome');
      const held: { conn: FakeConnection | null; release: (() => void) | null } = { conn: null, release: null };
      for (const c of [edge, chrome]) {
        c.onCdp = (method, _p, reply) => {
          if (method === 'Runtime.evaluate' && held.release === null) {
            held.conn = c;
            held.release = () => reply({ exceptionDetails: { text: 'Cannot find context with specified id' } });
            return true;
          }
          return false;
        };
      }
      await until(() => held.release !== null, 'the first send to be held');
      const first = held.conn!;
      const second = first === edge ? chrome : edge;
      assert((await rpc('bridge.use', [second.instanceId])).ok, 'switch active mid-verb');
      assert(await activeInstance({ ...h, edge, chrome }) === second.instanceId, 'the other browser is now active');
      held.release!();
      const r = await pending;
      assert(r.ok, `eval: ${JSON.stringify(r)}`);
      assert(first.received.includes('Runtime.disable'), `the retry stays on the first browser: ${first.received}`);
      assert(!second.received.includes('Runtime.disable') && !second.received.includes('Runtime.evaluate'),
        `a later send of the verb reached the second browser: ${second.received}`);
    }, { bind: false });
  });

  await test('daemon, all: batch freshness check and auto-snapshot go to the browser the step runs on', async () => {
    await withDaemon(async (h) => {
      const { rpc, edge, chrome } = h;
      const { chromeTab } = await driveEdgeTab1(h);
      assert(await activeInstance(h) === 'inst-edge', 'edge active at batch start');
      const edgeFrom = edge.received.length;
      chrome.received.length = 0;
      await rpc('batch', [[
        { cmd: 'tab', args: [chromeTab.id] },
        { cmd: 'click', args: ['@e1'] },
      ]], { stopOnError: false });
      assert(await activeInstance(h) === 'inst-chrome', 'the batch moved the active browser');
      const edgeGot = edge.received.slice(edgeFrom);
      assert(!edgeGot.includes('Runtime.evaluate'), `the step's freshness check hit the batch-start browser: ${edgeGot}`);
      assert(chrome.received.includes('Runtime.evaluate'), `the freshness check went to the step's browser: ${chrome.received}`);
    });
  });

  await test('daemon, all: tabs --browser on a non-active browser still marks its foreground tab active', async () => {
    await withDaemon(async (h) => {
      const { rpc, chrome, alias } = h;
      await driveEdgeTab1(h);
      chrome.controlledTabId = 2;
      const r = await rpc('tabs', [], { browser: 'inst-chrome' });
      assert(r.ok && r.data.length > 0, `tabs --browser: ${JSON.stringify(r)}`);
      const act = r.data.filter((t: any) => t.active).map((t: any) => t.id);
      assert(act.length === 1 && act[0] === `${await alias('inst-chrome')}:1`, `chrome's foreground tab, not the one it drives: ${JSON.stringify(act)}`);
      const own = await rpc('tabs', [], { browser: 'inst-edge' });
      assert(own.ok && own.data.filter((t: any) => t.active).length === 1, `one foreground tab per window: ${JSON.stringify(own)}`);
    });
  });

  await test('daemon, all: console/network with no active tab refuse instead of returning []', async () => {
    await withDaemon(async ({ rpc }) => {
      for (const verb of ['console', 'network']) {
        const r = await rpc(verb);
        assert(!r.ok && /no active tab/.test(String(r.error)) && /--all/.test(String(r.error)), `${verb}: ${JSON.stringify(r)}`);
      }
      assert((await rpc('console', [], { all: true })).ok, '--all still works');
    });
  });

  await test('daemon, borrowed: tabs leaves the owner\'s #n listing alone; writes and non-read verbs are refused', async () => {
    await withDaemon(async ({ rpc, alias }) => {
      const ca = await alias('inst-chrome');
      const own = await rpc('tabs');
      assert(own.ok && own.data.length === 6, `owner listing: ${JSON.stringify(own)}`);
      const row5 = own.data.find((t: any) => t.index === 5);
      // A borrowed listing of one browser only: 3 rows. Were it stored, the
      // owner's `#5` would resolve against it and fail.
      const peek = await rpc('tabs', [], { borrowed: true, browser: 'inst-chrome' });
      assert(peek.ok && peek.data.length === 3, `borrowed tabs: ${JSON.stringify(peek)}`);
      const sw = await rpc('tab', ['#5']);
      assert(sw.ok && sw.data.id === row5.id && row5.id.startsWith(`${ca}:`), `owner's #5 after a borrowed listing: ${JSON.stringify(sw)}`);
      for (const [cmd, opts] of [
        ['goto', {}], ['tab', {}], ['eval', {}], ['batch', {}],
        ['network', { har: '/tmp/ghax-borrowed.har' }], ['console', { 'source-maps': true }],
      ] as const) {
        const r = await rpc(cmd, cmd === 'goto' ? ['https://example.com'] : [], { ...opts, borrowed: true });
        assert(!r.ok && /borrowed daemon \(read-only\)/.test(String(r.error)), `${cmd} ${JSON.stringify(opts)}: ${JSON.stringify(r)}`);
      }
      assert((await rpc('network', [], { borrowed: true, all: true })).ok, 'plain network still reads');
      assert((await rpc('bridge.instances', [], { borrowed: true })).ok, 'bridge instances still reads');
    });
  });

  await test('daemon: bridge control --tab-id drives the tab in the background (focus:false, quiet:true)', async () => {
    await withDaemon(async ({ rpc, edge, alias }) => {
      const ea = await alias('inst-edge');
      const r = await rpc('bridge.control', [], { mode: 'tab', tabId: `${ea}:2` });
      assert(r.ok, JSON.stringify(r));
      assert(edge.lastControl?.action === 'control-tab' && edge.lastControl.focus === false && edge.lastControl.quiet === true,
        `control message: ${JSON.stringify(edge.lastControl)}`);
    });
  });

  await test('daemon: new-tab --window with no value or a boolean is a usage error', async () => {
    await withDaemon(async ({ rpc }) => {
      for (const w of [true, false, '', ' ']) {
        const r: any = await rpc('newTab', ['https://example.com'], { window: w });
        assert(!r.ok && r.exitCode === 1 && /requires a window id/.test(String(r.error)), `--window ${JSON.stringify(w)}: ${JSON.stringify(r)}`);
      }
      const bad: any = await rpc('newTab', [], { window: 'abc' });
      assert(!bad.ok && bad.exitCode === 1 && /not a window id/.test(String(bad.error)), JSON.stringify(bad));
    });
  });

  await test('daemon: close-tab closes its own tab, refuses the user\'s without --force and another agent\'s always', async () => {
    await withDaemon(async ({ rpc, edge, edgeExt, alias }) => {
      const ea = await alias('inst-edge');
      assert((await rpc('bridge.use', ['inst-edge'])).ok !== false, 'use edge');
      const opened = await rpc('newWindow', ['https://own.example']);
      assert(opened.ok, `newWindow: ${JSON.stringify(opened)}`);
      const ownId = opened.data.id as string;
      const closed = await rpc('closeTab');
      assert(closed.ok && closed.data.closed === ownId && closed.data.active === null, `closeTab: ${JSON.stringify(closed)}`);
      assert(edge.lastControl?.action === 'close-tab', `control message: ${JSON.stringify(edge.lastControl)}`);
      assert(!edgeExt.tabs.some((t) => `${ea}:${t.id}` === ownId), 'tab removed');
      const again = await rpc('closeTab');
      assert(!again.ok && /no active tab/.test(String(again.error)), `second closeTab: ${JSON.stringify(again)}`);
      const user = await rpc('closeTab', [`${ea}:2`]);
      assert(!user.ok && (user as any).exitCode === 1 && /--force/.test(String(user.error)), `user tab: ${JSON.stringify(user)}`);
      assert(edgeExt.tabs.some((t) => t.id === 2), 'user tab survives the refusal');
      // Another agent (bridge port 1) holds tab 3: refused even with --force.
      edgeExt.tabOwners.set(3, { controlledTabId: 3, port: 1 } as unknown as FakeConnection);
      const other = await rpc('closeTab', [`${ea}:3`], { force: true });
      assert(!other.ok && /another ghax agent \(bridge port 1\)/.test(String(other.error)), `other agent: ${JSON.stringify(other)}`);
      edgeExt.tabOwners.delete(3);
      const forced = await rpc('closeTab', [`${ea}:2`], { force: true });
      assert(forced.ok && forced.data.closed === `${ea}:2`, `--force: ${JSON.stringify(forced)}`);
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
