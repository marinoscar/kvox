#!/usr/bin/env node
// =============================================================================
// Copy the brand assets into dist/brand after the TypeScript build
// =============================================================================
//
// `tsc` emits only code. The SVG, PNG and ICO files of `src/brand/assets` and the
// Inter font and stylesheet of `src/brand/fonts` are package exports
// (`@marinoscar/kvox-web/brand/assets/*`, `.../brand/fonts/*`) that must exist
// next to the compiled `brand/index.js`, so the build ends by copying both
// folders into `dist/brand`. The font stylesheet's `url('./Inter-latin-variable.woff2')`
// is relative, so a bundler (Vite, electron-vite) resolves and emits the file
// from the copy beside it.
//
// Usage: node scripts/copy-brand-assets.mjs
// Exit: 0 copied, 1 `dist/brand` missing (build first).
// Node built-ins only. Importing this module runs nothing.
// =============================================================================

import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The source folders under `src/brand` that ship as-is. */
export const ASSET_FOLDERS = Object.freeze(['assets', 'fonts']);

/**
 * Copies the asset folders into `<packageDir>/dist/brand`.
 *
 * @param {string} packageDir Folder of the package that was just built.
 * @returns {string[]} The folders written.
 */
export function copyBrandAssets(packageDir = PACKAGE_DIR) {
  const target = join(packageDir, 'dist', 'brand');
  if (!existsSync(target)) throw new Error(`${target} does not exist; run the build first`);
  const written = [];
  for (const folder of ASSET_FOLDERS) {
    const to = join(target, folder);
    cpSync(join(packageDir, 'src', 'brand', folder), to, { recursive: true });
    written.push(to);
  }
  return written;
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    copyBrandAssets();
  } catch (err) {
    console.error(`copy-brand-assets: ${err.message}`);
    process.exit(1);
  }
}
