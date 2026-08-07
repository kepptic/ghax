/**
 * ghax bridge — background service worker.
 *
 * Relays CDP commands between ghax daemons (over localhost WebSockets,
 * see src/bridge.ts) and the tabs they control (via chrome.debugger,
 * which — unlike --remote-debugging-port — is not blocked on Edge 150+ /
 * Chrome 136+'s default profile).
 *
 * MULTIPLEXED (v0.3): this worker holds ONE `BridgeConnection` per daemon,
 * discovered by dialling the port range base..base+PORT_RANGE-1, and one
 * chrome.debugger attachment per connection's controlled tab. That is what
 * lets several agents — each with its own GHAX_STATE_FILE and therefore its
 * own daemon — drive the same browser on different tabs. A module-level
 * `tabOwners` registry keeps two agents off one tab; see
 * docs/design/plan/09-bridge-multi-agent.md.
 *
 * Wire format (see src/bridge.ts for the daemon side), per connection:
 *   -> daemon, on connect:   {"type":"hello","agent":"ghax-ext","version":"...","controlledTabId":N|null}
 *   <- daemon, disposition:  {"type":"hello-ack","role":"bound"|"parked","daemonId":"...","sessionToken?":"..."}
 *                            (`daemonId` identifies the daemon PROCESS; a change
 *                             on a port means a different agent, see applyRole)
 *   <- daemon, a CDP cmd:    {"id":<n>,"method":"Page.navigate","params":{...}}
 *   -> daemon, its reply:    {"id":<n>,"result":{...}}
 *                            {"id":<n>,"error":{"message":"...","phase":"attach"|"dispatch"|"dispatch-detached"}}
 *   -> daemon, a CDP event:  {"type":"event","method":"...","params":{...}}
 *   <> keepalive:            -> {"type":"ping"}   <- {"type":"pong"} (both ignored)
 *   <- daemon, control:      {"type":"control","id":<n>,"action":"control-active"|"control-tab"|"stop","tabId?":N}
 *   -> daemon, control ack:  {"type":"control-ack","id":<n>,"ok":bool,"tabId?":N,"error?":"..."}
 *   -> daemon, control note: {"type":"controlled","tabId":N|null}   (pushed on any change)
 * `list-tabs` acks additionally carry `controlledBy` per tab: the bridge port
 * of the agent that owns it, or null. Nothing else about the protocol changed.
 *
 * MV3 service workers are EPHEMERAL — Chrome evicts them after ~30s idle.
 * Two mechanisms keep this bridge alive and self-healing:
 *   1. A `chrome.alarms` alarm (needs the "alarms" permission) — alarms
 *      WAKE an evicted SW; a bare setInterval dies with the worker. The
 *      handler reconnects every connection whose socket is gone.
 *   2. An application-level `{type:"ping"}` every ~15s per open socket —
 *      active WS traffic extends the SW's lifetime between evictions.
 * Control targets are persisted per port in chrome.storage.local
 * (`controlledTabs: {"9223": {daemonId, tabId}}`) so a respawned worker knows
 * which tab each connection was driving; on reconnect it re-attaches
 * proactively (and the daemon also re-asserts — see gap 3 in src/bridge.ts).
 * The entry is keyed by DAEMON identity as well as port because ports are
 * pool slots: the next agent to bind a port a previous one freed is a
 * different agent, and must not inherit its tab. onStartup/onInstalled also
 * kick a connect.
 */

import { isTemporarilyUnattachable, isDetachedMidCommand } from './errors.js';

const DEFAULT_PORT = 9223;
/**
 * How many consecutive ports are scanned for daemons, starting at the
 * configured base. MUST match BRIDGE_PORT_RANGE in src/bridge.ts — the daemon
 * walks the same window looking for a free port, so a smaller range here means
 * a daemon that bound the high end is never found.
 */
const PORT_RANGE = 10;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
const PING_INTERVAL_MS = 15000;
const NAVIGATION_TIMEOUT_MS = 8000;
/**
 * How long a command may keep retrying a transient attach refusal.
 *
 * Deliberately SHORT. Measured recovery from a genuine mid-navigation refusal
 * is sub-second and almost always succeeds on the first retry. The failure
 * mode this must not indulge is the *permanent* refusal — a page containing
 * another extension's frame is never going to become attachable, and a long
 * budget just adds latency to a guaranteed failure (2s per command, measured
 * on the authenticated Autotask app before this was tuned down).
 */
const ATTACH_RETRY_BUDGET_MS = 400;
/**
 * Consecutive failed dials before a connection hands its tab back to the pool.
 *
 * Ownership must survive a TRANSIENT outage — a daemon restart, or the browser
 * suspending the worker — or a reconnecting agent would lose its tab to a
 * rival mid-session. Only a daemon that stays unreachable across several scan
 * rounds is treated as gone for good. The desired tab id is KEPT either way,
 * so a returning daemon reclaims it if nobody else took it.
 */
const DEAD_DIAL_THRESHOLD = 4;
/**
 * How long a BASE-PORT connection waits for a disposition before assuming the
 * pre-v2 legacy contract. Mirrored by test/bridge-multi-sim.ts, which models
 * the same fallback to guard the base-port restriction in `connect()`.
 */
const LEGACY_FALLBACK_MS = 1000;
// Chrome clamps repeating alarms to a 30s (0.5 min) floor, so a single alarm
// leaves a worst-case ~30s wake gap after the daemon restarts and the socket
// closes. TWO alarms phase-offset by 15s halve that to ~15s — the cheap half
// of the keepalive story (no offscreen document, per plan §3.7). Both fire the
// same handler; whichever lands first reconnects, the other no-ops.
const KEEPALIVE_ALARM_A = 'ghax-bridge-keepalive';   // unchanged name: survives upgrade
const KEEPALIVE_ALARM_B = 'ghax-bridge-keepalive-b';
const KEEPALIVE_ALARMS = new Set([KEEPALIVE_ALARM_A, KEEPALIVE_ALARM_B]);
const KEEPALIVE_PERIOD_MIN = 0.5;

const DORMANT_ALARM = 'ghax-bridge-dormant-retry';
const DORMANT_RETRY_MIN = 5;

/** port → BridgeConnection. One entry per scanned port, daemon present or not. */
const connections = new Map();
/**
 * tabId → the BridgeConnection driving it. The whole point of this registry:
 * `attachTo()` swallows "already attached", which is only safe for a tab this
 * connection owns — without the registry, agent B's attach to agent A's tab
 * would silently succeed and both would dispatch into the same page.
 */
const tabOwners = new Map();
let basePort = DEFAULT_PORT;

async function getPort() {
  const { bridgePort } = await chrome.storage.local.get('bridgePort');
  const port = Number(bridgePort);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

// ─── Tab-ownership registry ────────────────────────────────────

/**
 * The connection that owns `tabId`, or null. Self-heals a stale entry: a
 * connection that no longer names the tab as its control target has no claim
 * on it, whatever the map says.
 */
function ownerOf(tabId) {
  const owner = tabOwners.get(tabId);
  if (!owner) return null;
  if (owner.controlledTabId !== tabId) {
    tabOwners.delete(tabId);
    return null;
  }
  return owner;
}

function conflictError(tabId, owner) {
  // Tagged so callers can tell "someone else has this tab" (keep wanting it,
  // report the conflict) from "this tab is gone" (forget it).
  return Object.assign(
    new Error(
      `tab ${tabId} is already controlled by another ghax agent (bridge port ${owner.port}) — `
      + `pick another tab or run 'ghax bridge control --stop' there`,
    ),
    { ghaxConflict: true },
  );
}

/** Take ownership of `tabId`, or throw if a different connection holds it. */
function claimTab(conn, tabId) {
  const owner = ownerOf(tabId);
  if (owner && owner !== conn) throw conflictError(tabId, owner);
  tabOwners.set(tabId, conn);
}

/**
 * Persist each connection's control target as `{daemonId, tabId}`.
 *
 * The daemon id is half the key: a bare tab id keyed by port alone says "some
 * agent was driving tab 42 here", which the NEXT agent on that port would read
 * as its own. `daemonId: null` (a pre-daemonId daemon) is recorded honestly and
 * never restored — see restorePersistedTab.
 */
async function saveControlledTabs() {
  const map = {};
  for (const [port, conn] of connections) {
    if (conn.controlledTabId != null) {
      map[String(port)] = { daemonId: conn.daemonId ?? null, tabId: conn.controlledTabId };
    }
  }
  await chrome.storage.local.set({ controlledTabs: map });
}

/**
 * Pre-v0.3 installs persisted a single `controlledTabId`. That value belonged
 * to whatever daemon was on the base port, so that's where it migrates — with
 * no daemon id, because there is no way to learn which daemon it belonged to.
 * An entry like that is never restored (an unknown daemon is not this one);
 * migrating it anyway is what retires the pre-v0.3 key for good.
 */
async function migrateLegacyControlledTab() {
  const { controlledTabs, controlledTabId } = await chrome.storage.local.get([
    'controlledTabs', 'controlledTabId',
  ]);
  if (typeof controlledTabId !== 'number') return;
  const map = (controlledTabs && typeof controlledTabs === 'object') ? { ...controlledTabs } : {};
  if (map[String(basePort)] === undefined) {
    map[String(basePort)] = { daemonId: null, tabId: controlledTabId };
  }
  await chrome.storage.local.set({ controlledTabs: map });
  await chrome.storage.local.remove('controlledTabId');
}

async function setStatus() {
  // Polled by the popup rather than pushed — the popup may open well after
  // a status change happens, and MV3 has no persistent connection to a
  // closed popup to push to anyway.
  await chrome.storage.local.set({
    bridgeStatus: {
      connections: [...connections.values()].map((c) => c.statusRow()),
      updatedAt: Date.now(),
    },
  });
}

/**
 * This install's stable identity. `chrome.runtime.id` is derived from the
 * unpacked path, so every profile loading the same directory reports the
 * SAME id — useless for telling two browsers apart. A UUID minted once into
 * chrome.storage.local is per-profile, which is exactly the identity the
 * daemon's registry needs.
 *
 * Deliberately install-wide, not per-connection: each daemon keeps its OWN
 * peer registry, so the same instanceId reaching all of them is correct — it
 * says "one browser", which is the truth they each need.
 */
async function getIdentity() {
  const stored = await chrome.storage.local.get(['ghaxInstanceId', 'ghaxLabel']);
  let instanceId = stored.ghaxInstanceId;
  if (typeof instanceId !== 'string' || !instanceId) {
    instanceId = crypto.randomUUID();
    await chrome.storage.local.set({ ghaxInstanceId: instanceId });
  }
  return {
    instanceId,
    label: typeof stored.ghaxLabel === 'string' ? stored.ghaxLabel : '',
    browser: detectBrowser(),
  };
}

function detectBrowser() {
  const brands = (globalThis.navigator?.userAgentData?.brands) ?? [];
  for (const b of brands) {
    const name = String(b?.brand ?? '').toLowerCase();
    if (name.includes('edge')) return 'edge';
  }
  for (const b of brands) {
    const name = String(b?.brand ?? '').toLowerCase();
    if (name.includes('chrome') && !name.includes('chromium')) return 'chrome';
  }
  return brands.length ? 'chromium' : '';
}

/**
 * One daemon's worth of bridge state: its socket, its disposition, and the
 * single tab it drives. Everything here used to be a module global — which is
 * exactly why every relayed command landed on one tab no matter which session
 * asked for it.
 */
class BridgeConnection {
  constructor(port) {
    this.port = port;
    this.ws = null;
    // Socket generation — bumped on every connect(). Every socket's event
    // listeners capture their generation and act ONLY if they're still current.
    // This is what stops a superseded socket's late `close` from scheduling a
    // reconnect (or a stale `open` from re-pinging) after a newer socket has
    // already taken over. See docs/design/plan/08-bridge-reliability.md §1b.
    this.socketGen = 0;
    // Disposition assigned by the daemon in `hello-ack` (or a later `role`).
    // 'bound'  — we drive the controlled tab.
    // 'parked' — socket stays OPEN and pinging, but we hold NO chrome.debugger
    //            attachment and receive no CDP. Keeping the socket is what ends
    //            the livelock: our reconnect loop is satisfied, not retriggered.
    // null     — nothing answered the handshake. Holds NO attachment and drives
    //            nothing (see assertBound); on the base port only, it becomes
    //            'bound' after LEGACY_FALLBACK_MS for pre-v2 daemons.
    this.bridgeRole = null;
    // Identity of the daemon currently on this port, from `hello-ack`/`role`.
    // A change means a DIFFERENT agent took the slot, not that ours came back —
    // the tab we were driving goes back to the pool before we drive for the new
    // one. null for a pre-daemonId daemon, which therefore never restores a
    // persisted tab (an unidentified daemon can't prove the tab is its own).
    this.daemonId = null;
    // Set when the daemon explicitly REJECTED us (auth/protocol). Distinct from
    // parked: a rejected client stops the fast reconnect loop entirely and
    // retries once every DORMANT_RETRY_MIN minutes, so a rejection can't become
    // a hot loop.
    this.dormantReason = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.controlledTabId = null;
    this.attached = false;
    this.reattachTimer = null;
    this.navigationInProgress = false;
    this.detachedReason = null;
    /** Consecutive dials that never reached OPEN — see DEAD_DIAL_THRESHOLD. */
    this.failedDials = 0;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  statusRow() {
    return {
      port: this.port,
      connected: this.connected,
      role: this.bridgeRole,
      dormantReason: this.dormantReason,
      controlledTabId: this.controlledTabId,
      attached: this.attached,
      detachedReason: this.detachedReason,
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // Push the current controlled tab to the daemon so /bridge-status can
  // report it and gap-3 re-assert logic can reason about it.
  reportControlled() {
    this.send({ type: 'controlled', tabId: this.controlledTabId });
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ type: 'ping' });
      else this.stopPing();
    }, PING_INTERVAL_MS);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Re-adopt the tab this connection was driving FOR THIS DAEMON.
   *
   * Only callable once `daemonId` is known, i.e. from applyRole — a connection
   * must not claim a tab before it knows which daemon it is talking to. A
   * persisted entry from another daemon (or from one that never identified
   * itself) is discarded rather than restored: the port it was saved under is a
   * pool slot, so the entry says nothing about whether this agent owns the tab.
   */
  async restorePersistedTab() {
    if (this.controlledTabId != null || !this.daemonId) return;
    const { controlledTabs } = await chrome.storage.local.get('controlledTabs');
    const saved = controlledTabs?.[String(this.port)];
    if (!saved || saved.daemonId !== this.daemonId || typeof saved.tabId !== 'number') return;
    // Another agent may have taken the tab while this daemon was away. Don't
    // steal it back silently — the next explicit control action reports the
    // conflict instead.
    if (ownerOf(saved.tabId)) return;
    this.controlledTabId = saved.tabId;
    tabOwners.set(saved.tabId, this);
  }

  /**
   * Detach ONLY from a tab this connection still owns.
   *
   * chrome.debugger sessions are per (extension, tab) and every connection in
   * this worker shares one, so an unguarded detach tears down whatever agent is
   * actually driving that tab — mid-command. `attached` is not the test:
   * releaseControl() deliberately keeps `controlledTabId` after handing the
   * ownership entry back, so a returning connection still names a tab that now
   * belongs to someone else.
   */
  async detachOwnedTab() {
    const tabId = this.controlledTabId;
    if (tabId == null || tabOwners.get(tabId) !== this) return;
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
  }

  async persistTab(tabId) {
    const previous = this.controlledTabId;
    if (previous != null && previous !== tabId && tabOwners.get(previous) === this) {
      tabOwners.delete(previous);
    }
    this.controlledTabId = tabId;
    if (tabId != null) tabOwners.set(tabId, this);
    await saveControlledTabs();
  }

  async connect() {
    // Treat CLOSING as occupied, not free. A socket the daemon just evicted sits
    // in CLOSING until its close event fires; the OLD guard (OPEN/CONNECTING
    // only) let connect() open a SECOND socket in that window while the daemon
    // still held the first — which the daemon logs as "connection replaced" and
    // which self-sustains churn with no rival present. Wait for `close`; its
    // handler schedules the reconnect. See plan §1b.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN
                 || this.ws.readyState === WebSocket.CONNECTING
                 || this.ws.readyState === WebSocket.CLOSING)) return;
    const gen = ++this.socketGen;
    let socket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    let opened = false;

    socket.addEventListener('open', async () => {
      if (gen !== this.socketGen) return; // superseded before we even opened
      opened = true;
      this.failedDials = 0;
      this.reconnectDelay = RECONNECT_BASE_MS;
      // Identify FIRST, then claim and attach only once the daemon has told us
      // WHO it is and that we're the driver (see applyRole). Neither the tab nor
      // the attachment may be taken before the handshake: a peer destined to be
      // parked would grab a chrome.debugger attachment anyway, and a tab
      // restored before the daemon identifies itself may belong to a different
      // agent that held this port earlier.
      const identity = await getIdentity();
      const session = chrome.storage.session
        ? await chrome.storage.session.get('ghaxSessionToken').catch(() => ({}))
        : {};
      // Pairing code, if the user set one in the popup. Ignored by daemons that
      // don't require pairing; required by those started with a pair code.
      const { ghaxPairToken } = await chrome.storage.local.get('ghaxPairToken');
      this.send({
        type: 'hello',
        agent: 'ghax-ext',
        version: chrome.runtime.getManifest().version,
        instanceId: identity.instanceId,
        browser: identity.browser,
        label: identity.label,
        // The tab we WANT. Provisional in both directions: the attachment awaits
        // the disposition, and the tab itself is dropped if the ack turns out to
        // come from a different daemon — applyRole always follows with a
        // `controlled` push carrying what this connection actually holds.
        controlledTabId: this.controlledTabId,
        resumeToken: session?.ghaxSessionToken ?? null,
        ...(typeof ghaxPairToken === 'string' && ghaxPairToken ? { pairToken: ghaxPairToken } : {}),
      });
      this.startPing();
      void setStatus();
      // Pre-v2 daemons never answer `hello`, so on the BASE PORT ONLY, silence
      // is read as the legacy contract (we are the one and only driver) and an
      // old daemon keeps working with a new extension.
      //
      // Nowhere else, because silence is not consent: a daemon that requires a
      // pairing code answers `hello-reject`, so treating no answer as a grant
      // bypasses the gate entirely. The scan window is squattable — the other
      // ports are normally FREE, and any local process can accept a socket on
      // one, say nothing, and inherit full CDP over the user's real
      // authenticated browser. Pre-v2 daemons predate the scan window and only
      // ever listened on the configured base port, so the restriction costs no
      // real compatibility.
      if (this.port === basePort) {
        setTimeout(() => {
          if (gen === this.socketGen && this.bridgeRole === null && this.ws?.readyState === WebSocket.OPEN) {
            void this.applyRole('bound', undefined, undefined);
          }
        }, LEGACY_FALLBACK_MS);
      }
    });

    socket.addEventListener('message', (ev) => {
      if (gen !== this.socketGen) return; // a newer socket owns this connection now
      void this.handleMessage(String(ev.data));
    });

    socket.addEventListener('close', () => {
      // Only the current generation may clear `ws`, stop pinging, or schedule a
      // reconnect. A superseded socket closing is a no-op — otherwise its late
      // close would race a healthy newer socket back into the reconnect loop.
      if (gen !== this.socketGen) return;
      if (this.ws === socket) this.ws = null;
      this.stopPing();
      // Role is per-connection: the next handshake re-negotiates it. Without
      // this reset a reconnecting peer would keep acting on a stale disposition.
      this.bridgeRole = null;
      if (!opened) {
        // Connection refused — on a scanned port with no daemon this is the
        // normal, ~1ms outcome, and the backoff below keeps it cheap.
        this.failedDials++;
        if (this.failedDials === DEAD_DIAL_THRESHOLD) void this.releaseControl();
      }
      void setStatus();
      this.scheduleReconnect();
    });

    // 'close' always fires after 'error' for the WHATWG WebSocket — no
    // separate handling needed here beyond not crashing the worker.
    socket.addEventListener('error', () => undefined);
  }

  scheduleReconnect() {
    // The fast 500ms→8s backoff is correct for "daemon isn't listening yet".
    // It is NOT correct after an explicit rejection — goDormant owns that path.
    if (this.reconnectTimer || this.dormantReason) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      void this.connect();
    }, this.reconnectDelay);
  }

  /**
   * Apply a disposition from the daemon. This is the ONLY place that decides
   * whether we hold a tab and a debugger attachment — both are taken strictly
   * after the daemon has identified itself and told us we're the driver
   * (previously we attached before even sending hello, which meant a would-be
   * parked peer grabbed an attachment anyway).
   */
  async applyRole(role, sessionToken, daemonId) {
    const nextDaemonId = typeof daemonId === 'string' && daemonId ? daemonId : null;
    if (nextDaemonId !== this.daemonId) {
      // A DIFFERENT daemon now holds this port. Nothing detaches when a daemon
      // exits, so without this the tab (and its live debugger session) would be
      // silently inherited by whichever unrelated agent next lands on the slot.
      await this.releaseControl();
      this.controlledTabId = null;
      this.daemonId = nextDaemonId;
      // Deliberately NOT persisted here: the stored entry still names the
      // daemon that owned the tab, which is exactly what makes it discardable.
      // Rewriting the map now would erase the entry a RESUMING daemon (fresh
      // worker, same id) is about to restore from.
    }
    this.bridgeRole = role === 'bound' ? 'bound' : 'parked';
    this.dormantReason = null;
    if (typeof sessionToken === 'string' && chrome.storage.session) {
      // storage.session survives a service-worker respawn but dies with the
      // browser — exactly resume semantics.
      await chrome.storage.session.set({ ghaxSessionToken: sessionToken }).catch(() => undefined);
    }
    if (this.bridgeRole === 'bound') {
      await this.restorePersistedTab();
      if (this.controlledTabId != null && !this.attached) {
        try {
          claimTab(this, this.controlledTabId);
          await this.attachTo(this.controlledTabId);
        } catch (err) {
          if (isTemporarilyUnattachable(err)) this.scheduleReattach();
          // A tab someone else took is still the tab this agent wants: keep it
          // recorded so commands report the conflict instead of the much less
          // useful "no tab under control".
          else if (err?.ghaxConflict) this.detachedReason = err.message;
          else await this.persistTab(null);
        }
      }
      // Unconditional, because the daemon's view of which tab this connection
      // holds must be the extension's view — including "none". Hanging it off
      // the attach above meant a connection whose attachment outlived the socket
      // reported nothing at all, so the daemon drove a tab it believed was free.
      this.reportControlled();
    } else if (this.attached && this.controlledTabId != null) {
      // Demoted while driving: drop the attachment but KEEP the desired tab
      // recorded, so a later promotion restores exactly where we were.
      this.cancelReattach();
      await this.detachOwnedTab();
      this.attached = false;
    }
    await setStatus();
  }

  /**
   * The daemon rejected this client outright. Stop the fast reconnect loop —
   * retrying a rejection every 500ms is how a "no" becomes a hot loop — and
   * check back once every few minutes instead.
   */
  async goDormant(reason) {
    this.dormantReason = reason || 'rejected by the ghax daemon';
    this.bridgeRole = null;
    this.cancelReattach();
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.ws;
    this.socketGen++; // invalidate listeners so `close` can't schedule a reconnect
    this.ws = null;
    try {
      socket?.close();
    } catch {
      // ignore
    }
    // A rejected client is not coming back within this session's timeframe;
    // holding the tab (and its debugger banner) would strand it for everyone.
    await this.releaseControl();
    chrome.alarms.create(DORMANT_ALARM, { delayInMinutes: DORMANT_RETRY_MIN });
    await setStatus();
  }

  /**
   * Hand the tab back to the pool WITHOUT forgetting which tab we want. Used
   * when this connection's daemon looks gone for good (dormant, or unreachable
   * across several scan rounds): another agent may take the tab, and if none
   * does we reclaim it on reconnect.
   */
  async releaseControl() {
    this.cancelReattach();
    if (this.attached) await this.detachOwnedTab();
    this.attached = false;
    if (this.controlledTabId != null && tabOwners.get(this.controlledTabId) === this) {
      tabOwners.delete(this.controlledTabId);
    }
    await setStatus();
  }

  // Attach chrome.debugger to `tabId`, tolerating "already attached" (which
  // happens if the previous SW instance left the session live). Callers MUST
  // have claimed the tab first — the swallow above is only safe for a tab this
  // connection owns.
  async attachTo(tabId) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (!/already attached/i.test(msg)) throw err;
    }
    this.attached = true;
    this.detachedReason = null;
  }

  /**
   * Attach if needed, dispatch one CDP command, and absorb transient refusals.
   *
   * Safe for every verb, including click/fill, and that is the whole point: a
   * refusal is Chrome rejecting the request outright, so the command provably
   * never executed and retrying cannot double an action. It's the same reasoning
   * docs/design/plan/08 §2.5 uses to justify the unconditional evaluate retry
   * after a stale context pin. This is NOT the retry a mid-dispatch *detach*
   * would need — that one may have landed, and goes to the retry-class table via
   * `isDetachedMidCommand` / `phase: "dispatch-detached"`.
   *
   * Bounded, because "the tab is parked on a chrome:// page" is a real state that
   * must still surface as an error rather than hang.
   */
  async relayCommand(method, params, budgetMs = ATTACH_RETRY_BUDGET_MS) {
    const deadline = Date.now() + budgetMs;
    let delay = 25;
    for (;;) {
      let phase = 'attach';
      try {
        await this.ensureAttached();
        phase = 'dispatch';
        return await chrome.debugger.sendCommand({ tabId: this.controlledTabId }, method, params);
      } catch (err) {
        if (!isTemporarilyUnattachable(err) || Date.now() >= deadline) {
          // Report which half actually failed, not which half we assumed.
          throw Object.assign(err instanceof Error ? err : new Error(String(err)), { ghaxPhase: phase });
        }
        // A REAL detach/attach cycle, not just `attached = false`. Clearing the
        // flag alone is a no-op whenever Chrome still holds the session:
        // attachTo() swallows "already attached", so the next pass reuses the
        // very session that was just refused and fails identically. That is why
        // `ghax bridge control` recovers a stuck bridge and a retry did not —
        // switchControlTo() detaches first. Measured on the Autotask login page,
        // where one `snapshot` leaves every later command refused until a real
        // re-attach.
        //
        // Covers the refusal landing at DISPATCH as well as at attach: Chrome
        // detaches during navigation but `chrome.debugger.onDetach` is async, so
        // `attached` can still be true and sendCommand is what gets refused.
        // Ownership-guarded: the session being recycled here is shared with
        // every other connection, so a tab we no longer own must not be torn
        // down out from under the agent that does own it.
        this.attached = false;
        await this.detachOwnedTab();
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 200);
      }
    }
  }

  cancelReattach() {
    if (!this.reattachTimer) return;
    clearTimeout(this.reattachTimer);
    this.reattachTimer = null;
  }

  scheduleReattach(delay = 250) {
    if (this.reattachTimer || this.controlledTabId == null || this.attached || this.navigationInProgress) return;
    this.reattachTimer = setTimeout(async () => {
      this.reattachTimer = null;
      if (this.controlledTabId == null || this.attached) return;
      try {
        claimTab(this, this.controlledTabId);
        await this.attachTo(this.controlledTabId);
        await setStatus();
        this.reportControlled();
      } catch (err) {
        if (isTemporarilyUnattachable(err)) this.scheduleReattach(Math.min(delay * 2, 4000));
        else {
          this.detachedReason = err?.message ?? String(err);
          await setStatus();
        }
      }
    }, delay);
  }

  /**
   * Refuse anything that isn't the daemon-granted driver. `parked` is the
   * expected demotion; `null` — no disposition at all — must be refused for the
   * same reason the legacy fallback is fenced to the base port: on a scanned
   * port, silence identifies nothing, and attaching for it would hand the
   * user's real browser to whatever accepted the socket.
   */
  assertBound() {
    if (this.bridgeRole === 'bound') return;
    if (this.bridgeRole === 'parked') {
      throw new Error('this browser is parked — another browser is bound to the ghax daemon. Run `ghax bridge use <id|browser>` to switch.');
    }
    throw new Error(`no ghax daemon has granted control on port ${this.port} — the handshake was never answered. Run \`ghax attach --extension\`, and enter its pairing code in the ghax bridge popup if one was printed.`);
  }

  async ensureAttached() {
    this.assertBound();
    if (this.attached) return;
    if (this.controlledTabId == null) {
      throw new Error('no tab under control — click "Control this tab" in the ghax bridge popup, or run `ghax bridge control --active`');
    }
    claimTab(this, this.controlledTabId);
    await this.attachTo(this.controlledTabId);
  }

  // The single code path both the popup and the daemon control channel use to
  // point this connection at a tab: check ownership, detach any prior tab,
  // persist the new one, attach, and tell the daemon.
  async switchControlTo(tabId) {
    // Before any claim is recorded, not just before the attach: an unbound
    // connection that got as far as claiming would take the tab out of the
    // ownership pool for every real agent while driving nothing itself.
    this.assertBound();
    // Checked BEFORE anything is torn down: a refused switch must leave this
    // connection exactly where it was, still driving its own tab.
    const owner = ownerOf(tabId);
    if (owner && owner !== this) throw conflictError(tabId, owner);
    // Captured for the rollback below, before anything is torn down.
    const previousTabId = this.controlledTabId;
    if (this.attached && this.controlledTabId != null && this.controlledTabId !== tabId) {
      await this.detachOwnedTab();
      this.attached = false;
    }
    // Re-checked after the await — another connection could have claimed the
    // tab while we were detaching. claimTab and persistTab run back to back so
    // the reservation and `controlledTabId` never disagree.
    claimTab(this, tabId);
    await this.persistTab(tabId);
    try {
      await this.ensureAttached();
    } catch (err) {
      // Certificate interstitials and chrome-error:// pages temporarily refuse
      // chrome.debugger.attach. Keep the tab selected and retry as it returns
      // to an attachable page instead of losing control entirely.
      if (isTemporarilyUnattachable(err)) {
        this.attached = false;
        this.scheduleReattach();
      } else {
        // Anything else is permanent — a target that will never be attachable —
        // and it propagates as a FAILED control-ack, which leaves the DAEMON
        // still believing the old tab. Ownership goes back with it: a switch
        // that half-happened means the two disagree about which document is
        // under control, so a `@e3` from the old page resolves against the new
        // one (CLAUDE.md invariant 3) with nothing to show that it moved.
        await this.persistTab(previousTabId);
        await setStatus();
        throw err;
      }
    }
    await setStatus();
    this.reportControlled();
  }

  async stopControl() {
    this.cancelReattach();
    await this.detachOwnedTab();
    this.attached = false;
    await this.persistTab(null);
    await setStatus();
    this.reportControlled();
  }

  async navigateControlledTab(params) {
    const url = params?.url;
    if (typeof url !== 'string') throw new Error('Page.navigate requires a URL');
    if (this.controlledTabId == null) {
      throw new Error('no tab under control — click "Control this tab" in the ghax bridge popup, or run `ghax bridge control --active`');
    }

    const tabId = this.controlledTabId;
    const requestedTimeout = Number(params.ghaxLoadTimeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout >= 0
      ? Math.min(requestedTimeout, 30000)
      : NAVIGATION_TIMEOUT_MS;
    const { ghaxLoadTimeoutMs: _ghaxLoadTimeoutMs, ...navigateParams } = params;
    const load = watchTabLoad(tabId, timeoutMs);
    let result = {};
    let tab = null;
    let needsReattach = false;

    this.navigationInProgress = true;
    this.cancelReattach();
    try {
      let useTabsUpdate = false;
      try {
        await this.ensureAttached();
        await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
      } catch (err) {
        if (!isTemporarilyUnattachable(err)) throw err;
        this.attached = false;
        useTabsUpdate = true;
      }

      if (!useTabsUpdate) {
        try {
          result = await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', navigateParams);
        } catch {
          // Page.navigate may commit a cert-error navigation and then lose its
          // debugger session before replying. Reissuing the same URL through
          // chrome.tabs is safe and does not require an attachable target.
          this.attached = false;
          useTabsUpdate = true;
        }
      }

      if (useTabsUpdate) await chrome.tabs.update(tabId, { url });
      tab = await load.promise;

      if (!this.attached) {
        try {
          await this.attachTo(tabId);
        } catch (err) {
          if (!isTemporarilyUnattachable(err)) throw err;
          // The requested destination may itself be a cert interstitial. Keep
          // control selected so the next goto can escape via chrome.tabs.update.
          needsReattach = true;
        }
      }
    } catch (err) {
      load.cancel();
      throw err;
    } finally {
      this.navigationInProgress = false;
      if (needsReattach) this.scheduleReattach();
    }

    await setStatus();
    return {
      ...(result ?? {}),
      ghaxFinalUrl: tab?.url ?? url,
      ghaxTitle: tab?.title ?? '',
    };
  }

  async handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Keepalive frames carry no work.
    if (msg.type === 'ping' || msg.type === 'pong') return;

    // Handshake disposition, and later promotion/demotion over the live socket
    // (so a rebind never requires a disconnect).
    if (msg.type === 'hello-ack' || msg.type === 'role') {
      await this.applyRole(msg.role, msg.sessionToken, msg.daemonId);
      return;
    }
    if (msg.type === 'hello-reject') {
      await this.goDormant(msg.message);
      return;
    }

    // Daemon → extension control channel (scriptable activation, no popup).
    if (msg.type === 'control') {
      await this.handleControl(msg);
      return;
    }

    // Everything else is a CDP command to relay: {id, method, params}.
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    // Which half of the relay failed. The daemon needs this to tell "never ran"
    // from "may have run": only the former is safe to retry for a mutating verb.
    let phase = 'attach';
    try {
      let result;
      if (msg.method === 'Page.navigate') {
        phase = 'dispatch';
        result = await this.navigateControlledTab(msg.params ?? {});
      } else {
        // Transient refusals are absorbed inside relayCommand, so a mid-
        // navigation blip never reaches the user — and never replays an action
        // that ran, because a refusal means Chrome rejected the command outright.
        phase = 'dispatch';
        result = await this.relayCommand(msg.method, msg.params ?? {});
      }
      this.send({ id: msg.id, result: result ?? {} });
    } catch (err) {
      // relayCommand knows which half actually failed; fall back to the coarse
      // outer guess for paths that don't go through it (e.g. Page.navigate).
      const actual = err?.ghaxPhase ?? phase;
      // A dispatch-phase detach is the unsafe case: the command was already on
      // the wire. Report it as such rather than letting it read like a refusal.
      const detached = actual === 'dispatch' && isDetachedMidCommand(err);
      this.send({
        id: msg.id,
        error: {
          message: err?.message ?? String(err),
          phase: detached ? 'dispatch-detached' : actual,
        },
      });
    }
  }

  async handleControl(msg) {
    const id = msg.id ?? null;
    try {
      if (msg.action === 'stop') {
        await this.stopControl();
        this.send({ type: 'control-ack', id, ok: true, tabId: null });
        return;
      }
      if (msg.action === 'list-tabs') {
        const tabs = await chrome.tabs.query({});
        this.send({
          type: 'control-ack', id, ok: true, tabId: this.controlledTabId,
          result: tabs.filter((tab) => typeof tab.id === 'number').map((tab) => {
            const owner = ownerOf(tab.id);
            return {
              id: tab.id,
              title: tab.title ?? '',
              url: tab.url ?? '',
              active: tab.id === this.controlledTabId,
              // Which agent owns this tab, so `ghax tabs` can show the other
              // sessions' territory instead of offering a tab that will refuse.
              controlledBy: owner ? owner.port : null,
            };
          }),
        });
        return;
      }
      if (msg.action === 'new-window') {
        const win = await chrome.windows.create({ url: msg.url || 'about:blank', focused: false });
        const candidates = win.tabs?.length ? win.tabs : await chrome.tabs.query({ windowId: win.id });
        let tab = candidates.find((candidate) => typeof candidate.id === 'number');
        if (!tab?.id) throw new Error('new window did not create a controllable tab');
        await this.switchControlTo(tab.id);
        const deadline = Date.now() + 5000;
        while (tab.status !== 'complete' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          tab = await chrome.tabs.get(tab.id);
        }
        this.send({
          type: 'control-ack', id, ok: true, tabId: tab.id,
          result: { id: tab.id, title: tab.title ?? '', url: tab.url ?? msg.url ?? 'about:blank', active: true },
        });
        return;
      }
      let tabId;
      if (msg.action === 'control-active') {
        // A service worker has no "current window" — currentWindow can return
        // nothing from here. lastFocusedWindow is the reliable query.
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) throw new Error('no active tab in the last-focused window');
        tabId = tab.id;
      } else if (msg.action === 'control-tab') {
        if (typeof msg.tabId !== 'number') throw new Error('control-tab requires a numeric tabId');
        tabId = msg.tabId;
        // Ownership first: focusing a tab we're about to be refused would move
        // the user's window for nothing.
        const owner = ownerOf(tabId);
        if (owner && owner !== this) throw conflictError(tabId, owner);
        if (!msg.quiet) {
          const tab = await chrome.tabs.update(tabId, { active: true });
          if (typeof tab.windowId === 'number') await chrome.windows.update(tab.windowId, { focused: true });
        }
      } else {
        throw new Error(`unknown control action: ${msg.action}`);
      }
      await this.switchControlTo(tabId);
      this.send({ type: 'control-ack', id, ok: true, tabId });
    } catch (err) {
      this.send({ type: 'control-ack', id, ok: false, error: err?.message ?? String(err) });
    }
  }

  /** Tear down for good — the port left the scan range. */
  dispose() {
    this.cancelReattach();
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socketGen++;
    const socket = this.ws;
    this.ws = null;
    try {
      socket?.close();
    } catch {
      // ignore
    }
    if (this.controlledTabId != null) {
      if (this.attached) void this.detachOwnedTab();
      if (tabOwners.get(this.controlledTabId) === this) tabOwners.delete(this.controlledTabId);
    }
    this.attached = false;
  }
}

function watchTabLoad(tabId, timeoutMs) {
  let settled = false;
  let timer;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const finish = (tab) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    resolvePromise(tab);
  };
  const onUpdated = (updatedTabId, changeInfo, tab) => {
    if (updatedTabId === tabId && changeInfo.status === 'complete') finish(tab);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  timer = setTimeout(() => {
    void chrome.tabs.get(tabId).then(finish, () => finish(null));
  }, timeoutMs);
  return { promise, cancel: () => finish(null) };
}

// ─── Connection pool ───────────────────────────────────────────

/**
 * Ensure a connection object exists for every port in the scan window and dial
 * the ones whose socket is gone. A refused localhost connect fails in ~1ms, and
 * each connection keeps its own 500ms→8s backoff, so scanning ten ports costs
 * roughly one dial per second in steady state.
 */
async function ensureConnections() {
  await refreshBasePort();
  for (let i = 0; i < PORT_RANGE; i++) {
    const port = basePort + i;
    let conn = connections.get(port);
    if (!conn) {
      conn = new BridgeConnection(port);
      connections.set(port, conn);
    }
    if (conn.dormantReason) continue; // rejected: wait for the slow retry
    // Reconnect only when the socket is truly gone. A CLOSING socket is handled
    // by its own close listener (which schedules the reconnect).
    if (!conn.ws || conn.ws.readyState === WebSocket.CLOSED) void conn.connect();
  }
}

/** Pick up a base-port change from the popup and drop connections that fell out. */
async function refreshBasePort() {
  const port = await getPort();
  if (port === basePort && connections.size > 0) return;
  basePort = port;
  for (const [p, conn] of [...connections]) {
    if (p < basePort || p >= basePort + PORT_RANGE) {
      conn.dispose();
      connections.delete(p);
    }
  }
}

/** The connection a portless popup action should act on. */
function pickConnection(port) {
  if (Number.isFinite(port)) return connections.get(Number(port)) ?? null;
  // 'bound' only — a connection with no disposition would just refuse the
  // action (assertBound), and picking one over a real daemon turns a working
  // popup click into an error.
  const open = [...connections.values()].filter((c) => c.connected && c.bridgeRole === 'bound');
  return open.find((c) => c.controlledTabId == null) ?? open[0] ?? null;
}

// ─── Global chrome.* listeners, routed by tab ownership ────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  const conn = typeof source.tabId === 'number' ? ownerOf(source.tabId) : null;
  if (!conn) return;
  conn.send({ type: 'event', method, params });
});

// Fires when the user clicks Chrome's "Cancel" on the debugging banner, the
// tab crashes, devtools is opened on the same tab (steals the debugger
// session), or we call chrome.debugger.detach() ourselves.
chrome.debugger.onDetach.addListener((source, reason) => {
  const conn = typeof source.tabId === 'number' ? ownerOf(source.tabId) : null;
  if (!conn) return;
  conn.attached = false;
  conn.detachedReason = reason;
  void setStatus();
  if (reason === 'target_closed') conn.scheduleReattach();
});

// A cert interstitial temporarily turns the controlled target into an
// unattachable chrome-error:// page. Any subsequent navigation/update is a
// chance to recover, including the user clicking through the interstitial.
chrome.tabs.onUpdated.addListener((tabId) => {
  const conn = ownerOf(tabId);
  if (conn && !conn.attached) conn.scheduleReattach();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const conn = ownerOf(tabId);
  if (!conn) return;
  conn.attached = false;
  void conn.persistTab(null).then(() => {
    conn.reportControlled();
    return setStatus();
  });
});

// Keepalive alarm — resurrects an evicted SW and reconnects every connection
// whose socket is gone. Registered at top level so it re-arms on every SW spawn.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DORMANT_ALARM) {
    // Slow retry after an explicit rejection — clear dormancy and try once.
    // One alarm covers every dormant connection; they were all rejected by
    // daemons that may have been restarted with a new pairing code together.
    for (const conn of connections.values()) {
      if (!conn.dormantReason) continue;
      conn.dormantReason = null;
      void conn.connect();
    }
    return;
  }
  if (!KEEPALIVE_ALARMS.has(alarm.name)) return;
  void ensureConnections();
});

function ensureAlarm() {
  // create() with the same name replaces any existing schedule — idempotent.
  // Alarm B is phase-offset by ~15s so the two together fire every ~15s.
  chrome.alarms.create(KEEPALIVE_ALARM_A, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  chrome.alarms.create(KEEPALIVE_ALARM_B, {
    delayInMinutes: 0.25,
    periodInMinutes: KEEPALIVE_PERIOD_MIN,
  });
}

// Messages from popup.js. Every action is scoped to one connection by `port`;
// omitting it picks a sensible default so a single-daemon setup needs no UI.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.action === 'control-tab') {
      const conn = pickConnection(message.port);
      if (!conn) {
        sendResponse({ ok: false, error: 'no ghax daemon connected — run `ghax attach --extension`' });
        return;
      }
      // The popup runs in a real window context, so currentWindow is valid
      // here (unlike from the SW's control-active path).
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'no active tab found' });
        return;
      }
      try {
        await conn.switchControlTo(tab.id);
        sendResponse({ ok: true, port: conn.port, tabId: tab.id, title: tab.title, url: tab.url });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      }
      return;
    }

    if (message?.action === 'stop') {
      const conn = pickConnection(message.port);
      if (conn) await conn.stopControl();
      sendResponse({ ok: true });
      return;
    }

    if (message?.action === 'status') {
      sendResponse({
        ok: true,
        basePort,
        portRange: PORT_RANGE,
        connections: [...connections.values()].map((c) => c.statusRow()),
      });
      return;
    }

    if (message?.action === 'reconnect') {
      // The user just entered/changed a pairing code or port. Clear dormancy on
      // every connection and dial now instead of waiting out the slow retry.
      for (const conn of connections.values()) {
        conn.dormantReason = null;
        if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
        conn.reconnectDelay = RECONNECT_BASE_MS;
      }
      await ensureConnections();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: `unknown action: ${message?.action}` });
  })();
  return true; // keep the message channel open for the async sendResponse above
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  void init();
});
chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  void init();
});

async function init() {
  basePort = await getPort();
  await migrateLegacyControlledTab();
  await ensureConnections();
}

ensureAlarm();
void init();
