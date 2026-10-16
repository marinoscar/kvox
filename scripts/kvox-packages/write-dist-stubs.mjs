#!/usr/bin/env node
// =============================================================================
// Write the package.json stubs that give each dist tree its module format
// =============================================================================
//
// Modelled on marinoscar/enterpriseappbase (not copied verbatim).
//
// A `.d.ts` and a `.js` file take their module format from the NEAREST
// package.json. @marinoscar/kvox-contract is "type": "module", so its CommonJS
// build (dist/cjs) would be read as ESM unless a package.json of its own says
// otherwise: `require()` of a `.js` file fails with ERR_REQUIRE_ESM and the
// declarations raise TS1479 in a CommonJS consumer. The build therefore ends
// with this script:
//
//   dist/cjs/package.json  ->  {"type":"commonjs"}
//   dist/esm/package.json  ->  {"type":"module"}   (explicit, so moving the
//                                                    root "type" cannot change it)
//
// Usage: node ../../scripts/kvox-packages/write-dist-stubs.mjs [package-dir]
//        (package-dir defaults to the current working directory)
//
// Exit: 0 written, 1 a dist tree is missing (build first).
// Node built-ins only.
// =============================================================================

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Dist trees and the module format each one is. */
export const DIST_STUBS = Object.freeze([
  { dir: 'dist/cjs', type: 'commonjs' },
  { dir: 'dist/esm', type: 'module' },
]);

/**
 * Writes the stubs under `packageDir`.
 *
 * @param {string} packageDir Folder of the package that was just built.
 * @returns {string[]} The files written.
 */
export function writeDistStubs(packageDir) {
  const written = [];
  for (const { dir, type } of DIST_STUBS) {
    const folder = join(resolve(packageDir), dir);
    if (!existsSync(folder)) throw new Error(`${folder} does not exist; run the build first`);
    const file = join(folder, 'package.json');
    writeFileSync(file, `${JSON.stringify({ type })}\n`);
    written.push(file);
  }
  return written;
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    writeDistStubs(process.argv[2] ?? process.cwd());
  } catch (err) {
    console.error(`write-dist-stubs: ${err.message}`);
    process.exit(1);
  }
}
