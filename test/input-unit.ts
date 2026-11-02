/**
 * Input verbs, offline: a coordinate gesture whose input fails must report
 * retry "unsafe" (mouse events may have gone out), not "unknown".
 *
 * Run: tsx test/input-unit.ts   (npm run test:input)
 */
import { registerInput } from '../src/input';
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
process.exit(failed ? 1 : 0);
