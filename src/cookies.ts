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

export interface CookieBackend {
  /** URL of the active tab. */
  activeUrl(): Promise<string>;
  /** Cookies applicable to `urls`, or the whole profile when null. */
  list(urls: string[] | null): Promise<Cookie[]>;
  /** Delete exactly the cookie with this name/domain/path. */
  remove(c: { name: string; domain: string; path: string }): Promise<void>;
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

/**
 * Delete one cookie by name. Scope is the same as listing (active tab by
 * default, whole profile with --all/--domain). --domain here must equal the
 * cookie's domain (leading dot ignored) so a short substring can't widen the
 * match; --path must equal exactly. More than one match refuses and lists
 * name/domain/path only.
 */
export async function deleteCookie(
  be: CookieBackend,
  name: string,
  opts: CookieOpts,
): Promise<{ deleted: Array<{ name: string; domain: string; path: string }> }> {
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
    const lines = cookies.map((c) => `  ${c.name}  domain=${c.domain}  path=${c.path}`).join('\n');
    throw new CookieDeleteError(
      `"${name}" matches ${cookies.length} cookies; refusing to guess. Re-run with --domain and/or --path:\n${lines}`,
    );
  }
  const target = { name: cookies[0].name, domain: cookies[0].domain, path: cookies[0].path };
  await be.remove(target);
  return { deleted: [target] };
}
