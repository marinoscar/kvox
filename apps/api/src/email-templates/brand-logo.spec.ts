import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createEmailRenderContext } from '@marinoscar/platform-api/email';

import {
  EMAIL_LOGO_CID,
  EMAIL_LOGO_PATH,
  EMAIL_LOGO_RENDERED_SIZE,
  emailBrandMark,
  resetEmailLogoCacheForTests,
} from './brand-logo';

// =============================================================================
// The embedded email logo — tests
// =============================================================================
//
// The asset is committed, not generated at build time, and it is read from
// `apps/api/assets/email` at runtime by a path that has to resolve identically
// from `src/` under ts-jest and from `dist/` in the production image. Neither
// of those two facts fails loudly on its own:
//
//   * a missing or corrupt PNG produces a message with a broken image in it,
//     seen first by an invited stranger and never by CI;
//   * a wrong `..` count in the path resolves fine in development — where
//     `src/` is present — and is absent only in the container.
//
// So this file asserts against the REAL FILE ON DISK rather than a fixture,
// and checks the dist-side path arithmetic explicitly.
// =============================================================================

const apiRoot = resolve(__dirname, '../..');

describe('the committed email logo asset', () => {
  it('lives in the assets directory the production image already copies', () => {
    // `apps/api/assets` is copied by the Dockerfile's production stage (added
    // by #28 for the PDF fonts, asserted by
    // test/transcripts/transcript-export-assets.spec.ts). Putting the logo
    // under it is why this feature needed no Dockerfile change — and this
    // assertion is what would fail if somebody moved the asset somewhere that
    // is not copied.
    expect(EMAIL_LOGO_PATH).toBe(resolve(apiRoot, 'assets/email/logo.png'));
  });

  it('resolves to the same absolute path from dist/ as from src/', () => {
    // `brand-logo.ts` computes `resolve(__dirname, '../../../assets/email')`.
    // `src/email/templates` and `dist/email/templates` are the same depth
    // below `apps/api`, which is the entire reason there is no copy step and
    // no environment variable. Recomputing it here for the dist side is the
    // only way to catch a `..` miscount, since a test never runs from dist.
    const fromDist = resolve(
      apiRoot,
      'dist/email-templates',
      '../../assets/email/logo.png',
    );

    expect(fromDist).toBe(EMAIL_LOGO_PATH);
  });

  it('is a real 8-bit RGBA PNG at exactly twice the rendered size', () => {
    const bytes = readFileSync(EMAIL_LOGO_PATH);

    // PNG signature, then IHDR's fixed field offsets.
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.readUInt32BE(16)).toBe(EMAIL_LOGO_RENDERED_SIZE * 2);
    expect(bytes.readUInt32BE(20)).toBe(EMAIL_LOGO_RENDERED_SIZE * 2);
    expect(bytes[24]).toBe(8); // bit depth
    expect(bytes[25]).toBe(6); // colour type: RGBA
    expect(bytes[28]).toBe(0); // not interlaced
  });

  it('is inside the directory the production image copies', () => {
    // `apps/api/Dockerfile`'s production stage copies `dist`, `prisma`,
    // `scripts` and `assets` — an enumerated list, not the workspace. An image
    // missing this line BUILDS GREEN, STARTS FINE, and sends invitations with
    // a broken masthead that only an invited stranger ever sees.
    //
    // The line is already there (#28 added it for the PDF fonts) and
    // `test/transcripts/transcript-export-assets.spec.ts` already asserts it
    // for that feature. Asserted again here, in this feature's own file, so
    // removing PDF export some day does not silently take the email logo with
    // it.
    const dockerfile = readFileSync(resolve(apiRoot, 'Dockerfile'), 'utf8');
    const productionStage = dockerfile.slice(dockerfile.indexOf('AS production'));

    expect(dockerfile).toContain('AS production');
    expect(productionStage).toContain('COPY apps/api/assets ./apps/api/assets/');
  });

  it('is small enough to travel inside every copy of a message', () => {
    // Base64 inflates this by ~33%, once per recipient, inside the message
    // itself. A rebrand that drops a 500 KB photograph in here would not break
    // anything visibly — it would just make every invitation enormous, which
    // is exactly the kind of regression nobody notices without a number.
    expect(readFileSync(EMAIL_LOGO_PATH).byteLength).toBeLessThan(32 * 1024);
  });
});

describe('emailBrandMark', () => {
  beforeEach(() => {
    resetEmailLogoCacheForTests();
  });

  afterEach(() => {
    resetEmailLogoCacheForTests();
  });

  it('returns the asset as the layout brand mark: base64 bytes, the cid, the rendered size', () => {
    const mark = emailBrandMark();

    expect(mark).toBeDefined();
    expect(mark?.cid).toBe(EMAIL_LOGO_CID);
    expect(mark?.displaySize).toBe(EMAIL_LOGO_RENDERED_SIZE);
    expect(Buffer.from(mark?.pngBase64 ?? '', 'base64').equals(readFileSync(EMAIL_LOGO_PATH))).toBe(true);
  });

  it('reads the file once and hands back the same object afterwards', () => {
    const first = emailBrandMark();
    const second = emailBrandMark();

    expect(second).toBe(first);
  });

  it('carries no angle brackets on the cid — the layout writes src="cid:<id>"', () => {
    expect(EMAIL_LOGO_CID).not.toMatch(/[<>]/);
    expect(EMAIL_LOGO_CID.length).toBeGreaterThan(0);
  });

  it('is a brand mark the platform layout accepts (base64 with no prefix or line breaks)', () => {
    const mark = emailBrandMark();

    expect(mark?.pngBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(() => createEmailRenderContext({ appName: 'Test', layout: { brandMark: mark } })).not.toThrow();
  });

  it('returns undefined rather than throwing when the asset cannot be read', () => {
    const readSpy = jest
      .spyOn(require('node:fs'), 'readFileSync')
      .mockImplementation(() => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      });

    try {
      expect(emailBrandMark()).toBeUndefined();
      expect(emailBrandMark()).toBeUndefined();
      expect(readSpy).toHaveBeenCalledTimes(1);
    } finally {
      readSpy.mockRestore();
    }
  });
});
