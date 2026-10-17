import { PayloadTooLargeException } from '@nestjs/common';

import { GraphImportController } from '../src/graph-rdf/import/graph-import.controller.js';
import { NoteImportController } from '../src/notes/import/note-import.controller.js';
import { NoteSourcesController } from '../src/notes/note-sources.controller.js';
import { TranscriptsController } from '../src/transcripts/transcripts.controller.js';

// =============================================================================
// A file cut at the size limit is a 413, never a stored file (issue #585)
// =============================================================================
//
// `@fastify/multipart`'s `toBuffer()` can resolve with the first `fileSize` bytes
// and no error when the limit is reached as the last chunk is read; it only marks
// the stream `truncated`. KVox Desktop hit it: a 5 MiB + 60 byte note export
// was imported cut at 5 MiB. Every upload route checks the flag; this pins it.
// =============================================================================

const USER = { id: 'user-1', permissions: [], activeOrgId: null };

/** A request whose single `file` part resolves truncated, exactly as the plugin can. */
function truncatedRequest() {
  return {
    isMultipart: () => true,
    file: async () => ({
      fieldname: 'file',
      filename: 'big.bin',
      mimetype: 'text/markdown',
      file: { truncated: true },
      toBuffer: async () => Buffer.alloc(16),
    }),
  } as never;
}

describe('upload routes refuse a truncated multipart file with a 413', () => {
  it('POST /api/notes/import', async () => {
    const importFile = jest.fn();
    const controller = new NoteImportController({ importFile } as never, {} as never, { maxImportBytes: 16 } as never);

    await expect(controller.importNote(truncatedRequest(), USER)).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(importFile).not.toHaveBeenCalled();
  });

  it('POST /api/notes/sources/documents', async () => {
    const uploadDocument = jest.fn();
    const controller = new NoteSourcesController({ maxDocumentBytes: async () => 16, uploadDocument } as never);

    await expect(controller.uploadDocument(truncatedRequest(), 'user-1')).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('POST /api/transcripts/imports', async () => {
    const importFile = jest.fn();
    const controller = new TranscriptsController({} as never, {} as never, {} as never, {} as never, { importFile } as never, {
      maxImportBytes: 16,
    } as never);

    await expect(controller.importTranscript(truncatedRequest(), USER as never)).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(importFile).not.toHaveBeenCalled();
  });

  it('POST /api/graph/imports', async () => {
    const upload = jest.fn();
    const controller = new GraphImportController({ upload } as never, { maxImportBytes: 16 } as never);

    await expect(controller.upload(truncatedRequest(), USER as never)).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(upload).not.toHaveBeenCalled();
  });
});
