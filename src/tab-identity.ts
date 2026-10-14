/**
 * Tab identity: daemon-minted tab ids and the `#n` / id / bare-integer
 * resolver behind `ghax tab`, `ghax bridge control --tab-id`, and every
 * refusal that names a tab. See docs/design/plan/11-multi-browser.md
 * ("Tab identity").
 *
 * Chrome tab ids are per-browser integers, so two browsers can both have a
 * tab 42. On the bridge a tab id is therefore always `<alias>:<chromeTabId>`,
 * where the alias names the browser instance: `<brand>-<profile slug>` from the
 * popup's "Profile name" (`edge-work`), else `<brand>-<first 6 of instanceId>`. The format already carries
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
  /**
   * Per-browser-session nonce of the extension that answered (bridge only).
   * Chrome tab ids restart with the browser, so a `#n` row from before a
   * restart must not resolve against a different tab that reuses the number.
   * Undefined for extensions predating it.
   */
  nonce?: string;
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
 * Profile / brand text from a hello, cleaned once at intake: control, format
 * (zero-width, bidi override) and line-separator characters are dropped so a
 * name can never forge a line of output, then capped at 40 code points.
 */
export function sanitizeLabel(raw: string): string {
  return Array.from(raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()).slice(0, 40).join('').trim();
}

function idPrefix(instanceId: string, len: number): string {
  return instanceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, len).toLowerCase() || 'unknown';
}

function baseAlias(i: InstanceIdentity): string {
  const brand = slugAlias(i.browser) || 'browser';
  const slug = slugAlias(i.profile);
  return `${brand}-${slug || short6(i.instanceId)}`;
}

/**
 * Aliases for every instance in `all`, unique across the set.
 *
 * `<brand>-<profile slug>` (else `<brand>-<short6>`). Any alias that more than
 * one instance would take gets `-<short6>` appended, and if that still
 * collides (e.g. an unlabelled `edge-abcdef` against a profile literally named
 * "abcdef"), a longer instance-id prefix until it is unique. `pinned` aliases
 * (already handed out to live peers) are kept as-is and reserved.
 */
export function mintAliases(
  all: InstanceIdentity[],
  pinned: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const out = new Map<string, string>();
  const reserved = new Set<string>();
  for (const [id, alias] of pinned) {
    out.set(id, alias);
    reserved.add(alias);
  }
  const free = all.filter((i) => !pinned.has(i.instanceId));
  const level = new Map(free.map((i) => [i.instanceId, 0]));
  const aliasAt = (i: InstanceIdentity): string => {
    const lv = level.get(i.instanceId)!;
    return lv === 0 ? baseAlias(i) : `${baseAlias(i)}-${idPrefix(i.instanceId, 4 + 2 * lv)}`;
  };
  for (let round = 0; round < 40; round++) {
    const counts = new Map<string, number>();
    for (const a of reserved) counts.set(a, 1);
    for (const i of free) {
      const a = aliasAt(i);
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    let dup = false;
    for (const i of free) {
      if ((counts.get(aliasAt(i)) ?? 0) > 1) {
        level.set(i.instanceId, level.get(i.instanceId)! + 1);
        dup = true;
      }
    }
    if (!dup) break;
  }
  for (const i of free) out.set(i.instanceId, aliasAt(i));
  return out;
}

/** The alias for `self` given every other instance the daemon knows. */
export function mintAlias(self: InstanceIdentity, others: InstanceIdentity[] = []): string {
  const all = [self, ...others.filter((o) => o.instanceId !== self.instanceId)];
  return mintAliases(all).get(self.instanceId)!;
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
  who: { alias: string; browser: string; profile: string; nonce?: string },
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
      ...(who.nonce ? { nonce: who.nonce } : {}),
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

/**
 * Why the tab now answering to `row.id` is probably not the one that was
 * listed, or null. Chrome reuses small tab ids after a restart, so the id
 * alone proves nothing: a differing session nonce is conclusive; without a
 * nonce on both sides (older extension) the tab must at least still look like
 * itself, i.e. refuse only when url AND title both changed.
 */
function browserRestarted(row: TabIdentity, now: TabIdentity): string | null {
  if (row.nonce && now.nonce) {
    return row.nonce === now.nonce ? null : 'that browser has restarted since, so its tab numbers were reassigned';
  }
  if (row.url !== now.url && row.title !== now.title) {
    return `tab ${now.id} is now ${JSON.stringify(now.title.slice(0, 60))}, a different page (the browser may have restarted)`;
  }
  return null;
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
    const restarted = browserRestarted(row, now);
    if (restarted) {
      throw new TabResolveError(
        `${sel} was ${describeTab(row)}, but ${restarted}. Run 'ghax tabs' again.`,
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
    if (hits.length === 1) {
      // The last listing showed this number in another browser too: `tabs
      // --browser chrome` then `tab 42` must not quietly drive the bound one.
      const rivals = (last ?? []).filter((t) => t.chromeTabId === n && t.id !== hits[0].id);
      if (rivals.length === 0) return hits[0];
      throw new TabResolveError(
        `tab ${sel} is ambiguous: the last 'ghax tabs' listed it in another browser too. Use the full id or #n:\n${listing([hits[0], ...rivals])}`,
        'TAB_AMBIGUOUS',
      );
    }
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
