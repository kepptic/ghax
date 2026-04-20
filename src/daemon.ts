/**
 * ghax daemon — persistent Node http server.
 *
 * Owns:
 *   - Playwright Browser (connected via chromium.connectOverCDP)
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
 *   GET  /health      → quick liveness probe
 *   POST /rpc         → { cmd, args?, opts? } → { ok, data } | { ok:false, error }
 *   POST /shutdown    → exits
 *
 * Single-user localhost daemon, bound to 127.0.0.1. No auth in v0.1.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { CdpPool, type CdpTarget, type CdpTargetInfo } from './cdp-client';
import { resolveConfig, type DaemonState, writeState, readState } from './config';
import { CircularBuffer, parseStack, type ConsoleEntry, type NetworkEntry } from './buffers';
import { SourceMapCache, resolveStack } from './source-maps';
import type { RefEntry } from './snapshot';
import { snapshot as takeSnapshot } from './snapshot';
import * as fs from 'fs';
import * as http from 'http';
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

interface Ctx {
  browser: Browser;
  context: BrowserContext;
  cdpHttpUrl: string;
  cdpBrowserUrl: string;
  browserKind: string;
  pool: CdpPool;
  consoleBuf: CircularBuffer<ConsoleEntry>;
  networkBuf: CircularBuffer<NetworkEntry>;
  sourceMapCache: SourceMapCache;
  captureBodiesRe: RegExp | null;  // null = don't capture; set = capture URLs matching
  activePageId: string | null;
  refs: Map<string, RefEntry>;
  instrumented: WeakSet<Page>;
  startedAt: number;
  stateDir: string;
  recording: Recording | null;
  swLogs: Map<string, SwLogSubscription>;
  consoleListeners: Set<StreamListener>;
  networkListeners: Set<StreamListener>;
  swLogListeners: Map<string, Set<StreamListener>>;
}

type Handler = (ctx: Ctx, args: unknown[], opts: Record<string, unknown>) => Promise<unknown>;

const handlers = new Map<string, Handler>();

function register(name: string, fn: Handler) {
  handlers.set(name, fn);
}

// ─── Page / target helpers ─────────────────────────────────────

async function allPages(ctx: Ctx): Promise<Page[]> {
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
        if (body.length > BODY_CAP_BYTES) {
          entry.responseBody = body.slice(0, BODY_CAP_BYTES) + `\n[truncated ${body.length - BODY_CAP_BYTES} bytes]`;
          entry.responseBodyTruncated = true;
        } else {
          entry.responseBody = body;
        }
      })
      .catch(() => {
        // Response body may be unavailable (opaque CORS, navigation frame
        // already gone, etc.). Leave the field undefined; not an error.
      })
      .finally(release);
  });
}

/**
 * Convert a simple glob (just `*` wildcards) to an anchored RegExp.
 * Matches full strings; `*` expands to `.*`. No support for `**`
 * (would be identical to `*` under this semantics anyway) or `?`.
 */
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
      if (/json|text|javascript|xml|html|css|graphql/.test(ct)) {
        captureBodyAsync(e, resp);
      }
    }
  });
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

// ─── Command handlers ──────────────────────────────────────────

register('status', async (ctx) => {
  const pages = await allPages(ctx);
  const targets = await ctx.pool.list();
  const extIds = new Set<string>();
  for (const t of targets) if (t.extensionId) extIds.add(t.extensionId);
  return {
    pid: process.pid,
    uptimeMs: Date.now() - ctx.startedAt,
    browserKind: ctx.browserKind,
    browserUrl: ctx.cdpBrowserUrl,
    tabCount: pages.length,
    targetCount: targets.length,
    extensionCount: extIds.size,
  };
});

register('tabs', async (ctx) => {
  const pages = await allPages(ctx);
  return Promise.all(
    pages.map(async (p) => {
      const [id, title] = await Promise.all([pageTargetId(p), p.title().catch(() => '')]);
      return { id, title, url: p.url(), active: id === ctx.activePageId };
    }),
  );
});

register('tab', async (ctx, args, opts) => {
  const id = String(args[0] ?? '');
  if (!id) throw new Error('Usage: tab <id>');
  const pages = await allPages(ctx);
  for (const p of pages) {
    const tid = await pageTargetId(p);
    if (tid === id) {
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
  const context = ctx.browser.contexts()[0];
  if (!context) throw new Error('newWindow: no browser context available');
  const cdpSession = await ctx.browser.newBrowserCDPSession();
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
    ctx.activePageId = id;
    await instrumentPage(ctx, newPage);
    return {
      id,
      url: newPage.url(),
      title: await newPage.title().catch(() => ''),
    };
  } finally {
    await cdpSession.detach().catch(() => undefined);
  }
});

register('goto', async (ctx, args) => {
  const url = String(args[0] ?? '');
  if (!url) throw new Error('Usage: goto <url>');
  const page = await activePage(ctx);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { url: page.url(), title: await page.title().catch(() => '') };
});

register('back', async (ctx) => {
  const page = await activePage(ctx);
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  return { url: page.url() };
});

register('forward', async (ctx) => {
  const page = await activePage(ctx);
  await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  return { url: page.url() };
});

register('reload', async (ctx) => {
  const page = await activePage(ctx);
  await page.reload({ waitUntil: 'domcontentloaded' });
  return { url: page.url() };
});

register('eval', async (ctx, args) => {
  const js = String(args[0] ?? '');
  if (!js) throw new Error('Usage: eval <js>');
  const page = await activePage(ctx);
  const result = await page.evaluate(js);
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

register('text', async (ctx) => {
  const page = await activePage(ctx);
  const text = await page.evaluate(() => document.body.innerText);
  return text;
});

register('html', async (ctx, args) => {
  const sel = args[0] ? String(args[0]) : null;
  const page = await activePage(ctx);
  if (sel) return await page.locator(sel).first().innerHTML();
  return await page.content();
});

register('screenshot', async (ctx, args, opts) => {
  const page = await activePage(ctx);
  const outPath = (opts.path as string) || `/tmp/ghax-shot-${Date.now()}.png`;
  const target = args[0] ? String(args[0]) : null;
  if (target) {
    await resolveRef(ctx, target, page).screenshot({ path: outPath });
  } else {
    await page.screenshot({ path: outPath, fullPage: Boolean(opts.fullPage) });
  }
  return { path: outPath };
});

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
  const page = await activePage(ctx);
  const locator = resolveRef(ctx, target, page);
  const box = await locator.first().boundingBox();
  if (!box) throw new Error(`${target}: element not visible or not in layout`);
  return box;
});

register('snapshot', async (ctx, _args, opts) => {
  const page = await activePage(ctx);
  const result = await takeSnapshot(page, {
    interactive: Boolean(opts.interactive),
    compact: Boolean(opts.compact),
    depth: opts.depth === undefined ? undefined : Number(opts.depth),
    selector: opts.selector as string | undefined,
    cursorInteractive: Boolean(opts.cursorInteractive),
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

register('click', async (ctx, args) => {
  const target = String(args[0] ?? '');
  if (!target) throw new Error('Usage: click <@ref|selector>');
  const page = await activePage(ctx);
  const loc = resolveRef(ctx, target, page);
  await loc.click();
  return { ok: true };
});

register('fill', async (ctx, args) => {
  const target = String(args[0] ?? '');
  const value = String(args[1] ?? '');
  if (!target) throw new Error('Usage: fill <@ref|selector> <value>');
  const page = await activePage(ctx);
  const loc = resolveRef(ctx, target, page);
  // React-safe path: set the value via the native setter and dispatch
  // an 'input' event, so React's synthetic-event bookkeeping updates
  // its internal state (plain page.fill() triggers the controlled-input
  // "input value mismatch" bug on some code).
  await loc.evaluate((el, v) => {
    const e = el as HTMLInputElement | HTMLTextAreaElement;
    const proto = Object.getPrototypeOf(e);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(e, v);
    else (e as any).value = v;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  return { ok: true };
});

register('press', async (ctx, args) => {
  const key = String(args[0] ?? '');
  if (!key) throw new Error('Usage: press <key>');
  const page = await activePage(ctx);
  await page.keyboard.press(key);
  return { ok: true };
});

register('type', async (ctx, args) => {
  const text = String(args[0] ?? '');
  const page = await activePage(ctx);
  await page.keyboard.type(text);
  return { ok: true };
});

register('console', async (ctx, _args, opts) => {
  const errorsOnly = Boolean(opts.errors);
  const dedup = Boolean(opts.dedup);
  const sourceMaps = Boolean(opts['source-maps']);
  const n = opts.last ? Number(opts.last) : 200;
  let entries = ctx.consoleBuf.last(n);
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

  let entries = ctx.networkBuf.last(n);
  if (pattern) entries = entries.filter((e) => pattern.test(e.url));
  if (statusTest) entries = entries.filter((e) => statusTest!(e.status));

  if (harPath) {
    const har = buildHar(entries);
    fs.writeFileSync(harPath, JSON.stringify(har, null, 2));
    return { harPath, entryCount: entries.length };
  }
  return entries;
});

// Minimal HAR 1.2 generator. We don't capture bodies, so content.size comes
// from Content-Length when available and body text is omitted. Good enough
// for waterfall + diagnostics tools (Charles, har-analyzer, WebPageTest).
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
          bodySize: -1,
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

register('cookies', async (ctx) => {
  const page = await activePage(ctx);
  return await page.context().cookies();
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
      await page.screenshot({ path: outPath, fullPage: Boolean(opts.fullPage) });
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

// Centralised `Runtime.evaluate` with returnByValue + exception surfacing.
// Every CDP-eval site used to open-code the same shape and (inconsistently)
// the exceptionDetails check — the silent sites were masking real errors
// (ext.storage returned {ok:true} on thrown expressions). Throwing here
// surfaces them as DaemonError; callers that want to swallow wrap in
// try/catch as they already do.
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
  opts: { awaitPromise?: boolean; wrapIife?: boolean; errorPrefix?: string } = {},
): Promise<T | undefined> {
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

register('ext.panel.eval', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  const js = String(args[1] ?? '');
  return extViewEval(
    ctx,
    extId,
    js,
    (url) => /\/sidepanel\.html|sidePanel|panel\.html/i.test(url),
    'panel',
  );
});

register('ext.popup.eval', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  const js = String(args[1] ?? '');
  // Popups are transient — a page target only exists while the popup is
  // actually open. Matching by popup.html or action/default_popup path.
  return extViewEval(
    ctx,
    extId,
    js,
    (url) => /\/popup\.html|\/popup\.htm|default_popup/i.test(url),
    'popup',
  );
});

register('ext.options.eval', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  const js = String(args[1] ?? '');
  // Options pages open as normal tabs when the user clicks "Options" in
  // the extensions panel. Path convention: options.html or options_ui.
  return extViewEval(
    ctx,
    extId,
    js,
    (url) => /\/options\.html|\/options\/|options_ui/i.test(url),
    'options',
  );
});

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
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  } finally {
    await session.detach().catch(() => undefined);
  }
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

  let startMetrics: Record<string, number>;
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
    const session = await page.context().newCDPSession(page);
    const sendable = asCdpSend(session);
    try {
      startMetrics = await takeMetricsViaSession(sendable);
      if (durationMs > 0) {
        await new Promise((r) => setTimeout(r, durationMs));
        endMetrics = await takeMetricsViaSession(sendable);
      }
      if (heap) {
        heapPath = `${base}.heapsnapshot`;
        await captureHeapSnapshot(sendable, heapPath);
      }
    } finally {
      await session.detach().catch(() => undefined);
    }
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
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  } finally {
    await session.detach().catch(() => undefined);
  }
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
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    // clickCount=2 on the second pressed/released is what Chrome treats as a
    // dblclick — firing pressed/released twice with clickCount=1 is NOT the
    // same and won't trigger ondblclick handlers.
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
  } finally {
    await session.detach().catch(() => undefined);
  }
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
  const session = await page.context().newCDPSession(page);
  try {
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
  } finally {
    await session.detach().catch(() => undefined);
  }
  return { ok: true, direction: dir, amount };
});

// ─── HTTP server ───────────────────────────────────────────────

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
  if (!cdpHttpUrl || !cdpBrowserUrl) {
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
  log(`daemon starting, cdpHttp=${cdpHttpUrl}`);

  const browser = await chromium.connectOverCDP(cdpHttpUrl);
  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext());

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

  const ctx: Ctx = {
    browser,
    context,
    cdpHttpUrl,
    cdpBrowserUrl,
    browserKind,
    pool: new CdpPool(cdpHttpUrl),
    consoleBuf: new CircularBuffer<ConsoleEntry>(BUFFER_CAP),
    networkBuf: new CircularBuffer<NetworkEntry>(BUFFER_CAP),
    sourceMapCache: new SourceMapCache(),
    captureBodiesRe: captureBodiesPattern !== null ? globToRegExp(captureBodiesPattern) : null,
    activePageId: null,
    refs: new Map(),
    instrumented: new WeakSet<Page>(),
    startedAt: Date.now(),
    stateDir: cfg.stateDir,
    recording: null,
    swLogs: new Map(),
    consoleListeners: new Set(),
    networkListeners: new Set(),
    swLogListeners: new Map(),
  };

  // Instrument the first page now so console/network start capturing immediately.
  const pages = await allPages(ctx);
  if (pages.length > 0) {
    ctx.activePageId = await pageTargetId(pages[0]);
    await instrumentPage(ctx, pages[0]);
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
        json(res, 500, { ok: false, error: err.message || String(err), ...(exitCode !== undefined ? { exitCode } : {}) });
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
    browserUrl: cdpBrowserUrl,
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
      await browser.close().catch(() => undefined);
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
