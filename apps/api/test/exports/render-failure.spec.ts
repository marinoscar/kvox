import { PassThrough } from 'node:stream';

import {
  JsonTranscriptExporter,
  MarkdownTranscriptExporter,
  PdfTranscriptExporter,
  TranscriptExporterRegistry,
} from '@marinoscar/kvox-api/transcripts';
import { fixtureDocument } from '@marinoscar/kvox-api/transcripts/testing';
import { MarkdownNoteExporter, NoteExporterRegistry, PdfNoteExporter } from '@marinoscar/kvox-api/notes';
import { WordNoteExporter, noteDocument } from '@marinoscar/kvox-api/notes/testing';

// =============================================================================
// A render that fails destroys the output stream (issue #479)
// =============================================================================
//
// The package's writer contract: "a half-written file never looks complete".
// The upload treats a clean end as a finished file, so every exporter must
// destroy `out` (via `failStream`) when it throws, never end it.
// =============================================================================

function broken<T extends object>(doc: T): T {
  Object.defineProperty(doc, 'title', {
    get() {
      throw new Error('boom');
    },
  });

  return doc;
}

const transcripts = new TranscriptExporterRegistry();
const notes = new NoteExporterRegistry();

const CASES = [
  ['transcript markdown', new MarkdownTranscriptExporter(transcripts), () => broken(fixtureDocument())],
  ['transcript json', new JsonTranscriptExporter(transcripts), () => broken(fixtureDocument())],
  ['transcript pdf', new PdfTranscriptExporter(transcripts), () => broken(fixtureDocument())],
  ['note markdown', new MarkdownNoteExporter(notes), () => broken(noteDocument())],
  ['note pdf', new PdfNoteExporter(notes), () => broken(noteDocument())],
  ['note docx', new WordNoteExporter(notes), () => broken(noteDocument())],
] as const;

describe('exporters on render failure', () => {
  it.each(CASES)('%s rejects and destroys the destination', async (_name, exporter, make) => {
    const out = new PassThrough();

    out.resume();

    await expect(
      // The two document types differ; the exporter and its document are paired above.
      (exporter as { render: (d: unknown, o: Record<string, boolean>, s: PassThrough) => Promise<void> })
        .render(make(), exporter.optionsSchema.parse({}), out),
    ).rejects.toThrow('boom');
    expect(out.destroyed).toBe(true);
    expect(out.writableFinished).toBe(false);
  });
});
