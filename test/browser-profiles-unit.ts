/**
 * browser-profiles — automatic profile names, offline. Builds a fake User Data
 * dir in a temp folder: no browser needed.
 *
 * Run: tsx test/browser-profiles-unit.ts   (npm run test:browser-profiles)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearProfileCache, findProfile, lookupProfileName, profileRoots } from '../src/browser-profiles';
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

try {
  // one match
  const one = makeRoot('one', { Default: 'Personal', 'Profile 1': 'DAG Tech' }, { Default: OTHER, 'Profile 1': UUID });
  const m = findProfile(UUID, { roots: [one] });
  assert(m && m.dir === 'Profile 1' && m.name === 'DAG Tech', `one match: ${JSON.stringify(m)}`);
  assert(findProfile(UUID, { roots: [one], extensionId: EXT })?.name === 'DAG Tech', 'extensionId narrows, still matches');
  assert(findProfile(UUID, { roots: [one], extensionId: 'b'.repeat(32) }) === null, 'wrong extension id: no match');

  // zero matches
  assert(findProfile('00000000-0000-4000-8000-000000000000', { roots: [one] }) === null, 'zero matches');
  assert(findProfile('not a uuid!', { roots: [one] }) === null, 'malformed id rejected');
  assert(findProfile(UUID, { roots: [path.join(tmp, 'missing')] }) === null, 'missing root');

  // two matches: same root, and across roots
  const two = makeRoot('two', { Default: 'A', 'Profile 1': 'B' }, { Default: UUID, 'Profile 1': UUID });
  assert(findProfile(UUID, { roots: [two] }) === null, 'two profile dirs in one root: no guess');
  const r1 = makeRoot('r1', { Default: 'A' }, { Default: UUID });
  const r2 = makeRoot('r2', { Default: 'B' }, { Default: UUID });
  assert(findProfile(UUID, { roots: [r1, r2] }) === null, 'matches in two roots: no guess');

  // only .name is read
  assert(!JSON.stringify(findProfile(UUID, { roots: [one] })).includes('secret@example.com'), 'user_name never surfaces');

  // env override: empty turns it off, a path replaces the defaults
  assert(profileRoots('edge', 'darwin', { GHAX_BROWSER_PROFILE_ROOTS: '' }, '/h').length === 0, 'empty override = off');
  assert(profileRoots('edge', 'darwin', { GHAX_BROWSER_PROFILE_ROOTS: one }, '/h')[0] === one, 'override replaces roots');
  assert(profileRoots('edge', 'darwin', {}, '/h')[0] === '/h/Library/Application Support/Microsoft Edge', 'mac edge default root');

  // lookup caches misses and hits
  clearProfileCache();
  process.env.GHAX_BROWSER_PROFILE_ROOTS = one;
  assert(lookupProfileName(UUID) === 'DAG Tech', 'lookupProfileName via env roots');
  fs.rmSync(path.join(one, 'Local State'));
  assert(lookupProfileName(UUID) === 'DAG Tech', 'cached for the daemon life');

  // a popup label takes priority over the browser's name
  clearProfileCache();
  const lab = makeRoot('lab', { 'Profile 1': 'DAG Tech' }, { 'Profile 1': UUID });
  process.env.GHAX_BROWSER_PROFILE_ROOTS = lab;
  const ws = {} as never;
  const hello = (extra: object) => ({ instanceId: UUID, browser: 'edge', extensionId: EXT, version: '1', ...extra });
  const auto = new PeerRegistry(() => {}).upsertFromHello(hello({}), ws).peer;
  assert(auto.profile === 'DAG Tech' && auto.profileSource === 'browser', `auto name: ${auto.profile}/${auto.profileSource}`);
  const labelled = new PeerRegistry(() => {}).upsertFromHello(hello({ profile: 'work' }), ws).peer;
  assert(labelled.profile === 'work' && labelled.profileSource === 'label', `label wins: ${labelled.profile}/${labelled.profileSource}`);

  console.log(`✓ browser-profiles-unit: ${n} assertions`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
