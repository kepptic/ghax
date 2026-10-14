/**
 * `expect` — a check a plan carries with it, so a known flow runs with no
 * model reading pages in between.
 *
 * This file is transport-free: it parses the options, polls, and builds the
 * result. The daemon supplies `ExpectProbes` (CDP and bridge each answer
 * them differently), and test/expect-unit.ts drives the same code with fake
 * probes. A failed check is a RESULT ({ok:false}), never a throw: a throw
 * means the verb itself was misused (bad regex, two checks at once).
 */

export const EXPECT_KINDS = ['url', 'title', 'text', 'visible', 'hidden', 'count', 'value', 'eval'] as const;
export type ExpectKind = (typeof EXPECT_KINDS)[number];

export const DEFAULT_EXPECT_TIMEOUT_MS = 5000;
const POLL_MS = 100;
const CLIP = 300;

export type VisState = 'visible' | 'hidden' | 'absent';

export interface ExpectSpec {
  kind: ExpectKind;
  /** What the caller asked for, echoed back (regex source, substring, target, JS…). */
  expected: string | number | { n?: number; min?: number; max?: number };
  /** The subject: selector/@ref for visible|hidden|count|value|text-scope. */
  target: string | null;
  /** Only for `value`. */
  want: string | null;
  n: number | null;
  min: number | null;
  max: number | null;
  timeoutMs: number;
}

export interface ExpectProbes {
  url(): Promise<string>;
  title(): Promise<string>;
  /** null: the scoping selector matched nothing. */
  text(selector: string | null): Promise<string | null>;
  visibility(target: string): Promise<VisState>;
  count(selector: string): Promise<number>;
  /** null: the target matched nothing. */
  value(target: string): Promise<string | null>;
  evaluate(js: string): Promise<unknown>;
}

export interface ExpectResult {
  ok: boolean;
  expect: ExpectKind;
  expected: ExpectSpec['expected'];
  actual: unknown;
  elapsedMs: number;
  attempts: number;
  timeoutMs: number;
  /** Failure only: one line saying what was wrong. */
  message?: string;
  /**
   * Failure only. EXPECT_FAILED: the page was looked at and did not match
   * (exit 1). EXPECT_ERROR: the last look threw, so nothing was observed,
   * e.g. a bridge disconnect (operational, exit 4).
   */
  code?: 'EXPECT_FAILED' | 'EXPECT_ERROR';
}

function numOpt(opts: Record<string, unknown>, key: string): number | null {
  const raw = opts[key];
  if (raw === undefined || raw === null || raw === false) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`expect: --${key} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

function strOpt(opts: Record<string, unknown>, key: string): string | null {
  const raw = opts[key];
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) throw new Error(`expect: --${key} needs a value`);
  return String(raw);
}

export const EXPECT_USAGE =
  'Usage: expect one of --url <regex> | --title <regex> | --text <substring> [--selector <css>] | '
  + '--visible <@ref|css> | --hidden <@ref|css> | --count <css> (--n N | --min N [--max N]) | '
  + '--value <@ref|css> --expected <text> | --eval <js>   [--timeout <ms, default 5000>]';

export function parseExpect(opts: Record<string, unknown>): ExpectSpec {
  const given = EXPECT_KINDS.filter((k) => opts[k] !== undefined && opts[k] !== null && opts[k] !== false);
  if (given.length !== 1) {
    throw new Error(given.length === 0
      ? `expect: nothing to check. ${EXPECT_USAGE}`
      : `expect: one check per step, got ${given.join(' + ')}. Put each in its own expect step.`);
  }
  const kind = given[0];
  const timeoutMs = numOpt(opts, 'timeout') ?? DEFAULT_EXPECT_TIMEOUT_MS;
  if (timeoutMs < 0) throw new Error('expect: --timeout must be 0 or more (milliseconds)');
  const spec: ExpectSpec = {
    kind, expected: '', target: null, want: null, n: null, min: null, max: null, timeoutMs,
  };
  const subject = strOpt(opts, kind);
  if (subject === null) throw new Error(`expect: --${kind} needs a value. ${EXPECT_USAGE}`);
  switch (kind) {
    case 'url':
    case 'title':
      try { new RegExp(subject); } catch (err) {
        throw new Error(`expect: --${kind} is not a valid regex: ${(err as Error).message}`);
      }
      spec.expected = subject;
      break;
    case 'text':
      spec.expected = subject;
      spec.target = strOpt(opts, 'selector');
      break;
    case 'visible':
    case 'hidden':
      spec.expected = subject;
      spec.target = subject;
      break;
    case 'count':
      spec.target = subject;
      spec.n = numOpt(opts, 'n');
      spec.min = numOpt(opts, 'min');
      spec.max = numOpt(opts, 'max');
      if (spec.n === null && spec.min === null && spec.max === null) {
        throw new Error('expect: --count needs --n N, or --min N and/or --max N');
      }
      if (spec.n !== null && (spec.min !== null || spec.max !== null)) {
        throw new Error('expect: --count takes --n, or --min/--max, not both');
      }
      spec.expected = {
        ...(spec.n !== null ? { n: spec.n } : {}),
        ...(spec.min !== null ? { min: spec.min } : {}),
        ...(spec.max !== null ? { max: spec.max } : {}),
      };
      break;
    case 'value': {
      const want = opts.expected ?? opts.equals;
      if (want === undefined || want === null || want === true) {
        throw new Error('expect: --value <@ref|css> needs --expected <text>');
      }
      spec.target = subject;
      spec.want = String(want);
      spec.expected = spec.want;
      break;
    }
    case 'eval':
      spec.expected = subject;
      break;
  }
  return spec;
}

function clip(v: unknown): unknown {
  if (typeof v === 'string' && v.length > CLIP) return `${v.slice(0, CLIP)}… (${v.length} chars)`;
  if (v !== null && typeof v === 'object') {
    let s: string;
    try { s = JSON.stringify(v); } catch { return String(v); }
    return s.length > CLIP ? `${s.slice(0, CLIP)}…` : v;
  }
  return v;
}

/** One look. `error` means the probe itself threw; it is polled like a miss. */
async function checkOnce(spec: ExpectSpec, p: ExpectProbes): Promise<{ pass: boolean; actual: unknown }> {
  switch (spec.kind) {
    case 'url': {
      const actual = await p.url();
      return { pass: new RegExp(spec.expected as string).test(actual), actual };
    }
    case 'title': {
      const actual = await p.title();
      return { pass: new RegExp(spec.expected as string).test(actual), actual };
    }
    case 'text': {
      const text = await p.text(spec.target);
      if (text === null) return { pass: false, actual: `selector not found: ${spec.target}` };
      return { pass: text.includes(spec.expected as string), actual: text };
    }
    case 'visible': {
      const actual = await p.visibility(spec.target!);
      return { pass: actual === 'visible', actual };
    }
    case 'hidden': {
      // An element that is not in the page at all is as hidden as it gets.
      const actual = await p.visibility(spec.target!);
      return { pass: actual !== 'visible', actual };
    }
    case 'count': {
      const actual = await p.count(spec.target!);
      const pass = spec.n !== null
        ? actual === spec.n
        : (spec.min === null || actual >= spec.min) && (spec.max === null || actual <= spec.max);
      return { pass, actual };
    }
    case 'value': {
      const actual = await p.value(spec.target!);
      if (actual === null) return { pass: false, actual: `not found: ${spec.target}` };
      return { pass: actual === spec.want, actual };
    }
    case 'eval': {
      const actual = await p.evaluate(spec.expected as string);
      return { pass: Boolean(actual), actual };
    }
  }
}

function describe(spec: ExpectSpec): string {
  switch (spec.kind) {
    case 'url': case 'title': return `${spec.kind} to match /${spec.expected}/`;
    case 'text': return `${spec.target ? `${spec.target} ` : 'page '}text to contain ${JSON.stringify(spec.expected)}`;
    case 'visible': return `${spec.target} to be visible`;
    case 'hidden': return `${spec.target} to be hidden or absent`;
    case 'count': return `count of ${spec.target} to be ${JSON.stringify(spec.expected)}`;
    case 'value': return `value of ${spec.target} to equal ${JSON.stringify(spec.want)}`;
    case 'eval': return `eval to be truthy: ${spec.expected}`;
  }
}

/** Race `p` against `ms`. The loser is left running; its rejection is swallowed. */
function withCap<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`probe did not settle within ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Polls until the check passes or `timeoutMs` runs out. The timeout bounds
 * the waiting, not one look: each look may run for max(time left, probeFloorMs)
 * and a look that sees the condition true passes however long it took.
 * Errors are polled through; if the last look threw, nothing was observed and
 * the result is EXPECT_ERROR rather than a failed assertion.
 */
export async function runExpect(
  spec: ExpectSpec,
  probes: ExpectProbes,
  clock: { now(): number; sleep(ms: number): Promise<void> } = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  },
  probeFloorMs = 1000,
): Promise<ExpectResult> {
  const started = clock.now();
  let attempts = 0;
  let last: unknown = null;
  let lastThrew = false;
  let lastError = '';
  for (;;) {
    attempts++;
    try {
      const cap = Math.max(spec.timeoutMs - (clock.now() - started), probeFloorMs);
      const { pass, actual } = await withCap(checkOnce(spec, probes), cap);
      last = actual;
      lastThrew = false;
      if (pass) {
        return {
          ok: true, expect: spec.kind, expected: spec.expected, actual: clip(actual),
          elapsedMs: clock.now() - started, attempts, timeoutMs: spec.timeoutMs,
        };
      }
    } catch (err) {
      lastError = (err as { message?: string } | null)?.message ?? String(err);
      last = `error: ${lastError}`;
      lastThrew = true;
    }
    const left = spec.timeoutMs - (clock.now() - started);
    if (left <= 0) break;
    await clock.sleep(Math.min(POLL_MS, left));
  }
  const elapsedMs = clock.now() - started;
  if (lastThrew) {
    return {
      ok: false, code: 'EXPECT_ERROR', expect: spec.kind, expected: spec.expected, actual: clip(last), elapsedMs, attempts,
      timeoutMs: spec.timeoutMs,
      message: `expect ${describe(spec)} could not be checked after ${elapsedMs}ms: ${lastError}`,
    };
  }
  return {
    ok: false, code: 'EXPECT_FAILED', expect: spec.kind, expected: spec.expected, actual: clip(last), elapsedMs, attempts,
    timeoutMs: spec.timeoutMs,
    message: `expect ${describe(spec)} failed after ${elapsedMs}ms; actual: ${JSON.stringify(clip(last))}`,
  };
}
