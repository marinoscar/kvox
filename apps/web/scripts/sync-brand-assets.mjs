#!/usr/bin/env node
// =============================================================================
// Mirror the package's brand assets into apps/web/public
// =============================================================================
//
// The SINGLE copy of the brand files is the brand folder of the
// `@marinoscar/kvox-web` package, `src/brand/` (`assets/` and `fonts/`, the
// `@marinoscar/kvox-web/brand/*` exports; issue #628). This app still has to
// serve some of them from fixed URLs that no bundler rewrites:
//
//   /favicon.svg, /favicon.ico   `index.html` <link rel="icon">
//   /icons/*.png                 the web app manifest and the service worker
//   /fonts/inter.css + .woff2    `index.html` and the visual harness <link>
//
// so `public/` holds a byte-for-byte MIRROR of those files, written by this
// script and verified by `--check` (also asserted by
// `src/__tests__/pwa/brandAssetsMirror.test.ts`, so `npm run test:run` fails on
// drift). Nobody edits a mirrored file in `public/`: edit the package copy
// (the package's `scripts/generate-icons.py` writes the rasters there), then run
//
//   node apps/web/scripts/sync-brand-assets.mjs
//
// WHY A COMMITTED MIRROR AND NOT A VITE `publicDir` OR A `prebuild` COPY. The
// manifest, the service worker, the dev server, the vitest suites and the
// visual harness (a second Vite config) all read `public/` as plain files; a
// build-time copy would have to be wired into every one of them and would leave
// a checkout without the files until the first build. A committed mirror works
// in all of them unchanged, and the check makes it exactly as trustworthy as a
// single copy.
//
// Usage: node apps/web/scripts/sync-brand-assets.mjs [--check]
// Exit: 0 in step (or written), 1 out of step under --check, 2 a source is missing.
// Node built-ins only. Importing this module runs nothing.
// =============================================================================

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = resolve(HERE, '..');
export const REPO_ROOT = resolve(WEB_DIR, '..', '..');
/**
 * Where the single copy lives: `src/brand` of the `@marinoscar/kvox-web` workspace
 * package, found through its `package.json` export so this file names no folder.
 */
export const BRAND_DIR = join(
  dirname(createRequire(import.meta.url).resolve('@marinoscar/kvox-web/package.json')),
  'src',
  'brand',
);
/** Where the mirror is served from. */
export const PUBLIC_DIR = join(WEB_DIR, 'public');

const PNGS = [
  'icon-192',
  'icon-512',
  'icon-maskable-192',
  'icon-maskable-512',
  'badge-96',
  'apple-touch-icon-180',
].map((name) => `${name}.png`);

/**
 * Every mirrored file: `from` is relative to the brand folder, `to` to `public/`.
 * `icon-1024.png` is deliberately absent: it is for installers, not for the web.
 */
export const MIRRORED = Object.freeze([
  { from: 'assets/mark.svg', to: 'icons/source.svg' },
  { from: 'assets/favicon.svg', to: 'favicon.svg' },
  { from: 'assets/favicon.ico', to: 'favicon.ico' },
  ...PNGS.map((png) => ({ from: `assets/${png}`, to: `icons/${png}` })),
  { from: 'fonts/inter.css', to: 'fonts/inter.css' },
  { from: 'fonts/Inter-latin-variable.woff2', to: 'fonts/Inter-latin-variable.woff2' },
]);

/**
 * Writes (or checks) the mirror.
 *
 * @param {{ check?: boolean }} options
 * @returns {{ missing: string[], stale: string[], written: string[] }} Package files
 *   that do not exist, public files that differ, and public files written.
 */
export function syncBrandAssets({ check = false } = {}) {
  const missing = [];
  const stale = [];
  const written = [];
  for (const { from, to } of MIRRORED) {
    const source = join(BRAND_DIR, from);
    const target = join(PUBLIC_DIR, to);
    if (!existsSync(source)) {
      missing.push(from);
      continue;
    }
    const same = existsSync(target) && readFileSync(source).equals(readFileSync(target));
    if (same) continue;
    stale.push(to);
    if (!check) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      written.push(to);
    }
  }
  return { missing, stale, written };
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const check = process.argv.includes('--check');
  const { missing, stale, written } = syncBrandAssets({ check });
  if (missing.length > 0) {
    console.error(`sync-brand-assets: missing in ${BRAND_DIR}: ${missing.join(', ')}`);
    process.exit(2);
  }
  if (check && stale.length > 0) {
    console.error(
      `sync-brand-assets: apps/web/public is out of step with the package: ${stale.join(', ')}\n` +
        '  Run: node apps/web/scripts/sync-brand-assets.mjs',
    );
    process.exit(1);
  }
  console.log(
    written.length > 0
      ? `sync-brand-assets: wrote ${written.join(', ')}`
      : 'sync-brand-assets: in step',
  );
}
