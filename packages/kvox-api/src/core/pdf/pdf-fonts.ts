import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// =============================================================================
// The bundled PDF faces, shared by every PDF exporter of the package (issue #493,
// epic #491; extracted from the web edition's `pdf/pdf-fonts.ts`, issues #28, #54)
// =============================================================================
//
// THE FONTS ARE BUNDLED, AND THE TARBALL CARRIES THEM. `node:24-alpine` ships NO
// fonts. A PDF exporter that relied on the host's installed families would render
// differently on a developer's machine and on the container, or fail outright - so
// the three faces ship in this package (`assets/fonts`, `OFL.txt` beside them, the
// licence they are distributed under) and the package's `files` list names the
// directory.
//
// WHERE THEY ARE: the directory is found from the package's own `package.json`, not
// from `__dirname` arithmetic. The same code runs from `src/` (ts-jest) and from
// `dist/` (two levels deeper in a compiled build), and a relative path that is right
// for one is wrong for the other. A host that keeps the fonts elsewhere passes
// `fontDir` (the `pdf.fontDir` option of the transcripts module).
//
// CJK AND RIGHT-TO-LEFT SCRIPTS ARE A DOCUMENTED LIMITATION, not a gap discovered
// later. Noto Sans covers Latin, Greek and Cyrillic and has no CJK glyphs at all;
// pdfkit performs no bidirectional reordering, so an Arabic or Hebrew paragraph
// renders with individually-correct glyphs in the wrong visual order.
// =============================================================================

/** The name this package publishes under; the root the fonts are found from. */
const PACKAGE_NAME = '@marinoscar/kvox-api';

/**
 * The root directory of this package: the nearest ancestor of this file whose
 * `package.json` names it.
 *
 * @returns the absolute path.
 * @throws Error when no such ancestor exists (a bundled copy of the code).
 */
function packageRoot(): string {
  let dir = __dirname;

  for (;;) {
    const manifest = resolve(dir, 'package.json');

    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };

        if (parsed.name === PACKAGE_NAME) return dir;
      } catch {
        // An unreadable manifest is not this package's; keep climbing.
      }
    }

    const parent = dirname(dir);

    if (parent === dir) {
      throw new Error(
        `Could not find the ${PACKAGE_NAME} package root from ${__dirname}; pass the PDF fonts directory with the "fontDir" option.`,
      );
    }

    dir = parent;
  }
}

/**
 * Where the three committed faces live: `assets/fonts` in this package.
 *
 * @returns the absolute path.
 * @stability experimental
 */
export function defaultPdfFontDir(): string {
  return resolve(packageRoot(), 'assets/fonts');
}

/**
 * The names the faces are registered under in a PDF document.
 *
 * @stability experimental
 */
export const PDF_FONTS = {
  /** The face for running text. */
  body: 'transcript-body',
  /** The face for bold text. */
  bold: 'transcript-bold',
  /** The face for monospaced text. */
  mono: 'transcript-mono',
} as const;

/**
 * Which file each registered name loads.
 *
 * @stability experimental
 */
export const PDF_FONT_FILES: Readonly<Record<string, string>> = {
  [PDF_FONTS.body]: 'NotoSans-Regular.ttf',
  [PDF_FONTS.bold]: 'NotoSans-Bold.ttf',
  [PDF_FONTS.mono]: 'NotoSansMono-Regular.ttf',
};

/**
 * Throws a message naming the directory and the missing files when a face is not
 * on disk, so a build that left the fonts out fails on the first export with a
 * sentence that says what to fix, rather than a pdfkit stack trace.
 *
 * @param fontDir - the fonts directory; the packaged one when absent.
 * @throws Error naming the missing files.
 * @stability experimental
 */
export function assertFontsPresent(fontDir: string = defaultPdfFontDir()): void {
  const missing = Object.values(PDF_FONT_FILES).filter((file) => !existsSync(resolve(fontDir, file)));

  if (missing.length > 0) {
    throw new Error(
      `The PDF exporter's bundled fonts are missing from ${fontDir}: ${missing.join(', ')}. ` +
        'They ship in the package under assets/fonts; an install that dropped that directory, ' +
        'or a host that points "fontDir" elsewhere without the files, cannot export PDFs.',
    );
  }
}

/**
 * A pdfkit document, as the PDF exporters' exported drawing helpers take it.
 *
 * Declared as `object` on purpose: pdfkit is an OPTIONAL peer, and a declaration
 * that named its types would make `skipLibCheck: false` fail in every host that
 * left pdfkit out (TS2307 in `export/pdf.exporter.d.ts`). The helpers narrow it
 * to pdfkit's own type inside the implementation, where `import type` is erased.
 *
 * @stability experimental
 */
export type KvoxPdfDocument = object;

/**
 * Registers the three faces with a pdfkit document under {@link PDF_FONTS}.
 *
 * @param pdf - a pdfkit document (anything with `registerFont`).
 * @param fontDir - the fonts directory; the packaged one when absent.
 * @stability experimental
 */
export function registerPdfFonts(
  pdf: { registerFont(name: string, path: string): unknown },
  fontDir: string = defaultPdfFontDir(),
): void {
  for (const [alias, file] of Object.entries(PDF_FONT_FILES)) {
    pdf.registerFont(alias, resolve(fontDir, file));
  }
}
