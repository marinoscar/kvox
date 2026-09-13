import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Package version, read at runtime  (issue #140, epic #110)
// =============================================================================
//
// WHY NOT `import pkg from '../package.json' with { type: 'json' }`:
//
//   1. Import attributes are required for JSON in ESM, and the `with` syntax
//      only became non-experimental partway through Node 20's life. This
//      package advertises Node 20+, and "fails to start on 20.5" is the worst
//      possible bug for a CLI — it happens before any of our error handling
//      exists to explain it.
//   2. It changes the emitted layout. With `rootDir: ./src`, importing a file
//      from OUTSIDE src makes tsc widen the root and emit `dist/src/*.js`,
//      which quietly breaks the `bin` path in package.json.
//
// WHY NOT HARDCODE THE VERSION HERE: it would drift from package.json the
// first time someone bumps one and not the other, and the whole value of
// `--version` is that it is true.
//
// Both `src/package-info.ts` (run via tsx or vitest) and `dist/package-info.js`
// (the built CLI) sit exactly one directory below the package root, so the
// same `../package.json` resolves correctly in both — which is the only reason
// this trick is safe, and the reason nothing here may move into a subdirectory
// without revisiting it.
// =============================================================================

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version.length > 0) return version;
    }
  } catch {
    // Deliberately swallowed. A missing or unreadable package.json means an
    // unusual install, not a reason to refuse to run — every other command
    // still works, and printing `0.0.0-unknown` is a better outcome than a
    // stack trace at startup for something as peripheral as a version string.
  }
  return '0.0.0-unknown';
}

export const CLI_VERSION = readVersion();
