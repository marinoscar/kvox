import { Logger } from '@nestjs/common';
import type { Writable } from 'node:stream';

import { optionsSchemaFor } from './export-options';
import {
  TranscriptExporterRegistry,
  type TranscriptExporter,
} from './transcript-exporter.interface';

// =============================================================================
// The exporter registry (issue #28, epic #19, spec §8.1)
// =============================================================================

function fake(format: string, label = format.toUpperCase()): TranscriptExporter {
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

describe('TranscriptExporterRegistry', () => {
  it('answers undefined for a format nobody registered', () => {
    // Not a throw: the caller is an HTTP path that owes the client a 400 naming
    // the formats that DO exist, which is a better answer than an exception.
    expect(new TranscriptExporterRegistry().get('docx')).toBeUndefined();
  });

  it('returns what was registered', () => {
    const registry = new TranscriptExporterRegistry();

    registry.register(fake('markdown'));

    expect(registry.get('markdown')?.label).toBe('MARKDOWN');
  });

  it('orders by format, not by registration order', () => {
    // Registration order is the order Nest happens to instantiate providers in,
    // so the dialog's format list would silently reorder itself the day
    // somebody alphabetised the module's `providers` array.
    const registry = new TranscriptExporterRegistry();

    registry.register(fake('pdf'));
    registry.register(fake('json'));
    registry.register(fake('markdown'));

    expect(registry.formats()).toEqual(['json', 'markdown', 'pdf']);
    expect(registry.all().map((exporter) => exporter.format)).toEqual([
      'json',
      'markdown',
      'pdf',
    ]);
  });

  it('lets a later registration shadow an earlier one, and warns', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = new TranscriptExporterRegistry();

    registry.register(fake('markdown', 'Framework'));
    registry.register(fake('markdown', 'A fork\'s own'));

    expect(registry.get('markdown')?.label).toBe("A fork's own");
    expect(registry.formats()).toEqual(['markdown']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already registered'));

    warn.mockRestore();
  });

  it('is empty before anything registers', () => {
    expect(new TranscriptExporterRegistry().all()).toEqual([]);
  });
});
