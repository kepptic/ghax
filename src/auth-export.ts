/**
 * `ghax auth export`: write a Playwright storageState file from the attached
 * browser so a headless suite can reuse a real SSO login.
 *
 * Shared by both transports. Transport code supplies an `AuthSource`; the
 * allow-list, the Playwright cookie shape, the path checks and the file write
 * live here so CDP and the bridge behave identically.
 *
 * Secrets: the file holds live session tokens. The write happens in the
 * daemon (this module), so values never cross the RPC socket back to the CLI
 * and never reach stdout. The returned report is metadata only (counts, path,
 * earliest expiry). Errors name cookies, origins and paths, never values.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import type { Cookie } from './cookies';

/** A refusal or usage error. The daemon maps it to exit code 2. */
export class AuthExportError extends Error {}

export interface StorageItem {
  name: string;
  value: string;
}

export interface AuthSource {
  /** Every cookie in the profile (the allow-list is applied here, not there). */
  cookies(): Promise<Cookie[]>;
  /**
   * localStorage of a tab that is ALREADY at `origin`. Must never navigate;
   * throws AuthExportError when no such tab is open.
   */
  localStorage(origin: string): Promise<StorageItem[]>;
}

export interface AuthExportOpts {
  out?: unknown;
  domain?: unknown;
  origin?: unknown;
  force?: unknown;
}

export interface AuthExportResult {
  path: string;
  /** Octal file mode; omitted on Windows, where chmod has no meaning. */
  mode?: string;
  cookies: number;
  cookiesByDomain: Record<string, number>;
  partitionedCookies: number;
  sessionCookies: number;
  earliestExpiry: string | null;
  origins: number;
  localStorageKeys: number;
}

const USAGE = 'Usage: ghax auth export --out <path> --domain <d>[,<d>...] [--origin <url>...] [--force]';

/** Comma-separated string, array of them, or absent. */
function listOpt(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return raw.flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
}

/**
 * Normalize --domain into bare lowercase hostnames. A single label like
 * `com` would match half the profile, so only `localhost` may skip the dot.
 */
export function parseDomains(raw: unknown): string[] {
  if (raw === undefined || raw === true || raw === false) {
    throw new AuthExportError(`--domain is required (no export-everything mode). ${USAGE}`);
  }
  const out: string[] = [];
  for (const entry of listOpt(raw)) {
    const d = entry.replace(/^\./, '').toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(d) || d.startsWith('.') || d.endsWith('.') || d.includes('..')) {
      throw new AuthExportError(`--domain "${entry}" is not a hostname (no scheme, port or path).`);
    }
    if (!d.includes('.') && d !== 'localhost') {
      throw new AuthExportError(`--domain "${entry}" is a bare label and would match too much; name the site, e.g. example.com.`);
    }
    if (!out.includes(d)) out.push(d);
  }
  if (out.length === 0) throw new AuthExportError(`--domain is required (no export-everything mode). ${USAGE}`);
  return out;
}

/**
 * The allow-list entry a cookie domain falls under: equal to it, or a
 * subdomain of it. Leading dot ignored. A parent-domain cookie (`.example.com`)
 * is NOT under `app.example.com`; list `example.com` to include it. Returns
 * the most specific entry, or null.
 */
export function matchDomain(cookieDomain: string, allow: string[]): string | null {
  const cd = cookieDomain.replace(/^\./, '').toLowerCase();
  let best: string | null = null;
  for (const d of allow) {
    if ((cd === d || cd.endsWith(`.${d}`)) && (!best || d.length > best.length)) best = d;
  }
  return best;
}

/** --origin values → origins, each inside the --domain allow-list. */
export function parseOrigins(raw: unknown, allow: string[]): string[] {
  const out: string[] = [];
  for (const entry of listOpt(raw === true ? undefined : raw)) {
    let u: URL;
    try {
      u = new URL(entry);
    } catch {
      throw new AuthExportError(`--origin "${entry}" is not a URL (expected e.g. https://app.example.com).`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new AuthExportError(`--origin "${entry}" must be http(s).`);
    }
    if (!matchDomain(u.hostname, allow)) {
      throw new AuthExportError(`--origin "${u.origin}" is outside the --domain allow-list (${allow.join(', ')}).`);
    }
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  if (raw === true) throw new AuthExportError(`--origin needs a value. ${USAGE}`);
  return out;
}

/**
 * Playwright's storageState cookie shape. Playwright 1.63 takes a CHIPS
 * partitionKey as the top-level-site string plus `_crHasCrossSiteAncestor`;
 * the bridge hands back CDP's `{topLevelSite, hasCrossSiteAncestor}` object
 * and the CDP path already has the string, so accept both.
 */
export function toPlaywrightCookie(c: Cookie): Record<string, unknown> {
  const sameSite = c.sameSite === 'Strict' || c.sameSite === 'None' ? c.sameSite : 'Lax';
  const out: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1,
    httpOnly: c.httpOnly === true,
    secure: c.secure === true,
    sameSite,
  };
  const pk = c.partitionKey as unknown;
  if (typeof pk === 'string' && pk) {
    out.partitionKey = pk;
    if (typeof c._crHasCrossSiteAncestor === 'boolean') out._crHasCrossSiteAncestor = c._crHasCrossSiteAncestor;
  } else if (pk && typeof pk === 'object' && typeof (pk as { topLevelSite?: unknown }).topLevelSite === 'string') {
    const o = pk as { topLevelSite: string; hasCrossSiteAncestor?: unknown };
    out.partitionKey = o.topLevelSite;
    if (typeof o.hasCrossSiteAncestor === 'boolean') out._crHasCrossSiteAncestor = o.hasCrossSiteAncestor;
  }
  return out;
}

/**
 * Validate --out and return the real target path. The CLI makes it absolute
 * against the operator's cwd; a relative path here means a caller skipped
 * that, and the daemon's own cwd is the wrong base, so refuse.
 */
export function checkOutPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') {
    throw new AuthExportError(`--out <path> is required; the export is never printed to stdout. ${USAGE}`);
  }
  if (!path.isAbsolute(raw)) throw new AuthExportError(`--out must be an absolute path, got "${raw}".`);
  const base = path.basename(raw);
  if (!base || base === '.' || base === '..') throw new AuthExportError(`--out "${raw}" names a directory, not a file.`);
  let dir: string;
  try {
    dir = fs.realpathSync(path.dirname(raw));
  } catch {
    throw new AuthExportError(`--out directory ${path.dirname(raw)} does not exist.`);
  }
  const target = path.join(dir, base);
  refuseUnignoredGitPath(dir, base, target);
  return target;
}

/**
 * A storageState file inside a git work tree must be gitignored, or one
 * `git add -A` commits a live session. Git runs hardened: a hostile repo's
 * .git/config (core.fsmonitor, hooks) must not execute, and system/global
 * config is ignored. Fails CLOSED: only git's own "not a git repository" means
 * outside a work tree; any other error (dubious ownership, exit 128) refuses.
 * No git binary on PATH means no work tree to commit into, so that passes
 * (documented in SECURITY.md).
 */
function git(dir: string, args: string[]): SpawnSyncReturns<string> {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) delete env[k];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args],
    { env, encoding: 'utf8' },
  );
}

function refuseUnignoredGitPath(dir: string, base: string, target: string): void {
  const inside = git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.error) {
    if ((inside.error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new AuthExportError(`could not run git to check ${target}: ${inside.error.message}`);
  }
  if (inside.status !== 0) {
    if (/not a git repository/i.test(inside.stderr ?? '')) return;
    throw new AuthExportError(
      `git could not check ${target} (exit ${inside.status}: ${(inside.stderr ?? '').trim().split('\n')[0] || 'no message'}); refusing to write.`,
    );
  }
  // Inside a .git dir or bare repo rev-parse prints "false": not a work tree.
  if (inside.stdout.trim() !== 'true') return;
  const ignored = git(dir, ['check-ignore', '-q', '--', base]);
  if (ignored.status === 0) return;
  if (ignored.status === 1) {
    throw new AuthExportError(
      `${target} is inside a git work tree and not gitignored (or already tracked); refusing to write session tokens there. ` +
        'Add it to .gitignore or write outside the repo.',
    );
  }
  throw new AuthExportError(`git check-ignore failed for ${target} (exit ${ignored.status}); refusing to write.`);
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function fsyncDir(dir: string): void {
  // Durability only; some platforms cannot open or fsync a directory.
  try {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best effort */ }
}

/**
 * Write the secret file without ever touching `target` in place. The bytes go
 * to a 0600 O_EXCL|O_NOFOLLOW temp file in the same directory, are fsynced,
 * then published atomically:
 *   - no --force: link(2) tmp -> target, which fails EEXIST rather than replace;
 *   - --force: refuse a symlink or non-regular target, then rename(2) over it.
 * An old file keeps its inode (open readers never see the new secrets), and a
 * failed write only ever unlinks the temp file.
 * `beforeCommit` runs right before publishing (parent re-check after the slow
 * cookie read); if it throws, nothing is published.
 */
export function writeSecretFile(target: string, content: string, force: boolean, beforeCommit?: () => void): void {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
  const tmp = path.join(dir, `.${base}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, content, 'utf8'); // loops until every byte is written
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    beforeCommit?.();
    if (!force) {
      try {
        fs.linkSync(tmp, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new AuthExportError(`${target} already exists; pass --force to overwrite it.`);
        }
        throw err;
      }
      fs.unlinkSync(tmp);
    } else {
      let st: fs.Stats | null = null;
      try {
        st = fs.lstatSync(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (st?.isSymbolicLink()) throw new AuthExportError(`${target} is a symlink; refusing to write through it.`);
      if (st && !st.isFile()) throw new AuthExportError(`${target} exists and is not a regular file.`);
      fs.renameSync(tmp, target);
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(dir);
}

export async function exportAuth(src: AuthSource, opts: AuthExportOpts): Promise<AuthExportResult> {
  // All argument and path checks run before any cookie is read.
  const domains = parseDomains(opts.domain);
  const origins = parseOrigins(opts.origin, domains);
  const target = checkOutPath(opts.out);
  const force = opts.force === true;
  if (!force && fs.existsSync(target)) {
    throw new AuthExportError(`${target} already exists; pass --force to overwrite it.`);
  }

  const byDomain: Record<string, number> = Object.fromEntries(domains.map((d) => [d, 0]));
  const cookies: Array<Record<string, unknown>> = [];
  for (const c of await src.cookies()) {
    const d = matchDomain(c.domain, domains);
    if (!d) continue;
    byDomain[d]++;
    cookies.push(toPlaywrightCookie(c));
  }

  const originsOut: Array<{ origin: string; localStorage: StorageItem[] }> = [];
  for (const origin of origins) {
    const items = await src.localStorage(origin);
    originsOut.push({ origin, localStorage: items.map((i) => ({ name: String(i.name), value: String(i.value) })) });
  }

  // The cookie reads above are slow; the parent (or its git status) may have
  // changed since checkOutPath. Re-check immediately before publishing.
  writeSecretFile(target, `${JSON.stringify({ cookies, origins: originsOut }, null, 2)}\n`, force, () => {
    if (checkOutPath(opts.out) !== target) {
      throw new AuthExportError(`the directory of ${target} changed while exporting; refusing to write.`);
    }
  });

  const expiries = cookies.map((c) => c.expires as number).filter((e) => e > 0);
  return {
    path: target,
    ...(process.platform === 'win32' ? {} : { mode: '0600' }),
    cookies: cookies.length,
    cookiesByDomain: byDomain,
    partitionedCookies: cookies.filter((c) => c.partitionKey !== undefined).length,
    sessionCookies: cookies.length - expiries.length,
    earliestExpiry: expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : null,
    origins: originsOut.length,
    localStorageKeys: originsOut.reduce((n, o) => n + o.localStorage.length, 0),
  };
}

/** Expression that reads localStorage as JSON text (same on both transports). */
export const LOCAL_STORAGE_EXPR = `JSON.stringify((() => {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null) out.push({ name: k, value: localStorage.getItem(k) ?? '' });
  }
  return out;
})())`;

/** Parse LOCAL_STORAGE_EXPR's result. */
export function parseLocalStorage(raw: unknown, origin: string): StorageItem[] {
  if (typeof raw !== 'string') throw new AuthExportError(`could not read localStorage at ${origin}.`);
  return JSON.parse(raw) as StorageItem[];
}

/** Origin of a tab URL, or null for data:, about:, chrome:// and friends. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}
