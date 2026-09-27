/**
 * ghax bridge — LIVE end-to-end test over a real browser + the unpacked
 * extension. The counterpart to test/bridge-sim.ts (which needs no browser):
 * this exercises the actual CDP relay path that the simulator can only fake.
 *
 * It is opt-in and NOT part of the default suite, because it needs a human to
 * have loaded the extension and pointed it at a tab — which CI can't do:
 *
 *   1. Load extension/ unpacked in Edge/Chrome (edge://extensions).
 *   2. `GHAX_STATE_FILE=/tmp/ghax-live.json ghax attach --extension --control-active`
 *      (or click "Control this tab" in the popup).
 *   3. `GHAX_SMOKE_BRIDGE=1 GHAX_STATE_FILE=/tmp/ghax-live.json npm run test:bridge-live`
 *
 * It drives goto → wait --stable → snapshot → back/forward → eval over the
 * real bridge and asserts each lands. Non-destructive: it navigates to
 * example.com / example.org only.
 *
 * Exit 0 on success, non-zero on the first failure. Skips cleanly (exit 0)
 * unless GHAX_SMOKE_BRIDGE=1, so a bare `npm test` never trips on it.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createServer } from 'http';
import type { AddressInfo } from 'net';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ghax = process.env.GHAX_BIN ?? path.join(root, 'target', 'release', 'ghax');

if (process.env.GHAX_SMOKE_BRIDGE !== '1') {
  console.log('bridge-live: set GHAX_SMOKE_BRIDGE=1 to run (needs a real browser + the loaded extension). Skipping.');
  process.exit(0);
}

interface RunResult { stdout: string; stderr: string; code: number }

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(ghax, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('exit', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function parse<T>(s: string): T {
  const t = s.trim();
  const start = t.search(/[{[]/);
  return JSON.parse(start >= 0 ? t.slice(start) : t) as T;
}

let checks = 0, failures = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  checks++;
  try {
    await fn();
    console.log(`• ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n    ${(err as Error).message}`);
  }
}

/**
 * Fixture pages come from a throwaway local HTTP server, not data: URLs.
 * Chrome refuses extension-initiated top-level navigation to data: (both
 * chrome.debugger Page.navigate and chrome.tabs.update), so over the bridge
 * a data: goto never commits; the daemon now rejects it up front.
 */
let fixtureOrigin = '';
function startFixtureServer(): Promise<() => void> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><body>${u.searchParams.get('html') ?? ''}</body>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    fixtureOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve(() => server.close());
  }));
}
const fixture = (html: string) => `${fixtureOrigin}/page?html=${encodeURIComponent(html)}`;

/** goto a fixture and fail loudly if the tab didn't actually land there. */
async function gotoFixture(html: string): Promise<void> {
  const r = await run(['goto', fixture(html), '--json']);
  const g = parse<{ url: string }>(r.stdout);
  assert(g.url.startsWith(fixtureOrigin), `fixture did not load, tab is on ${g.url}: ${r.stderr}`);
}

async function main(): Promise<void> {
  console.log('bridge-live: driving the real extension bridge\n');
  const stopFixtures = await startFixtureServer();

  // Confirm we're actually talking to a bridge daemon with a controlled tab.
  const status = await run(['status', '--json']);
  assert(status.code === 0, `status failed — is a bridge daemon attached? ${status.stderr}`);
  const st = parse<{ browserUrl?: string }>(status.stdout);
  assert(
    String(st.browserUrl ?? '').startsWith('bridge://'),
    `not a bridge daemon (browserUrl=${st.browserUrl}). See the header of this file.`,
  );

  await test('bridge instances shows a bound driver', async () => {
    const r = await run(['bridge', 'instances', '--json']);
    const data = parse<{ state: string; instances: Array<{ role: string }> }>(r.stdout);
    assert(data.state === 'BOUND', `expected BOUND, got ${data.state}`);
    assert(data.instances.some((i) => i.role === 'bound'), 'no bound instance');
  });

  await test('goto --stable navigates the real tab and settles', async () => {
    const r = await run(['goto', 'https://example.com', '--stable', '--json']);
    const g = parse<{ url: string; stable: boolean }>(r.stdout);
    assert(g.url.includes('example.com'), `url was ${g.url}`);
    assert(g.stable === true, 'example.com should settle');
  });

  await test('snapshot -i returns interactive refs over the bridge', async () => {
    const r = await run(['snapshot', '-i', '--json']);
    const snap = parse<{ count: number }>(r.stdout);
    assert(snap.count >= 1, `expected ≥1 ref, got ${snap.count}`);
  });

  await test('eval reads the live document via the pinned context', async () => {
    const r = await run(['eval', 'document.title']);
    assert(/example/i.test(r.stdout), `title should mention example, got ${r.stdout.trim()}`);
  });

  await test('back/forward reconcile-navigate the history', async () => {
    await run(['goto', 'https://example.org']);
    const back = await run(['back', '--json']);
    const b = parse<{ url: string; outcome?: string }>(back.stdout);
    assert(b.url.includes('example.com'), `back should return to example.com, got ${b.url}`);
    assert(b.outcome === 'succeeded', `outcome should be succeeded, got ${b.outcome}`);
    const fwd = await run(['forward', '--json']);
    const f = parse<{ url: string }>(fwd.stdout);
    assert(f.url.includes('example.org'), `forward should return to example.org, got ${f.url}`);
  });

  await test('snapshot -i costs a constant number of relayed calls (--trace)', async () => {
    // Constant = independent of page size. The first snapshot of a document
    // also creates ghax's isolated world (two one-time calls), so measure the
    // second snapshot of each page.
    const calls = async (n: number): Promise<number> => {
      await gotoFixture(Array.from({ length: n }, (_, i) => `<button>b${i}</button>`).join(''));
      await run(['snapshot', '-i', '--no-cap']);
      const r = await run(['snapshot', '-i', '--no-cap', '--trace']);
      assert((r.stdout.match(/@e\d+ \[button\]/g) ?? []).length === n, `all ${n} buttons should be in the snapshot`);
      const m = /trace: (\d+) cdp calls/.exec(r.stderr);
      assert(m, `no trace line: ${r.stderr}`);
      return Number(m[1]);
    };
    const small = await calls(10);
    const big = await calls(150);
    assert(big === small, `call count grew with the page: 10 buttons ${small}, 150 buttons ${big}`);
    assert(big <= 10, `a warm snapshot took ${big} relayed calls`);
    assert(!/data-ghax-ref/.test((await run(['html'])).stdout), 'snapshot must not write data-ghax-ref into the DOM');
  });

  await test('bridge refs are stable across snapshots; batch skips an unneeded re-snapshot', async () => {
    await gotoFixture('<div id="top"></div><button onclick="window.__c=(window.__c||0)+1">Keep</button>');
    const refOf = (text: string, name: string) => new RegExp(`@(e\\d+) \\[button\\] "${name}"`).exec(text)?.[1];
    const first = refOf((await run(['snapshot', '-i'])).stdout, 'Keep');
    assert(first, 'Keep button not in snapshot');
    await run(['eval', `document.getElementById('top').innerHTML='<button>New</button>'; 'ok'`]);
    const snap = (await run(['snapshot', '-i'])).stdout;
    assert(refOf(snap, 'Keep') === first, `Keep moved from ${first} to ${refOf(snap, 'Keep')}`);
    const r = await run(['batch', JSON.stringify([{ cmd: 'click', args: [`@${first}`] }])]);
    const steps = parse<Array<{ ok: boolean; autoSnapshot?: string }>>(r.stdout);
    assert(steps[0].ok && steps[0].autoSnapshot === 'skipped', `batch step: ${r.stdout}`);
  });

  // ─── Actionability guard (plan 10, C5) ───────────────────────
  // These need a real DOM, which the simulator cannot provide.
  const overlayPage = (`
    <button id="under" onclick="window.__hit=(window.__hit||0)+1" style="position:absolute;top:40px;left:40px">Buy</button>
    <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.3)">Accept cookies</div>`);

  await test('guard: click on a covered button is refused and names the overlay', async () => {
    await gotoFixture(overlayPage);
    const r = await run(['click', '#under']);
    assert(r.code === 4, `expected exit 4, got ${r.code}: ${r.stderr}`);
    assert(/covered by div#overlay/.test(r.stderr), `should name the coverer: ${r.stderr}`);
    assert(/--force/.test(r.stderr), `hint should mention --force: ${r.stderr}`);
    const hit = await run(['eval', 'window.__hit || 0']);
    assert(hit.stdout.trim() === '0', 'the covered button must not have been clicked');
  });

  await test('guard: --force clicks through the overlay (at the button centre)', async () => {
    const r = await run(['click', '#under', '--force', '--json']);
    assert(r.code === 0, `--force should succeed: ${r.stderr}`);
  });

  await test('guard: fieldset[disabled] button is refused as disabled', async () => {
    await gotoFixture('<fieldset disabled><legend>L</legend><button id="b">Save</button></fieldset>');
    const r = await run(['click', '#b']);
    assert(r.code === 4 && /not actionable \(disabled\)/.test(r.stderr), `expected disabled: ${r.stderr}`);
  });

  await test('guard: a button inside the fieldset LEGEND stays enabled', async () => {
    await gotoFixture('<fieldset disabled><legend><button id="b" onclick="window.__ok=1">Toggle</button></legend></fieldset>');
    const r = await run(['click', '#b']);
    assert(r.code === 0, `legend button should click: ${r.stderr}`);
  });

  await test('guard: inherited aria-disabled wrapper is refused', async () => {
    await gotoFixture('<div aria-disabled="true"><span role="button" id="b">Go</span></div>');
    const r = await run(['click', '#b']);
    assert(r.code === 4 && /not actionable \(disabled\)/.test(r.stderr), `expected disabled: ${r.stderr}`);
  });

  const shadowPage = (covered: boolean) => (`
    <div id="host"></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<button onclick="window.__shadow=1" style="margin:40px">Shadow Save</button>';
    </script>
    ${covered ? '<div id="overlay" style="position:fixed;inset:0">x</div>' : ''}`);

  const shadowRef = async (): Promise<string> => {
    const snap = await run(['snapshot', '-i']);
    const m = /@(e\d+) \[button\] "Shadow Save"/.exec(snap.stdout);
    assert(m, `shadow button not in snapshot:\n${snap.stdout}`);
    return `@${m[1]}`;
  };

  await test('guard: a shadow-hosted button is hit-tested through its shadow root', async () => {
    await gotoFixture(shadowPage(false));
    const r = await run(['click', await shadowRef()]);
    assert(r.code === 0, `shadow click should pass the hit test: ${r.stderr}`);
    const v = await run(['eval', 'window.__shadow || 0']);
    assert(v.stdout.trim() === '1', 'shadow button should have been clicked');
  });

  await test('guard: a shadow-hosted button under an overlay is refused as covered', async () => {
    await gotoFixture(shadowPage(true));
    const r = await run(['click', await shadowRef()]);
    assert(r.code === 4 && /covered by div#overlay/.test(r.stderr), `expected covered: ${r.stderr}`);
  });

  // Review finding 3: no false positives on common real-world shapes.
  await test('guard: an opacity:0 native checkbox under its label is clickable', async () => {
    await gotoFixture('<label style="position:relative;display:inline-block;width:80px;height:30px">'
      + '<input id="b" type="checkbox" style="opacity:0;position:absolute;inset:0;width:100%;height:100%;margin:0">Agree</label>');
    const r = await run(['click', '#b']);
    assert(r.code === 0, `opacity:0 checkbox should click: ${r.stderr}`);
    const v = await run(['eval', "String(document.getElementById('b').checked)"]);
    assert(v.stdout.trim() === 'true', 'the checkbox should now be checked');
  });

  await test('guard: a target just under a sticky header is re-centred, not refused', async () => {
    await gotoFixture('<header style="position:sticky;top:0;height:80px;background:#ccc;z-index:5">hdr</header>'
      + '<div style="height:3000px"><button id="b" style="margin-top:900px" onclick="window.__s=1">Deep</button></div>');
    await run(['eval', "window.scrollTo(0, document.getElementById('b').offsetTop - 20); 'ok'"]);
    const r = await run(['click', '#b']);
    assert(r.code === 0, `sticky-header target should click after re-centring: ${r.stderr}`);
    const v = await run(['eval', 'String(window.__s || 0)']);
    assert(v.stdout.trim() === '1', 'the button should have been clicked');
  });

  await test('guard: a display:contents button acts through its rendered child', async () => {
    await gotoFixture('<div id="b" role="button" style="display:contents" onclick="window.__dc=1"><span>Inner</span></div>');
    const r = await run(['click', '#b']);
    assert(r.code === 0, `display:contents should not read as hidden: ${r.stderr}`);
    const v = await run(['eval', 'String(window.__dc || 0)']);
    assert(v.stdout.trim() === '1', 'the click should reach the handler');
  });

  // Review finding 6: the page's own world can't steer ghax.
  await test('isolated world: a page squatting window.__ghax and faking hit-tests cannot steer ghax', async () => {
    await gotoFixture(`
      <button id="b" onclick="window.__buy=1">Buy</button>
      <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.2)">Cookie wall</div>
      <span style="cursor:pointer" onclick="window.__c=1">Pointer thing</span>
      <script>
        window.__ghax = 'squatted';
        const btn = document.getElementById('b');
        Document.prototype.elementsFromPoint = function () { return [btn]; };
        Document.prototype.elementFromPoint = function () { return btn; };
        Element.prototype.getBoundingClientRect = function () { return new DOMRect(0, 0, 1, 1); };
      </script>`);
    const snap = await run(['snapshot', '-C']);
    assert(snap.code === 0 && /@c\d+ .*"Pointer thing"/.test(snap.stdout), `cursor pass must work despite a squatted __ghax:\n${snap.stdout}${snap.stderr}`);
    const r = await run(['click', '#b']);
    assert(r.code === 4 && /covered by div#overlay/.test(r.stderr), `the fake hit-test must not hide the overlay: ${r.stderr}`);
    const v = await run(['eval', 'String(window.__buy || 0)']);
    assert(v.stdout.trim() === '0', 'the covered button must not have been clicked');
  });

  await test('goto data: fails fast and says why (Chrome blocks it for extensions)', async () => {
    const started = Date.now();
    const r = await run(['goto', 'data:text/html,x']);
    assert(r.code !== 0, `data: goto should fail over the bridge, got exit 0: ${r.stdout}`);
    assert(/data: URLs/.test(r.stderr), `error should name the data: restriction: ${r.stderr}`);
    assert(Date.now() - started < 3000, 'should fail up front, not after the load timeout');
  });

  stopFixtures();
  console.log();
  if (failures > 0) {
    console.error(`✗ ${failures}/${checks} checks failed`);
    process.exit(1);
  }
  console.log(`✓ ${checks}/${checks} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
