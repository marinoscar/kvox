import { WordNoteExporter } from './word.exporter';
import { NoteExporterRegistry } from './note-exporter.registry';
import { collect, noteDocument } from './__fixtures__/note-document';
import { docxText, readZipEntry, zipEntries } from './__fixtures__/docx-text';

// =============================================================================
// The Word export (issue #54, docs/specs/notes.md §8.3)
// =============================================================================
//
// THE FIRST `docx` EXPORTER IN THIS CODEBASE, so this suite has to establish
// more than "it produced bytes":
//
//   * the bytes are a real OOXML package a reader will open — asserted by
//     unzipping it and finding the parts Word requires, not by a length check;
//   * the PROVENANCE BLOCK IS IN THE EXTRACTED TEXT, which is issue #54's own
//     acceptance criterion ("asserted against extracted text, not just file
//     size") and the reason `__fixtures__/docx-text.ts` exists;
//   * every block kind the markdown subset supports reaches the document, since
//     a renderer's block switch is where a format quietly stops rendering
//     something the other two still render.
// =============================================================================

describe('WordNoteExporter', () => {
  const exporter = new WordNoteExporter(new NoteExporterRegistry());

  it('registers itself as `docx` with a real Word content type', () => {
    const registry = new NoteExporterRegistry();

    new WordNoteExporter(registry).onModuleInit();

    expect(registry.get('docx')?.extension).toBe('docx');
    expect(registry.get('docx')?.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('produces a ZIP carrying the parts a Word reader requires', async () => {
    const bytes = await collect(exporter, noteDocument());

    // A ZIP local file header. A `.docx` that does not start with one will not
    // open anywhere.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    const entries = zipEntries(bytes);

    expect(entries).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'word/document.xml', 'word/numbering.xml']),
    );
  });

  it('names the source, template, version and timestamp in its text', async () => {
    const text = docxText(await collect(exporter, noteDocument()));

    expect(text).toContain('Weekly Sync Recap');
    expect(text).toContain('Source: Weekly Sync — Sep 12, 2026 (transcript)');
    expect(text).toContain('Template: Concise Meeting Notes');
    expect(text).toContain('Note version: Version 3');
    expect(text).toContain('Exported: 2026-09-14T04:37:11.000Z');
  });

  it('renders every block kind of the body', async () => {
    const text = docxText(await collect(exporter, noteDocument()));

    expect(text).toContain('Summary');
    expect(text).toContain('Decisions');
    // Emphasis is a run property, so the WORDS survive the tag strip even
    // though the marks do not — which is exactly what "no content is lost"
    // means for this assertion.
    expect(text).toContain('ship');
    expect(text).toContain('Word is the one a colleague edits');
    expect(text).toContain('Draft the API');
    expect(text).toContain('Provenance travels with the export.');
    expect(text).toContain('const answer = 42;');
    expect(text).toContain('Closing paragraph.');
  });

  it('carries the note title in a running header on every page', async () => {
    const bytes = await collect(exporter, noteDocument());
    const headers = zipEntries(bytes).filter((entry) => /word\/header\d*\.xml/.test(entry));

    expect(headers.length).toBeGreaterThan(0);
    expect(docxText(bytes, headers[0] as string)).toContain('Weekly Sync Recap');
  });

  it('puts page numbers in a footer as FIELD CODES, and honours the option', async () => {
    const withNumbers = await collect(exporter, noteDocument());
    const footers = zipEntries(withNumbers).filter((entry) => /word\/footer\d*\.xml/.test(entry));

    expect(footers.length).toBeGreaterThan(0);

    const xml = readZipEntry(withNumbers, footers[0] as string)?.toString('utf8') ?? '';

    // ⚠ `PAGE`/`NUMPAGES` INSTRUCTION TEXT, not a counted number. Word
    // recomputes these on open, so a reader who edits the document keeps
    // correct numbering — which a baked-in "Page 3 of 7" would not.
    expect(xml).toContain('PAGE');
    expect(xml).toContain('NUMPAGES');

    const without = await collect(exporter, noteDocument(), { includePageNumbers: false });

    expect(zipEntries(without).filter((entry) => /word\/footer\d*\.xml/.test(entry))).toEqual([]);
  });

  it('renders an empty note without throwing', async () => {
    // A note whose generation failed before writing anything still has to be
    // exportable: the provenance is the part the user needs.
    const text = docxText(await collect(exporter, noteDocument({ body: '' })));

    expect(text).toContain('Template: Concise Meeting Notes');
  });

  it('renders a `plain_text` body literally — no heading, no bold, no bullet (#334)', async () => {
    const PLAIN_BODY = ['# not a heading', 'second line of *not bold*', '', '- not a bullet'].join('\n');
    const bytes = await collect(
      exporter,
      noteDocument({ body: PLAIN_BODY, bodyFormat: 'plain_text' }),
    );
    const xml = readZipEntry(bytes, 'word/document.xml')?.toString('utf8') ?? '';
    const text = docxText(bytes);

    expect(text).toContain('# not a heading');
    expect(text).toContain('*not bold*');
    expect(text).toContain('- not a bullet');
    // No run is bold and no paragraph is numbered: nothing was interpreted.
    expect(xml).not.toMatch(/<w:numPr>/);
    expect(xml).not.toContain('Heading1');
    // The single line break inside the first paragraph survives as a break.
    expect(xml).toContain('<w:br/>');
  });

  it('still parses a `markdown` body as Markdown', async () => {
    const xml =
      readZipEntry(
        await collect(exporter, noteDocument({ body: '# A heading', bodyFormat: 'markdown' })),
        'word/document.xml',
      )?.toString('utf8') ?? '';

    expect(xml).toContain('Heading1');
    expect(xml).not.toContain('# A heading');
  });

  it('escapes XML-special characters in the body rather than emitting them raw', async () => {
    const bytes = await collect(
      exporter,
      noteDocument({ body: 'Rates < 5% and margins > 3% "quoted"' }),
    );
    const xml = readZipEntry(bytes, 'word/document.xml')?.toString('utf8') ?? '';

    expect(xml).toContain('&lt; 5% and margins &gt;');
    expect(docxText(bytes)).toContain('Rates < 5% and margins > 3% "quoted"');
  });
});
