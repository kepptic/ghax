/**
 * Typed target errors and retry disposition, shared by both transports.
 *
 * Every daemon error carries `retry`:
 * - `safe`: the action provably never reached the page (the target failed to
 *   resolve, the arguments were bad, or the verb only reads). Re-running it
 *   cannot double an effect.
 * - `unsafe`: the target resolved and the action was handed to the browser.
 *   A click or fill may have landed even though an error came back.
 * - `unknown`: a mutating verb failed and nothing tells us how far it got.
 *
 * An explicit `retry` on the error wins. Otherwise `retryOf` decides from the
 * verb (read-only or not) and the per-RPC `delivered` flag, which resolvers
 * set once a target resolved: from then on the action may have run.
 */
import { AsyncLocalStorage } from 'async_hooks';

export type Retry = 'safe' | 'unsafe' | 'unknown';

export type TargetErrorCode = 'STALE_REF' | 'AMBIGUOUS_TARGET';

/** Documented exit codes (help.rs, README, skill). */
export const EXIT_STALE_REF = 6;
export const EXIT_AMBIGUOUS_TARGET = 7;

/**
 * A ref or selector that could not be resolved to exactly one live element.
 * Thrown before anything is dispatched, so it is always retry-safe (after the
 * caller fixes the target: re-snapshot, or a narrower selector).
 */
export class TargetError extends Error {
  readonly retry: Retry = 'safe';
  readonly exitCode: number;
  constructor(
    message: string,
    readonly code: TargetErrorCode,
    readonly hint: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.exitCode = code === 'STALE_REF' ? EXIT_STALE_REF : EXIT_AMBIGUOUS_TARGET;
  }
}

export function staleRef(ref: string, why: string, details?: Record<string, unknown>): TargetError {
  return new TargetError(
    `${ref} is stale: ${why}`,
    'STALE_REF',
    "run 'ghax snapshot -i' and use a ref from it",
    details,
  );
}

export function ambiguousTarget(target: string, count: number): TargetError {
  return new TargetError(
    `${target} matches ${count} elements; refusing to guess`,
    'AMBIGUOUS_TARGET',
    "use an @ref from 'ghax snapshot -i' or a selector that matches one element",
    { count },
  );
}

const dispatchState = new AsyncLocalStorage<{ delivered: boolean }>();

/**
 * Run one verb (RPC or batch step) with a fresh delivered flag. A failure
 * leaves with its `retry` set, decided while the flag is still in scope.
 */
export function withDispatchScope<T>(cmd: string, opts: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  return dispatchState.run({ delivered: false }, async () => {
    try {
      return await fn();
    } catch (err) {
      const retry = retryOf(err, cmd, opts);
      if (err !== null && typeof err === 'object') {
        try { Object.assign(err, { retry }); } catch { /* frozen: retryOf re-derives */ }
        throw err;
      }
      throw Object.assign(new Error(String(err)), { retry });
    }
  });
}

/** The target resolved: an error from here on may follow a delivered action. */
export function markDelivered(): void {
  const s = dispatchState.getStore();
  if (s) s.delivered = true;
}

/**
 * Verbs that change nothing in the page or the daemon. Any error from them is
 * retry-safe. Mirrors the CLI's IDEMPOTENT list (crates/cli/src/rpc.rs) plus
 * the other pure reads.
 */
const READ_ONLY = new Set([
  'status', 'tabs', 'find', 'findEl', 'text', 'html', 'snapshot', 'is', 'xpath', 'box',
  'console', 'network', 'cookies', 'downloads', 'screenshot', 'wait', 'expect', 'perf',
  'bridge.instances', 'bridge.stats', 'record.status', 'ext.list', 'ext.targets', 'ext.sw.logs',
  'count', 'url', 'title', 'version',
]);

export function retryOf(err: unknown, cmd: string, opts: Record<string, unknown> = {}): Retry {
  const tagged = (err as { retry?: unknown } | null)?.retry;
  if (tagged === 'safe' || tagged === 'unsafe' || tagged === 'unknown') return tagged;
  if (READ_ONLY.has(cmd) && !(cmd === 'bridge.stats' && opts.reset === true)) return 'safe';
  // Usage errors (exit 1/2 from DaemonError) are raised while parsing.
  const exit = (err as { exitCode?: unknown } | null)?.exitCode;
  if (exit === 1 || exit === 2) return 'safe';
  return dispatchState.getStore()?.delivered ? 'unsafe' : 'unknown';
}

/** Tag an error with an explicit disposition, returning it. */
export function withRetry<E extends Error>(err: E, retry: Retry): E {
  return Object.assign(err, { retry });
}
