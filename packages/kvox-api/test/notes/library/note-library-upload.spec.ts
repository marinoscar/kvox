import { BadRequestException, ConflictException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { NoteLibraryUploadController } from '../../../src/notes/library/note-library-upload.controller.js';
import { NoteLibraryUploadService } from '../../../src/notes/library/note-library-upload.service.js';
import { NoteObjectsService } from '../../../src/notes/note-objects.service.js';
import { createFakeKvoxJobs, createInMemoryKvoxObjectStore } from '../../../src/testing/index.js';
import { createLibraryFakeDb } from './library-fake-db.js';

const ACTOR = { id: 'owner-1', permissions: ['notes:write'] };
const MD = Buffer.from('# Hello\n\nbody text');
const HASH = createHash('sha256').update(MD).digest('hex');

async function build() {
  const db = createLibraryFakeDb();
  const store = createInMemoryKvoxObjectStore();
  const jobs = createFakeKvoxJobs();
  const service = new NoteLibraryUploadService(db as never, jobs, new NoteObjectsService(store));
  const library = await db.noteLibrary.create({ data: { ownerId: ACTOR.id, name: 'L' } });
  const batch = await db.noteImportBatch.create({ data: { ownerId: ACTOR.id, libraryId: library.id } });
  const adhoc = await db.noteImportBatch.create({ data: { ownerId: ACTOR.id } });
  return { db, store, jobs, service, library, batch, adhoc };
}

describe('NoteLibraryUploadService.upload', () => {
  it('stores the object, creates the file row, the item and the job in one go (new)', async () => {
    const t = await build();

    const result = await t.service.upload(ACTOR, t.batch.id, { filename: 'b.md', body: MD, path: 'docs\\b.md', mtimeMs: 5000 });

    expect(result).toEqual({ itemId: expect.any(String), action: 'new', skipped: false });
    expect(t.db.noteLibraryFile.rows[0]).toMatchObject({ relativePath: 'docs/b.md', contentHash: HASH, status: 'importing', size: BigInt(MD.byteLength) });
    expect(t.db.noteLibraryFile.rows[0].mtime.getTime()).toBe(5000);
    const item = t.db.noteImportBatchItem.rows[0];
    expect(item).toMatchObject({ batchId: t.batch.id, filename: 'b.md', path: 'docs/b.md', action: 'new', status: 'queued', fileId: t.db.noteLibraryFile.rows[0].id });
    expect([...t.store.objects.values()]).toHaveLength(1);
    expect(item.sourceObjectId).toBe([...t.store.objects.keys()][0]);
    expect(t.jobs.jobs.map((j) => j.input)).toEqual([
      expect.objectContaining({ type: 'note.library.import', priority: 0, subjectType: 'note_import_batch_item', subjectId: item.id, payload: { itemId: item.id }, reason: 'import' }),
    ]);
    expect(item.jobId).toBe(t.jobs.jobs[0]!.id);
  });

  it('is a changed file when the library file already has a note', async () => {
    const t = await build();
    await t.db.noteLibraryFile.create({ data: { libraryId: t.library.id, relativePath: 'b.md', size: 1n, mtime: new Date(), contentHash: 'old', noteId: 'n1', status: 'imported' } });

    const result = await t.service.upload(ACTOR, t.batch.id, { filename: 'b.md', body: MD });

    expect(result.action).toBe('changed');
    expect(t.db.noteLibraryFile.rows).toHaveLength(1);
    expect(t.db.noteLibraryFile.rows[0]).toMatchObject({ contentHash: HASH, status: 'importing' });
  });

  it('skips identical bytes of an imported file: no object, no item, no job', async () => {
    const t = await build();
    await t.db.noteLibraryFile.create({ data: { libraryId: t.library.id, relativePath: 'b.md', size: 1n, mtime: new Date(), contentHash: HASH, noteId: 'n1', status: 'imported' } });

    const result = await t.service.upload(ACTOR, t.batch.id, { filename: 'b.md', body: MD });

    expect(result).toEqual({ itemId: null, action: null, skipped: true });
    expect(t.store.objects.size).toBe(0);
    expect(t.db.noteImportBatchItem.rows).toHaveLength(0);
    expect(t.jobs.jobs).toHaveLength(0);
  });

  it('an ad-hoc batch defaults the path to the file name and has no file row', async () => {
    const t = await build();
    await t.service.upload(ACTOR, t.adhoc.id, { filename: 'Notes.md', body: MD });

    expect(t.db.noteLibraryFile.rows).toHaveLength(0);
    expect(t.db.noteImportBatchItem.rows[0]).toMatchObject({ path: 'Notes.md', filename: 'Notes.md', fileId: null, action: 'new' });
  });

  it('re-opens a completed batch', async () => {
    const t = await build();
    await t.db.noteImportBatch.update({ where: { id: t.batch.id }, data: { status: 'completed', finishedAt: new Date() } });

    await t.service.upload(ACTOR, t.batch.id, { filename: 'b.md', body: MD });

    expect(t.db.noteImportBatch.rows.find((r: any) => r.id === t.batch.id)).toMatchObject({ status: 'running', finishedAt: null });
  });

  it.each(['../x.md', '/abs.md', 'C:\\x.md'])('refuses the path %s with invalid_path', async (path) => {
    const t = await build();
    const error = await t.service.upload(ACTOR, t.batch.id, { filename: 'b.md', body: MD, path }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ details: { reason: 'invalid_path' } });
    expect(t.store.objects.size).toBe(0);
  });

  it('refuses an unsupported file with unsupported_document and creates nothing', async () => {
    const t = await build();
    const error = await t.service.upload(ACTOR, t.batch.id, { filename: 'a.bin', body: Buffer.from([0, 1, 2, 3, 0, 0]) }).catch((e: unknown) => e);

    expect((error as BadRequestException).getResponse()).toMatchObject({ details: { reason: 'unsupported_document' } });
    expect(t.db.noteImportBatchItem.rows).toHaveLength(0);
    expect(t.store.objects.size).toBe(0);
  });

  it('answers 404 for a foreign or missing batch and 409 for a cancelled one', async () => {
    const t = await build();
    await expect(t.service.upload({ id: 'other', permissions: [] }, t.batch.id, { filename: 'b.md', body: MD })).rejects.toBeInstanceOf(NotFoundException);
    await t.db.noteImportBatch.update({ where: { id: t.batch.id }, data: { status: 'cancelled' } });
    await expect(t.service.upload(ACTOR, t.batch.id, { filename: 'b.md', body: MD })).rejects.toBeInstanceOf(ConflictException);
  });

  it('deletes the stored object when the transaction fails', async () => {
    const t = await build();
    jest.spyOn(t.jobs, 'enqueueWithin').mockRejectedValue(new Error('queue down'));

    await expect(t.service.upload(ACTOR, t.batch.id, { filename: 'b.md', body: MD })).rejects.toThrow('queue down');
    expect(t.store.objects.size).toBe(0);
  });
});

describe('NoteLibraryUploadService.retry', () => {
  it('re-queues failed items whose object still exists and skips the rest', async () => {
    const t = await build();
    await t.service.upload(ACTOR, t.batch.id, { filename: 'a.md', body: MD, path: 'a.md' });
    await t.service.upload(ACTOR, t.batch.id, { filename: 'c.md', body: Buffer.from('# C\n\nother'), path: 'c.md' });
    const [a, c] = t.db.noteImportBatchItem.rows;
    for (const item of [a, c]) await t.db.noteImportBatchItem.update({ where: { id: item.id }, data: { status: 'failed', failureReason: 'x' } });
    await t.store.delete(c.sourceObjectId);
    const enqueue = jest.spyOn(t.jobs, 'enqueueWithin');

    await expect(t.service.retry(ACTOR, t.batch.id)).resolves.toEqual({ requeued: 1 });

    expect(a).toMatchObject({ status: 'queued', failureReason: null });
    expect(c.status).toBe('failed');
    expect(enqueue.mock.calls.map(([, input]) => input.subjectId)).toEqual([a.id]);
    expect(t.db.noteImportBatch.rows.find((r: any) => r.id === t.batch.id).status).toBe('running');
  });

  it('answers 404 for a foreign batch', async () => {
    const t = await build();
    await expect(t.service.retry({ id: 'other', permissions: [] }, t.batch.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NoteLibraryUploadController.upload', () => {
  const BATCH = '11111111-1111-4111-8111-111111111111';

  function request(parts: unknown[]) {
    return { isMultipart: () => true, parts: () => (async function* () { yield* parts; })() } as never;
  }
  function file(over: Record<string, unknown> = {}) {
    return { type: 'file', fieldname: 'file', filename: 'b.md', toBuffer: async () => MD, file: {}, ...over };
  }
  function field(fieldname: string, value: string) {
    return { type: 'field', fieldname, value };
  }
  function controller(upload = jest.fn().mockResolvedValue({ itemId: 'i', action: 'new', skipped: false }), max = 1024) {
    return { c: new NoteLibraryUploadController({ upload } as never, { maxDocumentImportBytes: max } as never), upload };
  }

  it('reads fields that arrive before or after the file', async () => {
    const { c, upload } = controller();
    await c.upload(BATCH, request([field('path', 'a/b.md'), file(), field('mtime', '1234')]), ACTOR);

    expect(upload).toHaveBeenCalledWith(ACTOR, BATCH, { filename: 'b.md', body: MD, path: 'a/b.md', mtimeMs: 1234 });
  });

  it('answers 413 for a truncated file and for a size-limit error', async () => {
    const { c, upload } = controller();
    await expect(c.upload(BATCH, request([file({ file: { truncated: true } })]), ACTOR)).rejects.toBeInstanceOf(PayloadTooLargeException);

    const limit = { isMultipart: () => true, parts: () => (async function* () { throw Object.assign(new Error('big'), { code: 'FST_REQ_FILE_TOO_LARGE' }); })() } as never;
    await expect(c.upload(BATCH, limit, ACTOR)).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(upload).not.toHaveBeenCalled();
  });

  it('answers 400 for no file, a wrongly named file, or a non-multipart body', async () => {
    const { c } = controller();
    await expect(c.upload(BATCH, request([field('path', 'x')]), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.upload(BATCH, request([file({ fieldname: 'other' })]), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.upload(BATCH, { isMultipart: () => false, parts: () => undefined } as never, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
  });
});
