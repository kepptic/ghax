/**
 * Per-method CDP call counters.
 *
 * Why: the bridge relays every CDP command through an MV3 service worker, so
 * each call costs a WebSocket hop plus a chrome.debugger dispatch. "Why is
 * this verb slow" was unanswerable without knowing how many calls it made and
 * which ones dominated. One `CdpStats` lives on the Bridge (every relayed
 * call) and one module-level instance counts the daemon-owned CDP sessions on
 * the Playwright transport. `ghax bridge stats` reads the former; `--trace`
 * diffs whichever applies around a single RPC.
 */

export interface CdpMethodStats {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

export interface CdpStatsSnapshot {
  since: number;
  methods: Record<string, CdpMethodStats>;
}

export interface CdpTraceDelta {
  cdpCalls: number;
  cdpMs: number;
  byMethod: Record<string, { calls: number; errors: number; ms: number }>;
}

export class CdpStats {
  private map = new Map<string, CdpMethodStats>();
  private sinceMs = Date.now();

  record(method: string, ms: number, error: boolean): void {
    let s = this.map.get(method);
    if (!s) {
      s = { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
      this.map.set(method, s);
    }
    s.calls++;
    if (error) s.errors++;
    s.totalMs += ms;
    if (ms > s.maxMs) s.maxMs = ms;
  }

  /** Time a promise-returning call and record it when it settles. */
  track<T>(method: string, p: Promise<T>): Promise<T> {
    const started = performance.now();
    p.then(
      () => this.record(method, performance.now() - started, false),
      () => this.record(method, performance.now() - started, true),
    );
    return p;
  }

  snapshot(): CdpStatsSnapshot {
    const methods: Record<string, CdpMethodStats> = {};
    for (const [k, v] of this.map) methods[k] = { ...v };
    return { since: this.sinceMs, methods };
  }

  reset(): void {
    this.map.clear();
    this.sinceMs = Date.now();
  }
}

/** Calls made between two snapshots of the same CdpStats. */
export function diffStats(before: CdpStatsSnapshot, after: CdpStatsSnapshot): CdpTraceDelta {
  const byMethod: CdpTraceDelta['byMethod'] = {};
  let cdpCalls = 0;
  let cdpMs = 0;
  for (const [method, a] of Object.entries(after.methods)) {
    const b = before.since === after.since ? before.methods[method] : undefined;
    const calls = a.calls - (b?.calls ?? 0);
    if (calls <= 0) continue;
    const ms = a.totalMs - (b?.totalMs ?? 0);
    byMethod[method] = { calls, errors: a.errors - (b?.errors ?? 0), ms: Math.round(ms * 10) / 10 };
    cdpCalls += calls;
    cdpMs += ms;
  }
  return { cdpCalls, cdpMs: Math.round(cdpMs * 10) / 10, byMethod };
}

/**
 * Counts for CDP sessions the daemon opens itself on the Playwright
 * transport. Playwright's own internal traffic is not visible here: hooking it
 * would mean patching its private connection object.
 */
export const daemonCdpStats = new CdpStats();

/** Wrap a session-like object's `send` so every call lands in `stats`. */
export function traceSend<S extends { send: (...a: any[]) => Promise<any> }>(session: S, stats: CdpStats = daemonCdpStats): S {
  const original = session.send.bind(session);
  (session as { send: (...a: any[]) => Promise<any> }).send = (method: string, ...rest: any[]) =>
    stats.track(String(method), original(method, ...rest));
  return session;
}
