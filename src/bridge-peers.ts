/**
 * Peer registry — the instances the bridge knows about (plan §2.4, plan 12
 * step 0). Split out of bridge.ts so multi-bind work has a small, testable
 * surface: who is connected, how selectors resolve, and who the first-bind
 * selection would pick. Nothing here touches timers, the wire protocol or the
 * bound/degraded state machine; those stay in Bridge.
 */
import { WebSocket } from 'ws';
import { lookupProfileName } from './browser-profiles';
import { mintAliases, sanitizeLabel } from './tab-identity';

/**
 * Browser profile name for an instance with no popup label: (instanceId,
 * brand, chrome.runtime.id) → name, '' when unknown. Default reads the
 * browser's own profile data (src/browser-profiles.ts).
 */
export type ProfileLookup = (instanceId: string, brand: string, extensionId: string) => string;

const defaultProfileLookup: ProfileLookup = (instanceId, brand, extensionId) =>
  lookupProfileName(instanceId, { brand, extensionId });

export type PeerRole = 'bound' | 'parked';

/**
 * Bind filter that binds EVERY connected instance (plan 12, multi-bind) instead
 * of narrowing to one. `--browser all` / `GHAX_BRIDGE_BROWSER=all`.
 */
export const BIND_ALL = 'all';

/**
 * Outcome of the first-bind selection (plan 11, phase 1).
 *   idle         — no hello yet
 *   settling     — first hello landed, waiting GHAX_BRIDGE_SETTLE_MS for others
 *   bound        — exactly one candidate matched and was bound (or `bridge use`)
 *   no-candidate — the window closed and no connected instance matched --browser
 *   ambiguous    — more than one matched; nothing binds until `bridge use`
 */
export type BridgeSelectionState = 'idle' | 'settling' | 'bound' | 'no-candidate' | 'ambiguous';

/** One instance as the selection saw it when the settle window closed. */
export interface BridgeCandidate {
  instanceId: string;
  browser: string;
  label: string;
  /** The bridge port the instance reached — this daemon's. */
  port: number;
  connected: boolean;
  /** Passed the --browser filter (always true when there is no filter). */
  matches: boolean;
}

export interface BridgeSelection {
  state: BridgeSelectionState;
  code?: 'BRIDGE_NO_CANDIDATE' | 'BRIDGE_AMBIGUOUS';
  message?: string;
  /** The --browser filter in force when the window closed, or null. */
  filter?: string | null;
  /** Every instance seen when the window closed, matching or not. */
  instances?: BridgeCandidate[];
}

/** A connected extension instance, as reported by `ghax bridge instances`. */
export interface BridgeInstance {
  instanceId: string;
  browser: string;
  label: string;
  /**
   * Popup "Profile name" (hello.profile, else hello.label), else the
   * browser's own name for the profile (`profileSource: 'browser'`).
   */
  profile: string;
  /** Where `profile` came from: the popup label, the browser's profile data, or nowhere. */
  profileSource: ProfileSource;
  /** Tab-id prefix for this instance: `<alias>:<chromeTabId>`. */
  alias: string;
  /** Browser major version from the extension, '' if it did not say. */
  brandVersion: string;
  version: string;
  gitSha: string;
  buildDate: string;
  role: PeerRole;
  connected: boolean;
  controlledTabId: number | null;
  lastHelloAt: number;
  helloCount: number;
  replacedCount: number;
}

export type ProfileSource = 'label' | 'browser' | 'none';

export interface Peer {
  instanceId: string;
  browser: string;
  label: string;
  profile: string;
  profileSource: ProfileSource;
  /** chrome.runtime.id from hello; '' from extensions predating it. */
  extensionId: string;
  brandVersion: string;
  version: string;
  gitSha: string;
  buildDate: string;
  ws: WebSocket | null;
  role: PeerRole;
  lastHelloAt: number;
  lastFrameAt: number;
  helloCount: number;
  replacedCount: number;
  controlledTabId: number | null;
  /** hello.sessionNonce: new per browser session; '' for older extensions. */
  sessionNonce: string;
  /** Alias handed out while live; kept so it never flips under a bound id. */
  pinnedAlias: string | null;
  /** Hello carried no instanceId (pre-v2 extension); the id is synthetic. */
  legacy: boolean;
}

export class PeerRegistry {
  // Exactly one peer is `bound` (Bridge tracks which); every other healthy
  // peer is `parked` — socket held OPEN, pinging, discoverable, but holding no
  // chrome.debugger attachment and receiving no CDP. Holding the socket IS the
  // livelock cure: the rival's reconnect loop is satisfied instead of
  // retriggered. If we ever closed a parked socket, background.js's reconnect
  // loop would resume and the ping-pong would simply move.
  private peers = new Map<string, Peer>();
  private socketPeer = new WeakMap<WebSocket, Peer>();
  private legacySeq = 0;

  constructor(
    private readonly log: (msg: string) => void,
    private readonly lookupProfile: ProfileLookup = defaultProfileLookup,
  ) {}

  get(instanceId: string): Peer | undefined {
    return this.peers.get(instanceId);
  }

  all(): Peer[] {
    return [...this.peers.values()];
  }

  /** The peer that owns this socket, if it has said hello on it. */
  forSocket(ws: WebSocket): Peer | undefined {
    return this.socketPeer.get(ws);
  }

  shortId(id: string | null): string {
    return id ? id.slice(0, 6) : '?';
  }

  describePeer(p: Peer | null): string {
    if (!p) return 'unknown';
    const label = p.label ? ` "${p.label}"` : '';
    return `${p.browser || 'browser'}·${this.shortId(p.instanceId)}${label}`;
  }

  matchesFilter(p: Peer, filter: string | null): boolean {
    return !filter
      || filter === BIND_ALL
      || p.browser.toLowerCase() === filter
      || p.label.toLowerCase() === filter
      || (p.profile !== '' && p.profile.toLowerCase() === filter);
  }

  /**
   * Close the selection: pick exactly one matching connected instance, or
   * record why not. Never takes [0] of several (target-verification rule):
   * more than one candidate refuses and lists them. Pure — no timers, no
   * logging; `winners` holds the single winner, or is empty. Under the
   * BIND_ALL filter every connected instance wins.
   */
  decide(filter: string | null, port: number): { selection: BridgeSelection; winners: Peer[] } {
    const seen = this.all();
    const instances: BridgeCandidate[] = seen.map((p) => ({
      instanceId: p.instanceId,
      browser: p.browser,
      label: p.label,
      port,
      connected: p.ws?.readyState === WebSocket.OPEN,
      matches: this.matchesFilter(p, filter),
    }));
    const candidates = seen.filter((p) => p.ws?.readyState === WebSocket.OPEN && this.matchesFilter(p, filter));
    const list = instances.map((i) => `${i.browser || '?'} · ${i.label || '-'} · ${i.instanceId} · :${i.port}`).join('; ');
    // `all` asked for every candidate by name, so several is the answer, not
    // an ambiguity. Zero still refuses below.
    if (candidates.length === 1 || (filter === BIND_ALL && candidates.length > 1)) {
      return { selection: { state: 'bound', filter, instances }, winners: candidates };
    }
    if (candidates.length === 0) {
      const message = filter
        ? `BRIDGE_NO_CANDIDATE: no connected browser matches --browser ${filter} (seen: ${list || 'none'})`
        : `BRIDGE_NO_CANDIDATE: no connected browser (seen: ${list || 'none'})`;
      return {
        selection: { state: 'no-candidate', code: 'BRIDGE_NO_CANDIDATE', message, filter, instances },
        winners: [],
      };
    }
    const why = filter
      ? `${candidates.length} browsers match --browser ${filter}; give each a distinct label in the extension popup`
      : `${candidates.length} browsers connected and no --browser to pick one`;
    const message = `BRIDGE_AMBIGUOUS: ${why} (${list}). Nothing is bound until \`ghax bridge use <id|browser|label>\``;
    return {
      selection: { state: 'ambiguous', code: 'BRIDGE_AMBIGUOUS', message, filter, instances },
      winners: [],
    };
  }

  /**
   * Every peer a selector names: instanceId prefix, browser brand, label, or
   * the tab-id alias. Callers decide what 0 or >1 means.
   */
  match(selector: string): Peer[] {
    const want = selector.trim().toLowerCase();
    return this.all().filter(
      (p) => p.instanceId.toLowerCase().startsWith(want)
        || p.browser.toLowerCase() === want
        || p.label.toLowerCase() === want
        || (p.profile !== '' && p.profile.toLowerCase() === want)
        // The tab-id prefix, so a refusal's `ghax bridge use <alias>` works.
        || this.aliasOf(p.instanceId) === want,
    );
  }

  /** Snapshot of every known instance — backs `ghax bridge instances`. */
  instances(): BridgeInstance[] {
    return this.all().map((p) => ({
      instanceId: p.instanceId,
      browser: p.browser,
      label: p.label,
      profile: p.profile,
      profileSource: p.profileSource,
      alias: this.aliasOf(p.instanceId),
      brandVersion: p.brandVersion,
      version: p.version,
      gitSha: p.gitSha,
      buildDate: p.buildDate,
      role: p.role,
      connected: p.ws?.readyState === WebSocket.OPEN,
      controlledTabId: p.controlledTabId,
      lastHelloAt: p.lastHelloAt,
      helloCount: p.helloCount,
      replacedCount: p.replacedCount,
    }));
  }

  /**
   * Tab-id alias for an instance (see src/tab-identity.ts). Recomputed on
   * every call against all known peers, so a second browser with the same
   * profile name pushes both onto the `<name>-<short6>` form.
   */
  aliasOf(instanceId: string): string {
    const self = this.peers.get(instanceId);
    if (!self) return mintAliases([{ instanceId, browser: '', profile: '' }]).get(instanceId)!;
    if (self.pinnedAlias) return self.pinnedAlias;
    // Only live peers can clash: a gone one is not in the tab listings, and
    // counting it would flip a live alias when it reconnects.
    const pinned = new Map<string, string>();
    const all = [self];
    for (const p of this.peers.values()) {
      if (p === self || p.ws === null) continue;
      if (p.pinnedAlias) pinned.set(p.instanceId, p.pinnedAlias);
      all.push(p);
    }
    const alias = mintAliases(
      all.map((p) => ({ instanceId: p.instanceId, browser: p.browser, profile: p.profile })),
      pinned,
    ).get(instanceId)!;
    if (self.ws !== null) self.pinnedAlias = alias;
    return alias;
  }

  /** browser / profile / alias of one instance, for tab listings. */
  identityOf(instanceId: string): { instanceId: string; browser: string; profile: string; alias: string; nonce: string } | null {
    const p = this.peers.get(instanceId);
    if (!p) return null;
    return { instanceId, browser: p.browser, profile: p.profile, alias: this.aliasOf(instanceId), nonce: p.sessionNonce };
  }

  /**
   * Hello intake: find or create the peer, fold the hello's fields into it and
   * attach the socket. Returns `restarted` so Bridge can emit `peer-restart`.
   * Role/bind decisions are Bridge's.
   */
  upsertFromHello(msg: any, ws: WebSocket): { peer: Peer; restarted: boolean } {
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
    // Free text from the browser, shown in listings and refusals: cleaned and
    // capped here, once, so nothing downstream has to remember to.
    const browser = typeof msg.browser === 'string' ? sanitizeLabel(msg.browser) : '';
    const label = typeof msg.label === 'string' ? sanitizeLabel(msg.label) : '';
    // `profile` is the tab-identity name for the same popup field; extensions
    // predating it send only `label`, which carries the same value.
    const extensionId = typeof msg.extensionId === 'string' && /^[a-p]{32}$/.test(msg.extensionId) ? msg.extensionId : '';
    const labelled = typeof msg.profile === 'string' ? sanitizeLabel(msg.profile) : label;
    // No popup label: the browser's own name for the profile, when exactly
    // one profile on disk holds this instance's storage. A label always wins.
    const auto = labelled || legacy ? '' : sanitizeLabel(this.lookupProfile(instanceId, browser, extensionId));
    const profile = labelled || auto;
    const profileSource: ProfileSource = labelled ? 'label' : auto ? 'browser' : 'none';
    const sessionNonce = typeof msg.sessionNonce === 'string' ? msg.sessionNonce.slice(0, 64) : '';
    const brandVersion = typeof msg.brandVersion === 'string' ? msg.brandVersion : '';
    const version = typeof msg.version === 'string' ? msg.version : '?';
    // Optional — absent on any extension build predating the provenance
    // change. 'unknown' is the same sentinel build-info.ts/build.rs use.
    const gitSha = typeof msg.gitSha === 'string' && msg.gitSha ? msg.gitSha : 'unknown';
    const buildDate = typeof msg.buildDate === 'string' && msg.buildDate ? msg.buildDate : 'unknown';

    let peer = this.peers.get(instanceId);
    if (!peer) {
      peer = {
        instanceId, browser, label, profile, profileSource, extensionId, brandVersion, version, gitSha, buildDate,
        ws: null, role: 'parked',
        lastHelloAt: 0, lastFrameAt: Date.now(),
        helloCount: 0, replacedCount: 0, controlledTabId: null,
        sessionNonce, pinnedAlias: null, legacy,
      };
      this.peers.set(instanceId, peer);
    }
    // A new browser session (or an extension that cannot say) behind a known
    // instance: tab numbers from before are void, so anything holding a
    // listing of it must drop it.
    const restarted = peer.helloCount > 0 && (!sessionNonce || peer.sessionNonce !== sessionNonce);
    peer.sessionNonce = sessionNonce;
    if (profile && profile !== peer.profile) peer.pinnedAlias = null;
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
    peer.profile = profile || peer.profile;
    if (profile) peer.profileSource = profileSource;
    peer.extensionId = extensionId || peer.extensionId;
    peer.brandVersion = brandVersion || peer.brandVersion;
    peer.version = version;
    peer.gitSha = gitSha;
    peer.buildDate = buildDate;
    peer.helloCount++;
    peer.lastHelloAt = Date.now();
    peer.lastFrameAt = Date.now();
    peer.controlledTabId = typeof msg.controlledTabId === 'number' ? msg.controlledTabId : null;
    this.socketPeer.set(ws, peer);
    return { peer, restarted };
  }
}
