/**
 * Automatic profile names for bridge instances.
 *
 * The extension mints a UUID (`ghaxInstanceId`) into its own
 * chrome.storage.local, which the browser keeps as LevelDB files under
 * `<User Data>/<profile dir>/Local Extension Settings/<extension id>/`. Finding
 * the one profile dir whose files contain that UUID tells us which profile the
 * extension runs in, and `Local State` `.profile.info_cache[<dir>].name` is the
 * name the browser shows for it ("DAG Tech"). So an instance gets a real
 * profile name without anyone typing one into the popup.
 *
 * Rules:
 * - Byte search on raw files (`Buffer.indexOf`), never a locale-dependent text
 *   read. `.log` files are plain; `.ldb` blocks may be Snappy-compressed, but a
 *   UUID is stored as a literal run there unless it repeats inside one block,
 *   so a miss on `.ldb` is possible and simply means "no name".
 * - Exactly one profile dir must match across every searched root. Zero or
 *   several is no name ('—' upstream): never a guess.
 * - Only `.name` is read from `Local State`. Never `user_name`, email, or any
 *   other account field.
 * - Only regular files are read (`lstat`, opened O_NOFOLLOW|O_NONBLOCK and
 *   re-checked with `fstat`): a symlink or FIFO planted in a profile dir is
 *   skipped, never followed or blocked on. Every read is size-bounded.
 * - No scan without the extension's own id ([a-p]{32} from hello): walking
 *   every extension's storage of every profile is not worth a name.
 * - Async and off the hello path: the hello binds at once, the name lands
 *   when the scan does. Hits are cached for the daemon's life, misses for
 *   MISS_TTL_MS, keyed on instanceId+brand+extensionId, at most CACHE_MAX.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ProfileMatch {
  /** User Data root the profile lives in. */
  root: string;
  /** Profile directory name ("Profile 1", "Default"). */
  dir: string;
  /** Display name from Local State; '' when it has none. */
  name: string;
}

export interface ProfileLookupOptions {
  /** Brand from hello ("edge", "chrome", ...); '' searches every known root. */
  brand?: string;
  /** chrome.runtime.id from hello; narrows the search to that extension's dir. */
  extensionId?: string;
  /** Override the User Data roots (tests, and GHAX_BROWSER_PROFILE_ROOTS). */
  roots?: string[];
}

/**
 * LevelDB files bigger than this are skipped. A ghax storage file is a few KB;
 * LevelDB rolls `.log` at its 4 MB write buffer and `.ldb` tables are ~2 MB.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** `Local State` is a few hundred KB even with many profiles. */
export const MAX_LOCAL_STATE_BYTES = 8 * 1024 * 1024;
/** How long "no profile found" is remembered before a hello may scan again. */
export const MISS_TTL_MS = 60_000;
/** Cache entries kept; the oldest goes first. */
export const CACHE_MAX = 64;

const EXTENSION_ID = /^[a-p]{32}$/;

const UUIDISH = /^[0-9a-zA-Z-]{16,64}$/;

type Brand = 'edge' | 'chrome' | 'chromium' | 'brave';

/** Brand → User Data roots, relative to the platform's base directory. */
const MAC: Record<Brand, string[]> = {
  edge: ['Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'Microsoft Edge Canary'],
  chrome: ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary'],
  chromium: ['Chromium'],
  brave: ['BraveSoftware/Brave-Browser'],
};
const LINUX: Record<Brand, string[]> = {
  edge: ['microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev'],
  chrome: ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable'],
  chromium: ['chromium'],
  brave: ['BraveSoftware/Brave-Browser'],
};
const WINDOWS: Record<Brand, string[]> = {
  edge: ['Microsoft/Edge/User Data', 'Microsoft/Edge Beta/User Data', 'Microsoft/Edge Dev/User Data', 'Microsoft/Edge SxS/User Data'],
  chrome: ['Google/Chrome/User Data', 'Google/Chrome Beta/User Data', 'Google/Chrome SxS/User Data'],
  chromium: ['Chromium/User Data'],
  brave: ['BraveSoftware/Brave-Browser/User Data'],
};

function brandsFor(brand: string): Brand[] {
  const b = brand.trim().toLowerCase();
  if (b === 'edge' || b === 'chrome' || b === 'chromium' || b === 'brave') return [b];
  return ['edge', 'chrome', 'chromium', 'brave'];
}

/** True under WSL, where the browser usually runs on the Windows side. */
function isWsl(env: NodeJS.ProcessEnv): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Windows `%LOCALAPPDATA%` dirs reachable from WSL (best effort). */
function wslLocalAppData(): string[] {
  const users = '/mnt/c/Users';
  let names: string[] = [];
  try {
    names = fs.readdirSync(users);
  } catch {
    return [];
  }
  return names
    .filter((n) => !['Public', 'Default', 'Default User', 'All Users'].includes(n))
    .map((n) => path.join(users, n, 'AppData', 'Local'))
    .filter((p) => fs.existsSync(p));
}

/** Every User Data root for `brand` on this machine (existing or not). */
export function profileRoots(
  brand = '',
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const override = env.GHAX_BROWSER_PROFILE_ROOTS;
  if (override !== undefined) return override.split(path.delimiter).filter(Boolean);
  const brands = brandsFor(brand);
  const pick = (table: Record<Brand, string[]>) => brands.flatMap((b) => table[b]);
  if (platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return pick(MAC).map((r) => path.join(base, r));
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return pick(WINDOWS).map((r) => path.join(base, r));
  }
  const base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const roots = pick(LINUX).map((r) => path.join(base, r));
  if (platform === 'linux' && isWsl(env)) {
    for (const local of wslLocalAppData()) roots.push(...pick(WINDOWS).map((r) => path.join(local, r)));
  }
  return roots;
}

async function listDir(p: string): Promise<string[]> {
  try {
    return await fsp.readdir(p);
  } catch {
    return [];
  }
}

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * The whole file, or null when it is not a regular file (symlink, FIFO,
 * device, dir), is bigger than `max`, or can't be read. `lstat` first so a
 * symlink is never followed; O_NOFOLLOW + `fstat` close the swap race.
 */
export async function readRegularFile(file: string, max: number): Promise<Buffer | null> {
  try {
    const st = await fsp.lstat(file);
    if (!st.isFile() || st.size > max) return null;
    const fh = await fsp.open(file, OPEN_FLAGS);
    try {
      const fst = await fh.stat();
      if (!fst.isFile() || fst.size > max) return null;
      const buf = Buffer.alloc(fst.size);
      const { bytesRead } = await fh.read(buf, 0, fst.size, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    // Unreadable or vanished mid-scan (LevelDB compaction): no data.
    return null;
  }
}

/** True when any `.log`/`.ldb` file directly in `dir` contains `needle`. */
async function dirContains(dir: string, needle: Buffer): Promise<boolean> {
  for (const f of await listDir(dir)) {
    if (!f.endsWith('.log') && !f.endsWith('.ldb')) continue;
    const data = await readRegularFile(path.join(dir, f), MAX_FILE_BYTES);
    if (data && data.indexOf(needle) !== -1) return true;
  }
  return false;
}

/** The profile dirs under `root` whose storage for `extensionId` holds `needle`. */
async function matchingDirs(root: string, needle: Buffer, extensionId: string): Promise<string[]> {
  const hits: string[] = [];
  for (const dir of await listDir(root)) {
    if (await dirContains(path.join(root, dir, 'Local Extension Settings', extensionId), needle)) hits.push(dir);
  }
  return hits;
}

/** `Local State` `.profile.info_cache[dir].name`, '' when absent. Reads nothing else. */
export async function readProfileName(root: string, dir: string): Promise<string> {
  const raw = await readRegularFile(path.join(root, 'Local State'), MAX_LOCAL_STATE_BYTES);
  if (!raw) return '';
  try {
    const name = JSON.parse(raw.toString('utf8'))?.profile?.info_cache?.[dir]?.name;
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/**
 * The single profile whose ghax storage holds `instanceId`, or null when none
 * or more than one does, or when there is no valid `extensionId` to narrow
 * the scan to. Uncached; see `lookupProfileName`.
 */
export async function findProfile(instanceId: string, opts: ProfileLookupOptions = {}): Promise<ProfileMatch | null> {
  if (!UUIDISH.test(instanceId)) return null;
  const extensionId = opts.extensionId ?? '';
  if (!EXTENSION_ID.test(extensionId)) return null;
  const roots = opts.roots ?? profileRoots(opts.brand ?? '');
  const needle = Buffer.from(instanceId, 'latin1');
  const found: Array<{ root: string; dir: string }> = [];
  for (const root of roots) {
    const st = await fsp.lstat(path.join(root, 'Local State')).catch(() => null);
    if (!st?.isFile()) continue;
    for (const dir of await matchingDirs(root, needle, extensionId)) found.push({ root, dir });
    if (found.length > 1) return null;
  }
  if (found.length !== 1) return null;
  const [{ root, dir }] = found;
  return { root, dir, name: await readProfileName(root, dir) };
}

interface CacheEntry {
  name: string;
  /** 0 for a hit (kept for the daemon's life), else when the miss expires. */
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string>>();

function cacheKey(instanceId: string, opts: ProfileLookupOptions): string {
  return `${instanceId}\u0000${(opts.brand ?? '').toLowerCase()}\u0000${opts.extensionId ?? ''}`;
}

function cacheSet(key: string, entry: CacheEntry): void {
  cache.delete(key);
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, entry);
}

/**
 * The cached name for one instance without scanning: a string ('' for a
 * remembered miss) when the cache can answer, undefined when a scan is due.
 */
export function cachedProfileName(instanceId: string, opts: ProfileLookupOptions = {}, now = Date.now()): string | undefined {
  const key = cacheKey(instanceId, opts);
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt !== 0 && hit.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return hit.name;
}

/**
 * `findProfile(...).name` for one instance, cached; '' when it can't be
 * pinned to exactly one named profile. Concurrent calls for the same key share
 * one scan.
 */
export function lookupProfileName(instanceId: string, opts: ProfileLookupOptions = {}): Promise<string> {
  const cached = cachedProfileName(instanceId, opts);
  if (cached !== undefined) return Promise.resolve(cached);
  const key = cacheKey(instanceId, opts);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = (async () => {
    let name = '';
    try {
      name = (await findProfile(instanceId, opts))?.name ?? '';
    } catch {
      name = '';
    }
    cacheSet(key, { name, expiresAt: name ? 0 : Date.now() + MISS_TTL_MS });
    return name;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/** Tests only. */
export function clearProfileCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Tests only. */
export function profileCacheSize(): number {
  return cache.size;
}
