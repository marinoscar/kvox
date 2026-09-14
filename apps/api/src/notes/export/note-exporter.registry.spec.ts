import { Logger } from '@nestjs/common';
import type { Writable } from 'node:stream';

import { optionsSchemaFor } from '../../export/export-options';
import { MarkdownNoteExporter } from './markdown.exporter';
import { NoteExporterRegistry, type NoteExporter } from './note-exporter.registry';
import { PdfNoteExporter } from './pdf.exporter';
import { WordNoteExporter } from './word.exporter';

// =============================================================================
// The note exporter registry (issue #54, docs/specs/notes.md §8.1)
// =============================================================================
//
// Deliberately the SAME suite `transcript-exporter.registry.spec.ts` runs
// against the transcript registry, because both are now instantiations of one
// generic class and the whole claim of §8.1's extraction is that they behave
// identically. Plus the one assertion only this registry can make: the three
// formats #54 promises are all actually registered by their own classes.
// =============================================================================

function fake(format: string, label = format.toUpperCase()): NoteExporter {
  return {
    format,
    label,
    mimeType: `application/${format}`,
    extension: format,
    options: [],
    optionsSchema: optionsSchemaFor([]),
    render: (_doc, _options, out: Writable) =>
      new Promise<void>((resolve) => {
        out.end(() => resolve());
      }),
  };
}

describe('NoteExporterRegistry', () => {
  it('answers undefined for a format nobody registered', () => {
    // Not a throw: the caller is an HTTP path that owes the client a 400 naming
    // the formats that DO exist.
    expect(new NoteExporterRegistry().get('rtf')).toBeUndefined();
  });

  it('returns what was registered', () => {
    const registry = new NoteExporterRegistry();

    registry.register(fake('markdown'));

    expect(registry.get('markdown')?.label).toBe('MARKDOWN');
  });

  it('orders by format, not by registration order', () => {
    const registry = new NoteExporterRegistry();

    registry.register(fake('pdf'));
    registry.register(fake('docx'));
    registry.register(fake('markdown'));

    expect(registry.formats()).toEqual(['docx', 'markdown', 'pdf']);
  });

  it('lets a later registration shadow an earlier one, and warns', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = new NoteExporterRegistry();

    registry.register(fake('markdown', 'Framework'));
    registry.register(fake('markdown', "A fork's own"));

    expect(registry.get('markdown')?.label).toBe("A fork's own");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already registered'));

    warn.mockRestore();
  });

  it('is empty before anything registers', () => {
    expect(new NoteExporterRegistry().all()).toEqual([]);
  });

  it('holds exactly the three formats issue #54 ships, each from its own class', () => {
    // ADDING A FORMAT COSTS ONE CLASS: this is that promise, asserted. Nothing
    // in the controller, the handler or the web client names a format string.
    const registry = new NoteExporterRegistry();

    for (const exporter of [
      new MarkdownNoteExporter(registry),
      new PdfNoteExporter(registry),
      new WordNoteExporter(registry),
    ]) {
      exporter.onModuleInit();
    }

    expect(registry.formats()).toEqual(['docx', 'markdown', 'pdf']);
    expect(registry.all().map((exporter) => exporter.extension)).toEqual(['docx', 'md', 'pdf']);
  });
});
