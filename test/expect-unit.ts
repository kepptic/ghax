/**
 * expect — parse and poll logic, offline. Fake probes, fake clock: no browser,
 * so this runs anywhere and in milliseconds. The live behaviour (real pages,
 * exit codes, batch/chain/replay) is in test/smoke.ts.
 *
 * Run: tsx test/expect-unit.ts   (npm run test:expect)
 */
import { parseExpect, runExpect, type ExpectProbes } from '../src/expect';

let n = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  n++;
}
function throws(fn: () => unknown, re: RegExp, msg: string) {
  try { fn(); } catch (e) { assert(re.test((e as Error).message), `${msg}: ${(e as Error).message}`); return; }
  assert(false, `${msg}: did not throw`);
}

/** A clock that only moves when something sleeps. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, at: () => t };
}

const probes = (over: Partial<ExpectProbes> = {}): ExpectProbes => ({
  url: async () => 'http://x/dashboard',
  title: async () => 'Dash',
  text: async () => 'hello world',
  visibility: async () => 'visible',
  count: async () => 3,
  value: async () => 'ada',
  evaluate: async () => 1,
  ...over,
});

(async () => {
  // parse: exactly one check, validated.
  throws(() => parseExpect({}), /nothing to check/, 'empty');
  throws(() => parseExpect({ url: 'a', title: 'b' }), /one check per step/, 'two checks');
  throws(() => parseExpect({ url: '(' }), /not a valid regex/, 'bad regex');
  throws(() => parseExpect({ count: 'li' }), /--n N, or --min/, 'count needs a bound');
  throws(() => parseExpect({ count: 'li', n: 1, min: 1 }), /not both/, 'n with min');
  throws(() => parseExpect({ value: '#a' }), /needs --expected/, 'value needs expected');
  throws(() => parseExpect({ url: 'a', timeout: 'soon' }), /must be a number/, 'bad timeout');
  assert(parseExpect({ url: 'a' }).timeoutMs === 5000, 'default timeout is 5000');
  assert(parseExpect({ url: 'a', timeout: '250' }).timeoutMs === 250, 'string timeout coerced');

  // pass on the first look: no sleeping.
  let c = fakeClock();
  let r = await runExpect(parseExpect({ url: 'dash' }), probes(), c);
  assert(r.ok && r.attempts === 1 && r.elapsedMs === 0 && r.actual === 'http://x/dashboard', 'url passes at once');

  // polls until it flips, and reports how long that took.
  c = fakeClock();
  let looks = 0;
  r = await runExpect(parseExpect({ visible: '#late' }), probes({ visibility: async () => (++looks < 4 ? 'absent' : 'visible') }), c);
  assert(r.ok && r.attempts === 4 && r.elapsedMs === 300, `polled 3 times at 100 ms: ${JSON.stringify(r)}`);

  // times out: ok:false, the last actual, bounded by the budget.
  c = fakeClock();
  r = await runExpect(parseExpect({ text: 'nope', timeout: 450 }), probes(), c);
  assert(!r.ok && r.elapsedMs === 450 && r.actual === 'hello world' && /failed after 450ms/.test(r.message!), `timeout: ${JSON.stringify(r)}`);

  // timeout 0 is exactly one look.
  c = fakeClock();
  r = await runExpect(parseExpect({ count: 'li', n: 9, timeout: 0 }), probes(), c);
  assert(!r.ok && r.attempts === 1 && r.actual === 3, 'timeout 0 = one look');

  // count bounds.
  const count = (o: Record<string, unknown>) => runExpect(parseExpect({ count: 'li', timeout: 0, ...o }), probes(), fakeClock());
  assert((await count({ min: 3 })).ok && (await count({ max: 3 })).ok && !(await count({ min: 4 })).ok && !(await count({ max: 2 })).ok, 'min/max inclusive');

  // hidden passes for an absent element; visible does not.
  const absent = probes({ visibility: async () => 'absent' });
  assert((await runExpect(parseExpect({ hidden: '#x', timeout: 0 }), absent, fakeClock())).ok, 'absent counts as hidden');
  assert(!(await runExpect(parseExpect({ visible: '#x', timeout: 0 }), absent, fakeClock())).ok, 'absent is not visible');

  // a probe that throws is polled like a miss and reported, not propagated.
  c = fakeClock();
  let tries = 0;
  r = await runExpect(parseExpect({ eval: 'x', timeout: 1000 }), probes({ evaluate: async () => { if (++tries < 3) throw new Error('context destroyed'); return 'yes'; } }), c);
  assert(r.ok && r.attempts === 3, 'recovers from a transient probe error');
  r = await runExpect(parseExpect({ eval: 'x', timeout: 100 }), probes({ evaluate: async () => { throw new Error('boom'); } }), fakeClock());
  assert(!r.ok && r.code === 'EXPECT_ERROR' && /error: boom/.test(String(r.actual)) && /could not be checked/.test(r.message!), `a persistent probe error is EXPECT_ERROR: ${JSON.stringify(r)}`);

  // a miss is EXPECT_FAILED; a miss after an earlier throw is still a failure (last look observed).
  r = await runExpect(parseExpect({ text: 'nope', timeout: 0 }), probes(), fakeClock());
  assert(!r.ok && r.code === 'EXPECT_FAILED', 'plain miss is EXPECT_FAILED');
  c = fakeClock();
  let seq = 0;
  r = await runExpect(parseExpect({ eval: 'x', timeout: 150 }), probes({ evaluate: async () => { if (++seq === 1) throw new Error('blip'); return 0; } }), c);
  assert(!r.ok && r.code === 'EXPECT_FAILED', 'throw then observed miss is EXPECT_FAILED');
  // observed miss then a final throw is an operational error.
  c = fakeClock();
  seq = 0;
  r = await runExpect(parseExpect({ eval: 'x', timeout: 150 }), probes({ evaluate: async () => { if (++seq >= 2) throw new Error('bridge disconnected'); return 0; } }), c);
  assert(!r.ok && r.code === 'EXPECT_ERROR' && /bridge disconnected/.test(r.message!), `miss then throw is EXPECT_ERROR: ${JSON.stringify(r)}`);

  // a probe that never settles is cut off and counts as an error attempt.
  const hang = new Promise<never>(() => {});
  const t0 = Date.now();
  r = await runExpect(parseExpect({ eval: 'x', timeout: 0 }), probes({ evaluate: () => hang }), fakeClock(), 80);
  assert(!r.ok && r.code === 'EXPECT_ERROR' && /did not settle/.test(r.message!) && Date.now() - t0 < 1500, `hung probe is cut off: ${JSON.stringify(r)}`);
  // a hang then a pass recovers.
  seq = 0;
  r = await runExpect(parseExpect({ eval: 'x', timeout: 2000 }), probes({ evaluate: () => (++seq === 1 ? hang : Promise.resolve(1)) }), fakeClock(), 50);
  assert(r.ok && r.attempts === 2, 'hang then pass recovers');

  // timeout bounds waiting, not one probe: a slow probe that sees true still passes.
  r = await runExpect(parseExpect({ eval: 'x', timeout: 5 }), probes({ evaluate: () => new Promise((res) => setTimeout(() => res(true), 150)) }), undefined, 1000);
  assert(r.ok, `slow probe that observes true passes past a tiny timeout: ${JSON.stringify(r)}`);

  // value compares exactly; a missing target fails with a reason.
  assert(!(await runExpect(parseExpect({ value: '#n', expected: 'Ada', timeout: 0 }), probes(), fakeClock())).ok, 'value is exact');
  r = await runExpect(parseExpect({ value: '#n', expected: 'ada', timeout: 0 }), probes({ value: async () => null }), fakeClock());
  assert(!r.ok && /not found/.test(String(r.actual)), 'missing value target');

  // long actuals are clipped so a failure never dumps a whole page.
  r = await runExpect(parseExpect({ text: 'zzz', timeout: 0 }), probes({ text: async () => 'x'.repeat(5000) }), fakeClock());
  assert(String(r.actual).length < 400, 'actual clipped');

  console.log(`✓ expect-unit: ${n} assertions`);
})();
