import { PassThrough } from 'node:stream';

import type { Exporter } from '../../../export/exporter-registry';
import { buildNoteExportDocument, type NoteExportDocument } from '../note-export-document';

// =============================================================================
// One note document, and one way to collect an exporter's bytes (issue #54)
// =============================================================================
//
// Shared by the three exporter suites so that "the PDF and the DOCX say the
// same thing" is a claim about the renderers rather than about three slightly
// different fixtures. The body deliberately exercises every block kind the
// subset supports, because the renderers' block switches are where a format
// quietly stops rendering something.
// =============================================================================

export const FIXTURE_BODY = [
  '# Summary',
  '',
  'The team agreed to **ship** the *export* feature. See `notes.md` and',
  '[the spec](https://example.test/spec).',
  '',
  '## Decisions',
  '',
  '- Ship Markdown, PDF and Word',
  '  - Word is the one a colleague edits',
  '- Defer sharing to a later epic',
  '',
  '1. Draft the API',
  '2. Write the renderers',
  '',
  '> Provenance travels with the export.',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '---',
  '',
  'Closing paragraph.',
].join('\n');

/** The fixture document. Override anything a particular assertion is about. */
export function noteDocument(
  overrides: Partial<NoteExportDocument> = {},
): NoteExportDocument {
  return buildNoteExportDocument({
    noteId: '11111111-1111-4111-8111-111111111111',
    title: 'Weekly Sync Recap',
    body: FIXTURE_BODY,
    version: 3,
    createdAt: new Date('2026-09-12T10:00:00.000Z'),
    exportedAt: new Date('2026-09-14T04:37:11.000Z'),
    author: { displayName: 'Ada Lovelace', email: 'ada@example.test' },
    provider: { id: 'openai', model: 'gpt-4o' },
    templateName: 'Concise Meeting Notes',
    source: {
      type: 'transcript',
      id: '44444444-4444-4444-8444-444444444444',
      title: 'Weekly Sync',
      date: new Date('2026-09-12T09:00:00.000Z'),
    },
    ...overrides,
  });
}

/**
 * Render through an exporter and collect every byte it wrote.
 *
 * ⚠ THE COLLECTOR IS A REAL `Writable`, not a spy. The exporter contract is
 * about a stream — write, end, settle only once the destination has finished —
 * and a mock that recorded calls would let a renderer that never ends `out`
 * pass. A `PassThrough` that is actually drained is the cheapest honest
 * implementation of the other side of that contract.
 */
export async function collect<TDoc>(
  exporter: Exporter<TDoc>,
  doc: TDoc,
  options: Record<string, unknown> = {},
): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];

  out.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  await exporter.render(doc, exporter.optionsSchema.parse(options), out);

  return Buffer.concat(chunks);
}
