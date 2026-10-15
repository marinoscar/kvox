/**
 * Resolution smoke test for the pinned platform packages. Resolves each
 * package.json only (the exports maps publish `./package.json`); no runtime
 * module of any package is loaded.
 */
import { realpathSync } from 'fs';
import { dirname, resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..', '..');
const API_DIR = resolve(__dirname, '..');
const WEB_DIR = resolve(ROOT, 'apps', 'web');

function manifestPath(pkg: string, from: string = API_DIR): string {
  return require.resolve(`${pkg}/package.json`, { paths: [from] });
}

function versionOf(pkg: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(manifestPath(pkg)).version;
}

describe('platform package pin (api)', () => {
  const packages = [
    '@marinoscar/platform-api',
    '@marinoscar/platform-contract',
    '@marinoscar/platform-db',
  ];

  it.each(packages)('resolves %s', (pkg) => {
    expect(() => manifestPath(pkg)).not.toThrow();
  });

  it('installs one version across the packages, equal to the root pin', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rootPin = require(resolve(ROOT, 'package.json')).devDependencies[
      '@marinoscar/platform-contract'
    ];
    const versions = packages.map(versionOf);

    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toBe(rootPin);
  });

  it('resolves one platform-contract instance from api and web', () => {
    const fromApi = realpathSync(dirname(manifestPath('@marinoscar/platform-contract', API_DIR)));
    const fromWeb = realpathSync(dirname(manifestPath('@marinoscar/platform-contract', WEB_DIR)));

    expect(fromWeb).toBe(fromApi);
  });
});
