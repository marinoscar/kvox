import { NoteLibraryImportHandler } from '../../../src/notes/handlers/note-library-import.handler.js';
import { NoteLibrariesService } from '../../../src/notes/library/note-libraries.service.js';
import { NoteObjectsService } from '../../../src/notes/note-objects.service.js';
import { NoteVersionWriter } from '../../../src/notes/note-version-writer.js';
import { NOTE_READY_EVENT } from '../../../src/notes/notes.events.js';
import type { KvoxEventsPort, KvoxJob } from '../../../src/ports/index.js';
import {
  createFakeKvoxJobs,
  createInMemoryKvoxObjectStore,
  createRecordingKvoxAudit,
} from '../../../src/testing/index.js';
import { createLibraryFakeDb } from './library-fake-db.js';

const OWNER = 'owner-1';

function build(options: { formatImports: boolean } = { formatImports: false }) {
  const db = createLibraryFakeDb();
  const store = createInMemoryKvoxObjectStore();
  const jobs = createFakeKvoxJobs();
  const audit = createRecordingKvoxAudit();
  const emitted: Array<{ name: string; payload: any; committed: number }> = [];
  const events: KvoxEventsPort = {
    emit: (name, payload) => void emitted.push({ name, payload, committed: db.noteImportBatchItem.rows.filter((r: any) => r.status === 'imported').length }),
    subscribe: () => () => undefined,
  };
  const searchIndex = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const objects = new NoteObjectsService(store);
  const handler = new NoteLibraryImportHandler(
    db as never,
    jobs,
    audit,
    events,
    objects,
    new NoteVersionWriter(db as never),
    searchIndex as never,
    new NoteLibrariesService(db as never),
    options,
  );

  async function seed(opts: { text?: string; mime?: string; libraryId?: string | null; autoExtract?: boolean; file?: Record<string, unknown>; action?: string; filename?: string }) {
    const library = opts.libraryId === null ? null : await db.noteLibrary.create({ data: { ownerId: OWNER, name: 'L', autoExtract: opts.autoExtract ?? true } });
    const batch = await db.noteImportBatch.create({ data: { ownerId: OWNER, libraryId: library?.id ?? null } });
    const file = library
      ? await db.noteLibraryFile.create({ data: { libraryId: library.id, relativePath: 'a/b.md', size: 3n, mtime: new Date(), status: 'importing', ...opts.file } })
      : null;
    const obj = await objects.put({
      storageKey: `notes/sources/uploads/${Math.random().toString(16).slice(2)}/source.md`,
      name: opts.filename ?? 'b.md',
      mimeType: opts.mime ?? 'text/markdown',
      body: Buffer.from(opts.text ?? '# Title\n\nHello body'),
      ownerId: OWNER,
    });
    const item = await db.noteImportBatchItem.create({
      data: { batchId: batch.id, fileId: file?.id ?? null, filename: opts.filename ?? 'b.md', path: file ? 'a/b.md' : null, action: opts.action ?? 'new', sourceObjectId: obj.id, status: 'queued' },
    });
    return { library, batch, file, obj, item };
  }

  const job = (itemId: string, attempts = 1): KvoxJob => ({
    id: 'job-1', type: 'note.library.import', subjectType: 'note_import_batch_item', subjectId: itemId, payload: { itemId }, attempts, orgId: null,
  });

  return { db, store, jobs, audit, emitted, searchIndex, objects, handler, seed, job };
}

describe('NoteLibraryImportHandler', () => {
  it('is server-only with the declared profile and registers itself', () => {
    const { handler, jobs } = build();
    expect(handler.type).toBe('note.library.import');
    expect(handler.profile).toEqual({ maxRuntimeMs: 5 * 60_000, maxAttempts: 3 });
    expect((handler as any).nodeResultSchema).toBeUndefined();
    expect((handler as any).persistNodeResult).toBeUndefined();
    handler.onModuleInit();
    expect(jobs.isRegistered('note.library.import')).toBe(true);
  });

  it('imports a new file: note v1, item imported, file linked, note_ready after the commit', async () => {
    const t = build();
    const { item, file, obj, batch } = await t.seed({});

    await t.handler.process(t.job(item.id));

    const note = t.db.note.rows[0];
    expect(note).toMatchObject({ ownerId: OWNER, title: 'Title', titleSource: 'user', status: 'ready', currentVersion: 1, sourceType: 'document', sourceObjectId: obj.id });
    expect(t.db.noteVersion.rows).toEqual([expect.objectContaining({ noteId: note.id, version: 1, kind: 'edit', authorId: OWNER, summary: 'Imported from a/b.md' })]);
    expect(t.db.noteImportBatchItem.rows[0]).toMatchObject({ status: 'imported', noteId: note.id, noteVersion: 1 });
    expect(t.db.noteLibraryFile.rows.find((r: any) => r.id === file!.id)).toMatchObject({ noteId: note.id, importedVersion: 1, status: 'imported' });
    expect(t.db.noteImportBatch.rows.find((r: any) => r.id === batch.id).status).toBe('completed');
    expect(t.emitted).toEqual([
      { name: NOTE_READY_EVENT, payload: { noteId: note.id, ownerId: OWNER, version: 1, origin: 'library', bulk: true }, committed: 1 },
    ]);
    expect(t.searchIndex.enqueue).toHaveBeenCalledWith('note', note.id);
    expect(t.audit.recorded).toEqual([expect.objectContaining({ action: 'note:library_import', targetId: note.id })]);
    expect(JSON.stringify(t.audit.recorded)).not.toContain('Hello body');
  });

  describe('with formatImports on (#729)', () => {
    const FORMAT = 'note.import.format';
    const stub = (jobs: ReturnType<typeof build>['jobs']) =>
      jobs.registerHandler({ type: FORMAT, process: async () => undefined });

    it('queues note.import.format (priority 5) INSTEAD of note_ready, and still queues the search index', async () => {
      const t = build({ formatImports: true });
      stub(t.jobs);
      const { item } = await t.seed({});

      await t.handler.process(t.job(item.id));

      const note = t.db.note.rows[0];
      const queued = t.jobs.jobs.filter((j: any) => j.input.type === FORMAT);
      expect(queued).toHaveLength(1);
      expect((queued[0] as any).input).toMatchObject({
        subjectType: 'note',
        subjectId: note.id,
        priority: 5,
        payload: { itemId: item.id, noteId: note.id, version: 1 },
      });
      expect(t.emitted).toEqual([]);
      expect(t.searchIndex.enqueue).toHaveBeenCalledWith('note', note.id);
    });

    it('queues the format job even when the library has autoExtract off (the job decides on note_ready)', async () => {
      const t = build({ formatImports: true });
      stub(t.jobs);
      const { item } = await t.seed({ autoExtract: false });
      await t.handler.process(t.job(item.id));

      expect(t.jobs.jobs.filter((j: any) => j.input.type === FORMAT)).toHaveLength(1);
      expect(t.emitted).toEqual([]);
    });

    it('falls back to note_ready when the format handler is not registered', async () => {
      const t = build({ formatImports: true });
      const { item } = await t.seed({});
      await t.handler.process(t.job(item.id));

      expect(t.jobs.jobs.filter((j: any) => j.input.type === FORMAT)).toHaveLength(0);
      expect(t.emitted).toHaveLength(1);
    });

    it('falls back to note_ready when queueing the format job fails', async () => {
      const t = build({ formatImports: true });
      stub(t.jobs);
      const spy = jest.spyOn(t.jobs, 'enqueue').mockRejectedValue(new Error('queue down'));
      const { item } = await t.seed({});
      await t.handler.process(t.job(item.id));

      expect(t.emitted).toHaveLength(1);
      spy.mockRestore();
    });
  });

  it('is idempotent: re-running an imported item does nothing', async () => {
    const t = build();
    const { item } = await t.seed({});
    await t.handler.process(t.job(item.id));
    await t.handler.process(t.job(item.id));

    expect(t.db.note.rows).toHaveLength(1);
    expect(t.emitted).toHaveLength(1);
  });

  it('does not publish note_ready when the library has autoExtract off', async () => {
    const t = build();
    const { item } = await t.seed({ autoExtract: false });
    await t.handler.process(t.job(item.id));

    expect(t.db.note.rows).toHaveLength(1);
    expect(t.emitted).toEqual([]);
  });

  it('an ad-hoc batch imports with no library file and publishes note_ready', async () => {
    const t = build();
    const { item } = await t.seed({ libraryId: null });
    await t.handler.process(t.job(item.id));

    expect(t.db.note.rows).toHaveLength(1);
    expect(t.emitted).toHaveLength(1);
  });

  it('a changed file writes version 2 with the new source, deletes the old object, not diverged', async () => {
    const t = build();
    const prior = await t.objects.put({ storageKey: 'notes/sources/uploads/old/source.md', name: 'b.md', mimeType: 'text/markdown', body: Buffer.from('old'), ownerId: OWNER });
    const note = await t.db.note.create({ data: { ownerId: OWNER, title: 'Old', body: 'old', bodyFormat: 'markdown', currentVersion: 1, sourceType: 'document', sourceObjectId: prior.id } });
    const { item, file } = await t.seed({ action: 'changed', file: { noteId: note.id, importedVersion: 1, status: 'importing' }, text: '# New\n\nChanged body' });
    const commit = jest.spyOn(NoteVersionWriter.prototype, 'commit');

    await t.handler.process(t.job(item.id));

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ noteId: note.id, baseVersion: 1, kind: 'edit', authorId: OWNER, summary: 'Updated from a/b.md', sourceObjectId: item.sourceObjectId }), expect.anything());
    expect(t.db.note.rows[0]).toMatchObject({ currentVersion: 2, body: 'Changed body', sourceObjectId: item.sourceObjectId });
    expect(t.db.noteImportBatchItem.rows[0]).toMatchObject({ status: 'imported', noteVersion: 2, diverged: false });
    expect(t.db.noteLibraryFile.rows.find((r: any) => r.id === file!.id)).toMatchObject({ importedVersion: 2, status: 'imported' });
    expect(t.store.objects.has(prior.id)).toBe(false);
    expect(t.emitted[0]!.payload).toMatchObject({ version: 2, origin: 'library', bulk: true });
    commit.mockRestore();
  });

  it('flags a note edited since import as diverged', async () => {
    const t = build();
    const note = await t.db.note.create({ data: { ownerId: OWNER, title: 'T', body: 'x', bodyFormat: 'markdown', currentVersion: 3, sourceType: 'document', sourceObjectId: null } });
    const { item, file } = await t.seed({ action: 'changed', file: { noteId: note.id, importedVersion: 1 } });

    await t.handler.process(t.job(item.id));

    expect(t.db.note.rows[0].currentVersion).toBe(4);
    expect(t.db.noteImportBatchItem.rows[0]).toMatchObject({ diverged: true, noteVersion: 4 });
    expect(t.db.noteLibraryFile.rows.find((r: any) => r.id === file!.id)).toMatchObject({ status: 'diverged', importedVersion: 4 });
  });

  it('treats a deleted note as a new import', async () => {
    const t = build();
    const note = await t.db.note.create({ data: { ownerId: OWNER, title: 'T', body: 'x', bodyFormat: 'markdown', currentVersion: 1, deletedAt: new Date() } });
    const { item, file } = await t.seed({ action: 'changed', file: { noteId: note.id, importedVersion: 1 } });

    await t.handler.process(t.job(item.id));

    expect(t.db.note.rows).toHaveLength(2);
    const created = t.db.note.rows[1];
    expect(t.db.noteLibraryFile.rows.find((r: any) => r.id === file!.id)).toMatchObject({ noteId: created.id, importedVersion: 1 });
  });

  it('a parse failure fails the item and file, creates no note and completes the job', async () => {
    const t = build();
    const { item, file, batch } = await t.seed({ text: '   \n', mime: 'text/plain', filename: 'x.txt' });

    await expect(t.handler.process(t.job(item.id))).resolves.toBeUndefined();

    expect(t.db.note.rows).toHaveLength(0);
    expect(t.db.noteImportBatchItem.rows[0]).toMatchObject({ status: 'failed' });
    expect(t.db.noteImportBatchItem.rows[0].failureReason.length).toBeGreaterThan(0);
    expect(t.db.noteLibraryFile.rows.find((r: any) => r.id === file!.id).status).toBe('failed');
    expect(t.db.noteImportBatch.rows.find((r: any) => r.id === batch.id).status).toBe('completed_with_errors');
    expect(t.emitted).toEqual([]);
  });

  it('an unexpected error rethrows, and marks the item internal_error only on the last attempt', async () => {
    const t = build();
    const { item } = await t.seed({});
    const spy = jest.spyOn(t.db.note, 'create').mockRejectedValue(new Error('db down'));

    await expect(t.handler.process(t.job(item.id, 1))).rejects.toThrow('db down');
    expect(t.db.noteImportBatchItem.rows[0].status).toBe('importing');

    await expect(t.handler.process(t.job(item.id, 3))).rejects.toThrow('db down');
    expect(t.db.noteImportBatchItem.rows[0]).toMatchObject({ status: 'failed', failureReason: 'internal_error' });
    spy.mockRestore();
  });

  it('a missing item is a no-op', async () => {
    const t = build();
    await expect(t.handler.process(t.job('nope'))).resolves.toBeUndefined();
  });
});
