import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  API_PATH_PREFIX,
  CLI_DISPLAY_NAME,
  CLI_NAME,
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  ENV_PREFIX,
  envVar,
} from './branding.js';

// =============================================================================
// Branding: the one-constant rule (issue #140)
// =============================================================================
//
// The whole point of branding.ts is that CLI_NAME is the single seed a fork
// edits. These tests assert the DERIVATION, not the literal value of
// CLI_NAME — so they keep passing (and keep proving the rule holds) if a
// fork ever renames `appctl` to something else. Only the package.json `bin`
// test below is allowed to compare against the live CLI_NAME value directly,
// because that comparison IS the guard the module's own comment asks for.
// =============================================================================

describe('CONFIG_DIR_NAME', () => {
  it('is derived from CLI_NAME with a leading dot', () => {
    expect(CONFIG_DIR_NAME).toBe(`.${CLI_NAME}`);
  });
});

describe('ENV_PREFIX', () => {
  it('is derived from CLI_NAME: uppercased with a trailing underscore', () => {
    expect(ENV_PREFIX).toBe(`${CLI_NAME.toUpperCase()}_`);
  });

  it('contains no hyphen, so it is a legal shell identifier prefix', () => {
    // A fork could rename to something with a hyphen (`acme-cli`); the
    // constant itself must already be shell-safe regardless of what CLI_NAME
    // happens to be today.
    expect(ENV_PREFIX).not.toMatch(/-/);
    expect(ENV_PREFIX).toMatch(/^[A-Z0-9_]+_$/);
  });
});

describe('envVar()', () => {
  it('prefixes the suffix with ENV_PREFIX', () => {
    expect(envVar('TOKEN')).toBe(`${ENV_PREFIX}TOKEN`);
    expect(envVar('SERVER_URL')).toBe(`${ENV_PREFIX}SERVER_URL`);
  });

  it('never lets a caller construct the prefix by hand and drift from it', () => {
    // The point of the function existing at all: envVar('X') and manual
    // concatenation of ENV_PREFIX + 'X' must be identical, always.
    expect(envVar('X')).toBe(`${ENV_PREFIX}X`);
  });
});

describe('CLI_DISPLAY_NAME', () => {
  it('is a non-empty human-readable string, independent of CLI_NAME', () => {
    expect(typeof CLI_DISPLAY_NAME).toBe('string');
    expect(CLI_DISPLAY_NAME.length).toBeGreaterThan(0);
  });
});

describe('CONFIG_FILE_NAME', () => {
  it('is not a filename a machine-level gitignore would silently swallow', () => {
    expect(CONFIG_FILE_NAME).not.toBe('credentials.json');
    expect(CONFIG_FILE_NAME).not.toBe('secrets.json');
  });
});

describe('API_PATH_PREFIX', () => {
  it("matches the API's global route prefix", () => {
    expect(API_PATH_PREFIX).toBe('/api');
  });
});

describe("package.json's bin field", () => {
  it('has exactly one key, and it equals CLI_NAME', () => {
    // THE ONE PLACE THE CONSTANT CANNOT REACH: npm reads package.json before
    // any code runs, so `bin` necessarily repeats the name as a literal. This
    // test is the guard against that literal drifting from CLI_NAME — the
    // implementer explicitly asked for it (branding.ts's own header comment).
    const here = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(here, '..', 'package.json');
    const raw = readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as { bin?: unknown };

    expect(pkg.bin).toBeTypeOf('object');
    const bin = pkg.bin as Record<string, unknown>;
    const keys = Object.keys(bin);

    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(CLI_NAME);
  });
});
