// =============================================================================
// Render an exporter to a Buffer, for the tests (issue #28, epic #19)
// =============================================================================
//
// The exporter contract takes a `Writable` and ends it. A test wants the bytes,
// so this pipes a `PassThrough` into an array and resolves once BOTH the render
// promise and the stream have settled — the same "await both halves" rule the
// job handler follows, for the same reason: awaiting only one of them lets a
// truncated render pass as a complete one.
// =============================================================================

import { PassThrough } from 'node:stream';

import type { ExportDocument } from '../export-document';
import type { ExportOptions } from '../export-options';
import type { TranscriptExporter } from '../transcript-exporter.interface';

export async function renderToBuffer(
  exporter: TranscriptExporter,
  doc: ExportDocument,
  options: ExportOptions = {},
): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];

  const collected = new Promise<Buffer>((resolve, reject) => {
    out.on('data', (chunk: Buffer) => chunks.push(chunk));
    out.on('end', () => resolve(Buffer.concat(chunks)));
    out.on('error', reject);
  });

  const parsed = exporter.optionsSchema.parse(options);

  await exporter.render(doc, parsed, out);

  return collected;
}

/** The same, as text. */
export async function renderToString(
  exporter: TranscriptExporter,
  doc: ExportDocument,
  options: ExportOptions = {},
): Promise<string> {
  return (await renderToBuffer(exporter, doc, options)).toString('utf8');
}
