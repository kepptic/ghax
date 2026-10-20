/**
 * Find the page Target.createTarget just made, by target id. Split out of
 * daemon.ts so the matching rule is testable without a browser.
 */

export interface TargetPageSource<P> {
  /** Every page the context knows right now. */
  pages(): P[];
  /** The page's CDP target id; null when the browser won't say. */
  targetIdOf(page: P): Promise<string | null>;
  /** Resolves on the next page event or after `ms`, whichever comes first. */
  nextPage(ms: number): Promise<unknown>;
}

/**
 * The page whose target id is `targetId`. Playwright may surface it before or
 * after createTarget answers, so scan what is there, then wait for more page
 * events in short slices: a page that lands between a scan and the wait is
 * caught by the next scan. Another agent's (or the user's) new tab arriving in
 * the same moment never matches.
 */
export async function waitForTargetPage<P>(
  src: TargetPageSource<P>, targetId: string, timeoutMs: number, sliceMs = 250,
): Promise<P> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const p of src.pages()) {
      if ((await src.targetIdOf(p)) === targetId) return p;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(`new tab ${targetId} did not appear within ${timeoutMs} ms; it may still be opening. Run 'ghax tabs' to find it.`);
    }
    await src.nextPage(Math.min(left, sliceMs)).catch(() => undefined);
  }
}
