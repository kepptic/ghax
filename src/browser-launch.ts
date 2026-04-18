/**
 * Browser detection + CDP endpoint discovery + launch.
 *
 * v0.1 strategy:
 *   1. Probe --remote-debugging-port endpoint (default 9222).
 *      If it responds with /json/version, use it.
 *   2. Otherwise, if --launch: spawn browser with CDP flag using a
 *      dedicated ghax data dir under ~/.ghax/<browser>-profile/.
 *      This is NOT the user's real profile — that's a v0.2 feature
 *      (requires profile copy + keychain dance to keep cookies working).
 *   3. If neither: print instructions for the user to relaunch their
 *      browser manually with the flag.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type BrowserKind = 'edge' | 'chrome' | 'chromium' | 'brave' | 'arc';

export interface BrowserBinary {
  kind: BrowserKind;
  path: string;
  label: string;
}

export interface CdpEndpoint {
  browserUrl: string;        // ws://127.0.0.1:9222/devtools/browser/<uuid>
  httpUrl: string;           // http://127.0.0.1:9222
  port: number;
  version: {
    Browser: string;
    'Protocol-Version': string;
    'User-Agent': string;
    'V8-Version'?: string;
    'WebKit-Version'?: string;
    webSocketDebuggerUrl: string;
  };
}

const MAC_BINARIES: Record<BrowserKind, string> = {
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  arc: '/Applications/Arc.app/Contents/MacOS/Arc',
};

const LINUX_BINARIES: Record<BrowserKind, string[]> = {
  edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
  chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser'],
  brave: ['/usr/bin/brave-browser'],
  arc: [],
};

const WIN_BINARIES: Record<BrowserKind, string[]> = {
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  chromium: [],
  brave: ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  arc: [],
};

export function detectBrowsers(): BrowserBinary[] {
  const found: BrowserBinary[] = [];
  const labels: Record<BrowserKind, string> = {
    edge: 'Microsoft Edge',
    chrome: 'Google Chrome',
    chromium: 'Chromium',
    brave: 'Brave',
    arc: 'Arc',
  };

  const check = (kind: BrowserKind, candidate: string) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      found.push({ kind, path: candidate, label: labels[kind] });
    } catch {
      // not installed
    }
  };

  if (process.platform === 'darwin') {
    for (const kind of Object.keys(MAC_BINARIES) as BrowserKind[]) {
      check(kind, MAC_BINARIES[kind]);
    }
  } else if (process.platform === 'linux') {
    for (const kind of Object.keys(LINUX_BINARIES) as BrowserKind[]) {
      for (const candidate of LINUX_BINARIES[kind]) check(kind, candidate);
    }
  } else if (process.platform === 'win32') {
    for (const kind of Object.keys(WIN_BINARIES) as BrowserKind[]) {
      for (const candidate of WIN_BINARIES[kind]) check(kind, candidate);
    }
  }

  return found;
}

export async function probeCdp(port: number = 9222, host: string = '127.0.0.1'): Promise<CdpEndpoint | null> {
  const httpUrl = `http://${host}:${port}`;
  try {
    const resp = await fetch(`${httpUrl}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return null;
    const version = (await resp.json()) as CdpEndpoint['version'];
    if (!version.webSocketDebuggerUrl) return null;
    return {
      browserUrl: version.webSocketDebuggerUrl,
      httpUrl,
      port,
      version,
    };
  } catch {
    return null;
  }
}

export function profileDirFor(kind: BrowserKind): string {
  return path.join(os.homedir(), '.ghax', `${kind}-profile`);
}

export interface LaunchResult {
  pid: number;
  endpoint: CdpEndpoint;
  dataDir: string;
}

export async function launchBrowser(
  binary: BrowserBinary,
  opts: { port?: number; dataDir?: string; loadExtension?: string | string[] } = {},
): Promise<LaunchResult> {
  const port = opts.port ?? 9222;
  const dataDir = opts.dataDir ?? profileDirFor(binary.kind);
  fs.mkdirSync(dataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=IsolateOrigins,site-per-process',
  ];

  if (opts.loadExtension) {
    // `--load-extension` accepts a comma-separated list. `--disable-extensions-except`
    // silences the other (chrome-store-installed) extensions in the scratch
    // profile so the user sees only their unpacked dev extension.
    const paths = (Array.isArray(opts.loadExtension) ? opts.loadExtension : [opts.loadExtension])
      .map((p) => path.resolve(p));
    for (const p of paths) {
      if (!fs.existsSync(path.join(p, 'manifest.json'))) {
        throw new Error(`--load-extension: no manifest.json in ${p}`);
      }
    }
    const joined = paths.join(',');
    args.push(`--load-extension=${joined}`);
    args.push(`--disable-extensions-except=${joined}`);
  }

  const proc = Bun.spawn([binary.path, ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  proc.unref();

  // Poll for CDP readiness (up to ~10s)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ep = await probeCdp(port);
    if (ep) {
      return { pid: proc.pid!, endpoint: ep, dataDir };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Launched ${binary.label} (pid ${proc.pid}) but CDP on :${port} never came up.`);
}

export function launchInstructions(port: number, browsers: BrowserBinary[]): string {
  if (process.platform === 'darwin') {
    const lines = ['No running browser found on CDP port.', ''];
    for (const b of browsers) {
      lines.push(`  # ${b.label}`);
      lines.push(`  "${b.path}" --remote-debugging-port=${port} &`);
      lines.push('');
    }
    lines.push('Or run `ghax attach --launch [--browser edge|chrome]` to let ghax launch one in a scratch profile.');
    return lines.join('\n');
  }
  return `No running browser on :${port}. Launch Chrome/Edge with --remote-debugging-port=${port}, or use 'ghax attach --launch'.`;
}
