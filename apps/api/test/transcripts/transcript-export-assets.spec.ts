import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// =============================================================================
// The PDF exporter's bundled assets reach the production image (issue #28)
// =============================================================================
//
// `node:24-alpine` ships no fonts at all, so the three Noto faces committed
// under `apps/api/assets/fonts` are not a fallback for a missing system family
// — they are the only typography the image has. The production stage copies
// `dist/` and an enumerated list of directories; an image built without the
// `assets` line BUILDS GREEN, STARTS FINE, and throws on the first PDF export
// anybody asks for. Nothing else in CI would catch that: no PR job builds
// images, and the smoke job boots from the workspace checkout, where the files
// are present regardless.
//
// This is the same rule `production-image.spec.ts` asserts for `scripts/`, in
// its own file because it is about a different feature's assets rather than
// about npm-script entry points.
// =============================================================================

const apiRoot = resolve(__dirname, '../..');

const FONT_FILES = [
  'NotoSans-Regular.ttf',
  'NotoSans-Bold.ttf',
  'NotoSansMono-Regular.ttf',
];

function read(relativePath: string): string {
  return readFileSync(resolve(apiRoot, relativePath), 'utf8');
}

/** The `production` stage only; earlier stages copy the whole workspace. */
function productionStage(dockerfile: string): string {
  const index = dockerfile.indexOf('AS production');

  expect(index).toBeGreaterThan(-1);

  return dockerfile.slice(index);
}

describe('the bundled export fonts', () => {
  it('are committed, and are real files rather than LFS pointers', () => {
    for (const file of FONT_FILES) {
      const stats = statSync(resolve(apiRoot, 'assets/fonts', file));

      // A Git-LFS pointer is a ~130-byte text file. A real TrueType face is
      // hundreds of kilobytes, so the size alone tells the two apart — and an
      // image that shipped pointers would fail exactly like a missing COPY.
      expect(stats.size).toBeGreaterThan(100_000);
    }
  });

  it('ship with the licence they are distributed under', () => {
    // The SIL Open Font License requires the licence to travel with the fonts,
    // and these are redistributed inside every image built from this repo.
    const licence = read('assets/fonts/OFL.txt');

    expect(licence).toMatch(/SIL OPEN FONT LICENSE/i);
  });

  it('contain nothing but the three faces and the licence', () => {
    // Everything in this directory is copied into the production image, so an
    // unrelated file landing here is a file shipped to every deployment.
    expect(readdirSync(resolve(apiRoot, 'assets/fonts')).sort()).toEqual(
      [...FONT_FILES, 'OFL.txt'].sort(),
    );
  });
});

describe('the api production image', () => {
  const stage = productionStage(read('Dockerfile'));

  it('copies the assets directory the PDF exporter reads its fonts from', () => {
    expect(stage).toContain('COPY apps/api/assets ./apps/api/assets/');
  });

  it('lands them where the compiled exporter resolves them from', () => {
    // `FONT_DIR` is `resolve(__dirname, '../../../assets/fonts')`, which from
    // `dist/transcripts/export` is `apps/api/assets/fonts` — the same path it
    // resolves to from `src/transcripts/export`, which is why there is no
    // environment variable and no build-time copy step.
    expect(stage).toContain('WORKDIR /app/apps/api');
    expect(stage).toMatch(/COPY apps\/api\/assets \.\/apps\/api\/assets\//);
  });
});
