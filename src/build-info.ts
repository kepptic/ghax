/**
 * Daemon build provenance — version, git sha, build date.
 *
 * `scripts/build-daemon.mjs` injects the real values at bundle time via
 * esbuild's `define`, replacing the `__GHAX_BUILD__` identifier declared in
 * `build-info.d.ts` with a JSON literal. That means the `esbuild` bundle
 * (`dist/ghax-daemon.mjs`) never actually executes the fallback below.
 *
 * The fallback exists for every OTHER way this module gets loaded without
 * going through esbuild: `tsc --noEmit`, `tsx test/*.ts`, or any script that
 * imports daemon internals directly. In those cases `__GHAX_BUILD__` is
 * simply undefined at runtime, so `typeof __GHAX_BUILD__` guards against a
 * ReferenceError and this file falls back to reading the version straight
 * out of package.json (gitSha/buildDate can't be known without the build
 * step, so they report 'unknown' — same sentinel the Rust CLI uses for the
 * same situation, see crates/cli/build.rs).
 *
 * The `__GHAX_BUILD__` identifier's type comes from the ambient global
 * declaration in `build-info.d.ts` (no import needed — esbuild's `define`
 * does a raw text substitution, and TypeScript sees the same identifier via
 * the global ambient decl).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export type BuildInfo = GhaxBuildInfo;

function fallback(): BuildInfo {
  let version = 'dev';
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
  } catch {
    // Best-effort only — 'dev' stands if package.json isn't reachable from here.
  }
  return { version, gitSha: 'unknown', buildDate: 'unknown' };
}

export const BUILD_INFO: BuildInfo =
  typeof __GHAX_BUILD__ !== 'undefined' ? __GHAX_BUILD__ : fallback();
