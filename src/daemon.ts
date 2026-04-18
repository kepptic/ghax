/**
 * ghax daemon — persistent Bun.serve HTTP server.
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
import { CdpPool, type CdpTargetInfo } from './cdp-client';
import { resolveConfig, type DaemonState, writeState, readState } from './config';
import { CircularBuffer, type ConsoleEntry, type NetworkEntry } from './buffers';
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

interface Ctx {
  browser: Browser;
  context: BrowserContext;
  cdpHttpUrl: string;
  cdpBrowserUrl: string;
  browserKind: string;
  pool: CdpPool;
  consoleBuf: CircularBuffer<ConsoleEntry>;
  networkBuf: CircularBuffer<NetworkEntry>;
  activePageId: string | null;
  refs: Map<string, RefEntry>;
  instrumented: WeakSet<Page>;
  startedAt: number;
  stateDir: string;
  recording: Recording | null;
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

async function pageTargetId(page: Page): Promise<string | null> {
  try {
    const session = await page.context().newCDPSession(page);
    const info = await session.send('Target.getTargetInfo');
    await session.detach().catch(() => undefined);
    return (info as any)?.targetInfo?.targetId ?? null;
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

async function instrumentPage(ctx: Ctx, page: Page): Promise<void> {
  if (ctx.instrumented.has(page)) return;
  ctx.instrumented.add(page);

  page.on('console', (msg) => {
    ctx.consoleBuf.push({
      timestamp: Date.now(),
      level: (msg.type() as ConsoleEntry['level']) ?? 'log',
      text: msg.text(),
      url: page.url(),
      source: 'tab',
    });
  });
  page.on('pageerror', (err) => {
    ctx.consoleBuf.push({
      timestamp: Date.now(),
      level: 'error',
      text: `[pageerror] ${err.message}`,
      url: page.url(),
      source: 'tab',
    });
  });
  page.on('request', (req) => {
    ctx.networkBuf.push({
      timestamp: Date.now(),
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
    });
  });
  page.on('response', (resp) => {
    // Best-effort: stamp status onto the most recent matching request entry.
    const arr = ctx.networkBuf.toArray();
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      if (e.url === resp.url() && e.status === undefined) {
        e.status = resp.status();
        break;
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
  const out = [];
  for (const p of pages) {
    const id = await pageTargetId(p);
    out.push({
      id,
      title: await p.title().catch(() => ''),
      url: p.url(),
      active: id === ctx.activePageId,
    });
  }
  return out;
});

register('tab', async (ctx, args) => {
  const id = String(args[0] ?? '');
  if (!id) throw new Error('Usage: tab <id>');
  const pages = await allPages(ctx);
  for (const p of pages) {
    const tid = await pageTargetId(p);
    if (tid === id) {
      ctx.activePageId = tid;
      await instrumentPage(ctx, p);
      await p.bringToFront().catch(() => undefined);
      return { id: tid, url: p.url(), title: await p.title().catch(() => '') };
    }
  }
  throw new Error(`No tab with id ${id}`);
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
  const n = opts.last ? Number(opts.last) : 200;
  const entries = ctx.consoleBuf.last(n);
  return errorsOnly ? entries.filter((e) => e.level === 'error') : entries;
});

register('network', async (ctx, _args, opts) => {
  const n = opts.last ? Number(opts.last) : 200;
  const pattern = opts.pattern ? new RegExp(String(opts.pattern)) : null;
  const entries = ctx.networkBuf.last(n);
  return pattern ? entries.filter((e) => pattern.test(e.url)) : entries;
});

register('cookies', async (ctx) => {
  const page = await activePage(ctx);
  return await page.context().cookies();
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
  const byExt = new Map<string, { id: string; name?: string; targets: CdpTargetInfo[] }>();
  for (const t of targets) {
    if (!t.extensionId) continue;
    const entry = byExt.get(t.extensionId) || { id: t.extensionId, targets: [] };
    entry.targets.push(t);
    byExt.set(t.extensionId, entry);
  }
  return Array.from(byExt.values()).map((e) => ({
    id: e.id,
    targetCount: e.targets.length,
    // Best-effort name: the title of the first non-"service worker" target.
    name: e.targets.find((t) => t.type === 'page')?.title || e.targets[0]?.title || '',
    targets: e.targets.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url })),
  }));
});

register('ext.targets', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  if (!extId) throw new Error('Usage: ext targets <ext-id>');
  const ts = await ctx.pool.findByExtensionId(extId);
  return ts.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url }));
});

register('ext.reload', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  if (!extId) throw new Error('Usage: ext reload <ext-id>');
  const sws = await ctx.pool.findByExtensionId(extId, 'service_worker');
  if (sws.length === 0) throw new Error(`No service worker for ${extId}`);
  const target = await ctx.pool.get(sws[0]);
  await target.send('Runtime.enable');
  await target.send('Runtime.evaluate', {
    expression: 'chrome.runtime.reload()',
    awaitPromise: true,
  });
  return { ok: true };
});

register('ext.sw.eval', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  const js = String(args[1] ?? '');
  if (!extId || !js) throw new Error('Usage: ext sw <ext-id> eval <js>');
  const sws = await ctx.pool.findByExtensionId(extId, 'service_worker');
  if (sws.length === 0) throw new Error(`No service worker for ${extId}`);
  const target = await ctx.pool.get(sws[0]);
  await target.send('Runtime.enable');
  const res = await target.send('Runtime.evaluate', {
    expression: `(async () => { return (${js}); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const r = res as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown };
  if (r.exceptionDetails) {
    throw new Error(`SW eval threw: ${JSON.stringify(r.exceptionDetails)}`);
  }
  return r.result?.value ?? r.result?.description ?? null;
});

register('ext.storage', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  const area = String(args[1] ?? 'local');
  const op = String(args[2] ?? 'get');
  if (!extId) throw new Error('Usage: ext storage <ext-id> [local|session|sync] [get|set|clear] [key] [value]');
  if (!['local', 'session', 'sync'].includes(area)) throw new Error(`Unknown area: ${area}`);
  const sws = await ctx.pool.findByExtensionId(extId, 'service_worker');
  if (sws.length === 0) throw new Error(`No service worker for ${extId}`);
  const target = await ctx.pool.get(sws[0]);
  await target.send('Runtime.enable');

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
  const res = await target.send('Runtime.evaluate', {
    expression: `(async () => ${expr})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const r = res as { result?: { value?: unknown } };
  return r.result?.value ?? { ok: true };
});

register('ext.panel.eval', async (ctx, args) => {
  const extId = String(args[0] ?? '');
  const js = String(args[1] ?? '');
  if (!extId || !js) throw new Error('Usage: ext panel <ext-id> eval <js>');
  const panels = (await ctx.pool.findByExtensionId(extId, 'page'))
    .filter((t) => t.url.includes('/sidepanel.html') || t.url.includes('sidePanel') || t.url.includes('panel.html'));
  if (panels.length === 0) {
    throw new Error(`No sidepanel for ${extId}. Open it first (try: ghax gesture click <x,y> on the extension icon).`);
  }
  const target = await ctx.pool.get(panels[0]);
  await target.send('Runtime.enable');
  const res = await target.send('Runtime.evaluate', {
    expression: `(async () => { return (${js}); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const r = res as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (r.exceptionDetails) throw new Error(`Panel eval threw: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result?.value ?? null;
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

// ─── Recording ─────────────────────────────────────────────────

// Commands we never store in a recording — they're either meta-operations
// on the recorder itself, or expensive read-only queries a replay should
// not re-run as the user's "actions".
const NEVER_RECORD = new Set([
  'record.start', 'record.stop', 'record.status',
  'status', 'health',
  'tabs', 'console', 'network', 'cookies', 'text', 'html',
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

// ─── HTTP server ───────────────────────────────────────────────

async function main() {
  const cfg = resolveConfig();
  const cdpHttpUrl = process.env.GHAX_CDP_HTTP_URL;
  const cdpBrowserUrl = process.env.GHAX_CDP_BROWSER_URL;
  const browserKind = process.env.GHAX_BROWSER_KIND || 'chromium';
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

  const ctx: Ctx = {
    browser,
    context,
    cdpHttpUrl,
    cdpBrowserUrl,
    browserKind,
    pool: new CdpPool(cdpHttpUrl),
    consoleBuf: new CircularBuffer<ConsoleEntry>(BUFFER_CAP),
    networkBuf: new CircularBuffer<NetworkEntry>(BUFFER_CAP),
    activePageId: null,
    refs: new Map(),
    instrumented: new WeakSet<Page>(),
    startedAt: Date.now(),
    stateDir: cfg.stateDir,
    recording: null,
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
        json(res, 500, { ok: false, error: err.message || String(err) });
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
