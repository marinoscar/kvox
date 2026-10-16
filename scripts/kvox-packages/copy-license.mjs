#!/usr/bin/env node
// =============================================================================
// Copy the repository LICENSE into the package being packed
// =============================================================================
//
// Modelled on marinoscar/enterpriseappbase (not copied verbatim).
//
// Run by every @marinoscar/kvox-* package's `prepack` script, so the working
// directory is the package folder. `npm pack` and `npm publish` then ship a
// LICENSE next to package.json (the `files` list names it) while the repository
// keeps a single copy at its root. The copy is git-ignored.
//
// Usage: node ../../scripts/kvox-packages/copy-license.mjs [package-dir]
//        (package-dir defaults to the current working directory)
//
// Exit: 0 copied, 1 the repository has no LICENSE.
// Node built-ins only.
// =============================================================================

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root: this script lives in `<root>/scripts/kvox-packages/`. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Copies `<root>/LICENSE` to `<packageDir>/LICENSE`.
 *
 * @param {string} packageDir Folder of the package being packed.
 * @param {string} [root] Repository root.
 * @returns {string} The path written.
 */
export function copyLicense(packageDir, root = ROOT) {
  const source = join(root, 'LICENSE');
  if (!existsSync(source)) {
    throw new Error(`no LICENSE at the repository root (${source}); a published package must ship one`);
  }
  const target = join(resolve(packageDir), 'LICENSE');
  copyFileSync(source, target);
  return target;
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    copyLicense(process.argv[2] ?? process.cwd());
  } catch (err) {
    console.error(`copy-license: ${err.message}`);
    process.exit(1);
  }
}
