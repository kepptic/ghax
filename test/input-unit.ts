/**
 * Input verbs, offline: a coordinate gesture whose input fails must report
 * retry "unsafe" (mouse events may have gone out), not "unknown".
 *
 * Run: tsx test/input-unit.ts   (npm run test:input)
 */
import { registerInput, dragPath, hitAt } from '../src/input';
import { withDispatchScope } from '../src/errors';

type Handler = (ctx: { bridgeMode: boolean }, args: unknown[], opts: Record<string, unknown>) => Promise<unknown>;
const handlers = new Map<string, Handler>();
registerInput({
  register: (name, fn) => { handlers.set(name, fn as Handler); },
  withInput: async () => { throw new Error('socket closed mid-dispatch'); },
  verbBridge: () => { throw new Error('unused'); },
  resolveBridgeTarget: async () => { throw new Error('unused'); },
  resolveRef: async () => { throw new Error('unused'); },
  activePage: async () => { throw new Error('unused'); },
  requireTarget: () => undefined,
  parseGesturePoint: (spec) => { const [x, y] = spec.split(',').map(Number); return { x, y }; },
} as Parameters<typeof registerInput>[0]);

let failed = 0;
for (const verb of ['gesture.click', 'gesture.dblclick', 'gesture.tripleclick', 'gesture.rightclick']) {
  const h = handlers.get(verb);
  try {
    if (!h) throw new Error('not registered');
    await withDispatchScope(verb, {}, () => h({ bridgeMode: false }, ['10,20'], {}));
    console.error(`✗ ${verb}: did not throw`); failed++;
  } catch (e) {
    const retry = (e as { retry?: string }).retry;
    if (retry !== 'unsafe') { console.error(`✗ ${verb}: retry=${retry}, want unsafe`); failed++; }
    else console.log(`✓ ${verb} failure is retry:unsafe`);
  }
}
// Hover moves the pointer only: replaying it is safe, so it must NOT be marked.
try {
  await withDispatchScope('gesture.hover', {}, () => handlers.get('gesture.hover')!({ bridgeMode: false }, ['1,2'], {}));
} catch (e) {
  const retry = (e as { retry?: string }).retry;
  if (retry === 'unsafe') { console.error('✗ gesture.hover marked unsafe'); failed++; }
}

// drag --hold pauses after the press and before the release; the result
// reports elementFromPoint at both ends (viewport CSS px).
{
  const log: Array<{ m: string; t: number; type?: string }> = [];
  const t0 = Date.now();
  const send = async (m: string, p: Record<string, unknown>) => {
    log.push({ m, t: Date.now() - t0, type: p.type as string | undefined });
    if (m === 'Runtime.evaluate') {
      const e = String(p.expression);
      if (e.includes('innerWidth')) return { result: { value: { w: 1000, h: 800, sx: 0, sy: 0 } } };
      const m2 = /elementFromPoint\((\d+), ?(\d+)\)|hit\((\d+),(\d+)\)/.exec(e);
      void m2;
      return { result: { value: { tag: 'div', id: 'x', text: 't', rect: [0, 0, 1, 1] } } };
    }
    return {};
  };
  const res = await dragPath(send, () => () => undefined, async () => ({ x: 10, y: 10 }), async () => ({ x: 50, y: 50 }), { steps: 2, mode: 'mouse', hold: 120 });
  const press = log.find((l) => l.type === 'mousePressed')!;
  const firstMove = log.find((l) => l.type === 'mouseMoved' && l.t > press.t)!;
  const rel = log.find((l) => l.type === 'mouseReleased')!;
  const lastMove = [...log].reverse().find((l) => l.type === 'mouseMoved')!;
  if (firstMove.t - press.t < 100) { console.error('✗ drag --hold: no pause after press'); failed++; } else console.log('✓ drag --hold pauses after press');
  if (rel.t - lastMove.t < 100) { console.error('✗ drag --hold: no pause before release'); failed++; } else console.log('✓ drag --hold pauses before release');
  const hits = res as unknown as { hitStart?: { tag?: string }; hitEnd?: { tag?: string } };
  if (hits.hitStart?.tag !== 'div' || hits.hitEnd?.tag !== 'div') { console.error('✗ drag result lacks hitStart/hitEnd'); failed++; } else console.log('✓ drag reports elementFromPoint at both ends');
  const h = await hitAt(send, 5, 6);
  if (h.tag !== 'div') { console.error('✗ hitAt'); failed++; } else console.log('✓ hitAt returns the element');
}
process.exit(failed ? 1 : 0);
