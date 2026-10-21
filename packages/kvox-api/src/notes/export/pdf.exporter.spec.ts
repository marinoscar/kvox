import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { DEFAULT_KVOX_BRAND, assertFontsPresent, defaultPdfFontDir } from '../../core/index.js';
import { NoteExporterRegistry } from './note-exporter.registry.js';
import { PdfNoteExporter, noteFooterText } from './pdf.exporter.js';
import { RICH_NOTE_BODY, collect, extractPdfText, noteDocument } from '../testing/export-fixtures.js';

// The product name comes from the host's brand port, never a literal; the default brand is the
// one a host that binds none gets.
const APP_NAME = DEFAULT_KVOX_BRAND.appName;

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
      expect(existsSync(resolve(defaultPdfFontDir(), file))).toBe(true);
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

  it('renders a `plain_text` body literally — markup characters stay text (#334)', async () => {
    const PLAIN_BODY = ['# not a heading', 'second line of *not bold*', '', '- not a bullet'].join('\n');
    const text = await extractPdfText(
      await collect(exporter, noteDocument({ body: PLAIN_BODY, bodyFormat: 'plain_text' })),
    );

    expect(text).toContain('# not a heading');
    expect(text).toContain('*not bold*');
    expect(text).toContain('- not a bullet');
  });

  it('strips Markdown syntax from a `markdown` body, as before', async () => {
    const text = await extractPdfText(
      await collect(exporter, noteDocument({ body: '# A heading\n\n*emphasis*' })),
    );

    expect(text).toContain('A heading');
    expect(text).not.toContain('# A heading');
    expect(text).not.toContain('*emphasis*');
  });

  it('names the host\'s brand in the footer and the document info when one is bound', async () => {
    const branded = new PdfNoteExporter(new NoteExporterRegistry(), { appName: 'Acme Notes', appSlug: 'acme-notes' });
    const text = await extractPdfText(await collect(branded, noteDocument()));

    expect(text).toContain('Version 3 · Exported from Acme Notes');
    expect(text).not.toContain(`Exported from ${APP_NAME}`);
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

  describe('rich bodies', () => {
    const render = async (body: string): Promise<string> =>
      extractPdfText(await collect(exporter, noteDocument({ body })));

    const pageTotals = (text: string): { pages: number; totals: Set<string> } => {
      const matches = [...text.matchAll(/Page (\d+) of (\d+)/g)];

      return { pages: matches.length, totals: new Set(matches.map((m) => m[2]!)) };
    };

    it('renders the rich fixture: table cells, tasks, autolink, no raw delimiters', async () => {
      const text = await render(RICH_NOTE_BODY);

      for (const expected of ['Item', 'Owner', 'Cost', 'Status', 'Hosting', 'Licences', '1,200', 'declined']) {
        expect(text).toContain(expected);
      }

      expect(text).not.toContain('|---');
      expect(text).not.toContain('| :---');
      expect(text).toContain('Send the minutes');
      expect(text).toContain('Book the venue');
      expect(text).toContain('Confirm the budget with finance');
      expect(text).toContain('https://example.test/risks');
      expect(text).toContain('[roadmap]'.slice(1, -1));
      expect(text).toContain('Revisit in Q4');
      expect(text).toContain('Provenance travels with the export.');
      expect(text).toContain('export const answer: number = 42;');
      expect(text).toContain('Exported Sep 14, 2026');
    });

    it('paginates a code block of more than 1000 lines with a consistent total', async () => {
      const code = Array.from({ length: 1200 }, (_, i) => `line ${i} of the code`).join('\n');
      const text = await render(['```txt', code, '```'].join('\n'));
      const { pages, totals } = pageTotals(text);

      expect(pages).toBeGreaterThan(10);
      expect(totals.size).toBe(1);
      expect(Number([...totals][0])).toBe(pages);
      expect(text).toContain('line 0 of the code');
      expect(text).toContain('line 1199 of the code');
    });

    it('paginates a 300-row table and repeats the header on every page', async () => {
      const rows = Array.from({ length: 300 }, (_, i) => `| row${i} | value${i} |`).join('\n');
      const text = await render(`| Alpha | Beta |\n| --- | --- |\n${rows}`);
      const { pages, totals } = pageTotals(text);

      expect(pages).toBeGreaterThan(3);
      expect(totals.size).toBe(1);
      expect(text.match(/Alpha/g)!.length).toBeGreaterThanOrEqual(pages - 1);
      expect(text).toContain('row0');
      expect(text).toContain('row299');
      expect(text).toContain('value299');
    });

    it('renders a 20-column table', async () => {
      const header = Array.from({ length: 20 }, (_, i) => `H${i}`);
      const row = Array.from({ length: 20 }, (_, i) => `c${i}`);
      const text = await render(
        [`| ${header.join(' | ')} |`, `|${' --- |'.repeat(20)}`, `| ${row.join(' | ')} |`].join('\n'),
      );

      expect(text).toContain('H19');
      expect(text).toContain('c19');
    });

    it('renders a table with no body rows and one with an empty header', async () => {
      const headerOnly = await render('| Only | Header |\n| --- | --- |');

      expect(headerOnly).toContain('Only');

      const blankHeader = await render('|  |  |\n| --- | --- |\n| a | b |\n\nAfter the table.');

      expect(blankHeader).toContain('After the table.');
    });

    it('wraps a very long unbroken URL and word instead of overflowing or looping', async () => {
      const url = `https://example.test/${'segment/'.repeat(80)}end`;
      const word = 'x'.repeat(400);
      const text = await render(`See <${url}> now.\n\n${word}\n\n- ${word}`);
      const flat = text.replace(/\s+/g, '');

      expect(flat).toContain(url);
      expect(flat).toContain(word);
    });

    it('survives deeply nested lists and quotes, and a quote that crosses a page', async () => {
      const nested = Array.from({ length: 10 }, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n');
      const longQuote = Array.from({ length: 120 }, (_, i) => `> quoted line ${i}\n>`).join('\n');
      const text = await render(`${nested}\n\n${longQuote}`);
      const { pages, totals } = pageTotals(text);

      expect(text).toContain('level 9');
      expect(text).toContain('quoted line 119');
      expect(pages).toBeGreaterThan(1);
      expect(totals.size).toBe(1);
    });
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
