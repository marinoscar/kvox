/**
 * Resolution smoke test for the pinned platform packages. Resolves each
 * package.json only (the exports maps publish `./package.json`); no runtime
 * module of any package is loaded.
 */
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(here, '..', '..');
const ROOT = resolve(WEB_DIR, '..', '..');
const API_DIR = resolve(ROOT, 'apps', 'api');
const nodeRequire = createRequire(import.meta.url);

function manifestPath(pkg: string, from: string = WEB_DIR): string {
  return nodeRequire.resolve(`${pkg}/package.json`, { paths: [from] });
}

function versionOf(pkg: string): string {
  return JSON.parse(readFileSync(manifestPath(pkg), 'utf8')).version;
}

describe('platform package pin (web)', () => {
  const packages = ['@marinoscar/platform-web', '@marinoscar/platform-contract'];

  it.each(packages)('resolves %s', (pkg) => {
    expect(() => manifestPath(pkg)).not.toThrow();
  });

  it('installs one version across the packages, equal to the root pin', () => {
    const rootPin = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
      .devDependencies['@marinoscar/platform-contract'];
    const versions = packages.map(versionOf);

    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toBe(rootPin);
  });

  it('resolves one platform-contract instance from web and api', () => {
    const fromWeb = realpathSync(dirname(manifestPath('@marinoscar/platform-contract', WEB_DIR)));
    const fromApi = realpathSync(dirname(manifestPath('@marinoscar/platform-contract', API_DIR)));

    expect(fromApi).toBe(fromWeb);
  });
});
