/**
 * Accessibility-tree snapshot with @e<n> refs (CDP transport).
 *
 * Originally adapted from gstack/browse/src/snapshot.ts (MIT, Garry Tan);
 * the ref model below replaced its getByRole().nth() reconstruction.
 *
 * Flow:
 *   1. rootLocator.ariaSnapshotJSON({ mode: 'ai' }) → a JSON tree in which
 *      Playwright has already minted a ref (`e<n>`) for every visible node
 *      that receives pointer events.
 *   2. Walk it and render ghax's own line format
 *      (`@e12 [button] "Save" [checked, expanded]: text`).
 *   3. Each rendered ref resolves through Playwright's `aria-ref=e12`
 *      selector engine.
 *   4. Optional cursor-interactive pass (`@c<n>`), unchanged: catches Radix
 *      dropdowns/popovers built from cursor:pointer divs.
 *
 * Why aria-ref (plan 10, C7): Playwright caches the ref ON the element
 * (`_ariaRef`, reused while role and name are unchanged), so the same
 * element keeps its number across snapshots and an insertion above it does
 * not shift it. The old getByRole+nth locators silently re-targeted the
 * next same-named element after any DOM change. Costs: numbering is sparse
 * (refs count every interactable node, not only the ones printed), and
 * numbers restart on navigation.
 *
 * CACHE RULE: the aria-ref engine resolves only against the LAST
 * ariaSnapshot/ariaSnapshotJSON taken in that frame (any mode, any scope;
 * a locator-scoped snapshot makes the cache that subtree). This file must
 * stay the daemon's single call site for either method, or refs from the
 * user's last `ghax snapshot` stop resolving. Semi-private behaviour, hence
 * the exact Playwright pin in package.json and the smoke checks that pin it.
 */

import type { Page, Locator, Frame } from 'playwright';
import { RefRegistry, type RefAllocator } from './ref-registry';

export interface RefEntry {
  locator: Locator;
  role: string;
  name: string;
}

export interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  cursorInteractive?: boolean;
  /**
   * When true (default) and no explicit --selector was passed, auto-scope
   * the snapshot to an open modal dialog if one is visible. Outer app is
   * usually `aria-hidden="true"` while a modal is up, which means walking
   * from `body` yields an empty-ish tree and every captured ref lives on
   * a hidden ancestor. Pass `--no-dialog-scope` to force body.
   */
  dialogScope?: boolean;
  /**
   * Ref numbering (src/ref-registry.ts), bound to the current document. The
   * printed `@eN` is ghax's own daemon-wide number mapped to Playwright's
   * full `f<seq>e<n>`, never Playwright's number itself: Playwright restarts
   * `e<n>` per document, and a reused number is a wrong-element click.
   */
  refs?: RefAllocator;
}

export interface SnapshotResult {
  text: string;
  refs: Map<string, RefEntry>;
  count: number;
  /** True when rooted at --selector or a modal, i.e. not the whole page. */
  scoped?: boolean;
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem',
]);

/**
 * Single source of truth for "what counts as an open modal."
 * Used by the snapshot dialog-scope walker AND by the click handler's
 * post-click observation (did the modal actually dismiss?).
 *
 * Covers `[role=dialog]`, `[role=alertdialog]`, the native `<dialog open>`,
 * and ad-hoc `[aria-modal="true"]` scrims (Radix, Headless UI, Material,
 * HubSpot's Dialog__StyledDialog). The `:visible` pseudo filters detached
 * / display:none dialogs that some frameworks leave in the DOM between
 * openings.
 */
export const MODAL_SEL =
  '[role=dialog]:visible, [role=alertdialog]:visible, dialog[open]:visible, [aria-modal="true"]:visible';

/**
 * Structural copy of Playwright's AriaNodeJSON (packages/isomorphic/
 * ariaSnapshot.ts); the public API types the result as `Serializable`.
 */
interface AriaNodeJSON {
  role: string;
  name?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  active?: boolean;
  invalid?: boolean;
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
  ref?: string;
  cursor?: 'pointer';
  url?: string;
  placeholder?: string;
  text?: string;
  children?: Array<AriaNodeJSON | string>;
}

function renderProps(n: AriaNodeJSON): string {
  const out: string[] = [];
  if (n.checked === 'mixed') out.push('checked=mixed');
  else if (n.checked) out.push('checked');
  if (n.disabled) out.push('disabled');
  if (n.expanded) out.push('expanded');
  if (n.active) out.push('active');
  if (n.invalid) out.push('invalid');
  if (n.level) out.push(`level=${n.level}`);
  if (n.pressed === 'mixed') out.push('pressed=mixed');
  else if (n.pressed) out.push('pressed');
  if (n.selected) out.push('selected');
  if (n.placeholder) out.push(`placeholder=${JSON.stringify(n.placeholder)}`);
  return out.length ? `[${out.join(', ')}]` : '';
}

/**
 * A Playwright-minted ref: `e<n>`, or `f<seq>e<n>`. The prefix is NOT only
 * for iframes: Playwright renumbers the MAIN frame every time it navigates
 * away from a real document (server/frames.ts, "Re-number the main frame"),
 * so after the first navigation the main frame's own refs look like `f3e6`.
 * The full string goes into the `aria-ref=` locator; what ghax prints is a
 * daemon-wide number from the ref registry.
 */
const PW_REF = /^(?:f\d+)?e\d+$/;

export async function snapshot(
  target: Page | Frame,
  opts: SnapshotOptions = {},
): Promise<SnapshotResult> {
  // Root: --selector, else the top-most visible modal, else body. Scoping is
  // inherent now: a ref minted in a modal-scoped snapshot resolves only
  // inside that snapshot's subtree, so no locator re-scoping is needed.
  const allocator = opts.refs ?? new RefRegistry().forDoc('local');
  let modalScoped = false;
  let rootLocator: Locator = opts.selector ? target.locator(opts.selector) : target.locator('body');
  if (opts.selector) {
    const count = await rootLocator.count();
    if (count === 0) throw new Error(`Selector not found: ${opts.selector}`);
  } else if (opts.dialogScope !== false) {
    const modal = target.locator(MODAL_SEL).last();
    if ((await modal.count()) > 0) {
      rootLocator = modal;
      modalScoped = true;
    }
  }

  // The daemon's ONLY ariaSnapshot* call site (see CACHE RULE above).
  const tree = await rootLocator.ariaSnapshotJSON({ mode: 'ai' }) as unknown as AriaNodeJSON[];
  if (!Array.isArray(tree) || tree.length === 0) {
    return { text: '(no accessible elements found)', refs: new Map(), count: 0, scoped: Boolean(opts.selector) || modalScoped };
  }

  const refs = new Map<string, RefEntry>();
  const output: string[] = [];
  const alive = new Set<string>();

  // Iframe content renders but its refs are not registered (the ref engine
  // can reach them, but ghax's actions and guards assume the main frame).
  const walk = (node: AriaNodeJSON | string, depth: number, inIframe = false): void => {
    if (typeof node === 'string') {
      if (opts.interactive || opts.compact) return;
      if (opts.depth !== undefined && depth > opts.depth) return;
      const text = node.trim();
      if (text) output.push(`${'  '.repeat(depth)}[text]: ${text}`);
      return;
    }
    const role = node.role;
    const name = node.name ?? '';
    // Nameless generic wrappers are layout noise; flatten them unless they
    // are clickable (cursor:pointer), which is exactly what agents look for.
    const flatten = (role === 'generic' && !name && node.cursor !== 'pointer') || role === 'fragment';
    if (!flatten) {
      const isInteractive = INTERACTIVE_ROLES.has(role);
      const withinDepth = opts.depth === undefined || depth <= opts.depth;
      const text = node.text ?? '';
      const compactSkip = opts.compact && !isInteractive && !name && !text;
      if (withinDepth && !compactSkip && (!opts.interactive || isInteractive)) {
        const pwRef = node.ref;
        let line = '  '.repeat(depth);
        if (pwRef && !inIframe && PW_REF.test(pwRef)) {
          alive.add(`p${pwRef}`);
          const ref = allocator.assign('e', `p${pwRef}`, role, name);
          line += `@${ref} `;
          refs.set(ref, { locator: target.locator(`aria-ref=${pwRef}`), role, name });
        }
        line += `[${role}]`;
        if (name) line += ` ${JSON.stringify(name)}`;
        const props = renderProps(node);
        if (props) line += ` ${props}`;
        if (node.cursor === 'pointer' && !isInteractive) line += ' [cursor:pointer]';
        if (text) line += `: ${text}`;
        output.push(line);
      }
    }
    const childInIframe = inIframe || role === 'iframe';
    for (const child of node.children ?? []) walk(child, flatten ? depth : depth + 1, childInIframe);
  };
  for (const node of tree) walk(node, 0);

  // Auto-enable cursor scan when interactive mode is on — many React apps
  // (Radix, Headless UI) build popovers from plain divs with cursor:pointer.
  // The scan walks both light DOM and any open shadow roots it encounters,
  // emitting Playwright-compatible chain selectors (`host >> inner`) when
  // it crosses a shadow boundary.
  //
  // `--compact` explicitly skips the cursor pass: on heavy SPAs it dominates
  // the output size (hundreds of entries, each with a selector chain), and
  // operators who asked for compact are saying "I want the ARIA tree and
  // nothing else". `-C` (explicit cursorInteractive) still wins because it's
  // an explicit ask — --compact only suppresses the implicit `-i` trigger.
  const wantCursor = opts.cursorInteractive || (opts.interactive && !opts.compact);
  if (wantCursor) {
    try {
      const cursorElements = await target.evaluate(() => {
        const STANDARD = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS']);
        const results: Array<{ selector: string; text: string; reason: string }> = [];

        // Build a selector path for an element that may be inside nested open
        // shadow roots. Each shadow boundary becomes a ` >> ` in the output
        // — Playwright's chain operator, which descends into the first
        // selector's match (including its open shadow root) before applying
        // the next selector. We chain per-tree nth-child segments because
        // that guarantees uniqueness within each shadow tree.
        //
        // Per-tree walk needs to handle three cases at each step:
        //   (1) walker.parentElement exists — normal light-DOM ancestor chain.
        //   (2) walker.parentElement is null AND parentNode is a ShadowRoot —
        //       walker is a direct child of the shadow root. We still need to
        //       emit its nth-child position against the shadow root's children
        //       before crossing the boundary.
        //   (3) walker.parentElement is null AND parentNode is null/document —
        //       we're at <html>; stop.
        const selectorFor = (el: Element): string => {
          const chunks: string[] = [];
          let current: Element | null = el;
          while (current && current !== document.documentElement) {
            const segment: string[] = [];
            let walker: Element | null = current;
            while (walker) {
              const parent: Element | null = walker.parentElement;
              const parentNode = walker.parentNode;
              let siblings: Element[] | null = null;
              if (parent) {
                siblings = Array.from(parent.children);
              } else if (parentNode instanceof ShadowRoot) {
                siblings = Array.from(parentNode.children);
              }
              if (!siblings) break;
              const idx = siblings.indexOf(walker) + 1;
              segment.unshift(`${walker.tagName.toLowerCase()}:nth-child(${idx})`);
              if (!parent) break;
              walker = parent;
            }
            chunks.unshift(segment.join(' > '));
            // Cross the shadow boundary if this node lives in a shadow root.
            const root = current.getRootNode();
            if (root instanceof ShadowRoot && root.host) {
              current = root.host;
            } else {
              current = null;
            }
          }
          return chunks.join(' >> ');
        };

        // Cache getComputedStyle() calls for the duration of this walk. The
        // cursor-interactive pass reads style on every candidate in consider()
        // and again for every ancestor of every candidate in isInFloating().
        // On a 5k-element SPA that's O(n · depth) uncached reads, each one a
        // forced style recalc. One WeakMap cuts it to O(n).
        const styleCache = new WeakMap<Element, CSSStyleDeclaration>();
        const styleOf = (el: Element): CSSStyleDeclaration => {
          let s = styleCache.get(el);
          if (!s) {
            s = getComputedStyle(el);
            styleCache.set(el, s);
          }
          return s;
        };

        const isInFloating = (el: Element): boolean => {
          let p: Element | null = el;
          while (p && p !== document.documentElement) {
            const ps = styleOf(p);
            const floating = (ps.position === 'fixed' || ps.position === 'absolute') &&
              parseInt(ps.zIndex || '0', 10) >= 10;
            const portal = p.hasAttribute('data-radix-popper-content-wrapper') ||
              p.hasAttribute('data-radix-portal') ||
              p.hasAttribute('data-floating-ui-portal') ||
              p.getAttribute('role') === 'listbox' ||
              p.getAttribute('role') === 'menu';
            if (floating || portal) return true;
            p = p.parentElement;
          }
          return false;
        };

        const consider = (el: Element, inShadow: boolean) => {
          if (STANDARD.has(el.tagName)) return;
          if (!(el as HTMLElement).offsetParent && el.tagName !== 'BODY') return;
          const style = styleOf(el);
          const cursorPointer = style.cursor === 'pointer';
          const onclick = el.hasAttribute('onclick');
          const tabindex = el.hasAttribute('tabindex') && parseInt(el.getAttribute('tabindex')!, 10) >= 0;
          const hasRole = el.hasAttribute('role');
          const inFloating = isInFloating(el);

          if (!cursorPointer && !onclick && !tabindex) {
            if (inFloating && hasRole) {
              const r = el.getAttribute('role');
              if (!['option', 'menuitem', 'menuitemcheckbox', 'menuitemradio'].includes(r || '')) return;
            } else return;
          }
          if (hasRole && !inFloating) return;

          const text = (el as HTMLElement).innerText?.trim().slice(0, 80) || el.tagName.toLowerCase();
          const reasons: string[] = [];
          if (inShadow) reasons.push('shadow');
          if (inFloating) reasons.push('popover');
          if (cursorPointer) reasons.push('cursor:pointer');
          if (onclick) reasons.push('onclick');
          if (tabindex) reasons.push(`tabindex=${el.getAttribute('tabindex')}`);
          if (hasRole) reasons.push(`role=${el.getAttribute('role')}`);
          results.push({ selector: selectorFor(el), text, reason: reasons.join(', ') });
        };

        // Recursive walker: visits every element in the document, descending
        // into open shadow roots (closed shadow roots are deliberately skipped
        // — `el.shadowRoot` is null for closed mode, and we can't force entry).
        const walk = (root: Document | ShadowRoot, inShadow: boolean) => {
          for (const el of Array.from(root.querySelectorAll('*'))) {
            consider(el, inShadow);
            const sr = (el as HTMLElement).shadowRoot;
            if (sr) walk(sr, true);
          }
        };
        walk(document, false);

        return results;
      });

      if (cursorElements.length > 0) {
        output.push('');
        output.push('── cursor-interactive (not in ARIA tree) ──');
        for (const elem of cursorElements) {
          alive.add(`s${elem.selector}`);
          const ref = allocator.assign('c', `s${elem.selector}`, 'cursor-interactive', elem.text);
          const locator = target.locator(elem.selector);
          refs.set(ref, { locator, role: 'cursor-interactive', name: elem.text });
          output.push(`@${ref} [${elem.reason}] "${elem.text}"`);
        }
      }
    } catch (err: any) {
      // Swallow only the expected ephemeral failures; everything else is a real bug.
      const msg = err?.message || '';
      if (
        msg.includes('Execution context') ||
        msg.includes('closed') ||
        msg.includes('Target') ||
        msg.includes('Content Security')
      ) {
        output.push('');
        output.push('(cursor scan failed — page navigated or CSP)');
      } else {
        throw err;
      }
    }
  }

  // Only a body-rooted snapshot sees the whole page, so only it may forget
  // identities (a modal or --selector look must not renumber the rest).
  if (!opts.selector && !modalScoped) allocator.prune(alive);

  const scoped = Boolean(opts.selector) || modalScoped;
  if (output.length === 0) {
    return { text: '(no interactive elements found)', refs, count: 0, scoped };
  }
  return { text: output.join('\n'), refs, count: refs.size, scoped };
}
