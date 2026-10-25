/**
 * What `record` may store. Lives outside daemon.ts so the sims can import it.
 */

// Commands we never store in a recording: meta-operations on the recorder
// itself, or read-only queries a replay should not re-run as "actions".
export const NEVER_RECORD = new Set([
  'record.start', 'record.stop', 'record.status',
  'status', 'health',
  'tabs', 'console', 'network', 'cookies', 'text', 'html',
  // Writes a secrets file; a replay must never re-export a session.
  'auth.export',
  // Read-only queries that don't change page state — replay would re-fire
  // the measurement, not the action, and waste time. Add every new
  // read-only handler here.
  'find', 'is', 'perf', 'xpath', 'box', 'findEl',
]);

export interface RecordableStep {
  cmd: string;
  args: unknown[];
  opts: Record<string, unknown>;
  note?: string;
}

/**
 * The step to store for a dispatched command, or null to store nothing.
 * `batch` runs its steps through the handlers directly, so the outer cmd
 * check alone would let a NEVER_RECORD step (auth.export) ride inside one:
 * drop those steps (recursively) and leave a note, or skip the batch when
 * nothing is left.
 */
export function recordableStep(cmd: string, args: unknown[], opts: Record<string, unknown>): RecordableStep | null {
  if (NEVER_RECORD.has(cmd)) return null;
  if (cmd !== 'batch' || !Array.isArray(args[0])) return { cmd, args, opts };
  const { steps, dropped } = scrubBatch(args[0]);
  if (steps.length === 0) return null;
  return {
    cmd,
    args: [steps, ...args.slice(1)],
    opts,
    ...(dropped > 0 ? { note: `${dropped} non-replayable step(s) dropped from this batch` } : {}),
  };
}

function scrubBatch(raw: unknown[]): { steps: unknown[]; dropped: number } {
  const steps: unknown[] = [];
  let dropped = 0;
  for (const s of raw) {
    const step = s as { cmd?: unknown; args?: unknown } | null;
    const c = step && typeof step === 'object' ? step.cmd : undefined;
    if (typeof c === 'string' && NEVER_RECORD.has(c)) { dropped++; continue; }
    if (c === 'batch' && step && Array.isArray(step.args) && Array.isArray(step.args[0])) {
      const inner = scrubBatch(step.args[0]);
      dropped += inner.dropped;
      if (inner.steps.length === 0) continue;
      steps.push({ ...step, args: [inner.steps, ...step.args.slice(1)] });
      continue;
    }
    steps.push(s);
  }
  return { steps, dropped };
}
