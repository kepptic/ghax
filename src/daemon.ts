/**
 * ghax daemon — persistent Node http server.
 *
 * Owns:
 *   - Playwright Browser (connected via chromium.connectOverCDP) — OR, in
 *     bridge mode (see below), a Bridge relaying CDP commands through an
 *     MV3 extension's chrome.debugger API instead.
 *   - Raw CDP pool for service workers / sidepanels / browser-level
 *   - Active tab pointer + last-snapshot ref map
 *   - Circular buffers for console + network
 *
 * Lifecycle:
 *   - Started by `ghax attach` with env:
 *       GHAX_STATE_FILE, GHAX_CDP_HTTP_URL, GHAX_CDP_BROWSER_URL,
 *       GHAX_BROWSER_KIND
 *   - Writes daemon pid + port to the state file on boot
 *   - Auto-shuts after IDLE_MS with no requests
 *   - Exits on SIGINT/SIGTERM cleanly
 *
 * HTTP surface:
 *   GET  /health         → quick liveness probe
 *   POST /rpc            → { cmd, args?, opts? } → { ok, data } | { ok:false, error }
 *   GET  /bridge-status   → bridge mode only: { connected, extensionInfo? }
 *   POST /shutdown        → exits
 *
 * Single-user localhost daemon, bound to 127.0.0.1. No auth in v0.1.
 *
 * ── Bridge mode (experimental, `ghax attach --extension`) ──────────────
 *
 * Since Edge 150 / Chrome 136, `--remote-debugging-port` is silently
 * ignored on the browser's default profile, so `chromium.connectOverCDP`
 * can no longer reach the user's real, already-logged-in session — only a
 * scratch profile ghax launches itself. When `GHAX_BRIDGE=1` is set, this
 * daemon skips `connectOverCDP` entirely and instead starts a `Bridge`
 * (see bridge.ts) — a small WebSocket server an MV3 extension connects to,
 * relaying CDP commands via `chrome.debugger` (which the socket
 * restriction does not affect). Page operations use raw CDP and browser
 * tab/window operations use the extension's adjacent control channel.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Locator, type CDPSession } from 'playwright';
import { CdpPool, type CdpTarget, type CdpTargetInfo } from './cdp-client';
import { resolveConfig, type DaemonState, writeState, readState } from './config';
import { CircularBuffer, parseStack, type ConsoleEntry, type NetworkEntry } from './buffers';
import { SourceMapCache, resolveStack } from './source-maps';
import type { RefEntry } from './snapshot';
import { snapshot as takeSnapshot, MODAL_SEL } from './snapshot';
import {
  Bridge,
  BridgeInterrupted,
  bridgeBox,
  bridgeCallOn,
  bridgeEvaluate,
  bridgeGoto,
  bridgeResolveSelector,
  bridgeSnapshot,
  bridgeText,
  type BridgeRef,
  type BridgeTab,
  type ControlTarget,
} from './bridge';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';

const IDLE_MS = 30 * 60 * 1000;
const BUFFER_CAP = 5000;

interface RecordedStep {
  cmd: string;
  args: unknown[];
  opts: Record<string, unknown>;
  at: number;
}

interface Recording {
  name: string;
  startedAt: number;
  steps: RecordedStep[];
}

interface SwLogSubscription {
  targetId: string;
  buf: CircularBuffer<ConsoleEntry>;
}

type StreamListener = (entry: unknown) => void;

// A tracked file download. Populated from browser-level CDP
// `Browser.downloadWillBegin` / `Browser.downloadProgress` events.
interface DownloadEntry {
  guid: string;
  url: string;
  suggestedFilename: string;
  // Where the file is expected to land — downloadsDir + the final on-disk
  // name (which may differ from suggestedFilename if Chromium de-duped it
  // to `name (1).ext`). Resolved best-effort when the download completes.
  finalPath: string | null;
  state: 'inProgress' | 'completed' | 'canceled';
  totalBytes: number | null;
  receivedBytes: number | null;
  startedAt: number;
  updatedAt: number;
}

interface Ctx {
  // `null` in bridge mode (see the module doc comment above) — there is no
  // Playwright Browser/BrowserContext when the daemon is relaying CDP
  // through the extension instead of `connectOverCDP`.
  browser: Browser | null;
  context: BrowserContext | null;
  cdpHttpUrl: string;
  cdpBrowserUrl: string;
  browserKind: string;
  // Bridge-mode fields — see bridge.ts and the module doc comment above.
  bridgeMode: boolean;
  bridge: Bridge | null;
  pool: CdpPool;
  consoleBuf: CircularBuffer<ConsoleEntry>;
  networkBuf: CircularBuffer<NetworkEntry>;
  sourceMapCache: SourceMapCache;
  captureBodiesRe: RegExp | null;  // null = don't capture; set = capture URLs matching
  activePageId: string | null;
  refs: Map<string, RefEntry>;
  bridgeRefs: Map<string, BridgeRef>;
  bridgeNetworkRequests: Map<string, NetworkEntry>;
  instrumented: WeakSet<Page>;
  startedAt: number;
  stateDir: string;
  recording: Recording | null;
  swLogs: Map<string, SwLogSubscription>;
  consoleListeners: Set<StreamListener>;
  networkListeners: Set<StreamListener>;
  swLogListeners: Map<string, Set<StreamListener>>;
  // ── Download tracking ──────────────────────────────────────────
  // Directory downloads land in (the user's real ~/Downloads by default,
  // overridable via `ghax attach --downloads-dir`).
  downloadsDir: string;
  downloads: CircularBuffer<DownloadEntry>;
  // Long-lived browser-level CDP session we own. Playwright's connectOverCDP
  // hijacks download behaviour (allowAndName → GUID files in a temp dir);
  // we keep this session to re-assert sane behaviour and receive events.
  browserSession: CDPSession | null;
}

type Handler = (ctx: Ctx, args: unknown[], opts: Record<string, unknown>) => Promise<unknown>;

const handlers = new Map<string, Handler>();

// The bridge is page-scoped and intentionally does not emulate a browser
// debugging endpoint. Keep one explicit allow-list so any command that still
// depends on Playwright, /json/list, or browser-level CDP fails with a useful
// message instead of leaking a cryptic URL/parser error from those paths.
const BRIDGE_SUPPORTED_COMMANDS = new Set([
  'status', 'tabs', 'tab', 'find', 'newWindow',
  'goto', 'back', 'forward', 'reload', 'eval', 'text', 'html',
  'screenshot', 'snapshot', 'box', 'click', 'fill', 'press', 'type',
  'console', 'network', 'wait', 'bridge.control', 'bridge.instances', 'bridge.use',
  'batch', 'record.start', 'record.stop', 'record.status',
]);

/**
 * Verbs whose ENTIRE operation can be re-run after a bridge reconnect.
 *
 * Retry is classified per *operation*, never per CDP command: a verb like
 * `snapshot` enables domains, strips old ref tags, releases an object group,
 * reads the AX tree, then writes fresh tags (see bridgeSnapshot in bridge.ts).
 * Resuming from an interrupted middle command could splice two documents or
 * two ref generations together. Restarting the whole thing against a freshly
 * re-attached tab is safe; resuming a fragment is not.
 *
 * Everything absent from this set is NOT auto-replayed — see the failure
 * message in `register` below. That includes the obvious mutators (click,
 * fill, press, type, eval, newWindow, batch) and three less obvious ones:
 *   - `box` scrolls before measuring, which can trigger lazy-loading.
 *   - `goto`/`reload` re-run page lifecycle and can re-submit interstitials.
 *   - `back`/`forward` re-read currentIndex, so a naive replay can step TWO
 *     entries; correct handling is reconciliation against
 *     Page.getNavigationHistory, which the conservative "report unknown"
 *     path below is the honest subset of.
 * Console/network need no replay at all — they read daemon-local buffers.
 */
const BRIDGE_RETRY_SAFE = new Set([
  'status', 'tabs', 'find', 'text', 'html', 'screenshot', 'snapshot', 'wait',
]);

function register(name: string, fn: Handler) {
  handlers.set(name, async (ctx, args, opts) => {
    if (ctx.bridgeMode && !BRIDGE_SUPPORTED_COMMANDS.has(name)) {
      throw new Error(`${name}: not supported over the extension bridge yet`);
    }
    if (!ctx.bridgeMode) return fn(ctx, args, opts);
    try {
      return await fn(ctx, args, opts);
    } catch (err) {
      // The bound extension dropped mid-operation. Only the verb layer knows
      // whether re-running is safe, which is exactly why this lives here and
      // not in Bridge.send().
      if (err instanceof BridgeInterrupted) {
        if (BRIDGE_RETRY_SAFE.has(name)) {
          await requireBridge(ctx).waitForResume();
          // Whole-operation replay against the re-attached tab.
          return await fn(ctx, args, opts);
        }
        const e = new Error(
          `${name}: the bridge connection dropped mid-command — the action MAY have landed. ` +
          `Run \`ghax snapshot\` to check the page state before retrying.`,
        );
        (e as any).code = 'BRIDGE_OUTCOME_UNKNOWN';
        (e as any).hint = 'Verify the page with `ghax snapshot`; ghax will not replay an action that may have mutated the page.';
        throw e;
      }
      // Decorate recognized failures (unattachable tab, no extension) with a
      // code + recovery hint. Unrecognized errors pass through unchanged.
      const wrapped = bridgeError(err, {
        tabId: ctx.bridge?.controlledTabId ?? null,
      });
      if (wrapped.code === 'BRIDGE_ERROR') throw err; // nothing to add
      throw wrapped;
    }
  });
}

// ─── Page / target helpers ─────────────────────────────────────

async function allPages(ctx: Ctx): Promise<Page[]> {
  // Bridge mode has no Playwright Browser to enumerate — every non-bridge
  // verb that reaches here (anything but goto/eval/text) will surface as
  // "No tabs open in attached browser" via activePage() below, which is an
  // honest error for a walking-skeleton prototype that only wires 3 verbs.
  if (!ctx.browser) return [];
  // connectOverCDP gives back one default context; pages are spread across
  // the browser contexts returned by browser.contexts().
  const pages: Page[] = [];
  for (const c of ctx.browser.contexts()) {
    for (const p of c.pages()) pages.push(p);
  }
  return pages;
}

// Target IDs are stable for a page's lifetime, but reading them costs a
// full CDPSession open+detach round-trip. Every command that walks tabs
// (activePage, tabs, find, status, tab) used to pay that per page per
// call. Cache it on the Page via a WeakMap so the hot path stays O(1).
const pageTargetIds = new WeakMap<Page, string>();

async function pageTargetId(page: Page): Promise<string | null> {
  const cached = pageTargetIds.get(page);
  if (cached) return cached;
  try {
    const session = await page.context().newCDPSession(page);
    const info = await session.send('Target.getTargetInfo');
    await session.detach().catch(() => undefined);
    const id = (info as any)?.targetInfo?.targetId ?? null;
    if (id) pageTargetIds.set(page, id);
    return id;
  } catch {
    return null;
  }
}

// Retry once past a navigation-in-flight. Playwright's `page.evaluate`
// throws `Execution context was destroyed` / `Target closed` if the
// active frame navigates mid-call; the pragmatic fix is to wait for
// the next load state and retry once. Matches what a human would do
// manually — `wait --load && eval …`.
function isNavTransient(err: unknown): boolean {
  const msg = String((err as { message?: string } | null)?.message ?? '');
  return /Execution context was destroyed|Target closed|frame was detached|Navigation failed because/i.test(msg);
}

async function evalWithNavRetry(page: Page, js: string, maxWaitMs = 3000): Promise<unknown> {
  try {
    return await page.evaluate(js);
  } catch (err) {
    if (!isNavTransient(err)) throw err;
    await page.waitForLoadState('load', { timeout: maxWaitMs }).catch(() => {});
    return await page.evaluate(js);
  }
}

async function activePage(ctx: Ctx): Promise<Page> {
  const pages = await allPages(ctx);
  if (pages.length === 0) throw new Error('No tabs open in attached browser.');
  if (ctx.activePageId) {
    for (const p of pages) {
      const id = await pageTargetId(p);
      if (id === ctx.activePageId) {
        await instrumentPage(ctx, p);
        return p;
      }
    }
    // Stale pointer — fall through to first tab.
  }
  const p = pages[0];
  ctx.activePageId = await pageTargetId(p);
  await instrumentPage(ctx, p);
  return p;
}

const BODY_CAP_BYTES = 32 * 1024;
// Cap concurrent body reads so a traffic burst doesn't blow memory —
// each pending read buffers the full response before we truncate, and
// large images/video matched by an overly-broad glob would pile up. 8
// is plenty for interactive API debug; bursts past this queue.
const BODY_CAP_CONCURRENCY = 8;
let bodyInflight = 0;
const bodyQueue: Array<() => void> = [];

function acquireBodySlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const release = () => {
      bodyInflight--;
      const next = bodyQueue.shift();
      if (next) next();
    };
    const start = () => {
      bodyInflight++;
      resolve(release);
    };
    if (bodyInflight < BODY_CAP_CONCURRENCY) start();
    else bodyQueue.push(start);
  });
}

/**
 * Fire-and-forget body capture. Called from the sync `response` handler;
 * returns immediately. The body lands on the entry whenever Playwright
 * finishes reading it. Bodies beyond BODY_CAP_BYTES truncate with a
 * marker. A small semaphore limits concurrent reads so we don't buffer
 * hundreds of large responses in RAM during a traffic spike.
 */
function captureBodyAsync(entry: NetworkEntry, resp: import('playwright').Response): void {
  acquireBodySlot().then((release) => {
    resp
      .text()
      .then((body) => {
        const { text, truncated } = capBody(body);
        entry.responseBody = text;
        if (truncated) entry.responseBodyTruncated = true;
      })
      .catch(() => {
        // Response body may be unavailable (opaque CORS, navigation frame
        // already gone, etc.). Leave the field undefined; not an error.
      })
      .finally(release);
  });
}

// Content-type gate shared by request- and response-body capture: only
// capture bodies that are plausibly JSON/text (GraphQL mutations included
// — most send `application/json`, but some servers reply/accept
// `application/graphql`). Binary payloads (images, video, octet-stream)
// are skipped even when the URL matches the glob.
const CAPTURABLE_CONTENT_TYPE_RE = /json|text|javascript|xml|html|css|graphql/;

// Apply the shared 32KB cap + truncation marker to a body string. Used by
// both response and request capture so the two stay byte-for-byte
// consistent.
function capBody(body: string): { text: string; truncated: boolean } {
  if (body.length > BODY_CAP_BYTES) {
    return {
      text: body.slice(0, BODY_CAP_BYTES) + `\n[truncated ${body.length - BODY_CAP_BYTES} bytes]`,
      truncated: true,
    };
  }
  return { text: body, truncated: false };
}

/**
 * Convert a simple glob (just `*` wildcards) to an anchored RegExp.
 * Matches full strings; `*` expands to `.*`. No support for `**`
 * (would be identical to `*` under this semantics anyway) or `?`.
 */
// Parse the `since` opt shared by console + network. Accepts positive
// epoch-ms integers. Non-finite, negative, or zero → no filter. Rejects
// NaN explicitly so `--since=garbage` doesn't silently return an empty
// result set (was: Number("garbage") → NaN, every `ts >= NaN` is false).
function parseSinceOpt(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Bad --since "${String(raw)}". Expected an epoch-ms integer.`);
  }
  if (n < 0) {
    throw new Error(`Bad --since "${String(raw)}". Expected a non-negative epoch-ms integer.`);
  }
  return n;
}

function globToRegExp(pattern: string): RegExp {
  if (pattern === '*' || pattern === '') return /.*/;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

async function instrumentPage(ctx: Ctx, page: Page): Promise<void> {
  if (ctx.instrumented.has(page)) return;
  ctx.instrumented.add(page);

  page.on('console', (msg) => {
    const entry: ConsoleEntry = {
      timestamp: Date.now(),
      level: (msg.type() as ConsoleEntry['level']) ?? 'log',
      text: msg.text(),
      url: page.url(),
      source: 'tab',
    };
    ctx.consoleBuf.push(entry);
    for (const l of ctx.consoleListeners) l(entry);
  });
  page.on('pageerror', (err) => {
    const stack = parseStack(err.stack);
    const entry: ConsoleEntry = {
      timestamp: Date.now(),
      level: 'error',
      text: `[pageerror] ${err.message}`,
      url: page.url(),
      source: 'tab',
      ...(stack.length > 0 ? { stack } : {}),
    };
    ctx.consoleBuf.push(entry);
    for (const l of ctx.consoleListeners) l(entry);
  });
  page.on('request', (req) => {
    const entry: NetworkEntry = {
      timestamp: Date.now(),
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      requestHeaders: req.headers(),
    };

    // Request-body capture rides the same --capture-bodies gate as
    // response bodies (no separate flag — see FEAT-1 in the 2026-04-30
    // Datto RMM field report). Playwright buffers postData() synchronously
    // as part of request interception, so this is a cheap read, not a
    // network round-trip. Only bodies of mutating methods with a
    // JSON/text-ish content-type are captured; GET/HEAD never carry a
    // body worth recording.
    if (
      ctx.captureBodiesRe &&
      ctx.captureBodiesRe.test(entry.url) &&
      /^(POST|PUT|PATCH)$/i.test(entry.method)
    ) {
      const ct = (req.headers()['content-type'] ?? '').toLowerCase();
      if (CAPTURABLE_CONTENT_TYPE_RE.test(ct)) {
        try {
          const body = req.postData();
          if (body !== null && body !== undefined) {
            const { text, truncated } = capBody(body);
            entry.requestBody = text;
            if (truncated) entry.requestBodyTruncated = true;
          }
        } catch {
          // postData() can throw for a handful of request shapes (e.g.
          // some data: URI navigations); not fatal, just skip capture.
        }
      }
    }

    ctx.networkBuf.push(entry);
    for (const l of ctx.networkListeners) l(entry);
  });
  page.on('response', (resp) => {
    // Stamp status + response headers + arrival time onto the most recent
    // matching request entry. Duration is (responseAt - timestamp).
    const respUrl = resp.url();
    const e = ctx.networkBuf.findMostRecent((x) => x.url === respUrl && x.status === undefined);
    if (!e) return;
    e.status = resp.status();
    e.statusText = resp.statusText();
    e.responseHeaders = resp.headers();
    e.responseAt = Date.now();
    e.duration = e.responseAt - e.timestamp;

    if (ctx.captureBodiesRe && ctx.captureBodiesRe.test(respUrl)) {
      const ct = (resp.headers()['content-type'] ?? '').toLowerCase();
      if (CAPTURABLE_CONTENT_TYPE_RE.test(ct)) {
        captureBodyAsync(e, resp);
      }
    }
  });
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

function wireBridgeEvents(ctx: Ctx): void {
  const bridge = requireBridge(ctx);
  bridge.onEvent((ev) => {
    const p = ev.params as any;
    if (ev.method === 'Runtime.consoleAPICalled') {
      const levels: Record<string, ConsoleEntry['level']> = {
        log: 'log', info: 'info', warning: 'warn', error: 'error', debug: 'debug', verbose: 'debug', trace: 'trace', assert: 'error',
      };
      const frame = p.stackTrace?.callFrames?.[0];
      const entry: ConsoleEntry = {
        timestamp: bridgeTimestamp(p.timestamp),
        level: levels[String(p.type)] ?? 'log',
        text: Array.isArray(p.args) ? p.args.map(remoteObjectText).join(' ') : '',
        ...(frame?.url ? { url: String(frame.url) } : {}),
        source: 'tab',
      };
      ctx.consoleBuf.push(entry);
      for (const listener of ctx.consoleListeners) listener(entry);
      return;
    }
    if (ev.method === 'Runtime.exceptionThrown') {
      const details = p.exceptionDetails ?? {};
      const description = details.exception?.description ?? details.text ?? 'Uncaught exception';
      const stack = parseStack(String(description));
      const entry: ConsoleEntry = {
        timestamp: bridgeTimestamp(p.timestamp),
        level: 'error',
        text: `[pageerror] ${String(details.exception?.description ?? details.text ?? 'Uncaught exception').split('\n')[0]}`,
        ...(details.url ? { url: String(details.url) } : {}),
        source: 'tab',
        ...(stack.length > 0 ? { stack } : {}),
      };
      ctx.consoleBuf.push(entry);
      for (const listener of ctx.consoleListeners) listener(entry);
      return;
    }
    if (ev.method === 'Log.entryAdded') {
      const logEntry = p.entry ?? {};
      const rawLevel = String(logEntry.level ?? 'log');
      const level: ConsoleEntry['level'] = rawLevel === 'warning' ? 'warn' :
        (['log', 'info', 'warn', 'error', 'debug', 'trace'].includes(rawLevel) ? rawLevel : 'log') as ConsoleEntry['level'];
      const entry: ConsoleEntry = {
        timestamp: bridgeTimestamp(logEntry.timestamp),
        level,
        text: String(logEntry.text ?? ''),
        ...(logEntry.url ? { url: String(logEntry.url) } : {}),
        source: 'tab',
      };
      ctx.consoleBuf.push(entry);
      for (const listener of ctx.consoleListeners) listener(entry);
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
      };
      if (request.postData !== undefined && ctx.captureBodiesRe?.test(entry.url)) {
        const ct = entry.requestHeaders?.['content-type'] ?? '';
        if (CAPTURABLE_CONTENT_TYPE_RE.test(ct)) {
          const capped = capBody(String(request.postData));
          entry.requestBody = capped.text;
          if (capped.truncated) entry.requestBodyTruncated = true;
        }
      }
      ctx.networkBuf.push(entry);
      ctx.bridgeNetworkRequests.set(String(p.requestId), entry);
      for (const listener of ctx.networkListeners) listener(entry);
      return;
    }
    if (ev.method === 'Network.responseReceived') {
      const entry = ctx.bridgeNetworkRequests.get(String(p.requestId));
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
      const entry = ctx.bridgeNetworkRequests.get(requestId);
      if (entry) {
        entry.responseAt ??= Date.now();
        entry.duration ??= entry.responseAt - entry.timestamp;
        if (ev.method === 'Network.loadingFinished' && typeof p.encodedDataLength === 'number') entry.size = p.encodedDataLength;
        if (ev.method === 'Network.loadingFailed' && !entry.statusText) entry.statusText = String(p.errorText ?? 'failed');
        if (
          ev.method === 'Network.loadingFinished' &&
          ctx.captureBodiesRe?.test(entry.url) &&
          CAPTURABLE_CONTENT_TYPE_RE.test(entry.responseHeaders?.['content-type'] ?? '')
        ) {
          void bridge.send('Network.getResponseBody', { requestId }).then((bodyResult) => {
            const body = bodyResult as { body?: string; base64Encoded?: boolean };
            if (typeof body.body !== 'string' || body.base64Encoded) return;
            const capped = capBody(body.body);
            entry.responseBody = capped.text;
            if (capped.truncated) entry.responseBodyTruncated = true;
          }).catch(() => undefined);
        }
      }
      ctx.bridgeNetworkRequests.delete(requestId);
    }
  });
}

async function enableBridgeDomains(ctx: Ctx): Promise<void> {
  const bridge = requireBridge(ctx);
  await Promise.all([
    bridge.send('Page.enable'),
    bridge.send('Runtime.enable'),
    bridge.send('Log.enable'),
    bridge.send('Network.enable'),
    bridge.send('DOM.enable'),
  ]).catch(() => undefined);
}

function resolveRef(ctx: Ctx, target: string, page: Page): Locator {
  if (target.startsWith('@')) {
    const key = target.slice(1);
    const entry = ctx.refs.get(key);
    if (!entry) throw new Error(`Ref ${target} not found. Run 'ghax snapshot' first.`);
    return entry.locator;
  }
  return page.locator(target);
}

function requireBridge(ctx: Ctx): Bridge {
  if (!ctx.bridge) throw new Error('ghax bridge: extension bridge is not initialized');
  return ctx.bridge;
}

function clearSnapshotRefs(ctx: Ctx): void {
  ctx.refs.clear();
  ctx.bridgeRefs.clear();
}

async function listBridgeTabs(ctx: Ctx): Promise<BridgeTab[]> {
  const ack = await requireBridge(ctx).sendControl({ action: 'list-tabs' });
  if (!Array.isArray(ack.result)) throw new Error('tabs: extension returned an invalid tab list');
  return (ack.result as unknown[]).flatMap((value) => {
    const tab = value as Partial<BridgeTab>;
    if (typeof tab.id !== 'number') return [];
    return [{
      id: tab.id,
      title: typeof tab.title === 'string' ? tab.title : '',
      url: typeof tab.url === 'string' ? tab.url : '',
      active: Boolean(tab.active),
    }];
  });
}

async function resolveBridgeTarget(ctx: Ctx, target: string): Promise<BridgeRef> {
  if (target.startsWith('@')) {
    const key = target.slice(1);
    const entry = ctx.bridgeRefs.get(key);
    if (!entry) throw new Error(`Ref ${target} not found. Run 'ghax snapshot' first.`);
    return entry;
  }
  return bridgeResolveSelector(requireBridge(ctx), target);
}

// ─── Command handlers ──────────────────────────────────────────

// Batch — execute N steps in a single daemon round-trip. Between steps
// that reference `@e<n>` refs, re-snapshot automatically so the ref
// map resolves against the *current* DOM. That's the core fix for
// JNR-03: mid-click-sequence ARIA shifts (Material / React comboboxes
// opening and reindexing) used to silently mis-resolve refs under
// `ghax chain`. Auto-snapshot can be disabled with `--no-auto-snapshot`
// for callers that want strict one-shot semantics.
register('batch', async (ctx, args, opts) => {
  const steps = Array.isArray(args[0]) ? (args[0] as unknown[]) : null;
  if (!steps || steps.length === 0) {
    throw new Error('Usage: batch \'[{"cmd":"click","args":["@e7"]}, …]\'');
  }
  const stopOnError = opts.stopOnError !== false;
  const autoSnapshot = opts['auto-snapshot'] !== false && opts.autoSnapshot !== false;
  const snapshotHandler = handlers.get('snapshot');
  const results: Array<Record<string, unknown>> = [];

  const usesRef = (step: { args?: unknown[]; opts?: Record<string, unknown> }) => {
    const inArgs = Array.isArray(step.args)
      ? step.args.some((v) => typeof v === 'string' && v.startsWith('@e'))
      : false;
    const inOpts = step.opts
      ? Object.values(step.opts).some((v) => typeof v === 'string' && v.startsWith('@e'))
      : false;
    return inArgs || inOpts;
  };

  for (const raw of steps) {
    if (!raw || typeof raw !== 'object') {
      results.push({ cmd: '<invalid>', ok: false, error: 'step must be an object' });
      if (stopOnError) break;
      continue;
    }
    const step = raw as { cmd?: unknown; args?: unknown; opts?: unknown };
    const cmd = typeof step.cmd === 'string' ? step.cmd : null;
    if (!cmd) {
      results.push({ cmd: '<missing>', ok: false, error: 'step missing cmd' });
      if (stopOnError) break;
      continue;
    }
    const stepArgs = Array.isArray(step.args) ? (step.args as unknown[]) : [];
    const stepOpts = (step.opts && typeof step.opts === 'object') ? (step.opts as Record<string, unknown>) : {};
    const handler = handlers.get(cmd);
    if (!handler) {
      results.push({ cmd, ok: false, error: `unknown cmd: ${cmd}` });
      if (stopOnError) break;
      continue;
    }
    // Refresh the ref map before any step that uses `@e<n>` — so the
    // caller doesn't have to interleave manual snapshots.
    if (autoSnapshot && snapshotHandler && usesRef({ args: stepArgs, opts: stepOpts })) {
      try {
        await snapshotHandler(ctx, [], { interactive: true });
      } catch {
        // A snapshot failure is informational — the step itself will
        // surface the concrete "ref not found" error if it's still bad.
      }
    }
    try {
      const data = await handler(ctx, stepArgs, stepOpts);
      results.push({ cmd, ok: true, data });
    } catch (err) {
      results.push({ cmd, ok: false, error: String((err as { message?: string } | null)?.message ?? err) });
      if (stopOnError) break;
    }
  }
  return results;
});

register('status', async (ctx) => {
  if (ctx.bridgeMode) {
    const tabs = await listBridgeTabs(ctx);
    const active = tabs.find((tab) => tab.id === ctx.bridge?.controlledTabId) ?? null;
    return {
      pid: process.pid,
      uptimeMs: Date.now() - ctx.startedAt,
      browserKind: ctx.browserKind,
      browserUrl: ctx.cdpBrowserUrl,
      tabCount: tabs.length,
      targetCount: tabs.length,
      extensionCount: 0,
      activeTabId: active ? String(active.id) : null,
      activeTabTitle: active?.title ?? '',
      activeTabUrl: active?.url ?? '',
    };
  }
  const pages = await allPages(ctx);
  const targets = await ctx.pool.list();
  const extIds = new Set<string>();
  for (const t of targets) if (t.extensionId) extIds.add(t.extensionId);
  // Surface the active tab's id + title so `ghax status` can tell operators
  // which tab they're about to drive — matters most in multi-agent sessions
  // where `new-window` has parked the agent on a non-obvious tab.
  let activeTabTitle = '';
  let activeTabUrl = '';
  if (ctx.activePageId) {
    const entries = await Promise.all(
      pages.map(async (p) => [await pageTargetId(p), p] as const),
    );
    const active = entries.find(([id]) => id === ctx.activePageId)?.[1];
    if (active) {
      activeTabTitle = await active.title().catch(() => '');
      activeTabUrl = active.url();
    }
  }
  return {
    pid: process.pid,
    uptimeMs: Date.now() - ctx.startedAt,
    browserKind: ctx.browserKind,
    browserUrl: ctx.cdpBrowserUrl,
    tabCount: pages.length,
    targetCount: targets.length,
    extensionCount: extIds.size,
    activeTabId: ctx.activePageId ?? null,
    activeTabTitle,
    activeTabUrl,
  };
});

register('tabs', async (ctx, _args, opts) => {
  const filterStr = (opts.filter as string | undefined) ?? null;
  let filterRe: RegExp | null = null;
  if (filterStr) {
    try {
      filterRe = new RegExp(filterStr, 'i');
    } catch (err: any) {
      throw new Error(`tabs --filter: invalid regex: ${err?.message || filterStr}`);
    }
  }
  // --fields accepts a csv list of keys to keep. Valid keys: id, title,
  // url, active. Invalid keys are ignored silently so a typo can't kill
  // the whole command mid-session. Omitted → return every field.
  const fieldsArg = (opts.fields as string | undefined) ?? null;
  const fields: Set<string> | null = fieldsArg
    ? new Set(fieldsArg.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const all = ctx.bridgeMode
    ? (await listBridgeTabs(ctx)).map((t) => ({ id: String(t.id), title: t.title, url: t.url, active: t.active }))
    : await Promise.all(
        (await allPages(ctx)).map(async (p) => {
          const [id, title] = await Promise.all([pageTargetId(p), p.title().catch(() => '')]);
          return { id, title, url: p.url(), active: id === ctx.activePageId };
        }),
      );
  const matched = filterRe
    ? all.filter((t) => filterRe!.test(t.url) || filterRe!.test(t.title))
    : all;
  if (!fields) return matched;
  return matched.map((t) => {
    const out: Record<string, unknown> = {};
    for (const k of fields) if (k in t) out[k] = (t as any)[k];
    return out;
  });
});

register('tab', async (ctx, args, opts) => {
  const id = String(args[0] ?? '');
  if (!id) throw new Error('Usage: tab <id>');
  if (ctx.bridgeMode) {
    const tabId = Number(id);
    if (!Number.isInteger(tabId)) throw new Error(`No tab with id ${id}`);
    const tabs = await listBridgeTabs(ctx);
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`No tab with id ${id}`);
    const bridge = requireBridge(ctx);
    await bridge.sendControl({ action: 'control-tab', tabId, quiet: Boolean(opts.quiet) });
    clearSnapshotRefs(ctx);
    ctx.activePageId = String(tabId);
    return { id: String(tabId), url: tab.url, title: tab.title };
  }
  const pages = await allPages(ctx);
  for (const p of pages) {
    const tid = await pageTargetId(p);
    if (tid === id) {
      if (ctx.activePageId !== tid) {
        // Refs are scoped to "the last snapshot on the active tab". Switching
        // tabs invalidates them — otherwise `@e3` after `tab <other>` would
        // resolve against the previous tab's locator and land in the wrong
        // DOM. The CLAUDE.md invariant is explicit about this.
        ctx.refs.clear();
      }
      ctx.activePageId = tid;
      await instrumentPage(ctx, p);
      // --quiet skips bringToFront. Useful when an agent locks onto a tab
      // while the user is working elsewhere — no focus steal, no window
      // raised. Default preserves v0.1 human-friendly behavior.
      if (!opts.quiet) {
        await p.bringToFront().catch(() => undefined);
      }
      return { id: tid, url: p.url(), title: await p.title().catch(() => '') };
    }
  }
  throw new Error(`No tab with id ${id}`);
});

// ─── find / newWindow — dedicated-window workflow ──────────────
//
// The multi-agent + user-working-alongside pattern. Each agent owns a
// window that ghax put there; the user's other windows/tabs are off-
// limits. Implementation leans entirely on the browser's native
// multi-window support via CDP's Target.createTarget:
//   - newWindow: true       → new OS-level window (not a tab)
//   - background: true      → don't raise / don't steal focus
//   - same browser profile  → auth, cookies, extensions carry over
//
// For multi-agent isolation, each agent uses its own GHAX_STATE_FILE so
// daemon state (including active tab) stays separated.

register('find', async (ctx, args) => {
  const pattern = String(args[0] ?? '');
  if (!pattern) throw new Error('Usage: find <url-substring>');
  if (ctx.bridgeMode) {
    return (await listBridgeTabs(ctx))
      .filter((tab) => tab.url.includes(pattern))
      .map((tab) => ({ id: String(tab.id), url: tab.url, title: tab.title }));
  }
  const pages = await allPages(ctx);
  const hits = pages.filter((p) => p.url().includes(pattern));
  return Promise.all(
    hits.map(async (p) => {
      const [id, title] = await Promise.all([pageTargetId(p), p.title().catch(() => '')]);
      return { id, url: p.url(), title };
    }),
  );
});

register('newWindow', async (ctx, args) => {
  const url = args[0] ? String(args[0]) : 'about:blank';
  if (ctx.bridgeMode) {
    const bridge = requireBridge(ctx);
    const ack = await bridge.sendControl({ action: 'new-window', url });
    const tab = ack.result as BridgeTab | undefined;
    if (!tab || typeof tab.id !== 'number') throw new Error('newWindow: extension did not return the new tab');
    bridge.setDesiredControl({ action: 'control-tab', tabId: tab.id, quiet: true });
    clearSnapshotRefs(ctx);
    ctx.activePageId = String(tab.id);
    return { id: String(tab.id), url: tab.url, title: tab.title };
  }
  const browser = ctx.browser;
  if (!browser) throw new Error('newWindow: no browser available');
  const context = browser.contexts()[0];
  if (!context) throw new Error('newWindow: no browser context available');
  const cdpSession = await browser.newBrowserCDPSession();
  try {
    // Race-free: subscribe to the "page" event BEFORE firing createTarget.
    // Playwright surfaces the new page as soon as the target becomes
    // attachable, so waitForEvent resolves right after CDP confirms.
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 10_000 }),
      cdpSession.send('Target.createTarget', {
        url,
        newWindow: true,
        background: true,
      }),
    ]);
    // Let the initial nav settle so the caller sees the real URL, not
    // about:blank, when they read the returned object.
    await newPage.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
    const id = await pageTargetId(newPage);
    // Auto-lock this tab as the active one so subsequent commands land
    // in the freshly-created window without an extra `ghax tab` step.
    // Same refs-invalidation rule as the `tab` handler.
    if (ctx.activePageId !== id) ctx.refs.clear();
    ctx.activePageId = id;
    await instrumentPage(ctx, newPage);
    // Re-assert sane download behaviour. Playwright re-runs
    // `Browser.setDownloadBehavior` (allowAndName → temp dir) whenever it
    // initialises a browser context; a new OS-level window created via the
    // same default context does *not* trigger that, but re-asserting here is
    // cheap insurance against any Playwright/Chromium path that resets it.
    await assertDownloadBehavior(ctx).catch(() => undefined);
    return {
      id,
      url: newPage.url(),
      title: await newPage.title().catch(() => ''),
    };
  } finally {
    await cdpSession.detach().catch(() => undefined);
  }
});

// ─── Downloads ─────────────────────────────────────────────────
//
// Playwright's `connectOverCDP` hijacks the profile's download settings:
// on every browser-context init it issues `Browser.setDownloadBehavior`
// with behavior `allowAndName` and downloadPath pointed at its own temp
// `playwright-artifacts-*` dir. Result: files land as extension-less GUIDs
// in /var/folders/**, not `~/Downloads/report.csv`.
//
// We undo this by owning a long-lived browser-level CDP session and
// re-asserting `behavior: 'allow'` (honours the site-suggested filename +
// extension) with downloadPath = the user's real Downloads dir. 'allow'
// (not 'allowAndName') is the key: Chromium then writes the file under its
// real name and handles collision de-duping (`name (1).ext`) itself.
register('downloads', async (ctx, _args, opts) => {
  const n = typeof opts.last === 'number' ? opts.last : Number(opts.last ?? 20);
  const limit = Number.isFinite(n) && n > 0 ? n : 20;
  const items = ctx.downloads.last(limit).map((d) => ({
    guid: d.guid,
    url: d.url,
    filename: d.suggestedFilename,
    finalPath: d.finalPath,
    state: d.state,
    totalBytes: d.totalBytes,
    receivedBytes: d.receivedBytes,
    startedAt: new Date(d.startedAt).toISOString(),
    updatedAt: new Date(d.updatedAt).toISOString(),
  }));
  return { downloadsDir: ctx.downloadsDir, count: items.length, downloads: items };
});

register('goto', async (ctx, args) => {
  const url = String(args[0] ?? '');
  if (!url) throw new Error('Usage: goto <url>');
  if (ctx.bridgeMode) {
    clearSnapshotRefs(ctx);
    return await bridgeGoto(requireBridge(ctx), url);
  }
  const page = await activePage(ctx);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { url: page.url(), title: await page.title().catch(() => '') };
});

// History navigation waits on `commit`, not `domcontentloaded`: when
// Chromium restores the target entry from the back/forward cache it fires
// `pageshow`, never a fresh `DOMContentLoaded`, so a `domcontentloaded` wait
// would block until goBack's 30s default timeout every time bfcache kicks in
// — stalling the RPC (and, under the suite's no-timeout client, the whole
// run). `commit` resolves as soon as the history navigation commits, which
// happens for both fresh loads and bfcache restores. The explicit timeout is
// a backstop so no pathological navigation can ever wedge the daemon.
register('back', async (ctx) => {
  if (ctx.bridgeMode) {
    const bridge = requireBridge(ctx);
    const history = await bridge.send('Page.getNavigationHistory') as {
      currentIndex?: number; entries?: Array<{ id: number; url: string }>;
    };
    const index = history.currentIndex ?? 0;
    const entry = history.entries?.[index - 1];
    if (entry) await bridge.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    clearSnapshotRefs(ctx);
    return { url: entry?.url ?? String(await bridgeEvaluate(bridge, 'location.href')) };
  }
  const page = await activePage(ctx);
  await page.goBack({ waitUntil: 'commit', timeout: 15_000 }).catch(() => undefined);
  return { url: page.url() };
});

register('forward', async (ctx) => {
  if (ctx.bridgeMode) {
    const bridge = requireBridge(ctx);
    const history = await bridge.send('Page.getNavigationHistory') as {
      currentIndex?: number; entries?: Array<{ id: number; url: string }>;
    };
    const index = history.currentIndex ?? 0;
    const entry = history.entries?.[index + 1];
    if (entry) await bridge.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    clearSnapshotRefs(ctx);
    return { url: entry?.url ?? String(await bridgeEvaluate(bridge, 'location.href')) };
  }
  const page = await activePage(ctx);
  await page.goForward({ waitUntil: 'commit', timeout: 15_000 }).catch(() => undefined);
  return { url: page.url() };
});

register('reload', async (ctx) => {
  if (ctx.bridgeMode) {
    const bridge = requireBridge(ctx);
    await bridge.send('Page.reload', {});
    clearSnapshotRefs(ctx);
    return { url: String(await bridgeEvaluate(bridge, 'location.href').catch(() => '')) };
  }
  const page = await activePage(ctx);
  await page.reload({ waitUntil: 'domcontentloaded' });
  return { url: page.url() };
});

register('eval', async (ctx, args, opts) => {
  const js = String(args[0] ?? '');
  if (!js) throw new Error('Usage: eval <js>');
  let result: unknown;
  if (ctx.bridgeMode) {
    if (!ctx.bridge) throw new Error('bridge not initialized');
    result = await bridgeEvaluate(ctx.bridge, js);
  } else {
    const page = await activePage(ctx);
    // Navigation in flight when eval lands will destroy the execution
    // context mid-call. Wait for the next load state once and retry before
    // giving up — matches what a human would do manually.
    result = await evalWithNavRetry(page, js);
  }
  // --max-bytes caps the stringified result so an accidental
  // `document.body.innerText` on a heavy page can't blow out the
  // LLM operator's context window. Measured in UTF-8 bytes, not
  // characters. When it trips we wrap the response so the caller
  // can see what happened; when it doesn't trip we return the
  // value unchanged (zero shape change for scripts that already
  // expect the raw value).
  const maxBytesRaw = opts['max-bytes'] ?? opts.maxBytes;
  const maxBytes = maxBytesRaw !== undefined ? Number(maxBytesRaw) : null;
  if (maxBytes !== null && Number.isFinite(maxBytes) && maxBytes > 0) {
    const serialized = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > maxBytes) {
      // Slice in bytes — Buffer handles multi-byte UTF-8 correctly.
      const truncated = Buffer.from(serialized, 'utf8').subarray(0, maxBytes).toString('utf8');
      return { value: truncated, truncated: true, originalBytes: bytes };
    }
  }
  return result;
});

// ─── try — live-injection fix-preview ──────────────────────────
//
// Composable wrapper over page.evaluate + page.screenshot for the
// "mutate the live page, measure, maybe screenshot" loop. Revert
// semantics are trivial: reload the page. Any in-memory DOM/CSS
// mutation dies with navigation.
//
// Trust model matches `ghax eval`: the JS is supplied by the operator
// on their own shell, runs in their own browser. No external input.
//
// opts:
//   js        positional[0] — function body (use `return` for a value)
//   css       --css          — appended as <style class="ghax-try">
//   selector  --selector     — binds document.querySelector(sel) as `el`
//   measure   --measure      — expression evaluated AFTER the mutation;
//                              its return value wins over the js return.
//   shot      --shot <path>  — screenshot written at path (viewport only)
register('try', async (ctx, args, opts) => {
  const page = await activePage(ctx);
  const js = args[0] ? String(args[0]) : null;
  const css = (opts.css as string | undefined) ?? null;
  const selector = (opts.selector as string | undefined) ?? null;
  const measure = (opts.measure as string | undefined) ?? null;
  const shotPath = (opts.shot as string | undefined) ?? null;

  if (!js && !css && !measure && !shotPath) {
    throw new Error('Usage: try [<js>] [--css <rules>] [--selector <sel>] [--measure <expr>] [--shot <path>]');
  }

  // 1. Inject CSS as a tagged <style> node — easy to find/remove later.
  if (css) {
    await page.evaluate((cssText) => {
      const style = document.createElement('style');
      style.className = 'ghax-try';
      style.textContent = cssText;
      document.head.appendChild(style);
    }, css);
  }

  // 2. Run user JS. Wrap in an IIFE as a string so that `return` at the
  // top level works. Bare expressions auto-get `return (...)` so both
  // forms do the right thing:
  //     ghax try '1+2'                         → value: 3
  //     ghax try 'el.style.color="red"; return el.textContent'
  // If --selector is passed, the IIFE binds the match as `el`.
  let value: unknown = null;
  if (js) {
    const body = js.includes('return') ? js : `return (${js})`;
    const sourceWithBinding = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ${body} })()`
      : `(() => { ${body} })()`;
    value = await page.evaluate(sourceWithBinding);
  }

  // 3. --measure runs AFTER the mutation so you can observe the effect.
  if (measure) {
    value = await page.evaluate(measure);
  }

  // 4. Optional screenshot.
  let shot: string | undefined;
  if (shotPath) {
    await page.screenshot({ path: shotPath, fullPage: false });
    shot = shotPath;
  }

  return { value, ...(shot ? { shot } : {}) };
});

register('text', async (ctx, _args, opts) => {
  const selector = (opts.selector as string | undefined) ?? null;
  // --skip/--length paginate the returned string. The daemon still
  // pulls full innerText — the win is on the wire, which is where
  // the operator's context budget lives. Pagination uses code-unit
  // offsets to match JavaScript's substring semantics; if/when a
  // field report complains about emoji-splitting we'll switch to
  // grapheme segmentation.
  const skip = opts.skip !== undefined ? Math.max(0, Number(opts.skip)) : 0;
  const lengthRaw = opts.length !== undefined ? Number(opts.length) : null;
  const length = lengthRaw !== null && Number.isFinite(lengthRaw) && lengthRaw > 0 ? lengthRaw : null;
  let text: string;
  if (ctx.bridgeMode) {
    const bridge = requireBridge(ctx);
    if (selector) {
      text = String(await bridgeEvaluate(bridge, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Selector not found: ' + ${JSON.stringify(selector)});
        return el.innerText;
      })()`));
    } else {
      text = await bridgeText(bridge);
    }
  } else {
    const page = await activePage(ctx);
    if (selector) {
      text = await page.locator(selector).first().innerText();
    } else {
      // Same nav-in-flight retry as `eval` — heavy pages with still-running
      // XHR-driven navigation will trip `Execution context was destroyed`
      // the first time around; waiting for the next load event and
      // retrying once rescues the operator from a spurious failure.
      text = (await evalWithNavRetry(page, 'document.body.innerText')) as string;
    }
  }
  if (skip > 0 || length !== null) {
    const end = length !== null ? skip + length : undefined;
    text = text.slice(skip, end);
  }
  return text;
});

// Bridge-mode-only: point the extension at a tab without a popup click.
// Backs `ghax attach --extension --control-active` (via env) and the
// standalone `ghax bridge control [--active | --tab-id N | --stop]`.
register('bridge.control', async (ctx, _args, opts) => {
  if (!ctx.bridgeMode || !ctx.bridge) {
    throw new Error('bridge.control requires bridge mode — start with `ghax attach --extension`');
  }
  const mode = String(opts.mode ?? '');
  let target: ControlTarget;
  if (mode === 'active') {
    target = { action: 'control-active' };
  } else if (mode === 'stop') {
    target = { action: 'stop' };
  } else if (mode === 'tab') {
    const tabId = Number(opts.tabId ?? opts['tab-id']);
    if (!Number.isFinite(tabId)) throw new Error('bridge.control tab mode requires --tab-id <n>');
    target = { action: 'control-tab', tabId };
  } else {
    throw new Error(`bridge.control: unknown mode '${mode}' (expected active | tab | stop)`);
  }
  const ack = await ctx.bridge.sendControl(target);
  return { ok: ack.ok, tabId: ack.tabId };
});

// `ghax bridge instances` — the inventory that turns "why did my session just
// die" into a five-second diagnosis: which browsers are connected, which one
// is driving, and whether ownership has been flapping.
register('bridge.instances', async (ctx) => {
  if (!ctx.bridgeMode || !ctx.bridge) {
    throw new Error('bridge.instances requires bridge mode — start with `ghax attach --extension`');
  }
  return {
    state: ctx.bridge.state,
    boundInstanceId: ctx.bridge.instances().find((i) => i.role === 'bound')?.instanceId ?? null,
    livelockSuspected: ctx.bridge.livelockSuspected,
    instances: ctx.bridge.instances(),
  };
});

// `ghax bridge use <id|browser|label>` — explicit takeover. Rebinding happens
// over live sockets (a `role` message), so neither side disconnects.
register('bridge.use', async (ctx, args, opts) => {
  if (!ctx.bridgeMode || !ctx.bridge) {
    throw new Error('bridge.use requires bridge mode — start with `ghax attach --extension`');
  }
  const selector = String(args[0] ?? opts.instance ?? opts.browser ?? '');
  if (!selector) throw new Error('Usage: ghax bridge use <instance-id|browser|label>');
  const instance = await ctx.bridge.use(selector);
  clearSnapshotRefs(ctx);
  ctx.bridgeNetworkRequests.clear();
  return instance;
});

register('html', async (ctx, args) => {
  const sel = args[0] ? String(args[0]) : null;
  if (ctx.bridgeMode) {
    return bridgeEvaluate(requireBridge(ctx), sel
      ? `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('Selector not found: ' + ${JSON.stringify(sel)}); return el.innerHTML; })()`
      : `document.doctype ? '<!DOCTYPE ' + document.doctype.name + '>' + document.documentElement.outerHTML : document.documentElement.outerHTML`);
  }
  const page = await activePage(ctx);
  if (sel) return await page.locator(sel).first().innerHTML();
  return await page.content();
});

register('screenshot', async (ctx, args, opts) => {
  const outPath = (opts.path as string) || `/tmp/ghax-shot-${Date.now()}.png`;
  const target = args[0] ? String(args[0]) : null;
  // Accept both `--fullPage` (v0.1 camelCase) and `--full-page` (kebab,
  // matches every other CLI flag). Kebab is the preferred form going
  // forward; camelCase stays for back-compat with live scripts.
  const fullPage = Boolean(opts.fullPage || opts['full-page']);
  if (ctx.bridgeMode) {
    const ref = target ? await resolveBridgeTarget(ctx, target) : null;
    await captureBridgeScreenshot(requireBridge(ctx), outPath, fullPage, ref);
    return { path: outPath };
  }
  const page = await activePage(ctx);
  if (target) {
    await resolveRef(ctx, target, page).screenshot({ path: outPath });
  } else {
    await page.screenshot({ path: outPath, fullPage });
  }
  return { path: outPath };
});

async function captureBridgeScreenshot(
  bridge: Bridge,
  outPath: string,
  fullPage: boolean,
  ref: BridgeRef | null = null,
): Promise<void> {
  await bridge.send('Page.enable');
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (ref) {
    clip = { ...(await bridgeBox(bridge, ref)), scale: 1 };
  } else if (fullPage) {
    const metrics = await bridge.send('Page.getLayoutMetrics') as {
      cssContentSize?: { x?: number; y?: number; width?: number; height?: number };
      contentSize?: { x?: number; y?: number; width?: number; height?: number };
    };
    const size = metrics.cssContentSize ?? metrics.contentSize;
    if (size?.width && size?.height) {
      clip = { x: size.x ?? 0, y: size.y ?? 0, width: size.width, height: size.height, scale: 1 };
    }
  }
  const shot = await bridge.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: Boolean(fullPage || ref),
    ...(clip ? { clip } : {}),
  }) as { data?: string };
  if (!shot.data) throw new Error('screenshot: bridge returned no image data');
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
}

// ─── xpath / box — utility queries ─────────────────────────────
//
// XPath itself is already usable with every selector-accepting command
// via Playwright's native `xpath=...` prefix (e.g. `ghax click
// 'xpath=//button[@id="submit"]'`). This handler is the *query* form:
// list every matching element with its text, tag, and bounding box so
// you can preview what your expression hit before acting on it.

register('xpath', async (ctx, args, opts) => {
  const expr = String(args[0] ?? '');
  if (!expr) throw new Error('Usage: xpath <expression>');
  const limit = opts.limit ? Number(opts.limit) : 50;
  const page = await activePage(ctx);
  // Single page.evaluate instead of per-match CDP round-trips — 50+
  // locator.nth()/textContent()/boundingBox()/evaluate() calls collapse
  // into one. Uses document.evaluate directly; getBoundingClientRect is
  // viewport-relative, same as Playwright's locator.boundingBox().
  const { count, matches } = await page.evaluate(
    ({ expr, limit }: { expr: string; limit: number }) => {
      const result = document.evaluate(
        expr,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      const count = result.snapshotLength;
      const matches: Array<{
        index: number;
        tag: string;
        text: string;
        box: { x: number; y: number; width: number; height: number } | null;
      }> = [];
      for (let i = 0; i < Math.min(count, limit); i++) {
        const node = result.snapshotItem(i);
        if (!node) continue;
        const el = node as Element;
        const rect = typeof (el as Element).getBoundingClientRect === 'function'
          ? (el as Element).getBoundingClientRect()
          : null;
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
        matches.push({
          index: i,
          tag: (el.tagName ?? 'node').toLowerCase(),
          text,
          box: rect && rect.width > 0 && rect.height > 0
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : null,
        });
      }
      return { count, matches };
    },
    { expr, limit },
  );
  return { count, returned: matches.length, matches };
});

register('box', async (ctx, args) => {
  const target = args[0] ? String(args[0]) : null;
  if (!target) throw new Error('Usage: box <@ref|selector>');
  if (ctx.bridgeMode) {
    try {
      return await bridgeBox(requireBridge(ctx), await resolveBridgeTarget(ctx, target));
    } catch (err) {
      if (String((err as Error)?.message ?? err).includes('element not visible')) {
        throw new Error(`${target}: element not visible or not in layout`);
      }
      throw err;
    }
  }
  const page = await activePage(ctx);
  const locator = resolveRef(ctx, target, page);
  const box = await locator.first().boundingBox();
  if (!box) throw new Error(`${target}: element not visible or not in layout`);
  return box;
});

register('snapshot', async (ctx, _args, opts) => {
  if (ctx.bridgeMode) {
    const bridge = requireBridge(ctx);
    const result = await bridgeSnapshot(bridge, {
      interactive: Boolean(opts.interactive),
      compact: Boolean(opts.compact),
      depth: opts.depth === undefined ? undefined : Number(opts.depth),
      selector: opts.selector as string | undefined,
      cursorInteractive: Boolean(opts.cursorInteractive),
      dialogScope: !(opts['no-dialog-scope'] || opts.noDialogScope),
    });
    ctx.refs.clear();
    ctx.bridgeRefs = result.refs;
    let annotatedPath: string | null = null;
    if (opts.annotate) {
      annotatedPath = (opts.output as string) || `/tmp/ghax-annotated-${Date.now()}.png`;
      await annotateBridgeScreenshot(bridge, result.refs, annotatedPath);
    }
    return { text: result.text, count: result.count, ...(annotatedPath ? { annotatedPath } : {}) };
  }
  const page = await activePage(ctx);
  const result = await takeSnapshot(page, {
    interactive: Boolean(opts.interactive),
    compact: Boolean(opts.compact),
    depth: opts.depth === undefined ? undefined : Number(opts.depth),
    selector: opts.selector as string | undefined,
    cursorInteractive: Boolean(opts.cursorInteractive),
    // Default-on dialog scoping; callers opt out with --no-dialog-scope,
    // which the arg parser surfaces as `no-dialog-scope: true`.
    dialogScope: !(opts['no-dialog-scope'] || opts.noDialogScope),
  });
  ctx.refs = result.refs;

  let annotatedPath: string | null = null;
  if (opts.annotate) {
    annotatedPath = (opts.output as string) || `/tmp/ghax-annotated-${Date.now()}.png`;
    await annotateScreenshot(page, result.refs, annotatedPath);
  }

  return {
    text: result.text,
    count: result.count,
    ...(annotatedPath ? { annotatedPath } : {}),
  };
});

async function annotateBridgeScreenshot(
  bridge: Bridge,
  refs: Map<string, BridgeRef>,
  outPath: string,
): Promise<void> {
  const boxes: Array<{ ref: string; x: number; y: number; width: number; height: number }> = [];
  for (const [ref, entry] of refs) {
    try {
      boxes.push({ ref, ...(await bridgeBox(bridge, entry)) });
    } catch {
      // Hidden/off-layout refs are omitted, matching the Playwright path.
    }
  }
  await bridgeEvaluate(bridge, `(() => {
    document.getElementById('__ghax_annotate__')?.remove();
    const data = ${JSON.stringify(boxes)};
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = '__ghax_annotate__';
    const w = Math.max(document.documentElement.scrollWidth, innerWidth);
    const h = Math.max(document.documentElement.scrollHeight, innerHeight);
    svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.style.cssText = 'position:absolute;top:0;left:0;z-index:2147483647;pointer-events:none';
    for (const b of data) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [k,v] of Object.entries({x:b.x,y:b.y,width:b.width,height:b.height})) rect.setAttribute(k, String(v));
      rect.setAttribute('fill','rgba(255,0,0,.08)'); rect.setAttribute('stroke','#e00'); rect.setAttribute('stroke-width','2');
      svg.appendChild(rect);
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(b.x + 4)); label.setAttribute('y', String(b.y + 14));
      label.setAttribute('font-family','ui-monospace,monospace'); label.setAttribute('font-size','11');
      label.setAttribute('fill','#fff'); label.setAttribute('stroke','#000'); label.setAttribute('stroke-width','3');
      label.setAttribute('paint-order','stroke'); label.textContent = '@' + b.ref; svg.appendChild(label);
    }
    document.body.appendChild(svg);
  })()`);
  try {
    await captureBridgeScreenshot(bridge, outPath, true);
  } finally {
    await bridgeEvaluate(bridge, `document.getElementById('__ghax_annotate__')?.remove()`).catch(() => undefined);
  }
}

async function annotateScreenshot(
  page: Page,
  refs: Map<string, RefEntry>,
  outPath: string,
): Promise<void> {
  // Collect bounding boxes from Playwright locators. Some refs may be off-screen
  // or hidden — skip them rather than fail the whole snapshot.
  const boxes: Array<{ ref: string; x: number; y: number; width: number; height: number }> = [];
  for (const [ref, entry] of refs.entries()) {
    try {
      const box = await entry.locator.first().boundingBox({ timeout: 500 });
      if (box && box.width > 0 && box.height > 0) {
        boxes.push({ ref, ...box });
      }
    } catch {
      // locator missing, off-screen, or timed out
    }
  }

  // Inject an SVG overlay covering the full document, screenshot, then remove it.
  // Using an SVG (not DOM divs) means we don't risk triggering re-layout on
  // React pages that are sensitive to DOM mutations.
  await page.evaluate((data: { boxes: typeof boxes }) => {
    const existing = document.getElementById('__ghax_annotate__');
    if (existing) existing.remove();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = '__ghax_annotate__';
    const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    svg.setAttribute('width', String(docW));
    svg.setAttribute('height', String(docH));
    svg.setAttribute('viewBox', `0 0 ${docW} ${docH}`);
    svg.style.cssText = `position:absolute;top:0;left:0;z-index:2147483647;pointer-events:none;`;
    for (const b of data.boxes) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(b.x));
      rect.setAttribute('y', String(b.y));
      rect.setAttribute('width', String(b.width));
      rect.setAttribute('height', String(b.height));
      rect.setAttribute('fill', 'rgba(255,0,0,0.08)');
      rect.setAttribute('stroke', '#e00');
      rect.setAttribute('stroke-width', '2');
      svg.appendChild(rect);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(b.x + 4));
      label.setAttribute('y', String(b.y + 14));
      label.setAttribute('font-family', 'ui-monospace, monospace');
      label.setAttribute('font-size', '11');
      label.setAttribute('fill', '#fff');
      label.setAttribute('stroke', '#000');
      label.setAttribute('stroke-width', '3');
      label.setAttribute('paint-order', 'stroke');
      label.textContent = `@${b.ref}`;
      svg.appendChild(label);
    }
    document.body.appendChild(svg);
  }, { boxes });

  try {
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    await page.evaluate(() => {
      const el = document.getElementById('__ghax_annotate__');
      if (el) el.remove();
    });
  }
}

// Click — Playwright's `loc.click()` resolves the moment the trusted mouse
// event has been dispatched. That tells you "the click was sent" but says
// nothing about whether the page reacted. Real-world failure mode: a
// confirm-modal "Save" button accepts the click but doesn't dismiss for
// >1s because the React handler kicks off an async network round-trip
// before unmounting the dialog. Callers see `{ ok: true }` and assume the
// click no-op'd.
//
// Fix: take a cheap before/after observation around the click and report
// whether observable downstream effects happened within a short budget.
// Two signals worth tracking:
//   - dialogDismissed → a visible modal disappeared (count went down)
//   - urlChanged      → location.href changed (navigation/SPA route)
// Both are O(1) DOM queries; the poll loop short-circuits on first signal,
// so the cost is ~one round-trip when the click is effective.
//
// Defaults: observe on, 300ms budget. Opt-outs:
//   --no-observe        → skip entirely (back to old behavior, no extras)
//   --observe-ms <n>    → custom budget (e.g. --observe-ms 1500 for HubSpot
//                          confirm modals that wait on a network save).
register('click', async (ctx, args, opts) => {
  const target = String(args[0] ?? '');
  if (!target) throw new Error('Usage: click <@ref|selector>');
  const observe = opts.observe !== false && opts['no-observe'] !== true;
  const observeMs = (() => {
    const raw = opts['observe-ms'] ?? opts.observeMs;
    if (raw === undefined) return 300;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 300;
  })();

  if (ctx.bridgeMode) {
    const bridge = requireBridge(ctx);
    const ref = await resolveBridgeTarget(ctx, target);
    const readState = async () => bridgeEvaluate(bridge, `(() => {
      const sel = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]';
      const dialogs = [...document.querySelectorAll(sel)].filter((el) => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      }).length;
      return { dialogs, url: location.href };
    })()`) as Promise<{ dialogs: number; url: string }>;
    const pre = observe ? await readState() : { dialogs: 0, url: '' };
    const box = await bridgeBox(bridge, ref);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await bridge.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await bridge.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await bridge.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    if (!observe) return { ok: true };
    const deadline = Date.now() + observeMs;
    let post = pre;
    let urlChanged = false;
    while (Date.now() < deadline) {
      post = await readState().catch(() => post);
      urlChanged = post.url !== pre.url;
      if (urlChanged || post.dialogs < pre.dialogs) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    post = await readState().catch(() => post);
    urlChanged ||= post.url !== pre.url;
    return {
      ok: true,
      dialogDismissed: post.dialogs < pre.dialogs,
      urlChanged,
      preDialogCount: pre.dialogs,
      postDialogCount: post.dialogs,
      observedMs: observeMs,
    };
  }

  const page = await activePage(ctx);
  const loc = resolveRef(ctx, target, page);

  const preDialogCount = observe ? await page.locator(MODAL_SEL).count() : 0;
  const preUrl = observe ? page.url() : '';

  await loc.click();

  if (!observe) return { ok: true };

  // Poll for downstream effects. 30ms steps trades a tiny bit of CPU for
  // promptness — most React modal dismissals land in the next animation
  // frame (~16ms), and 30ms means the first poll catches them without a
  // wasted full sleep when the click was instant.
  //
  // Always do a final fresh dialog-count sample after the loop so callers
  // never see stale `postDialogCount`. Without this, a click that
  // navigated AND dismissed a modal would report `urlChanged: true` plus
  // an outdated `postDialogCount` (the pre-navigation count) — confusing.
  const deadline = Date.now() + observeMs;
  let urlChanged = false;
  let postDialogCount = preDialogCount;
  while (Date.now() < deadline) {
    postDialogCount = await page.locator(MODAL_SEL).count();
    if (page.url() !== preUrl) { urlChanged = true; break; }
    if (postDialogCount < preDialogCount) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  // Final sample — covers (a) the early-break-on-urlChanged path where the
  // pre-break sample may now be stale post-navigation and (b) the early-
  // break-on-dismissal path which is already fresh (no extra cost beyond
  // one count() round-trip).
  postDialogCount = await page.locator(MODAL_SEL).count().catch(() => postDialogCount);
  const dialogDismissed = postDialogCount < preDialogCount;

  return {
    ok: true,
    dialogDismissed,
    urlChanged,
    preDialogCount,
    postDialogCount,
    observedMs: observeMs,
  };
});

register('fill', async (ctx, args) => {
  const target = String(args[0] ?? '');
  const value = String(args[1] ?? '');
  if (!target) throw new Error('Usage: fill <@ref|selector> <value>');
  if (ctx.bridgeMode) {
    const result = await bridgeCallOn(
      requireBridge(ctx),
      await resolveBridgeTarget(ctx, target),
      `function(v) {
        const start = this;
        const container = start.closest?.('.monaco-editor') || start.closest?.('[data-mode-id]');
        const root = container?.classList?.contains('monaco-editor') ? container : (container?.closest?.('.monaco-editor') || container);
        const editors = globalThis.monaco?.editor?.getEditors?.() || [];
        const editor = root && editors.find((ed) => { const node = ed.getDomNode(); return node && (node === root || node.contains(root) || root.contains(node)); });
        if (editor) { editor.setValue(v); return { editor: 'monaco' }; }
        const e = this;
        if (e.getAttribute?.('contenteditable') === 'true') {
          e.focus(); e.textContent = v;
          e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
          e.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          return {};
        }
        const proto = Object.getPrototypeOf(e);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        e.focus(); if (setter) setter.call(e, v); else e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        e.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        return {};
      }`,
      [value],
    ) as { editor?: string } | undefined;
    return result?.editor === 'monaco' ? { ok: true, editor: 'monaco' } : { ok: true };
  }
  const page = await activePage(ctx);
  const loc = resolveRef(ctx, target, page);

  // Monaco path — Datto RMM, Splunk, Grafana, Postman, and GitLab's Web IDE
  // all embed Monaco for script/query editors. Monaco renders its own
  // virtualized text layer; the hidden `textarea.inputarea` only mirrors
  // composition state, it isn't the source of truth, so the native-setter
  // trick below doesn't reach it. The editor's own model API is the
  // reliable way in — `editor.setValue()` updates the model and fires
  // Monaco's own change events, exactly what typing into the editor would
  // trigger downstream.
  const monacoHandled = await loc.evaluate((el, v) => {
    const start = el as HTMLElement;
    const container = start.closest('.monaco-editor') ?? start.closest('[data-mode-id]');
    if (!container) return false;
    const root = container.classList.contains('monaco-editor')
      ? container
      : (container.closest('.monaco-editor') ?? container);
    const monacoGlobal = (window as unknown as {
      monaco?: { editor?: { getEditors?: () => Array<{ getDomNode: () => HTMLElement | null; setValue: (v: string) => void }> } };
    }).monaco;
    const getEditors = monacoGlobal?.editor?.getEditors;
    if (!getEditors || !monacoGlobal?.editor) return false;
    const editors = getEditors.call(monacoGlobal.editor);
    const match = editors.find((ed) => {
      const node = ed.getDomNode();
      return node !== null && (node === root || node.contains(root) || root.contains(node));
    });
    if (!match) return false;
    match.setValue(v);
    return true;
  }, value).catch(() => false);

  if (monacoHandled) return { ok: true, editor: 'monaco' };

  // Framework-safe path. React, Angular, and Material each intercept
  // `value` assignment in a way plain `locator.fill()` doesn't reach:
  //   - React:    tracks the value on a hidden internal property; the
  //               native setter bypasses React's wrapper so a subsequent
  //               'input' event refreshes its synthetic-event bookkeeping.
  //   - Angular:  binds via `(input)`/`(change)` but most validators only
  //               run on 'blur' — we dispatch one at the end.
  //   - Material: often wraps the real <input> inside a host component
  //               with `contenteditable` spans; falls through to the
  //               textContent path when there's no native value setter.
  await loc.evaluate((el, v) => {
    const e = el as HTMLElement;
    // contenteditable path — Material's mat-chip / rich editors land here.
    if (e.getAttribute('contenteditable') === 'true') {
      e.focus();
      e.textContent = v;
      e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      e.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      return;
    }
    const input = e as HTMLInputElement | HTMLTextAreaElement;
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    input.focus();
    if (setter) setter.call(input, v);
    else (input as unknown as { value: string }).value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Blur triggers Angular's `FormControl.markAsTouched` and most
    // pristine/dirty-based validators. Most sites no-op if the focus
    // never moved, so dispatching an explicit blur is safe.
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  }, value);
  return { ok: true };
});

// ─── select — companion to fill for dropdowns/comboboxes ───────
//
// "Set a value" means something different depending on what rendered the
// widget, and BUG-1 in the 2026-04-30 Datto RMM field report showed that
// `ghax click` alone can't cover all of them — AntD's `<Select>` in
// particular doesn't open for synthetic pointer events the way a native
// element does. Strategy cascade, cheapest/most-reliable first:
//
//   a. Native <select>            → Playwright's own selectOption().
//   b. AntD <Select>               → React fiber traversal straight to the
//                                    controlled component's onChange. AntD's
//                                    controlled-Select contract is stable
//                                    across versions, so this is more
//                                    robust than fighting its pointer-event
//                                    handling.
//   c. Everything else (react-select, MUI, Headless UI, role=combobox)
//                                  → open via a real click on the trigger,
//                                    then click the matching option —
//                                    including options rendered into a
//                                    portal under <body> rather than as a
//                                    DOM descendant of the trigger.
//
// Each strategy that doesn't apply/succeed records why, so a total failure
// reports what was tried instead of a bare "not found".
register('select', async (ctx, args, opts) => {
  const target = String(args[0] ?? '');
  if (!target) {
    throw new Error(
      'Usage: select <@ref|selector> <value>\n' +
      '   or: select <@ref|selector> --index <n>\n' +
      '   or: select <@ref|selector> --by-value <val>',
    );
  }

  const indexRaw = opts.index;
  const hasIndex = indexRaw !== undefined && indexRaw !== null && String(indexRaw) !== '';
  const indexNum = hasIndex ? Number(indexRaw) : undefined;
  if (hasIndex && (!Number.isInteger(indexNum) || (indexNum as number) < 0)) {
    throw new Error(`Bad --index "${String(indexRaw)}". Expected a 0-based integer.`);
  }
  const byValueRaw = opts['by-value'] ?? opts.byValue;
  const byValue = byValueRaw !== undefined ? String(byValueRaw) : undefined;
  const text = args[1] !== undefined ? String(args[1]) : undefined;

  if (text === undefined && !hasIndex && byValue === undefined) {
    throw new Error(
      'select needs a value: pass <value> as the 2nd arg, or --index <n>, or --by-value <val>.',
    );
  }

  const page = await activePage(ctx);
  const loc = resolveRef(ctx, target, page);
  const attempts: string[] = [];

  // ── (a) native <select> ──────────────────────────────────────
  const tag = await loc.evaluate((el) => (el as Element).tagName).catch(() => null);
  if (tag === 'SELECT') {
    try {
      let selected: string[];
      if (byValue !== undefined) {
        selected = await loc.selectOption({ value: byValue });
      } else if (hasIndex) {
        selected = await loc.selectOption({ index: indexNum as number });
      } else {
        // Plain <value> means "by visible text" first (label), falling
        // back to the option's `value` attribute — matches the semantics
        // documented for `ghax select <ref> <value>`.
        try {
          selected = await loc.selectOption({ label: text as string });
        } catch {
          selected = await loc.selectOption(text as string);
        }
      }
      return { ok: true, strategy: 'native', value: selected };
    } catch (err) {
      attempts.push(`native <select>: ${(err as Error)?.message ?? err}`);
    }
  } else {
    attempts.push('native <select>: target is not a <select> element');
  }

  // ── (b) AntD <Select> — React fiber traversal ────────────────
  interface FiberSelectResult {
    ok: boolean;
    value?: unknown;
    matchedBy?: string;
    reason?: string;
  }
  const fiberParams = { text, indexNum, hasIndex, byValue };
  const fiberResult = await loc.evaluate((el, params) => {
    const { text: t, indexNum: idx, hasIndex: hasIdx, byValue: bv } = params as {
      text?: string; indexNum?: number; hasIndex: boolean; byValue?: string;
    };
    const antRoot = (el as HTMLElement).closest('.ant-select');
    if (!antRoot) return { ok: false, reason: 'no .ant-select ancestor' };
    const fiberKey = Object.keys(antRoot).find((k) => k.startsWith('__reactFiber'));
    if (!fiberKey) return { ok: false, reason: '.ant-select found but no React fiber property on it' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let f: any = (antRoot as unknown as Record<string, unknown>)[fiberKey];
    let owner: any = null;
    while (f) {
      if (f.memoizedProps && typeof f.memoizedProps.onChange === 'function') {
        owner = f;
        break;
      }
      f = f.return;
    }
    if (!owner) return { ok: false, reason: 'walked fiber .return chain, no onChange prop found' };

    const props = owner.memoizedProps as Record<string, unknown>;
    // AntD's <Select options={[...]}> shape, or the <Select><Option/></Select>
    // children shape — try both so text/index matching works either way.
    let options: Array<{ value: unknown; label: unknown }> | null = null;
    if (Array.isArray(props.options)) {
      options = (props.options as Array<Record<string, unknown>>).map((o) => ({ value: o.value, label: o.label ?? o.children }));
    } else if (Array.isArray(props.children)) {
      options = (props.children as Array<{ props?: Record<string, unknown> }>)
        .filter((c) => c && c.props)
        .map((c) => ({ value: c.props!.value, label: c.props!.children }));
    }

    let value: unknown;
    let matchedBy: string;
    if (bv !== undefined) {
      value = bv;
      matchedBy = 'by-value';
    } else if (hasIdx) {
      if (options && options[idx as number] !== undefined) {
        value = options[idx as number].value;
        matchedBy = 'index (matched against fiber options)';
      } else {
        value = idx;
        matchedBy = 'index (raw — no options list on fiber)';
      }
    } else {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      const found = options?.find((o) => norm(o.label) === norm(t))
        ?? options?.find((o) => norm(o.label).includes(norm(t)));
      if (found) {
        value = found.value;
        matchedBy = 'text (matched against fiber options)';
      } else {
        value = t;
        matchedBy = 'text (raw — no matching option on fiber, passed through)';
      }
    }

    (owner.memoizedProps.onChange as (v: unknown) => void)(value);
    return { ok: true, value, matchedBy };
  }, fiberParams).catch((err) => ({ ok: false, reason: String((err as Error)?.message ?? err) } as FiberSelectResult)) as FiberSelectResult;

  if (fiberResult.ok) {
    return { ok: true, strategy: 'fiber', value: fiberResult.value, matchedBy: fiberResult.matchedBy };
  }
  attempts.push(`AntD fiber: ${fiberResult.reason ?? 'unknown failure'}`);

  // ── (c) other custom comboboxes — open + click the option ────
  try {
    await loc.click();
  } catch (err) {
    attempts.push(`open-click: could not click trigger — ${(err as Error)?.message ?? err}`);
    throw new Error(buildSelectError(target, attempts));
  }
  // Let the dropdown/portal render. Most React comboboxes mount within a
  // frame or two; a short fixed wait is cheaper and less flaky here than
  // polling for a specific selector we don't know the shape of yet.
  await page.waitForTimeout(150);

  interface OpenClickResult {
    ok: boolean;
    containerFound: boolean;
  }
  const openParams = { text, indexNum, hasIndex, byValue };
  const openResult = await page.evaluate((params) => {
    const { text: t, indexNum: idx, hasIndex: hasIdx, byValue: bv } = params as {
      text?: string; indexNum?: number; hasIndex: boolean; byValue?: string;
    };

    const isVisible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (el.classList.contains('ant-select-dropdown-hidden')) return false;
      return true;
    };

    // Portal-anchored dropdowns aren't DOM descendants of the trigger, so
    // gather candidates two ways: (1) explicit aria-controls/aria-owns from
    // whatever's currently expanded, and (2) well-known dropdown container
    // shapes rendered under <body> (AntD, ARIA listbox/menu, react-select /
    // MUI / Headless UI class-name conventions).
    const containers = new Set<Element>();
    document.querySelectorAll('[aria-expanded="true"][aria-controls], [aria-expanded="true"][aria-owns]').forEach((trigger) => {
      const ids = (trigger.getAttribute('aria-controls') ?? trigger.getAttribute('aria-owns') ?? '').split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const c = document.getElementById(id);
        if (c) containers.add(c);
      }
    });
    document.querySelectorAll('.ant-select-dropdown, [role="listbox"], [role="menu"], [role="grid"], [class*="menu-list" i], [class*="dropdown-content" i]')
      .forEach((c) => containers.add(c));

    const visible = Array.from(containers).filter(isVisible);
    // Prefer highest computed z-index; tie-break on later DOM position
    // (portals typically append their most-recently-opened node last).
    visible.sort((a, b) => {
      const za = parseInt(getComputedStyle(a).zIndex, 10) || 0;
      const zb = parseInt(getComputedStyle(b).zIndex, 10) || 0;
      if (za !== zb) return zb - za;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return 1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return -1;
      return 0;
    });

    for (const container of visible) {
      let options = Array.from(container.querySelectorAll('[role="option"], [role="menuitem"], .ant-select-item-option'))
        .filter(isVisible);
      if (options.length === 0) {
        options = Array.from(container.querySelectorAll('li, [data-value], [class*="option" i]')).filter(isVisible);
      }
      if (options.length === 0) continue;

      let match: Element | null = null;
      if (bv !== undefined) {
        match = options.find((o) => (o.getAttribute('data-value') ?? o.getAttribute('value')) === bv) ?? null;
      } else if (hasIdx) {
        match = options[idx as number] ?? null;
      } else {
        const norm = (s: string | null) => (s ?? '').trim().toLowerCase();
        match = options.find((o) => norm(o.textContent) === norm(t ?? null))
          ?? options.find((o) => norm(o.textContent).includes(norm(t ?? null)))
          ?? null;
      }

      if (match) {
        match.setAttribute('data-ghax-select-target', '1');
        return { ok: true, containerFound: true };
      }
    }
    return { ok: false, containerFound: visible.length > 0 };
  }, openParams) as OpenClickResult;

  if (openResult.ok) {
    const optionLoc = page.locator('[data-ghax-select-target="1"]');
    await optionLoc.first().click();
    await optionLoc.first().evaluate((el) => el.removeAttribute('data-ghax-select-target')).catch(() => {});
    return { ok: true, strategy: 'open-click', value: byValue ?? text ?? indexNum };
  }
  attempts.push(
    `open-click: ${openResult.containerFound
      ? 'a dropdown/listbox opened but no option matched the given value/index'
      : 'clicked the trigger but no dropdown/listbox/menu appeared'}`,
  );

  throw new Error(buildSelectError(target, attempts));
});

function buildSelectError(target: string, attempts: string[]): string {
  return `ghax select: no strategy worked for ${target}.\nTried:\n${attempts.map((a) => `  - ${a}`).join('\n')}`;
}

register('press', async (ctx, args) => {
  const key = String(args[0] ?? '');
  if (!key) throw new Error('Usage: press <key>');
  if (ctx.bridgeMode) {
    await pressBridgeKey(requireBridge(ctx), key);
    return { ok: true };
  }
  const page = await activePage(ctx);
  await page.keyboard.press(key);
  return { ok: true };
});

// ─── upload — first-class file upload via setInputFiles ────────
//
// Wraps Playwright's locator.setInputFiles so operators don't have to
// hand-roll the DOM.setFileInputFiles CDP call every time. Accepts a
// single path or a comma-separated list for multi-file inputs.
// Paths are resolved relative to the daemon's cwd (captured at attach).
register('upload', async (ctx, args) => {
  const target = String(args[0] ?? '');
  const pathArg = String(args[1] ?? '');
  if (!target || !pathArg) throw new Error('Usage: upload <@ref|selector> <path>[,<path>…]');
  const page = await activePage(ctx);
  const loc = resolveRef(ctx, target, page);
  const paths = pathArg.split(',').map((p) => p.trim()).filter(Boolean);
  await loc.setInputFiles(paths.length === 1 ? paths[0] : paths);
  return { ok: true, count: paths.length };
});

register('type', async (ctx, args) => {
  const text = String(args[0] ?? '');
  if (ctx.bridgeMode) {
    await requireBridge(ctx).send('Input.insertText', { text });
    return { ok: true };
  }
  const page = await activePage(ctx);
  await page.keyboard.type(text);
  return { ok: true };
});

async function pressBridgeKey(bridge: Bridge, spec: string): Promise<void> {
  const parts = spec.split('+').filter(Boolean);
  const keyName = parts.pop() ?? spec;
  let modifiers = 0;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'alt') modifiers |= 1;
    else if (lower === 'control' || lower === 'ctrl') modifiers |= 2;
    else if (lower === 'meta' || lower === 'command' || lower === 'cmd') modifiers |= 4;
    else if (lower === 'shift') modifiers |= 8;
  }
  const aliases: Record<string, { key: string; code: string; keyCode: number }> = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    Home: { key: 'Home', code: 'Home', keyCode: 36 },
    End: { key: 'End', code: 'End', keyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    Space: { key: ' ', code: 'Space', keyCode: 32 },
  };
  const known = aliases[keyName];
  const key = known?.key ?? keyName;
  const code = known?.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key);
  const keyCode = known?.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const common = { key, code, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await bridge.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...common,
    ...(key.length === 1 && (modifiers & 7) === 0 ? { text: key, unmodifiedText: key } : {}),
  });
  await bridge.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

register('console', async (ctx, _args, opts) => {
  const errorsOnly = Boolean(opts.errors);
  const dedup = Boolean(opts.dedup);
  const sourceMaps = Boolean(opts['source-maps']);
  const n = opts.last ? Number(opts.last) : 200;
  const since = parseSinceOpt(opts.since);
  let entries = ctx.consoleBuf.last(n);
  if (since > 0) entries = entries.filter((e) => e.timestamp >= since);
  if (errorsOnly) entries = entries.filter((e) => e.level === 'error');

  // --source-maps: resolve each entry's parsed stack back to original
  // positions via the daemon's map cache. Silent fallback to bundled
  // frames on any failure (unreachable script, no map comment, parse
  // error, position-out-of-range). Only entries that already have a
  // `stack` (i.e. pageerror events) get enriched.
  if (sourceMaps) {
    entries = await Promise.all(
      entries.map(async (e) => {
        if (!e.stack || e.stack.length === 0) return e;
        const resolved = await resolveStack(ctx.sourceMapCache, e.stack);
        return { ...e, stack: resolved };
      }),
    );
  }

  if (!dedup) return entries;

  // Group by (level, text). Duplicates keep the earliest `firstAt`, update
  // `lastAt`, and increment `count`. Sort by count desc so the loudest
  // spam rises to the top — exactly what you want when debugging a page
  // that's emitting the same error 500 times.
  const groups = new Map<string, {
    level: ConsoleEntry['level'];
    text: string;
    count: number;
    firstAt: number;
    lastAt: number;
    url?: string;
    source?: ConsoleEntry['source'];
    stack?: ConsoleEntry['stack'];
  }>();
  for (const e of entries) {
    const key = `${e.level}::${e.text}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.lastAt = e.timestamp;
    } else {
      groups.set(key, {
        level: e.level,
        text: e.text,
        count: 1,
        firstAt: e.timestamp,
        lastAt: e.timestamp,
        url: e.url,
        source: e.source,
        stack: e.stack,
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
});

register('network', async (ctx, _args, opts) => {
  const n = opts.last ? Number(opts.last) : 200;
  const pattern = opts.pattern ? new RegExp(String(opts.pattern)) : null;
  const statusArg = opts.status ? String(opts.status) : null;
  const harPath = opts.har ? String(opts.har) : null;

  // --status accepts:
  //   "404"   → exact match
  //   "4xx"   → any 400s (likewise 3xx, 5xx, etc.)
  //   "500-599" → range
  let statusTest: ((s: number | undefined) => boolean) | null = null;
  if (statusArg) {
    if (/^\d{3}$/.test(statusArg)) {
      const exact = Number(statusArg);
      statusTest = (s) => s === exact;
    } else if (/^\dxx$/i.test(statusArg)) {
      const family = Number(statusArg[0]);
      statusTest = (s) => s !== undefined && Math.floor(s / 100) === family;
    } else if (/^\d{3}-\d{3}$/.test(statusArg)) {
      const [lo, hi] = statusArg.split('-').map(Number);
      statusTest = (s) => s !== undefined && s >= lo && s <= hi;
    } else {
      throw new Error(`Bad --status "${statusArg}". Expected 404, 4xx, or 400-499.`);
    }
  }

  const since = parseSinceOpt(opts.since);
  let entries = ctx.networkBuf.last(n);
  if (since > 0) entries = entries.filter((e) => e.timestamp >= since);
  if (pattern) entries = entries.filter((e) => pattern.test(e.url));
  if (statusTest) entries = entries.filter((e) => statusTest!(e.status));

  if (harPath) {
    const har = buildHar(entries);
    fs.writeFileSync(harPath, JSON.stringify(har, null, 2));
    return { harPath, entryCount: entries.length };
  }
  return entries;
});

// Minimal HAR 1.2 generator. Response bodies are never included (content.size
// comes from Content-Length when available; body text is omitted) — good
// enough for waterfall + diagnostics tools (Charles, har-analyzer,
// WebPageTest). Request bodies *are* included as `postData` when the
// daemon was run with --capture-bodies and the entry captured a
// requestBody (see FEAT-1 in the 2026-04-30 Datto RMM field report).
function buildHar(entries: NetworkEntry[]): unknown {
  const asHeaders = (h: Record<string, string> | undefined) =>
    h ? Object.entries(h).map(([name, value]) => ({ name, value })) : [];
  const queryString = (url: string) => {
    try {
      const u = new URL(url);
      return Array.from(u.searchParams.entries()).map(([name, value]) => ({ name, value }));
    } catch {
      return [];
    }
  };
  return {
    log: {
      version: '1.2',
      creator: { name: 'ghax', version: '0.4' },
      pages: [],
      entries: entries.map((e) => ({
        startedDateTime: new Date(e.timestamp).toISOString(),
        time: e.duration ?? 0,
        request: {
          method: e.method,
          url: e.url,
          httpVersion: 'HTTP/1.1',
          headers: asHeaders(e.requestHeaders),
          queryString: queryString(e.url),
          cookies: [],
          headersSize: -1,
          bodySize: e.requestBody !== undefined ? Buffer.byteLength(e.requestBody, 'utf8') : -1,
          ...(e.requestBody !== undefined
            ? {
                postData: {
                  mimeType: e.requestHeaders?.['content-type'] ?? '',
                  text: e.requestBody,
                },
              }
            : {}),
        },
        response: {
          status: e.status ?? 0,
          statusText: e.statusText ?? '',
          httpVersion: 'HTTP/1.1',
          headers: asHeaders(e.responseHeaders),
          cookies: [],
          content: {
            size: Number(e.responseHeaders?.['content-length'] ?? -1),
            mimeType: e.responseHeaders?.['content-type'] ?? '',
          },
          redirectURL: e.responseHeaders?.['location'] ?? '',
          headersSize: -1,
          bodySize: -1,
        },
        cache: {},
        timings: {
          send: 0,
          wait: e.duration ?? 0,
          receive: 0,
        },
      })),
    },
  };
}

/**
 * Redact a cookie's value unless the caller opted into raw values.
 * Everything else (name, domain, path, expires, httpOnly, secure,
 * sameSite) is safe to print — it's the raw session/auth value that's
 * the privacy hazard (see docs/reports/resolved/2026-06-23-setsail-localhost-dev-session.md).
 */
function redactCookie(cookie: import('playwright').Cookie, showValues: boolean): Record<string, unknown> {
  if (showValues) return { ...cookie };
  const { value, ...rest } = cookie;
  const len = typeof value === 'string' ? value.length : 0;
  return { ...rest, value: `<redacted, ${len} chars>` };
}

register('cookies', async (ctx, _args, opts) => {
  const page = await activePage(ctx);
  const context = page.context();

  const showValues = opts.values === true;
  const wantAll = opts.all === true;
  const domainFilter = typeof opts.domain === 'string' ? opts.domain.toLowerCase() : undefined;
  const urlFilter = typeof opts.url === 'string' ? opts.url : undefined;
  const hasName = typeof opts.has === 'string' ? opts.has : undefined;

  // Scope resolution:
  //   --url <u>          → cookies applicable to that URL (Playwright's own
  //                        domain/path/secure applicability match — handles
  //                        subdomains, localhost, IP literals, and ports
  //                        correctly; don't hand-roll this).
  //   --all / --domain    → whole-profile dump, filtered by --domain if given.
  //   (default)           → cookies applicable to the active tab's URL only.
  let cookies: import('playwright').Cookie[];
  if (urlFilter) {
    cookies = await context.cookies([urlFilter]);
  } else if (wantAll || domainFilter) {
    cookies = await context.cookies();
  } else {
    cookies = await context.cookies([page.url()]);
  }

  if (domainFilter) {
    cookies = cookies.filter((c) => {
      const d = String(c.domain ?? '').replace(/^\./, '').toLowerCase();
      return d.includes(domainFilter);
    });
  }

  if (hasName !== undefined) {
    const exists = cookies.some((c) => c.name === hasName);
    return { name: hasName, exists };
  }

  return cookies.map((c) => redactCookie(c, showValues));
});

register('storage', async (ctx, args) => {
  const area = String(args[0] ?? 'local');
  const op = String(args[1] ?? 'get');
  if (!['local', 'session'].includes(area)) {
    throw new Error(`Unknown storage area: ${area} (expected local or session)`);
  }
  const api = area === 'local' ? 'localStorage' : 'sessionStorage';
  const page = await activePage(ctx);

  const evalAndReturn = async (expr: string) => {
    const r = await page.evaluate(expr);
    return r;
  };

  switch (op) {
    case 'get': {
      const key = args[2] !== undefined ? String(args[2]) : null;
      if (key === null) {
        // Dump the whole store.
        return await evalAndReturn(`(() => {
          const out = {};
          for (let i = 0; i < ${api}.length; i++) {
            const k = ${api}.key(i);
            if (k) out[k] = ${api}.getItem(k);
          }
          return out;
        })()`);
      }
      return await evalAndReturn(`${api}.getItem(${JSON.stringify(key)})`);
    }
    case 'set': {
      const key = args[2] !== undefined ? String(args[2]) : '';
      const value = args[3] !== undefined ? String(args[3]) : '';
      if (!key) throw new Error('Usage: storage <area> set <key> <value>');
      await evalAndReturn(`${api}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
      return { ok: true };
    }
    case 'remove': {
      const key = args[2] !== undefined ? String(args[2]) : '';
      if (!key) throw new Error('Usage: storage <area> remove <key>');
      await evalAndReturn(`${api}.removeItem(${JSON.stringify(key)})`);
      return { ok: true };
    }
    case 'clear': {
      await evalAndReturn(`${api}.clear()`);
      return { ok: true };
    }
    case 'keys': {
      return await evalAndReturn(`(() => {
        const out = [];
        for (let i = 0; i < ${api}.length; i++) {
          const k = ${api}.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      })()`);
    }
    default:
      throw new Error(`Unknown storage op: ${op} (expected get/set/remove/clear/keys)`);
  }
});

register('viewport', async (ctx, args) => {
  const spec = String(args[0] ?? '');
  const m = spec.match(/^(\d+)x(\d+)$/);
  if (!m) throw new Error('Usage: viewport <WxH>, e.g. 1440x900');
  const page = await activePage(ctx);
  const width = Number(m[1]);
  const height = Number(m[2]);
  await page.setViewportSize({ width, height });
  return { width, height };
});

const RESPONSIVE_PRESETS: Array<{ name: string; width: number; height: number }> = [
  { name: 'mobile', width: 375, height: 667 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

register('responsive', async (ctx, args, opts) => {
  const prefix = String(args[0] ?? opts.prefix ?? `/tmp/ghax-responsive-${Date.now()}`);
  const page = await activePage(ctx);
  const before = page.viewportSize();
  const results: Array<{ name: string; width: number; height: number; path: string }> = [];
  try {
    for (const preset of RESPONSIVE_PRESETS) {
      await page.setViewportSize({ width: preset.width, height: preset.height });
      // Let layout settle — some CSS grid + responsive components need a paint.
      await page.waitForTimeout(200);
      const outPath = `${prefix}-${preset.name}.png`;
      await page.screenshot({ path: outPath, fullPage: Boolean(opts.fullPage || opts['full-page']) });
      results.push({ ...preset, path: outPath });
    }
  } finally {
    if (before) await page.setViewportSize(before).catch(() => undefined);
  }
  return results;
});

register('diff', async (ctx, args) => {
  const [a, b] = [args[0], args[1]].map((x) => (x ? String(x) : ''));
  if (!a || !b) throw new Error('Usage: diff <url1> <url2>');
  const page = await activePage(ctx);
  const textOf = async (url: string) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(() => document.body.innerText);
  };
  const textA = await textOf(a);
  const textB = await textOf(b);
  // Minimal line-based diff. Kept inline to avoid pulling in a diff library
  // for v0.2 — we can upgrade to jsdiff later if users ask.
  const la = textA.split('\n');
  const lb = textB.split('\n');
  const out: string[] = [`--- ${a}`, `+++ ${b}`];
  const max = Math.max(la.length, lb.length);
  for (let i = 0; i < max; i++) {
    if (la[i] === lb[i]) continue;
    if (la[i] !== undefined) out.push(`- ${la[i]}`);
    if (lb[i] !== undefined) out.push(`+ ${lb[i]}`);
  }
  return { diff: out.join('\n'), linesA: la.length, linesB: lb.length };
});

register('is', async (ctx, args) => {
  const check = String(args[0] ?? '');
  const target = String(args[1] ?? '');
  if (!check || !target) throw new Error('Usage: is <visible|enabled|checked|hidden|disabled> <@ref|selector>');
  const page = await activePage(ctx);
  const loc = resolveRef(ctx, target, page);
  let result: boolean;
  switch (check) {
    case 'visible':
      result = await loc.isVisible();
      break;
    case 'hidden':
      result = await loc.isHidden();
      break;
    case 'enabled':
      result = await loc.isEnabled();
      break;
    case 'disabled':
      result = await loc.isDisabled();
      break;
    case 'checked':
      result = await loc.isChecked();
      break;
    case 'editable':
      result = await loc.isEditable();
      break;
    default:
      throw new Error(`Unknown check: ${check}`);
  }
  return { check, target, result };
});

register('wait', async (ctx, args, opts) => {
  if (ctx.bridgeMode) {
    const bridge = requireBridge(ctx);
    if (opts.networkidle) {
      await bridge.send('Network.enable');
      const deadline = Date.now() + 30_000;
      let idleSince = ctx.bridgeNetworkRequests.size === 0 ? Date.now() : 0;
      while (Date.now() < deadline) {
        if (ctx.bridgeNetworkRequests.size === 0) {
          if (!idleSince) idleSince = Date.now();
          if (Date.now() - idleSince >= 500) return { ok: true };
        } else {
          idleSince = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('wait --networkidle timed out after 30000ms');
    }
    if (opts.load) {
      if (await bridgeEvaluate(bridge, 'document.readyState === "complete"').catch(() => false)) return { ok: true };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('wait --load timed out after 30000ms')); }, 30_000);
        const off = bridge.onEvent((ev) => {
          if (ev.method === 'Page.loadEventFired') { clearTimeout(timer); off(); resolve(); }
        });
      });
      return { ok: true };
    }
    const a = args[0];
    if (typeof a === 'string' && /^\d+$/.test(a)) {
      await new Promise((resolve) => setTimeout(resolve, Number(a)));
      return { ok: true };
    }
    if (typeof a === 'string') {
      const result = await bridge.send('Runtime.evaluate', {
        expression: `(async () => {
          const selector = ${JSON.stringify(a)};
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            const el = document.querySelector(selector);
            if (el) { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); if (s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0) return true; }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return false;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }, 31_000);
      const visible = Boolean((result as { result?: { value?: unknown } }).result?.value);
      if (!visible) throw new Error(`wait selector timed out after 30000ms: ${a}`);
      return { ok: true };
    }
    throw new Error('Usage: wait <selector|ms|--networkidle|--load>');
  }
  const page = await activePage(ctx);
  if (opts.networkidle) {
    await page.waitForLoadState('networkidle');
    return { ok: true };
  }
  if (opts.load) {
    await page.waitForLoadState('load');
    return { ok: true };
  }
  const a = args[0];
  if (typeof a === 'string' && /^\d+$/.test(a)) {
    await page.waitForTimeout(Number(a));
    return { ok: true };
  }
  if (typeof a === 'string') {
    await page.locator(a).first().waitFor({ state: 'visible' });
    return { ok: true };
  }
  throw new Error('Usage: wait <selector|ms|--networkidle|--load>');
});

// ─── Extension commands ────────────────────────────────────────

register('ext.list', async (ctx) => {
  const targets = await ctx.pool.list();
  const byExt = new Map<string, { id: string; targets: CdpTargetInfo[] }>();
  for (const t of targets) {
    if (!t.extensionId) continue;
    const entry = byExt.get(t.extensionId) || { id: t.extensionId, targets: [] };
    entry.targets.push(t);
    byExt.set(t.extensionId, entry);
  }
  // Enrich each extension with manifest-derived fields via its SW (or any
  // page target if no SW exists — MV2 extensions still have background_page).
  const entries = Array.from(byExt.values());
  const out = [] as Array<{
    id: string;
    name: string;
    version: string;
    targetCount: number;
    enabled: boolean;
    targets: Array<{ id: string; type: string; title: string; url: string }>;
  }>;
  for (const e of entries) {
    const probe = e.targets.find((t) => t.type === 'service_worker' && t.webSocketDebuggerUrl)
      ?? e.targets.find((t) => (t.type === 'background_page' || t.type === 'page') && t.webSocketDebuggerUrl);
    let name = '';
    let version = '';
    if (probe) {
      try {
        const target = await ctx.pool.get(probe);
        await target.send('Runtime.enable');
        const value = await evalInTarget<string>(
          target,
          '(() => { try { const m = chrome.runtime.getManifest(); return JSON.stringify({n: m.name, v: m.version}); } catch (e) { return "{}"; } })()',
        );
        const parsed = JSON.parse(value || '{}') as { n?: string; v?: string };
        name = parsed.n ?? '';
        version = parsed.v ?? '';
      } catch {
        // fall through to fallback below
      }
    }
    if (!name) {
      name = e.targets.find((t) => t.type === 'page')?.title || e.targets[0]?.title || '';
    }
    out.push({
      id: e.id,
      name,
      version,
      targetCount: e.targets.length,
      // Chrome's /json/list only surfaces enabled extensions' targets, so
      // anything we see here is enabled by definition. The field is here
      // for future compat when we teach ghax to read chrome://extensions.
      enabled: true,
      targets: e.targets.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url })),
    });
  }
  return out;
});

register('ext.targets', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  if (!extId) throw new Error('Usage: ext targets <ext-id>');
  const ts = await ctx.pool.findByExtensionId(extId);
  return ts.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url }));
});

class DaemonError extends Error {
  constructor(message: string, public exitCode: number) {
    super(message);
  }
}

/**
 * A bridge-mode error that carries a machine-readable `code` and a
 * human-facing `hint` (the recovery verb / next step), surfaced by the CLI
 * on its own line. Phase 0 of the bridge-reliability plan
 * (docs/design/plan/08-bridge-reliability.md §2.7) — the codes that need the
 * instance state machine land in Phase 1; these are the ones expressible
 * today (no extension connected, unattachable controlled tab).
 */
class BridgeError extends Error {
  constructor(message: string, public code: string, public hint?: string) {
    super(message);
  }
}

/**
 * Wrap a raw chrome.debugger / bridge failure with a code + recovery hint.
 * Recognizes the two failure shapes that reach an operator today: an
 * unattachable controlled tab (chrome://, edge://, a chrome-extension:// page,
 * or a cert interstitial) and "no extension connected".
 */
function bridgeError(raw: unknown, ctx?: { tabId?: number | null; url?: string; title?: string }): BridgeError {
  const message = (raw as { message?: string } | null)?.message ?? String(raw);
  if (/cannot (?:access|attach to)|not attachable|chrome-extension:\/\/|chrome:\/\/|edge:\/\//i.test(message)) {
    const where = ctx?.tabId != null
      ? `controlled tab ${ctx.tabId}${ctx.title ? ` (${JSON.stringify(ctx.title.slice(0, 40))})` : ''}`
      : 'the controlled tab';
    return new BridgeError(
      message,
      'BRIDGE_TAB_UNATTACHABLE',
      `${where} is not attachable (browser-internal page). Run \`ghax bridge control --active\` or \`ghax tab <id>\` to point the bridge at a normal tab.`,
    );
  }
  if (/no extension connected|extension is not initialized|bridge is not initialized/i.test(message)) {
    return new BridgeError(
      message,
      'BRIDGE_NOT_CONNECTED',
      'Load extension/ unpacked in edge://extensions, then click "Control this tab" in the ghax bridge popup (or run `ghax bridge control --active`).',
    );
  }
  return new BridgeError(message, 'BRIDGE_ERROR');
}

// evalInTarget (below) throws DaemonError on exceptionDetails so silent
// swallowing can't mask thrown expressions — ext.storage previously
// returned {ok:true} on a thrown expr. Callers that want the old
// behaviour wrap in try/catch.
async function withCdpSession<T>(
  page: Page,
  fn: (session: import('playwright').CDPSession) => Promise<T>,
): Promise<T> {
  const session = await page.context().newCDPSession(page);
  try {
    return await fn(session);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function getSwTarget(
  ctx: Ctx,
  extId: string,
): Promise<{ target: CdpTarget; info: CdpTargetInfo }> {
  const sws = await ctx.pool.findByExtensionId(extId, 'service_worker');
  if (sws.length === 0) throw new DaemonError(`No service worker for ${extId}`, 3);
  const info = sws[0];
  const target = await ctx.pool.get(info);
  await target.send('Runtime.enable');
  return { target, info };
}

async function evalInTarget<T = unknown>(
  target: CdpTarget,
  expression: string,
  opts: { awaitPromise?: boolean; wrapIife?: boolean; errorPrefix?: string; fallbackDescription?: boolean } = {},
): Promise<T | string | undefined> {
  const expr = opts.wrapIife ? `(async () => { return (${expression}); })()` : expression;
  const res = (await target.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: opts.awaitPromise ?? false,
    returnByValue: true,
  })) as { result?: { value?: T; description?: string }; exceptionDetails?: unknown };
  if (res.exceptionDetails) {
    throw new DaemonError(
      `${opts.errorPrefix ?? 'eval'} threw: ${JSON.stringify(res.exceptionDetails)}`,
      4,
    );
  }
  // `returnByValue: true` drops any result CDP can't JSON-encode (functions,
  // undefined, chrome.runtime, BigInt, Map/Set, etc.) — the caller gets
  // undefined. Opt-in fallback returns `description`, which CDP populates
  // with a stringified preview for those cases. Used by ext.sw.eval where
  // inspection of non-serialisable globals is the whole point.
  if (opts.fallbackDescription && res.result?.value === undefined) {
    return res.result?.description;
  }
  return res.result?.value;
}

register('ext.reload', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  if (!extId) throw new Error('Usage: ext reload <ext-id>');
  const { target } = await getSwTarget(ctx, extId);
  // Read content_scripts so we can warn — reload disconnects us before the promise resolves.
  let manifestCs: unknown[] = [];
  try {
    const value = await evalInTarget<string>(
      target,
      'JSON.stringify(chrome.runtime.getManifest().content_scripts || [])',
    );
    manifestCs = JSON.parse(value || '[]') as unknown[];
  } catch {
    // non-fatal; hint relies on it but reload itself doesn't
  }
  // Fire-and-forget: reload kills the WebSocket before the promise resolves.
  target.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }).catch(() => undefined);
  // Remove stale target from pool so next call re-connects.
  ctx.pool.close();
  return {
    ok: true,
    hint: manifestCs.length > 0
      ? `Extension declares ${manifestCs.length} content_scripts — run 'ghax ext hot-reload ${extId}' to also refresh them in open tabs.`
      : null,
  };
});

interface ManifestContentScript {
  matches: string[];
  js?: string[];
  css?: string[];
  run_at?: string;
  all_frames?: boolean;
}

async function findSwTarget(pool: CdpPool, extId: string): Promise<CdpTargetInfo | null> {
  const targets = await pool.findByExtensionId(extId, 'service_worker');
  return targets[0] ?? null;
}

async function waitForSw(pool: CdpPool, extId: string, timeoutMs: number): Promise<CdpTargetInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await findSwTarget(pool, extId);
    if (t?.webSocketDebuggerUrl) return t;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new DaemonError(`Service worker for ${extId} did not return within ${timeoutMs}ms`, 5);
}

register('ext.hot-reload', async (ctx, args, opts) => {
  const startedAt = Date.now();
  const extId = String(args[0] ?? '');
  if (!extId) throw new Error('Usage: ext hot-reload <ext-id>');
  const waitSeconds = opts.wait === undefined ? 5 : Number(opts.wait);
  const noInject = Boolean(opts.noInject ?? opts['no-inject']);
  const verbose = Boolean(opts.verbose);

  const sw = await findSwTarget(ctx.pool, extId);
  if (!sw?.webSocketDebuggerUrl) throw new DaemonError(`Extension ${extId} has no service worker target`, 3);

  // Step 1–3: read the manifest before reload.
  const oldTarget = await ctx.pool.get(sw);
  await oldTarget.send('Runtime.enable');
  let contentScripts: ManifestContentScript[] = [];
  let oldVersion = '';
  try {
    const value = await evalInTarget<string>(
      oldTarget,
      'JSON.stringify({v: chrome.runtime.getManifest().version, cs: chrome.runtime.getManifest().content_scripts || []})',
    );
    const parsed = JSON.parse(value || '{}') as { v?: string; cs?: ManifestContentScript[] };
    oldVersion = parsed.v ?? '';
    contentScripts = parsed.cs ?? [];
  } catch (err: any) {
    throw new DaemonError(`Could not read manifest: ${err.message}`, 4);
  }

  // Step 4: fire reload without awaiting — the SW disconnects before the promise resolves.
  oldTarget.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }).catch(() => undefined);
  // Drop the stale WebSocket; a new one will open on the new SW target.
  ctx.pool.close();

  // Step 5–6: wait, then re-discover the new SW target.
  await new Promise((r) => setTimeout(r, waitSeconds * 1000));
  const newSw = await waitForSw(ctx.pool, extId, waitSeconds * 2000);
  const newTarget = await ctx.pool.get(newSw);
  await newTarget.send('Runtime.enable');

  // Read the new version for reporting.
  let newVersion = '';
  try {
    newVersion =
      (await evalInTarget<string>(newTarget, 'chrome.runtime.getManifest().version')) || '';
  } catch {
    // non-fatal
  }

  if (noInject || contentScripts.length === 0) {
    return {
      ok: true,
      swVersion: newVersion,
      previousVersion: oldVersion,
      tabs: [],
      reinjected: 0,
      failed: 0,
      skipped: true,
      durationMs: Date.now() - startedAt,
    };
  }

  // Step 7: for each content_scripts entry, inject into matching tabs.
  interface InjectResult {
    tabId: number;
    url?: string;
    status: 'ok' | 'error';
    error?: string;
  }
  const allResults: InjectResult[] = [];
  for (const cs of contentScripts) {
    if (!cs.matches || cs.matches.length === 0) continue;
    const jsFiles = cs.js ?? [];
    const cssFiles = cs.css ?? [];
    // Build one eval expression that does the query + per-tab injection and returns a result array.
    const expr = `
      (async () => {
        const tabs = await chrome.tabs.query({ url: ${JSON.stringify(cs.matches)} });
        const out = [];
        for (const t of tabs) {
          try {
            ${jsFiles.length > 0
              ? `await chrome.scripting.executeScript({ target: { tabId: t.id${cs.all_frames ? ', allFrames: true' : ''} }, files: ${JSON.stringify(jsFiles)} });`
              : ''}
            ${cssFiles.length > 0
              ? `await chrome.scripting.insertCSS({ target: { tabId: t.id${cs.all_frames ? ', allFrames: true' : ''} }, files: ${JSON.stringify(cssFiles)} });`
              : ''}
            out.push({ tabId: t.id, url: t.url, status: 'ok' });
          } catch (e) {
            out.push({ tabId: t.id, url: t.url, status: 'error', error: String(e && e.message || e) });
          }
        }
        return JSON.stringify(out);
      })()
    `;
    const value = await evalInTarget<string>(newTarget, expr, {
      awaitPromise: true,
      errorPrefix: 'hot-reload inject',
    });
    const results = JSON.parse(value || '[]') as InjectResult[];
    allResults.push(...results);
    if (verbose) {
      // Verbose output is surfaced via log — the structured response carries the per-tab detail.
      // Structured logging happens through the main log stream which the CLI doesn't see,
      // so we just include verbose=true in the response; CLI rendering handles display.
    }
  }

  const reinjected = allResults.filter((r) => r.status === 'ok').length;
  const failed = allResults.filter((r) => r.status === 'error').length;

  return {
    ok: failed === 0,
    swVersion: newVersion,
    previousVersion: oldVersion,
    tabs: allResults,
    reinjected,
    failed,
    skipped: false,
    durationMs: Date.now() - startedAt,
    ...(verbose ? { verbose: true } : {}),
  };
});

async function ensureSwLogSubscription(ctx: Ctx, extId: string): Promise<SwLogSubscription> {
  const existing = ctx.swLogs.get(extId);
  if (existing) {
    // Check if the underlying target is still alive. After a hot-reload the
    // SW target id changes, so the old subscription is dead.
    const targets = await ctx.pool.list();
    if (targets.some((t) => t.id === existing.targetId && t.type === 'service_worker')) {
      return existing;
    }
    ctx.swLogs.delete(extId);
  }

  const { target, info: targetInfo } = await getSwTarget(ctx, extId);
  const buf = new CircularBuffer<ConsoleEntry>(BUFFER_CAP);
  target.on((event) => {
    if (event.method === 'Runtime.consoleAPICalled') {
      const p = event.params as {
        type?: string;
        args?: Array<{ value?: unknown; description?: string }>;
        timestamp?: number;
      };
      const text = (p.args || [])
        .map((a) => (a.value !== undefined ? stringifyArg(a.value) : (a.description ?? '')))
        .join(' ');
      const entry: ConsoleEntry = {
        timestamp: p.timestamp ? Math.round(p.timestamp) : Date.now(),
        level: (p.type as ConsoleEntry['level']) ?? 'log',
        text,
        source: 'service_worker',
        targetId: targetInfo.id,
      };
      buf.push(entry);
      const listeners = ctx.swLogListeners.get(extId);
      if (listeners) for (const l of listeners) l(entry);
    } else if (event.method === 'Runtime.exceptionThrown') {
      const p = event.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
      const text = p.exceptionDetails?.exception?.description
        ?? p.exceptionDetails?.text
        ?? '[unknown SW exception]';
      const entry: ConsoleEntry = {
        timestamp: Date.now(),
        level: 'error',
        text: `[exception] ${text}`,
        source: 'service_worker',
        targetId: targetInfo.id,
      };
      buf.push(entry);
      const listeners = ctx.swLogListeners.get(extId);
      if (listeners) for (const l of listeners) l(entry);
    }
  });
  const sub: SwLogSubscription = { targetId: targetInfo.id, buf };
  ctx.swLogs.set(extId, sub);
  return sub;
}

function stringifyArg(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

register('ext.sw.logs', async (ctx, args, opts) => {
  const extId = String(args[0] ?? '');
  if (!extId) throw new Error('Usage: ext sw <ext-id> logs [--last N] [--errors]');
  const sub = await ensureSwLogSubscription(ctx, extId);
  const n = opts.last ? Number(opts.last) : 200;
  const entries = sub.buf.last(n);
  const errorsOnly = Boolean(opts.errors);
  return errorsOnly ? entries.filter((e) => e.level === 'error') : entries;
});

register('ext.sw.eval', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  const js = String(args[1] ?? '');
  if (!extId || !js) throw new Error('Usage: ext sw <ext-id> eval <js>');
  const { target } = await getSwTarget(ctx, extId);
  const value = await evalInTarget(target, js, {
    awaitPromise: true,
    wrapIife: true,
    errorPrefix: 'SW eval',
    fallbackDescription: true,
  });
  return value ?? null;
});

register('ext.storage', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  const area = String(args[1] ?? 'local');
  const op = String(args[2] ?? 'get');
  if (!extId) throw new Error('Usage: ext storage <ext-id> [local|session|sync] [get|set|clear] [key] [value]');
  if (!['local', 'session', 'sync'].includes(area)) throw new Error(`Unknown area: ${area}`);
  const { target } = await getSwTarget(ctx, extId);

  let expr: string;
  if (op === 'get') {
    const key = args[3] ? JSON.stringify(String(args[3])) : 'null';
    expr = `chrome.storage.${area}.get(${key})`;
  } else if (op === 'set') {
    const key = String(args[3] ?? '');
    const value = String(args[4] ?? '');
    if (!key) throw new Error('Usage: ext storage <ext-id> <area> set <key> <value>');
    let parsed: unknown = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      // leave as string
    }
    expr = `chrome.storage.${area}.set(${JSON.stringify({ [key]: parsed })})`;
  } else if (op === 'clear') {
    expr = `chrome.storage.${area}.clear()`;
  } else {
    throw new Error(`Unknown op: ${op}`);
  }
  const value = await evalInTarget(target, expr, {
    awaitPromise: true,
    wrapIife: true,
    errorPrefix: 'ext storage',
  });
  return value ?? { ok: true };
});

register('ext.message', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  const payloadRaw = String(args[1] ?? '');
  if (!extId || !payloadRaw) throw new Error('Usage: ext message <ext-id> <json-payload>');
  let payload: unknown;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    // Allow raw strings too — wrap as {data: <string>}
    payload = payloadRaw;
  }
  const { target } = await getSwTarget(ctx, extId);
  // chrome.runtime.sendMessage from inside the SW with a recipient extension
  // ID round-trips through the extension's own onMessage listeners. For
  // cross-extension messaging, the SW would need to already be authorised.
  const expr = `
    (async () => {
      try {
        const resp = await chrome.runtime.sendMessage(${JSON.stringify(extId)}, ${JSON.stringify(payload)});
        return { ok: true, response: resp === undefined ? null : resp };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    })()
  `;
  const value = await evalInTarget(target, expr, {
    awaitPromise: true,
    errorPrefix: 'ext message',
  });
  return value ?? null;
});

// Shared eval-in-extension-page helper. `filter` decides which of the
// extension's `page` targets we talk to; the CLI wraps this with distinct
// verbs (panel, popup, options) so the user's intent is explicit.
async function extViewEval(
  ctx: Ctx,
  extId: string,
  js: string,
  filter: (url: string) => boolean,
  label: string,
): Promise<unknown> {
  if (!extId || !js) throw new Error(`Usage: ext ${label} <ext-id> eval <js>`);
  const pages = (await ctx.pool.findByExtensionId(extId, 'page')).filter((t) => filter(t.url));
  if (pages.length === 0) {
    throw new DaemonError(
      `No ${label} page open for ${extId}. Open it first (e.g. via gesture click on the extension icon).`,
      3,
    );
  }
  const target = await ctx.pool.get(pages[0]);
  await target.send('Runtime.enable');
  const value = await evalInTarget(target, js, {
    awaitPromise: true,
    wrapIife: true,
    errorPrefix: `${label} eval`,
  });
  return value ?? null;
}

// The three ext-view eval verbs differ only in label + URL filter.
// Popups are transient (target only exists while open); options pages
// are normal tabs (options.html / options_ui); panels live in the
// side panel frame (sidepanel.html).
const EXT_VIEW_FILTERS: Array<{ label: string; match: RegExp }> = [
  { label: 'panel', match: /\/sidepanel\.html|sidePanel|panel\.html/i },
  { label: 'popup', match: /\/popup\.html|\/popup\.htm|default_popup/i },
  { label: 'options', match: /\/options\.html|\/options\/|options_ui/i },
];

for (const { label, match } of EXT_VIEW_FILTERS) {
  register(`ext.${label}.eval`, async (ctx, args) => {
    const extId = String(args[0] ?? '');
    const js = String(args[1] ?? '');
    return extViewEval(ctx, extId, js, (url) => match.test(url), label);
  });
}

// ─── Gesture commands (real Input.dispatch*) ───────────────────

register('gesture.click', async (ctx, args) => {
  const spec = String(args[0] ?? '');
  if (!spec) throw new Error('Usage: gesture click <x,y>');
  const [xs, ys] = spec.split(',').map((s) => s.trim());
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid coords: ${spec}`);
  // Dispatch on the active tab's target.
  const page = await activePage(ctx);
  await withCdpSession(page, async (session) => {
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  });
  return { ok: true };
});

// ─── Profiling ─────────────────────────────────────────────────

interface MetricsSnapshot {
  at: number;
  metrics: Record<string, number>;
}

function metricsToMap(result: unknown): Record<string, number> {
  const r = result as { metrics?: Array<{ name: string; value: number }> };
  const out: Record<string, number> = {};
  for (const m of r.metrics || []) out[m.name] = m.value;
  return out;
}

async function takeMetricsViaSession(session: {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}): Promise<Record<string, number>> {
  await session.send('Performance.enable');
  const result = await session.send('Performance.getMetrics');
  return metricsToMap(result);
}

async function captureHeapSnapshot(
  cdpSession: { send: (m: string, p?: Record<string, unknown>) => Promise<unknown>; on?: unknown },
  outPath: string,
): Promise<void> {
  // Both the Playwright CDPSession and our raw CdpTarget wrap the same
  // protocol. HeapProfiler streams chunks via HeapProfiler.addHeapSnapshotChunk
  // events rather than returning the payload from takeHeapSnapshot directly,
  // so we need an event listener regardless of the session flavour.
  const listener = (event: unknown) => {
    const e = event as { method?: string; params?: { chunk?: string } };
    if (e.method === 'HeapProfiler.addHeapSnapshotChunk' && e.params?.chunk) {
      fs.appendFileSync(outPath, e.params.chunk);
    }
  };
  const off = attachSessionListener(cdpSession, listener);
  try {
    await cdpSession.send('HeapProfiler.enable');
    await cdpSession.send('HeapProfiler.collectGarbage');
    // Truncate the file before streaming in new chunks.
    fs.writeFileSync(outPath, '');
    await cdpSession.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  } finally {
    off();
  }
}

type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function asCdpSend(session: unknown): { send: CdpSend } {
  return session as { send: CdpSend };
}

function attachSessionListener(sess: unknown, cb: (event: unknown) => void): () => void {
  // Playwright CDPSession: has `.on(eventName, handler)` — we hook the
  // wildcard 'HeapProfiler.addHeapSnapshotChunk' event.
  const s = sess as {
    on?: (e: string, h: (p: unknown) => void) => void;
    off?: (e: string, h: (p: unknown) => void) => void;
  };
  if (s.on && typeof s.on === 'function' && typeof s.off === 'function') {
    const h = (params: unknown) => cb({ method: 'HeapProfiler.addHeapSnapshotChunk', params });
    s.on('HeapProfiler.addHeapSnapshotChunk', h);
    return () => s.off!('HeapProfiler.addHeapSnapshotChunk', h);
  }
  // Raw CdpTarget: its .on takes a CdpEvent consumer that fires for every event.
  const t = sess as { on?: (h: (e: unknown) => void) => () => void };
  if (t.on) {
    return t.on(cb);
  }
  return () => undefined;
}

register('profile', async (ctx, _args, opts) => {
  const durationMs = opts.duration ? Number(opts.duration) * 1000 : 0;
  const heap = Boolean(opts.heap);
  const extId = opts.extension ? String(opts.extension) : null;

  const dir = `${ctx.stateDir}/profiles`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${dir}/${extId ? `ext-${extId}-${ts}` : `tab-${ts}`}`;

  let startMetrics: Record<string, number> = {};
  let endMetrics: Record<string, number> | null = null;
  let target = extId ? `ext:${extId}` : 'active-tab';
  let heapPath: string | null = null;

  if (extId) {
    const sws = await ctx.pool.findByExtensionId(extId, 'service_worker');
    if (sws.length === 0) throw new DaemonError(`No service worker for ${extId}`, 3);
    const swTarget = await ctx.pool.get(sws[0]);
    startMetrics = await takeMetricsViaSession(swTarget);
    if (durationMs > 0) {
      await new Promise((r) => setTimeout(r, durationMs));
      endMetrics = await takeMetricsViaSession(swTarget);
    }
    if (heap) {
      heapPath = `${base}.heapsnapshot`;
      await captureHeapSnapshot(swTarget, heapPath);
    }
  } else {
    const page = await activePage(ctx);
    await withCdpSession(page, async (session) => {
      const sendable = asCdpSend(session);
      startMetrics = await takeMetricsViaSession(sendable);
      if (durationMs > 0) {
        await new Promise((r) => setTimeout(r, durationMs));
        endMetrics = await takeMetricsViaSession(sendable);
      }
      if (heap) {
        heapPath = `${base}.heapsnapshot`;
        await captureHeapSnapshot(sendable, heapPath);
      }
    });
    target = `tab:${page.url()}`;
  }

  const deltas: Record<string, number> = {};
  if (endMetrics) {
    for (const k of Object.keys(endMetrics)) {
      const s = startMetrics[k] ?? 0;
      deltas[k] = endMetrics[k] - s;
    }
  }

  const report = {
    at: new Date().toISOString(),
    target,
    durationMs,
    start: { at: Date.now() - durationMs, metrics: startMetrics } satisfies MetricsSnapshot,
    end: endMetrics ? ({ at: Date.now(), metrics: endMetrics } satisfies MetricsSnapshot) : null,
    deltas: endMetrics ? deltas : null,
    heapSnapshotPath: heapPath,
  };
  const reportPath = `${base}.json`;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { reportPath, ...report };
});

// ─── perf — Core Web Vitals + navigation timing ────────────────
//
// Reads the page's own performance timeline rather than setting up an
// observer mid-session. That means results reflect what's happened since
// page load, which is what users want 99% of the time ("how did this page
// load just now?").
//
// LCP is the most recent `largest-contentful-paint` entry. CLS is the sum
// of all `layout-shift` values excluding those with `hadRecentInput` (per
// web-vitals spec). FCP comes from the `paint` entries. TTFB is derived
// from the single `navigation` entry. INP requires user input to fire, so
// it's null for headless/scripted sessions and noted as such.
//
// Users can pass --wait <ms> to settle late paints (common for SPAs that
// finish hydrating after the load event). Without --wait we just read
// whatever's currently in the timeline.

register('perf', async (ctx, _args, opts) => {
  const waitMs = opts.wait ? Number(opts.wait) : 0;
  const page = await activePage(ctx);
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const result = await page.evaluate(async () => {
    const nav = (performance.getEntriesByType('navigation')[0] ?? null) as
      | PerformanceNavigationTiming
      | null;
    const paints = performance.getEntriesByType('paint') as PerformanceEntry[];
    const fcp = paints.find((p) => p.name === 'first-contentful-paint')?.startTime ?? null;
    const fp = paints.find((p) => p.name === 'first-paint')?.startTime ?? null;

    // LCP, CLS, and longtask entries don't live in the default performance
    // timeline buffer — they only surface via a PerformanceObserver set up
    // with `buffered: true`. Browsers deliver those buffered entries on the
    // next task, not synchronously, so we set up all three observers and
    // wait a common window before reading. Inline rather than a helper to
    // keep the function source trivially serializable for page.evaluate.
    const lcpBuf: any[] = [];
    const clsBuf: any[] = [];
    const longtaskBuf: any[] = [];
    const startObserver = (type: string, buf: any[]) => {
      try {
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) buf.push(e);
        });
        obs.observe({ type, buffered: true });
        return obs;
      } catch {
        return null;
      }
    };
    const lcpObs = startObserver('largest-contentful-paint', lcpBuf);
    const clsObs = startObserver('layout-shift', clsBuf);
    const ltObs = startObserver('longtask', longtaskBuf);
    await new Promise((r) => setTimeout(r, 300));
    lcpObs?.disconnect();
    clsObs?.disconnect();
    ltObs?.disconnect();
    const lcpEntries = lcpBuf as Array<{ renderTime: number; loadTime: number; size: number; url?: string }>;
    const clsEntries = clsBuf as Array<{ value: number; hadRecentInput: boolean }>;
    const longTaskEntries = longtaskBuf as Array<{ startTime: number; duration: number }>;

    const lastLcp = lcpEntries[lcpEntries.length - 1];
    const lcp = lastLcp ? (lastLcp.renderTime || lastLcp.loadTime) : null;
    const lcpSize = lastLcp ? lastLcp.size : null;
    const lcpUrl = lastLcp?.url ?? null;
    const cls = clsEntries.reduce((acc, s) => acc + (s.hadRecentInput ? 0 : s.value), 0);
    const ttfb = nav ? nav.responseStart - nav.requestStart : null;
    const longTasks = longTaskEntries.map((t) => ({
      startTime: t.startTime,
      duration: t.duration,
    }));
    // Navigation timing breakdown — all relative to navigationStart (which
    // is startTime=0 for the navigation entry).
    const navTiming = nav
      ? {
          redirectMs: nav.redirectEnd - nav.redirectStart,
          dnsMs: nav.domainLookupEnd - nav.domainLookupStart,
          tcpMs: nav.connectEnd - nav.connectStart,
          tlsMs: nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0,
          ttfbMs: nav.responseStart - nav.requestStart,
          responseMs: nav.responseEnd - nav.responseStart,
          domInteractiveMs: nav.domInteractive,
          domContentLoadedMs: nav.domContentLoadedEventEnd,
          loadMs: nav.loadEventEnd,
          transferSize: nav.transferSize,
          encodedBodySize: nav.encodedBodySize,
          decodedBodySize: nav.decodedBodySize,
        }
      : null;
    return {
      url: location.href,
      title: document.title,
      cwv: {
        lcp,
        lcpSize,
        lcpUrl,
        fcp,
        fp,
        cls: Number(cls.toFixed(4)),
        ttfb,
        inp: null as number | null, // requires user input to fire; null in headless
      },
      navTiming,
      longTaskCount: longTasks.length,
      longTaskTotalMs: longTasks.reduce((a, t) => a + t.duration, 0),
    };
  });
  return result;
});

// ─── Recording ─────────────────────────────────────────────────

// Commands we never store in a recording — they're either meta-operations
// on the recorder itself, or expensive read-only queries a replay should
// not re-run as the user's "actions".
const NEVER_RECORD = new Set([
  'record.start', 'record.stop', 'record.status',
  'status', 'health',
  'tabs', 'console', 'network', 'cookies', 'text', 'html',
  // Read-only queries that don't change page state — replay would re-fire
  // the measurement, not the action, and waste time. Add every new
  // read-only handler here.
  'find', 'is', 'perf', 'xpath', 'box',
]);

register('record.start', async (ctx, args) => {
  const name = String(args[0] ?? `rec-${Date.now()}`);
  ctx.recording = { name, startedAt: Date.now(), steps: [] };
  return { name, startedAt: ctx.recording.startedAt };
});

register('record.stop', async (ctx) => {
  if (!ctx.recording) throw new Error('No recording in progress');
  const rec = ctx.recording;
  ctx.recording = null;
  const dir = `${ctx.stateDir}/recordings`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const outPath = `${dir}/${rec.name}.json`;
  fs.writeFileSync(outPath, JSON.stringify(rec, null, 2), { mode: 0o600 });
  return { name: rec.name, path: outPath, steps: rec.steps.length };
});

register('record.status', async (ctx) => {
  if (!ctx.recording) return { recording: false };
  return {
    recording: true,
    name: ctx.recording.name,
    startedAt: ctx.recording.startedAt,
    steps: ctx.recording.steps.length,
  };
});

register('gesture.key', async (ctx, args) => {
  const key = String(args[0] ?? '');
  if (!key) throw new Error('Usage: gesture key <key>');
  const page = await activePage(ctx);
  await withCdpSession(page, async (session) => {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  });
  return { ok: true };
});

register('gesture.dblclick', async (ctx, args) => {
  const spec = String(args[0] ?? '');
  if (!spec) throw new Error('Usage: gesture dblclick <x,y>');
  const [xs, ys] = spec.split(',').map((s) => s.trim());
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid coords: ${spec}`);
  const page = await activePage(ctx);
  await withCdpSession(page, async (session) => {
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    // clickCount=2 on the second pressed/released is what Chrome treats as a
    // dblclick — firing pressed/released twice with clickCount=1 is NOT the
    // same and won't trigger ondblclick handlers.
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
  });
  return { ok: true };
});

register('gesture.scroll', async (ctx, args) => {
  const dir = String(args[0] ?? '').toLowerCase();
  const amount = args[1] !== undefined ? Number(args[1]) : 300;
  if (!['up', 'down', 'left', 'right'].includes(dir)) {
    throw new Error('Usage: gesture scroll <up|down|left|right> [amount=300]');
  }
  if (!Number.isFinite(amount)) throw new Error(`Invalid scroll amount: ${args[1]}`);
  const page = await activePage(ctx);
  await withCdpSession(page, async (session) => {
    // Dispatch on the viewport centre. Magnitude is the wheel delta.
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const x = viewport.width / 2;
    const y = viewport.height / 2;
    const deltaX = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
    const deltaY = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    });
  });
  return { ok: true, direction: dir, amount };
});

// ─── HTTP server ───────────────────────────────────────────────

// Re-assert normal download behaviour on our owned browser-level CDP
// session. Called after attach and after each new window. Uses `behavior:
// 'allow'` so Chromium honours the site-suggested filename (with extension)
// and writes into `ctx.downloadsDir`. No browserContextId → sets the
// browser-level default, overriding Playwright's last per-default-context
// write (the default context has no id, so both target the same scope and
// last-write-wins in our favour since attach runs this after connectOverCDP).
async function assertDownloadBehavior(ctx: Ctx): Promise<void> {
  if (!ctx.browserSession) return;
  await ctx.browserSession.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: ctx.downloadsDir,
    eventsEnabled: true,
  });
}

// Wire the browser-level download events into ctx.downloads. Kept on the
// long-lived ctx.browserSession so events keep flowing for the daemon's life.
function wireDownloadEvents(ctx: Ctx): void {
  const session = ctx.browserSession;
  if (!session) return;
  session.on('Browser.downloadWillBegin', (e: any) => {
    const entry: DownloadEntry = {
      guid: String(e.guid ?? ''),
      url: String(e.url ?? ''),
      suggestedFilename: String(e.suggestedFilename ?? ''),
      finalPath: null,
      state: 'inProgress',
      totalBytes: null,
      receivedBytes: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    ctx.downloads.push(entry);
  });
  session.on('Browser.downloadProgress', (e: any) => {
    const guid = String(e.guid ?? '');
    const entry = ctx.downloads.findMostRecent((d) => d.guid === guid);
    if (!entry) return;
    if (e.state === 'inProgress' || e.state === 'completed' || e.state === 'canceled') {
      entry.state = e.state;
    }
    if (typeof e.totalBytes === 'number') entry.totalBytes = e.totalBytes;
    if (typeof e.receivedBytes === 'number') entry.receivedBytes = e.receivedBytes;
    entry.updatedAt = Date.now();
    if (entry.state === 'completed') {
      // With behavior 'allow', Chromium writes the file under its
      // suggested name and de-dupes collisions itself. Resolve the real
      // on-disk path best-effort: prefer the suggested name, otherwise
      // find the freshest `base (n).ext` sibling Chromium may have chosen.
      entry.finalPath = resolveDownloadedPath(ctx.downloadsDir, entry.suggestedFilename);
    }
  });
}

// Best-effort resolution of where a completed download actually landed.
// 'allow' behaviour means Chromium owns the final name; on a collision it
// appends ` (1)`, ` (2)`, … before the extension. We return the suggested
// path if present, else the newest matching de-duped sibling, else the
// suggested path anyway (so callers always get a stable, sensible value).
function resolveDownloadedPath(dir: string, suggestedRaw: string): string {
  // suggestedFilename comes from the page/server (Browser.downloadWillBegin)
  // and must never be trusted as a path: a hostile site can suggest
  // "../../.zshrc". Chromium sanitizes the name it actually writes, but the
  // finalPath we report must stay inside the downloads dir too — automation
  // downstream moves/deletes finalPath and must not be steerable outside it.
  const suggested = path.basename(suggestedRaw.replace(/\0/g, '')) || 'download';
  const exact = path.join(dir, suggested);
  try {
    if (fs.existsSync(exact)) return exact;
    const ext = path.extname(suggested);
    const base = suggested.slice(0, suggested.length - ext.length);
    const re = new RegExp(`^${escapeRegExp(base)} \\(\\d+\\)${escapeRegExp(ext)}$`);
    const candidates = fs
      .readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 0) return candidates[0].full;
  } catch {
    /* ignore — return the suggested path below */
  }
  return exact;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveDownloadsDir(): string {
  const raw = process.env.GHAX_DOWNLOADS_DIR;
  const dir = raw && raw.trim() ? raw.trim() : path.join(os.homedir(), 'Downloads');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort — Chromium will error visibly if the dir is unwritable */
  }
  return dir;
}

async function main() {
  const cfg = resolveConfig();
  const cdpHttpUrl = process.env.GHAX_CDP_HTTP_URL;
  const cdpBrowserUrl = process.env.GHAX_CDP_BROWSER_URL;
  const browserKind = process.env.GHAX_BROWSER_KIND || 'chromium';
  // GHAX_CAPTURE_BODIES is absent (no capture), "*" (capture all),
  // or a glob-ish pattern like "*/api/*" (capture URLs matching).
  // We treat it as a simple glob: '*' → any, otherwise the pattern is
  // converted to a RegExp with * → .* for matching URL substrings.
  const captureBodiesPattern = process.env.GHAX_CAPTURE_BODIES ?? null;
  // Bridge mode (`ghax attach --extension`) — see the module doc comment
  // and bridge.ts. No CDP endpoint is required in this mode: there is no
  // `connectOverCDP` at all, so GHAX_CDP_HTTP_URL/GHAX_CDP_BROWSER_URL are
  // only mandatory on the normal path.
  const bridgeMode = process.env.GHAX_BRIDGE === '1';
  const bridgePort = Number(process.env.GHAX_BRIDGE_PORT) || 9223;
  if (!bridgeMode && (!cdpHttpUrl || !cdpBrowserUrl)) {
    console.error('ghax daemon: missing GHAX_CDP_HTTP_URL / GHAX_CDP_BROWSER_URL env');
    process.exit(4);
  }

  const logStream = fs.createWriteStream(cfg.daemonLog, { flags: 'a', mode: 0o600 });
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      logStream.write(line);
    } catch {
      // best-effort
    }
  };
  log(bridgeMode ? `daemon starting in bridge mode, wsPort=${bridgePort}` : `daemon starting, cdpHttp=${cdpHttpUrl}`);

  // Defense-in-depth: a stray async throw (e.g. inside a CDP event handler,
  // where there's no promise for the caller to await) must not silently kill
  // the daemon and leave the RPC socket dangling. Log it and survive — a
  // browser-automation daemon that stays up is far more useful than one that
  // dies mid-session. The stderr capture file is unlinked once the daemon is
  // healthy, so without this the stack would vanish into a deleted fd.
  process.on('unhandledRejection', (reason) => {
    log(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    log(`UNCAUGHT EXCEPTION: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let bridge: Bridge | null = null;

  if (bridgeMode) {
    bridge = new Bridge(bridgePort, log);
    log(`bridge: listening on ws://127.0.0.1:${bridgePort} — waiting for extension`);
    bridge.on('hello', (info: { agent?: string; version?: string }) => {
      log(`bridge: extension connected (${info.agent ?? 'unknown'} v${info.version ?? '?'})`);
    });
    bridge.on('controlled', (tabId: number | null) => {
      log(`bridge: controlled tab = ${tabId ?? 'none'}`);
    });
    bridge.on('disconnect', () => {
      log('bridge: extension disconnected — waiting for reconnect');
    });
    // `ghax attach --extension --control-active` sets this so the extension
    // drives the browser's active tab immediately on connect — no popup
    // click. Stored (not sent) here; the Bridge's `hello` handler sends it
    // once the extension is live, and re-asserts it on every reconnect.
    if (process.env.GHAX_BRIDGE_CONTROL === 'active') {
      bridge.setDesiredControl({ action: 'control-active' });
      log('bridge: will control the active tab on connect (--control-active)');
    }
    // `ghax attach --extension --browser edge|chrome|<label>` restricts which
    // instance may bind, so a second browser (or a forgotten install in
    // another profile) parks instead of racing for the session.
    const bindFilter = process.env.GHAX_BRIDGE_BROWSER;
    if (bindFilter && bindFilter.trim()) {
      bridge.setBindFilter(bindFilter);
      log(`bridge: only '${bindFilter}' may bind — other instances will park`);
    }
  } else {
    browser = await chromium.connectOverCDP(cdpHttpUrl!);
    const contexts = browser.contexts();
    context = contexts[0] ?? (await browser.newContext());

    // If the user quits the browser (or it crashes) while we're attached,
    // Playwright fires `disconnected` on the Browser object. Without this
    // listener, subsequent commands throw a raw "Target page has been closed"
    // stack trace. Here we catch the event and shut the daemon cleanly — the
    // state file gets cleared, and the next `ghax attach` starts fresh.
    browser.on('disconnected', () => {
      log('browser disconnected — shutting down daemon');
      // shutdown() is defined further down in the outer scope via closure;
      // call it via setImmediate to avoid running inside a Playwright event
      // handler which can re-enter odd code paths during teardown.
      setImmediate(() => {
        void shutdown('browser-disconnected');
      });
    });
  }

  const ctx: Ctx = {
    browser,
    context,
    cdpHttpUrl: cdpHttpUrl ?? '',
    cdpBrowserUrl: cdpBrowserUrl ?? (bridgeMode ? `bridge://127.0.0.1:${bridgePort}` : ''),
    browserKind,
    bridgeMode,
    bridge,
    pool: new CdpPool(cdpHttpUrl ?? ''),
    consoleBuf: new CircularBuffer<ConsoleEntry>(BUFFER_CAP),
    networkBuf: new CircularBuffer<NetworkEntry>(BUFFER_CAP),
    sourceMapCache: new SourceMapCache(),
    captureBodiesRe: captureBodiesPattern !== null ? globToRegExp(captureBodiesPattern) : null,
    activePageId: null,
    refs: new Map(),
    bridgeRefs: new Map(),
    bridgeNetworkRequests: new Map(),
    instrumented: new WeakSet<Page>(),
    startedAt: Date.now(),
    stateDir: cfg.stateDir,
    recording: null,
    swLogs: new Map(),
    consoleListeners: new Set(),
    networkListeners: new Set(),
    swLogListeners: new Map(),
    downloadsDir: resolveDownloadsDir(),
    downloads: new CircularBuffer<DownloadEntry>(200),
    browserSession: null,
  };

  if (bridgeMode && bridge) {
    wireBridgeEvents(ctx);
    bridge.on('controlled', (tabId: number | null) => {
      clearSnapshotRefs(ctx);
      ctx.bridgeNetworkRequests.clear();
      ctx.activePageId = tabId === null ? null : String(tabId);
      if (tabId !== null) void enableBridgeDomains(ctx);
    });
    bridge.on('hello', () => {
      if (bridge.controlledTabId !== null) void enableBridgeDomains(ctx);
    });
    if (bridge.controlledTabId !== null) {
      ctx.activePageId = String(bridge.controlledTabId);
      void enableBridgeDomains(ctx);
    }
  }

  if (!bridgeMode && browser) {
    // Undo Playwright's download hijack. connectOverCDP has, by now, issued
    // `Browser.setDownloadBehavior` (allowAndName → its temp artifacts dir).
    // Open our own browser-level CDP session, re-assert `behavior: 'allow'`
    // with downloadPath = the real Downloads dir, and keep it alive to receive
    // downloadWillBegin / downloadProgress events.
    try {
      ctx.browserSession = await browser.newBrowserCDPSession();
      wireDownloadEvents(ctx);
      await assertDownloadBehavior(ctx);
      log(`download behavior re-asserted → allow, dir=${ctx.downloadsDir}`);
    } catch (err) {
      log(`WARN: failed to set download behavior: ${String(err)}`);
    }

    // Instrument the first page now so console/network start capturing immediately.
    const pages = await allPages(ctx);
    if (pages.length > 0) {
      ctx.activePageId = await pageTargetId(pages[0]);
      await instrumentPage(ctx, pages[0]);
    }
  }

  let lastActivity = Date.now();
  const dispatch = async (cmd: string, args: unknown[], opts: Record<string, unknown>) => {
    const handler = handlers.get(cmd);
    if (!handler) throw new Error(`Unknown command: ${cmd}`);
    lastActivity = Date.now();
    const result = await handler(ctx, args, opts);
    if (ctx.recording && !NEVER_RECORD.has(cmd)) {
      ctx.recording.steps.push({ cmd, args, opts, at: Date.now() });
    }
    return result;
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    if (url === '/health' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - ctx.startedAt,
        browserKind,
      });
      return;
    }
    // Bridge-mode-only: `ghax attach --extension` polls this until the
    // extension's `hello` handshake lands (see attach.rs). Harmless (and
    // always `connected:false`) outside bridge mode.
    if (url === '/bridge-status' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        bridgeMode,
        connected: ctx.bridge?.connected ?? false,
        controlledTabId: ctx.bridge?.controlledTabId ?? null,
        extensionInfo: ctx.bridge?.extensionInfo ?? null,
        state: ctx.bridge?.state ?? 'UNBOUND',
        instances: ctx.bridge?.instances() ?? [],
        livelockSuspected: ctx.bridge?.livelockSuspected ?? false,
      });
      return;
    }
    // `ghax version --full` reads this to answer "which daemon bundle is the
    // RUNNING daemon actually executing" — the exact question the stale-binary
    // trap turns into a two-hour debugging session. The daemon hashes its own
    // entry file (process.argv[1]); the CLI compares it against the bundle that
    // resolves now and flags a mismatch.
    if (url === '/version' && req.method === 'GET') {
      const bundlePath = process.argv[1] ?? '';
      let bundleSha256 = '';
      try {
        bundleSha256 = crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
      } catch {
        // Bundle unreadable from here (unusual) — report empty, don't crash.
      }
      json(res, 200, {
        ok: true,
        bundlePath,
        bundleSha256,
        bridgeMode,
        controlledTabId: ctx.bridge?.controlledTabId ?? null,
        extensionInfo: ctx.bridge?.extensionInfo ?? null,
      });
      return;
    }
    if (url === '/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true });
      setTimeout(() => shutdown('shutdown-request'), 20);
      return;
    }

    // ─── Server-Sent Events endpoints ─────────────────────────
    //
    // Each endpoint:
    //   1. Sets text/event-stream headers.
    //   2. Registers a listener against the appropriate in-memory source.
    //   3. Writes `data: <json>\n\n` per event.
    //   4. Sends a `:ping` line every 15s to keep proxies / long-lived
    //      intermediaries from killing the connection.
    //   5. On `close`, removes the listener so the buffer GC can reclaim.
    //
    // The CLI side (streamSse) fetches with a reader and prints lines.
    if (url.startsWith('/sse/') && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const write = (obj: unknown) => {
        try {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch {
          // socket closed — cleanup via req close handler
        }
      };
      const keepAlive = setInterval(() => {
        try {
          res.write(':ping\n\n');
        } catch {
          // ignore
        }
      }, 15_000);

      let cleanup: () => void = () => undefined;

      if (url === '/sse/console') {
        ctx.consoleListeners.add(write);
        cleanup = () => ctx.consoleListeners.delete(write);
      } else if (url === '/sse/network') {
        ctx.networkListeners.add(write);
        cleanup = () => ctx.networkListeners.delete(write);
      } else if (url.startsWith('/sse/ext-sw-logs/')) {
        if (ctx.bridgeMode) {
          write({ error: 'ext.sw.logs: not supported over the extension bridge yet' });
          clearInterval(keepAlive);
          res.end();
          return;
        }
        const extId = decodeURIComponent(url.slice('/sse/ext-sw-logs/'.length));
        try {
          // Force the subscription to exist before attaching the listener.
          await ensureSwLogSubscription(ctx, extId);
        } catch (err: any) {
          write({ error: err.message });
          clearInterval(keepAlive);
          res.end();
          return;
        }
        let listeners = ctx.swLogListeners.get(extId);
        if (!listeners) {
          listeners = new Set();
          ctx.swLogListeners.set(extId, listeners);
        }
        listeners.add(write);
        cleanup = () => listeners!.delete(write);
      } else {
        res.writeHead(404);
        res.end('Unknown SSE stream');
        clearInterval(keepAlive);
        return;
      }

      req.on('close', () => {
        clearInterval(keepAlive);
        cleanup();
      });
      return;
    }
    if (url === '/rpc' && req.method === 'POST') {
      let body: { cmd?: string; args?: unknown[]; opts?: Record<string, unknown> };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { ok: false, error: 'Invalid JSON body' });
        return;
      }
      if (!body.cmd) {
        json(res, 400, { ok: false, error: 'Missing cmd' });
        return;
      }
      try {
        const data = await dispatch(body.cmd, body.args ?? [], body.opts ?? {});
        json(res, 200, { ok: true, data });
      } catch (err: any) {
        log(`rpc ${body.cmd} failed: ${err.message}`);
        const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : undefined;
        const code = typeof err?.code === 'string' ? err.code : undefined;
        const hint = typeof err?.hint === 'string' ? err.hint : undefined;
        json(res, 500, {
          ok: false,
          error: err.message || String(err),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(code !== undefined ? { code } : {}),
          ...(hint !== undefined ? { hint } : {}),
        });
      }
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`http.createServer returned invalid port: ${port}`);
  }
  const state: DaemonState = {
    pid: process.pid,
    port,
    browserUrl: cdpBrowserUrl ?? `bridge://127.0.0.1:${bridgePort}`,
    browserKind: browserKind as DaemonState['browserKind'],
    attachedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };
  writeState(cfg, state);
  log(`listening on 127.0.0.1:${port}`);

  // Idle watchdog.
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) {
      log(`idle for ${IDLE_MS / 1000}s — shutting down`);
      shutdown('idle');
    }
  }, 60_000);

  let shuttingDown = false;
  async function shutdown(reason: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown: ${reason}`);
    clearInterval(idleTimer);
    try {
      ctx.pool.close();
      ctx.sourceMapCache.destroy();
      if (bridge) bridge.close();
      if (browser) await browser.close().catch(() => undefined);
    } catch {
      // ignore
    }
    // Only clear the state file if it still points to us.
    const current = readState(cfg);
    if (current && current.pid === process.pid) {
      try {
        fs.unlinkSync(cfg.stateFile);
      } catch {
        // ignore
      }
    }
    server.close();
    logStream.end();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('ghax daemon fatal:', err);
  process.exit(1);
});
