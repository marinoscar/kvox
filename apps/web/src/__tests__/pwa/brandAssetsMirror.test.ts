/**
 * `apps/web/public` mirrors the brand files of `@marinoscar/kvox-web/brand`
 * (issue #628).
 *
 * The package (`packages/kvox-web/src/brand/assets|fonts`) holds the only copy; the
 * manifest, the service worker, `index.html` and the visual harness need fixed
 * URLs, so `scripts/sync-brand-assets.mjs` writes a byte-for-byte mirror into
 * `public/`. This is the same comparison as `npm run brand:check`, where
 * `npm run test:run` finds it: edit the package file, run
 * `node apps/web/scripts/sync-brand-assets.mjs`, commit both.
 *
 * The vector geometry itself (the SVGs against each other and against the inline
 * `BrandMark`) is tested in the package: `packages/kvox-web/test/brand/`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_DIR = join(__dirname, '..', '..', '..');
const PUBLIC_DIR = join(WEB_DIR, 'public');
const BRAND_DIR = join(WEB_DIR, '..', '..', 'packages', 'kvox-web', 'src', 'brand');

describe('apps/web/public mirrors the package brand files', () => {
  it('`sync-brand-assets.mjs --check` finds nothing out of step', () => {
    expect(() =>
      execFileSync('node', [join(WEB_DIR, 'scripts', 'sync-brand-assets.mjs'), '--check'], {
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('the font stylesheet resolves its font relative to itself, in the package and in the mirror', () => {
    for (const root of [join(BRAND_DIR, 'fonts'), join(PUBLIC_DIR, 'fonts')]) {
      const css = readFileSync(join(root, 'inter.css'), 'utf8');
      expect(css).toContain("url('./Inter-latin-variable.woff2')");
      expect(existsSync(join(root, 'Inter-latin-variable.woff2'))).toBe(true);
    }
  });
});
