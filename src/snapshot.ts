/**
 * Accessibility-tree snapshot with @e<n> refs.
 *
 * Adapted from gstack/browse/src/snapshot.ts (MIT — Garry Tan).
 *
 * Flow:
 *   1. page.locator('body').ariaSnapshot() → YAML-like tree
 *   2. Parse, assign @e1, @e2, ... to interactive roles (or all roles if -i off)
 *   3. Build Playwright Locator for each ref via getByRole + nth() disambiguation
 *   4. Optional cursor-interactive pass — catches Radix dropdowns/popovers that
 *      never land in the a11y tree because they use cursor:pointer divs
 *   5. Return compact rendered tree + a Map<string, RefEntry>
 *
 * The caller stores the RefEntry map on the tab session so later
 * `click @e3` / `fill @e5 <value>` can resolve back to a Locator.
 */

import type { Page, Locator, Frame } from 'playwright';

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
}

export interface SnapshotResult {
  text: string;
  refs: Map<string, RefEntry>;
  count: number;
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem',
]);

interface ParsedNode {
  indent: number;
  role: string;
  name: string | null;
  props: string;
  children: string;
}

function parseLine(line: string): ParsedNode | null {
  const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?(?:\s+(\[.*?\]))?\s*(?::\s*(.*))?$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    role: match[2],
    name: match[3] ?? null,
    props: match[4] || '',
    children: match[5]?.trim() || '',
  };
}

export async function snapshot(
  target: Page | Frame,
  opts: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const rootLocator = opts.selector ? target.locator(opts.selector) : target.locator('body');
  if (opts.selector) {
    const count = await rootLocator.count();
    if (count === 0) throw new Error(`Selector not found: ${opts.selector}`);
  }

  const ariaText = await rootLocator.ariaSnapshot();
  if (!ariaText || ariaText.trim().length === 0) {
    return { text: '(no accessible elements found)', refs: new Map(), count: 0 };
  }

  const refs = new Map<string, RefEntry>();
  const output: string[] = [];
  let refCounter = 1;

  // Disambiguation: count role+name pairs so we can nth() duplicates
  const roleNameCounts = new Map<string, number>();
  const roleNameSeen = new Map<string, number>();

  const nodes: ParsedNode[] = [];
  for (const line of ariaText.split('\n')) {
    const node = parseLine(line);
    if (!node) continue;
    nodes.push(node);
    const key = `${node.role}:${node.name || ''}`;
    roleNameCounts.set(key, (roleNameCounts.get(key) || 0) + 1);
  }

  for (const node of nodes) {

    const depth = Math.floor(node.indent / 2);
    const isInteractive = INTERACTIVE_ROLES.has(node.role);

    if (opts.depth !== undefined && depth > opts.depth) continue;

    // Still advance seen counter on skipped interactive-filtered nodes so locator
    // indexing stays aligned with the ariaSnapshot document order.
    if (opts.interactive && !isInteractive) {
      const key = `${node.role}:${node.name || ''}`;
      roleNameSeen.set(key, (roleNameSeen.get(key) || 0) + 1);
      continue;
    }
    if (opts.compact && !isInteractive && !node.name && !node.children) continue;

    const ref = `e${refCounter++}`;
    const indent = '  '.repeat(depth);
    const key = `${node.role}:${node.name || ''}`;
    const seenIndex = roleNameSeen.get(key) || 0;
    roleNameSeen.set(key, seenIndex + 1);
    const totalCount = roleNameCounts.get(key) || 1;

    let locator: Locator = target.getByRole(node.role as any, {
      name: node.name || undefined,
    });
    if (opts.selector) {
      locator = target.locator(opts.selector).getByRole(node.role as any, {
        name: node.name || undefined,
      });
    }
    if (totalCount > 1) locator = locator.nth(seenIndex);

    refs.set(ref, { locator, role: node.role, name: node.name || '' });

    let outputLine = `${indent}@${ref} [${node.role}]`;
    if (node.name) outputLine += ` "${node.name}"`;
    if (node.props) outputLine += ` ${node.props}`;
    if (node.children) outputLine += `: ${node.children}`;
    output.push(outputLine);
  }

  // Auto-enable cursor scan when interactive mode is on — many React apps
  // (Radix, Headless UI) build popovers from plain divs with cursor:pointer.
  // The scan walks both light DOM and any open shadow roots it encounters,
  // emitting Playwright-compatible chain selectors (`host >> inner`) when
  // it crosses a shadow boundary.
  const wantCursor = opts.cursorInteractive || opts.interactive;
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
        let c = 1;
        for (const elem of cursorElements) {
          const ref = `c${c++}`;
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

  if (output.length === 0) {
    return { text: '(no interactive elements found)', refs, count: 0 };
  }
  return { text: output.join('\n'), refs, count: refs.size };
}
