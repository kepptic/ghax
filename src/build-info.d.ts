// Ambient global declaration for the build-time provenance constant that
// `scripts/build-daemon.mjs` injects via esbuild's `define:
// { __GHAX_BUILD__: JSON.stringify(info) }`. esbuild does a raw identifier
// substitution — no import needed — so this identifier only actually
// exists once the bundle has been built. `src/build-info.ts` guards every
// reference with `typeof __GHAX_BUILD__ !== 'undefined'` so `tsc --noEmit`
// and direct `tsx` runs (no esbuild define pass) fall back cleanly instead
// of throwing a ReferenceError.
//
// No top-level import/export in this file — that's what keeps it a global
// ambient declaration visible to every file in the program, rather than a
// module. TypeScript's `include` globs deliberately don't pick up `.d.ts`
// files even when the pattern says `*.d.ts` (a documented quirk), so this
// file is listed explicitly under tsconfig.json's `files` instead.

interface GhaxBuildInfo {
  version: string;
  gitSha: string;
  buildDate: string;
}

declare const __GHAX_BUILD__: GhaxBuildInfo | undefined;
