import { BadRequestException } from '@nestjs/common';

import { parseNoteMarkdownExport } from '@marinoscar/kvox-contract/notes';

import {
  createFakeKvoxJobs,
  createInMemoryKvoxObjectStore,
  createRecordingKvoxAudit,
} from '../../../src/testing/index.js';
import type { KvoxEventsPort } from '../../../src/ports/index.js';
import { MarkdownNoteExporter } from '../../../src/notes/export/markdown.exporter.js';
import { NoteExporterRegistry } from '../../../src/notes/export/note-exporter.registry.js';
import { NoteImportService } from '../../../src/notes/import/note-import.service.js';
import { NOTE_SOURCE_EXTRACT_JOB_TYPE } from '../../../src/notes/job-types.js';
import { NoteObjectsService } from '../../../src/notes/note-objects.service.js';
import { NOTE_READY_EVENT } from '../../../src/notes/notes.events.js';
import type { NotesActor } from '../../../src/notes/notes-actor.js';
import { FIXTURE_BODY, collect, noteDocument } from '../../../src/notes/testing/export-fixtures.js';

// =============================================================================
// NoteImportService over in-memory ports (issue #585)
// =============================================================================
//
// Pins the write shape (a `ready` note with version 1, an `edit` by the importer),
// the export -> import round trip through the REAL Markdown exporter, the typed
// 400s, the compensation when the transaction fails, and what happens after the
// commit (the extraction and index enqueues, `kvox.notes.note_ready`).
// =============================================================================

const USER: NotesActor = { id: '11111111-1111-4111-8111-111111111111', permissions: ['notes:write'] };

function createDb(options: { failOn?: 'version' } = {}) {
  const notes = new Map<string, Record<string, unknown>>();
  const versions: Record<string, unknown>[] = [];
  let n = 0;
  const tx = {
    note: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        n += 1;
        const row = { id: `00000000-0000-4000-8000-00000000000${n}`, ...data };
        notes.set(row.id, row);
        return row;
      }),
    },
    noteVersion: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.failOn === 'version') throw new Error('version write refused');
        versions.push(data);
        return data;
      }),
    },
  };
  const db = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      const snapshot = new Map(notes);
      try {
        return await fn(tx);
      } catch (error) {
        notes.clear();
        for (const [k, v] of snapshot) notes.set(k, v);
        throw error;
      }
    },
  };
  return { db, notes, versions };
}

function build(options: { failOn?: 'version' } = {}) {
  const recording = createDb(options);
  const store = createInMemoryKvoxObjectStore();
  const jobs = createFakeKvoxJobs();
  const audit = createRecordingKvoxAudit();
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const events: KvoxEventsPort = {
    emit: (name, payload) => void emitted.push({ name, payload }),
    subscribe: () => () => undefined,
  };
  const searchIndex = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new NoteImportService(
    recording.db as never,
    audit,
    jobs,
    events,
    new NoteObjectsService(store),
    searchIndex as never,
  );
  return { service, recording, store, jobs, audit, emitted, searchIndex };
}

const exporter = new MarkdownNoteExporter(new NoteExporterRegistry());

describe('NoteImportService', () => {
  it('imports a Markdown export as a ready note with the same title and body (round trip)', async () => {
    const { service, recording, store } = build();
    const exported = await collect(exporter, noteDocument());

    const { noteId } = await service.importFile(USER, { filename: 'C:\\exports\\weekly-sync-recap.md', body: exported });
    const row = recording.notes.get(noteId)!;

    expect(row).toMatchObject({
      ownerId: USER.id,
      title: 'Weekly Sync Recap',
      titleSource: 'user',
      body: FIXTURE_BODY,
      bodyFormat: 'markdown',
      status: 'ready',
      currentVersion: 1,
      sourceType: 'document',
    });
    expect(recording.versions).toEqual([
      expect.objectContaining({
        noteId,
        version: 1,
        kind: 'edit',
        body: FIXTURE_BODY,
        authorId: USER.id,
        summary: 'Imported from C:_exports_weekly-sync-recap.md',
      }),
    ]);

    const source = store.objects.get(row.sourceObjectId as string)!;
    expect(source).toMatchObject({ managedBy: 'notes', mimeType: 'text/markdown' });
    expect(source.key).toMatch(/^notes\/sources\/uploads\/[0-9a-f-]{36}\/source\.md$/);
    expect((source.metadata as Record<string, any>).importedFrom).toMatchObject({
      noteId: '11111111-1111-4111-8111-111111111111',
      templateName: 'Concise Meeting Notes',
      source: { type: 'transcript', title: 'Weekly Sync' },
    });
  });

  it('exports the imported note to the same title and body again', async () => {
    const { service, recording } = build();
    const first = await collect(exporter, noteDocument());

    const { noteId } = await service.importFile(USER, { filename: 'n.md', body: first });
    const row = recording.notes.get(noteId)!;
    const again = (await collect(exporter, noteDocument({ title: row.title as string, body: row.body as string }))).toString('utf8');
    const reread = parseNoteMarkdownExport(again);

    expect(reread.ok && reread.note.title).toBe('Weekly Sync Recap');
    expect(reread.ok && reread.note.body).toBe(FIXTURE_BODY);
  });

  it('queues the source extraction and the search index, then publishes note_ready', async () => {
    const { service, recording, jobs, searchIndex, emitted, audit } = build();

    const { noteId } = await service.importFile(USER, { filename: 'n.md', body: Buffer.from('# T\n\nBody\n') });
    const objectId = recording.notes.get(noteId)!.sourceObjectId;

    expect(jobs.jobs.map((job) => job.input)).toEqual([
      expect.objectContaining({ type: NOTE_SOURCE_EXTRACT_JOB_TYPE, subjectType: 'storage_object', subjectId: objectId }),
    ]);
    expect(searchIndex.enqueue).toHaveBeenCalledWith('note', noteId);
    expect(emitted).toEqual([{ name: NOTE_READY_EVENT, payload: { noteId, ownerId: USER.id, version: 1 } }]);
    expect(audit.recorded).toEqual([expect.objectContaining({ action: 'note:import', targetId: noteId })]);
    // The audit carries counts and ids, never the title or the text.
    expect(JSON.stringify(audit.recorded)).not.toContain('Body');
  });

  it.each([
    ['not_text', Buffer.from([0xff, 0xfe, 0x00, 0x41])],
    ['not_text', Buffer.from('abc\u0000def')],
    ['invalid_front_matter', Buffer.from('---\ntitle: "x"\nno colon here\n---\nBody')],
    ['unsupported_note_format', Buffer.from('---\nschema: "kvox.note/v9"\n---\nBody')],
    ['empty_note', Buffer.from('')],
  ])('answers %s with a 400 carrying details.reason, and stores nothing', async (reason, body) => {
    const { service, store, recording } = build();

    const error = await service.importFile(USER, { filename: 'x.md', body }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ details: { reason } });
    expect(store.objects.size).toBe(0);
    expect(recording.notes.size).toBe(0);
  });

  it('deletes the stored file again when the transaction fails, and publishes nothing', async () => {
    const { service, store, emitted, jobs } = build({ failOn: 'version' });

    await expect(service.importFile(USER, { filename: 'n.md', body: Buffer.from('Body') })).rejects.toThrow('version write refused');
    expect(store.objects.size).toBe(0);
    expect(emitted).toEqual([]);
    expect(jobs.jobs).toEqual([]);
  });
});
