/**
 * Per-peer page state for the bridge transport (plan 12, brief B).
 *
 * Under `--browser all` several browsers are bound at once, and each one's
 * tab has its own main frame, execution contexts, load timing and in-flight
 * requests. Those live here, keyed by instanceId, so one browser's navigation
 * can never wipe or poison another's bookkeeping.
 *
 * Daemon-wide state (console/network buffers, refs, the active page) stays in
 * the daemon. Buffers take every peer's entries, each tagged with its tab id;
 * anything that clears refs is the daemon's call, made only for the ACTIVE
 * peer (CLAUDE.md invariant 3) through `onActiveMainFrameNavigated`.
 */

import type { Bridge, BridgeEvent } from './bridge';
import { parseStack, type CircularBuffer, type ConsoleEntry, type NetworkEntry } from './buffers';

export const BODY_CAP_BYTES = 32 * 1024;

// Content-type gate shared by request- and response-body capture: only
// capture bodies that are plausibly JSON/text (GraphQL mutations included
// — most send `application/json`, but some servers reply/accept
// `application/graphql`). Binary payloads (images, video, octet-stream)
// are skipped even when the URL matches the glob.
export const CAPTURABLE_CONTENT_TYPE_RE = /json|text|javascript|xml|html|css|graphql/;

// Apply the shared 32KB cap + truncation marker to a body string. Used by
// both response and request capture so the two stay byte-for-byte
// consistent.
export function capBody(body: string): { text: string; truncated: boolean } {
  if (body.length > BODY_CAP_BYTES) {
    return {
      text: body.slice(0, BODY_CAP_BYTES) + `\n[truncated ${body.length - BODY_CAP_BYTES} bytes]`,
      truncated: true,
    };
  }
  return { text: body, truncated: false };
}

/** One bound browser's view of its controlled tab. */
export interface PeerPageState {
  // Execution-context tracking (plan §2.5). `chrome.debugger` attaches to the
  // tab's top-level target, so we only ever see the main frame — this is NOT
  // frame selection. It exists to stop `Runtime.evaluate` landing on a
  // document that navigation already destroyed.
  mainFrameId: string | null;
  // frameId → the frame's DEFAULT execution context. `uniqueId` is preferred
  // over the numeric id, which Chromium reuses across navigations.
  contexts: Map<string, { uniqueId: string; id: number }>;
  // Timestamp of the last main-frame load event, so read verbs can tell
  // "small page" from "page still settling" (suspicious-empty, §2.6).
  lastLoadAt: number;
  // requestId → entry, for requests still in flight.
  networkRequests: Map<string, NetworkEntry>;
}

export function newPeerPageState(): PeerPageState {
  return { mainFrameId: null, contexts: new Map(), lastLoadAt: 0, networkRequests: new Map() };
}

type Listener = (entry: unknown) => void;

/** The slice of the daemon's Ctx this module reads and writes. */
export interface BridgePageSink {
  bridgePeers: Map<string, PeerPageState>;
  consoleBuf: CircularBuffer<ConsoleEntry>;
  networkBuf: CircularBuffer<NetworkEntry>;
  consoleListeners: Set<Listener>;
  networkListeners: Set<Listener>;
  captureBodiesRe: RegExp | null;
}

export interface BridgePageHooks {
  /** Composite tab id (`<alias>:<n>`) for a peer's chrome tab. */
  tabIdOf(instanceId: string, chromeTabId: number): string;
  /** The ACTIVE peer's main frame navigated: every @ref is dead. */
  onActiveMainFrameNavigated(): void;
}

/** A peer's state, created on first use. */
export function peerState(sink: Pick<BridgePageSink, 'bridgePeers'>, instanceId: string): PeerPageState {
  let st = sink.bridgePeers.get(instanceId);
  if (!st) {
    st = newPeerPageState();
    sink.bridgePeers.set(instanceId, st);
  }
  return st;
}

/**
 * The state verbs read: the active peer's. With nothing bound it is a
 * throwaway empty state, so readers never need a null check and never
 * create an entry for a peer that does not exist.
 */
export function activePeerState(sink: Pick<BridgePageSink, 'bridgePeers'>, bridge: Bridge): PeerPageState {
  const id = bridge.boundInstanceId;
  return id ? peerState(sink, id) : newPeerPageState();
}

/** The main frame's live default context in one peer's tab, or null. */
export function pickMainFrameContext(st: PeerPageState): string | null {
  if (st.mainFrameId) {
    const hit = st.contexts.get(st.mainFrameId);
    if (hit) return hit.uniqueId;
  }
  // No main frame id yet (e.g. attached mid-session, before any
  // frameNavigated). Exactly one tracked context is unambiguous.
  if (st.contexts.size === 1) return [...st.contexts.values()][0].uniqueId;
  return null;
}

function remoteObjectText(value: unknown): string {
  const obj = value as { value?: unknown; description?: string; unserializableValue?: string };
  if (obj.value !== undefined) {
    if (typeof obj.value === 'string') return obj.value;
    try { return JSON.stringify(obj.value); } catch { return String(obj.value); }
  }
  return obj.unserializableValue ?? obj.description ?? '';
}

function bridgeTimestamp(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return Date.now();
  return n > 10_000_000_000 ? n : Math.round(n * 1000);
}

function bridgeHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

/**
 * Consume EVERY bound peer's relayed events into that peer's state and the
 * shared buffers, and keep per-peer state in step with the peer lifecycle.
 */
export function wireBridgePageEvents(bridge: Bridge, sink: BridgePageSink, hooks: BridgePageHooks): void {
  // A peer's tab changed: its in-flight requests belong to the old tab.
  bridge.on('controlled', (_tabId: number | null, instanceId: string) => {
    sink.bridgePeers.get(instanceId)?.networkRequests.clear();
  });
  // A dropped or expired peer's frames and contexts are gone with its
  // debugger session; a reconnect re-announces them.
  bridge.on('disconnect', (instanceId: string) => { sink.bridgePeers.delete(instanceId); });
  bridge.on('expired', (instanceId: string) => { sink.bridgePeers.delete(instanceId); });
  // Membership changed (a single-browser `use` swaps the bound peer without a
  // disconnect): forget anyone no longer bound.
  bridge.on('instances', () => {
    const bound = new Set(bridge.boundIds);
    for (const id of sink.bridgePeers.keys()) if (!bound.has(id)) sink.bridgePeers.delete(id);
  });

  const pushConsole = (entry: ConsoleEntry) => {
    sink.consoleBuf.push(entry);
    for (const listener of sink.consoleListeners) listener(entry);
  };

  bridge.onEvent((ev: BridgeEvent) => {
    const instanceId = ev.instanceId;
    if (!instanceId) return;
    const st = peerState(sink, instanceId);
    const tag = typeof ev.tabId === 'number' ? { tabId: hooks.tabIdOf(instanceId, ev.tabId) } : {};
    const p = ev.params as any;
    // ─── Execution-context bookkeeping (plan §2.5) ────────────
    // Track, don't guess: knowing the live main-frame context is what stops
    // a read from executing against a document navigation already replaced.
    if (ev.method === 'Runtime.executionContextCreated') {
      const c = p.context ?? {};
      const aux = c.auxData ?? {};
      // Only the frame's DEFAULT context (i.e. not an isolated world /
      // content-script sandbox) sees the page's own JS state.
      if (aux.isDefault && typeof aux.frameId === 'string' && typeof c.uniqueId === 'string') {
        st.contexts.set(aux.frameId, { uniqueId: c.uniqueId, id: Number(c.id) });
      }
      return;
    }
    if (ev.method === 'Runtime.executionContextDestroyed') {
      const goneUnique = typeof p.executionContextUniqueId === 'string' ? p.executionContextUniqueId : null;
      const goneId = typeof p.executionContextId === 'number' ? p.executionContextId : null;
      for (const [frameId, entry] of st.contexts) {
        if ((goneUnique && entry.uniqueId === goneUnique) || (goneId !== null && entry.id === goneId)) {
          st.contexts.delete(frameId);
        }
      }
      return;
    }
    if (ev.method === 'Runtime.executionContextsCleared') {
      st.contexts.clear();
      return;
    }
    if (ev.method === 'Page.frameNavigated') {
      const frame = p.frame ?? {};
      // A main-frame navigation invalidates every context this peer knew
      // about. It also kills every @ref, but refs are the ACTIVE tab's, so
      // only the active peer's navigation clears them (invariant 3).
      if (typeof frame.id === 'string' && !frame.parentId) {
        st.mainFrameId = frame.id;
        st.contexts.clear();
        if (instanceId === bridge.boundInstanceId) hooks.onActiveMainFrameNavigated();
      }
      return;
    }
    if (ev.method === 'Page.loadEventFired') {
      st.lastLoadAt = Date.now();
      return;
    }
    if (ev.method === 'Runtime.consoleAPICalled') {
      const levels: Record<string, ConsoleEntry['level']> = {
        log: 'log', info: 'info', warning: 'warn', error: 'error', debug: 'debug', verbose: 'debug', trace: 'trace', assert: 'error',
      };
      const frame = p.stackTrace?.callFrames?.[0];
      pushConsole({
        timestamp: bridgeTimestamp(p.timestamp),
        level: levels[String(p.type)] ?? 'log',
        text: Array.isArray(p.args) ? p.args.map(remoteObjectText).join(' ') : '',
        ...(frame?.url ? { url: String(frame.url) } : {}),
        source: 'tab',
        ...tag,
      });
      return;
    }
    if (ev.method === 'Runtime.exceptionThrown') {
      const details = p.exceptionDetails ?? {};
      const description = details.exception?.description ?? details.text ?? 'Uncaught exception';
      const stack = parseStack(String(description));
      pushConsole({
        timestamp: bridgeTimestamp(p.timestamp),
        level: 'error',
        text: `[pageerror] ${String(details.exception?.description ?? details.text ?? 'Uncaught exception').split('\n')[0]}`,
        ...(details.url ? { url: String(details.url) } : {}),
        source: 'tab',
        ...(stack.length > 0 ? { stack } : {}),
        ...tag,
      });
      return;
    }
    if (ev.method === 'Log.entryAdded') {
      const logEntry = p.entry ?? {};
      const rawLevel = String(logEntry.level ?? 'log');
      const level: ConsoleEntry['level'] = rawLevel === 'warning' ? 'warn' :
        (['log', 'info', 'warn', 'error', 'debug', 'trace'].includes(rawLevel) ? rawLevel : 'log') as ConsoleEntry['level'];
      pushConsole({
        timestamp: bridgeTimestamp(logEntry.timestamp),
        level,
        text: String(logEntry.text ?? ''),
        ...(logEntry.url ? { url: String(logEntry.url) } : {}),
        source: 'tab',
        ...tag,
      });
      return;
    }
    if (ev.method === 'Network.requestWillBeSent') {
      const request = p.request ?? {};
      const entry: NetworkEntry = {
        timestamp: Date.now(),
        method: String(request.method ?? 'GET'),
        url: String(request.url ?? ''),
        resourceType: p.type ? String(p.type).toLowerCase() : undefined,
        requestHeaders: bridgeHeaders(request.headers),
        ...tag,
      };
      if (request.postData !== undefined && sink.captureBodiesRe?.test(entry.url)) {
        const ct = entry.requestHeaders?.['content-type'] ?? '';
        if (CAPTURABLE_CONTENT_TYPE_RE.test(ct)) {
          const capped = capBody(String(request.postData));
          entry.requestBody = capped.text;
          if (capped.truncated) entry.requestBodyTruncated = true;
        }
      }
      sink.networkBuf.push(entry);
      st.networkRequests.set(String(p.requestId), entry);
      for (const listener of sink.networkListeners) listener(entry);
      return;
    }
    if (ev.method === 'Network.responseReceived') {
      const entry = st.networkRequests.get(String(p.requestId));
      if (!entry) return;
      const response = p.response ?? {};
      entry.status = Number(response.status ?? 0);
      entry.statusText = String(response.statusText ?? '');
      entry.responseHeaders = bridgeHeaders(response.headers);
      entry.responseAt = Date.now();
      entry.duration = entry.responseAt - entry.timestamp;
      return;
    }
    if (ev.method === 'Network.loadingFinished' || ev.method === 'Network.loadingFailed') {
      const requestId = String(p.requestId);
      const entry = st.networkRequests.get(requestId);
      if (entry) {
        entry.responseAt ??= Date.now();
        entry.duration ??= entry.responseAt - entry.timestamp;
        if (ev.method === 'Network.loadingFinished' && typeof p.encodedDataLength === 'number') entry.size = p.encodedDataLength;
        if (ev.method === 'Network.loadingFailed' && !entry.statusText) entry.statusText = String(p.errorText ?? 'failed');
        if (
          ev.method === 'Network.loadingFinished' &&
          sink.captureBodiesRe?.test(entry.url) &&
          CAPTURABLE_CONTENT_TYPE_RE.test(entry.responseHeaders?.['content-type'] ?? '')
        ) {
          // The body lives in the browser that made the request, which need
          // not be the active one.
          void bridge.send('Network.getResponseBody', { requestId }, undefined, { peer: instanceId }).then((bodyResult) => {
            const body = bodyResult as { body?: string; base64Encoded?: boolean };
            if (typeof body.body !== 'string' || body.base64Encoded) return;
            const capped = capBody(body.body);
            entry.responseBody = capped.text;
            if (capped.truncated) entry.responseBodyTruncated = true;
          }).catch(() => undefined);
        }
      }
      st.networkRequests.delete(requestId);
    }
  });
}
