/**
 * Tab identity: daemon-minted tab ids and the `#n` / id / bare-integer
 * resolver behind `ghax tab`, `ghax bridge control --tab-id`, and every
 * refusal that names a tab. See docs/design/plan/11-multi-browser.md
 * ("Tab identity").
 *
 * Chrome tab ids are per-browser integers, so two browsers can both have a
 * tab 42. On the bridge a tab id is therefore always `<alias>:<chromeTabId>`,
 * where the alias names the browser instance: the popup's "Profile name"
 * slugged, else `<brand>-<first 6 of instanceId>`. The format already carries
 * the browser, so binding several browsers at once (phase 3) needs no change
 * to it. On the CDP transport the id stays Playwright's target id.
 *
 * Pure functions only, so the sims can test them without a daemon.
 */

/** One row of `ghax tabs`, both transports. */
export interface TabIdentity {
  /** 1-based position in the listing; what `#n` refers to. */
  index: number;
  /** `<alias>:<chromeTabId>` on the bridge, the CDP target id otherwise. */
  id: string;
  /** Chrome's own tab id (bridge only; null on CDP). */
  chromeTabId: number | null;
  /** Display brand: "Edge", "Chrome", "Chromium". */
  browser: string;
  /** Popup "Profile name", or "—" when unset / unknowable (CDP). */
  profile: string;
  windowId: number | null;
  title: string;
  url: string;
  /** True for THIS daemon's controlled / active tab. */
  active: boolean;
  /** Bridge port of the agent driving the tab, null if free. Bridge only. */
  controlledBy?: number | null;
}

/** What the alias is minted from. */
export interface InstanceIdentity {
  instanceId: string;
  browser: string;
  /** User-set profile name; '' when unset or the extension predates it. */
  profile: string;
}

export const NO_PROFILE = '—';

/** "work laptop!" → "work-laptop". '' when nothing usable is left. */
export function slugAlias(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
}

function short6(instanceId: string): string {
  return instanceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase() || 'unknown';
}

/**
 * The alias for `self`. `others` are every other instance the daemon knows:
 * when two of them slug to the same profile name, both get the instance
 * suffix so the ids stay unique, and the user is told to rename one.
 */
export function mintAlias(self: InstanceIdentity, others: InstanceIdentity[] = []): string {
  const slug = slugAlias(self.profile);
  const brand = slugAlias(self.browser) || 'browser';
  if (!slug) return `${brand}-${short6(self.instanceId)}`;
  const clash = others.some((o) => o.instanceId !== self.instanceId && slugAlias(o.profile) === slug);
  return clash ? `${slug}-${short6(self.instanceId)}` : slug;
}

export function composeTabId(alias: string, chromeTabId: number): string {
  return `${alias}:${chromeTabId}`;
}

/** "edge" → "Edge". Unknown brands are capitalised as-is. */
export function displayBrand(browser: string): string {
  const b = browser.trim().toLowerCase();
  if (!b) return 'Browser';
  if (b === 'edge' || b === 'msedge') return 'Edge';
  if (b === 'chrome') return 'Chrome';
  if (b === 'chromium') return 'Chromium';
  return b.charAt(0).toUpperCase() + b.slice(1);
}

/** One tab as the extension's `list-tabs` ack reports it (fields optional on old builds). */
export interface RawBridgeTab {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  active?: unknown;
  controlledBy?: unknown;
  windowId?: unknown;
}

/**
 * `list-tabs` rows → identity rows, ids minted with the answering instance's
 * alias. `who.browser` is the display brand, `who.profile` '' when unset.
 */
export function bridgeRowsToIdentities(
  rows: unknown[],
  who: { alias: string; browser: string; profile: string },
): TabIdentity[] {
  return rows
    .filter((v): v is RawBridgeTab & { id: number } => typeof (v as RawBridgeTab)?.id === 'number')
    .map((tab, i) => ({
      index: i + 1,
      id: composeTabId(who.alias, tab.id),
      chromeTabId: tab.id,
      browser: who.browser,
      profile: who.profile || NO_PROFILE,
      // Absent from extensions predating tab identity.
      windowId: typeof tab.windowId === 'number' ? tab.windowId : null,
      title: typeof tab.title === 'string' ? tab.title : '',
      url: typeof tab.url === 'string' ? tab.url : '',
      active: Boolean(tab.active),
      // Absent from pre-v0.3 extensions, which knew of only one agent.
      controlledBy: typeof tab.controlledBy === 'number' ? tab.controlledBy : null,
    }));
}

/** `#3 work:42 "Bank feeds" (Edge · Work)` — the form every refusal uses. */
export function describeTab(t: TabIdentity): string {
  const title = JSON.stringify((t.title || '').slice(0, 60));
  return `#${t.index} ${t.id} ${title} (${t.browser} · ${t.profile})`;
}

/** One `ghax tabs` text line. */
export function formatTabLine(t: TabIdentity): string {
  const parts = [`#${t.index}`, t.id, JSON.stringify(t.title || ''), `${t.browser} · ${t.profile}`];
  if (t.controlledBy !== undefined) {
    parts.push(`controlledBy=${t.controlledBy === null ? 'none' : `:${t.controlledBy}`}`);
  }
  if (t.active) parts.push('active');
  return parts.join('  ');
}

export class TabResolveError extends Error {
  constructor(message: string, public readonly code: 'TAB_NOT_FOUND' | 'TAB_AMBIGUOUS' | 'TAB_VANISHED' | 'TAB_NO_LISTING') {
    super(message);
  }
}

/** `work:42` → `work`; null for ids without an alias (CDP target ids). */
export function aliasOfId(id: string): string | null {
  const colon = id.lastIndexOf(':');
  return colon > 0 && /^\d+$/.test(id.slice(colon + 1)) ? id.slice(0, colon) : null;
}

/** True when `id` names a browser none of `current`'s tabs belong to. */
function inOtherBrowser(id: string, current: TabIdentity[]): boolean {
  const alias = aliasOfId(id);
  if (alias === null || current.length === 0) return false;
  return !current.some((t) => aliasOfId(t.id) === alias);
}

function otherBrowserError(sel: string, what: string, alias: string): TabResolveError {
  return new TabResolveError(
    `${sel}: ${what} is in another browser (${alias}), not the one this daemon drives. `
    + `Run 'ghax bridge use ${alias}' first, or 'ghax tabs' for this browser's tabs.`,
    'TAB_NOT_FOUND',
  );
}

function listing(tabs: TabIdentity[]): string {
  return tabs.map((t) => `  ${describeTab(t)}`).join('\n');
}

/**
 * Resolve a user's tab selector against the CURRENT tab list.
 *
 *   `#n`       → row n of `last` (the previous `ghax tabs`), then the same id
 *                in `current`. Refused when there was no listing, n is out of
 *                range, or that tab has closed since (never re-pointed at
 *                whatever now sits in row n).
 *   full id    → exact match in `current`.
 *   bare `42`  → only when exactly one tab has chromeTabId 42; 0 or >1 is
 *                refused, listing every match with its full identity.
 *
 * Never takes [0] of several (target-verification rule).
 */
export function resolveTabSelector(
  selector: string,
  current: TabIdentity[],
  last: TabIdentity[] | null,
): TabIdentity {
  const sel = selector.trim();
  if (!sel) throw new TabResolveError('Usage: tab <#n | id | chrome-tab-id>', 'TAB_NOT_FOUND');

  const hash = /^#(\d+)$/.exec(sel);
  if (hash) {
    const n = Number(hash[1]);
    if (!last) {
      throw new TabResolveError(`${sel}: no tab listing yet — run 'ghax tabs' first, then use its #n`, 'TAB_NO_LISTING');
    }
    const row = last.find((t) => t.index === n);
    if (!row) {
      throw new TabResolveError(
        `${sel}: the last 'ghax tabs' listed ${last.length} tab(s); there is no #${n}. Run 'ghax tabs' again.`,
        'TAB_NOT_FOUND',
      );
    }
    const now = current.find((t) => t.id === row.id);
    if (!now && inOtherBrowser(row.id, current)) {
      throw otherBrowserError(sel, describeTab(row), aliasOfId(row.id)!);
    }
    if (!now) {
      throw new TabResolveError(
        `${sel} was ${describeTab(row)}, which has closed since the last 'ghax tabs'. Run 'ghax tabs' again.`,
        'TAB_VANISHED',
      );
    }
    return { ...now, index: row.index };
  }

  const exact = current.find((t) => t.id === sel);
  if (exact) return exact;

  if (/^\d+$/.test(sel)) {
    const n = Number(sel);
    const hits = current.filter((t) => t.chromeTabId === n);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new TabResolveError(
        `tab ${sel} is ambiguous: ${hits.length} tabs have that id. Use the full id or #n:\n${listing(hits)}`,
        'TAB_AMBIGUOUS',
      );
    }
  }

  // A full id for a browser this daemon is not driving: say whose it is.
  if (inOtherBrowser(sel, current)) throw otherBrowserError(sel, `tab ${sel}`, aliasOfId(sel)!);
  const colon = sel.lastIndexOf(':');
  if (colon > 0) {
    const sameNumber = current.filter((t) => t.chromeTabId === Number(sel.slice(colon + 1)));
    if (sameNumber.length) {
      throw new TabResolveError(
        `No tab with id ${sel}. Tabs with that number here:\n${listing(sameNumber)}`,
        'TAB_NOT_FOUND',
      );
    }
  }
  throw new TabResolveError(`No tab with id ${sel}. Run 'ghax tabs' to list them.`, 'TAB_NOT_FOUND');
}
