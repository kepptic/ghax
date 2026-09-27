/**
 * Default output budget for `ghax snapshot`, shared by both transports.
 *
 * Why: a large SPA produces thousands of refs, and an agent pays for every
 * line of that in context before it can act on any of them. The cap keeps
 * the first 250 refs / 32 KB of the rendered tree (document order, AX refs
 * before the cursor-interactive section) and says in-band how much was cut,
 * so the reader knows to narrow with --selector/--depth rather than assume
 * the page ends there.
 *
 * Only the TEXT is cut. The ref map keeps every ref, so an agent that saw
 * `@e812` in an earlier, narrower snapshot can still act on it.
 */

export const DEFAULT_MAX_REFS = 250;
export const DEFAULT_MAX_CHARS = 32_768;

export interface SnapshotBudget {
  /** 0 = unlimited. */
  maxRefs: number;
  /** 0 = unlimited. */
  maxChars: number;
}

export interface BudgetedText {
  text: string;
  /** Refs printed. */
  shownRefs: number;
  /** Refs in the whole rendered tree. */
  totalRefs: number;
  omittedRefs: number;
  omittedLines: number;
}

const REF_LINE = /^\s*@[ec]\d+\b/;

export const OMITTED_HINT = 'use --depth/--selector/--max-refs, or --no-cap';

/**
 * Line-granular cut: lines are kept in order until the next one would push
 * the ref count past maxRefs or the text past maxChars. The first line is
 * always kept so a pathological single line still shows something.
 */
export function applySnapshotBudget(lines: string[], budget: SnapshotBudget): BudgetedText {
  const totalRefs = lines.reduce((n, l) => n + (REF_LINE.test(l) ? 1 : 0), 0);
  const kept: string[] = [];
  let refs = 0;
  let chars = 0;
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isRef = REF_LINE.test(line);
    const addChars = line.length + (kept.length > 0 ? 1 : 0);
    const overRefs = budget.maxRefs > 0 && isRef && refs + 1 > budget.maxRefs;
    const overChars = budget.maxChars > 0 && chars + addChars > budget.maxChars;
    if (kept.length > 0 && (overRefs || overChars)) {
      cut = i;
      break;
    }
    kept.push(line);
    chars += addChars;
    if (isRef) refs++;
  }
  if (cut < 0) {
    return { text: lines.join('\n'), shownRefs: refs, totalRefs, omittedRefs: 0, omittedLines: 0 };
  }
  // Trailing blank / section-header lines with nothing under them read as
  // noise before the marker.
  while (kept.length > 1 && (kept[kept.length - 1] === '' || kept[kept.length - 1].startsWith('──'))) kept.pop();
  const omittedLines = lines.length - kept.length;
  const omittedRefs = totalRefs - refs;
  const marker = omittedRefs > 0
    ? `… ${omittedRefs} more refs omitted (${OMITTED_HINT})`
    : `… ${omittedLines} more lines omitted (${OMITTED_HINT})`;
  return {
    text: [...kept, marker].join('\n'),
    shownRefs: refs,
    totalRefs,
    omittedRefs,
    omittedLines,
  };
}

/** Read --max-refs / --max-chars / --no-cap from RPC opts. */
export function budgetFromOpts(opts: Record<string, unknown>): SnapshotBudget {
  if (opts['no-cap'] === true || opts.noCap === true) return { maxRefs: 0, maxChars: 0 };
  const num = (v: unknown, fallback: number): number => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  const maxRefs = num(opts['max-refs'] ?? opts.maxRefs, DEFAULT_MAX_REFS);
  // --max-refs 0 means "no cap" as a whole, per the documented escape hatch.
  if (maxRefs === 0 && (opts['max-refs'] ?? opts.maxRefs) !== undefined && (opts['max-chars'] ?? opts.maxChars) === undefined) {
    return { maxRefs: 0, maxChars: 0 };
  }
  return { maxRefs, maxChars: num(opts['max-chars'] ?? opts.maxChars, DEFAULT_MAX_CHARS) };
}
