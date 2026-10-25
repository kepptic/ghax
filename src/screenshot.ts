/**
 * `screenshot`: the whole-page / element / region+scale capture, on both
 * transports.
 *
 * The region and scale paths send raw `Page.captureScreenshot {clip}` through
 * one `send`, so the bridge (`chrome.debugger` relay) and CDP (a Playwright
 * session) run the same code. The plain viewport/full-page/element paths are
 * unchanged from before this module existed: Playwright's `page.screenshot`
 * on CDP, `captureBridgeScreenshot` on the bridge.
 *
 * daemon.ts is the esbuild entry and its helpers are module-private, so
 * `registerScreenshot(deps)` takes the few it needs (same pattern as
 * `wireBridgePageEvents` in bridge-page-state.ts).
 */

import * as fs from 'fs';
import type { CDPSession, Locator, Page } from 'playwright';
import { bridgeBox, type BridgeConn, type BridgeRef } from './bridge';

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface Region { x0: number; y0: number; x1: number; y1: number }

/** `--region` alone is a zoom: capture at this scale. */
export const REGION_DEFAULT_SCALE = 2;
const SCALE_MIN = 0.1;
const SCALE_MAX_REGION = 4;
const SCALE_MAX_VIEWPORT = 1;
const SCALE_TOLERANCE = 0.02;

function usage(message: string): Error {
  // exitCode 2 = bad arguments, same as the daemon's DaemonError(…, 2).
  return Object.assign(new Error(message), { exitCode: 2 });
}

/** `x0,y0,x1,y1` in viewport CSS pixels, non-negative, with positive area. */
export function parseRegion(raw: unknown): Region {
  const parts = typeof raw === 'string' ? raw.split(',').map((p) => p.trim()) : [];
  const n = parts.map(Number);
  if (parts.length !== 4 || parts.some((p) => p === '') || n.some((v) => !Number.isFinite(v))) {
    throw usage(`screenshot: --region must be x0,y0,x1,y1 in viewport CSS pixels, e.g. --region 0,0,400,300 (got ${String(raw)})`);
  }
  const [x0, y0, x1, y1] = n;
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) {
    throw usage(`screenshot: --region needs 0 <= x0 < x1 and 0 <= y0 < y1 (got ${String(raw)})`);
  }
  return { x0, y0, x1, y1 };
}

/** `--scale` 0.1..4 with a region, 0.1..1 without; undefined when not given. */
export function parseScale(raw: unknown, hasRegion: boolean): number | undefined {
  if (raw === undefined) return undefined;
  const scale = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  const max = hasRegion ? SCALE_MAX_REGION : SCALE_MAX_VIEWPORT;
  if (!Number.isFinite(scale) || scale < SCALE_MIN || scale > max) {
    throw usage(`screenshot: --scale must be ${SCALE_MIN} to ${max}${hasRegion ? '' : ' without --region'} (got ${String(raw)})`);
  }
  return scale;
}

/** Width and height from a PNG's IHDR chunk (bytes 16-24). */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('screenshot: capture did not return a PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export interface ClipShot {
  png: Buffer;
  region: Region | null;
  /** Measured: image.width / region width, so `x = x0 + px/scale` holds. */
  scale: number;
  /** Measured image.height / region height; only set when it differs from `scale`. */
  scaleY?: number;
  viewport: { width: number; height: number };
  image: { width: number; height: number };
}

interface ViewportInfo { width: number; height: number; dpr: number; pageX: number; pageY: number }

async function readViewport(send: CdpSend): Promise<ViewportInfo> {
  const r = await send('Runtime.evaluate', {
    expression: `({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1,
      pageX: (visualViewport && visualViewport.pageLeft) || scrollX || 0,
      pageY: (visualViewport && visualViewport.pageTop) || scrollY || 0 })`,
    returnByValue: true,
  }) as { result?: { value?: Partial<ViewportInfo> }; exceptionDetails?: unknown };
  const v = r.result?.value;
  if (!v?.width || !v?.height) throw new Error('screenshot: could not read the viewport size (innerWidth/innerHeight)');
  return { width: v.width, height: v.height, dpr: v.dpr || 1, pageX: v.pageX ?? 0, pageY: v.pageY ?? 0 };
}

/**
 * Capture `region` (viewport CSS px; null = the whole viewport) at about
 * `scale` with `Page.captureScreenshot {clip}`. The browser rounds the image to
 * whole pixels, so the returned `scale` is MEASURED (image.width / region
 * width), not the requested one; a tiny region can be off by a pixel.
 *
 * Two things the clip does not do by itself:
 *  - `clip` is in document coordinates, so the scroll offset is added to keep
 *    `region` in the viewport frame the click/gesture verbs use.
 *  - Chrome multiplies the output by devicePixelRatio, so the clip scale is
 *    divided by it. If an image misses its rounded target by more than a pixel
 *    (and 2%) in either dimension (a browser that does not multiply),
 *    recapture once with the scale corrected by the measured ratio, and fail
 *    if that misses too.
 */
export async function captureClip(send: CdpSend, region: Region | null, scale: number): Promise<ClipShot> {
  const vp = await readViewport(send);
  if (region && (region.x1 > vp.width || region.y1 > vp.height)) {
    throw usage(
      `screenshot: --region ${region.x0},${region.y0},${region.x1},${region.y1} reaches outside the ${vp.width}x${vp.height} viewport. `
      + 'Regions are viewport CSS pixels; scroll first or shrink the region.',
    );
  }
  const r = region ?? { x0: 0, y0: 0, x1: vp.width, y1: vp.height };
  const width = r.x1 - r.x0;
  const height = r.y1 - r.y0;
  const grab = async (clipScale: number): Promise<Buffer> => {
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { x: vp.pageX + r.x0, y: vp.pageY + r.y0, width, height, scale: clipScale },
    }) as { data?: string };
    if (!shot.data) throw new Error('screenshot: the browser returned no image data');
    return Buffer.from(shot.data, 'base64');
  };
  // Absolute pixels against the rounded target: a 7px region at 0.5 is 3 or 4
  // px, which is rounding, not a miss that a recapture could fix.
  const expectedW = Math.max(1, Math.round(width * scale));
  const expectedH = Math.max(1, Math.round(height * scale));
  const off = (img: { width: number; height: number }): number =>
    Math.max(
      Math.abs(img.width - expectedW) / Math.max(1, SCALE_TOLERANCE * width * scale),
      Math.abs(img.height - expectedH) / Math.max(1, SCALE_TOLERANCE * height * scale),
    );
  let clipScale = scale / vp.dpr;
  let png = await grab(clipScale);
  let image = pngSize(png);
  if (off(image) > 1) {
    // Correct by the dimension that missed by more.
    const ratio = Math.abs(image.width - expectedW) / expectedW >= Math.abs(image.height - expectedH) / expectedH
      ? expectedW / image.width
      : expectedH / image.height;
    clipScale *= ratio;
    png = await grab(clipScale);
    image = pngSize(png);
    if (off(image) > 1) {
      throw new Error(
        `screenshot: the browser returned ${image.width}x${image.height} for a ${width}x${height} region at scale ${scale} `
        + `(expected about ${expectedW}x${expectedH}) even after one correction. Try a different --scale.`,
      );
    }
  }
  const measuredX = image.width / width;
  const measuredY = image.height / height;
  return {
    png,
    region,
    scale: measuredX,
    ...(Math.abs(measuredY - measuredX) > 1e-9 ? { scaleY: measuredY } : {}),
    viewport: { width: vp.width, height: vp.height },
    image,
  };
}

/**
 * The bridge's whole-page, full-page and element capture. Moved verbatim from
 * daemon.ts so `snapshot -a` (annotate) and `screenshot` share it.
 */
export async function captureBridgeScreenshot(
  bridge: BridgeConn,
  outPath: string,
  fullPage: boolean,
  ref: BridgeRef | null = null,
  label = 'element',
): Promise<void> {
  await bridge.send('Page.enable');
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (ref) {
    clip = { ...(await bridgeBox(bridge, ref, label)), scale: 1 };
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

/** The daemon helpers `registerScreenshot` needs. `C` is the daemon's private Ctx. */
export interface ScreenshotDeps<C> {
  register(name: string, fn: (ctx: C, args: unknown[], opts: Record<string, unknown>) => Promise<unknown>): void;
  /** The verb's pinned bridge connection, or null on the CDP transport. */
  bridgeOf(ctx: C): BridgeConn | null;
  activePage(ctx: C): Promise<Page>;
  withCdpSession<T>(page: Page, fn: (session: CDPSession) => Promise<T>): Promise<T>;
  resolveBridgeTarget(ctx: C, target: string): Promise<BridgeRef>;
  resolveRef(ctx: C, target: string, page: Page): Promise<Locator>;
}

export function registerScreenshot<C>(deps: ScreenshotDeps<C>): void {
  deps.register('screenshot', async (ctx, args, opts) => {
    const outPath = (opts.path as string) || `/tmp/ghax-shot-${Date.now()}.png`;
    const target = args[0] ? String(args[0]) : null;
    // Accept both `--fullPage` (v0.1 camelCase) and `--full-page` (kebab,
    // matches every other CLI flag). Kebab is the preferred form going
    // forward; camelCase stays for back-compat with live scripts.
    const fullPage = Boolean(opts.fullPage || opts['full-page']);
    const bridge = deps.bridgeOf(ctx);

    if (opts.region !== undefined || opts.scale !== undefined) {
      if (fullPage) throw usage('screenshot: --region/--scale cannot be combined with --full-page');
      if (target) throw usage('screenshot: --region/--scale cannot be combined with an @ref or selector; use one or the other');
      const region = opts.region !== undefined ? parseRegion(opts.region) : null;
      const scale = parseScale(opts.scale, region !== null) ?? REGION_DEFAULT_SCALE;
      let shot: ClipShot;
      if (bridge) {
        await bridge.send('Page.enable');
        shot = await captureClip((method, params) => bridge.send(method, params), region, scale);
      } else {
        const page = await deps.activePage(ctx);
        shot = await deps.withCdpSession(page, (session) =>
          captureClip((method, params) => session.send(method as never, params as never), region, scale));
      }
      fs.writeFileSync(outPath, shot.png);
      return {
        path: outPath,
        frame: 'viewport-css-px',
        scale: shot.scale,
        ...(shot.scaleY === undefined ? {} : { scaleY: shot.scaleY }),
        region: shot.region,
        viewport: shot.viewport,
        image: shot.image,
        note: 'click/gesture coords are viewport CSS px: x = x0 + px/scale, y = y0 + py/(scaleY ?? scale). scale is measured from the image, so it can differ slightly from --scale on a small region',
      };
    }

    if (bridge) {
      const ref = target ? await deps.resolveBridgeTarget(ctx, target) : null;
      await captureBridgeScreenshot(bridge, outPath, fullPage, ref, target ?? 'element');
      return { path: outPath };
    }
    const page = await deps.activePage(ctx);
    if (target) {
      await (await deps.resolveRef(ctx, target, page)).screenshot({ path: outPath });
    } else {
      await page.screenshot({ path: outPath, fullPage });
    }
    return { path: outPath };
  });
}
