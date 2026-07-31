/**
 * Pure error-classification predicates for the bridge extension.
 *
 * Split out of background.js for one reason: background.js touches `chrome.*`
 * at module scope, so Node can't import it and these predicates had zero test
 * coverage. They are exactly the kind of thing that needs it — each one is a
 * regex against strings Chrome produces, and a string it fails to match is a
 * user-visible failure, not a caught edge case. That is how
 * `uniqueContextId not found` slipped past `isStaleContextError` on the daemon
 * side (see src/bridge.ts) and how `chrome-extension://` slipped past this
 * file's predicate below.
 *
 * No chrome.* access here. Keep it that way so test/bridge-sim.ts can import it.
 */

/**
 * True when `chrome.debugger.attach` is refusing *for now* — the tab is on a
 * page the debugger may not touch, and will likely become attachable again.
 *
 * The scheme alternation deliberately allows a `-suffix`, so this matches
 * `chrome://`, `edge://`, `chrome-error://` (cert interstitials) AND
 * `chrome-extension://`. The last two were both missed by the original
 * `(?:chrome|edge):\/\/`, which required the scheme to end at the colon:
 *
 *   - `chrome-error://` is the cert-interstitial case this predicate was
 *     written for in the first place — it only ever worked because Chrome
 *     also says "Cannot attach to this target" for some of those.
 *   - `Cannot access a chrome-extension:// URL of different extension` is what
 *     Chrome returns for a moment after a cross-origin navigation, measured at
 *     ~25% of zero-settle rounds against concord.rmm.datto.com ⇄
 *     ww14.autotask.net. Unmatched, it surfaced to the user as a hard failure.
 */
export function isTemporarilyUnattachable(err) {
  const msg = err?.message ?? String(err);
  return /cannot attach to this target|cannot (?:access|attach to) (?:a )?(?:chrome|edge)(?:-\w+)?:\/\/|no tab with given id|target closed/i.test(msg);
}

/**
 * True when the debugger session dropped *while a command was in flight*.
 *
 * Deliberately NOT folded into isTemporarilyUnattachable: that predicate gates
 * a pre-dispatch retry, which is safe because the command provably never ran.
 * This one means the opposite — the command may have partially executed, so
 * the only honest thing is to report it and let the daemon's retry-class table
 * decide (docs/design/plan/08-bridge-reliability.md §2.3).
 */
export function isDetachedMidCommand(err) {
  const msg = err?.message ?? String(err);
  return /detached while handling command|debugger is not attached/i.test(msg);
}
