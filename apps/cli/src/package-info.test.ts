import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CLI_VERSION } from './package-info.js';

// =============================================================================
// Package version, read at runtime (issue #140)
// =============================================================================

describe('CLI_VERSION', () => {
  it('matches the version in package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };

    expect(CLI_VERSION).toBe(pkg.version);
  });

  it('is a non-empty string and not the unreadable-package.json fallback', () => {
    expect(typeof CLI_VERSION).toBe('string');
    expect(CLI_VERSION.length).toBeGreaterThan(0);
    expect(CLI_VERSION).not.toBe('0.0.0-unknown');
  });
});
