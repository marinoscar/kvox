import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import {
  compareVersions,
  currentAppVersion,
  isSemver,
  parseSemver,
  setLockfileWorkspaceVersion,
  setManifestVersion,
  suggestBump,
  validateAppVersion,
} from './app-version.js';

// =============================================================================
// The version arithmetic  (issue #295, epic #168)
// =============================================================================
//
// Everything here is pure, so it is tested without a filesystem, a git or a
// deployment. The pipeline behaviour that USES it - the health gate, the
// rollback, the `.env` write - is `version-step.test.ts`.
// =============================================================================

describe('parseSemver', () => {
  it('accepts a release, a prerelease and build metadata', () => {
    expect(parseSemver('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('1.2.3-rc.1')).toMatchObject({ prerelease: ['rc', '1'] });
    expect(parseSemver('1.2.3+build.5')).toMatchObject({ build: ['build', '5'] });
  });

  it('refuses the near-misses rather than coercing them', () => {
    // Each of these is something a human plausibly types, and quietly
    // reinterpreting any of them means a server reports a number nobody chose.
    // `v1.2.3` in particular is the one that looks harmless: a leading `v` is
    // a tag convention, not part of a version.
    for (const value of ['v1.2.3', '1.2', '1.2.3.4', '01.2.3', 'latest', '', '1.2.3-']) {
      expect(isSemver(value)).toBe(false);
    }
  });

  it('trims surrounding whitespace, which a paste carries', () => {
    expect(parseSemver('  1.2.3  ')).toMatchObject({ major: 1, minor: 2, patch: 3 });
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.2', '1.0.10')).toBeLessThan(0);
  });

  it('sorts a prerelease BELOW its release, per SemVer §11', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBeLessThan(0);
    // Numeric identifiers sort below alphanumeric ones.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    // A larger set of fields wins when the preceding ones are equal.
    expect(compareVersions('1.0.0-rc.1.1', '1.0.0-rc.1')).toBeGreaterThan(0);
  });

  it('ignores build metadata, so it can never make a version "newer"', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });
});

describe('suggestBump', () => {
  it('suggests a patch bump', () => {
    expect(suggestBump('1.0.0')).toBe('1.0.1');
    expect(suggestBump('1.2.9')).toBe('1.2.10');
  });

  it('promotes a prerelease to its own release rather than patching it', () => {
    // `1.4.0` is the next version above `1.4.0-rc.2` by SemVer's own rule, and
    // it is what an operator putting a release candidate into production means.
    expect(suggestBump('1.4.0-rc.2')).toBe('1.4.0');
  });

  it('drops build metadata, which would otherwise not sort above the current', () => {
    expect(suggestBump('1.0.0+ci.7')).toBe('1.0.1');
  });

  it('falls back to 0.0.1 when there is nothing parseable to bump', () => {
    expect(suggestBump('0.0.0')).toBe('0.0.1');
    expect(suggestBump('nonsense')).toBe('0.0.1');
  });
});

describe('currentAppVersion', () => {
  it('takes the HIGHEST of the clone and the running deployment', () => {
    // THE POINT OF THE MAX: a publish that could not reach the repository
    // restores the clone, so the clone reports the old number while the `.env`
    // carries the deployed one. Measuring from the clone alone would suggest
    // the same number again and let the running version go backwards.
    expect(currentAppVersion({ api: '1.0.0', web: '1.0.0', env: '1.0.4' })).toBe('1.0.4');
    expect(currentAppVersion({ api: '1.1.0', web: '1.1.0', env: '1.0.4' })).toBe('1.1.0');
  });

  it('ignores an unparseable source rather than being defeated by it', () => {
    expect(currentAppVersion({ api: 'not-a-version', web: '1.2.3', env: undefined })).toBe('1.2.3');
  });

  it('answers 0.0.0 when nothing is readable', () => {
    expect(currentAppVersion({ api: undefined, web: undefined, env: undefined })).toBe('0.0.0');
  });
});

describe('validateAppVersion', () => {
  it('accepts a version that sorts above the current one', () => {
    expect(validateAppVersion('1.0.1', '1.0.0')).toBeUndefined();
    expect(validateAppVersion('2.0.0', '1.9.9')).toBeUndefined();
    expect(validateAppVersion('1.0.0', '1.0.0-rc.1')).toBeUndefined();
  });

  it('refuses anything that is not SemVer, and says so with an example', () => {
    const refusal = validateAppVersion('v1.0.1', '1.0.0');
    expect(refusal).toContain('not a valid SemVer version');
    expect(refusal).toContain('1.0.1');
    expect(validateAppVersion('1.0', '1.0.0')).toContain('not a valid SemVer');
    expect(validateAppVersion('', '1.0.0')).toBe('A version is required.');
  });

  it('refuses a version that moves the number BACKWARDS', () => {
    const refusal = validateAppVersion('1.3.9', '1.4.0');
    expect(refusal).toContain('sorts BELOW');
    expect(refusal).toContain('1.4.0');
    expect(refusal).toContain('--no-version-bump');
  });

  it('refuses the SAME version too, not only a regression', () => {
    // Re-deploying one number for two different builds is the same failure
    // with a smaller step size; `--no-version-bump` is how you say you meant it.
    const refusal = validateAppVersion('1.4.0', '1.4.0');
    expect(refusal).toContain('already deployed');
    expect(refusal).toContain('--no-version-bump');
  });

  it('refuses a build-metadata-only change, which does not sort above', () => {
    expect(validateAppVersion('1.4.0+rebuild', '1.4.0')).toContain('already deployed');
  });
});

describe('setManifestVersion', () => {
  it('edits a pretty-printed manifest and changes nothing else', () => {
    const before = `{\n  "name": "api",\n  "version": "1.0.0",\n  "scripts": {}\n}\n`;
    expect(setManifestVersion(before, '1.0.1')).toBe(
      `{\n  "name": "api",\n  "version": "1.0.1",\n  "scripts": {}\n}\n`,
    );
  });

  it('edits a MINIFIED manifest, which is legal JSON with no line structure', () => {
    expect(setManifestVersion('{"name":"api","version":"1.0.0"}', '2.0.0')).toBe(
      '{"name":"api","version":"2.0.0"}',
    );
  });

  it('edits the TOP-LEVEL version, not a nested one that appears first', () => {
    // The failure a regex would produce: rewriting a dependency constraint and
    // leaving the product version untouched.
    const before = `{\n  "engines": { "version": "9.9.9" },\n  "version": "1.0.0"\n}\n`;
    const after = setManifestVersion(before, '1.0.1');
    expect(after).toContain('"engines": { "version": "9.9.9" }');
    expect(JSON.parse(after)).toMatchObject({ version: '1.0.1' });
  });

  it('refuses a manifest with no top-level version rather than guessing', () => {
    expect(() => setManifestVersion('{"name":"api"}', '1.0.1')).toThrow(UsageError);
    expect(() => setManifestVersion('{"name":"api"}', '1.0.1')).toThrow(/--no-version-bump/);
  });

  it('refuses a version that is not a string', () => {
    expect(() => setManifestVersion('{"version":1}', '1.0.1')).toThrow(UsageError);
  });
});

describe('setLockfileWorkspaceVersion', () => {
  it('edits one workspace entry and leaves the other alone', () => {
    const before = `{\n  "packages": {\n    "apps/api": {\n      "version": "1.0.0"\n    },\n    "apps/web": {\n      "version": "1.0.0"\n    }\n  }\n}\n`;
    const after = setLockfileWorkspaceVersion(before, 'apps/api', '1.0.1');
    const parsed = JSON.parse(after) as { packages: Record<string, { version: string }> };
    expect(parsed.packages['apps/api']?.version).toBe('1.0.1');
    expect(parsed.packages['apps/web']?.version).toBe('1.0.0');
  });

  it('leaves a lockfile with no such workspace untouched, rather than failing', () => {
    const before = `{\n  "packages": {\n    "": { "name": "root" }\n  }\n}\n`;
    expect(setLockfileWorkspaceVersion(before, 'apps/api', '1.0.1')).toBe(before);
  });

  // =========================================================================
  // THE ASSERTION THAT KEEPS THE SURGICAL EDIT HONEST
  // =========================================================================
  // `setLockfileWorkspaceVersion` is used INSTEAD of `npm install
  // --package-lock-only` precisely because that command would resolve
  // dependency ranges against the registry mid-deploy and could move the
  // image's dependency tree. That trade is only sound while the lockfile
  // carries a workspace's version in exactly ONE place. If a future npm
  // format records it somewhere else as well, this fails rather than letting
  // the edit go quietly half-applied.
  it('covers every place THIS repository\'s real lockfile records those versions', () => {
    const lockPath = join(process.cwd(), '..', '..', 'package-lock.json');
    let raw: string;
    try {
      raw = readFileSync(lockPath, 'utf8');
    } catch {
      // A consumer running this suite from a packed tarball has no lockfile;
      // the unit cases above still hold.
      return;
    }

    const parsed = JSON.parse(raw) as {
      packages: Record<string, { version?: string }>;
    };
    const apiVersion = parsed.packages['apps/api']?.version;
    expect(typeof apiVersion).toBe('string');

    const edited = setLockfileWorkspaceVersion(raw, 'apps/api', '99.99.99');
    const after = JSON.parse(edited) as { packages: Record<string, { version?: string }> };

    expect(after.packages['apps/api']?.version).toBe('99.99.99');
    // Nothing anywhere else in the document still claims the old number for
    // this workspace, under any key.
    const entriesNamingApi = Object.entries(after.packages).filter(
      ([name]) => name === 'apps/api' || name.endsWith('/api'),
    );
    for (const [, entry] of entriesNamingApi) {
      expect(entry.version === apiVersion).toBe(false);
    }
  });
});
