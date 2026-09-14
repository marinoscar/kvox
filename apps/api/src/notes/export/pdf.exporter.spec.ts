import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { APP_NAME } from '@app/shared';

import { FONT_DIR, assertFontsPresent } from '../../export/pdf-fonts';
import { NoteExporterRegistry } from './note-exporter.registry';
import { PdfNoteExporter, noteFooterText } from './pdf.exporter';
import { collect, noteDocument } from './__fixtures__/note-document';
import { extractPdfText } from './__fixtures__/pdf-text';

// =============================================================================
// The PDF note export (issue #54, docs/specs/notes.md §8.3)
// =============================================================================
//
// Issue #54 quotes VISION.md — documents that "feel intentionally produced
// rather than simply printed from a browser" — as the requirement, so the
// assertions here are about the document, not about a byte count:
//
//   * it is a real PDF whose TEXT can be read back, which is what lets the
//     provenance criterion be asserted "against extracted text, not just file
//     size";
//   * it reuses the SAME bundled Noto faces transcript export does (spec §8.3
//     names the fonts as shared infrastructure), so a note PDF and a transcript
//     PDF cannot drift into two typographic families;
//   * the footer names the version and the application, so a printed page found
//     on its own can still be traced back — and it does so through `APP_NAME`,
//     never a literal, which is what keeps a rebranded fork from shipping PDFs
//     footed with somebody else's product name.
// =============================================================================

describe('PdfNoteExporter', () => {
  const exporter = new PdfNoteExporter(new NoteExporterRegistry());

  it('registers itself as `pdf`', () => {
    const registry = new NoteExporterRegistry();

    new PdfNoteExporter(registry).onModuleInit();

    expect(registry.get('pdf')?.mimeType).toBe('application/pdf');
  });

  it('uses the bundled faces transcript export already ships', () => {
    // Not a second font set: the same three files, from the same directory.
    expect(() => assertFontsPresent()).not.toThrow();

    for (const file of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSansMono-Regular.ttf']) {
      expect(existsSync(resolve(FONT_DIR, file))).toBe(true);
    }
  });

  it('produces a readable PDF whose text names the source, template, version and time', async () => {
    const bytes = await collect(exporter, noteDocument());

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const text = await extractPdfText(bytes);

    expect(text).toContain('Weekly Sync Recap');
    expect(text).toContain('Weekly Sync');
    expect(text).toContain('Sep 12, 2026');
    expect(text).toContain('(transcript)');
    expect(text).toContain('Concise Meeting Notes');
    expect(text).toContain('Version 3');
    expect(text).toContain('2026-09-14T04:37:11.000Z');
  });

  it('renders every block kind of the body into the page text', async () => {
    const text = await extractPdfText(await collect(exporter, noteDocument()));

    expect(text).toContain('Summary');
    expect(text).toContain('Decisions');
    expect(text).toContain('Ship Markdown, PDF and Word');
    expect(text).toContain('Word is the one a colleague edits');
    expect(text).toContain('Draft the API');
    expect(text).toContain('Provenance travels with the export.');
    expect(text).toContain('const answer = 42;');
    expect(text).toContain('Closing paragraph.');
  });

  it('stamps a footer naming the page, the version and the product', async () => {
    const text = await extractPdfText(await collect(exporter, noteDocument()));

    expect(text).toContain(`Version 3 · Exported from ${APP_NAME}`);
  });

  it('omits the footer when page numbers are switched off', async () => {
    const text = await extractPdfText(
      await collect(exporter, noteDocument(), { includePageNumbers: false }),
    );

    expect(text).not.toContain('Page 1 of');
    // The provenance block is NOT an option and stays either way.
    expect(text).toContain('Concise Meeting Notes');
  });

  it('paginates a long note and numbers every page against the real total', async () => {
    const body = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} of a long note.`)
      .join('\n\n');
    const text = await extractPdfText(await collect(exporter, noteDocument({ body })));

    // `bufferPages` is what makes "of y" knowable; a renderer that stamped
    // "Page 1 of 1" on every page would still produce a plausible file, so the
    // assertion is that EVERY page agrees on a total greater than one.
    const totals = [...text.matchAll(/Page (\d+) of (\d+)/g)];

    expect(totals.length).toBeGreaterThan(1);
    expect(new Set(totals.map((match) => match[2])).size).toBe(1);
    expect(Number(totals[0]?.[2])).toBe(totals.length);
  });

  it('renders an empty note without throwing', async () => {
    const text = await extractPdfText(await collect(exporter, noteDocument({ body: '' })));

    expect(text).toContain('Concise Meeting Notes');
  });

  it('destroys the destination when the render fails, so nothing half-written is stored', async () => {
    const out = new PassThrough();

    out.resume();
    // A destroyed stream emits `error`; in production the upload pipeline is
    // the listener. Without one here Node raises ERR_UNHANDLED_ERROR and the
    // suite dies rather than failing an assertion.
    out.on('error', () => undefined);

    // A title pdfkit cannot lay out is hard to contrive, so the failure is
    // injected where the contract is actually observable: a document whose
    // provenance builder throws. What matters is that `out` is destroyed rather
    // than ended, because the upload treats a clean end as a complete file.
    const broken = noteDocument();

    Object.defineProperty(broken, 'title', {
      get() {
        throw new Error('boom');
      },
    });

    await expect(
      exporter.render(broken, exporter.optionsSchema.parse({}), out),
    ).rejects.toThrow('boom');
    expect(out.destroyed).toBe(true);
  });
});

describe('noteFooterText', () => {
  it('names the page, the total, the version and the product', () => {
    expect(noteFooterText(2, 7, 3)).toBe(
      `Page 2 of 7 · Version 3 · Exported from ${APP_NAME}`,
    );
  });
});
