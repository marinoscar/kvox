import { MarkdownNoteExporter } from './markdown.exporter';
import { NoteExporterRegistry } from './note-exporter.registry';
import { FIXTURE_BODY, collect, noteDocument } from './__fixtures__/note-document';

// =============================================================================
// The Markdown export (issue #54, docs/specs/notes.md §8.3)
// =============================================================================
//
// The property this suite exists for is BYTE FAITHFULNESS: the stored body
// comes out unaltered. `markdown-ast.ts` exists for the PDF and DOCX
// renderers, and a markdown export that round-tripped through it would rewrite
// a user's own careful formatting — a table, a footnote, an HTML block,
// anything outside the parsed subset — into something they did not type.
// =============================================================================

describe('MarkdownNoteExporter', () => {
  const exporter = new MarkdownNoteExporter(new NoteExporterRegistry());

  it('registers itself as `markdown`', () => {
    const registry = new NoteExporterRegistry();

    new MarkdownNoteExporter(registry).onModuleInit();

    expect(registry.get('markdown')?.extension).toBe('md');
  });

  it('reproduces the stored body verbatim', async () => {
    const text = (await collect(exporter, noteDocument())).toString('utf8');

    expect(text).toContain(FIXTURE_BODY);
  });

  it('does not normalise syntax the parser does not model', async () => {
    // A pipe table is outside `markdown-ast.ts`'s subset. It must survive
    // untouched, because this exporter never parses.
    const body = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n<div>raw html</div>';
    const text = (await collect(exporter, noteDocument({ body }))).toString('utf8');

    expect(text).toContain(body);
  });

  it('names the source, template, version and timestamp in a quoted block', async () => {
    const text = (await collect(exporter, noteDocument())).toString('utf8');

    expect(text).toContain('> **Source:** Weekly Sync — Sep 12, 2026 (transcript)');
    expect(text).toContain('> **Template:** Concise Meeting Notes');
    expect(text).toContain('> **Note version:** Version 3 · saved Sep 12, 2026');
    expect(text).toContain('> **Exported:** 2026-09-14T04:37:11.000Z');
  });

  it('emits front matter by default and omits it on request', async () => {
    const withFront = (await collect(exporter, noteDocument())).toString('utf8');

    expect(withFront.startsWith('---\n')).toBe(true);
    expect(withFront).toContain('version: 3');
    expect(withFront).toContain('  type: "transcript"');

    const without = (
      await collect(exporter, noteDocument(), { includeFrontMatter: false })
    ).toString('utf8');

    expect(without.startsWith('---')).toBe(false);
    // ⚠ THE PROVENANCE BLOCK IS STILL THERE. Front matter is a formatting
    // preference; provenance is the reason the feature exists, and no option
    // may switch it off.
    expect(without).toContain('> **Source:**');
  });

  it('quotes and escapes front-matter values so the block stays parseable', async () => {
    const text = (
      await collect(exporter, noteDocument({ title: 'Q3: the "big" plan\\revision' }))
    ).toString('utf8');

    expect(text).toContain('title: "Q3: the \\"big\\" plan\\\\revision"');
  });

  it('writes `null` rather than a dash for a note with no template', async () => {
    const text = (await collect(exporter, noteDocument({ templateName: null }))).toString('utf8');

    expect(text).toContain('template: null');
    // The human block says `None` — a missing line would be indistinguishable
    // from a renderer that forgot to print one.
    expect(text).toContain('> **Template:** None');
  });

  it('terminates with exactly one newline whatever the body ended with', async () => {
    const one = (await collect(exporter, noteDocument({ body: 'Body' }))).toString('utf8');
    const many = (await collect(exporter, noteDocument({ body: 'Body\n\n\n' }))).toString('utf8');

    expect(one.endsWith('Body\n')).toBe(true);
    expect(many.endsWith('Body\n')).toBe(true);
  });
});
