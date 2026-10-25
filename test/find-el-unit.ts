/**
 * find-el — parse, score and rank logic, offline, on canned snapshot text.
 * No browser, so it runs anywhere in milliseconds. The live behaviour (real
 * pages, both transports' refs being clickable) is in test/smoke.ts.
 *
 * Every assertion here compares candidates against each other or pins an
 * exact number, so a scorer that returned a constant (or the same score for
 * every node) fails them.
 *
 * Run: tsx test/find-el-unit.ts   (npm run test:find-el)
 */
import {
  findEl, parseQuery, parseSnapshot, registerFindEl, scoreNode, tokenize,
  type FindElDeps, type FindElResult,
} from '../src/find-el';

let n = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  n++;
}
const refs = (r: FindElResult) => r.results.map((m) => m.ref);
const top = (r: FindElResult) => r.results[0];

// A page in the format `snapshot` prints (src/snapshot.ts renderer).
const PAGE = `
@e23 [heading] "Account settings" [level=1]
[group] "Profile"
  [text]: Email address
  @e1 [textbox] "Email" [placeholder="you@example.com"]
  @e2 [textbox] [placeholder="Search products, orders"]
  @e3 [link] "Save"
  @e4 [button] "Save"
  @e5 [button] "Save changes"
  @e6 [button] "Discard changes"
  @e7 [button] "Submit" [disabled]
  @e8 [button] "Submit"
@e9 [group] "Sessions"
  @e10 [button] "Delete"
  @e11 [button] "Delete"
  @e12 [button] "Delete"
  @e13 [textbox] "First name"
  @e14 [textbox] "Last name"
  @e15 [checkbox] "Remember me" [checked]
  @e16 [checkbox] "Subscribe to news"
  @e17 [tab] "Billing" [selected]
  @e18 [tab] "Settings"
  @e19 [heading] "Danger zone" [level=2]
  @e20 [link] "Terms of service": read the terms
[group] "Shipping address"
  @e21 [button] "Edit"
[group] "Billing address"
  @e22 [button] "Edit"
── cursor-interactive (not in ARIA tree) ──
@c1 [cursor:pointer, onclick] "Open the help panel"
@c2 [cursor:pointer] "Save"
`;

// ─── parse ──────────────────────────────────────────────────────
const nodes = parseSnapshot(PAGE);
const byRef = (r: string) => nodes.find((x) => x.ref === r)!;
assert(nodes.filter((x) => x.ref).length === 25, `25 ref-carrying lines, got ${nodes.filter((x) => x.ref).length}`);
assert(byRef('e1').props.placeholder === 'you@example.com' && byRef('e1').name === 'Email', 'name and placeholder parsed');
assert(byRef('e2').name === '' && byRef('e2').props.placeholder === 'Search products, orders', 'a placeholder with a comma survives the props split');
assert(byRef('e7').props.disabled && !byRef('e8').props.disabled, 'disabled flag parsed per node');
assert(byRef('e15').props.checked === true && byRef('e17').props.selected, 'checked and selected parsed');
assert(byRef('e20').text === 'read the terms' && byRef('e20').name === 'Terms of service', 'text suffix parsed');
assert(byRef('e1').depth === 1 && byRef('e9').depth === 0, 'depth comes from indentation');
assert(byRef('e1').ancestors[0] === 'Profile' && byRef('e21').ancestors[0] === 'Shipping address', 'nearest ancestor name');
assert(byRef('e1').adjacent.includes('Email address'), 'the label text before a field is adjacent');
assert(byRef('c1').kind === 'cursor' && byRef('c1').name === 'Open the help panel', 'cursor refs parsed with their text');
assert(parseSnapshot('(no accessible elements found)').length === 0, 'the empty-page marker yields no nodes');
assert(parseSnapshot('@e1 [button] "Say \\"hi\\", ok" [disabled, placeholder="a]b"]')[0].name === 'Say "hi", ok', 'escaped quotes in a name');
assert(parseSnapshot('@e1 [textbox] "x" [placeholder="a]b"]')[0].props.placeholder === 'a]b', 'a bracket inside a quoted placeholder does not end the group');

// ─── query parsing ──────────────────────────────────────────────
let q = parseQuery('the Save button');
assert(q.tokens.join() === 'save' && q.roles.has('button') && q.strictRole && q.ordinal === null, 'stop and role words stripped');
q = parseQuery('second delete button');
assert(q.ordinal === 2 && q.tokens.join() === 'delete', 'ordinal before a role word');
q = parseQuery('first name');
assert(q.ordinal === null && q.tokens.join() === 'first,name', '"first name" is a field, not an ordinal');
q = parseQuery('first name field');
assert(q.ordinal === null, '"first name field" is a field');
q = parseQuery('last link');
assert(q.ordinal === -1 && q.roles.has('link'), 'last link');
q = parseQuery('3rd result');
assert(q.ordinal === 3, 'numeric ordinal');
q = parseQuery('disabled submit button');
assert(q.states.join() === 'disabled' && q.tokens.join() === 'submit', 'state hint stripped from the name');
q = parseQuery('settings tab');
assert(q.tokens.join() === 'settings,tab' && q.tokensCore.join() === 'settings' && q.roles.has('tab') && !q.strictRole, 'weak role word: hint, optional name token');
q = parseQuery('search button');
assert(q.roles.has('button') && !q.roles.has('searchbox'), 'a strong role word beats a weak one');
assert(tokenize('E-mail, Address!').join() === 'e,mail,address', 'tokenize splits on punctuation');

// ─── exact name ─────────────────────────────────────────────────
let r = findEl(PAGE, 'save changes');
assert(top(r).ref === '@e5' && top(r).score === 100, `exact name wins at 100: ${JSON.stringify(top(r))}`);
assert(r.results.find((m) => m.ref === '@e6')!.score < 60, '"Discard changes" shares only one token');
assert(top(r).why.includes('name'), 'why says name');
// Exact (100) beats phrase-contained (70) beats token coverage, with the same role.
r = findEl(PAGE, 'save button');
const sc = (ref: string) => r.results.find((m) => m.ref === ref)!.score;
assert(top(r).ref === '@e4', `"Save" button is first for "save button": ${refs(r)}`);
assert(sc('@e4') === 100 && sc('@e5') === 100, 'both cap at 100 (exact 100+30, phrase 70+30)');
assert(refs(r).indexOf('@e4') < refs(r).indexOf('@e5'), 'tie on score: the higher name score (exact) goes first');
assert(sc('@e3') < sc('@e4') - 30, `link "Save" is penalised for a button hint: ${sc('@e3')} vs ${sc('@e4')}`);

// ─── role hint ──────────────────────────────────────────────────
r = findEl(PAGE, 'save link');
assert(top(r).ref === '@e3', `"save link" picks the link, not the button: ${refs(r)}`);
r = findEl(PAGE, 'save');
// No role hint: neither the link nor the button is penalised, and the two exact names tie on score.
const tied = r.results.filter((m) => m.ref === '@e3' || m.ref === '@e4');
assert(tied.length === 2 && tied[0].score === tied[1].score && tied[0].score === 100, 'no hint, no mismatch penalty');
r = findEl(PAGE, 'billing tab');
assert(top(r).ref === '@e17', `weak role word is optional in the name: ${JSON.stringify(top(r))}`);
assert(top(r).score === 100, 'exact via the core tokens + role bonus, capped');
r = findEl(PAGE, 'checkbox');
assert(r.results.every((m) => m.role === 'checkbox') && r.results.length === 2, 'a hint-only query returns just that role');

// ─── placeholder ────────────────────────────────────────────────
r = findEl(PAGE, 'search products field');
assert(top(r).ref === '@e2', `an unnamed field is found by its placeholder: ${JSON.stringify(top(r))}`);
assert(top(r).why.includes('placeholder') && top(r).why.includes('role'), 'why lists placeholder and role');
const emailByPlaceholder = scoreNode(byRef('e1'), parseQuery('you example com'));
const emailNoMatch = scoreNode(byRef('e4'), parseQuery('you example com'));
assert(emailByPlaceholder.score > emailNoMatch.score && emailByPlaceholder.score >= 20, 'placeholder tokens score a textbox, not a button');

// ─── state: disabled penalty and hints ──────────────────────────
r = findEl(PAGE, 'submit button');
assert(top(r).ref === '@e8', 'the enabled Submit ranks first');
const sub = (ref: string) => r.results.find((m) => m.ref === ref)!;
assert(refs(r).indexOf('@e8') < refs(r).indexOf('@e7') && sub('@e8').score === 100, 'both cap at 100; the uncapped sum still puts the enabled one first');
const e7 = scoreNode(byRef('e7'), parseQuery('subm'));
const e8 = scoreNode(byRef('e8'), parseQuery('subm'));
assert(e8.score - e7.score === 10 && e7.why.includes('disabled'), `disabled costs exactly 10 with no hint: ${e8.score} vs ${e7.score}`);
r = findEl(PAGE, 'disabled submit button');
assert(top(r).ref === '@e7' && top(r).why.includes('state:disabled'), 'a disabled hint flips the order');
assert(findEl(PAGE, 'checked checkbox').results[0].ref === '@e15', 'checked hint');
assert(findEl(PAGE, 'unchecked checkbox').results[0].ref === '@e16', 'unchecked hint');
assert(findEl(PAGE, 'selected tab').results[0].ref === '@e17', 'selected hint');

// ─── ordinals ───────────────────────────────────────────────────
r = findEl(PAGE, 'delete button');
assert(r.results.slice(0, 3).map((m) => m.ref).join() === '@e10,@e11,@e12', 'document order breaks the tie');
assert(top(findEl(PAGE, 'second delete button')).ref === '@e11', 'second');
assert(top(findEl(PAGE, 'third delete button')).ref === '@e12', 'third');
assert(top(findEl(PAGE, 'last delete button')).ref === '@e12', 'last');
assert(top(findEl(PAGE, '2nd delete')).ref === '@e11', 'numeric ordinal');
assert(top(findEl(PAGE, 'first name')).ref === '@e13', '"first name" is the field');
assert(top(findEl(PAGE, 'last name')).ref === '@e14', '"last name" is the field');
r = findEl(PAGE, 'fifth delete button');
assert(top(r).ref === '@e10' && top(r).why.some((w) => w.startsWith('ordinal-out-of-range')) && r.confidence === 'low', 'out-of-range ordinal keeps the order and says so');
r = findEl(PAGE, 'second link');
assert(top(r).ref === '@e20', `second link among tied links: ${refs(r)}`);

// ─── tie-breaks ─────────────────────────────────────────────────
const tie = `
@e1 [button] "Go"
[group] "Other"
  @e2 [button] "Go"
@e3 [link] "Go"
@e4 [img] "Go"
`;
r = findEl(tie, 'go');
// e1 (depth 0, interactive) = e3 (depth 0, interactive): e1 first by order; e2 deeper; e4 not interactive.
assert(refs(r).join() === '@e1,@e3,@e2,@e4', `depth, then order, then non-interactive last: ${refs(r)}`);
const lowRef = `@e9 [button] "Go"\n@e2 [button] "Go"`;
assert(refs(findEl(lowRef, 'go')).join() === '@e9,@e2', 'document order beats ref number');
// Name score outranks a capped tie: see "save button" above. A deeper interactive node beats a shallower static one:
const inter = `@e5 [img] "Go"\n[group] "Box"\n  @e6 [button] "Go"`;
assert(top(findEl(inter, 'go')).ref === '@e6', 'interactive role goes before shallower depth');

// ─── context ────────────────────────────────────────────────────
r = findEl(PAGE, 'edit billing address');
assert(top(r).ref === '@e22', `ancestor name disambiguates: ${JSON.stringify(top(r))}`);
assert(top(r).why.includes('context'), 'why says context');
assert(findEl(PAGE, 'edit shipping address').results[0].ref === '@e21', 'and the other way round');
assert(top(findEl(PAGE, 'read the terms')).ref === '@e20', 'node text matches');
r = findEl(PAGE, 'email address field');
assert(top(r).ref === '@e1', 'adjacent label text finds the field');

// ─── fuzzy ──────────────────────────────────────────────────────
r = findEl(PAGE, 'subscribe to newsletter');
assert(top(r).ref === '@e16', 'prefix of 4+ chars ("news" ~ "newsletter")');
r = findEl(PAGE, 'discrd changes');
assert(top(r).ref === '@e6' && r.results.find((m) => m.ref === '@e5')!.score < top(r).score, 'the exact token "changes" still finds it past a one-letter typo');
const fz = scoreNode(byRef('e15'), parseQuery('rememmber'));
const nofz = scoreNode(byRef('e15'), parseQuery('zzzzzzz'));
assert(fz.score > nofz.score, 'a one-letter typo still scores');
assert(scoreNode(byRef('e10'), parseQuery('cat')).score < scoreNode(byRef('e10'), parseQuery('delete')).score, 'short tokens do not fuzz');

// ─── cursor refs ────────────────────────────────────────────────
r = findEl(PAGE, 'open the help panel');
assert(top(r).ref === '@c1' && top(r).score === 25 && top(r).why.includes('cursor'), `cursor text 30*ratio-5: ${JSON.stringify(top(r))}`);
r = findEl(PAGE, 'save button');
assert(refs(r).indexOf('@c2') === -1 || r.results.find((m) => m.ref === '@c2')!.score < 25, 'a cursor ref never beats a real button');

// ─── options and result shape ───────────────────────────────────
r = findEl(PAGE, 'delete', { top: 2 });
assert(r.results.length === 2 && r.considered === 25, '--top limits, considered counts all refs');
r = findEl(PAGE, 'settings', { interactiveOnly: true });
assert(r.results.length > 0 && r.results.every((m) => m.role !== 'heading') && findEl(PAGE, 'settings').results.some((m) => m.role === 'heading'), '--interactive-only drops non-interactive roles');
assert(findEl(PAGE, 'danger zone').results[0].ref === '@e19', 'headings are found by default');
assert(findEl(PAGE, 'danger zone', { interactiveOnly: true }).results.length === 0, 'and dropped under --interactive-only');
r = findEl(PAGE, 'save changes', { minScore: 90 });
assert(r.results.length === 1, `--min-score filters: ${refs(r)}`);
assert(findEl(PAGE, 'save changes').confidence === 'high', 'top 100 with a wide margin is high');
assert(findEl(PAGE, 'save').confidence !== 'high', 'two exact "Save" nodes: no margin, not high');
assert(findEl(PAGE, 'zzzz qqqq').confidence === 'low', 'no match is low');
assert(JSON.stringify(Object.keys(findEl(PAGE, 'save changes').results[0]).sort()) === '["line","name","ref","role","score","why"]', 'result item shape');

// ─── empty result and errors ────────────────────────────────────
r = findEl(PAGE, 'zzzz qqqq');
assert(r.results.length === 0 && r.bestScore < 20, 'nothing matches gibberish');
assert(findEl('(no accessible elements found)', 'save').results.length === 0, 'empty page');
try { findEl(PAGE, 'the'); assert(false, 'stop-words-only query must throw'); } catch (e) { assert(/nothing to look for/.test((e as Error).message), 'stop-words-only query is a usage error'); }

// ─── registration (deps injected) ───────────────────────────────
(async () => {
  const handlers = new Map<string, (c: object, a: unknown[], o: Record<string, unknown>) => Promise<unknown>>();
  const seen: Record<string, unknown>[] = [];
  const deps = (text: string): FindElDeps<object> => ({
    register: (name, fn) => { handlers.set(name, fn); },
    snapshot: async (_c, o) => { seen.push(o); return { text }; },
    fail: (message, exitCode, hint) => Object.assign(new Error(message), { exitCode, hint }),
  });
  registerFindEl(deps(PAGE));
  const h = handlers.get('findEl')!;
  const res = (await h({}, ['save changes'], { top: '2' })) as FindElResult;
  assert(top(res).ref === '@e5' && res.results.length === 2, 'handler scores the injected snapshot and honours opts');
  assert(seen[0]['no-cap'] === true && seen[0].interactive === false && seen[0].cursorInteractive === true, 'asks for an uncapped full snapshot with cursor refs');
  try { await h({}, ['zzzz qqqq'], {}); assert(false, 'empty result must throw'); } catch (e: any) {
    assert(e.exitCode === 4 && /snapshot -i/.test(e.hint) && /no element matches/.test(e.message), `empty result: exit 4 + hint: ${e.message}`);
  }
  try { await h({}, [''], {}); assert(false, 'blank query must throw'); } catch (e: any) { assert(e.exitCode === 2, 'blank query exits 2'); }
  try { await h({}, ['save'], { top: '0' }); assert(false, 'bad --top must throw'); } catch (e: any) { assert(e.exitCode === 2 && /--top/.test(e.message), 'bad --top exits 2'); }
  try { await h({}, ['save'], { 'min-score': 'x' }); assert(false, 'bad --min-score must throw'); } catch (e: any) { assert(e.exitCode === 2, 'bad --min-score exits 2'); }
  const mk = (rerank: FindElDeps<object>['reranker']) => { handlers.clear(); registerFindEl({ ...deps(PAGE), reranker: rerank }); return handlers.get('findEl')!; };
  const flipped = (await mk({ rerank: async (_q, c) => [...c].reverse() })({}, ['delete button'], { top: 3 })) as FindElResult;
  const plain = (await mk(null)({}, ['delete button'], { top: 3 })) as FindElResult;
assert(refs(plain).join() === '@e10,@e11,@e12' && flipped.results.length === 3 && flipped.results[0].ref !== '@e10', 'a reranker reorders the pool; without one the order is the scorer\'s');
  console.log(`✓ ${n} find-el checks passed`);
})();
