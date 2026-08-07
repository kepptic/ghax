/**
 * Extension bridge — the "chrome.debugger relay" transport.
 *
 * WHY THIS EXISTS: since Edge 150 / Chrome 136, the CDP
 * `--remote-debugging-port` flag is silently ignored on the browser's
 * default profile. Playwright's `chromium.connectOverCDP` (the daemon's
 * normal transport, see daemon.ts) can no longer reach the user's real,
 * already-logged-in browser session — only a scratch profile launched
 * fresh by ghax itself. The `chrome.debugger` API is NOT subject to that
 * socket restriction, so an MV3 extension using it can drive the user's
 * real tab. This module is the daemon-side half of that path: a tiny
 * WebSocket server the extension's background service worker connects to.
 *
 * Wire format (daemon <-> extension), one JSON object per WS message:
 *   extension -> daemon, on connect:
 *     {"type":"hello","agent":"ghax-ext","version":"0.1.0"}
 *   daemon -> extension, a CDP command to relay via chrome.debugger.sendCommand:
 *     {"id":<n>,"method":"Page.navigate","params":{...}}
 *   extension -> daemon, the command's reply:
 *     {"id":<n>,"result":{...}}
 *     {"id":<n>,"error":{"message":"...","phase":"attach"|"dispatch"|"dispatch-detached"}}
 *       `phase` says which half of the relay failed, which is what decides
 *       whether a retry is safe. "attach" = the command provably never ran;
 *       "dispatch-detached" = it was already on the wire and MAY have landed
 *       (mapped to BridgeInterrupted below). Older extensions omit it.
 *   extension -> daemon, a relayed chrome.debugger.onEvent:
 *     {"type":"event","method":"Page.loadEventFired","params":{...}}
 *
 * This is deliberately the same request/response/event shape as the raw
 * CDP client in cdp-client.ts (CdpTarget) — chrome.debugger.sendCommand
 * IS a CDP command dispatcher, so reusing that mental model means the
 * bridge "looks like" talking to a CdpTarget from the daemon's side.
 *
 * The bridge is deliberately page-scoped: one controlled tab at a time.
 * Browser-level operations (tab enumeration/switching/window creation) use
 * the adjacent control channel implemented by extension/background.js.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

export interface BridgeEvent {
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeExtensionInfo {
  agent?: string;
  version?: string;
}

/**
 * A control target for the daemon→extension control channel (distinct from
 * CDP commands): attach the browser's current active tab, a specific tab, or
 * detach entirely. See the wire-protocol comment in extension/background.js.
 */
export type ControlTarget =
  | { action: 'control-active' }
  | { action: 'control-tab'; tabId: number; quiet?: boolean }
  | { action: 'list-tabs' }
  | { action: 'new-window'; url: string }
  | { action: 'stop' };

export interface ControlAck {
  ok: boolean;
  tabId: number | null;
  result?: unknown;
}

export interface BridgeTab {
  id: number;
  title: string;
  url: string;
  /** True for THIS daemon's controlled tab — never another agent's. */
  active: boolean;
  /**
   * Bridge port of the agent driving this tab, or null when it's free. Two
   * agents on one browser each see the other's territory here, which is the
   * difference between "that tab is taken" and an unexplained refusal.
   */
  controlledBy: number | null;
}

export interface BridgeRef {
  backendNodeId: number;
  role: string;
  name: string;
}

export interface BridgeSnapshotResult {
  text: string;
  refs: Map<string, BridgeRef>;
  count: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 10_000;

// ─── Session-lifecycle constants (plan §2.2) ───────────────────
// Env-overridable for field debugging; also settable per-instance via the
// constructor, which is how test/bridge-sim.ts drives transitions in
// milliseconds instead of tens of seconds (env can't be used there — ESM
// hoists imports above any process.env assignment in the test file).
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
/** No frame of any kind from the bound socket → terminate it. Kills half-open. */
const LIVENESS_MS = envMs('GHAX_BRIDGE_LIVENESS_MS', 25_000);
/** DEGRADED → EXPIRED. Covers the ≤8s extension reconnect backoff + attach. */
const GRACE_MS = envMs('GHAX_BRIDGE_GRACE_MS', 20_000);

/**
 * How many consecutive ports one browser's extension will look for daemons on,
 * starting at the configured base (9223). MUST match `PORT_RANGE` in
 * extension/background.js: the extension dials this window, so a daemon that
 * auto-picked a port above it would never be found. Ten is enough for any
 * plausible number of agents sharing one browser and keeps the extension's
 * steady-state dial rate around one per second.
 */
export const BRIDGE_PORT_RANGE = 10;

export interface BridgeOptions {
  /** DEGRADED → EXPIRED window. Defaults to GHAX_BRIDGE_GRACE_MS or 20s. */
  graceMs?: number;
  /** Silence before a bound socket is terminated. Default 25s. */
  livenessMs?: number;
  /**
   * An already-listening server to adopt instead of binding one. Set by
   * `Bridge.create`, which is the only way to learn the ACTUAL port when the
   * requested one was busy — `new WebSocketServer({port})` binds
   * asynchronously, so a constructor cannot report a bind failure.
   */
  server?: WebSocketServer;
  /**
   * Opt-in pairing code. When set, a `hello` must carry a matching
   * `pairToken` or it's rejected (`hello-reject` → the extension goes
   * dormant). The bridge WS is already localhost-only; this closes the
   * "any local process can drive the browser" gap flagged in
   * design/plan/07. Off by default — no behaviour change unless requested.
   */
  pairCode?: string | null;
}
/** Commands queued while DEGRADED before we stop pretending and fail fast. */
const QUEUE_CAP = 32;
/** ≥N bind-ownership changes inside this window trips the livelock warning. */
const LIVELOCK_WINDOW_MS = 5 * 60_000;
const LIVELOCK_THRESHOLD = 3;

export type PeerRole = 'bound' | 'parked';
/**
 * Lifecycle of the BOUND peer only. Parked-socket churn is registry
 * bookkeeping and never moves this. Identity answers *who may drive*; this
 * answers *what happens when the driver blinks*.
 */
export type BridgeSessionState = 'UNBOUND' | 'BOUND' | 'DEGRADED' | 'EXPIRED';

/** A connected extension instance, as reported by `ghax bridge instances`. */
export interface BridgeInstance {
  instanceId: string;
  browser: string;
  label: string;
  version: string;
  role: PeerRole;
  connected: boolean;
  controlledTabId: number | null;
  lastHelloAt: number;
  helloCount: number;
  replacedCount: number;
}

/**
 * Thrown to a caller whose command was in flight when the bound socket
 * dropped. The *operation* layer (runBridgeOperation in daemon.ts) decides
 * what to do: replay the whole operation for a `safe` verb, or surface
 * BRIDGE_OUTCOME_UNKNOWN for anything that may have mutated the page.
 */
export class BridgeInterrupted extends Error {
  readonly code = 'BRIDGE_INTERRUPTED';
  constructor(public readonly method: string) {
    super(`bridge: connection lost while '${method}' was in flight`);
  }
}

/**
 * Bind one WebSocketServer, resolving only once it's actually listening.
 *
 * `new WebSocketServer({port})` returns before the bind completes and reports
 * EADDRINUSE asynchronously on 'error', so port-scanning needs this promise
 * form — a synchronous constructor can only log a failure it has already
 * pretended to survive.
 */
function listenOn(port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    const onError = (err: Error) => {
      wss.off('listening', onListening);
      try { wss.close(); } catch { /* ignore */ }
      reject(err);
    };
    const onListening = () => {
      wss.off('error', onError);
      resolve(wss);
    };
    wss.once('error', onError);
    wss.once('listening', onListening);
  });
}

/** Constant-time string compare, so the pairing check can't be timed. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

interface Peer {
  instanceId: string;
  browser: string;
  label: string;
  version: string;
  ws: WebSocket | null;
  role: PeerRole;
  lastHelloAt: number;
  lastFrameAt: number;
  helloCount: number;
  replacedCount: number;
  controlledTabId: number | null;
}

interface QueuedCommand {
  method: string;
  params: Record<string, unknown>;
  deadline: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * One WebSocket server holding MANY extension connections: exactly one
 * `bound` (the driver) and any number of `parked`.
 *
 * This replaced a "latest connection wins" model that closed the incumbent
 * socket and rejected all its in-flight work. That was wrong twice over: it
 * couldn't tell "my own service worker respawned" from "a second browser
 * connected", and closing the loser's socket kicked its reconnect loop, so
 * two installs would evict each other indefinitely. Identity in the
 * handshake answers *who may drive*; keeping every healthy socket open
 * answers *how the losers stop fighting*.
 *
 * Emits:
 *   'hello'      (info: BridgeExtensionInfo)  — bound peer handshook
 *   'disconnect' ()                            — bound peer's socket dropped
 *   'expired'    ()                            — grace window elapsed
 *   'resumed'    (wasInterrupted: boolean)     — bound peer is driving again
 *   'event'      (ev: BridgeEvent)             — relayed chrome.debugger.onEvent
 *   'controlled' (tabId: number | null)        — controlled tab changed
 *   'instances'  ()                            — registry membership changed
 */
export class Bridge extends EventEmitter {
  private wss: WebSocketServer;
  private nextId = 1;
  private pending = new Map<
    number,
    { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  // Control-channel replies are correlated separately from CDP replies —
  // control messages carry `type:"control-ack"` so they never collide with
  // a `{id,result}` CDP reply in the numeric-id `pending` map.
  private controlNextId = 1;
  // The dispatching socket is stored with the resolver: control ids are minted
  // per-daemon, not per-peer, so correlating on the id alone lets ANY connected
  // peer answer a request it never received.
  private controlPending = new Map<
    number,
    { ws: WebSocket; resolve: (v: ControlAck) => void; reject: (e: Error) => void }
  >();
  // ─── Instance registry (plan §2.4) ───────────────────────────
  // Exactly one peer is `bound`; every other healthy peer is `parked` —
  // socket held OPEN, pinging, discoverable, but holding no chrome.debugger
  // attachment and receiving no CDP. Holding the socket IS the livelock cure:
  // the rival's reconnect loop is satisfied instead of retriggered. If we ever
  // closed a parked socket, background.js's reconnect loop would resume and
  // the ping-pong would simply move.
  private peers = new Map<string, Peer>();
  private socketPeer = new WeakMap<WebSocket, Peer>();
  private boundId: string | null = null;
  private _state: BridgeSessionState = 'UNBOUND';
  private sessionToken: string | null = null;
  private legacySeq = 0;
  /** Non-null → only instances matching (browser or label) may bind. */
  private bindFilter: string | null = null;
  /** Timestamps of bind-ownership changes, for the livelock detector. */
  private bindEvents: number[] = [];
  private livelockWarned = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private queue: QueuedCommand[] = [];
  private resumeWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  // The desired control target, remembered across reconnects so control
  // resumes automatically after an MV3 service-worker eviction. Set by
  // `setDesiredControl` (env-driven initial control) or `sendControl`
  // (mid-session `ghax bridge control`); cleared by a `stop`.
  private desiredControl: ControlTarget | null = null;
  private readonly log: (msg: string) => void;
  private readonly graceMs: number;
  private readonly livenessMs: number;
  private readonly pairCode: string | null;
  // Timestamps of failed pairing attempts in a rolling window, used to throttle
  // brute force. A CORRECT code is never counted and never delayed, so the
  // legit extension is unaffected; only wrong/missing codes accrue delay. The
  // counter is PER-DAEMON — each Bridge lives in its own process — so an
  // attacker spreading guesses across N daemons in the scan window gets N times
  // the free allowance. Impractical anyway against 10^8 codes; sharing the
  // counter across processes is out of scope.
  private pairFailures: number[] = [];

  readonly port: number;

  /**
   * This daemon process's identity, minted fresh on every construction.
   *
   * The extension keys its persisted control target on this, not on the bridge
   * port: with ports auto-assigned from a pool, a port identifies a SLOT and
   * the next agent to land on it is a different agent. Never persisted and
   * never derived from the port, so a new daemon cannot present the previous
   * one's id and inherit the tab it was driving.
   */
  readonly daemonId = crypto.randomUUID();

  constructor(
    port: number,
    log: (msg: string) => void = () => undefined,
    opts: BridgeOptions = {},
  ) {
    super();
    this.log = log;
    this.graceMs = opts.graceMs ?? GRACE_MS;
    this.livenessMs = opts.livenessMs ?? LIVENESS_MS;
    this.pairCode = opts.pairCode && opts.pairCode.trim() ? opts.pairCode.trim() : null;
    this.wss = opts.server ?? new WebSocketServer({ host: '127.0.0.1', port });
    this.port = port;
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('error', (err) => this.log(`bridge: server error: ${String(err)}`));
    this.livenessTimer = setInterval(
      () => this.checkLiveness(),
      Math.max(50, Math.floor(this.livenessMs / 5)),
    );
    this.livenessTimer.unref?.();
  }

  /**
   * Bind a bridge, walking up from `port` when the requested one is taken.
   *
   * This is what lets a SECOND agent attach: every daemon in bridge mode used
   * to demand 9223, so agent B's daemon could never get an extension
   * connection. The extension scans the same window (BRIDGE_PORT_RANGE), so an
   * auto-picked port needs no configuration on the browser side.
   *
   * `scan: false` (an explicitly requested port) binds or fails — silently
   * landing somewhere else would defeat the point of asking.
   */
  static async create(
    port: number,
    log: (msg: string) => void = () => undefined,
    opts: BridgeOptions & { scan?: boolean } = {},
  ): Promise<Bridge> {
    const range = opts.scan === false ? 1 : BRIDGE_PORT_RANGE;
    let lastErr: unknown = null;
    for (let candidate = port; candidate < port + range; candidate++) {
      try {
        const server = await listenOn(candidate);
        if (candidate !== port) {
          log(`bridge: port ${port} in use — bound ${candidate} instead`);
        }
        const { scan: _scan, ...rest } = opts;
        return new Bridge(candidate, log, { ...rest, server });
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
        lastErr = err;
      }
    }
    if (range === 1) {
      throw new Error(
        `bridge: port ${port} is already in use (another ghax daemon?) — omit --bridge-port to auto-pick a free one`,
      );
    }
    throw new Error(
      `bridge: no free port in ${port}-${port + range - 1} (${range} ghax daemons already running?). `
      + `Stop one with \`ghax detach\`, or move the range with --bridge-port and the popup's base-port field. `
      + `Last error: ${String(lastErr)}`,
    );
  }

  /** True when a bound extension is connected and handshaken. */
  get connected(): boolean {
    return this._state === 'BOUND' && this.boundPeer?.ws?.readyState === WebSocket.OPEN;
  }

  get state(): BridgeSessionState {
    return this._state;
  }

  get extensionInfo(): BridgeExtensionInfo | null {
    const p = this.boundPeer;
    return p ? { agent: 'ghax-ext', version: p.version } : null;
  }

  /** The tab the bound extension reports it's currently driving, or null. */
  get controlledTabId(): number | null {
    return this.boundPeer?.controlledTabId ?? null;
  }

  private get boundPeer(): Peer | null {
    return this.boundId ? this.peers.get(this.boundId) ?? null : null;
  }

  /** Restrict binding to a browser brand or label. Applied on the next hello. */
  setBindFilter(filter: string | null): void {
    this.bindFilter = filter && filter.trim() ? filter.trim().toLowerCase() : null;
  }

  /** Snapshot of every known instance — backs `ghax bridge instances`. */
  instances(): BridgeInstance[] {
    return [...this.peers.values()].map((p) => ({
      instanceId: p.instanceId,
      browser: p.browser,
      label: p.label,
      version: p.version,
      role: p.role,
      connected: p.ws?.readyState === WebSocket.OPEN,
      controlledTabId: p.controlledTabId,
      lastHelloAt: p.lastHelloAt,
      helloCount: p.helloCount,
      replacedCount: p.replacedCount,
    }));
  }

  /** True once ownership has flapped enough to indicate a pre-identity rival. */
  get livelockSuspected(): boolean {
    return this.livelockWarned;
  }

  private handleConnection(ws: WebSocket): void {
    // NOTE: no eviction here. A new socket is anonymous until its `hello`
    // names an instanceId — only then can we tell "my worker respawned" from
    // "a second browser wants in". This is the fix for the unconditional
    // `rejectAllPending('connection replaced')` that nuked in-flight work.
    ws.on('message', (data) => this.onMessage(data.toString(), ws));
    ws.on('close', () => this.handleClose(ws));
    ws.on('error', (err) => this.log(`bridge: socket error: ${String(err)}`));
  }

  private handleClose(ws: WebSocket): void {
    const peer = this.socketPeer.get(ws);
    if (!peer || peer.ws !== ws) return; // stale/superseded socket — no-op
    peer.ws = null;
    if (peer.instanceId !== this.boundId) {
      // A parked peer went away. Pure bookkeeping; the session is unaffected.
      this.emit('instances');
      return;
    }
    // The bound peer's socket dropped. Enter the grace window instead of
    // failing everything: an MV3 respawn typically reconnects in <1s.
    this.toDegraded('socket closed');
  }

  private toDegraded(reason: string): void {
    if (this._state !== 'BOUND') return;
    this._state = 'DEGRADED';
    this.log(`bridge: bound instance ${this.shortId(this.boundId)} lost (${reason}) — ${this.graceMs}ms grace`);
    // In-flight commands can't be silently retried here: only the operation
    // layer knows whether the verb was a read or a click. Hand them a typed
    // interruption and let runBridgeOperation decide.
    for (const p of this.pending.values()) p.reject(new BridgeInterrupted(p.method));
    this.pending.clear();
    for (const p of this.controlPending.values()) p.reject(new BridgeInterrupted('control'));
    this.controlPending.clear();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => this.toExpired(), this.graceMs);
    this.emit('disconnect');
  }

  private toExpired(): void {
    if (this._state !== 'DEGRADED') return;
    this._state = 'EXPIRED';
    this.graceTimer = null;
    const who = this.describePeer(this.boundPeer);
    const err = new Error(
      `bridge: extension ${who} did not reconnect within ${this.graceMs}ms. Is the browser running? Check edge://extensions.`,
    );
    (err as any).code = 'BRIDGE_DEGRADED_TIMEOUT';
    this.log(`bridge: grace expired for ${who}`);
    for (const q of this.queue.splice(0)) q.reject(err);
    for (const w of this.resumeWaiters.splice(0)) w.reject(err);
    this.emit('expired');
  }

  private checkLiveness(): void {
    const peer = this.boundPeer;
    if (this._state !== 'BOUND' || !peer?.ws) return;
    if (Date.now() - peer.lastFrameAt <= this.livenessMs) return;
    // Nothing — not even a ping — for LIVENESS_MS. The socket is half-open;
    // terminate so `close` fires deterministically instead of hanging.
    this.log(`bridge: no frames from ${this.describePeer(peer)} for ${this.livenessMs}ms — terminating socket`);
    try {
      peer.ws.terminate();
    } catch {
      // ignore
    }
  }

  private shortId(id: string | null): string {
    return id ? id.slice(0, 6) : '?';
  }

  private describePeer(p: Peer | null): string {
    if (!p) return 'unknown';
    const label = p.label ? ` "${p.label}"` : '';
    return `${p.browser || 'browser'}·${this.shortId(p.instanceId)}${label}`;
  }

  private rawSend(ws: WebSocket | null, obj: unknown): boolean {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  private onMessage(raw: string, ws: WebSocket): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const peer = this.socketPeer.get(ws);
    if (peer) peer.lastFrameAt = Date.now();

    if (msg && msg.type === 'hello') {
      this.handleHello(msg, ws);
      return;
    }
    // Keepalive: reply to the extension's ping so both sides see traffic;
    // ignore any pong. Neither disturbs id/reply correlation.
    if (msg && msg.type === 'ping') {
      this.rawSend(ws, { type: 'pong' });
      return;
    }
    if (msg && msg.type === 'pong') return;

    if (!peer) return;
    const isBound = peer.instanceId === this.boundId;

    // Control traffic is correlated by id and may come from ANY peer — a
    // parked instance answers `list-tabs` so `ghax tabs --browser <x>` can
    // enumerate it without stealing the session.
    if (msg.type === 'controlled') {
      peer.controlledTabId = typeof msg.tabId === 'number' ? msg.tabId : null;
      // Only the driver's tab changing is session-relevant (it clears refs).
      if (isBound) this.emit('controlled', peer.controlledTabId);
      return;
    }
    if (msg.type === 'control-ack') {
      const id = typeof msg.id === 'number' ? msg.id : null;
      const p = id === null ? undefined : this.controlPending.get(id);
      // Only the socket a request was dispatched to may answer it. Correlating
      // on the bare id let any peer — a parked one, or anything that got a
      // socket — resolve the BOUND peer's pending control request with its own
      // payload, e.g. handing `list-tabs` a different browser's tabs.
      if (p && p.ws !== ws) return;
      if (id !== null) this.controlPending.delete(id);
      if (msg.ok && typeof msg.tabId === 'number') peer.controlledTabId = msg.tabId;
      else if (msg.ok && msg.tabId === null) peer.controlledTabId = null;
      if (p) {
        if (msg.ok) p.resolve({
          ok: true,
          tabId: typeof msg.tabId === 'number' ? msg.tabId : null,
          ...(msg.result !== undefined ? { result: msg.result } : {}),
        });
        else p.reject(new Error(msg.error || 'bridge: control failed'));
      }
      return;
    }

    // CDP replies and events are session traffic — only the BOUND peer drives.
    // A parked peer that somehow sent CDP is ignored, not obeyed.
    if (!isBound) return;
    if (msg.type === 'event') {
      this.emit('event', { method: msg.method, params: msg.params ?? {} } as BridgeEvent);
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        // `phase` (extension/background.js) says which half of the relay
        // failed. `dispatch-detached` means chrome.debugger dropped while the
        // command was already on the wire — so the action MAY have landed.
        // That is exactly BridgeInterrupted's contract, and routing it there
        // hands it to the retry-class table in daemon.ts `register()`: a
        // `safe` verb replays in full, anything else surfaces
        // BRIDGE_OUTCOME_UNKNOWN with the "verify with `ghax snapshot`" hint.
        //
        // Attach-phase failures deliberately do NOT come here: the extension
        // absorbs the transient ones before dispatch, and a genuinely
        // unattachable tab is a plain error, not an ambiguous outcome.
        if (msg.error.phase === 'dispatch-detached') p.reject(new BridgeInterrupted(p.method));
        else p.reject(new Error(msg.error.message || 'bridge command failed'));
      } else p.resolve(msg.result);
      return;
    }
  }

  /**
   * Handshake v2. Decides this connection's role and answers with
   * `hello-ack`. Arbitration (plan §2.4): a bind filter makes acceptance
   * identity-scoped; with no filter the first hello binds and later ones
   * park. Parking is non-destructive, so "first wins" is safe — and takeover
   * is always explicit via `use()`.
   */
  /**
   * Throttled pairing rejection. Brute-forcing an 8-digit code (10^8) needs
   * ~10^8 attempts; an escalating delay past a small free allowance makes that
   * infeasible. The counter is per-daemon (one Bridge per process), so N
   * daemons running at once multiply the free allowance by N — still nowhere
   * near 10^8. The delay is applied to the FAILURE path only — a correct code
   * is checked first and never reaches here — so the legit extension is never
   * penalized.
   */
  private rejectPairing(ws: WebSocket, kind: 'wrong' | 'missing'): void {
    const now = Date.now();
    this.pairFailures = this.pairFailures.filter((t) => now - t < 60_000);
    this.pairFailures.push(now);
    const n = this.pairFailures.length;
    // First few are free (real typos), then 500ms per extra failure, capped
    // at 10s. At the cap a single client manages ~6 tries/min; 10^8 codes make
    // brute force take on the order of centuries.
    const FREE = 5;
    const delayMs = n <= FREE ? 0 : Math.min(10_000, (n - FREE) * 500);
    if (n === FREE + 1) {
      this.log('bridge: repeated bad pairing codes — throttling (possible brute-force from a local process)');
    } else {
      this.log(`bridge: rejecting hello — ${kind} pairing code`);
    }
    const send = () => this.rawSend(ws, {
      type: 'hello-reject',
      reason: 'auth',
      message: 'pairing code required — enter the code ghax printed into the ghax bridge popup',
    });
    if (delayMs === 0) send();
    else setTimeout(send, delayMs).unref?.();
  }

  private handleHello(msg: any, ws: WebSocket): void {
    // Pairing gate (opt-in). A wrong/absent code is rejected explicitly —
    // `hello-reject` sends the extension dormant (a slow retry), NOT a socket
    // close that would restart its fast reconnect loop.
    if (this.pairCode) {
      const supplied = typeof msg.pairToken === 'string' ? msg.pairToken : '';
      if (!timingSafeEqualStr(supplied, this.pairCode)) {
        this.rejectPairing(ws, supplied ? 'wrong' : 'missing');
        return;
      }
      // Correct code: a clean slate, so one legit typo doesn't leave the user
      // throttled behind an attacker's noise.
      this.pairFailures = [];
    }
    let instanceId = typeof msg.instanceId === 'string' && msg.instanceId ? msg.instanceId : '';
    const legacy = !instanceId;
    if (legacy) {
      // Pre-v2 extension: no minted identity. Give it a synthetic one so the
      // registry still works, and tell the operator to reload — until every
      // profile is reloaded, legacy clients can still fight each other.
      instanceId = `legacy-${++this.legacySeq}`;
      this.log(
        'bridge: hello without instanceId — reload the ghax bridge extension in edge://extensions (every profile)',
      );
    }
    const browser = typeof msg.browser === 'string' ? msg.browser : '';
    const label = typeof msg.label === 'string' ? msg.label : '';
    const version = typeof msg.version === 'string' ? msg.version : '?';

    let peer = this.peers.get(instanceId);
    if (!peer) {
      peer = {
        instanceId, browser, label, version,
        ws: null, role: 'parked',
        lastHelloAt: 0, lastFrameAt: Date.now(),
        helloCount: 0, replacedCount: 0, controlledTabId: null,
      };
      this.peers.set(instanceId, peer);
    }
    if (peer.ws && peer.ws !== ws) {
      // Same instance, new socket — its old one is stale (respawn raced the
      // close). Drop the old quietly; this is NOT a rival.
      peer.replacedCount++;
      const old = peer.ws;
      this.socketPeer.delete(old);
      try { old.close(); } catch { /* ignore */ }
    }
    peer.ws = ws;
    peer.browser = browser || peer.browser;
    peer.label = label || peer.label;
    peer.version = version;
    peer.helloCount++;
    peer.lastHelloAt = Date.now();
    peer.lastFrameAt = Date.now();
    peer.controlledTabId = typeof msg.controlledTabId === 'number' ? msg.controlledTabId : null;
    this.socketPeer.set(ws, peer);

    const isResume = this.boundId === instanceId;
    const noBoundPeer = this.boundId === null;
    // A rival may take the session only once the incumbent is genuinely gone,
    // and the GRACE TIMER is what decides that: EXPIRED, or nothing bound yet.
    // DEGRADED must not qualify — the bound peer's `ws` is null for the whole
    // grace window (handleClose nulls it), so admitting that condition meant a
    // routine MV3 service-worker respawn was an open door: any other install
    // reconnecting first took the session and demoted the returning incumbent
    // to parked, mid-drive. Takeover inside the window stays explicit: `use()`.
    const boundGone = !noBoundPeer && !isResume && this._state === 'EXPIRED';
    const matchesFilter = !this.bindFilter
      || browser.toLowerCase() === this.bindFilter
      || label.toLowerCase() === this.bindFilter;

    let role: PeerRole;
    if (isResume) {
      role = 'bound';
    } else if ((noBoundPeer || boundGone) && matchesFilter) {
      role = 'bound';
    } else {
      role = 'parked';
    }

    // A takeover reads exactly like a first bind in the log otherwise, which is
    // how "the session moved" hid behind "an extension connected".
    const reason = role === 'bound'
      ? (isResume
        ? 'resume'
        : (noBoundPeer ? 'first-bind' : `takeover — ${this.describePeer(this.boundPeer)} never came back`))
      : (matchesFilter
        ? `${this.describePeer(this.boundPeer)} is bound`
        : `does not match --browser ${this.bindFilter}`);
    this.log(
      `bridge: hello ${this.describePeer(peer)} v${version} → ${role} (${reason})`,
    );

    if (role === 'parked') {
      peer.role = 'parked';
      this.rawSend(ws, {
        type: 'hello-ack', role: 'parked', daemonId: this.daemonId, graceMs: this.graceMs,
      });
      this.emit('instances');
      return;
    }

    // ─── Bind / resume ───────────────────────────────────────
    const previousBound = this.boundId;
    const ownershipChanged = previousBound !== instanceId;
    peer.role = 'bound';
    this.boundId = instanceId;
    if (!this.sessionToken || ownershipChanged) {
      this.sessionToken = crypto.randomBytes(16).toString('hex');
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    const wasInterrupted = this._state !== 'BOUND';
    this._state = 'BOUND';
    if (ownershipChanged) this.noteBindChange();

    this.rawSend(ws, {
      type: 'hello-ack',
      role: 'bound',
      // Identity of the DAEMON, not the port: the extension hands back any tab
      // it was driving for a different daemon before it starts driving for this
      // one. See the `daemonId` field.
      daemonId: this.daemonId,
      sessionToken: this.sessionToken,
      graceMs: this.graceMs,
    });
    this.emit('hello', this.extensionInfo);
    this.emit('instances');

    // Resume order matters (plan §2.2): re-assert control and AWAIT its ack
    // before anything queued is allowed to run, so replayed work can't land
    // on a tab the respawned worker hasn't re-attached yet.
    void this.resumeSequence(wasInterrupted);
  }

  private async resumeSequence(wasInterrupted: boolean): Promise<void> {
    try {
      if (this.desiredControl && this.desiredControl.action !== 'stop') {
        await this.sendControl(this.desiredControl);
      }
      this.emit('resumed', wasInterrupted);
      for (const w of this.resumeWaiters.splice(0)) w.resolve();
      this.flushQueue();
    } catch (e) {
      this.log(`bridge: re-assert control failed: ${String(e)}`);
      // Control didn't come back; let the grace timer keep running rather
      // than flushing work at a tab we don't actually own.
      for (const w of this.resumeWaiters.splice(0)) {
        w.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  /**
   * Track bind-ownership changes. Flapping means something is fighting for
   * the bridge — almost always a pre-identity extension still installed in
   * another profile. Surface it instead of letting it churn silently.
   */
  private noteBindChange(): void {
    const now = Date.now();
    this.bindEvents = this.bindEvents.filter((t) => now - t < LIVELOCK_WINDOW_MS);
    this.bindEvents.push(now);
    if (this.bindEvents.length >= LIVELOCK_THRESHOLD && !this.livelockWarned) {
      this.livelockWarned = true;
      this.log(
        'bridge: WARNING — bridge ownership is flapping. A pre-identity ghax bridge ' +
        'extension is probably still installed in another profile; reload the extension ' +
        'in edge://extensions in EVERY profile, or disable the ones you do not drive.',
      );
    }
  }

  private flushQueue(): void {
    if (this._state !== 'BOUND') return;
    const now = Date.now();
    for (const q of this.queue.splice(0)) {
      if (q.deadline <= now) {
        q.reject(new Error(`bridge: ${q.method} timed out while the extension was reconnecting`));
        continue;
      }
      this.dispatch(q.method, q.params, q.deadline - now).then(q.resolve, q.reject);
    }
  }

  /**
   * Resolve when the bridge is BOUND again (immediately if it already is),
   * reject if the grace window expires first. The operation layer awaits this
   * before replaying a `safe` verb.
   */
  waitForResume(): Promise<void> {
    if (this._state === 'BOUND') return Promise.resolve();
    if (this._state === 'UNBOUND' || this._state === 'EXPIRED') {
      return Promise.reject(new Error('ghax bridge: no extension connected.'));
    }
    return new Promise((resolve, reject) => this.resumeWaiters.push({ resolve, reject }));
  }

  /**
   * Send one CDP command to the bound extension's controlled tab.
   *
   * BOUND     → dispatched now.
   * DEGRADED  → QUEUED (the caller sees latency, not an error, if the
   *             extension returns inside the grace window). The command still
   *             honours its OWN deadline: a 20s session grace must never turn
   *             a 5s command into a 20s hang.
   * otherwise → rejected immediately with install guidance.
   */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this._state === 'BOUND') return this.dispatch(method, params, timeoutMs);
    if (this._state === 'DEGRADED') {
      if (this.queue.length >= QUEUE_CAP) {
        return Promise.reject(new Error('bridge: too many commands queued while the extension reconnects'));
      }
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const entry: QueuedCommand = { method, params, deadline, resolve, reject };
        this.queue.push(entry);
        setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(new Error(`bridge: ${method} timed out after ${timeoutMs}ms (extension reconnecting)`));
          }
        }, timeoutMs).unref?.();
      });
    }
    return Promise.reject(
      new Error(
        'ghax bridge: no extension connected. Load extension/ unpacked, then click "Control this tab" in the ghax bridge popup.',
      ),
    );
  }

  private dispatch(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const ws = this.boundPeer?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(
          'ghax bridge: no extension connected. Load extension/ unpacked, then click "Control this tab" in the ghax bridge popup.',
        ),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Rebind to a different instance by id, browser brand, or label. Uses the
   * `role` message so demotion/promotion happens over LIVE sockets — no
   * disconnect, so neither side re-enters a reconnect loop.
   */
  async use(selector: string): Promise<BridgeInstance> {
    const want = selector.trim().toLowerCase();
    const target = [...this.peers.values()].find(
      (p) => p.instanceId.toLowerCase().startsWith(want)
        || p.browser.toLowerCase() === want
        || p.label.toLowerCase() === want,
    );
    if (!target) {
      const known = this.instances().map((i) => `${i.browser}·${i.instanceId.slice(0, 6)}`).join(', ') || 'none';
      throw new Error(`bridge: no instance matching '${selector}'. Known instances: ${known}`);
    }
    if (target.ws?.readyState !== WebSocket.OPEN) {
      throw new Error(`bridge: instance ${this.describePeer(target)} is not connected`);
    }
    if (target.instanceId === this.boundId) return this.instances().find((i) => i.instanceId === target.instanceId)!;

    const previous = this.boundPeer;
    if (previous?.ws) {
      previous.role = 'parked';
      this.rawSend(previous.ws, { type: 'role', role: 'parked', daemonId: this.daemonId });
    }
    // Drop session state tied to the old instance. Tab ids are per-browser,
    // so refs MUST die here — the 'controlled' emit reuses the existing
    // ref-clearing path (CLAUDE.md invariant 3) for free.
    for (const p of this.pending.values()) p.reject(new BridgeInterrupted(p.method));
    this.pending.clear();
    // Control requests belong to the instance they were dispatched to just as
    // much as CDP does: a late ack arriving after the session moved would
    // answer for a browser that is no longer the one being driven.
    for (const p of this.controlPending.values()) {
      p.reject(new Error('bridge: rebound to a different instance'));
    }
    this.controlPending.clear();
    for (const q of this.queue.splice(0)) q.reject(new Error('bridge: rebound to a different instance'));
    this.desiredControl = null;

    target.role = 'bound';
    this.boundId = target.instanceId;
    this._state = 'BOUND';
    this.sessionToken = crypto.randomBytes(16).toString('hex');
    this.noteBindChange();
    this.rawSend(target.ws, {
      type: 'role', role: 'bound', daemonId: this.daemonId, sessionToken: this.sessionToken,
    });
    this.log(`bridge: bound → ${this.describePeer(target)}`);
    this.emit('controlled', target.controlledTabId);
    this.emit('instances');
    return this.instances().find((i) => i.instanceId === target.instanceId)!;
  }

  /**
   * Remember a desired control target WITHOUT sending it now — used for
   * env-driven initial control (`GHAX_BRIDGE_CONTROL=active`) set before the
   * extension has connected. The `hello` handler sends it once the
   * extension is live.
   */
  setDesiredControl(target: ControlTarget): void {
    this.desiredControl = target.action === 'stop' ? null : target;
  }

  /**
   * Send a control message to the extension and await its `control-ack`.
   * Also records the target as `desiredControl` (except `stop`, which
   * clears it) so it's re-asserted on the next reconnect. Rejects if no
   * extension is connected, or after `CONTROL_TIMEOUT_MS`.
   */
  sendControl(target: ControlTarget, timeoutMs = CONTROL_TIMEOUT_MS): Promise<ControlAck> {
    if (target.action === 'stop') this.desiredControl = null;
    else if (target.action === 'control-active') this.desiredControl = target;
    else if (target.action === 'control-tab') this.desiredControl = { ...target, quiet: true };
    const ws = this.boundPeer?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this._state !== 'BOUND') {
      return Promise.reject(
        new Error(
          'ghax bridge: no extension connected. Load extension/ unpacked (the ghax bridge extension) and make sure the browser is running.',
        ),
      );
    }
    return this.dispatchControl(ws, target, timeoutMs);
  }

  /**
   * Send a control message to a SPECIFIC instance, bound or parked.
   *
   * Only safe for control actions that don't require a debugger attachment —
   * `list-tabs` is the motivating case (`ghax tabs --browser chrome`), since
   * `chrome.tabs.query` needs no attachment. Do NOT route attach-requiring
   * actions here: a parked peer deliberately holds no attachment.
   */
  sendControlToInstance(
    selector: string,
    target: ControlTarget,
    timeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<ControlAck> {
    const peer = this.findPeer(selector);
    if (!peer) {
      const known = this.instances().map((i) => `${i.browser}·${i.instanceId.slice(0, 6)}`).join(', ') || 'none';
      return Promise.reject(new Error(`bridge: no instance matching '${selector}'. Known instances: ${known}`));
    }
    if (peer.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`bridge: instance ${this.describePeer(peer)} is not connected`));
    }
    return this.dispatchControl(peer.ws, target, timeoutMs);
  }

  private findPeer(selector: string): Peer | null {
    const want = selector.trim().toLowerCase();
    return [...this.peers.values()].find(
      (p) => p.instanceId.toLowerCase().startsWith(want)
        || p.browser.toLowerCase() === want
        || p.label.toLowerCase() === want,
    ) ?? null;
  }

  private dispatchControl(ws: WebSocket, target: ControlTarget, timeoutMs: number): Promise<ControlAck> {
    const id = this.controlNextId++;
    return new Promise<ControlAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlPending.delete(id);
        reject(new Error(`bridge: control(${target.action}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.controlPending.set(id, {
        ws,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        ws.send(JSON.stringify({ type: 'control', id, ...target }));
      } catch (err) {
        clearTimeout(timer);
        this.controlPending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Subscribe to relayed CDP events. Returns an unsubscribe function. */
  onEvent(listener: (ev: BridgeEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  close(): void {
    const err = new Error('bridge: shutting down');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const p of this.controlPending.values()) p.reject(err);
    this.controlPending.clear();
    for (const q of this.queue.splice(0)) q.reject(err);
    for (const w of this.resumeWaiters.splice(0)) w.reject(err);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    for (const peer of this.peers.values()) {
      try {
        peer.ws?.close();
      } catch {
        // ignore
      }
      peer.ws = null;
    }
    try {
      this.wss.close();
    } catch {
      // ignore
    }
  }
}

// ─── CDP result helpers shared by the daemon's bridge-mode verb branches ──

/**
 * Unwrap a `Runtime.evaluate` result the way `page.evaluate()` would:
 * return the value on success, throw the page-side exception's
 * description on failure.
 */
export function unwrapEvalResult(result: unknown): unknown {
  const r = result as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } } | null;
  if (r?.exceptionDetails) {
    const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Runtime.evaluate exception';
    throw new Error(desc);
  }
  return r?.result?.value;
}

/**
 * `Runtime.evaluate` with the same flags `eval`/`text` need.
 *
 * `uniqueContextId` pins the evaluation to a specific live document. Without
 * it, a read issued around a navigation can execute against the document
 * Chromium is about to discard — one source of the intermittent
 * "only got the nav shell" reads. Callers pass the main frame's default
 * context (tracked in daemon.ts); omitting it keeps the old unpinned
 * behaviour, which is the correct fallback when bookkeeping hasn't caught up.
 *
 * Note `uniqueContextId` and `contextId` are mutually exclusive in CDP, and
 * the unique form is preferred because Chromium reuses numeric ids across
 * navigations.
 */
export async function bridgeEvaluate(
  bridge: Bridge,
  expression: string,
  opts: { uniqueContextId?: string | null; timeoutMs?: number } = {},
): Promise<unknown> {
  const params: Record<string, unknown> = {
    expression,
    awaitPromise: true,
    returnByValue: true,
  };
  if (opts.uniqueContextId) params.uniqueContextId = opts.uniqueContextId;
  const result = await bridge.send('Runtime.evaluate', params, opts.timeoutMs);
  return unwrapEvalResult(result);
}

/**
 * True when CDP rejected an evaluate because the pinned context is gone.
 *
 * `uniqueContextId not found` is the one Chrome actually returns when we pin
 * via `uniqueContextId` — which is every bridge eval. It was missing here, so
 * the self-heal in `bridgeEval` never fired for its most common real-world
 * trigger: a command issued in the window between a cross-origin `goto` and
 * the daemon's context bookkeeping catching up. Verified live against
 * concord.rmm.datto.com → ww14.autotask.net.
 */
export function isStaleContextError(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  return /cannot find context|context with specified id|uniquecontextid not found|execution context was destroyed|no execution context/i.test(msg);
}

/**
 * Navigate through the extension, which waits for the tab load and recovers
 * an unattachable cert/chrome-error target via chrome.tabs.update before it
 * re-attaches. Then read back the final URL + title via Runtime.evaluate.
 */
export async function bridgeGoto(
  bridge: Bridge,
  url: string,
  loadTimeoutMs = 8_000,
): Promise<{ url: string; title: string }> {
  const navigation = await bridge.send('Page.navigate', {
    url,
    ghaxLoadTimeoutMs: loadTimeoutMs,
  }) as { ghaxFinalUrl?: string; ghaxTitle?: string } | undefined;

  let finalUrl = navigation?.ghaxFinalUrl || url;
  let title = navigation?.ghaxTitle || '';
  try {
    const info = (await bridgeEvaluate(bridge, '({ url: location.href, title: document.title })')) as
      | { url?: string; title?: string }
      | undefined;
    if (info?.url) finalUrl = info.url;
    if (info?.title) title = info.title;
  } catch {
    // Best-effort — navigation still "succeeded" even if we couldn't read
    // back the final location (e.g. the page immediately redirected again).
  }
  return { url: finalUrl, title };
}

/** `document.body.innerText`, shaped exactly like the non-bridge `text` verb. */
export async function bridgeText(bridge: Bridge): Promise<string> {
  const value = await bridgeEvaluate(bridge, 'document.body.innerText');
  return typeof value === 'string' ? value : String(value ?? '');
}

const BRIDGE_INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem',
]);

interface AxValue { value?: unknown }
interface AxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: Array<{ name: string; value?: AxValue }>;
}

function axRole(node: AxNode): string {
  const raw = String(node.role?.value ?? '');
  if (raw === 'StaticText' || raw === 'LineBreak') return 'text';
  return raw.toLowerCase();
}

function axProps(node: AxNode): string {
  const values: string[] = [];
  for (const prop of node.properties ?? []) {
    const value = prop.value?.value;
    if (value === undefined || value === null || value === false || value === '') continue;
    if (prop.name === 'focusable' || prop.name === 'editable' || prop.name === 'settable') continue;
    if (value === true) values.push(prop.name);
    else if (['checked', 'pressed', 'expanded', 'selected', 'level', 'valuetext', 'value'].includes(prop.name)) {
      values.push(`${prop.name}=${String(value)}`);
    }
  }
  return values.length > 0 ? `[${values.join(', ')}]` : '';
}

async function runtimeObjectFor(
  bridge: Bridge,
  expression: string,
): Promise<{ objectId: string; backendNodeId: number } | null> {
  const evaluated = await bridge.send('Runtime.evaluate', {
    expression,
    returnByValue: false,
  }) as { result?: { objectId?: string; subtype?: string } };
  const objectId = evaluated.result?.objectId;
  if (!objectId || evaluated.result?.subtype === 'null') return null;
  try {
    const described = await bridge.send('DOM.describeNode', { objectId }) as {
      node?: { backendNodeId?: number };
    };
    const backendNodeId = described.node?.backendNodeId;
    return typeof backendNodeId === 'number' ? { objectId, backendNodeId } : null;
  } catch {
    await bridge.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
    return null;
  }
}

async function tagBackendNode(bridge: Bridge, backendNodeId: number, ref: string): Promise<boolean> {
  try {
    const resolved = await bridge.send('DOM.resolveNode', {
      backendNodeId,
      objectGroup: 'ghax-refs',
    }) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId) return false;
    await bridge.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(ref) {
        if (this && this.nodeType === Node.ELEMENT_NODE) this.setAttribute('data-ghax-ref', ref);
        return true;
      }`,
      arguments: [{ value: ref }],
      returnByValue: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the bridge snapshot from Chromium's own accessibility tree. Every
 * emitted ref keeps the AX node's backendDOMNodeId and is also tagged in the
 * page DOM for human inspection/debugging. The backend id is the resolver;
 * the attribute is not relied on for interaction and therefore survives
 * selector changes caused by React rerenders better than a CSS path.
 */
export async function bridgeSnapshot(
  bridge: Bridge,
  opts: {
    interactive?: boolean;
    compact?: boolean;
    depth?: number;
    selector?: string;
    cursorInteractive?: boolean;
    dialogScope?: boolean;
  } = {},
): Promise<BridgeSnapshotResult> {
  await bridge.send('Runtime.enable');
  await bridge.send('DOM.enable');
  await bridge.send('Accessibility.enable');
  await bridgeEvaluate(bridge, `(() => {
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        el.removeAttribute('data-ghax-ref');
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
  })()`).catch(() => undefined);
  await bridge.send('Runtime.releaseObjectGroup', { objectGroup: 'ghax-refs' }).catch(() => undefined);

  let rootBackendNodeId: number | null = null;
  if (opts.selector) {
    const root = await runtimeObjectFor(bridge, `document.querySelector(${JSON.stringify(opts.selector)})`);
    if (!root) throw new Error(`Selector not found: ${opts.selector}`);
    rootBackendNodeId = root.backendNodeId;
    await bridge.send('Runtime.releaseObject', { objectId: root.objectId }).catch(() => undefined);
  } else if (opts.dialogScope !== false) {
    const modal = await runtimeObjectFor(bridge, `(() => {
      const selectors = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]';
      const visible = [...document.querySelectorAll(selectors)].filter((el) => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      return visible.at(-1) || document.body;
    })()`);
    if (modal) {
      rootBackendNodeId = modal.backendNodeId;
      await bridge.send('Runtime.releaseObject', { objectId: modal.objectId }).catch(() => undefined);
    }
  }
  if (rootBackendNodeId === null) {
    const body = await runtimeObjectFor(bridge, 'document.body');
    if (body) {
      rootBackendNodeId = body.backendNodeId;
      await bridge.send('Runtime.releaseObject', { objectId: body.objectId }).catch(() => undefined);
    }
  }

  const result = await bridge.send('Accessibility.getFullAXTree', {}) as { nodes?: AxNode[] };
  const nodes = result.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  let root = rootBackendNodeId === null
    ? undefined
    : nodes.find((n) => n.backendDOMNodeId === rootBackendNodeId);
  root ??= nodes.find((n) => !n.parentId) ?? nodes[0];

  const refs = new Map<string, BridgeRef>();
  const output: string[] = [];
  let nextRef = 1;
  const walk = async (node: AxNode, depth: number): Promise<void> => {
    const role = axRole(node);
    const rawRole = String(node.role?.value ?? '');
    const axName = String(node.name?.value ?? '');
    const name = rawRole === 'StaticText' || rawRole === 'LineBreak' ? '' : axName;
    const children = rawRole === 'StaticText' || rawRole === 'LineBreak'
      ? axName
      : (node.value?.value === undefined ? '' : String(node.value.value));
    const skipStructural = node.ignored || !role || role === 'none' || role === 'rootwebarea' ||
      role === 'webarea' || role === 'inlineTextBox'.toLowerCase() || (role === 'generic' && !name);
    const isInteractive = BRIDGE_INTERACTIVE_ROLES.has(role);
    const withinDepth = opts.depth === undefined || depth <= opts.depth;
    const compactSkip = Boolean(opts.compact && !isInteractive && !name);
    if (!skipStructural && withinDepth && !compactSkip && (!opts.interactive || isInteractive)) {
      if (typeof node.backendDOMNodeId === 'number') {
        const ref = `e${nextRef++}`;
        await tagBackendNode(bridge, node.backendDOMNodeId, ref);
        refs.set(ref, { backendNodeId: node.backendDOMNodeId, role, name });
        let line = `${'  '.repeat(Math.max(0, depth))}@${ref} [${role}]`;
        if (name) line += ` ${JSON.stringify(name)}`;
        const props = axProps(node);
        if (props) line += ` ${props}`;
        if (children) line += `: ${children}`;
        output.push(line);
      }
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) await walk(child, skipStructural ? depth : depth + 1);
    }
  };
  if (root) await walk(root, -1);

  const wantCursor = opts.cursorInteractive || (opts.interactive && !opts.compact);
  if (wantCursor) {
    const cursor = await bridgeEvaluate(bridge, `(() => {
      const standard = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','DETAILS']);
      const out = []; let n = 1;
      const walk = (root, inShadow) => {
        for (const el of root.querySelectorAll('*')) {
          const style = getComputedStyle(el);
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
          const tabindex = el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0;
          if (visible && !standard.has(el.tagName) && !el.hasAttribute('role') &&
              (style.cursor === 'pointer' || el.hasAttribute('onclick') || tabindex)) {
            const ref = 'c' + n++;
            el.setAttribute('data-ghax-ref', ref);
            const reasons = [];
            if (inShadow) reasons.push('shadow');
            if (style.cursor === 'pointer') reasons.push('cursor:pointer');
            if (el.hasAttribute('onclick')) reasons.push('onclick');
            if (tabindex) reasons.push('tabindex=' + el.getAttribute('tabindex'));
            out.push({ ref, text: (el.innerText || el.tagName.toLowerCase()).trim().slice(0, 80), reason: reasons.join(', ') });
          }
          if (el.shadowRoot) walk(el.shadowRoot, true);
        }
      };
      walk(document, false);
      return out;
    })()`) as Array<{ ref: string; text: string; reason: string }>;
    if (cursor.length > 0) {
      output.push('', '── cursor-interactive (not in ARIA tree) ──');
      for (const item of cursor) {
        const object = await runtimeObjectFor(bridge, `(() => {
          const find = (root) => {
            const hit = root.querySelector('[data-ghax-ref="${item.ref}"]');
            if (hit) return hit;
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const nested = find(el.shadowRoot); if (nested) return nested; }
            return null;
          };
          return find(document);
        })()`);
        if (!object) continue;
        refs.set(item.ref, { backendNodeId: object.backendNodeId, role: 'cursor-interactive', name: item.text });
        await bridge.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
        output.push(`@${item.ref} [${item.reason}] ${JSON.stringify(item.text)}`);
      }
    }
  }

  if (output.length === 0) {
    return {
      text: opts.interactive ? '(no interactive elements found)' : '(no accessible elements found)',
      refs,
      count: 0,
    };
  }
  return { text: output.join('\n'), refs, count: refs.size };
}

/** Resolve a normal CSS selector to the same backend-node handle refs use. */
export async function bridgeResolveSelector(bridge: Bridge, selector: string): Promise<BridgeRef> {
  const object = await runtimeObjectFor(bridge, `document.querySelector(${JSON.stringify(selector)})`);
  if (!object) throw new Error(`Selector not found: ${selector}`);
  await bridge.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
  return { backendNodeId: object.backendNodeId, role: '', name: '' };
}

export async function bridgeBox(
  bridge: Bridge,
  ref: BridgeRef,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await bridge.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: ref.backendNodeId }).catch(() => undefined);
  const model = await bridge.send('DOM.getBoxModel', { backendNodeId: ref.backendNodeId }) as {
    model?: { border?: number[]; content?: number[] };
  };
  const quad = model.model?.border ?? model.model?.content;
  if (!quad || quad.length < 8) throw new Error('element not visible or not in layout');
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export async function bridgeCallOn(
  bridge: Bridge,
  ref: BridgeRef,
  functionDeclaration: string,
  args: unknown[] = [],
): Promise<unknown> {
  const resolved = await bridge.send('DOM.resolveNode', { backendNodeId: ref.backendNodeId }) as {
    object?: { objectId?: string };
  };
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error('element no longer exists. Run \'ghax snapshot\' again.');
  try {
    const result = await bridge.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
    });
    return unwrapEvalResult(result);
  } finally {
    await bridge.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}
