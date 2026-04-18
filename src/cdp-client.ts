/**
 * Minimal raw CDP client.
 *
 * Playwright handles normal tabs for us. This module exists for target
 * types Playwright doesn't expose well: service workers, sidepanels,
 * options pages, popup pages, and real-gesture input dispatch.
 *
 * Two entry points:
 *   - listTargets(httpUrl)  → GET /json/list
 *   - CdpTarget             → one WebSocket per target, request/response
 *                              with auto-incrementing id
 *
 * For gestures on the *browser* (not a specific target), connect to the
 * browser endpoint from /json/version's webSocketDebuggerUrl.
 */

export type CdpTargetType =
  | 'page'
  | 'background_page'
  | 'service_worker'
  | 'iframe'
  | 'webview'
  | 'worker'
  | 'shared_worker'
  | 'browser'
  | 'other';

export interface CdpTargetInfo {
  id: string;
  type: CdpTargetType;
  title: string;
  url: string;
  attached?: boolean;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  faviconUrl?: string;
  // Extension-related — Chrome sets these for chrome-extension:// targets
  extensionId?: string;
}

export interface CdpMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  sessionId?: string;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export async function listTargets(httpUrl: string): Promise<CdpTargetInfo[]> {
  const resp = await fetch(`${httpUrl}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) throw new Error(`/json/list failed: ${resp.status}`);
  const targets = (await resp.json()) as CdpTargetInfo[];
  for (const t of targets) {
    if (t.url.startsWith('chrome-extension://')) {
      const m = t.url.match(/^chrome-extension:\/\/([a-z0-9]+)/);
      if (m) t.extensionId = m[1];
    }
  }
  return targets;
}

export class CdpTarget {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners: Array<(ev: CdpEvent) => void> = [];
  private connectPromise: Promise<void> | null = null;

  constructor(public readonly url: string) {}

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const onOpen = () => {
        ws.removeEventListener('error', onError);
        resolve();
      };
      const onError = (e: Event) => {
        ws.removeEventListener('open', onOpen);
        reject(new Error(`CDP WebSocket error: ${(e as any).message ?? 'unknown'}`));
      };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev.data as string));
      ws.addEventListener('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('CDP WebSocket closed'));
        this.pending.clear();
        this.ws = null;
        this.connectPromise = null;
      });
    });

    return this.connectPromise;
  }

  private onMessage(raw: string) {
    let msg: CdpResponse | CdpEvent;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if ('id' in msg && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else p.resolve(msg.result);
    } else if ('method' in msg) {
      for (const l of this.listeners) {
        try {
          l(msg as CdpEvent);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP not connected'));
    }
    const id = this.nextId++;
    const msg: CdpMessage = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify(msg));
    });
  }

  on(listener: (ev: CdpEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/**
 * Per-target connection pool. Connections are lazy and reused.
 * Call pool.close() on daemon shutdown.
 */
export class CdpPool {
  private targets = new Map<string, CdpTarget>();

  constructor(private readonly httpUrl: string) {}

  async list(): Promise<CdpTargetInfo[]> {
    return listTargets(this.httpUrl);
  }

  async findByExtensionId(extensionId: string, type?: CdpTargetType): Promise<CdpTargetInfo[]> {
    const all = await this.list();
    return all.filter(
      (t) => t.extensionId === extensionId && (!type || t.type === type),
    );
  }

  /**
   * Returns the cached (or newly opened) CdpTarget for a given targetId.
   * `info` must carry a webSocketDebuggerUrl.
   */
  async get(info: Pick<CdpTargetInfo, 'id' | 'webSocketDebuggerUrl'>): Promise<CdpTarget> {
    let t = this.targets.get(info.id);
    if (t && t.connected) return t;
    if (!info.webSocketDebuggerUrl) {
      throw new Error(`Target ${info.id} has no webSocketDebuggerUrl (already attached?)`);
    }
    t = new CdpTarget(info.webSocketDebuggerUrl);
    await t.connect();
    this.targets.set(info.id, t);
    return t;
  }

  close() {
    for (const t of this.targets.values()) t.close();
    this.targets.clear();
  }
}
