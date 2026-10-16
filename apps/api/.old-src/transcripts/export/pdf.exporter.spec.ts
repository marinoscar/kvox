import { APP_NAME } from '@app/shared';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import PDFDocument from 'pdfkit';

import {
  FONT_DIR,
  PdfTranscriptExporter,
  assertFontsPresent,
  exportFooterText,
} from './pdf.exporter';
import { SPEAKER_PALETTE, speakerColor } from './speaker-palette';
import { TranscriptExporterRegistry } from './transcript-exporter.interface';
import { fixtureDocument, longDocument } from './__fixtures__/document';
import { renderToBuffer } from './__fixtures__/collect';

// =============================================================================
// The PDF export (issue #28, epic #19, spec §8.4)
// =============================================================================
//
// Issue #28's acceptance criterion: "PDF smoke test: parses, multi-page output
// has a header and footer with page numbers, and a Unicode speaker name
// (e.g. 'José Núñez') renders".
//
// -----------------------------------------------------------------------------
// WHY THE TEXT IS ASSERTED THROUGH A SPY AND NOT BY READING THE PDF BACK
// -----------------------------------------------------------------------------
//
// pdfkit SUBSETS an embedded TrueType font: the content stream holds glyph
// indices into a subset, not characters, so "José Núñez" does not appear as
// text anywhere in the bytes even with compression off. Grepping the output
// would therefore prove nothing either way, and reading it properly needs a PDF
// text extractor this repository does not (and should not) depend on.
//
// So the render is REAL — a genuine pdfkit document, genuine font embedding,
// genuine pagination — and two different things are asserted about it:
//
//   * the BYTES, structurally: it starts `%PDF-`, ends `%%EOF`, and the page
//     tree's `/Count` (which pdfkit writes uncompressed) says how many pages
//     there are. That is what "parses" and "multi-page" mean here.
//   * the CONTENT, through a spy on `PDFDocument.prototype.text` that calls
//     through: every string the exporter asked pdfkit to draw, which is where
//     the footer's page numbers, the running header and the Unicode name are.
//
// And the Unicode claim is checked a third way, at the FONT: the embedded face
// is asked whether it has a glyph for `é` and `ñ`. A spy proves the exporter
// asked for the name; the glyph check proves the bundled font can draw it.
// =============================================================================

function exporter(): PdfTranscriptExporter {
  const instance = new PdfTranscriptExporter(new TranscriptExporterRegistry());

  instance.onModuleInit();

  return instance;
}

/** Every string the exporter drew, in order. */
function captureText(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const spy = jest
    .spyOn(PDFDocument.prototype, 'text')
    .mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === 'string') calls.push(args[0]);

      return originalText.apply(this, args as never) as never;
    });

  return { calls, restore: () => spy.mockRestore() };
}

// Captured BEFORE any spy replaces it, so the mock can call through.
const originalText = PDFDocument.prototype.text;

/** `/Count N` out of the page tree pdfkit writes uncompressed. */
function pageCount(pdf: Buffer): number {
  const match = /\/Count\s+(\d+)/.exec(pdf.toString('latin1'));

  return match ? Number(match[1]) : 0;
}

describe('the bundled fonts', () => {
  it('are all present where the exporter looks for them', () => {
    expect(() => assertFontsPresent()).not.toThrow();

    for (const file of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSansMono-Regular.ttf']) {
      expect(existsSync(resolve(FONT_DIR, file))).toBe(true);
    }
  });

  it('cover the Latin accents a Spanish or Portuguese name needs', () => {
    const pdf = new PDFDocument({ autoFirstPage: false });

    pdf.registerFont('probe', resolve(FONT_DIR, 'NotoSans-Regular.ttf'));
    pdf.font('probe');

    const font = (pdf as unknown as { _font: { font: { hasGlyphForCodePoint(cp: number): boolean } } })
      ._font.font;

    expect(font.hasGlyphForCodePoint(0x00e9)).toBe(true); // é
    expect(font.hasGlyphForCodePoint(0x00f1)).toBe(true); // ñ
    expect(font.hasGlyphForCodePoint(0x00b7)).toBe(true); // · in the footer
  });

  it('do NOT cover CJK — the documented v1 limitation, asserted so it stays known', () => {
    // Spec §8.4: CJK and RTL are a declared limitation of this version, fixed
    // later by bundling the relevant Noto families and adding a bidi pass. This
    // assertion exists so that the gap is a recorded fact rather than a
    // surprise somebody finds in a customer's export.
    const pdf = new PDFDocument({ autoFirstPage: false });

    pdf.registerFont('probe', resolve(FONT_DIR, 'NotoSans-Regular.ttf'));
    pdf.font('probe');

    const font = (pdf as unknown as { _font: { font: { hasGlyphForCodePoint(cp: number): boolean } } })
      ._font.font;

    expect(font.hasGlyphForCodePoint(0x4e2d)).toBe(false); // 中
  });
});

describe('exportFooterText', () => {
  it('is spec §8.4\'s line, with the app name from @app/shared', () => {
    expect(exportFooterText(2, 7, 4)).toBe(
      `Page 2 of 7 · Version 4 · Exported from ${APP_NAME}`,
    );
  });

  it('never hardcodes a product name', () => {
    // `apps/cli/src/template-identity.test.ts` scans this tree and fails the
    // build on a hardcoded product name; this is the same rule asserted where
    // somebody editing the footer would see it.
    expect(exportFooterText(1, 1, 1)).toContain(APP_NAME);
  });
});

describe('speakerColor', () => {
  it('returns the palette entry for an index inside it', () => {
    expect(speakerColor(0)).toBe(SPEAKER_PALETTE[0]);
    expect(speakerColor(3)).toBe(SPEAKER_PALETTE[3]);
  });

  it('cycles rather than clamping, so a ninth speaker is still coloured', () => {
    expect(speakerColor(SPEAKER_PALETTE.length)).toBe(SPEAKER_PALETTE[0]);
    expect(speakerColor(SPEAKER_PALETTE.length + 2)).toBe(SPEAKER_PALETTE[2]);
  });

  it('is total over nonsense', () => {
    expect(speakerColor(Number.NaN)).toBe(SPEAKER_PALETTE[0]);
    expect(speakerColor(-1)).toBe(SPEAKER_PALETTE[1]);
  });
});

describe('PdfTranscriptExporter', () => {
  it('registers itself', () => {
    const registry = new TranscriptExporterRegistry();

    new PdfTranscriptExporter(registry).onModuleInit();

    expect(registry.get('pdf')?.mimeType).toBe('application/pdf');
  });

  it('produces a PDF that parses', async () => {
    const pdf = await renderToBuffer(exporter(), fixtureDocument());

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('%%EOF');
    expect(pdf.byteLength).toBeGreaterThan(1_000);
  });

  it('renders a Unicode speaker name', async () => {
    const capture = captureText();

    try {
      await renderToBuffer(exporter(), fixtureDocument());

      expect(capture.calls).toContain('José Núñez');
    } finally {
      capture.restore();
    }
  });

  it('runs to several pages for a long transcript, and stamps every one', async () => {
    const capture = captureText();

    let pdf: Buffer;

    try {
      pdf = await renderToBuffer(exporter(), longDocument());

      const pages = pageCount(pdf);

      expect(pages).toBeGreaterThan(1);

      // The footer, on every page, with the running number and the total.
      for (let page = 1; page <= pages; page += 1) {
        expect(capture.calls).toContain(exportFooterText(page, pages, 4));
      }

      // The running header carries the title on every page after the cover —
      // and the cover itself draws it once more, at 22pt, which is why this
      // totals `pages` rather than `pages - 1`.
      expect(capture.calls.filter((call) => call === 'A very long conversation').length).toBe(
        pages,
      );
    } finally {
      capture.restore();
    }

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('draws the cover block: title, facts and each participant with their share', async () => {
    const capture = captureText();

    try {
      await renderToBuffer(exporter(), fixtureDocument());

      expect(capture.calls).toContain('Weekly sync — Sept 10');
      expect(capture.calls).toContain('Participants');
      expect(capture.calls.some((call) => call.includes('66.7%'))).toBe(true);
      expect(capture.calls.some((call) => call.startsWith('2026-09-10'))).toBe(true);
      expect(capture.calls).toContain('Edited by Oscar Marin');
    } finally {
      capture.restore();
    }
  });

  it('omits the cover block when asked, and still renders the body', async () => {
    const capture = captureText();

    try {
      await renderToBuffer(exporter(), fixtureDocument(), { includeCover: false });

      expect(capture.calls).not.toContain('Participants');
      expect(capture.calls).toContain('José Núñez');
    } finally {
      capture.restore();
    }
  });

  it('draws timestamps in the gutter, and drops them when asked', async () => {
    const withStamps = captureText();

    try {
      await renderToBuffer(exporter(), fixtureDocument());

      expect(withStamps.calls).toContain('00:00:08');
    } finally {
      withStamps.restore();
    }

    const without = captureText();

    try {
      await renderToBuffer(exporter(), fixtureDocument(), { includeTimestamps: false });

      expect(without.calls).not.toContain('00:00:08');
    } finally {
      without.restore();
    }
  });

  it('renders a transcript with no segments without throwing', async () => {
    const pdf = await renderToBuffer(exporter(), fixtureDocument({ segments: [] }));

    expect(pageCount(pdf)).toBe(1);
  });

  it('names an unknown speaker rather than drawing `undefined`', async () => {
    const capture = captureText();

    try {
      const doc = fixtureDocument();

      await renderToBuffer(exporter(), { ...doc, speakers: [] });

      expect(capture.calls).toContain('Unknown speaker');
    } finally {
      capture.restore();
    }
  });
});
