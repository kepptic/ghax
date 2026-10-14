/**
 * Cookie read/delete logic shared by the CDP (Playwright) and bridge
 * (chrome.debugger) transports. Transport-specific code only supplies a
 * `CookieBackend`; scoping, redaction, --has and the exactly-one delete rule
 * live here so both transports behave identically.
 *
 * Secrets: cookie values are auth tokens. Nothing in this file puts a value
 * into an error message or a delete report; values only leave through
 * `listCookies` when the caller passes --values.
 */

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
  [k: string]: unknown;
}

/** What a delete sends: the triple, plus partitionKey for a CHIPS cookie. */
export interface CookieTarget {
  name: string;
  domain: string;
  path: string;
  partitionKey?: unknown;
}

export interface CookieBackend {
  /** URL of the active tab. */
  activeUrl(): Promise<string>;
  /** Cookies applicable to `urls`, or the whole profile when null. */
  list(urls: string[] | null): Promise<Cookie[]>;
  /** Delete exactly the cookie with this name/domain/path. */
  remove(c: CookieTarget): Promise<void>;
}

export interface CookieOpts {
  values?: unknown;
  all?: unknown;
  domain?: unknown;
  url?: unknown;
  has?: unknown;
  path?: unknown;
}

/** CDP Network.Cookie → the Playwright cookie shape the CLI already prints. */
export function fromCdpCookie(c: Record<string, unknown>): Cookie {
  const expires = typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1;
  const out: Cookie = {
    name: String(c.name ?? ''),
    value: String(c.value ?? ''),
    domain: String(c.domain ?? ''),
    path: String(c.path ?? '/'),
    expires,
    httpOnly: c.httpOnly === true,
    secure: c.secure === true,
  };
  if (typeof c.sameSite === 'string') out.sameSite = c.sameSite;
  // Identity fields the delete path needs: Chromium's delete filter ignores
  // scheme/port, and a partitioned cookie is invisible to a delete that
  // carries no partitionKey.
  if (c.partitionKey !== undefined && c.partitionKey !== null) out.partitionKey = c.partitionKey;
  if (typeof c.sourceScheme === 'string') out.sourceScheme = c.sourceScheme;
  if (typeof c.sourcePort === 'number') out.sourcePort = c.sourcePort;
  return out;
}

export function redactCookie(cookie: Cookie, showValues: boolean): Record<string, unknown> {
  if (showValues) return { ...cookie };
  const { value, ...rest } = cookie;
  const len = typeof value === 'string' ? value.length : 0;
  return { ...rest, value: `<redacted, ${len} chars>` };
}

async function scoped(be: CookieBackend, opts: CookieOpts): Promise<Cookie[]> {
  const domainFilter = typeof opts.domain === 'string' ? opts.domain.toLowerCase() : undefined;
  const urlFilter = typeof opts.url === 'string' ? opts.url : undefined;
  let cookies: Cookie[];
  if (urlFilter) cookies = await be.list([urlFilter]);
  else if (opts.all === true || domainFilter) cookies = await be.list(null);
  else cookies = await be.list([await be.activeUrl()]);
  if (domainFilter) {
    cookies = cookies.filter((c) => c.domain.replace(/^\./, '').toLowerCase().includes(domainFilter));
  }
  return cookies;
}

export async function listCookies(be: CookieBackend, opts: CookieOpts): Promise<unknown> {
  const cookies = await scoped(be, opts);
  if (typeof opts.has === 'string') {
    return { name: opts.has, exists: cookies.some((c) => c.name === opts.has) };
  }
  return cookies.map((c) => redactCookie(c, opts.values === true));
}

export class CookieDeleteError extends Error {}
/** The browser accepted the delete but the cookie state says otherwise (exit 4). */
export class CookieVerifyError extends Error {}

const hasPartition = (c: Cookie): boolean => c.partitionKey !== undefined && c.partitionKey !== null;
const samePartition = (a: Cookie, b: Cookie): boolean =>
  hasPartition(a) === hasPartition(b) && (!hasPartition(a) || JSON.stringify(a.partitionKey) === JSON.stringify(b.partitionKey));
const sameTriple = (a: Cookie, b: Cookie): boolean => a.name === b.name && a.domain === b.domain && a.path === b.path;
const sameCookie = (a: Cookie, b: Cookie): boolean =>
  sameTriple(a, b) && samePartition(a, b) && a.sourceScheme === b.sourceScheme && a.sourcePort === b.sourcePort;

/** Describe a cookie for an error message: identity only, never the value. */
function describe(c: Cookie): string {
  const part = hasPartition(c) ? `  partition=${JSON.stringify(c.partitionKey)}` : '';
  return `  ${c.name}  domain=${c.domain}  path=${c.path}  scheme=${c.sourceScheme ?? '?'}  port=${c.sourcePort ?? '?'}${part}`;
}

/**
 * Delete one cookie by name. Scope is the same as listing (active tab by
 * default, whole profile with --all/--domain). --domain here must equal the
 * cookie's domain (leading dot ignored) so a short substring can't widen the
 * match; --path must equal exactly. More than one match refuses and lists
 * name/domain/path only.
 *
 * The browser's delete filter is only name+domain+path(+partitionKey), so
 * after narrowing to one target we re-read the whole profile: if a sibling
 * with the same triple exists (e.g. http and https origin-bound cookies) the
 * delete cannot be exact and we refuse. After deleting we re-read again and
 * only report success if the target is really gone.
 */
export async function deleteCookie(
  be: CookieBackend,
  name: string,
  opts: CookieOpts,
): Promise<{ deleted: Array<{ name: string; domain: string; path: string }>; alsoRemoved?: string[] }> {
  if (!name) throw new CookieDeleteError('Usage: cookies delete <name> [--domain <d>] [--url <u>] [--path <p>]');
  const hasDomain = typeof opts.domain === 'string';
  const domainWant = hasDomain ? String(opts.domain).replace(/^\./, '').toLowerCase() : '';
  // Scope with the domain filter off: we apply our stricter equality below.
  let cookies = await scoped(be, { ...opts, domain: undefined, all: hasDomain ? true : opts.all });
  cookies = cookies.filter((c) => c.name === name);
  if (hasDomain) cookies = cookies.filter((c) => c.domain.replace(/^\./, '').toLowerCase() === domainWant);
  if (typeof opts.path === 'string') cookies = cookies.filter((c) => c.path === opts.path);

  if (cookies.length === 0) {
    throw new CookieDeleteError(
      `no cookie named "${name}" in scope. Use \`ghax cookies --all\` to see names, or widen with --all/--domain/--url.`,
    );
  }
  if (cookies.length > 1) {
    const lines = cookies.map(describe).join('\n');
    throw new CookieDeleteError(
      `"${name}" matches ${cookies.length} cookies; refusing to guess. Re-run with --domain and/or --path:\n${lines}`,
    );
  }
  const picked = cookies[0];

  // Collision check against the FULL profile, not the scoped view. A target
  // without a partitionKey collides with anything sharing its triple (a
  // delete with no key may sweep partitions); a partitioned target only with
  // siblings in the same partition, since the key makes the delete exact there.
  const before = await be.list(null);
  const siblings = before.filter((c) => sameTriple(c, picked) && (hasPartition(picked) ? samePartition(c, picked) : true));
  if (siblings.length > 1) {
    throw new CookieDeleteError(
      `"${name}" at domain=${picked.domain} path=${picked.path} exists ${siblings.length} times (scheme/port/partition differ), ` +
        `and the browser can only delete by name+domain+path, so it cannot delete just one of them. Nothing was deleted:\n${siblings.map(describe).join('\n')}`,
    );
  }

  const target: CookieTarget = { name: picked.name, domain: picked.domain, path: picked.path };
  if (hasPartition(picked)) target.partitionKey = picked.partitionKey;
  await be.remove(target);

  const after = await be.list(null);
  if (after.some((c) => sameCookie(c, picked))) {
    throw new CookieVerifyError(
      `browser did not delete "${name}" (domain=${picked.domain} path=${picked.path}${hasPartition(picked) ? ' partitioned' : ''}); it is still present after the delete call.`,
    );
  }
  const collateral = before.filter((c) => !sameCookie(c, picked) && sameTriple(c, picked) && !after.some((a) => sameCookie(a, c)));
  const out: { deleted: Array<{ name: string; domain: string; path: string }>; alsoRemoved?: string[] } = {
    deleted: [{ name: picked.name, domain: picked.domain, path: picked.path }],
  };
  if (collateral.length) out.alsoRemoved = collateral.map((c) => describe(c).trim());
  return out;
}
