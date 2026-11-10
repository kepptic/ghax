/**
 * screenshot --scale math, offline. The browser (measured, mercury-wifi
 * 2026-11-03) quantizes clip.scale: asked 0.6 at dpr 2.5, the clip scale
 * 0.24 became 0.3, so the image was 0.75x CSS. Image px must equal CSS px * scale.
 *
 * Run: tsx test/screenshot-unit.ts   (npm run test:screenshot)
 */
import { captureClip, pngSize, type CdpSend } from '../src/screenshot';
import { decodePng, encodePng, resizePng } from '../src/png-resize';

let failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`✓ ${name}`); } catch (e) { console.error(`✗ ${name}: ${(e as Error).message}`); failed++; }
};
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

function browser(page: { width: number; height: number; dpr: number }, quantize: (s: number) => number) {
  const clips: Array<Record<string, number>> = [];
  const send: CdpSend = async (method, params) => {
    if (method === 'Runtime.evaluate') return { result: { value: { ...page, pageX: 0, pageY: 0 } } };
    if (method === 'Page.captureScreenshot') {
      const clip = (params as { clip: Record<string, number> }).clip;
      clips.push(clip);
      const k = quantize(clip.scale) * page.dpr;
      const w = Math.round(clip.width * k), h = Math.round(clip.height * k);
      const data = Buffer.alloc(w * h * 3, 128);
      return { data: encodePng({ width: w, height: h, channels: 3, data }).toString('base64') };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { send, clips };
}

for (const [label, q] of [
  ['exact', (s: number) => s],
  ['ceil to 0.1', (s: number) => Math.ceil(s * 10 - 1e-9) / 10],
  ['floor to 0.1', (s: number) => Math.max(0.1, Math.floor(s * 10 + 1e-9) / 10)],
] as const) {
  await test(`dpr 2.5, 1299px viewport, --scale 0.6 (${label}): image = CSS * 0.6`, async () => {
    const { send } = browser({ width: 1299, height: 700, dpr: 2.5 }, q);
    const shot = await captureClip(send, null, 0.6);
    const size = pngSize(shot.png);
    assert(size.width === Math.round(1299 * 0.6) && size.height === Math.round(700 * 0.6), `png ${size.width}x${size.height}`);
    assert(shot.image.width === size.width && shot.image.height === size.height, 'image field matches the returned png');
    assert(Math.abs(shot.scale - 0.6) < 0.002, `reported scale ${shot.scale}`);
    assert(shot.origin.x === 0 && shot.origin.y === 0, `origin ${JSON.stringify(shot.origin)}`);
  });
}

await test('near-miss inside the tolerance is resized: 101x101 CSS at 0.99 is 100x100', async () => {
  const { send } = browser({ width: 101, height: 101, dpr: 1 }, (s) => s + 0.01); // 1.00 -> 101px
  const shot = await captureClip(send, null, 0.99);
  const size = pngSize(shot.png);
  assert(size.width === 100 && size.height === 100, `png ${size.width}x${size.height}`);
  assert(shot.image.width === 100 && shot.image.height === 100, 'image field');
});

await test('floor-rounding browser on a tiny region still yields round(CSS * scale)', async () => {
  const { send } = browser({ width: 1280, height: 720, dpr: 2 }, (s) => s * 0.99);
  const shot = await captureClip(send, { x0: 0, y0: 0, x1: 7, y1: 7 }, 0.5);
  assert(shot.image.width === 4 && shot.image.height === 4, `image ${JSON.stringify(shot.image)}`);
});

await test('resizePng keeps colours: 2x2 checker area-averages to one grey pixel', async () => {
  const data = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]);
  const out = decodePng(resizePng(encodePng({ width: 2, height: 2, channels: 3, data }), 1, 1));
  assert(out.width === 1 && out.height === 1 && Math.abs(out.data[0] - 128) <= 1, `got ${JSON.stringify(out)}`);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
