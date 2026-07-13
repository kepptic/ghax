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
 *     {"id":<n>,"result":{...}} | {"id":<n>,"error":{"message":"..."}}
 *   extension -> daemon, a relayed chrome.debugger.onEvent:
 *     {"type":"event","method":"Page.loadEventFired","params":{...}}
 *
 * This is deliberately the same request/response/event shape as the raw
 * CDP client in cdp-client.ts (CdpTarget) — chrome.debugger.sendCommand
 * IS a CDP command dispatcher, so reusing that mental model means the
 * bridge "looks like" talking to a CdpTarget from the daemon's side.
 *
 * Scope (walking skeleton): exactly the commands `goto`/`eval`/`text` need
 * (Page.enable, Page.navigate, Runtime.evaluate) plus whatever events those
 * verbs listen for (Page.loadEventFired). No attempt at CDP-session/target
 * multiplexing, no reconnect-time command replay, no back-pressure — the
 * doc-comment at the top of daemon.ts's bridge branch says why.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';

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
  | { action: 'control-tab'; tabId: number }
  | { action: 'stop' };

export interface ControlAck {
  ok: boolean;
  tabId: number | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 10_000;

/**
 * One WebSocket server, at most one live extension connection at a time.
 * If a second connection arrives (e.g. the user reloaded the extension),
 * the old one is dropped — "latest wins" per the spec, logged so it's
 * visible in the daemon log rather than a silent swap.
 *
 * Emits:
 *   'hello'      (info: BridgeExtensionInfo)  — handshake received
 *   'disconnect' ()                            — extension socket closed
 *   'event'      (ev: BridgeEvent)             — relayed chrome.debugger.onEvent
 *   'controlled' (tabId: number | null)        — controlled tab changed
 */
export class Bridge extends EventEmitter {
  private wss: WebSocketServer;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  // Control-channel replies are correlated separately from CDP replies —
  // control messages carry `type:"control-ack"` so they never collide with
  // a `{id,result}` CDP reply in the numeric-id `pending` map.
  private controlNextId = 1;
  private controlPending = new Map<
    number,
    { resolve: (v: ControlAck) => void; reject: (e: Error) => void }
  >();
  private _connected = false;
  private _extensionInfo: BridgeExtensionInfo | null = null;
  private _controlledTabId: number | null = null;
  // The desired control target, remembered across reconnects so control
  // resumes automatically after an MV3 service-worker eviction (gap 3). Set
  // by `setDesiredControl` (env-driven initial control) or `sendControl`
  // (mid-session `ghax bridge control`); cleared by a `stop`.
  private desiredControl: ControlTarget | null = null;
  private readonly log: (msg: string) => void;

  constructor(
    public readonly port: number,
    log: (msg: string) => void = () => undefined,
  ) {
    super();
    this.log = log;
    this.wss = new WebSocketServer({ host: '127.0.0.1', port });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('error', (err) => this.log(`bridge: server error: ${String(err)}`));
  }

  /** True once the current connection has sent its `hello` handshake. */
  get connected(): boolean {
    return this._connected;
  }

  get extensionInfo(): BridgeExtensionInfo | null {
    return this._extensionInfo;
  }

  /** The tab the extension reports it's currently driving, or null. */
  get controlledTabId(): number | null {
    return this._controlledTabId;
  }

  private handleConnection(ws: WebSocket): void {
    if (this.ws) {
      this.log('bridge: new extension connection replacing existing one');
      this.rejectAllPending(new Error('bridge: extension connection replaced'));
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = ws;
    this._connected = false;
    this._extensionInfo = null;

    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', () => {
      if (this.ws !== ws) return; // already replaced
      this.ws = null;
      this._connected = false;
      this._extensionInfo = null;
      // The controlled tab is no longer reachable until the extension
      // reconnects; `desiredControl` is intentionally NOT cleared so the
      // next `hello` re-asserts it.
      this._controlledTabId = null;
      this.rejectAllPending(new Error('bridge: extension disconnected'));
      this.emit('disconnect');
    });
    ws.on('error', (err) => this.log(`bridge: socket error: ${String(err)}`));
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const p of this.controlPending.values()) p.reject(err);
    this.controlPending.clear();
  }

  private rawSend(obj: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg && msg.type === 'hello') {
      this._connected = true;
      this._extensionInfo = { agent: msg.agent, version: msg.version };
      this._controlledTabId = typeof msg.controlledTabId === 'number' ? msg.controlledTabId : null;
      this.log(`bridge: hello from ${msg.agent ?? 'unknown'} v${msg.version ?? '?'}`);
      this.emit('hello', this._extensionInfo);
      // Gap 3: re-assert the desired control target on every fresh
      // connection so control resumes automatically after an SW eviction.
      if (this.desiredControl && this.desiredControl.action !== 'stop') {
        const target = this.desiredControl;
        this.sendControl(target).catch((e) =>
          this.log(`bridge: re-assert control failed: ${String(e)}`),
        );
      }
      return;
    }
    // Keepalive: reply to the extension's ping so both sides see traffic;
    // ignore any pong. Neither disturbs id/reply correlation.
    if (msg && msg.type === 'ping') {
      this.rawSend({ type: 'pong' });
      return;
    }
    if (msg && msg.type === 'pong') return;
    if (msg && msg.type === 'controlled') {
      this._controlledTabId = typeof msg.tabId === 'number' ? msg.tabId : null;
      this.emit('controlled', this._controlledTabId);
      return;
    }
    if (msg && msg.type === 'control-ack') {
      const p = typeof msg.id === 'number' ? this.controlPending.get(msg.id) : undefined;
      if (typeof msg.id === 'number') this.controlPending.delete(msg.id);
      if (msg.ok && typeof msg.tabId === 'number') this._controlledTabId = msg.tabId;
      else if (msg.ok && msg.tabId === null) this._controlledTabId = null;
      if (p) {
        if (msg.ok) p.resolve({ ok: true, tabId: typeof msg.tabId === 'number' ? msg.tabId : null });
        else p.reject(new Error(msg.error || 'bridge: control failed'));
      }
      return;
    }
    if (msg && msg.type === 'event') {
      this.emit('event', { method: msg.method, params: msg.params ?? {} } as BridgeEvent);
      return;
    }
    if (msg && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'bridge command failed'));
      else p.resolve(msg.result);
      return;
    }
  }

  /**
   * Send one CDP command to the extension's controlled tab and await its
   * reply. Rejects immediately if no extension is connected (with a
   * message pointing the operator at the fix), or after `timeoutMs` with
   * no reply.
   */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this._connected) {
      return Promise.reject(
        new Error(
          'ghax bridge: no extension connected. Load extension/ unpacked, then click "Control this tab" in the ghax bridge popup.',
        ),
      );
    }
    const id = this.nextId++;
    const ws = this.ws;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
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
    this.desiredControl = target.action === 'stop' ? null : target;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this._connected) {
      return Promise.reject(
        new Error(
          'ghax bridge: no extension connected. Load extension/ unpacked (the ghax bridge extension) and make sure the browser is running.',
        ),
      );
    }
    const id = this.controlNextId++;
    const ws = this.ws;
    return new Promise<ControlAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlPending.delete(id);
        reject(new Error(`bridge: control(${target.action}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.controlPending.set(id, {
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
    this.rejectAllPending(new Error('bridge: shutting down'));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
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

/** `Runtime.evaluate` with the same flags `eval`/`text` need. */
export async function bridgeEvaluate(bridge: Bridge, expression: string): Promise<unknown> {
  const result = await bridge.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return unwrapEvalResult(result);
}

/**
 * `Page.navigate` + a short wait for `Page.loadEventFired` (falls back to a
 * fixed timeout so a page that never fires load — e.g. a download URL, or
 * one already mid-navigation — can't wedge the RPC forever), then reads
 * back the final URL + title via `Runtime.evaluate`.
 */
export async function bridgeGoto(
  bridge: Bridge,
  url: string,
  loadTimeoutMs = 8_000,
): Promise<{ url: string; title: string }> {
  await bridge.send('Page.enable', {});

  const waitForLoad = new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, loadTimeoutMs);
    const unsubscribe = bridge.onEvent((ev) => {
      if (ev.method === 'Page.loadEventFired') finish();
    });
  });

  await bridge.send('Page.navigate', { url });
  await waitForLoad;

  let finalUrl = url;
  let title = '';
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
