#!/usr/bin/env node
// build-daemon.mjs — builds dist/ghax-daemon.mjs and stamps it with build
// provenance (version, git sha, build date), replacing the old plain
// esbuild CLI invocation in package.json's `build` script.
//
// Two things a shell one-liner couldn't do cleanly:
//   1. Cross-platform provenance (this runs in CI on ubuntu/macos/windows —
//      see ci.yml's matrix — so `$(git rev-parse ...)` shell substitution
//      isn't safe to depend on; this script shells out via child_process
//      itself, with the same fallback chain build.rs uses on the Rust side).
//   2. Injecting that provenance into the bundle via esbuild's `define`,
//      and writing the same info to extension/build-info.js so the
//      bridge extension (which can't read package.json/git at runtime —
//      MV3 service workers have no filesystem or child_process access) can
//      report matching values in its `hello` handshake.
//
// Usage: node scripts/build-daemon.mjs   (what `npm run build` invokes)

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function gitSha() {
  if (process.env.BUILD_GIT_SHA) return process.env.BUILD_GIT_SHA.trim();
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function buildDate() {
  if (process.env.BUILD_DATE) return process.env.BUILD_DATE.trim();
  const epochSecs = process.env.SOURCE_DATE_EPOCH
    ? Number(process.env.SOURCE_DATE_EPOCH)
    : Math.floor(Date.now() / 1000);
  return new Date(epochSecs * 1000).toISOString().slice(0, 10);
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return pkg.version;
}

const info = {
  version: readVersion(),
  gitSha: gitSha(),
  buildDate: buildDate(),
};

// Written for the bridge extension. A service worker can't shell out to git,
// and extension/background.js statically imports this file, so provenance is
// captured at SW script load and cached with it: a never-reloaded worker keeps
// its OLD values and `ghax version --full` can flag it. The checked-in stub is
// marked skip-worktree (best effort) so rebuilding doesn't dirty the tree.
const extInfoPath = join(repoRoot, 'extension', 'build-info.js');
writeFileSync(
  extInfoPath,
  `self.GHAX_BUILD_INFO = ${JSON.stringify(info)};\n`,
);
try {
  execFileSync('git', ['update-index', '--skip-worktree', 'extension/build-info.js'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
} catch {
  // not a git checkout (tarball) — nothing to hide
}

await build({
  entryPoints: [join(repoRoot, 'src', 'daemon.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(repoRoot, 'dist', 'ghax-daemon.mjs'),
  external: [
    'electron',
    'chromium-bidi',
    '@playwright/test',
    'playwright',
    'playwright-core',
    'source-map',
    'ws',
  ],
  legalComments: 'none',
  define: {
    __GHAX_BUILD__: JSON.stringify(info),
  },
});

console.log(
  `build-daemon: dist/ghax-daemon.mjs built — version=${info.version} gitSha=${info.gitSha} buildDate=${info.buildDate}`,
);
