import { Logger } from '@nestjs/common';

import { NoteLibraryImportHandler } from './note-library-import.handler.js';

const ITEM = { id: 'item-1', batchId: 'batch-1', fileId: null, filename: 'Notes.docx', path: null, sourceObjectId: 'obj-1', status: 'queued' };

function build(info: unknown, bytes: Buffer | null) {
  const update = jest.fn().mockResolvedValue({});
  const prisma = {
    noteImportBatchItem: { findUnique: jest.fn().mockResolvedValue(ITEM), update },
    noteImportBatch: { findUnique: jest.fn().mockResolvedValue({ id: 'batch-1', ownerId: 'u1', libraryId: null }) },
    noteLibrary: { findUnique: jest.fn() },
    noteLibraryFile: { findUnique: jest.fn() },
  };
  const objects = { describe: jest.fn().mockResolvedValue(info), downloadBuffer: jest.fn().mockResolvedValue(bytes) };
  const libraries = { refreshBatchStatus: jest.fn().mockResolvedValue(undefined) };
  const handler = new NoteLibraryImportHandler(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    objects as never,
    {} as never,
    {} as never,
    libraries as never,
    { formatImports: false },
  );
  return { handler, update };
}

describe('NoteLibraryImportHandler source_missing', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const job = { id: 'j1', payload: { itemId: 'item-1' }, subjectId: 'item-1', attempts: 1 } as never;

  it.each([
    ['the object is not found', null, null, /describe returned null/],
    ['the bytes cannot be read', { mimeType: 'application/pdf', state: 'ready' }, null, /download returned null/],
    ['the stored mime type is not a document type', { mimeType: 'application/octet-stream', state: 'ready' }, Buffer.from('x'), /"application\/octet-stream" is not an accepted/],
  ])('fails the item and logs which condition failed when %s', async (_name, info, bytes, expected) => {
    const { handler, update } = build(info, bytes as Buffer | null);

    await handler.process(job);

    expect(update).toHaveBeenCalledWith({ where: { id: 'item-1' }, data: { status: 'failed', failureReason: 'source_missing' } });
    const message = String(warn.mock.calls.map((c) => c[0]).find((m) => String(m).includes('source_missing')));
    expect(message).toMatch(expected);
    expect(message).not.toContain('Hello');
  });
});
