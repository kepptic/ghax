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
 * Only the TEXT is cut. The ref map still holds every ref this snapshot
 * found, so a ref cut from the printout (or seen in an earlier `--no-cap`
 * or `--selector` look at the same, unchanged elements) still resolves.
 * The map itself is replaced by the next snapshot, as always.
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

/** Leading spaces of a rendered snapshot line (two per tree level). */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * `snapshot --grep`: keep the lines matching `re`, each match's ancestor
 * lines (walking up by indentation, so a hit under a dialog still shows the
 * dialog), and `context` lines after it. Document order, no duplicates.
 *
 * Runs on the rendered text BEFORE applySnapshotBudget, so the ref/char cap
 * counts only what was asked for. Printing only: the ref registry already
 * holds every ref from the snapshot and is not touched here.
 */
export function grepSnapshotLines(lines: string[], re: RegExp, context = 0): string[] {
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    keep.add(i);
    let want = indentOf(lines[i]);
    for (let j = i - 1; j >= 0 && want > 0; j--) {
      if (lines[j].trim() === '') continue;
      const ind = indentOf(lines[j]);
      if (ind < want) {
        keep.add(j);
        want = ind;
      }
    }
    for (let j = i + 1; j <= i + context && j < lines.length; j++) keep.add(j);
  }
  return lines.filter((_, i) => keep.has(i));
}

/** Read --grep / --context from RPC opts; null when --grep is absent. */
export function grepFromOpts(opts: Record<string, unknown>): { re: RegExp; context: number } | null {
  const raw = opts.grep;
  if (raw === undefined || raw === false) return null;
  if (typeof raw !== 'string' || raw === '') {
    throw new SnapshotGrepError("snapshot: --grep needs a regex. Use --grep='<regex>' (the = form also works for patterns starting with a dash)");
  }
  let re: RegExp;
  try {
    re = new RegExp(raw);
  } catch (err) {
    throw new SnapshotGrepError(`snapshot: --grep '${raw}' is not a valid regex: ${(err as Error).message}`);
  }
  const ctxRaw = opts.context;
  let context = 0;
  if (ctxRaw !== undefined) {
    context = Number(ctxRaw);
    if (!Number.isInteger(context) || context < 0) {
      throw new SnapshotGrepError(`snapshot: --context needs a whole number of lines, got '${String(ctxRaw)}'`);
    }
  }
  return { re, context };
}

/** Bad --grep/--context input; the daemon maps it to exit 2. */
export class SnapshotGrepError extends Error {
  readonly exitCode = 2;
}

/** Apply --grep (if given) to rendered lines; a miss says so in-band. */
export function applyGrep(lines: string[], opts: Record<string, unknown>): string[] {
  const g = grepFromOpts(opts);
  if (!g) return lines;
  const out = grepSnapshotLines(lines, g.re, g.context);
  return out.length > 0 ? out : [`(no snapshot line matches ${g.re})`];
}
