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
  /** innerWidth/innerHeight after the call: what the page now sees. */
  viewport: { width: number; height: number };
}

const SIZE_RE = /^(\d+)x(\d+)$/i;
const INNER_SIZE_EXPR = '({ width: innerWidth, height: innerHeight })';
const SETTLE_POLL_MS = 100;
const SETTLE_POLLS = 8;

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

/** A window resize reaches the page a beat later; wait until two reads agree. */
async function settledViewport(read: () => Promise<{ width: number; height: number }>): Promise<{ width: number; height: number }> {
  let last = await read();
  for (let i = 0; i < SETTLE_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
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
  size: { width: number; height: number } | null,
  windowId?: number,
): Promise<WindowSizeResult> {
  let result: unknown;
  try {
    const ack = await conn.sendControl({ action: 'window-bounds', ...(size ?? {}), ...(windowId === undefined ? {} : { windowId }) });
    result = ack.result;
  } catch (err) {
    // A pre-PR-D extension answers `unknown control action` at once (same
    // shape bridge.reload maps). It cannot learn window-bounds without a reload.
    if (/unknown control action/i.test((err as Error)?.message ?? '')) {
      throw new Error("window size: the loaded bridge extension predates window sizing. Run 'ghax bridge reload', then retry.");
    }
    throw err;
  }
  const bounds = toBounds(result as Record<string, unknown> | undefined, 'the extension');
  const viewport = await settledViewport(async () => {
    const v = await bridgeEvaluate(conn, INNER_SIZE_EXPR) as { width?: number; height?: number } | null;
    return { width: v?.width ?? 0, height: v?.height ?? 0 };
  });
  return { ...bounds, transport: 'bridge', viewport };
}

/** `Browser.setWindowBounds` / `getWindowBounds` over a CDP session on the page. */
export async function cdpWindowSize(
  session: CDPSession,
  page: Page,
  size: { width: number; height: number } | null,
  windowId?: number,
): Promise<WindowSizeResult> {
  let id = windowId;
  if (id === undefined) {
    const r = await session.send('Browser.getWindowForTarget' as never) as unknown as { windowId?: number };
    if (typeof r.windowId !== 'number') throw new Error('window size: the browser did not say which window this tab is in');
    id = r.windowId;
  }
  if (size) {
    await session.send('Browser.setWindowBounds' as never, {
      windowId: id,
      bounds: { windowState: 'normal', width: size.width, height: size.height },
    } as never);
  }
  const got = await session.send('Browser.getWindowBounds' as never, { windowId: id } as never) as unknown as {
    bounds?: { left?: number; top?: number; width?: number; height?: number; windowState?: string };
  };
  const b = got.bounds;
  const bounds = toBounds({
    windowId: id, width: b?.width, height: b?.height, left: b?.left, top: b?.top, state: b?.windowState,
  }, 'the browser');
  // Read innerWidth/innerHeight, never page.viewportSize(): that is null
  // unless emulation was set, and says nothing about a real window resize.
  const viewport = await settledViewport(async () => {
    const v = await page.evaluate(INNER_SIZE_EXPR) as { width: number; height: number };
    return { width: v.width, height: v.height };
  });
  return { ...bounds, transport: 'cdp', viewport };
}

/** The daemon helpers `registerWindow` needs. `C` is the daemon's private Ctx. */
export interface WindowDeps<C> {
  register(name: string, fn: (ctx: C, args: unknown[], opts: Record<string, unknown>) => Promise<unknown>): void;
  /** The verb's pinned bridge connection, or null on the CDP transport. */
  bridgeOf(ctx: C): BridgeConn | null;
  activePage(ctx: C): Promise<Page>;
  withCdpSession<T>(page: Page, fn: (session: CDPSession) => Promise<T>): Promise<T>;
}

export function registerWindow<C>(deps: WindowDeps<C>): void {
  deps.register('window.size', async (ctx, args, opts) => {
    const size = parseWindowSize(args[0]);
    const windowId = parseWindowId(opts.window);
    const bridge = deps.bridgeOf(ctx);
    if (bridge) return bridgeWindowSize(bridge, size, windowId);
    const page = await deps.activePage(ctx);
    return deps.withCdpSession(page, (session) => cdpWindowSize(session, page, size, windowId));
  });
}
