import { NoteImportFormatHandler } from '../../../src/notes/handlers/note-import-format.handler.js';
import { NoteVersionWriter } from '../../../src/notes/note-version-writer.js';
import { NOTE_READY_EVENT } from '../../../src/notes/notes.events.js';
import {
  KvoxAiError,
  KvoxRateLimitError,
  type KvoxEventsPort,
  type KvoxJob,
} from '../../../src/ports/index.js';
import {
  createFakeKvoxAi,
  createFakeKvoxJobs,
  createRecordingKvoxAudit,
  type FakeKvoxAiScript,
} from '../../../src/testing/index.js';
import { createLibraryFakeDb } from '../library/library-fake-db.js';

const OWNER = 'owner-1';

const WRAPPED =
  'Quarterly Review\nThe committee met on Tuesday to review the budget for the coming year and agreed\n' +
  'that travel spending should be reduced by ten percent while training spending stays flat across\n' +
  'every department of the company.\nItem one\nItem two';

const FORMATTED =
  '# Quarterly Review\n\nThe committee met on Tuesday to review the budget for the coming year and agreed ' +
  'that travel spending should be reduced by ten percent while training spending stays flat across ' +
  'every department of the company.\n\n- Item one\n- Item two';

function build(script: FakeKvoxAiScript = { text: FORMATTED }) {
  const db = createLibraryFakeDb();
  const jobs = createFakeKvoxJobs();
  const ai = createFakeKvoxAi({ script });
  const audit = createRecordingKvoxAudit();
  const emitted: Array<{ name: string; payload: any; version: number }> = [];
  const events: KvoxEventsPort = {
    emit: (name, payload) => void emitted.push({ name, payload, version: db.note.rows[0]?.currentVersion }),
    subscribe: () => () => undefined,
  };
  const searchIndex = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const handler = new NoteImportFormatHandler(
    db as never,
    jobs,
    ai,
    audit,
    events,
    new NoteVersionWriter(db as never),
    searchIndex as never,
  );

  async function seed(opts: { body?: string; currentVersion?: number; autoExtract?: boolean; adHoc?: boolean } = {}) {
    const library = opts.adHoc ? null : await db.noteLibrary.create({ data: { ownerId: OWNER, name: 'L', autoExtract: opts.autoExtract ?? true } });
    const batch = await db.noteImportBatch.create({ data: { ownerId: OWNER, libraryId: library?.id ?? null } });
    const item = await db.noteImportBatchItem.create({ data: { batchId: batch.id, filename: 'a.pdf', action: 'new', status: 'imported' } });
    const note = await db.note.create({
      data: { ownerId: OWNER, title: 'T', body: opts.body ?? WRAPPED, bodyFormat: 'markdown', currentVersion: opts.currentVersion ?? 1 },
    });
    return { item, note };
  }

  const job = (noteId: string, itemId?: string, version = 1): KvoxJob => ({
    id: 'job-1', type: 'note.import.format', subjectType: 'note', subjectId: noteId, payload: { noteId, version, ...(itemId ? { itemId } : {}) }, attempts: 1, orgId: null,
  });

  const modelCalls = () => ai.calls.filter((c) => c.method === 'generateText');

  return { db, jobs, ai, audit, emitted, searchIndex, handler, seed, job, modelCalls };
}

describe('NoteImportFormatHandler', () => {
  it('is server-only, uses AI, declares the profile and registers itself', () => {
    const { handler, jobs } = build();
    expect(handler.type).toBe('note.import.format');
    expect(handler.usesAi).toBe(true);
    expect(handler.profile).toEqual({ maxRuntimeMs: 10 * 60_000, maxAttempts: 1 });
    expect((handler as any).nodeResultSchema).toBeUndefined();
    expect((handler as any).persistNodeResult).toBeUndefined();
    handler.onModuleInit();
    expect(jobs.isRegistered('note.import.format')).toBe(true);
  });

  it('formats: commits the next version as the AI, indexes it, then publishes note_ready with that version', async () => {
    const t = build();
    const { item, note } = await t.seed();

    await t.handler.process(t.job(note.id, item.id));

    expect(t.db.note.rows[0]).toMatchObject({ currentVersion: 2, body: `${FORMATTED}\n`, bodyFormat: 'markdown' });
    expect(t.db.noteVersion.rows).toEqual([
      expect.objectContaining({ noteId: note.id, version: 2, kind: 'edit', authorId: null, summary: 'Formatted with AI', bodyFormat: 'markdown' }),
    ]);
    expect(t.searchIndex.enqueue).toHaveBeenCalledWith('note', note.id);
    expect(t.emitted).toEqual([
      { name: NOTE_READY_EVENT, payload: { noteId: note.id, ownerId: OWNER, version: 2, origin: 'library', bulk: true }, version: 2 },
    ]);
    expect(t.audit.recorded).toEqual([
      expect.objectContaining({ action: 'note:import_format', targetId: note.id, meta: expect.objectContaining({ outcome: 'formatted', version: 2, itemId: item.id }) }),
    ]);
    expect(JSON.stringify(t.audit.recorded)).not.toContain('committee');
    const call = t.modelCalls()[0]!.req as { system: string; user: string };
    expect(call.user).toBe(WRAPPED);
    expect(call.system).toMatch(/NOT/);
  });

  it('keeps version 1 when the guard refuses (a summary), and still publishes note_ready for v1', async () => {
    const t = build({ text: 'The committee reduced travel.' });
    const { item, note } = await t.seed();

    await t.handler.process(t.job(note.id, item.id));

    expect(t.db.note.rows[0]).toMatchObject({ currentVersion: 1, body: WRAPPED });
    expect(t.db.noteVersion.rows).toEqual([]);
    expect(t.searchIndex.enqueue).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0]!.payload).toMatchObject({ version: 1, origin: 'library', bulk: true });
    expect(t.audit.recorded[0]!.meta).toMatchObject({ outcome: 'unfaithful', reason: 'dropped_content' });
  });

  it('refuses an answer that invents content', async () => {
    const t = build({ text: `${FORMATTED}\n\nIn conclusion the committee made several important decisions that will shape the company.` });
    const { item, note } = await t.seed();
    await t.handler.process(t.job(note.id, item.id));

    expect(t.db.note.rows[0]!.currentVersion).toBe(1);
    expect(t.audit.recorded[0]!.meta).toMatchObject({ outcome: 'unfaithful', reason: 'added_content' });
  });

  it('skips with ai_unavailable when the owner has no key, calls no model, and still publishes note_ready', async () => {
    const t = build({ failWith: 'key_missing' });
    const { item, note } = await t.seed();

    await t.handler.process(t.job(note.id, item.id));

    expect(t.modelCalls()).toEqual([]);
    expect(t.db.note.rows[0]!.currentVersion).toBe(1);
    expect(t.audit.recorded[0]!.meta).toMatchObject({ outcome: 'ai_unavailable', reason: 'key_missing' });
    expect(t.emitted).toHaveLength(1);
  });

  it('skips a note the owner edited since the import (stale version): no model call, note_ready at the current version', async () => {
    const t = build();
    const { item, note } = await t.seed({ currentVersion: 3 });

    await t.handler.process(t.job(note.id, item.id, 1));

    expect(t.modelCalls()).toEqual([]);
    expect(t.db.note.rows[0]).toMatchObject({ currentVersion: 3, body: WRAPPED });
    expect(t.audit.recorded[0]!.meta).toMatchObject({ outcome: 'stale_version' });
    expect(t.emitted[0]!.payload.version).toBe(3);
  });

  it('does not overwrite an edit that lands between the read and the commit', async () => {
    const t = build();
    const { item, note } = await t.seed();
    const original = t.ai.generateText.bind(t.ai);
    jest.spyOn(t.ai, 'generateText').mockImplementation((ctx, req) => {
      // The owner saves while the model is writing.
      t.db.note.rows[0].currentVersion = 2;
      return original(ctx, req);
    });

    await t.handler.process(t.job(note.id, item.id));

    expect(t.db.note.rows[0]).toMatchObject({ currentVersion: 2, body: WRAPPED });
    expect(t.db.noteVersion.rows).toEqual([]);
    expect(t.audit.recorded[0]!.meta).toMatchObject({ outcome: 'stale_version' });
  });

  it('publishes nothing for a library with autoExtract off, but publishes for an ad-hoc import and for a job with no item', async () => {
    const off = build();
    const a = await off.seed({ autoExtract: false });
    await off.handler.process(off.job(a.note.id, a.item.id));
    expect(off.db.note.rows[0]!.currentVersion).toBe(2);
    expect(off.emitted).toEqual([]);

    const adHoc = build();
    const b = await adHoc.seed({ adHoc: true });
    await adHoc.handler.process(adHoc.job(b.note.id, b.item.id));
    expect(adHoc.emitted).toHaveLength(1);

    const noItem = build();
    const c = await noItem.seed();
    await noItem.handler.process(noItem.job(c.note.id));
    expect(noItem.emitted).toHaveLength(1);
  });

  it('keeps the imported text on a provider error and still publishes note_ready', async () => {
    const t = build();
    const { item, note } = await t.seed();
    jest.spyOn(t.ai, 'generateText').mockImplementation(() => {
      throw new KvoxAiError('auth', 'bad key');
    });

    await expect(t.handler.process(t.job(note.id, item.id))).resolves.toBeUndefined();

    expect(t.db.note.rows[0]!.currentVersion).toBe(1);
    expect(t.audit.recorded[0]!.meta).toMatchObject({ outcome: 'ai_error', reason: 'auth' });
    expect(t.emitted).toHaveLength(1);
  });

  it('defers on a provider rate limit (rethrown as the queue deferral) and publishes nothing yet', async () => {
    const t = build();
    const { item, note } = await t.seed();
    jest.spyOn(t.ai, 'generateText').mockImplementation(() => {
      throw new KvoxAiError('rate_limit', 'slow down', 1500);
    });

    const failure = await t.handler.process(t.job(note.id, item.id)).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(KvoxRateLimitError);
    expect(failure).toMatchObject({ retryAfterMs: 1500 });
    expect(t.emitted).toEqual([]);
    expect(t.audit.recorded).toEqual([]);
  });

  it('a failure after the model (the commit) keeps v1 and still publishes', async () => {
    const t = build();
    const { item, note } = await t.seed();
    jest.spyOn(NoteVersionWriter.prototype, 'commit').mockRejectedValueOnce(new Error('db down'));

    await expect(t.handler.process(t.job(note.id, item.id))).resolves.toBeUndefined();

    expect(t.audit.recorded[0]!.meta).toMatchObject({ outcome: 'error' });
    expect(t.emitted).toHaveLength(1);
    jest.restoreAllMocks();
  });

  it('survives a failing search index or event bus after the commit', async () => {
    const t = build();
    const { item, note } = await t.seed();
    t.searchIndex.enqueue.mockRejectedValue(new Error('index down'));

    await expect(t.handler.process(t.job(note.id, item.id))).resolves.toBeUndefined();
    expect(t.db.note.rows[0]!.currentVersion).toBe(2);
  });

  it('is a no-op for a missing or deleted note and for a garbage payload', async () => {
    const t = build();
    await expect(t.handler.process(t.job('nope'))).resolves.toBeUndefined();
    const { note } = await t.seed();
    t.db.note.rows[0]!.deletedAt = new Date();
    await t.handler.process(t.job(note.id));
    await t.handler.process({ ...t.job(note.id), payload: { noteId: note.id } } as KvoxJob);
    await t.handler.process({ ...t.job(note.id), payload: null } as KvoxJob);

    expect(t.modelCalls()).toEqual([]);
    expect(t.emitted).toEqual([]);
  });

  it('skips an empty body without a model call', async () => {
    const t = build();
    const { item, note } = await t.seed({ body: '  \n' });
    await t.handler.process(t.job(note.id, item.id));

    expect(t.modelCalls()).toEqual([]);
    expect(t.audit.recorded[0]!.meta).toMatchObject({ outcome: 'empty' });
  });
});
