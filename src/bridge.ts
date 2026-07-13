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
 * The bridge is deliberately page-scoped: one controlled tab at a time.
 * Browser-level operations (tab enumeration/switching/window creation) use
 * the adjacent control channel implemented by extension/background.js.
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
  active: boolean;
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
        if (msg.ok) p.resolve({
          ok: true,
          tabId: typeof msg.tabId === 'number' ? msg.tabId : null,
          ...(msg.result !== undefined ? { result: msg.result } : {}),
        });
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
    if (target.action === 'stop') this.desiredControl = null;
    else if (target.action === 'control-active') this.desiredControl = target;
    else if (target.action === 'control-tab') this.desiredControl = { ...target, quiet: true };
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
