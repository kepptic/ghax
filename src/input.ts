/**
 * Mouse input verbs: hover, drag, click buttons/counts, and the
 * coordinate gestures (click, dblclick, rightclick, tripleclick, hover).
 *
 * Every event here is a raw `Input.*` CDP call sent through the daemon's
 * `withInput`, so the bridge and the CDP transport run the same sequence.
 * No `locator.hover()` / `locator.dragTo()`: those exist only on the
 * Playwright side, and two code paths drift.
 *
 * This module can't import daemon.ts (it's the esbuild entry and its helpers
 * are module-private), so `registerInput(deps)` takes the few helpers it
 * needs, the same way `wireBridgePageEvents` does in bridge-page-state.ts.
 */

import type { Locator, Page } from 'playwright';
import { actionability } from './actionability';
import {
  bridgeGuard,
  bridgeReleaseHandle,
  bridgeResolveHandle,
  notActionableError,
  type BridgeConn,
  type BridgeRef,
} from './bridge';

export type InputSend = (method: string, params: Record<string, unknown>) => Promise<unknown>;
/** Subscribe to one CDP event on the input session. Returns an unsubscribe. */
export type InputOn = (method: string, listener: (params: Record<string, unknown>) => void) => () => void;

export interface Point { x: number; y: number }
export type MouseButton = 'left' | 'right' | 'middle';

/** Every verb this module registers. All of them work over the bridge. */
export const INPUT_VERBS = [
  'hover', 'drag',
  'gesture.click', 'gesture.dblclick', 'gesture.rightclick', 'gesture.tripleclick', 'gesture.hover',
] as const;

/**
 * Safe to replay whole after a bridge reconnect: a hover is one mouseMoved,
 * and moving to the same point twice changes nothing. Clicks and drags are
 * not: a replay could click or drop twice.
 */
export const INPUT_RETRY_SAFE = ['hover', 'gesture.hover'] as const;

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };
const POINT_RE = /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/;
const DRAG_MODES = ['auto', 'mouse', 'html5', 'synthetic'] as const;
export type DragMode = typeof DRAG_MODES[number];
/** How long to wait for Input.dragIntercepted after the last move. */
const DRAG_INTERCEPT_WAIT_MS = 300;

function usage(message: string): Error {
  // exitCode 2 = bad arguments, same as the daemon's DaemonError(…, 2).
  return Object.assign(new Error(message), { exitCode: 2 });
}

/** The CDP sender + event hook for one bridge peer (the verb's pinned one). */
export function bridgeInputIO(conn: BridgeConn): { send: InputSend; on: InputOn } {
  return {
    send: (method, params) => conn.send(method, params),
    on: (method, listener) => conn.bridge.onEvent((ev) => {
      // The bridge relays every bound peer's events; only ours count.
      if (ev.method === method && ev.instanceId === conn.instanceId) listener(ev.params);
    }),
  };
}

/** `--button` / `--count` for click and the click gestures. Defaults: left, 1. */
export function parseClickOpts(opts: Record<string, unknown>, verb: string): { button: MouseButton; count: number } {
  const rawButton = opts.button ?? 'left';
  const button = String(rawButton).toLowerCase();
  if (button !== 'left' && button !== 'right' && button !== 'middle') {
    throw usage(`${verb}: --button must be left, right or middle (got ${String(rawButton)})`);
  }
  const rawCount = opts.count ?? 1;
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 1 || count > 3) {
    throw usage(`${verb}: --count must be 1, 2 or 3 (got ${String(rawCount)})`);
  }
  return { button, count };
}

/**
 * Move to (x, y), then `count` pressed/released pairs with clickCount 1..n.
 * Rising clickCount on the same spot is what Chromium reads as a double or
 * triple click: two pairs that both say clickCount=1 fire no dblclick.
 */
export async function clickAt(
  send: InputSend,
  x: number,
  y: number,
  { button = 'left', count = 1 }: { button?: MouseButton; count?: number } = {},
): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let clickCount = 1; clickCount <= count; clickCount++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: BUTTON_MASK[button], clickCount });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount });
  }
}

/** One mouseMoved and nothing after it, so `:hover` holds for a later snapshot. */
export async function hoverAt(send: InputSend, x: number, y: number): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

/**
 * Over the bridge: guard the element (connected, enabled, visible, not
 * covered), scroll it into view, and return the point to act on. One
 * in-page call, the same one `click` uses.
 */
export async function bridgeTargetPoint(conn: BridgeConn, ref: BridgeRef, label: string, force: boolean): Promise<Point> {
  const handle = await bridgeResolveHandle(conn, ref, label);
  try {
    const { guard } = await bridgeGuard(conn, handle, label, 'click', force);
    return { x: guard.x ?? 0, y: guard.y ?? 0 };
  } finally {
    bridgeReleaseHandle(conn, handle);
  }
}

/**
 * Press at `from`, move to `to` in `steps` moves, release. Playwright's own
 * algorithm (crDragDrop.ts), in raw CDP so the bridge gets it too:
 *   - With interception on, a page that starts an HTML5 drag makes Chromium
 *     emit Input.dragIntercepted {data} instead of running a native drag.
 *     We then finish with dragEnter / dragOver / drop at `to`, carrying that
 *     data, and send no mouseReleased (the drop ends the gesture).
 *   - No intercept within DRAG_INTERCEPT_WAIT_MS: it was a plain mouse drag
 *     (slider, canvas, sortable list on mouse events); release at `to`.
 * `mouse` skips interception, `html5` fails when no drag started,
 * `synthetic` dispatches DragEvents in the page instead (dropzone and
 * react-dnd listeners that never see a trusted drag).
 */
export async function dragPath(
  send: InputSend,
  on: InputOn,
  from: Point,
  to: Point,
  { steps = 10, mode = 'auto' }: { steps?: number; mode?: DragMode } = {},
): Promise<{ html5: boolean }> {
  if (mode === 'synthetic') {
    await syntheticDrag(send, from, to);
    return { html5: true };
  }
  const intercept = mode !== 'mouse';
  // A holder, not a `let`: the listener fills it in, which TS flow analysis can't see.
  const drag: { data: Record<string, unknown> | null; wake: (() => void) | null } = { data: null, wake: null };
  const off = intercept
    ? on('Input.dragIntercepted', (params) => {
      if (drag.data !== null) return;
      drag.data = (params.data as Record<string, unknown> | undefined) ?? {};
      drag.wake?.();
    })
    : () => undefined;
  let last = from;
  try {
    if (intercept) await send('Input.setInterceptDrags', { enabled: true });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps && drag.data === null; i++) {
      last = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: last.x, y: last.y, button: 'left', buttons: 1 });
    }
    if (intercept && drag.data === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DRAG_INTERCEPT_WAIT_MS);
        drag.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    const data = drag.data;
    if (data !== null) {
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data, modifiers: 0 });
      }
      return { html5: true };
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1 });
    if (mode === 'html5') {
      throw new Error('drag --mode html5: the page started no HTML5 drag (no Input.dragIntercepted). Try --mode mouse or --mode synthetic.');
    }
    return { html5: false };
  } finally {
    off();
    if (intercept) await send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
  }
}

/**
 * dragstart / dragenter / dragover / drop / dragend dispatched in the page on
 * the elements under `from` and `to`, sharing one DataTransfer. Untrusted
 * events, so it only reaches listeners that don't check `isTrusted`.
 */
async function syntheticDrag(send: InputSend, from: Point, to: Point): Promise<void> {
  const expression = `(() => {
    const fx = ${from.x}, fy = ${from.y}, tx = ${to.x}, ty = ${to.y};
    const src = document.elementFromPoint(fx, fy);
    const dst = document.elementFromPoint(tx, ty);
    if (!src) return { ok: false, missing: 'from' };
    if (!dst) return { ok: false, missing: 'to' };
    const dataTransfer = new DataTransfer();
    const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer,
    }));
    fire(src, 'dragstart', fx, fy);
    fire(dst, 'dragenter', tx, ty);
    fire(dst, 'dragover', tx, ty);
    fire(dst, 'drop', tx, ty);
    fire(src, 'dragend', tx, ty);
    return { ok: true };
  })()`;
  const res = await send('Runtime.evaluate', { expression, returnByValue: true }) as
    { result?: { value?: { ok?: boolean; missing?: string } }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (res.exceptionDetails) {
    throw new Error(`drag --mode synthetic: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'page threw'}`);
  }
  const out = res.result?.value;
  if (!out?.ok) {
    const at = out?.missing === 'to' ? to : from;
    throw new Error(`drag --mode synthetic: no element at ${out?.missing ?? 'from'} point ${at.x},${at.y}`);
  }
}

export interface InputDeps<C extends { bridgeMode: boolean }> {
  register(name: string, fn: (ctx: C, args: unknown[], opts: Record<string, unknown>) => Promise<unknown>): void;
  withInput<T>(ctx: C, fn: (send: InputSend, on: InputOn) => Promise<T>): Promise<T>;
  verbBridge(ctx: C): BridgeConn;
  resolveBridgeTarget(ctx: C, target: string): Promise<BridgeRef>;
  resolveRef(ctx: C, target: string, page: Page): Promise<Locator>;
  activePage(ctx: C): Promise<Page>;
  requireTarget(verb: string, target: string | null | undefined): void;
  parseGesturePoint(spec: string): Point;
}

export function registerInput<C extends { bridgeMode: boolean }>(deps: InputDeps<C>): void {
  /**
   * `x,y` as given, or the guarded, scrolled-into-view click point of an
   * @ref / selector. Both transports run the same actionability check, so
   * hover and drag refuse a covered or disabled target like click does.
   */
  const targetPoint = async (ctx: C, verb: string, spec: string, force: boolean): Promise<Point> => {
    if (POINT_RE.test(spec)) return deps.parseGesturePoint(spec);
    deps.requireTarget(verb, spec);
    if (ctx.bridgeMode) {
      return bridgeTargetPoint(deps.verbBridge(ctx), await deps.resolveBridgeTarget(ctx, spec), spec, force);
    }
    const loc = await deps.resolveRef(ctx, spec, await deps.activePage(ctx));
    // shortcut: the point is in the element's own frame, so an @ref inside an
    // iframe is aimed with frame-local coordinates. Upgrade when hover/drag
    // has to reach into iframes: add the frame's offset from boundingBox().
    const guard = await loc.evaluate(actionability, { kind: 'click' as const, force });
    if (!guard.ok) throw notActionableError(spec, verb, guard);
    return { x: guard.x ?? 0, y: guard.y ?? 0 };
  };

  const gesturePoint = (verb: string, args: unknown[]): Point => {
    const spec = String(args[0] ?? '');
    // Plain Error (exit 4), as gesture click/dblclick always threw.
    if (!spec) throw new Error(`Usage: gesture ${verb} <x,y>`);
    return deps.parseGesturePoint(spec);
  };

  deps.register('hover', async (ctx, args, opts) => {
    const target = String(args[0] ?? '');
    deps.requireTarget('hover', target);
    const { x, y } = await targetPoint(ctx, 'hover', target, opts.force === true);
    await deps.withInput(ctx, (send) => hoverAt(send, x, y));
    return { ok: true, x, y };
  });

  deps.register('gesture.hover', async (ctx, args) => {
    const { x, y } = gesturePoint('hover', args);
    await deps.withInput(ctx, (send) => hoverAt(send, x, y));
    return { ok: true, x, y };
  });

  deps.register('drag', async (ctx, args, opts) => {
    const fromSpec = String(args[0] ?? '');
    const toSpec = String(args[1] ?? '');
    if (!fromSpec || !toSpec) throw usage('Usage: drag <from> <to> [--steps 10] [--mode auto|mouse|html5|synthetic]');
    const mode = String(opts.mode ?? 'auto') as DragMode;
    if (!DRAG_MODES.includes(mode)) throw usage(`drag: --mode must be one of ${DRAG_MODES.join(', ')} (got ${mode})`);
    const steps = opts.steps === undefined ? 10 : Number(opts.steps);
    if (!Number.isInteger(steps) || steps < 1 || steps > 200) throw usage(`drag: --steps must be an integer 1-200 (got ${String(opts.steps)})`);
    const force = opts.force === true;
    // shortcut: both ends are resolved (and scrolled to) before the press, so
    // a pair that can't share one viewport drags toward a stale `to` point.
    // Upgrade when a real page needs a long drag: re-aim `to` after the press
    // and auto-scroll near the edge the way a user would.
    const from = await targetPoint(ctx, 'drag', fromSpec, force);
    const to = await targetPoint(ctx, 'drag', toSpec, force);
    const { html5 } = await deps.withInput(ctx, (send, on) => dragPath(send, on, from, to, { steps, mode }));
    return { ok: true, from, to, mode, html5 };
  });

  deps.register('gesture.click', async (ctx, args, opts) => {
    const { x, y } = gesturePoint('click', args);
    const click = parseClickOpts(opts, 'gesture click');
    await deps.withInput(ctx, (send) => clickAt(send, x, y, click));
    return { ok: true };
  });

  const fixedClick = (verb: string, click: { button: MouseButton; count: number }) =>
    deps.register(`gesture.${verb}`, async (ctx, args) => {
      const { x, y } = gesturePoint(verb, args);
      await deps.withInput(ctx, (send) => clickAt(send, x, y, click));
      return { ok: true };
    });
  fixedClick('dblclick', { button: 'left', count: 2 });
  fixedClick('tripleclick', { button: 'left', count: 3 });
  fixedClick('rightclick', { button: 'right', count: 1 });
}
