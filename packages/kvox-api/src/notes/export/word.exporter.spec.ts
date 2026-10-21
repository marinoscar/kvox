import { WordNoteExporter } from './word.exporter.js';
import { NoteExporterRegistry } from './note-exporter.registry.js';
import {
  collect,
  docxText,
  noteDocument,
  readZipEntry,
  RICH_NOTE_BODY,
  zipEntries,
} from '../testing/export-fixtures.js';

const part = (bytes: Buffer, name: string): string => readZipEntry(bytes, name)?.toString('utf8') ?? '';

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

// The first render rasterises the brand mark and loads `docx`: slow on a cold worker.
jest.setTimeout(60_000);

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
    // The provenance card is a label/value table: each pair is two cells (labels are uppercased
    // by a run property, so the stored text keeps its case).
    expect(text).toMatch(/Source\nWeekly Sync — Sep 12, 2026 \(transcript\)/);
    expect(text).toMatch(/Template\nConcise Meeting Notes/);
    expect(text).toMatch(/Note version\nVersion 3/);
    expect(text).toMatch(/Exported\n2026-09-14T04:37:11.000Z/);
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

    // Two headers: the first-page masthead and the running header of pages 2+.
    expect(headers).toHaveLength(2);
    expect(headers.some((h) => docxText(bytes, h).includes('Weekly Sync Recap'))).toBe(true);
    expect(headers.every((h) => docxText(bytes, h).includes('KVox'))).toBe(true);
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

    expect(text).toContain('Concise Meeting Notes');
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
  describe('design', () => {
    const rich = () => collect(exporter, noteDocument({ body: RICH_NOTE_BODY }));

    it('embeds the brand mark as SVG with a PNG fallback', async () => {
      const entries = zipEntries(await rich());

      expect(entries.some((e) => /^word\/media\/.*\.png$/.test(e))).toBe(true);
      expect(entries.some((e) => /^word\/media\/.*\.svg$/.test(e))).toBe(true);
      expect(entries).toEqual(
        expect.arrayContaining(['word/header1.xml', 'word/header2.xml', 'word/footer1.xml', 'word/footer2.xml']),
      );
    });

    it('declares the brand in the styles, not only in runs', async () => {
      const styles = part(await rich(), 'word/styles.xml');

      expect(styles).toContain('4F46E5');
      for (const id of ['Heading1', 'Heading6', 'Title', 'Hyperlink', 'Code', 'Quote', 'InlineCode']) {
        expect(styles).toContain(`w:styleId="${id}"`);
        // No style id is declared twice (Word would reject or merge them unpredictably).
        expect(styles.split(`w:styleId="${id}"`).length - 1).toBe(1);
      }
      expect(styles).toContain('Calibri');
      expect(styles).toContain('Consolas');
    });

    it('uses a first-page header and sets document properties', async () => {
      const bytes = await rich();

      expect(part(bytes, 'word/document.xml')).toContain('<w:titlePg/>');
      expect(part(bytes, 'docProps/core.xml')).toContain('Note version 3');
      expect(part(bytes, 'docProps/core.xml')).toContain('Concise Meeting Notes');
    });

    it('renders tables with a repeating header row, equal cell counts and cantSplit rows', async () => {
      const xml = part(await rich(), 'word/document.xml');

      expect(xml).toContain('<w:tblHeader/>');
      expect(xml).toContain('<w:cantSplit/>');
      expect(xml).toContain('<w:tblLayout w:type="fixed"/>');

      const body = xml.slice(xml.indexOf('Hosting') - 2000);
      const table = body.slice(body.indexOf('<w:tbl>'), body.indexOf('</w:tbl>'));

      for (const row of table.split('<w:tr>').slice(1)) {
        expect(row.split('<w:tc>').length - 1).toBe(4);
      }
    });

    it('survives degenerate tables without producing empty cells', async () => {
      const wide = Array.from({ length: 20 }, (_, i) => `c${i}`);
      const body = [
        `| ${wide.join(' | ')} |`,
        `| ${wide.map(() => '---').join(' | ')} |`,
        `| ${wide.map((_, i) => (i % 2 ? '' : 'x')).join(' | ')} |`,
        '',
        '| A | B |',
        '| - | - |',
      ].join('\n');
      const xml = part(await collect(exporter, noteDocument({ body })), 'word/document.xml');

      for (const cell of xml.split('<w:tc>').slice(1)) {
        expect(cell.slice(0, cell.indexOf('</w:tc>'))).toContain('<w:p>');
      }
      expect(xml).toContain('c19');
    });

    it('restarts numbering for each ordered list and honours a start value', async () => {
      const body = ['1. a', '2. b', '', 'between', '', '1. c', '', 'again', '', '5. five', '6. six'].join('\n');
      const bytes = await collect(exporter, noteDocument({ body }));
      const xml = part(bytes, 'word/document.xml');
      const numbering = part(bytes, 'word/numbering.xml');
      const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
      const distinct = [...new Set(ids)];

      expect(distinct).toHaveLength(3);
      expect(ids).toEqual([distinct[0], distinct[0], distinct[1], distinct[2], distinct[2]]);

      // The list starting at 5 resolves to an abstract numbering whose level 0 starts at 5.
      const fiveNum = distinct[2] as string;
      const abstractId = new RegExp(`<w:num w:numId="${fiveNum}"[^>]*><w:abstractNumId w:val="(\\d+)"`).exec(
        numbering,
      )?.[1] as string;
      const abstract = numbering.slice(numbering.indexOf(`<w:abstractNum w:abstractNumId="${abstractId}"`));

      expect(abstract.slice(0, abstract.indexOf('</w:lvl>'))).toContain('<w:start w:val="5"/>');
    });

    it('renders task items with checkbox glyphs and no numbering', async () => {
      const bytes = await collect(exporter, noteDocument({ body: '- [x] done thing\n- [ ] open thing' }));
      const xml = part(bytes, 'word/document.xml');

      expect(xml).toContain('☑');
      expect(xml).toContain('☐');
      expect(xml).not.toContain('<w:numPr>');
    });

    it('keeps code in a Code style, preserving leading spaces and escaping', async () => {
      const xml = part(
        await collect(
          exporter,
          noteDocument({ body: '```html\n<div>\n    indented & "quoted"\n</div>\n```' }),
        ),
        'word/document.xml',
      );

      expect(xml).toContain('w:val="Code"');
      expect(xml).toContain('xml:space="preserve">    indented &amp; &quot;quoted&quot;');
      expect(xml).toContain('&lt;div&gt;');
      expect(xml).toContain('HTML');
    });

    it('puts quotes in the Quote style and links in Hyperlink runs', async () => {
      const xml = part(await rich(), 'word/document.xml');

      expect(xml).toContain('w:val="Quote"');
      expect(xml).toContain('w:val="Hyperlink"');
    });

    it('mentions the footer fields and the version line', async () => {
      const bytes = await rich();
      const footer = part(bytes, 'word/footer1.xml') + part(bytes, 'word/footer2.xml');

      expect(docxText(bytes, 'word/footer1.xml')).toContain('Version 3 · Exported from KVox');
      expect(footer).toContain('NUMPAGES');
    });
  });
});
