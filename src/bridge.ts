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
 *     {"type":"hello","agent":"ghax-ext","version":"0.1.0","gitSha?":"...","buildDate?":"..."}
 *     (gitSha/buildDate are optional — absent on any extension build older
 *     than the provenance change, or one loaded before its first `npm run
 *     build` produced extension/build-info.json; treated as "unknown".)
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
import { CdpStats, type CdpStatsSnapshot } from './cdp-stats';
import { actionability, type ActionabilityKind, type ActionabilityResult } from './actionability';
import { RefRegistry, type RefAllocator } from './ref-registry';
import { BIND_ALL, PeerRegistry, type Peer, type PeerRole, type BridgeSelection, type BridgeInstance } from './bridge-peers';
export { BIND_ALL } from './bridge-peers';
export type { Peer, PeerRole, BridgeSelectionState, BridgeCandidate, BridgeSelection, BridgeInstance } from './bridge-peers';

export interface BridgeEvent {
  method: string;
  params: Record<string, unknown>;
  /** The bound peer that relayed it — several may be bound under `all`. */
  instanceId?: string;
  /** That peer's controlled tab when the event arrived. */
  tabId?: number | null;
}

export interface BridgeExtensionInfo {
  agent?: string;
  version?: string;
  /** Optional — absent for any extension build older than the provenance
   * change (`hello` simply omits the fields), so every reader treats these
   * as "unknown" rather than a protocol violation. */
  gitSha?: string;
  buildDate?: string;
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
  | { action: 'reload' }
  | { action: 'stop' };

export interface ControlAck {
  ok: boolean;
  tabId: number | null;
  result?: unknown;
  /** The instance that answered, so tab ids can be minted with its alias. */
  instanceId?: string;
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
  /** Absent (null) from extensions predating tab identity. */
  windowId: number | null;
  /** Position within its window; null from older extensions. */
  index: number | null;
}

/**
 * What a bridge `@ref` points at. AX refs carry the backend node id the AX
 * tree already gave us. Cursor refs (`@c<n>`, elements the AX tree misses)
 * carry `cursorId`, a key into the page-side `window.__ghax.nodes` map, and
 * are resolved to a node only when something acts on them: tagging each one
 * at snapshot time cost two relayed calls per ref.
 */
export interface BridgeRef {
  backendNodeId: number | null;
  cursorId?: number;
  role: string;
  name: string;
}

export interface BridgeSnapshotResult {
  text: string;
  refs: Map<string, BridgeRef>;
  count: number;
  /** True when rooted at --selector or a modal, i.e. not the whole page. */
  scoped: boolean;
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
 * How long the first `hello` waits for other browsers before anything binds
 * (plan 11, phase 1). Two browsers dialling the same daemon arrive within a
 * second of each other; without this window the first one simply won. `0`
 * restores first-hello-wins, which is what the single-browser sims use.
 */
function settleMsFromEnv(): number {
  const raw = Number(process.env.GHAX_BRIDGE_SETTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}
const SETTLE_MS = settleMsFromEnv();

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
  /** First-bind settle window. Defaults to GHAX_BRIDGE_SETTLE_MS or 1500ms; 0 = first hello binds. */
  settleMs?: number;
}
/** Commands queued while DEGRADED before we stop pretending and fail fast. */
const QUEUE_CAP = 32;
/** ≥N bind-ownership changes inside this window trips the livelock warning. */
const LIVELOCK_WINDOW_MS = 5 * 60_000;
const LIVELOCK_THRESHOLD = 3;

/**
 * Lifecycle of one BOUND peer's session. Parked-socket churn is registry
 * bookkeeping and never moves this. Identity answers *who may drive*; this
 * answers *what happens when the driver blinks*.
 */
export type BridgeSessionState = 'UNBOUND' | 'BOUND' | 'DEGRADED' | 'EXPIRED';

/**
 * Thrown to a caller whose command was in flight when the bound socket
 * dropped. The *operation* layer (runBridgeOperation in daemon.ts) decides
 * what to do: replay the whole operation for a `safe` verb, or surface
 * BRIDGE_OUTCOME_UNKNOWN for anything that may have mutated the page.
 */
export class BridgeInterrupted extends Error {
  readonly code = 'BRIDGE_INTERRUPTED';
  /**
   * `instanceId` is the peer the command was in flight on. A replay may only
   * ever run there: by the time the drop surfaces, `use` may have made a
   * different browser the active one.
   */
  constructor(public readonly method: string, public readonly instanceId: string | null = null) {
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

interface QueuedCommand {
  method: string;
  params: Record<string, unknown>;
  deadline: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Names one bound peer for a call; omitted = the active one. */
export interface PeerOpt {
  peer?: string;
}

/**
 * Everything that belongs to ONE bound browser's session (plan 12, brief A).
 * Under a single-browser filter there is at most one of these; under `all`
 * there is one per bound browser, so one peer's drop, queue and grace window
 * can never stall another's.
 */
class PeerSession {
  state: BridgeSessionState = 'UNBOUND';
  sessionToken: string | null = null;
  graceTimer: NodeJS.Timeout | null = null;
  queue: QueuedCommand[] = [];
  resumeWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  // The desired control target, remembered across reconnects so control
  // resumes automatically after an MV3 service-worker eviction. Set by
  // `setDesiredControl` (env-driven initial control) or `sendControl`
  // (mid-session `ghax bridge control`); cleared by a `stop`.
  desiredControl: ControlTarget | null = null;
  /**
   * Set whenever THIS daemon asks the extension to reload (`sendControl({action:
   * 'reload'})`). The bound peer's socket closing a few seconds later is that
   * reload doing its job, not a rival or a crash — `toDegraded` reads this to
   * log accordingly. Deliberately loose (a few-second window, not a precise
   * ack correlation): the grace/resume machinery downstream doesn't change
   * either way, this only affects what gets logged.
   */
  lastReloadRequestedAt = 0;
  readonly pending = new Map<
    number,
    { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(readonly instanceId: string) {}
}

/**
 * One WebSocket server holding MANY extension connections: one or more
 * `bound` (drivers — exactly one unless the bind filter is `all`) and any
 * number of `parked`.
 *
 * This replaced a "latest connection wins" model that closed the incumbent
 * socket and rejected all its in-flight work. That was wrong twice over: it
 * couldn't tell "my own service worker respawned" from "a second browser
 * connected", and closing the loser's socket kicked its reconnect loop, so
 * two installs would evict each other indefinitely. Identity in the
 * handshake answers *who may drive*; keeping every healthy socket open
 * answers *how the losers stop fighting*.
 *
 * Every session event carries the instanceId it is about, so a daemon driving
 * several browsers can tell them apart. Getters read the ACTIVE session.
 *
 * Emits:
 *   'hello'      (info: BridgeExtensionInfo, instanceId) — a peer bound / resumed
 *   'disconnect' (instanceId)                   — a bound peer's socket dropped
 *   'expired'    (instanceId)                   — its grace window elapsed
 *   'resumed'    (wasInterrupted, instanceId)   — a bound peer is driving again
 *   'event'      (ev: BridgeEvent)              — relayed chrome.debugger.onEvent,
 *                                                 tagged with instanceId + tabId
 *   'controlled' (tabId: number | null, instanceId) — a controlled tab changed,
 *                                                 or `use` switched the active peer
 *   'instances'  ()                             — registry membership changed
 */
export class Bridge extends EventEmitter {
  private wss: WebSocketServer;
  private nextId = 1;
  // Control-channel replies are correlated separately from CDP replies —
  // control messages carry `type:"control-ack"` so they never collide with
  // a `{id,result}` CDP reply in a session's numeric-id `pending` map.
  private controlNextId = 1;
  // The dispatching socket is stored with the resolver: control ids are minted
  // per-daemon, not per-peer, so correlating on the id alone lets ANY connected
  // peer answer a request it never received. `instanceId` scopes the
  // interruption when that one peer drops.
  private controlPending = new Map<
    number,
    { ws: WebSocket; instanceId: string | null; resolve: (v: ControlAck) => void; reject: (e: Error) => void }
  >();
  // ─── Instance registry (plan §2.4) — see bridge-peers.ts ─────
  private readonly registry = new PeerRegistry((m) => this.log(m));
  /** Every bound peer's session, by instanceId. */
  private readonly bound = new Map<string, PeerSession>();
  /** The peer whose tab is the daemon's active page; getters read it. */
  private activeId: string | null = null;
  /**
   * Control target recorded before any session exists (env-driven
   * `--control-active`). The first session to bind takes it; under `all`
   * that is the first bound peer only (plan 12, risks).
   */
  private initialDesiredControl: ControlTarget | null = null;
  /** Non-null → only instances matching (browser or label) may bind; `all` binds every one. */
  private bindFilter: string | null = null;
  private readonly settleMs: number;
  private settleTimer: NodeJS.Timeout | null = null;
  private _selection: BridgeSelection = { state: 'idle' };
  /** Timestamps of bind-ownership changes, for the livelock detector. */
  private bindEvents: number[] = [];
  private livelockWarned = false;
  private livenessTimer: NodeJS.Timeout | null = null;
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

  /** Every CDP command relayed through the extension, by method. */
  readonly cdpStats = new CdpStats();

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
    this.settleMs = opts.settleMs ?? SETTLE_MS;
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

  /** True when the active bound extension is connected and handshaken. */
  get connected(): boolean {
    const s = this.activeSession;
    return s?.state === 'BOUND' && this.peerOf(s)?.ws?.readyState === WebSocket.OPEN;
  }

  get state(): BridgeSessionState {
    return this.activeSession?.state ?? 'UNBOUND';
  }

  get extensionInfo(): BridgeExtensionInfo | null {
    return this.infoOf(this.activePeer);
  }

  /** The tab the active extension reports it's currently driving, or null. */
  get controlledTabId(): number | null {
    return this.activePeer?.controlledTabId ?? null;
  }

  /** Every bound instanceId, active first. */
  get boundIds(): string[] {
    const ids = [...this.bound.keys()];
    return this.activeId && this.bound.has(this.activeId)
      ? [this.activeId, ...ids.filter((id) => id !== this.activeId)]
      : ids;
  }

  private get bindAll(): boolean {
    return this.bindFilter === BIND_ALL;
  }

  private get activeSession(): PeerSession | null {
    return this.activeId ? this.bound.get(this.activeId) ?? null : null;
  }

  private get activePeer(): Peer | null {
    return this.activeId && this.bound.has(this.activeId) ? this.registry.get(this.activeId) ?? null : null;
  }

  private peerOf(s: PeerSession): Peer | null {
    return this.registry.get(s.instanceId) ?? null;
  }

  /**
   * The session a call is for: the named peer, else the active one. A named
   * peer that is not bound is null — never a fallback to the active one.
   */
  private sessionFor(opts?: PeerOpt): PeerSession | null {
    if (opts?.peer !== undefined) return this.bound.get(opts.peer) ?? null;
    return this.activeSession;
  }

  /** The refusal for a call naming a peer that has no session. */
  private notBound(instanceId: string): Error {
    return new Error(`bridge: instance ${this.registry.shortId(instanceId)} is not bound`);
  }

  private infoOf(p: Peer | null): BridgeExtensionInfo | null {
    if (!p) return null;
    const info: BridgeExtensionInfo = { agent: 'ghax-ext', version: p.version };
    if (p.gitSha && p.gitSha !== 'unknown') info.gitSha = p.gitSha;
    if (p.buildDate && p.buildDate !== 'unknown') info.buildDate = p.buildDate;
    return info;
  }

  /**
   * Restrict binding to a browser brand or label, or `all` to bind every
   * candidate. Applied on the next hello.
   */
  setBindFilter(filter: string | null): void {
    this.bindFilter = filter && filter.trim() ? filter.trim().toLowerCase() : null;
  }

  /** First-bind selection outcome — backs `/bridge-status` `selection`. */
  get selection(): BridgeSelection {
    return this._selection;
  }

  /**
   * Close the selection: the matching connected instances to bind (exactly
   * one, or every one under `all`), or record why not. Never takes [0] of
   * several (target-verification rule).
   */
  private decideSelection(): Peer[] {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    const { selection, winners } = this.registry.decide(this.bindFilter, this.port);
    this._selection = selection;
    if (selection.message) this.log(`bridge: ${selection.message}`);
    return winners;
  }

  /** Settle window expired: bind the single candidate (or, under `all`, each). */
  private closeSettle(): void {
    this.settleTimer = null;
    if (this.bound.size > 0 && !this.bindAll) {
      // `bridge use` picked one while we were waiting.
      this._selection = { ...this._selection, state: 'bound' };
      return;
    }
    // A settle close is a selection, not ownership flapping: counting it would
    // trip the livelock warning on any machine with three browsers.
    for (const winner of this.decideSelection()) {
      if (this.bound.has(winner.instanceId)) continue;
      this.bindPeer(winner, 'role', `first-bind after ${this.settleMs}ms settle`, false);
    }
  }

  /** Snapshot of every known instance — backs `ghax bridge instances`. */
  instances(): BridgeInstance[] {
    return this.registry.instances();
  }

  /** Tab-id alias for an instance (see PeerRegistry.aliasOf). */
  aliasOf(instanceId: string): string {
    return this.registry.aliasOf(instanceId);
  }

  /** Identity of the active bound instance, or null when nothing is bound. */
  get boundInstanceId(): string | null {
    return this.activeId;
  }

  /** browser / profile / alias of one instance, for tab listings. */
  identityOf(instanceId: string): { instanceId: string; browser: string; profile: string; alias: string; nonce: string } | null {
    return this.registry.identityOf(instanceId);
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
    const peer = this.registry.forSocket(ws);
    if (!peer || peer.ws !== ws) return; // stale/superseded socket — no-op
    peer.ws = null;
    peer.pinnedAlias = null;
    const session = this.bound.get(peer.instanceId);
    if (!session) {
      // A parked peer went away. Pure bookkeeping; no session is affected.
      this.emit('instances');
      return;
    }
    // A bound peer's socket dropped. Enter ITS grace window instead of
    // failing everything: an MV3 respawn typically reconnects in <1s.
    this.toDegraded(session, 'socket closed');
  }

  private toDegraded(session: PeerSession, reason: string): void {
    if (session.state !== 'BOUND') return;
    session.state = 'DEGRADED';
    const expectedFromReload = Date.now() - session.lastReloadRequestedAt < 5_000;
    const logged = expectedFromReload ? 'reload requested' : reason;
    this.log(`bridge: bound instance ${this.registry.shortId(session.instanceId)} lost (${logged}) — ${this.graceMs}ms grace`);
    // In-flight commands can't be silently retried here: only the operation
    // layer knows whether the verb was a read or a click. Hand them a typed
    // interruption and let runBridgeOperation decide.
    for (const p of session.pending.values()) p.reject(new BridgeInterrupted(p.method, session.instanceId));
    session.pending.clear();
    this.rejectControlPending(session.instanceId, () => new BridgeInterrupted('control', session.instanceId));
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = setTimeout(() => this.toExpired(session), this.graceMs);
    this.emit('disconnect', session.instanceId);
  }

  private toExpired(session: PeerSession): void {
    if (session.state !== 'DEGRADED') return;
    session.state = 'EXPIRED';
    session.graceTimer = null;
    const who = this.registry.describePeer(this.peerOf(session));
    const err = new Error(
      `bridge: extension ${who} did not reconnect within ${this.graceMs}ms. Is the browser running? Check edge://extensions.`,
    );
    (err as any).code = 'BRIDGE_DEGRADED_TIMEOUT';
    this.log(`bridge: grace expired for ${who}`);
    for (const q of session.queue.splice(0)) q.reject(err);
    for (const w of session.resumeWaiters.splice(0)) w.reject(err);
    this.emit('expired', session.instanceId);
    if (this.bindAll) {
      // Under `all` nothing replaces an expired session, so keeping it would
      // grow `bound` by one dead entry per browser ever seen. A return binds
      // fresh (a late hello under `all` joins). Single mode keeps its one
      // EXPIRED session: that state is what lets a rival take over.
      this.bound.delete(session.instanceId);
      const peer = this.peerOf(session);
      if (peer) peer.role = 'parked';
      this.emit('instances');
    }
  }

  /** Reject in-flight control requests dispatched to one instance. */
  private rejectControlPending(instanceId: string, err: () => Error): void {
    for (const [id, p] of this.controlPending) {
      if (p.instanceId !== instanceId) continue;
      this.controlPending.delete(id);
      p.reject(err());
    }
  }

  private checkLiveness(): void {
    for (const session of this.bound.values()) {
      const peer = this.peerOf(session);
      if (session.state !== 'BOUND' || !peer?.ws) continue;
      if (Date.now() - peer.lastFrameAt <= this.livenessMs) continue;
      // Nothing — not even a ping — for LIVENESS_MS. The socket is half-open;
      // terminate so `close` fires deterministically instead of hanging.
      this.log(`bridge: no frames from ${this.registry.describePeer(peer)} for ${this.livenessMs}ms — terminating socket`);
      try {
        peer.ws.terminate();
      } catch {
        // ignore
      }
    }
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
    const peer = this.registry.forSocket(ws);
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
    const session = this.bound.get(peer.instanceId) ?? null;

    // Control traffic is correlated by id and may come from ANY peer — a
    // parked instance answers `list-tabs` so `ghax tabs --browser <x>` can
    // enumerate it without stealing the session.
    if (msg.type === 'controlled') {
      peer.controlledTabId = typeof msg.tabId === 'number' ? msg.tabId : null;
      // Only a driver's tab changing is session-relevant (it clears refs).
      if (session) this.emit('controlled', peer.controlledTabId, peer.instanceId);
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
          instanceId: peer.instanceId,
          ...(msg.result !== undefined ? { result: msg.result } : {}),
        });
        else p.reject(new Error(msg.error || 'bridge: control failed'));
      }
      return;
    }

    // CDP replies and events are session traffic — only BOUND peers drive.
    // A parked peer that somehow sent CDP is ignored, not obeyed.
    if (!session) return;
    if (msg.type === 'event') {
      this.emit('event', {
        method: msg.method,
        params: msg.params ?? {},
        instanceId: peer.instanceId,
        tabId: peer.controlledTabId,
      } as BridgeEvent);
      return;
    }
    if (typeof msg.id === 'number') {
      const p = session.pending.get(msg.id);
      if (!p) return;
      session.pending.delete(msg.id);
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
        if (msg.error.phase === 'dispatch-detached') p.reject(new BridgeInterrupted(p.method, peer.instanceId));
        else p.reject(new Error(msg.error.message || 'bridge command failed'));
      } else p.resolve(msg.result);
      return;
    }
  }

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

  /**
   * Handshake v2. Decides this connection's role and answers with
   * `hello-ack`. Arbitration (plan §2.4): a bind filter makes acceptance
   * identity-scoped; with no filter the first hello binds and later ones
   * park. Parking is non-destructive, so "first wins" is safe — and takeover
   * is always explicit via `use()`. Under `all` (plan 12) a late hello binds
   * alongside the others instead of parking.
   */
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
    const { peer, restarted } = this.registry.upsertFromHello(msg, ws);
    if (restarted) this.emit('peer-restart', peer.instanceId);

    const isResume = this.bound.has(peer.instanceId);
    const noBoundPeer = this.bound.size === 0;
    // A rival may take the session only once the incumbent is genuinely gone,
    // and the GRACE TIMER is what decides that: EXPIRED, or nothing bound yet.
    // DEGRADED must not qualify — the bound peer's `ws` is null for the whole
    // grace window (handleClose nulls it), so admitting that condition meant a
    // routine MV3 service-worker respawn was an open door: any other install
    // reconnecting first took the session and demoted the returning incumbent
    // to parked, mid-drive. Takeover inside the window stays explicit: `use()`.
    const boundGone = !noBoundPeer && !isResume && this.activeSession?.state === 'EXPIRED';
    const matches = this.registry.matchesFilter(peer, this.bindFilter);

    let role: PeerRole;
    let reason: string;
    // Peers other than this one picked by a zero-length settle window.
    let promote: Peer[] = [];
    // A selection decision binding several at once is not flapping.
    let countBind = true;
    if (isResume) {
      role = 'bound';
      reason = 'resume';
    } else if (this.bindAll && !noBoundPeer && !this.settleTimer) {
      // Multi-bind: nobody is displaced, so a late browser simply joins.
      role = 'bound';
      reason = 'bind-all';
    } else if (!this.bindAll && boundGone && matches) {
      role = 'bound';
      // A takeover reads exactly like a first bind in the log otherwise, which
      // is how "the session moved" hid behind "an extension connected".
      reason = `takeover — ${this.registry.describePeer(this.activePeer)} never came back`;
    } else if (noBoundPeer && this._selection.state === 'ambiguous') {
      role = 'parked';
      reason = 'selection is ambiguous, waiting for `ghax bridge use`';
    } else if ((noBoundPeer || this.settleTimer) && this.settleMs > 0) {
      // First-bind selection: everyone parks until the window closes, then
      // closeSettle promotes the candidate(s) over their live sockets.
      role = 'parked';
      reason = `settling ${this.settleMs}ms`;
      if (this._selection.state !== 'settling' && !this.settleTimer) {
        this._selection = { state: 'settling', filter: this.bindFilter };
        this.settleTimer = setTimeout(() => this.closeSettle(), this.settleMs);
        this.settleTimer.unref?.();
      }
    } else if (noBoundPeer) {
      const winners = this.decideSelection();
      const picked = winners.includes(peer);
      role = picked ? 'bound' : 'parked';
      promote = winners.filter((w) => w !== peer);
      if (this.bindAll) countBind = false;
      reason = picked ? 'first-bind' : (this._selection.message ?? 'not selected');
    } else {
      role = 'parked';
      reason = matches
        ? `${this.registry.describePeer(this.activePeer)} is bound`
        : `does not match --browser ${this.bindFilter}`;
    }
    this.log(
      `bridge: hello ${this.registry.describePeer(peer)} v${peer.version} → ${role} (${reason})`,
    );

    if (role === 'parked') {
      peer.role = 'parked';
      this.rawSend(ws, {
        type: 'hello-ack', role: 'parked', daemonId: this.daemonId, graceMs: this.graceMs,
      });
      this.emit('instances');
      for (const p of promote) this.bindPeer(p, 'role', 'first-bind', countBind);
      return;
    }
    this.bindPeer(peer, 'hello-ack', reason, countBind);
    for (const p of promote) this.bindPeer(p, 'role', 'first-bind', countBind);
  }

  /**
   * Make `peer` a driver: hello-time (`hello-ack`) or a promotion of an
   * already-parked socket after the settle window (`role`, same wire shape
   * `use()` sends — the extension treats both identically).
   *
   * Single-browser mode replaces the session of an EXPIRED incumbent
   * (takeover), carrying its desired control across as before. Under `all`
   * every bound peer keeps its own session.
   */
  private bindPeer(peer: Peer, via: 'hello-ack' | 'role', reason: string, countBind = true): void {
    const instanceId = peer.instanceId;
    if (this.bindAll && peer.legacy) {
      // A pre-identity extension gets a fresh synthetic id on every hello, so
      // under `all` each reconnect would bind (and leak) a new session.
      this.log(
        `bridge: refusing to bind ${this.registry.describePeer(peer)} under --browser all: its extension predates `
        + 'instance ids. Reload the ghax bridge extension in that browser (edge://extensions or chrome://extensions).',
      );
      peer.role = 'parked';
      if (via === 'hello-ack') {
        this.rawSend(peer.ws, { type: 'hello-ack', role: 'parked', daemonId: this.daemonId, graceMs: this.graceMs });
      }
      this.emit('instances');
      return;
    }
    if (via === 'role') this.log(`bridge: bound → ${this.registry.describePeer(peer)} (${reason})`);
    let session = this.bound.get(instanceId);
    const ownershipChanged = !session;
    if (!session) {
      session = new PeerSession(instanceId);
      if (!this.bindAll) {
        // At most one session outside `all`: the one being replaced here is an
        // expired incumbent (handleHello only takes over after the grace
        // window), whose queue and waiters were already failed at expiry.
        for (const old of this.bound.values()) {
          session.desiredControl = old.desiredControl;
          if (old.graceTimer) clearTimeout(old.graceTimer);
        }
        this.bound.clear();
      }
      if (this.initialDesiredControl) {
        session.desiredControl = this.initialDesiredControl;
        this.initialDesiredControl = null;
      }
      this.bound.set(instanceId, session);
    }
    if (!this.bindAll || this.activeId === null || !this.bound.has(this.activeId)) {
      this.activeId = instanceId;
    }
    peer.role = 'bound';
    if (this._selection.state !== 'bound') this._selection = { ...this._selection, state: 'bound' };
    if (!session.sessionToken || ownershipChanged) {
      session.sessionToken = crypto.randomBytes(16).toString('hex');
    }
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }
    const wasInterrupted = session.state !== 'BOUND';
    session.state = 'BOUND';
    if (ownershipChanged && countBind) this.noteBindChange();

    this.rawSend(peer.ws, {
      type: via,
      role: 'bound',
      // Identity of the DAEMON, not the port: the extension hands back any tab
      // it was driving for a different daemon before it starts driving for this
      // one. See the `daemonId` field.
      daemonId: this.daemonId,
      sessionToken: session.sessionToken,
      graceMs: this.graceMs,
    });
    this.emit('hello', this.infoOf(peer), instanceId);
    this.emit('instances');

    // Resume order matters (plan §2.2): re-assert control and AWAIT its ack
    // before anything queued is allowed to run, so replayed work can't land
    // on a tab the respawned worker hasn't re-attached yet.
    void this.resumeSequence(session, wasInterrupted);
  }

  private async resumeSequence(session: PeerSession, wasInterrupted: boolean): Promise<void> {
    try {
      if (session.desiredControl && session.desiredControl.action !== 'stop') {
        await this.sendControl(session.desiredControl, CONTROL_TIMEOUT_MS, { peer: session.instanceId });
      }
      this.emit('resumed', wasInterrupted, session.instanceId);
      for (const w of session.resumeWaiters.splice(0)) w.resolve();
      this.flushQueue(session);
    } catch (e) {
      this.log(`bridge: re-assert control failed: ${String(e)}`);
      // Control didn't come back; let the grace timer keep running rather
      // than flushing work at a tab we don't actually own.
      for (const w of session.resumeWaiters.splice(0)) {
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

  private flushQueue(session: PeerSession): void {
    if (session.state !== 'BOUND') return;
    const now = Date.now();
    for (const q of session.queue.splice(0)) {
      if (q.deadline <= now) {
        q.reject(new Error(`bridge: ${q.method} timed out while the extension was reconnecting`));
        continue;
      }
      this.dispatch(session, q.method, q.params, q.deadline - now).then(q.resolve, q.reject);
    }
  }

  /**
   * Resolve when the peer (default: active) is BOUND again (immediately if it
   * already is), reject if its grace window expires first. The operation
   * layer awaits this before replaying a `safe` verb.
   */
  waitForResume(opts?: PeerOpt): Promise<void> {
    const session = this.sessionFor(opts);
    if (session?.state === 'BOUND') return Promise.resolve();
    if (!session || session.state === 'UNBOUND' || session.state === 'EXPIRED') {
      return Promise.reject(new Error('ghax bridge: no extension connected.'));
    }
    return new Promise((resolve, reject) => session.resumeWaiters.push({ resolve, reject }));
  }

  /**
   * The replay gate for an interrupted `safe` verb: resolve once the peer the
   * command was in flight on is driving again AND is still the active one.
   */
  async waitForResumeOf(err: BridgeInterrupted, verb: string): Promise<void> {
    const origin = err.instanceId;
    if (origin === null) return this.waitForResume();
    const refuseIfMoved = () => {
      if (this.activeId === origin) return;
      const from = this.registry.describePeer(this.registry.get(origin) ?? null);
      const now = this.activeId ? this.registry.describePeer(this.activePeer) : 'none';
      const e = new Error(
        `${verb}: the bridge connection to ${from} dropped mid-command and the active browser is now ${now}. `
        + `Not replaying on a different browser; re-run the command.`,
      );
      (e as any).code = 'BRIDGE_PEER_CHANGED';
      throw e;
    };
    refuseIfMoved();
    if (!this.bound.has(origin)) {
      throw new Error(`${verb}: instance ${this.registry.shortId(origin)} is no longer bound; re-run the command.`);
    }
    await this.waitForResume({ peer: origin });
    // `use` may have moved the active peer while we waited.
    refuseIfMoved();
  }

  /**
   * Resolve on the next `hello` from one instance (a `bridge reload` waiting
   * for the browser it reloaded), reject after `timeoutMs`.
   */
  waitForHello(instanceId: string, timeoutMs: number): Promise<BridgeExtensionInfo> {
    return new Promise<BridgeExtensionInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('hello', onHello);
        reject(new Error(`bridge: instance did not reconnect within ${timeoutMs}ms`));
      }, timeoutMs);
      const onHello = (info: BridgeExtensionInfo | null, from: string) => {
        if (from !== instanceId) return;
        clearTimeout(timer);
        this.off('hello', onHello);
        resolve(info ?? { agent: 'ghax-ext', version: '?' });
      };
      this.on('hello', onHello);
    });
  }

  /**
   * Send one CDP command to a bound extension's controlled tab (default:
   * the active peer).
   *
   * BOUND     → dispatched now.
   * DEGRADED  → QUEUED (the caller sees latency, not an error, if the
   *             extension returns inside the grace window). The command still
   *             honours its OWN deadline: a 20s session grace must never turn
   *             a 5s command into a 20s hang.
   * otherwise → rejected immediately with install guidance.
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    opts?: PeerOpt,
  ): Promise<unknown> {
    // Counted here rather than in dispatch() so a command queued while
    // DEGRADED is counted once, with the reconnect wait included in its time.
    return this.cdpStats.track(method, this.sendUntracked(method, params, timeoutMs, opts));
  }

  /** Per-method relayed-call counters since start or the last reset. */
  stats(): CdpStatsSnapshot {
    return this.cdpStats.snapshot();
  }

  resetStats(): void {
    this.cdpStats.reset();
  }

  private sendUntracked(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    opts?: PeerOpt,
  ): Promise<unknown> {
    const session = this.sessionFor(opts);
    if (!session && opts?.peer !== undefined) return Promise.reject(this.notBound(opts.peer));
    if (session?.state === 'BOUND') return this.dispatch(session, method, params, timeoutMs);
    if (session?.state === 'DEGRADED') {
      if (session.queue.length >= QUEUE_CAP) {
        return Promise.reject(new Error('bridge: too many commands queued while the extension reconnects'));
      }
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const entry: QueuedCommand = { method, params, deadline, resolve, reject };
        session.queue.push(entry);
        setTimeout(() => {
          const i = session.queue.indexOf(entry);
          if (i >= 0) {
            session.queue.splice(i, 1);
            reject(new Error(`bridge: ${method} timed out after ${timeoutMs}ms (extension reconnecting)`));
          }
        }, timeoutMs).unref?.();
      });
    }
    // An unresolved selection is the more useful answer than "load the
    // extension": the browsers ARE connected, the daemon just won't guess.
    const sel = this._selection;
    if (!session && sel.message && (sel.state === 'ambiguous' || sel.state === 'no-candidate')) {
      return Promise.reject(new Error(`ghax bridge: ${sel.message}`));
    }
    return Promise.reject(
      new Error(
        'ghax bridge: no extension connected. Load extension/ unpacked, then click "Control this tab" in the ghax bridge popup.',
      ),
    );
  }

  private dispatch(
    session: PeerSession,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const ws = this.peerOf(session)?.ws;
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
        session.pending.delete(id);
        reject(new Error(`bridge: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      session.pending.set(id, {
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
        session.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Resolve a selector to exactly one known peer, or throw. Never picks by
   * arrival order (target-verification rule): more than one match is a
   * refusal that lists every candidate so the caller can name one precisely.
   */
  private matchOne(selector: string): Peer {
    const matches = this.registry.match(selector);
    if (matches.length === 0) {
      const known = this.instances().map((i) => `${i.browser}·${i.instanceId.slice(0, 6)}`).join(', ') || 'none';
      throw new Error(`bridge: no instance matching '${selector}'. Known instances: ${known}`);
    }
    if (matches.length > 1) {
      const rows = matches
        .map((p) => `  ${p.browser} · ${p.label || '-'} · ${p.instanceId} · :${this.port}`)
        .join('\n');
      throw new Error(
        `bridge: '${selector}' matches ${matches.length} instances; use an instanceId (or a unique prefix) or a distinct label:\n${rows}`,
      );
    }
    return matches[0];
  }

  /**
   * Rebind to a different instance by id, browser brand, or label. Uses the
   * `role` message so demotion/promotion happens over LIVE sockets — no
   * disconnect, so neither side re-enters a reconnect loop.
   *
   * Under `all` nobody is demoted: this only moves which bound peer is active.
   */
  async use(selector: string): Promise<BridgeInstance> {
    const target = this.matchOne(selector);
    if (target.ws?.readyState !== WebSocket.OPEN) {
      throw new Error(`bridge: instance ${this.registry.describePeer(target)} is not connected`);
    }
    const describe = () => this.instances().find((i) => i.instanceId === target.instanceId)!;
    if (target.instanceId === this.activeId && this.bound.has(target.instanceId)) return describe();

    if (this.bindAll) {
      if (target.legacy) {
        throw new Error(
          `bridge: ${this.registry.describePeer(target)} predates instance ids and cannot bind under --browser all. `
          + 'Reload the ghax bridge extension in that browser.',
        );
      }
      // A peer that joined while unbindable (e.g. its hello raced a settle
      // close) binds here; one already bound just becomes the active one.
      if (!this.bound.has(target.instanceId)) this.bindPeer(target, 'role', 'bridge use');
      this.activeId = target.instanceId;
      if (!this.settleTimer) this._selection = { ...this._selection, state: 'bound' };
      this.log(`bridge: active → ${this.registry.describePeer(target)}`);
      // Tab ids are per-browser, so refs MUST die on the switch — the
      // 'controlled' emit reuses the existing ref-clearing path (invariant 3).
      this.emit('controlled', target.controlledTabId, target.instanceId);
      this.emit('instances');
      return describe();
    }

    const previous = this.activeSession;
    const previousPeer = this.activePeer;
    if (previousPeer?.ws) {
      previousPeer.role = 'parked';
      this.rawSend(previousPeer.ws, { type: 'role', role: 'parked', daemonId: this.daemonId });
    }
    // Drop session state tied to the old instance. Tab ids are per-browser,
    // so refs MUST die here — the 'controlled' emit reuses the existing
    // ref-clearing path (CLAUDE.md invariant 3) for free.
    if (previous) {
      for (const p of previous.pending.values()) p.reject(new BridgeInterrupted(p.method, previous.instanceId));
      previous.pending.clear();
      // Control requests belong to the instance they were dispatched to just as
      // much as CDP does: a late ack arriving after the session moved would
      // answer for a browser that is no longer the one being driven.
      this.rejectControlPending(previous.instanceId, () => new Error('bridge: rebound to a different instance'));
      for (const q of previous.queue.splice(0)) q.reject(new Error('bridge: rebound to a different instance'));
      for (const w of previous.resumeWaiters.splice(0)) w.reject(new Error('bridge: rebound to a different instance'));
      if (previous.graceTimer) clearTimeout(previous.graceTimer);
    }
    this.bound.clear();
    this.initialDesiredControl = null;

    const session = new PeerSession(target.instanceId);
    session.state = 'BOUND';
    session.sessionToken = crypto.randomBytes(16).toString('hex');
    this.bound.set(target.instanceId, session);
    this.activeId = target.instanceId;
    target.role = 'bound';
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this._selection = { ...this._selection, state: 'bound' };
    this.noteBindChange();
    this.rawSend(target.ws, {
      type: 'role', role: 'bound', daemonId: this.daemonId, sessionToken: session.sessionToken,
    });
    this.log(`bridge: bound → ${this.registry.describePeer(target)}`);
    this.emit('controlled', target.controlledTabId, target.instanceId);
    this.emit('instances');
    return describe();
  }

  /** Apply a control target to what gets re-asserted on the next resume. */
  private recordDesired(session: PeerSession | null, target: ControlTarget): void {
    let next: ControlTarget | null | undefined;
    if (target.action === 'stop') next = null;
    else if (target.action === 'control-active') next = target;
    else if (target.action === 'control-tab') next = { ...target, quiet: true };
    if (next === undefined) return;
    if (session) session.desiredControl = next;
    else this.initialDesiredControl = next;
  }

  /**
   * Remember a desired control target WITHOUT sending it now — used for
   * env-driven initial control (`GHAX_BRIDGE_CONTROL=active`) set before the
   * extension has connected. The `hello` handler sends it once the
   * extension is live. With no session yet it waits for the first bind.
   */
  setDesiredControl(target: ControlTarget, opts?: PeerOpt): void {
    const session = this.sessionFor(opts);
    if (!session && opts?.peer !== undefined) throw this.notBound(opts.peer);
    const next = target.action === 'stop' ? null : target;
    if (session) session.desiredControl = next;
    else if (opts?.peer === undefined) this.initialDesiredControl = next;
  }

  /**
   * Send a control message to a bound extension (default: the active one) and
   * await its `control-ack`. Also records the target as that session's
   * `desiredControl` (except `stop`, which clears it) so it's re-asserted on
   * the next reconnect. Rejects if no extension is connected, or after
   * `CONTROL_TIMEOUT_MS`.
   */
  sendControl(target: ControlTarget, timeoutMs = CONTROL_TIMEOUT_MS, opts?: PeerOpt): Promise<ControlAck> {
    const session = this.sessionFor(opts);
    if (!session && opts?.peer !== undefined) return Promise.reject(this.notBound(opts.peer));
    this.recordDesired(session, target);
    // Deliberately NOT `desiredControl` — a reload must not become "what to
    // re-assert on the next resume". Leaving desiredControl untouched means
    // resumeSequence re-asserts whatever tab was ACTUALLY being driven before
    // the reload, exactly like recovering from an ordinary SW eviction.
    if (target.action === 'reload' && session) session.lastReloadRequestedAt = Date.now();
    const ws = session ? this.peerOf(session)?.ws : null;
    if (!session || !ws || ws.readyState !== WebSocket.OPEN || session.state !== 'BOUND') {
      return Promise.reject(
        new Error(
          'ghax bridge: no extension connected. Load extension/ unpacked (the ghax bridge extension) and make sure the browser is running.',
        ),
      );
    }
    return this.dispatchControl(ws, session.instanceId, target, timeoutMs);
  }

  /**
   * Send a control message to a SPECIFIC instance, bound or parked.
   *
   * Only safe for control actions that don't require a debugger attachment —
   * `list-tabs` is the motivating case (`ghax tabs --browser chrome`), since
   * `chrome.tabs.query` needs no attachment. Do NOT route attach-requiring
   * actions here: a parked peer deliberately holds no attachment.
   *
   * A selector matching no instance, or more than one, is refused — never
   * routed to the first match.
   */
  sendControlToInstance(
    selector: string,
    target: ControlTarget,
    timeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<ControlAck> {
    let peer: Peer;
    try {
      peer = this.matchOne(selector);
    } catch (err) {
      return Promise.reject(err);
    }
    if (peer.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`bridge: instance ${this.registry.describePeer(peer)} is not connected`));
    }
    return this.dispatchControl(peer.ws, peer.instanceId, target, timeoutMs);
  }

  private dispatchControl(
    ws: WebSocket,
    instanceId: string | null,
    target: ControlTarget,
    timeoutMs: number,
  ): Promise<ControlAck> {
    const id = this.controlNextId++;
    return new Promise<ControlAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlPending.delete(id);
        reject(new Error(`bridge: control(${target.action}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.controlPending.set(id, {
        ws,
        instanceId,
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

  /**
   * Subscribe to a session event, delivered only while it is about the ACTIVE
   * peer. Daemon state (refs, main frame, contexts, buffers, active tab) is
   * single-session until plan 12 brief B, so another bound peer's traffic must
   * not reach it. Returns an unsubscribe function.
   */
  onActive(name: 'event' | 'controlled' | 'hello', listener: (...args: any[]) => void): () => void {
    const wrapped = (...args: any[]) => {
      const id = name === 'event' ? (args[0] as BridgeEvent | undefined)?.instanceId : args[1];
      if (id === this.activeId) listener(...args);
    };
    this.on(name, wrapped);
    return () => this.off(name, wrapped);
  }

  /** Subscribe to relayed CDP events. Returns an unsubscribe function. */
  onEvent(listener: (ev: BridgeEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  close(): void {
    const err = new Error('bridge: shutting down');
    for (const session of this.bound.values()) {
      for (const p of session.pending.values()) p.reject(err);
      session.pending.clear();
      for (const q of session.queue.splice(0)) q.reject(err);
      for (const w of session.resumeWaiters.splice(0)) w.reject(err);
      if (session.graceTimer) clearTimeout(session.graceTimer);
    }
    for (const p of this.controlPending.values()) p.reject(err);
    this.controlPending.clear();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    for (const peer of this.registry.all()) {
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
  opts: { uniqueContextId?: string | null; contextId?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const params: Record<string, unknown> = {
    expression,
    awaitPromise: true,
    returnByValue: true,
  };
  if (opts.uniqueContextId) params.uniqueContextId = opts.uniqueContextId;
  else if (typeof opts.contextId === 'number') params.contextId = opts.contextId;
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
  // Chrome refuses extension-initiated top-level navigation to data: URLs,
  // through chrome.debugger's Page.navigate and chrome.tabs.update alike. The
  // navigation never commits, the extension's load watcher times out after
  // 8 s, and the old tab came back looking like a successful goto. Fail up
  // front with the reason instead.
  if (/^\s*data:/i.test(url)) {
    throw new BridgeTypedError(
      `goto: the bridge can't open data: URLs (Chrome blocks extension-initiated navigation to data:)`,
      'BRIDGE_NAVIGATION_BLOCKED',
      'serve the page over http (e.g. a local server on 127.0.0.1), or load a normal page and set its content with `ghax eval`',
    );
  }
  const navigation = await bridge.send('Page.navigate', {
    url,
    ghaxLoadTimeoutMs: loadTimeoutMs,
  }) as { ghaxFinalUrl?: string; ghaxTitle?: string; errorText?: string } | undefined;
  // Page.navigate reports a refused or failed navigation in errorText rather
  // than rejecting; passing it through as success hid real failures.
  if (navigation?.errorText) {
    throw new BridgeTypedError(
      `goto: navigation to ${url} failed: ${navigation.errorText}`,
      'BRIDGE_NAVIGATION_FAILED',
      'check the URL; the tab is still on its previous page',
    );
  }

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

// ─── ghax's own isolated world (review finding 6) ──────────────────
//
// The cursor-ref registry, root selection, selector resolution and the
// click/upload actionability guard run in a ghax-owned isolated world, not
// the page's main world. There the page cannot squat `window.__ghax`, and a
// page that overrides getBoundingClientRect / elementsFromPoint / querySelector
// in its own world cannot move ghax's click point or hide an overlay from
// the hit test: isolated worlds share the DOM but not JS prototypes. One
// world per document: created on first use, forgotten on main-frame
// navigation, context teardown, or a control change, and re-created once if
// CDP says the context is gone. Fill stays in the main world on purpose: it
// needs the page's own `monaco` global.

interface WorldState { contextId: number | null }
const worlds = new WeakMap<Bridge, WorldState>();

function worldState(bridge: Bridge): WorldState {
  let st = worlds.get(bridge);
  if (st) return st;
  const state: WorldState = { contextId: null };
  worlds.set(bridge, state);
  bridge.onActive('event', (ev: BridgeEvent) => {
    const p = ev.params as { executionContextId?: unknown; frame?: { parentId?: unknown } };
    if (ev.method === 'Runtime.executionContextsCleared') state.contextId = null;
    else if (ev.method === 'Runtime.executionContextDestroyed' && p.executionContextId === state.contextId) state.contextId = null;
    else if (ev.method === 'Page.frameNavigated' && !p.frame?.parentId) state.contextId = null;
  });
  bridge.onActive('controlled', () => { state.contextId = null; });
  bridge.on('disconnect', () => { state.contextId = null; });
  return state;
}

/** The execution context id of ghax's isolated world in the controlled tab. */
export async function bridgeIsolatedWorld(bridge: Bridge): Promise<number> {
  const st = worldState(bridge);
  if (st.contextId !== null) return st.contextId;
  const tree = await bridge.send('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } };
  const frameId = tree.frameTree?.frame?.id;
  if (!frameId) throw new Error('bridge: no main frame to create the ghax isolated world in');
  const res = await bridge.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'ghax',
    grantUniveralAccess: true,
  }) as { executionContextId?: number };
  if (typeof res.executionContextId !== 'number') {
    throw new Error('bridge: Page.createIsolatedWorld returned no execution context');
  }
  st.contextId = res.executionContextId;
  return st.contextId;
}

/** Run `fn` in the isolated world, re-creating it once if it went stale. */
async function inWorld<T>(bridge: Bridge, fn: (contextId: number) => Promise<T>): Promise<T> {
  try {
    return await fn(await bridgeIsolatedWorld(bridge));
  } catch (err) {
    if (!isStaleContextError(err)) throw err;
    worldState(bridge).contextId = null;
    return await fn(await bridgeIsolatedWorld(bridge));
  }
}

async function runtimeObjectFor(
  bridge: Bridge,
  expression: string,
  contextId?: number,
): Promise<{ objectId: string; backendNodeId: number; nodeName: string } | null> {
  const evaluated = await bridge.send('Runtime.evaluate', {
    expression,
    returnByValue: false,
    ...(typeof contextId === 'number' ? { contextId } : {}),
  }) as { result?: { objectId?: string; subtype?: string } };
  const objectId = evaluated.result?.objectId;
  if (!objectId || evaluated.result?.subtype === 'null') return null;
  try {
    const described = await bridge.send('DOM.describeNode', { objectId }) as {
      node?: { backendNodeId?: number; nodeName?: string };
    };
    const backendNodeId = described.node?.backendNodeId;
    return typeof backendNodeId === 'number'
      ? { objectId, backendNodeId, nodeName: String(described.node?.nodeName ?? '') }
      : null;
  } catch {
    await bridge.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
    return null;
  }
}

/**
 * Page-side cursor-ref registry, installed once per document. Elements get a
 * stable numeric id from a WeakMap (so re-snapshots reuse it) and live in
 * `nodes` until they disconnect. Ported from jev-ultrafast's snapshot.js.
 */
const CURSOR_REGISTRY_JS = `const reg = (window.__ghax ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  for (const [id, e] of reg.nodes) if (!e.isConnected) reg.nodes.delete(id);
  const cursorId = (e) => {
    let id = reg.ids.get(e);
    if (id === undefined) { id = reg.next++; reg.ids.set(e, id); }
    reg.nodes.set(id, e);
    return id;
  };`;

/**
 * Build the bridge snapshot from Chromium's own accessibility tree.
 *
 * Cost is a constant number of relayed CDP calls however large the page is
 * (three domain enables, one evaluate + describeNode + release for the root,
 * one getFullAXTree, one cursor-pass evaluate): the old version tagged every
 * ref in the DOM (`data-ghax-ref`, two calls per ref) and read every cursor
 * ref back (three more each). Refs resolve from the backend node id (AX) or
 * the page-side registry (cursor) only when a verb acts on them. The
 * `data-ghax-ref` attribute is gone; `ghax box @eN` answers "which element
 * is this" instead.
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
    /**
     * Ref numbering (src/ref-registry.ts): the daemon passes its registry
     * bound to the current document, so a number is never reused. Omitted =
     * a private registry numbering from e1.
     */
    refs?: RefAllocator;
  } = {},
): Promise<BridgeSnapshotResult> {
  const allocator = opts.refs ?? new RefRegistry().forDoc('local');
  await bridge.send('Runtime.enable');
  await bridge.send('DOM.enable');
  await bridge.send('Accessibility.enable');

  // Root selection in ONE evaluate: --selector, else the top-most visible
  // modal (unless --no-dialog-scope), else body.
  const selectorJs = opts.selector ? JSON.stringify(opts.selector) : 'null';
  const root = await inWorld(bridge, (cid) => runtimeObjectFor(bridge, `(() => {
    const sel = ${selectorJs};
    if (sel) return document.querySelector(sel);
    if (${opts.dialogScope !== false}) {
      const selectors = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]';
      const visible = [...document.querySelectorAll(selectors)].filter((el) => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (visible.length) return visible.at(-1);
    }
    return document.body;
  })()`, cid));
  if (!root && opts.selector) throw new Error(`Selector not found: ${opts.selector}`);
  const rootBackendNodeId = root ? root.backendNodeId : null;
  // Anything but <body> means --selector or a modal won: not the whole page.
  const scoped = Boolean(opts.selector) || (root !== null && root.nodeName.toUpperCase() !== 'BODY');
  if (root) void bridge.send('Runtime.releaseObject', { objectId: root.objectId }).catch(() => undefined);

  const result = await bridge.send('Accessibility.getFullAXTree', {}) as { nodes?: AxNode[] };
  const nodes = result.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  let axRoot = rootBackendNodeId === null
    ? undefined
    : nodes.find((n) => n.backendDOMNodeId === rootBackendNodeId);
  axRoot ??= nodes.find((n) => !n.parentId) ?? nodes[0];

  const refs = new Map<string, BridgeRef>();
  const output: string[] = [];
  // A node keeps its ref while role and name hold (Playwright's rule); the
  // registry never hands the same number to a different element.
  const refFor = (backendNodeId: number, role: string, name: string): string =>
    allocator.assign('e', `b${backendNodeId}`, role, name);
  const walk = (node: AxNode, depth: number): void => {
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
        const ref = refFor(node.backendDOMNodeId, role, name);
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
      if (child) walk(child, skipStructural ? depth : depth + 1);
    }
  };
  if (axRoot) walk(axRoot, -1);
  const alive = new Set<string>();
  for (const n of nodes) if (typeof n.backendDOMNodeId === 'number') alive.add(`b${n.backendDOMNodeId}`);

  const wantCursor = opts.cursorInteractive || (opts.interactive && !opts.compact);
  if (wantCursor) {
    const cursor = await inWorld(bridge, (contextId) => bridgeEvaluate(bridge, `(() => {
      ${CURSOR_REGISTRY_JS}
      const standard = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','DETAILS']);
      const out = [];
      const walk = (root, inShadow) => {
        for (const el of root.querySelectorAll('*')) {
          const style = getComputedStyle(el);
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
          const tabindex = el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0;
          if (visible && !standard.has(el.tagName) && !el.hasAttribute('role') &&
              (style.cursor === 'pointer' || el.hasAttribute('onclick') || tabindex)) {
            const reasons = [];
            if (inShadow) reasons.push('shadow');
            if (style.cursor === 'pointer') reasons.push('cursor:pointer');
            if (el.hasAttribute('onclick')) reasons.push('onclick');
            if (tabindex) reasons.push('tabindex=' + el.getAttribute('tabindex'));
            out.push({ cursorId: cursorId(el), text: (el.innerText || el.tagName.toLowerCase()).trim().slice(0, 80), reason: reasons.join(', ') });
          }
          if (el.shadowRoot) walk(el.shadowRoot, true);
        }
      };
      walk(document, false);
      return out;
    })()`, { contextId })) as Array<{ cursorId: number; text: string; reason: string }>;
    if (cursor.length > 0) {
      output.push('', '── cursor-interactive (not in ARIA tree) ──');
      cursor.forEach((item) => {
        // The page registry id is stable per element but restarts at 1 in a
        // new document, so it is a key, never the printed number.
        alive.add(`k${item.cursorId}`);
        const ref = allocator.assign('c', `k${item.cursorId}`, 'cursor-interactive', item.text);
        refs.set(ref, { backendNodeId: null, cursorId: item.cursorId, role: 'cursor-interactive', name: item.text });
        output.push(`@${ref} [${item.reason}] ${JSON.stringify(item.text)}`);
      });
    }
  }

  // Forget nodes that left the document. getFullAXTree is the whole page
  // even for a modal-scoped walk, but a --selector snapshot is left alone so
  // a narrow look never costs refs from the wider one (settled decision 5).
  if (!opts.selector) allocator.prune(alive);

  if (output.length === 0) {
    return {
      text: opts.interactive ? '(no interactive elements found)' : '(no accessible elements found)',
      refs,
      count: 0,
      scoped,
    };
  }
  return { text: output.join('\n'), refs, count: refs.size, scoped };
}

/**
 * Does the node behind an AX ref still have the role and name it was
 * printed with? One `Accessibility.getPartialAXTree` call; cursor refs
 * (no backend id) are not rechecked.
 */
export async function bridgeRefStillMatches(bridge: Bridge, ref: BridgeRef): Promise<boolean> {
  if (ref.backendNodeId === null) return true;
  const res = await bridge.send('Accessibility.getPartialAXTree', {
    backendNodeId: ref.backendNodeId,
    fetchRelatives: false,
  }) as { nodes?: AxNode[] };
  const node = (res.nodes ?? []).find((n) => n.backendDOMNodeId === ref.backendNodeId) ?? res.nodes?.[0];
  if (!node || node.ignored) return false;
  const rawRole = String(node.role?.value ?? '');
  const name = rawRole === 'StaticText' || rawRole === 'LineBreak' ? '' : String(node.name?.value ?? '');
  return axRole(node) === ref.role && name === ref.name;
}

/** Resolve a normal CSS selector to the same backend-node handle refs use. */
export async function bridgeResolveSelector(bridge: Bridge, selector: string): Promise<BridgeRef> {
  const object = await inWorld(bridge, (cid) => runtimeObjectFor(bridge, `document.querySelector(${JSON.stringify(selector)})`, cid));
  if (!object) throw new Error(`Selector not found: ${selector}`);
  await bridge.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
  return { backendNodeId: object.backendNodeId, role: '', name: '' };
}

// ─── Typed action errors (plan 10, C5) ──────────────────────────────

/**
 * An error with a machine-readable `code` and a recovery `hint`, thrown by
 * the helpers below and passed through the daemon's bridge error wrapper
 * untouched. `details` rides along in the RPC envelope.
 */
export class BridgeTypedError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** What CDP says when a backend node id no longer maps to a live node. */
const STALE_NODE_RE = /no node with given id|could not find node|does not belong to the document|node with given id does not exist/i;

export function isStaleNodeError(err: unknown): boolean {
  return STALE_NODE_RE.test((err as { message?: string } | null)?.message ?? String(err));
}

export function staleRefError(label: string): BridgeTypedError {
  const hint = label.startsWith('@')
    ? `the element behind ${label} is gone (re-render or navigation). Run 'ghax snapshot -i' and use a fresh ref.`
    : `the element matched by ${label} is gone (re-render or navigation). Re-run the command.`;
  return new BridgeTypedError(`${label}: element is gone`, 'BRIDGE_REF_STALE', hint);
}

const NOT_ACTIONABLE_HINTS: Record<string, (r: ActionabilityResult) => string> = {
  covered: (r) => `something is on top of it (${r.coveredBy ?? 'unknown'}): dismiss it, click that instead, or pass --force`,
  disabled: () => 'it is disabled; wait for it to enable or pick another ref',
  inert: () => 'it sits inside an inert subtree (usually behind an open modal); close the modal or pick another ref',
  readonly: () => 'it is read-only; pick an editable field or pass --force',
  hidden: () => 're-snapshot; it is not visible at its current position',
  offscreen: () => 're-snapshot; it is not visible at its current position',
  detached: () => "re-snapshot with 'ghax snapshot -i'; the element left the document",
};

export function notActionableError(label: string, kind: string, r: ActionabilityResult): BridgeTypedError {
  const reason = r.reason ?? 'unknown';
  const what = r.retargeted ? `${label} (via ${r.retargeted})` : label;
  const msg = reason === 'covered'
    ? `${kind} ${what}: covered by ${r.coveredBy ?? 'another element'}`
    : `${kind} ${what}: not actionable (${reason})`;
  const hint = (NOT_ACTIONABLE_HINTS[reason] ?? (() => 'pass --force to act anyway'))(r);
  return new BridgeTypedError(msg, 'BRIDGE_TARGET_NOT_ACTIONABLE', hint, {
    reason,
    ...(r.coveredBy ? { coveredBy: r.coveredBy } : {}),
    ...(r.retargeted ? { retargeted: r.retargeted } : {}),
  });
}

export interface BridgeHandle {
  objectId: string;
  /** Null for a cursor ref: nothing downstream needs it, so it isn't fetched. */
  backendNodeId: number | null;
}

/**
 * Resolve a ref to a live Runtime object. The one place a stale backend node
 * id turns into BRIDGE_REF_STALE instead of a raw CDP string.
 */
export async function bridgeResolveHandle(
  bridge: Bridge,
  ref: BridgeRef,
  label = 'element',
  /** 'isolated' (default): ghax's own world. 'main': the page's, for fill. */
  world: 'isolated' | 'main' = 'isolated',
): Promise<BridgeHandle> {
  let backendNodeId = ref.backendNodeId;
  if (backendNodeId === null) {
    // Cursor ref: look it up in ghax's registry, which lives in the isolated
    // world where the page can't reach it. A missing registry (new document),
    // a registry of the wrong shape, or a disconnected node is a stale ref,
    // never a guess.
    const id = Number(ref.cursorId);
    const evaluated = await inWorld(bridge, (contextId) => bridge.send('Runtime.evaluate', {
      expression: `(() => { const r = window.__ghax; const n = r && r.nodes instanceof Map ? r.nodes.get(${id}) : null; return n && n.isConnected ? n : null; })()`,
      returnByValue: false,
      contextId,
    })) as { result?: { objectId?: string; subtype?: string } };
    const objectId = evaluated.result?.objectId;
    if (!objectId || evaluated.result?.subtype === 'null') throw staleRefError(label);
    if (world === 'isolated') return { objectId, backendNodeId: null };
    // Main-world handle wanted: hop through the backend id.
    const described = await bridge.send('DOM.describeNode', { objectId }) as { node?: { backendNodeId?: number } };
    void bridge.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
    if (typeof described.node?.backendNodeId !== 'number') throw staleRefError(label);
    backendNodeId = described.node.backendNodeId;
  }
  const resolveIn = (executionContextId?: number) => bridge.send('DOM.resolveNode', {
    backendNodeId,
    ...(typeof executionContextId === 'number' ? { executionContextId } : {}),
  }) as Promise<{ object?: { objectId?: string } }>;
  let resolved: { object?: { objectId?: string } };
  try {
    resolved = world === 'isolated' ? await inWorld(bridge, resolveIn) : await resolveIn();
  } catch (err) {
    if (isStaleNodeError(err)) throw staleRefError(label);
    throw err;
  }
  const objectId = resolved.object?.objectId;
  if (!objectId) throw staleRefError(label);
  return { objectId, backendNodeId };
}

/** Fire-and-forget: the caller never waits on a release. */
export function bridgeReleaseHandle(bridge: Bridge, handle: BridgeHandle): void {
  void bridge.send('Runtime.releaseObject', { objectId: handle.objectId }).catch(() => undefined);
}

const ACTIONABILITY_SRC = actionability.toString();

/**
 * ONE `Runtime.callFunctionOn` that checks the element and, for click,
 * scrolls it into view and returns the click point. It replaces the old
 * scrollIntoViewIfNeeded + getBoxModel pair, so a guarded click costs no
 * more round-trips than an unguarded one did. `then` runs a second function
 * on the same element in the same call when the guard passes (fill).
 */
export async function bridgeGuard(
  bridge: Bridge,
  handle: BridgeHandle,
  label: string,
  kind: ActionabilityKind,
  force: boolean,
  then?: { fn: string; args: unknown[] },
): Promise<{ guard: ActionabilityResult; value?: unknown }> {
  const functionDeclaration = `function(kind, force, ...rest) {
    const guard = (${ACTIONABILITY_SRC})(this, { kind, force });
    if (!guard.ok) return { guard };
    ${then ? `return { guard, value: (${then.fn}).apply(this, rest) };` : 'return { guard };'}
  }`;
  let raw: unknown;
  try {
    raw = await bridge.send('Runtime.callFunctionOn', {
      objectId: handle.objectId,
      functionDeclaration,
      arguments: [kind, force, ...(then?.args ?? [])].map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
    });
  } catch (err) {
    if (isStaleNodeError(err) || /cannot find object with id|could not find object/i.test(String((err as Error)?.message ?? err))) {
      throw staleRefError(label);
    }
    throw err;
  }
  const out = unwrapEvalResult(raw) as { guard?: ActionabilityResult; value?: unknown } | undefined;
  const guard = out?.guard;
  if (!guard) throw new Error(`${kind} ${label}: actionability check returned nothing`);
  if (!guard.ok) {
    if (guard.reason === 'detached') throw staleRefError(label);
    throw notActionableError(label, kind, guard);
  }
  return { guard, ...(out && 'value' in out ? { value: out.value } : {}) };
}

export async function bridgeBox(
  bridge: Bridge,
  ref: BridgeRef,
  label = 'element',
): Promise<{ x: number; y: number; width: number; height: number }> {
  // AX refs address the node by backend id directly; cursor refs need the
  // page-side registry lookup first.
  const handle = ref.backendNodeId === null ? await bridgeResolveHandle(bridge, ref, label) : null;
  const target = handle ? { objectId: handle.objectId } : { backendNodeId: ref.backendNodeId };
  let model: { model?: { border?: number[]; content?: number[] } };
  try {
    await bridge.send('DOM.scrollIntoViewIfNeeded', target).catch(() => undefined);
    model = await bridge.send('DOM.getBoxModel', target) as typeof model;
  } catch (err) {
    if (isStaleNodeError(err)) throw staleRefError(label);
    throw err;
  } finally {
    if (handle) bridgeReleaseHandle(bridge, handle);
  }
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
  label = 'element',
): Promise<unknown> {
  const handle = await bridgeResolveHandle(bridge, ref, label, 'main');
  try {
    const result = await bridge.send('Runtime.callFunctionOn', {
      objectId: handle.objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
    });
    return unwrapEvalResult(result);
  } finally {
    bridgeReleaseHandle(bridge, handle);
  }
}
