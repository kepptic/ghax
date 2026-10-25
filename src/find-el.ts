/**
 * `find-el` — find an element from a plain description ("the save button",
 * "second delete link", "email field") without a model in the loop.
 *
 * It scores the text the existing `snapshot` verb already renders, so it runs
 * the same on the CDP and bridge transports and adds no second ariaSnapshot
 * call site (CLAUDE.md invariant 3). Every ref it returns was minted by that
 * snapshot, so it is clickable straight away.
 *
 * Everything here is a pure function over text, except `registerFindEl`,
 * which gets the daemon's helpers injected (this file can't import
 * daemon.ts, the esbuild entry). The optional model step is CLI-side:
 * `--rerank-cmd` in crates/cli/src/find_el.rs. `Reranker` below is the
 * seam for doing it in-daemon later; it is null today.
 *
 * Weights are documented in docs/planning/2026-10-25-claude-in-chrome-parity-plan.md
 * section 3 and in the README of the verb.
 */
import { INTERACTIVE_ROLES } from './snapshot';

export const VERBS = ['findEl'] as const;

export const DEFAULT_TOP = 5;
export const DEFAULT_MIN_SCORE = 20;
/** Candidates a reranker sees, whatever --top says. */
export const RERANK_POOL = 20;

// ─── Snapshot parsing ──────────────────────────────────────────

export interface NodeProps {
  disabled: boolean;
  checked: boolean | 'mixed';
  expanded: boolean;
  selected: boolean;
  pressed: boolean | 'mixed';
  placeholder: string;
}

export interface SnapNode {
  /** Position among all parsed lines. */
  order: number;
  depth: number;
  /** `e12` / `c3`, without the @. Null for lines that carry no ref. */
  ref: string | null;
  kind: 'ax' | 'cursor';
  role: string;
  name: string;
  props: NodeProps;
  /** The `: text` suffix. */
  text: string;
  line: string;
  /** Names of up to 3 nearest ancestors, nearest first. */
  ancestors: string[];
  /** Nearest `[text]` line within 3 lines before / after. */
  adjacent: string[];
}

const LINE_RE = /^(\s*)(?:@([ec]\d+) )?\[([^\]]+)\](?: ("(?:[^"\\]|\\.)*"))?(.*)$/;

function emptyProps(): NodeProps {
  return { disabled: false, checked: false, expanded: false, selected: false, pressed: false, placeholder: '' };
}

/** Read one `[...]` group starting at s[0]=='[', quote-aware. Returns [inner, rest]. */
function bracketGroup(s: string): [string, string] | null {
  let inQuote = false;
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === '\\') i++;
      else if (ch === '"') inQuote = false;
    } else if (ch === '"') inQuote = true;
    else if (ch === ']') return [s.slice(1, i), s.slice(i + 1)];
  }
  return null;
}

/** `checked, placeholder="a, b"` -> ['checked', 'placeholder="a, b"'] */
function splitProps(inner: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuote) {
      cur += ch;
      if (ch === '\\' && i + 1 < inner.length) cur += inner[++i];
      else if (ch === '"') inQuote = false;
    } else if (ch === '"') { inQuote = true; cur += ch; }
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function unquote(s: string): string {
  try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
}

/**
 * Parse `snapshot` output (src/snapshot.ts and bridge.ts render the same
 * format): `indent @eN [role] "name" [props] [cursor:pointer]: text`, text
 * nodes `[text]: ...`, and the `@cN [reason] "text"` cursor section.
 * Lines that don't fit (section headers, the omitted-refs marker, a
 * multi-line text continuation) are skipped.
 */
export function parseSnapshot(text: string): SnapNode[] {
  const nodes: SnapNode[] = [];
  const stack: Array<{ depth: number; name: string }> = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, indent, ref, role, quotedName, tail] = m;
    const kind: 'ax' | 'cursor' = ref?.startsWith('c') ? 'cursor' : 'ax';
    const depth = kind === 'cursor' ? 0 : Math.floor(indent.length / 2);
    const props = emptyProps();
    let rest = tail;
    let nodeText = '';
    for (;;) {
      rest = rest.replace(/^ +/, '');
      if (!rest.startsWith('[')) break;
      const g = bracketGroup(rest);
      if (!g) break;
      rest = g[1];
      for (const p of splitProps(g[0])) {
        if (p === 'disabled') props.disabled = true;
        else if (p === 'checked') props.checked = true;
        else if (p === 'checked=mixed') props.checked = 'mixed';
        else if (p === 'expanded') props.expanded = true;
        else if (p === 'selected') props.selected = true;
        else if (p === 'pressed') props.pressed = true;
        else if (p === 'pressed=mixed') props.pressed = 'mixed';
        else if (p.startsWith('placeholder=')) props.placeholder = unquote(p.slice('placeholder='.length));
      }
    }
    if (rest.startsWith(':')) nodeText = rest.slice(1).trim();
    const name = quotedName ? unquote(quotedName) : '';
    const order = nodes.length;

    // Ancestors by indentation: pop everything at this depth or deeper.
    if (kind === 'ax') {
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    }
    const ancestors = kind === 'ax'
      ? stack.slice(-3).reverse().map((a) => a.name).filter(Boolean)
      : [];
    const node: SnapNode = {
      order, depth, ref: ref ?? null, kind,
      // Cursor lines carry the reason in the role slot, not a role.
      role: kind === 'cursor' ? 'cursor-interactive' : role,
      name,
      props, text: nodeText, line: line.trim(), ancestors, adjacent: [],
    };
    nodes.push(node);
    if (kind === 'ax') stack.push({ depth, name });
  }
  // Adjacent text (a label next to its field): nearest `[text]` within 3 lines.
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].kind !== 'ax' || nodes[i].role === 'text') continue;
    const adj: string[] = [];
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (nodes[j].kind === 'ax' && nodes[j].role === 'text' && nodes[j].text) { adj.push(nodes[j].text); break; }
    }
    for (let j = i + 1; j <= Math.min(nodes.length - 1, i + 3); j++) {
      if (nodes[j].kind === 'ax' && nodes[j].role === 'text' && nodes[j].text) { adj.push(nodes[j].text); break; }
    }
    nodes[i].adjacent = adj;
  }
  return nodes;
}

// ─── Query parsing ─────────────────────────────────────────────

export type StateHint = 'disabled' | 'enabled' | 'checked' | 'unchecked' | 'selected' | 'expanded' | 'collapsed';

export interface Query {
  raw: string;
  /** Name tokens, weak role words included. */
  tokens: string[];
  /** Same without weak role words ("settings tab" -> settings). */
  tokensCore: string[];
  /** Roles the description points at, or empty. */
  roles: Set<string>;
  /** A mismatch is penalised only for explicit (strong) hints. */
  strictRole: boolean;
  states: StateHint[];
  /** 1-based, or -1 for "last". Null when none. */
  ordinal: number | null;
}

const STOP = new Set([
  'the', 'a', 'an', 'that', 'says', 'saying', 'labeled', 'labelled', 'called', 'named',
  'with', 'which', 'this', 'please', 'click', 'find', 'element',
]);

const STRONG_ROLES: Record<string, string[]> = {
  button: ['button'], btn: ['button'],
  link: ['link'],
  textbox: ['textbox', 'searchbox', 'spinbutton'], input: ['textbox', 'searchbox', 'spinbutton'], field: ['textbox', 'searchbox', 'spinbutton'],
  checkbox: ['checkbox'],
  radio: ['radio'],
  heading: ['heading'],
  slider: ['slider'],
  menuitem: ['menuitem', 'menuitemcheckbox', 'menuitemradio'],
};
const WEAK_ROLES: Record<string, string[]> = {
  tab: ['tab'],
  menu: ['menu', 'menuitem', 'menubar'],
  dropdown: ['combobox', 'listbox'], select: ['combobox', 'listbox'], combobox: ['combobox'],
  search: ['searchbox', 'textbox'],
  option: ['option'],
  toggle: ['switch', 'checkbox'], switch: ['switch', 'checkbox'],
};
const STATE_WORDS: Record<string, StateHint> = {
  disabled: 'disabled', enabled: 'enabled', checked: 'checked', unchecked: 'unchecked',
  selected: 'selected', expanded: 'expanded', collapsed: 'collapsed',
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1,
};
/** Nouns an ordinal may precede ("second result") besides a role word. */
const ORDINAL_NOUNS = new Set(['one', 'result', 'item', 'match', 'entry', 'row', 'element']);
/** Words that make a preceding "first"/"last" part of a field name ("first name field"). */
const NAME_WORDS = new Set(['name', 'login', 'updated', 'modified']);

export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function ordinalOf(tok: string): number | null {
  if (tok in ORDINALS) return ORDINALS[tok];
  const m = /^(\d+)(?:st|nd|rd|th)$/.exec(tok);
  return m ? Number(m[1]) : null;
}

export function parseQuery(raw: string): Query {
  const all = tokenize(raw);
  const isRoleWord = (t: string) => t in STRONG_ROLES || t in WEAK_ROLES;
  // Ordinal: only when it can't be part of a name. "second delete button" and
  // "3rd result" are ordinals; "first name" and "last login" are fields.
  let ordinal: number | null = null;
  const toks: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    const o: number | null = ordinal === null ? ordinalOf(t) : null;
    if (o !== null) {
      const numeric = /^\d/.test(t);
      let j = i + 1;
      while (j < all.length && STOP.has(all[j])) j++;
      const next = all[j];
      const isNoun = (w: string) => isRoleWord(w) || ORDINAL_NOUNS.has(w);
      // "second delete button": a role word later in the phrase makes it an
      // ordinal, unless the next word reads like part of a field name.
      const laterNoun = next !== undefined && !NAME_WORDS.has(next) && all.slice(j + 1).some(isNoun);
      if (numeric || (next !== undefined && isNoun(next)) || laterNoun) {
        ordinal = o;
        continue;
      }
    }
    toks.push(t);
  }
  const roles = new Set<string>();
  let strict = false;
  const states: StateHint[] = [];
  const strongWords: string[] = [];
  for (const t of toks) {
    if (t in STRONG_ROLES) { strict = true; strongWords.push(t); }
  }
  const weakWords: string[] = [];
  for (const t of toks) {
    if (t in STRONG_ROLES) for (const r of STRONG_ROLES[t]) roles.add(r);
    // A strong word wins: "search button" asks for a button, not a searchbox.
    else if (t in WEAK_ROLES && strongWords.length === 0) {
      weakWords.push(t);
      for (const r of WEAK_ROLES[t]) roles.add(r);
    }
    if (t in STATE_WORDS && !states.includes(STATE_WORDS[t])) states.push(STATE_WORDS[t]);
  }
  const tokens = toks.filter((t) => !STOP.has(t) && !(t in STRONG_ROLES) && !(t in STATE_WORDS));
  const tokensCore = tokens.filter((t) => !weakWords.includes(t));
  return { raw, tokens, tokensCore, roles, strictRole: strict, states, ordinal };
}

// ─── Scoring ───────────────────────────────────────────────────

export interface Scored {
  node: SnapNode;
  /** 0..100, capped. */
  score: number;
  /** The sum before the cap. Orders candidates that both hit 100. */
  raw: number;
  /** The name component alone, uncapped by the rest; the first tie-break. */
  nameScore: number;
  interactive: boolean;
  why: string[];
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Prefix of 4+ characters either way, or edit distance <= 1 on tokens of 4+. */
function fuzzyTokenMatch(q: string, n: string): boolean {
  if (q.length < 4 || n.length < 4) return false;
  return n.startsWith(q) || q.startsWith(n) || editDistanceAtMostOne(q, n);
}

function contiguous(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Share of query tokens present exactly in the haystack. */
function coverage(q: string[], hay: string[]): number {
  if (q.length === 0 || hay.length === 0) return 0;
  const set = new Set(hay);
  return q.filter((t) => set.has(t)).length / q.length;
}

type NameKind = 'exact' | 'phrase' | 'tokens' | 'fuzzy' | null;

function nameScoreOf(q: string[], nameTokens: string[]): { score: number; kind: NameKind } {
  if (q.length === 0 || nameTokens.length === 0) return { score: 0, kind: null };
  if (q.join(' ') === nameTokens.join(' ')) return { score: 100, kind: 'exact' };
  if (contiguous(nameTokens, q)) return { score: 70, kind: 'phrase' };
  const set = new Set(nameTokens);
  const exact = q.filter((t) => set.has(t));
  const fuzzy = q.filter((t) => !set.has(t) && nameTokens.some((n) => fuzzyTokenMatch(t, n)));
  const score = 45 * (exact.length / q.length) + 25 * (fuzzy.length / q.length);
  return { score, kind: exact.length > 0 ? 'tokens' : fuzzy.length > 0 ? 'fuzzy' : null };
}

function stateMatch(h: StateHint, n: SnapNode, interactive: boolean): boolean | null {
  const p = n.props;
  switch (h) {
    case 'disabled': return p.disabled;
    case 'enabled': return interactive ? !p.disabled : null;
    case 'checked': return Boolean(p.checked);
    case 'unchecked': return ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(n.role) ? !p.checked : null;
    case 'selected': return p.selected;
    case 'expanded': return p.expanded;
    case 'collapsed': return interactive ? !p.expanded : null;
  }
}

export function scoreNode(node: SnapNode, q: Query): Scored {
  const why: string[] = [];
  const interactive = node.kind === 'cursor' || INTERACTIVE_ROLES.has(node.role);

  if (node.kind === 'cursor') {
    // Not in the ARIA tree, so only its visible text says anything.
    const ratio = coverage(q.tokens, tokenize(node.name));
    const raw = ratio > 0 ? 30 * ratio - 5 : 0;
    if (ratio > 0) why.push('text', 'cursor');
    const s = Math.max(0, Math.min(100, Math.round(raw)));
    return { node, score: s, raw, nameScore: Math.max(0, raw), interactive: false, why };
  }

  let total = 0;
  // Name. The weak-word-free reading counts too: "settings tab" should
  // match a tab named just "Settings" exactly.
  const nameTokens = tokenize(node.name);
  const a = nameScoreOf(q.tokens, nameTokens);
  const b = q.tokensCore.length !== q.tokens.length ? nameScoreOf(q.tokensCore, nameTokens) : a;
  const best = b.score > a.score ? b : a;
  total += best.score;
  if (best.score > 0) why.push(best.kind === 'fuzzy' ? 'name~' : 'name');

  if (q.roles.size > 0) {
    if (q.roles.has(node.role)) { total += 30; why.push('role'); }
    else if (q.strictRole) { total -= 40; why.push('role-mismatch'); }
  }
  if (interactive) total += 5;

  if (node.props.placeholder) {
    const r = coverage(q.tokens, tokenize(node.props.placeholder));
    if (r > 0) { total += 30 * r; why.push('placeholder'); }
  }

  let stateTouched = false;
  for (const h of q.states) {
    const m = stateMatch(h, node, interactive);
    if (m === null) continue;
    if (h === 'disabled' || h === 'enabled') stateTouched = true;
    total += m ? 15 : -15;
    why.push(m ? `state:${h}` : `state-mismatch:${h}`);
  }
  if (!stateTouched && node.props.disabled) { total -= 10; why.push('disabled'); }

  const textR = coverage(q.tokens, tokenize(node.text));
  if (textR > 0) { total += 20 * textR; why.push('text'); }

  const ctx = [...node.ancestors, ...node.adjacent].flatMap(tokenize);
  const ctxR = coverage(q.tokens, ctx);
  if (ctxR > 0) { total += 15 * ctxR; why.push('context'); }

  return {
    node,
    score: Math.max(0, Math.min(100, Math.round(total))),
    raw: total,
    nameScore: best.score,
    interactive,
    why,
  };
}

/**
 * Ranking order: score, then the uncapped sum, name score, interactive role,
 * shallower, document order, ref number. The plan lists name score first;
 * the uncapped sum goes ahead of it because the 100 cap would otherwise
 * erase the disabled and role-mismatch penalties between two strong matches
 * (an enabled and a disabled "Submit" both capping at 100).
 */
export function compareScored(x: Scored, y: Scored): number {
  return (
    y.score - x.score
    || y.raw - x.raw
    || y.nameScore - x.nameScore
    || Number(y.interactive) - Number(x.interactive)
    || x.node.depth - y.node.depth
    || x.node.order - y.node.order
    || refNumber(x.node.ref) - refNumber(y.node.ref)
  );
}

function refNumber(ref: string | null): number {
  const m = ref ? /(\d+)$/.exec(ref) : null;
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// ─── Ranking and result ────────────────────────────────────────

export interface FindElOptions {
  top?: number;
  minScore?: number;
  interactiveOnly?: boolean;
}

export interface FindElMatch {
  ref: string;
  score: number;
  role: string;
  name: string;
  why: string[];
  line: string;
}

export interface FindElResult {
  query: string;
  results: FindElMatch[];
  confidence: 'high' | 'medium' | 'low';
  /** Ref-carrying lines that were scored. */
  considered: number;
  /** Best score seen, even if under --min-score; lets the caller say how close it got. */
  bestScore: number;
}

/** Pure: snapshot text + description in, ranked matches out. */
export function findEl(snapshotText: string, description: string, options: FindElOptions = {}): FindElResult {
  const top = options.top ?? DEFAULT_TOP;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const q = parseQuery(description);
  if (q.tokens.length === 0 && q.roles.size === 0 && q.states.length === 0) {
    throw new FindElUsageError(`find-el: "${description}" has nothing to look for. Name the element: "save button", "email field", "second delete link".`);
  }
  let cands = parseSnapshot(snapshotText).filter((n) => n.ref !== null);
  const considered = cands.length;
  if (options.interactiveOnly) cands = cands.filter((n) => n.kind === 'cursor' || INTERACTIVE_ROLES.has(n.role));

  const scored = cands.map((n) => scoreNode(n, q)).sort(compareScored);
  const kept = scored.filter((s) => s.score >= minScore);

  let ordered = kept;
  let marginBase = kept;
  let ordinalNote: string | null = null;
  if (q.ordinal !== null && kept.length > 0) {
    // The ordinal picks among the candidates tied at the top, in page order.
    const t = kept[0];
    const group = kept
      .filter((s) => s.score === t.score && s.nameScore === t.nameScore)
      .sort((x, y) => x.node.order - y.node.order);
    const idx = q.ordinal === -1 ? group.length - 1 : q.ordinal - 1;
    if (idx >= 0 && idx < group.length) {
      const pick = group[idx];
      ordered = [pick, ...kept.filter((s) => s !== pick)];
      marginBase = kept.filter((s) => !group.includes(s));
      pick.why = [...pick.why, `ordinal:${q.ordinal === -1 ? 'last' : q.ordinal}`];
    } else {
      ordinalNote = `ordinal-out-of-range:${group.length}`;
      ordered[0].why = [...ordered[0].why, ordinalNote];
    }
  }

  const topScore = ordered[0]?.score ?? 0;
  const second = marginBase.find((s) => s !== ordered[0]);
  const margin = topScore - (second?.score ?? 0);
  const confidence: FindElResult['confidence'] =
    ordered.length === 0 || ordinalNote ? 'low'
      : topScore >= 60 && margin >= 20 ? 'high'
      : topScore >= 40 ? 'medium' : 'low';

  return {
    query: description,
    results: ordered.slice(0, top).map(toMatch),
    confidence,
    considered,
    bestScore: scored[0]?.score ?? 0,
  };
}

function toMatch(s: Scored): FindElMatch {
  return { ref: `@${s.node.ref}`, score: s.score, role: s.node.role, name: s.node.name, why: s.why, line: s.node.line };
}

/** Bad description or option: the daemon maps it to exit 2. */
export class FindElUsageError extends Error {
  readonly exitCode = 2;
}

export function parseFindElOpts(opts: Record<string, unknown>): Required<FindElOptions> {
  const num = (v: unknown, name: string, min: number, max: number, dflt: number): number => {
    if (v === undefined || v === null || v === '' || v === true) {
      if (v === true) throw new FindElUsageError(`find-el: --${name} needs a number`);
      return dflt;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new FindElUsageError(`find-el: --${name} must be ${min}-${max}, got '${String(v)}'`);
    return Math.floor(n);
  };
  return {
    top: num(opts.top, 'top', 1, 100, DEFAULT_TOP),
    minScore: num(opts.minScore ?? opts['min-score'], 'min-score', 0, 100, DEFAULT_MIN_SCORE),
    interactiveOnly: opts.interactiveOnly === true || opts['interactive-only'] === true,
  };
}

// ─── Optional model seam (unused in the daemon today) ──────────

export interface Reranker {
  rerank(query: string, candidates: FindElMatch[]): Promise<FindElMatch[]>;
}

// ─── Daemon registration (deps injected) ───────────────────────

export interface FindElDeps<C> {
  register(name: string, fn: (ctx: C, args: unknown[], opts: Record<string, unknown>) => Promise<unknown>): void;
  /** The registered `snapshot` handler, looked up at call time (as `batch` does). */
  snapshot(ctx: C, opts: Record<string, unknown>): Promise<unknown>;
  /** A DaemonError with an exit code and an optional recovery hint. */
  fail(message: string, exitCode: number, hint?: string): Error;
  reranker?: Reranker | null;
}

export function registerFindEl<C>(deps: FindElDeps<C>): void {
  deps.register('findEl', async (ctx, args, opts) => {
    const description = typeof args[0] === 'string' ? args[0].trim() : '';
    if (!description) throw deps.fail('Usage: find-el "<description>" [--top N] [--min-score N] [--interactive-only]', 2);
    let parsed: Required<FindElOptions>;
    try {
      parsed = parseFindElOpts(opts);
    } catch (err) {
      if (err instanceof FindElUsageError) throw deps.fail(err.message, err.exitCode);
      throw err;
    }
    // Uncapped on purpose: the default 250-ref cut would hide the answer on a
    // big page. The cursor pass is on so `@c` refs are candidates too.
    const snap = (await deps.snapshot(ctx, { interactive: false, 'no-cap': true, cursorInteractive: true })) as { text?: unknown };
    const text = typeof snap?.text === 'string' ? snap.text : '';
    let result: FindElResult;
    try {
      result = findEl(text, description, parsed);
    } catch (err) {
      if (err instanceof FindElUsageError) throw deps.fail(err.message, err.exitCode);
      throw err;
    }
    if (result.results.length === 0) {
      const closest = result.bestScore > 0 ? ` (closest scored ${result.bestScore}, under --min-score ${parsed.minScore})` : '';
      throw deps.fail(
        `find-el: no element matches "${description}"${closest} among ${result.considered} refs`,
        4,
        'Run `ghax snapshot -i` to see what is on the page, rephrase, or lower --min-score.',
      );
    }
    if (deps.reranker) {
      const pool = findEl(text, description, { ...parsed, top: Math.max(parsed.top, RERANK_POOL) });
      const reranked = await deps.reranker.rerank(description, pool.results);
      return { ...pool, results: reranked.slice(0, parsed.top) };
    }
    return result;
  });
}
