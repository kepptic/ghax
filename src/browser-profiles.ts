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
 * - Results (hits and misses) are cached per instanceId for the daemon's life.
 */

import * as fs from 'node:fs';
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

/** Files bigger than this are skipped: a ghax storage file is a few KB. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

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

function listDir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/** True when any `.log`/`.ldb` file directly in `dir` contains `needle`. */
function dirContains(dir: string, needle: Buffer): boolean {
  for (const f of listDir(dir)) {
    if (!f.endsWith('.log') && !f.endsWith('.ldb')) continue;
    const file = path.join(dir, f);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      if (fs.readFileSync(file).indexOf(needle) !== -1) return true;
    } catch {
      // Unreadable or vanished mid-scan (LevelDB compaction): not a match.
    }
  }
  return false;
}

/** The profile dirs under `root` whose extension storage holds `needle`. */
function matchingDirs(root: string, needle: Buffer, extensionId: string): string[] {
  const hits: string[] = [];
  for (const dir of listDir(root)) {
    const settings = path.join(root, dir, 'Local Extension Settings');
    const exts = extensionId ? [extensionId] : listDir(settings);
    if (exts.some((ext) => dirContains(path.join(settings, ext), needle))) hits.push(dir);
  }
  return hits;
}

/** `Local State` `.profile.info_cache[dir].name`, '' when absent. Reads nothing else. */
export function readProfileName(root: string, dir: string): string {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'));
    const name = state?.profile?.info_cache?.[dir]?.name;
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/**
 * The single profile whose ghax storage holds `instanceId`, or null when none
 * or more than one does. Uncached; see `lookupProfileName`.
 */
export function findProfile(instanceId: string, opts: ProfileLookupOptions = {}): ProfileMatch | null {
  if (!UUIDISH.test(instanceId)) return null;
  const extensionId = opts.extensionId && /^[a-p]{32}$/.test(opts.extensionId) ? opts.extensionId : '';
  const roots = opts.roots ?? profileRoots(opts.brand ?? '');
  const needle = Buffer.from(instanceId, 'latin1');
  const found: Array<{ root: string; dir: string }> = [];
  for (const root of roots) {
    if (!fs.existsSync(path.join(root, 'Local State'))) continue;
    for (const dir of matchingDirs(root, needle, extensionId)) found.push({ root, dir });
    if (found.length > 1) return null;
  }
  if (found.length !== 1) return null;
  const [{ root, dir }] = found;
  return { root, dir, name: readProfileName(root, dir) };
}

const cache = new Map<string, ProfileMatch | null>();

/**
 * Cached `findProfile(...).name` for one instance; '' when it can't be pinned
 * to exactly one named profile. Synchronous on purpose: it runs at hello, and
 * the tab-id alias minted from it must not flip a moment later.
 */
export function lookupProfileName(instanceId: string, opts: ProfileLookupOptions = {}): string {
  if (!cache.has(instanceId)) {
    let hit: ProfileMatch | null = null;
    try {
      hit = findProfile(instanceId, opts);
    } catch {
      hit = null;
    }
    cache.set(instanceId, hit);
  }
  return cache.get(instanceId)?.name ?? '';
}

/** Tests only. */
export function clearProfileCache(): void {
  cache.clear();
}
