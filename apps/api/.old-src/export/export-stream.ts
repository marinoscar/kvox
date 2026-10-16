// =============================================================================
// Writing to an exporter's `out`, with backpressure (issue #28, epic #19)
// =============================================================================
//
// Two four-line helpers, shared by the JSON and Markdown exporters, because
// both of them emit a long sequence of small chunks and both of them would
// otherwise be wrong in the same way.
//
// `Writable.write()` returning `false` means the stream's buffer is full. A
// loop that ignores it — `for (const segment of doc.segments) out.write(...)` —
// does not fail; it buffers the ENTIRE document in memory inside the stream
// and then flushes it, which is precisely the "builds the whole document in
// memory" behaviour spec §8.4 rejected `pdfmake` for. The difference between
// streaming and not streaming is this `await`, and nothing else.
//
// pdfkit handles its own backpressure, so the PDF exporter does not use these.
// =============================================================================

import { once } from 'node:events';
import type { Writable } from 'node:stream';

/** Write one chunk, waiting for `drain` when the stream asks us to. */
export async function writeChunk(out: Writable, chunk: string): Promise<void> {
  if (!out.write(chunk)) {
    await once(out, 'drain');
  }
}

/**
 * End the stream and resolve once it has finished.
 *
 * The exporter contract says `render` ends `out` and settles only when every
 * byte has been handed on — this is that promise. `error` is listened for so a
 * storage failure downstream rejects the render instead of hanging it.
 */
export async function endStream(out: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.end(() => {
      resolve();
    });
  });
}
