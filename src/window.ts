/**
 * `window size`: read or set the browser WINDOW's outer size.
 *
 * This is not `viewport`, which emulates a page size inside the window. It
 * resizes the real OS window, so the page sees a real `innerWidth` change.
 *
 * Bridge: `chrome.windows.update` via the extension's `window-bounds` control
 * action (the bridge has no browser-level CDP session, so
 * `Browser.setWindowBounds` is not reachable through `chrome.debugger`).
 * CDP: `Browser.setWindowBounds` on a session for the active page.
 *
 * daemon.ts is the esbuild entry and its helpers are module-private, so
 * `registerWindow(deps)` takes the few it needs (same pattern as
 * `wireBridgePageEvents` in bridge-page-state.ts).
 */

import type { CDPSession, Page } from 'playwright';
import { bridgeEvaluate, type BridgeConn } from './bridge';

/** Every verb this module registers. All of them work over the bridge. */
export const WINDOW_VERBS = ['window.size'] as const;

export interface WindowBounds {
  windowId: number;
  width: number;
  height: number;
  left: number;
  top: number;
  state: string;
}

export interface WindowSizeResult extends WindowBounds {
  transport: 'bridge' | 'cdp';
  /**
   * innerWidth/innerHeight after the call: what the page now sees. null when
   * the selected window (`--window`) has no tab ghax can read from; the
   * numbers of another window's tab are never substituted.
   */
  viewport: { width: number; height: number } | null;
  /** Why `viewport` is null, or that the window did not reach the size asked for. */
  note?: string;
}

type Size = { width: number; height: number };

const SIZE_RE = /^(\d+)x(\d+)$/i;
const INNER_SIZE_EXPR = '({ width: innerWidth, height: innerHeight })';
const SETTLE_POLL_MS = 100;
/** Polls to wait for the page to see a change after a resize (an animated state change). */
const CHANGE_POLLS = 10;
/** Polls to wait for two reads to agree once the change has landed. */
const SETTLE_POLLS = 8;
/** Polls to wait for the browser to report a state or size it was just told to apply. */
const BOUNDS_POLLS = 10;
/** Ack timeout for `window-bounds`: the extension answers at once, or is too old. */
const WINDOW_ACK_TIMEOUT_MS = 5_000;

function usage(message: string): Error {
  // exitCode 2 = bad arguments, same as the daemon's DaemonError(…, 2).
  return Object.assign(new Error(message), { exitCode: 2 });
}

export function parseWindowSize(spec: unknown): { width: number; height: number } | null {
  if (spec === undefined || spec === null || spec === '') return null;
  const m = typeof spec === 'string' ? spec.match(SIZE_RE) : null;
  const width = m ? Number(m[1]) : 0;
  const height = m ? Number(m[2]) : 0;
  if (!m || width < 1 || height < 1) throw usage(`window size: expected <WxH> such as 1440x900 (got ${String(spec)})`);
  return { width, height };
}

function parseWindowId(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const id = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (!Number.isInteger(id) || id < 0) throw usage(`window size: --window must be a window id from 'ghax tabs --json' (got ${String(raw)})`);
  return id;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A window resize reaches the page a beat later, and a maximize/restore
 * animates through intermediate sizes. `before` is what the page reported
 * before the update: wait (bounded) until the numbers differ from it, then
 * until two reads agree. If they never change (the window was already that
 * size, or the browser ignored it) the unchanged numbers are returned.
 */
async function settledViewport(read: () => Promise<Size>, before: Size | null): Promise<Size> {
  let last = await read();
  if (before) {
    for (let i = 0; i < CHANGE_POLLS && last.width === before.width && last.height === before.height; i++) {
      await sleep(SETTLE_POLL_MS);
      last = await read();
    }
  }
  for (let i = 0; i < SETTLE_POLLS; i++) {
    await sleep(SETTLE_POLL_MS);
    const next = await read();
    if (next.width === last.width && next.height === last.height) return next;
    last = next;
  }
  return last;
}

function toBounds(raw: Record<string, unknown> | undefined, where: string): WindowBounds {
  const num = (k: string): number => {
    const v = raw?.[k];
    if (typeof v !== 'number') throw new Error(`window size: ${where} returned no ${k}`);
    return v;
  };
  return {
    windowId: num('windowId'),
    width: num('width'),
    height: num('height'),
    left: typeof raw?.left === 'number' ? raw.left : 0,
    top: typeof raw?.top === 'number' ? raw.top : 0,
    state: typeof raw?.state === 'string' ? raw.state : 'normal',
  };
}

/** `window-bounds` over the bridge control channel. */
export async function bridgeWindowSize(
  conn: BridgeConn,
  size: Size | null,
  windowId?: number,
  ackTimeoutMs = WINDOW_ACK_TIMEOUT_MS,
): Promise<WindowSizeResult> {
  const readInner = async (): Promise<Size> => {
    const v = await bridgeEvaluate(conn, INNER_SIZE_EXPR) as { width?: number; height?: number } | null;
    return { width: v?.width ?? 0, height: v?.height ?? 0 };
  };
  // Read before the update so settling can tell "not resized yet" from "done".
  // No controlled tab (only possible with --window) means no viewport at all.
  const before = size ? await readInner().catch(() => null) : null;
  let result: Record<string, unknown> | undefined;
  try {
    const ack = await conn.sendControl({ action: 'window-bounds', ...size, ...(windowId === undefined ? {} : { windowId }) }, ackTimeoutMs);
    result = ack.result as Record<string, unknown> | undefined;
  } catch (err) {
    // A pre-PR-D extension either answers `unknown control action` at once
    // (same shape bridge.reload maps) or, if it predates handleControl, never
    // answers and the control times out. Neither can learn window-bounds
    // without a reload.
    if (/unknown control action|timed out/i.test((err as Error)?.message ?? '')) {
      throw new Error("window size: the loaded bridge extension predates window sizing. Run 'ghax bridge reload', then retry.");
    }
    throw err;
  }
  const bounds = toBounds(result, 'the extension');
  // The bridge drives one tab, and chrome.debugger cannot read another window's
  // tab. So the viewport is only the page's own when the window asked about is
  // the controlled tab's window.
  if (result?.controlledWindowId !== bounds.windowId) {
    return {
      ...bounds, transport: 'bridge', viewport: null,
      note: `viewport unavailable: the controlled tab is not in window ${bounds.windowId}. `
        + "Control a tab in that window ('ghax bridge control --tab-id …') to read its viewport.",
    };
  }
  const viewport = await settledViewport(readInner, before);
  return { ...bounds, transport: 'bridge', viewport };
}

type BrowserBounds = { left?: number; top?: number; width?: number; height?: number; windowState?: string };

async function getBounds(session: CDPSession, id: number): Promise<WindowBounds> {
  const got = await session.send('Browser.getWindowBounds' as never, { windowId: id } as never) as unknown as { bounds?: BrowserBounds };
  const b = got.bounds;
  return toBounds({ windowId: id, width: b?.width, height: b?.height, left: b?.left, top: b?.top, state: b?.windowState }, 'the browser');
}

/** Poll `getWindowBounds` until `done` holds (bounded); returns the last read. */
async function boundsWhen(session: CDPSession, id: number, done: (b: WindowBounds) => boolean): Promise<WindowBounds> {
  let b = await getBounds(session, id);
  for (let i = 0; i < BOUNDS_POLLS && !done(b); i++) {
    await sleep(SETTLE_POLL_MS);
    b = await getBounds(session, id);
  }
  return b;
}

/**
 * `Browser.setWindowBounds` / `getWindowBounds` over a CDP session on the page.
 * `findPage` finds a page in another window (for `--window`); without one, or
 * when it finds none, the viewport is null rather than the active tab's.
 */
export async function cdpWindowSize(
  session: CDPSession,
  page: Page,
  size: Size | null,
  windowId?: number,
  findPage?: (windowId: number) => Promise<Page | null>,
): Promise<WindowSizeResult> {
  const r = await session.send('Browser.getWindowForTarget' as never) as unknown as { windowId?: number };
  if (typeof r.windowId !== 'number') throw new Error('window size: the browser did not say which window this tab is in');
  const id = windowId ?? r.windowId;
  const viewPage = id === r.windowId ? page : (findPage ? await findPage(id) : null);
  // Read innerWidth/innerHeight, never page.viewportSize(): that is null
  // unless emulation was set, and says nothing about a real window resize.
  const readInner = async (): Promise<Size> => {
    const v = await viewPage!.evaluate(INNER_SIZE_EXPR) as Size;
    return { width: v.width, height: v.height };
  };
  const before = size && viewPage ? await readInner() : null;
  let note: string | undefined;
  if (size) {
    // setWindowBounds with windowState:'normal' plus a size restores a
    // maximized/minimized/fullscreen window and skips the SetBounds, so the
    // size is lost. Restore on its own first, wait for it, then size.
    if ((await getBounds(session, id)).state !== 'normal') {
      await session.send('Browser.setWindowBounds' as never, { windowId: id, bounds: { windowState: 'normal' } } as never);
      await boundsWhen(session, id, (b) => b.state === 'normal');
    }
    await session.send('Browser.setWindowBounds' as never, {
      windowId: id,
      bounds: { width: size.width, height: size.height },
    } as never);
  }
  const bounds = size
    ? await boundsWhen(session, id, (b) => b.state === 'normal' && b.width === size.width && b.height === size.height)
    : await getBounds(session, id);
  if (size && (bounds.state !== 'normal' || bounds.width !== size.width || bounds.height !== size.height)) {
    note = `the window is ${bounds.width}x${bounds.height} (${bounds.state}), not ${size.width}x${size.height}: `
      + 'a headless browser ignores bounds, and the OS may clamp them.';
  }
  if (!viewPage) {
    const why = `viewport unavailable: no open tab ghax can read in window ${id}.`;
    return { ...bounds, transport: 'cdp', viewport: null, note: note ? `${why} ${note}` : why };
  }
  const viewport = await settledViewport(readInner, before);
  return { ...bounds, transport: 'cdp', viewport, ...(note ? { note } : {}) };
}

/**
 * A page in window `id`, preferring the visible (foreground) one. `windowOf`
 * is injected so the walk is testable without a browser.
 */
export async function findPageInWindow(
  pages: Page[],
  windowOf: (page: Page) => Promise<number | null>,
  id: number,
): Promise<Page | null> {
  const inWindow: Page[] = [];
  for (const p of pages) {
    if (await windowOf(p) === id) inWindow.push(p);
  }
  for (const p of inWindow) {
    if (await p.evaluate('document.visibilityState') === 'visible') return p;
  }
  return inWindow[0] ?? null;
}

/** The daemon helpers `registerWindow` needs. `C` is the daemon's private Ctx. */
export interface WindowDeps<C> {
  register(name: string, fn: (ctx: C, args: unknown[], opts: Record<string, unknown>) => Promise<unknown>): void;
  /** The verb's pinned bridge connection, or null on the CDP transport. */
  bridgeOf(ctx: C): BridgeConn | null;
  activePage(ctx: C): Promise<Page>;
  allPages(ctx: C): Promise<Page[]>;
  withCdpSession<T>(page: Page, fn: (session: CDPSession) => Promise<T>): Promise<T>;
}

export function registerWindow<C>(deps: WindowDeps<C>): void {
  deps.register('window.size', async (ctx, args, opts) => {
    const size = parseWindowSize(args[0]);
    const windowId = parseWindowId(opts.window);
    const bridge = deps.bridgeOf(ctx);
    if (bridge) return bridgeWindowSize(bridge, size, windowId);
    const page = await deps.activePage(ctx);
    const windowOf = (p: Page): Promise<number | null> => deps.withCdpSession(p, async (session) => {
      const r = await session.send('Browser.getWindowForTarget' as never) as unknown as { windowId?: number };
      return typeof r.windowId === 'number' ? r.windowId : null;
    });
    const findPage = async (id: number): Promise<Page | null> => findPageInWindow(await deps.allPages(ctx), windowOf, id);
    return deps.withCdpSession(page, (session) => cdpWindowSize(session, page, size, windowId, findPage));
  });
}
