/**
 * In-page actionability check, run right before ghax acts on an element.
 *
 * Why: over the bridge, `click @e3` used to scroll, read the box model, and
 * dispatch a mouse event at the centre, whatever was there. A cookie banner,
 * a spinner overlay, or a disabled button all "succeeded" silently. The
 * logic below is a port of Playwright's own rules (injectedScript.ts
 * `retarget` + `expectHitTarget`, roleUtils.ts `getAriaDisabled`), not its
 * code, so both transports refuse the same things for the same reasons.
 *
 * SELF-CONTAINED ON PURPOSE. This function is shipped to the page with
 * `Function.prototype.toString()`: over the bridge as a
 * `Runtime.callFunctionOn` declaration, and on the Playwright path through
 * `locator.evaluate(actionability, ...)`, which serialises it the same way.
 * It must not reference anything outside its own body (no imports, no
 * module constants). The daemon bundle is not minified, so toString() is
 * the source as written.
 *
 * Kinds:
 *   click    connected, not disabled/inert, visible (no opacity check;
 *            display:contents via its children), scrolled into view, centre
 *            inside the viewport, and the hit test at the centre lands on
 *            the (retargeted) element, re-tried once after centring (sticky
 *            headers).
 *   fill     connected, not disabled/inert, not read-only. No visibility or
 *            hit test: Monaco and hidden-but-scriptable inputs must work.
 *   upload   connected only.
 *   precheck inherited aria-disabled / inert only. The Playwright path runs
 *            this before locator.click(); Playwright checks the rest itself
 *            but would wait out its whole timeout on these two.
 * `force` skips everything except "connected" and, for click, the rect.
 */

export type ActionabilityKind = 'click' | 'fill' | 'upload' | 'precheck';

export type ActionabilityReason =
  | 'detached' | 'disabled' | 'inert' | 'readonly' | 'hidden' | 'offscreen' | 'covered';

export interface ActionabilityResult {
  ok: boolean;
  reason?: ActionabilityReason;
  /** Short description of the element on top, for `covered`. */
  coveredBy?: string;
  /** Set when a click was retargeted to an enclosing button/link. */
  retargeted?: string;
  /** Click point (viewport CSS px) and the element's rect, click only. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export function actionability(
  node: Node,
  arg: { kind: ActionabilityKind; force: boolean },
): ActionabilityResult {
  const kind = arg.kind;
  const force = Boolean(arg.force);
  const ARIA_DISABLED_ROLES = ['application', 'button', 'composite', 'gridcell', 'group', 'input', 'link',
    'menuitem', 'scrollbar', 'separator', 'tab', 'checkbox', 'columnheader', 'combobox', 'grid', 'listbox',
    'menu', 'menubar', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup', 'row',
    'rowheader', 'searchbox', 'select', 'slider', 'spinbutton', 'switch', 'tablist', 'textbox', 'toolbar',
    'tree', 'treegrid', 'treeitem'];

  const parentOrHost = (n: Node): Element | null => {
    if ((n as Element).parentElement) return (n as Element).parentElement;
    const p = n.parentNode;
    return p && p.nodeType === 11 ? (p as ShadowRoot).host : null;
  };
  const describe = (n: Element | null): string => {
    if (!n) return 'document';
    let s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += '.' + cls.join('.');
    const role = n.getAttribute('role');
    if (role) s += ' role=' + role;
    const text = ((n as HTMLElement).innerText || n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (text) s += ' "' + text + '"';
    return s;
  };
  // Simplified implicit-role table: only what decides whether aria-disabled
  // applies (Playwright's full getAriaRole is far larger).
  const roleOf = (e: Element): string => {
    const explicit = (e.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit) return explicit.toLowerCase();
    const t = e.tagName;
    if (t === 'A' || t === 'AREA') return e.hasAttribute('href') ? 'link' : '';
    if (t === 'BUTTON') return 'button';
    if (t === 'INPUT') {
      const ty = ((e as HTMLInputElement).type || 'text').toLowerCase();
      if (ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'image') return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'range') return 'slider';
      if (ty === 'number') return 'spinbutton';
      if (ty === 'hidden') return '';
      if (e.hasAttribute('list')) return 'combobox';
      return ty === 'search' ? 'searchbox' : 'textbox';
    }
    if (t === 'SELECT') {
      const sel = e as HTMLSelectElement;
      return sel.multiple || sel.size > 1 ? 'listbox' : 'combobox';
    }
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'OPTION') return 'option';
    if (t === 'FIELDSET' || t === 'OPTGROUP' || t === 'DETAILS') return 'group';
    if (t === 'TR') return 'row';
    if (t === 'TH') return 'columnheader';
    return '';
  };
  const inDisabledFieldset = (e: Element): boolean => {
    const fs = e.closest('fieldset[disabled]');
    if (!fs) return false;
    const legend = fs.querySelector(':scope > legend');
    return !legend || !legend.contains(e);
  };
  const nativelyDisabled = (e: Element): boolean =>
    ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'].includes(e.tagName)
    && (e.hasAttribute('disabled')
      || (e.tagName === 'OPTION' && !!e.closest('optgroup[disabled]'))
      || inDisabledFieldset(e));
  // aria-disabled applies to descendants and crosses shadow boundaries; the
  // nearest explicit "true"/"false" wins.
  const ariaDisabled = (e: Element): boolean => {
    if (!ARIA_DISABLED_ROLES.includes(roleOf(e))) return false;
    for (let n: Element | null = e; n; n = parentOrHost(n)) {
      const a = (n.getAttribute('aria-disabled') || '').toLowerCase();
      if (a === 'true') return true;
      if (a === 'false') return false;
    }
    return false;
  };
  const inert = (e: Element): boolean => {
    for (let n: Element | null = e; n; n = parentOrHost(n)) if (n.hasAttribute('inert')) return true;
    return false;
  };

  // Text nodes (AX StaticText refs) act through their parent element.
  const el: Element | null = node && node.nodeType === 1 ? node as Element : (node ? node.parentElement : null);
  if (!el || !el.isConnected) return { ok: false, reason: 'detached' };

  if (kind === 'precheck') {
    if (force) return { ok: true };
    if (inert(el)) return { ok: false, reason: 'inert' };
    if (ariaDisabled(el)) return { ok: false, reason: 'disabled' };
    return { ok: true };
  }
  if (kind === 'upload') return { ok: true };

  // Playwright's 'button-link' retarget: a click on an icon inside a button
  // must hit-test against the button.
  const editable = el.matches('input, textarea, select') || (el as HTMLElement).isContentEditable;
  const target = kind === 'click' && !editable
    ? (el.closest('button, [role=button], a, [role=link]') || el)
    : el;
  const retargeted = target !== el ? describe(target) : undefined;
  const fail = (reason: ActionabilityReason, extra: Partial<ActionabilityResult> = {}): ActionabilityResult =>
    ({ ok: false, reason, ...(retargeted ? { retargeted } : {}), ...extra });

  if (!force) {
    if (inert(el)) return fail('inert');
    if (nativelyDisabled(el) || ariaDisabled(el) || nativelyDisabled(target) || ariaDisabled(target)) {
      return fail('disabled');
    }
    if (kind === 'fill') {
      const ro = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
        ? el.hasAttribute('readonly')
        : el.getAttribute('aria-readonly') === 'true';
      if (ro) return fail('readonly');
    }
  }
  if (kind === 'fill') return { ok: true };

  // ─── click ───
  // Visibility per Playwright's computeBox / computeElementStyleVisibilityVisible:
  // checkVisibility() WITHOUT checkOpacity (an opacity:0 native checkbox
  // under a styled label is a normal click target), and display:contents
  // counts as visible when any child renders.
  const textRect = (t: Node): DOMRect | null => {
    const range = document.createRange();
    range.selectNode(t);
    const r = range.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };
  const boxOf = (e: Element): DOMRect | null => {
    if (getComputedStyle(e).display === 'contents') {
      // Not rendered itself: its first rendered child stands in for it.
      for (let c = e.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1) {
          const r = boxOf(c as Element);
          if (r) return r;
        } else if (c.nodeType === 3) {
          const r = textRect(c);
          if (r) return r;
        }
      }
      return null;
    }
    const cv = (e as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    const styleVisible = typeof cv === 'function'
      ? cv.call(e, { checkVisibilityCSS: true })
      : getComputedStyle(e).visibility === 'visible';
    if (!styleVisible) return null;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };
  const inViewport = (r: DOMRect): boolean => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
  };
  const scrollToCentre = () => {
    const anchor = getComputedStyle(el).display === 'contents'
      ? (el.firstElementChild ?? el)
      : el;
    anchor.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  };
  let rect = boxOf(el);
  if (!rect) {
    if (!force) return fail('hidden');
    rect = el.getBoundingClientRect();
  }
  let scrolled = false;
  if (!inViewport(rect)) {
    scrollToCentre();
    scrolled = true;
    rect = boxOf(el) ?? el.getBoundingClientRect();
  }
  if (rect.width <= 0 || rect.height <= 0) return fail('hidden');
  const pointOf = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height });
  let point = pointOf(rect);
  if (force) return { ok: true, ...point, ...(retargeted ? { retargeted } : {}) };
  if (!inViewport(rect)) return fail('offscreen', point);

  // Hit test, per expectHitTarget: walk the chain of roots from the target up
  // to the document, then from the document down, each level's innermost hit
  // must be the next level's shadow host; the last must be the target or a
  // descendant of it. Returns null when the hit lands, else the coverer.
  const hitTest = (x: number, y: number): string | null => {
    const roots: Array<Document | ShadowRoot> = [];
    for (let p: Element | null = target; p;) {
      const r = p.getRootNode();
      if (r.nodeType !== 9 && r.nodeType !== 11) break;
      roots.push(r as Document | ShadowRoot);
      if (r.nodeType === 9) break;
      p = (r as ShadowRoot).host;
    }
    let hit: Element | undefined;
    for (let i = roots.length - 1; i >= 0; i--) {
      const root = roots[i];
      const els = root.elementsFromPoint(x, y);
      const single = root.elementFromPoint(x, y);
      // Chromium's elementsFromPoint misses a display:contents innermost hit.
      if (single && els[0] && parentOrHost(single) === els[0] && getComputedStyle(single).display === 'contents') {
        els.unshift(single);
      }
      const inner = els[0];
      if (!inner) break;
      hit = inner;
      if (i && inner !== (roots[i - 1] as ShadowRoot).host) break;
    }
    const chain: Element[] = [];
    let h: Element | null | undefined = hit;
    while (h && h !== target) {
      chain.push(h);
      h = (h as Element & { assignedSlot?: Element | null }).assignedSlot || parentOrHost(h);
    }
    return h === target ? null : describe(chain[0] || document.documentElement);
  };
  let coveredBy = hitTest(point.x, point.y);
  // A sticky header or footer covers an element near the viewport edge. Like
  // Playwright's scroll retries, bring it to the centre once and look again
  // before refusing.
  if (coveredBy && !scrolled) {
    scrollToCentre();
    const again = boxOf(el);
    if (again && inViewport(again)) {
      point = pointOf(again);
      coveredBy = hitTest(point.x, point.y);
    }
  }
  if (!coveredBy) return { ok: true, ...point, ...(retargeted ? { retargeted } : {}) };
  return fail('covered', { ...point, coveredBy });
}
