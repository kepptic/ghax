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

/**
 * True when chrome.debugger refused the tab because ANOTHER extension has a
 * frame in it. Chromium won't attach to a tab holding a chrome-extension://
 * frame it doesn't own; Hudu Assist does exactly that on authenticated
 * Autotask (ww14.autotask.net). Narrower than isTemporarilyUnattachable on
 * purpose: this one alone is worth stripping frames for.
 */
export function isForeignExtensionFrameError(err) {
  const msg = err?.message ?? String(err);
  return /chrome-extension:\/\/ URL of different extension/i.test(msg);
}

/**
 * Injected into every frame of the tab by chrome.scripting.executeScript, so
 * it must be self-contained: no closures, no imports, only its argument and
 * page globals. Removes every <iframe> whose src is a chrome-extension:// URL
 * of an extension other than `ownId`, including ones inside shadow roots.
 * Closed roots are only reachable through chrome.dom.openOrClosedShadowRoot,
 * which content scripts get on Chrome 88+ / Edge; elsewhere it falls back to
 * el.shadowRoot (open roots only). Returns the extension hosts it removed.
 *
 * Same idea as Claude in Chrome's "stripExtensionInterference".
 */
export function stripForeignExtensionFrames(ownId) {
  const removed = [];
  const openRoot = globalThis.chrome?.dom?.openOrClosedShadowRoot;
  const shadowOf = (el) => {
    if (openRoot) {
      try { return openRoot(el) ?? null; } catch { /* not a shadow host */ }
    }
    return el.shadowRoot ?? null;
  };
  const base = globalThis.location?.href;
  const seen = new Set();
  const walk = (root) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (String(el.tagName).toUpperCase() === 'IFRAME') {
        const raw = el.getAttribute?.('src') ?? el.src ?? '';
        let url = null;
        try { url = new URL(raw, base); } catch { /* unparseable src: leave it */ }
        if (url && url.protocol === 'chrome-extension:' && url.host !== ownId) {
          removed.push(url.host);
          el.remove();
          continue;
        }
      }
      const shadow = shadowOf(el);
      if (shadow) walk(shadow);
    }
  };
  walk(globalThis.document);
  return removed;
}

/**
 * Run `attach`; if Chromium refuses it over a foreign extension frame, call
 * `strip` (removes the frames, resolves to the hosts removed) and retry with
 * a 75ms*(n+1) backoff, at most `maxTries` times. Each retry that is refused
 * the same way strips again first: the injecting extension may put its frame
 * back. If the first strip removes nothing, or every retry is refused, the
 * ORIGINAL error is thrown so the daemon's bridgeError() classification and
 * hint still apply. Any other error from a retry propagates as-is.
 *
 * The backoff is ~750ms, long enough for the caller to give the tab up
 * (`bridge control --stop`, a switch to another tab, a demotion to parked,
 * another agent claiming it). `stillWanted` is asked before every strip and
 * every retry attach; once it says no, the ORIGINAL error is thrown. A retry
 * that succeeds after the caller stopped wanting the tab is undone with
 * `detach` and the original error is thrown, so the caller never records an
 * attachment to a tab it no longer owns.
 *
 * Takes its side effects as arguments so test/bridge-sim.ts can drive it.
 */
export async function attachStrippingForeignFrames({
  attach,
  strip,
  detach = async () => undefined,
  stillWanted = () => true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => undefined,
  maxTries = 4,
  baseDelayMs = 75,
}) {
  let original;
  try {
    return await attach();
  } catch (err) {
    if (!isForeignExtensionFrameError(err)) throw err;
    original = err;
  }
  if (!stillWanted()) throw original;
  const first = await strip().catch(() => []);
  if (!first?.length) throw original;
  log(first);
  for (let n = 0; n < maxTries; n++) {
    await sleep(baseDelayMs * (n + 1));
    if (!stillWanted()) throw original;
    let result;
    let attached = false;
    try {
      result = await attach();
      attached = true;
    } catch (err) {
      if (!isForeignExtensionFrameError(err)) throw err;
    }
    if (attached) {
      if (stillWanted()) return result;
      await Promise.resolve(detach()).catch(() => undefined);
      throw original;
    }
    if (n + 1 < maxTries) {
      if (!stillWanted()) throw original;
      const again = await strip().catch(() => []);
      if (again?.length) log(again);
    }
  }
  throw original;
}
