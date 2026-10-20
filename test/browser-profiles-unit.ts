/**
 * browser-profiles — automatic profile names, offline. Builds a fake User Data
 * dir in a temp folder: no browser needed.
 *
 * Run: tsx test/browser-profiles-unit.ts   (npm run test:browser-profiles)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CACHE_MAX, cachedProfileName, clearProfileCache, findProfile, lookupProfileName, MISS_TTL_MS, profileCacheSize, profileRoots, readRegularFile,
} from '../src/browser-profiles';
import { PeerRegistry } from '../src/bridge-peers';

let n = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  n++;
}

const EXT = 'a'.repeat(32);
const UUID = '3f2a1b9c-1111-4222-8333-444455556666';
const OTHER = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghax-bp-'));

/** A User Data root with `Local State` naming each dir, and ghax storage per `stores`. */
function makeRoot(name: string, names: Record<string, string>, stores: Record<string, string>): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  const info_cache: Record<string, unknown> = {};
  for (const [dir, n2] of Object.entries(names)) info_cache[dir] = { name: n2, user_name: 'secret@example.com' };
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache } }));
  for (const [dir, content] of Object.entries(stores)) {
    const d = path.join(root, dir, 'Local Extension Settings', EXT);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '000003.log'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`ghaxInstanceId${content}`), Buffer.from([255])]));
  }
  return root;
}

async function main(): Promise<void> {
  // one match
  const one = makeRoot('one', { Default: 'Personal', 'Profile 1': 'DAG Tech' }, { Default: OTHER, 'Profile 1': UUID });
  const m = await findProfile(UUID, { roots: [one], extensionId: EXT });
  assert(m && m.dir === 'Profile 1' && m.name === 'DAG Tech', `one match: ${JSON.stringify(m)}`);
  assert(await findProfile(UUID, { roots: [one], extensionId: 'b'.repeat(32) }) === null, 'wrong extension id: no match');

  // no (valid) extension id: no scan at all
  assert(await findProfile(UUID, { roots: [one] }) === null, 'no extensionId: no scan');
  assert(await findProfile(UUID, { roots: [one], extensionId: 'Z'.repeat(32) }) === null, 'malformed extensionId: no scan');

  // zero matches
  assert(await findProfile('00000000-0000-4000-8000-000000000000', { roots: [one], extensionId: EXT }) === null, 'zero matches');
  assert(await findProfile('not a uuid!', { roots: [one], extensionId: EXT }) === null, 'malformed id rejected');
  assert(await findProfile(UUID, { roots: [path.join(tmp, 'missing')], extensionId: EXT }) === null, 'missing root');

  // two matches: same root, and across roots
  const two = makeRoot('two', { Default: 'A', 'Profile 1': 'B' }, { Default: UUID, 'Profile 1': UUID });
  assert(await findProfile(UUID, { roots: [two], extensionId: EXT }) === null, 'two profile dirs in one root: no guess');
  const r1 = makeRoot('r1', { Default: 'A' }, { Default: UUID });
  const r2 = makeRoot('r2', { Default: 'B' }, { Default: UUID });
  assert(await findProfile(UUID, { roots: [r1, r2], extensionId: EXT }) === null, 'matches in two roots: no guess');

  // only .name is read
  assert(!JSON.stringify(await findProfile(UUID, { roots: [one], extensionId: EXT })).includes('secret@example.com'), 'user_name never surfaces');

  // only regular files: a symlinked storage file or Local State is never followed
  const linkSrc = makeRoot('linksrc', { Default: 'Linked' }, { Default: UUID });
  const sym = makeRoot('sym', { Default: 'Sym' }, {});
  const symStore = path.join(sym, 'Default', 'Local Extension Settings', EXT);
  fs.mkdirSync(symStore, { recursive: true });
  fs.symlinkSync(path.join(linkSrc, 'Default', 'Local Extension Settings', EXT, '000003.log'), path.join(symStore, '000003.log'));
  assert(await findProfile(UUID, { roots: [sym], extensionId: EXT }) === null, 'symlinked .log is not followed');
  const symState = makeRoot('symstate', {}, { Default: UUID });
  fs.rmSync(path.join(symState, 'Local State'));
  fs.symlinkSync(path.join(linkSrc, 'Local State'), path.join(symState, 'Local State'));
  assert(await findProfile(UUID, { roots: [symState], extensionId: EXT }) === null, 'symlinked Local State: root skipped');
  assert(await readRegularFile(path.join(symState, 'Local State'), 1 << 20) === null, 'readRegularFile refuses a symlink');

  // a FIFO is skipped, not blocked on (a blocking open would hang this test)
  if (process.platform !== 'win32') {
    const fifoRoot = makeRoot('fifo', { Default: 'Fifo' }, {});
    const fifoStore = path.join(fifoRoot, 'Default', 'Local Extension Settings', EXT);
    fs.mkdirSync(fifoStore, { recursive: true });
    execFileSync('mkfifo', [path.join(fifoStore, '000003.log')]);
    const t0 = Date.now();
    assert(await findProfile(UUID, { roots: [fifoRoot], extensionId: EXT }) === null, 'FIFO .log rejected');
    assert(await readRegularFile(path.join(fifoStore, '000003.log'), 1 << 20) === null, 'readRegularFile refuses a FIFO');
    assert(Date.now() - t0 < 2000, 'FIFO did not block');
  }

  // size bound
  const big = path.join(tmp, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(2048));
  assert(await readRegularFile(big, 1024) === null && (await readRegularFile(big, 4096))?.length === 2048, 'size bound');

  // env override: empty turns it off, a path replaces the defaults
  assert(profileRoots('edge', 'darwin', { GHAX_BROWSER_PROFILE_ROOTS: '' }, '/h').length === 0, 'empty override = off');
  assert(profileRoots('edge', 'darwin', { GHAX_BROWSER_PROFILE_ROOTS: one }, '/h')[0] === one, 'override replaces roots');
  assert(profileRoots('edge', 'darwin', {}, '/h')[0] === '/h/Library/Application Support/Microsoft Edge', 'mac edge default root');

  // lookup caches hits for the daemon life
  clearProfileCache();
  process.env.GHAX_BROWSER_PROFILE_ROOTS = one;
  const opts = { brand: 'edge', extensionId: EXT };
  assert(cachedProfileName(UUID, opts) === undefined, 'cold cache says "scan"');
  assert(await lookupProfileName(UUID, opts) === 'DAG Tech', 'lookupProfileName via env roots');
  fs.renameSync(path.join(one, 'Local State'), path.join(one, 'Local State.bak'));
  assert(await lookupProfileName(UUID, opts) === 'DAG Tech', 'hit cached for the daemon life');
  assert(cachedProfileName(UUID, opts) === 'DAG Tech', 'cached hit readable synchronously');
  // ... keyed on brand + extensionId too
  assert(cachedProfileName(UUID, { brand: 'chrome', extensionId: EXT }) === undefined, 'another brand is another key');
  fs.renameSync(path.join(one, 'Local State.bak'), path.join(one, 'Local State'));

  // misses expire after MISS_TTL_MS
  const LATE = '77777777-aaaa-4bbb-8ccc-dddddddddddd';
  assert(await lookupProfileName(LATE, opts) === '', 'miss');
  assert(cachedProfileName(LATE, opts) === '', 'miss cached');
  assert(cachedProfileName(LATE, opts, Date.now() + MISS_TTL_MS + 1) === undefined, 'miss expires');

  // the cache is capped
  clearProfileCache();
  for (let i = 0; i < CACHE_MAX + 20; i++) {
    await lookupProfileName(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, opts);
  }
  assert(profileCacheSize() === CACHE_MAX, `cache capped at ${CACHE_MAX}: ${profileCacheSize()}`);
  assert(cachedProfileName('00000000-0000-4000-8000-000000000000', opts) === undefined, 'oldest entry evicted first');

  // concurrent lookups share one scan
  clearProfileCache();
  const [x, y] = await Promise.all([lookupProfileName(UUID, opts), lookupProfileName(UUID, opts)]);
  assert(x === 'DAG Tech' && y === 'DAG Tech', 'concurrent lookups agree');

  // hello never waits for the scan; the name lands when it finishes
  clearProfileCache();
  const lab = makeRoot('lab', { 'Profile 1': 'DAG Tech' }, { 'Profile 1': UUID });
  process.env.GHAX_BROWSER_PROFILE_ROOTS = lab;
  const ws = {} as never;
  const hello = (extra: object) => ({ instanceId: UUID, browser: 'edge', extensionId: EXT, version: '1', ...extra });
  const reg = new PeerRegistry(() => {});
  const auto = reg.upsertFromHello(hello({}), ws).peer;
  assert(auto.profile === '' && auto.profileSource === 'none', `hello returns before the scan: ${auto.profile}`);
  await reg.profileLookupsSettled();
  const after = reg.get(UUID)!; // same object; re-read so TS drops the narrowing above
  assert(after.profile === 'DAG Tech' && after.profileSource === 'browser', `auto name: ${after.profile}/${after.profileSource}`);
  // warm cache: the next registry's hello names it at once
  const warm = new PeerRegistry(() => {}).upsertFromHello(hello({}), ws).peer;
  assert(warm.profile === 'DAG Tech', `warm cache applies in hello: ${warm.profile}`);
  // a popup label takes priority, even over a scan that lands later
  clearProfileCache();
  const reg2 = new PeerRegistry(() => {});
  reg2.upsertFromHello(hello({}), ws);
  const labelled = reg2.upsertFromHello(hello({ profile: 'work' }), ws).peer;
  await reg2.profileLookupsSettled();
  assert(labelled.profile === 'work' && labelled.profileSource === 'label', `label wins: ${labelled.profile}/${labelled.profileSource}`);
  // no extensionId in hello: no lookup at all
  let called = 0;
  const counting = new PeerRegistry(() => {}, () => { called++; return ''; });
  counting.upsertFromHello({ instanceId: UUID, browser: 'edge', version: '1' }, ws);
  assert(called === 0, 'no extensionId: lookup never called');

  console.log(`✓ browser-profiles-unit: ${n} assertions`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
