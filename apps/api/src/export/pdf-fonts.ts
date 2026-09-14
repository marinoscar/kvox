// =============================================================================
// The bundled PDF faces, shared by every PDF exporter (issue #54)
// =============================================================================
//
// Extracted from `transcripts/export/pdf.exporter.ts` (issue #28) so that the
// note PDF exporter uses THE SAME THREE FILES rather than a second font set —
// `docs/specs/notes.md` §8.3 names the fonts and the streaming `render`
// contract as the two pieces of infrastructure genuinely shared between
// transcript and note PDFs, and this is the first of them.
//
// -----------------------------------------------------------------------------
// THE FONTS ARE BUNDLED, AND THE IMAGE MUST COPY THEM
// -----------------------------------------------------------------------------
//
// `node:24-alpine` ships NO fonts. A PDF exporter that relied on the host's
// installed families would render differently on a developer's machine and on
// the container, or fail outright — so the three faces are committed to this
// repository and `apps/api/Dockerfile`'s production stage has a `COPY` for the
// `assets` directory. `test/transcripts/transcript-export-assets.spec.ts`
// asserts that COPY exists, because the failure mode without it is an image
// that builds green, starts fine, and throws on the first export anybody asks
// for.
//
// `FONT_DIR` resolves the same way from `src/` and from `dist/`
// (`apps/api/<either>/export/../../assets/fonts`), which is why there is no
// environment variable and no build-time copy step.
//
// ⚠ CJK AND RIGHT-TO-LEFT SCRIPTS ARE A DOCUMENTED LIMITATION, not a gap
// discovered later. Noto Sans covers Latin, Greek and Cyrillic and has no CJK
// glyphs at all; pdfkit performs no bidirectional reordering, so an Arabic or
// Hebrew paragraph renders with individually-correct glyphs in the wrong visual
// order. It applies identically to note PDFs, because they are the same faces
// and the same engine.
// =============================================================================

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Where the three committed faces live. See the header for the path rule. */
export const FONT_DIR = resolve(__dirname, '../../assets/fonts');

/**
 * pdfkit font aliases, so no call site repeats a filename.
 *
 * Product-neutral on purpose: these are internal handles pdfkit resolves
 * `doc.font(...)` against, never anything a reader sees, and a rebrand must not
 * have to touch them (`apps/cli/src/template-identity.test.ts` enforces that).
 *
 * ⚠ THE VALUES ARE UNCHANGED FROM ISSUE #28's ORIGINALS. They are registered
 * per `PDFDocument`, so two exporters sharing them cannot collide — and
 * renaming them would be a change with no benefit and one way to be wrong.
 */
export const PDF_FONTS = {
  body: 'transcript-body',
  bold: 'transcript-bold',
  mono: 'transcript-mono',
} as const;

/** Alias → the committed file that backs it. */
export const FONT_FILES: Record<string, string> = {
  [PDF_FONTS.body]: 'NotoSans-Regular.ttf',
  [PDF_FONTS.bold]: 'NotoSans-Bold.ttf',
  [PDF_FONTS.mono]: 'NotoSansMono-Regular.ttf',
};

/** Fail with a sentence an operator can act on, not with ENOENT from fontkit. */
export function assertFontsPresent(): void {
  const missing = Object.values(FONT_FILES).filter((file) => !existsSync(resolve(FONT_DIR, file)));

  if (missing.length > 0) {
    throw new Error(
      `The PDF exporter's bundled fonts are missing from ${FONT_DIR}: ${missing.join(', ')}. ` +
        'They are committed under apps/api/assets/fonts and the production image copies that ' +
        'directory; an image built without that COPY cannot export PDFs.',
    );
  }
}

/** Register all three aliases on one pdfkit document. */
export function registerExportFonts(pdf: {
  registerFont(name: string, path: string): unknown;
}): void {
  for (const [alias, file] of Object.entries(FONT_FILES)) {
    pdf.registerFont(alias, resolve(FONT_DIR, file));
  }
}
