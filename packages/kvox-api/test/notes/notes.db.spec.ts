import { randomUUID } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';

import { NoteAccessService } from '../../src/notes/access/note-access.service.js';
import type { KvoxNotesDb } from '../../src/notes/data/notes-db.js';
import { NoteGenerationService } from '../../src/notes/generation/note-generation.service.js';
import { NOTE_BUILTIN_TEMPLATES, seedNoteTemplates } from '../../src/notes/templates/index.js';
import { NOTE_READY_EVENT } from '../../src/notes/notes.events.js';
import { resolveNotesOptions } from '../../src/notes/notes.options.js';
import { NotesUserDataService } from '../../src/notes/user-data/notes-user-data.service.js';
import { createFakeKvoxJobs } from '../../src/testing/index.js';
import { createTestDb, type TestDb } from '../host/db.js';

// =============================================================================
// The notes slice on the test host: a real PostgreSQL (issue #495, epic #491)
// =============================================================================
//
// What a structural client cannot prove: that `KvoxNotesDb` really is the generated client's
// shape (the delegates, the columns, the `$transaction` callback form), that the built-in
// templates seed idempotently against the real unique keys, and that the note-ready event leaves
// only after the row it describes is committed and readable by a second connection.
//
// Visibility is the OWNER-ONLY posture of the slice: a stranger gets the same 404 as a missing
// note. (Transcript sharing and row-level security are the web edition's, and stay in the
// application's own db specs.)
//
// Needs `npm run test:host:prepare -w @marinoscar/kvox-api` and PostgreSQL 16 with pgvector; run by
// `npm run test:db -w @marinoscar/kvox-api -- notes`.
// =============================================================================

let testDb: TestDb;
let db: KvoxNotesDb;

beforeAll(async () => {
  testDb = await createTestDb();
  db = testDb.prisma as unknown as KvoxNotesDb;
});

afterAll(async () => {
  await testDb?.dispose();
});

async function insertUser(label: string): Promise<string> {
  const id = randomUUID();

  await testDb.prisma.$executeRaw`
    INSERT INTO users (id, email, updated_at) VALUES (${id}::uuid, ${`notes-${label}-${id}@example.test`}, now())
  `;

  return id;
}

describe('seedNoteTemplates', () => {
  it('creates the six built-ins once, and a second run creates nothing', async () => {
    const first = await seedNoteTemplates(db);
    const second = await seedNoteTemplates(db);

    expect(first).toEqual({ created: NOTE_BUILTIN_TEMPLATES.length, updated: 0 });
    expect(second).toEqual({ created: 0, updated: NOTE_BUILTIN_TEMPLATES.length });
    expect(await testDb.prisma.noteTemplate.count({ where: { ownerId: null } })).toBe(NOTE_BUILTIN_TEMPLATES.length);
  });

  it('seeds each built-in under its fixed id with no owner, and re-asserts an edited field', async () => {
    const [template] = NOTE_BUILTIN_TEMPLATES;

    await testDb.prisma.noteTemplate.update({ where: { id: template.id }, data: { tone: 'edited by hand' } });
    await seedNoteTemplates(db);

    const row = await testDb.prisma.noteTemplate.findUnique({ where: { id: template.id } });

    expect(row?.ownerId).toBeNull();
    expect(row?.name).toBe(template.name);
    expect(row?.tone).toBe(template.tone);
  });
});

describe('NoteGenerationService.commit over the real client', () => {
  it('writes the version and the ready note in one transaction, then publishes the event', async () => {
    const ownerId = await insertUser('owner');
    const note = await testDb.prisma.note.create({
      data: { ownerId, title: 'Draft', sourceType: 'document', status: 'generating' },
    });
    const generation = await testDb.prisma.noteGeneration.create({
      data: {
        noteId: note.id,
        kind: 'create',
        status: 'streaming',
        templateNameSnapshot: 'Concise Meeting Notes',
        sourceType: 'document',
        providerId: 'fake',
        model: 'fake-model',
      },
    });
    const seen: Array<{ name: string; payload: unknown; status: string | undefined }> = [];
    const events = {
      emit: (name: string, payload: unknown): void => {
        // A second connection: the row must already be committed to be visible here.
        void testDb.prisma.note
          .findUnique({ where: { id: note.id } })
          .then((row) => seen.push({ name, payload, status: row?.status }));
      },
      subscribe: () => () => undefined,
    };
    const service = new NoteGenerationService(
      db,
      { notify: () => undefined, registerEvents: () => undefined },
      events,
      resolveNotesOptions({}),
      { titleNote: async () => null } as never,
      { enqueue: async () => undefined } as never,
    );

    await service.commit({
      generation: { ...generation, note } as never,
      content: '# Summary\n\nShipped.',
      promptTokens: 10,
      completionTokens: 5,
      providerLabel: 'Fake',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const row = await testDb.prisma.note.findUniqueOrThrow({ where: { id: note.id } });
    const versions = await testDb.prisma.noteVersion.findMany({ where: { noteId: note.id } });

    expect(row).toMatchObject({ status: 'ready', currentVersion: 1, body: '# Summary\n\nShipped.' });
    expect(versions.map((version) => version.kind)).toEqual(['ai_generated']);
    expect(seen).toEqual([
      { name: NOTE_READY_EVENT, payload: { noteId: note.id, ownerId, version: 1 }, status: 'ready' },
    ]);
  });
});

describe('the owner-only default', () => {
  it('answers a stranger with the same 404 as a missing note, and counts only the owner\'s notes', async () => {
    const ownerId = await insertUser('owner-only');
    const strangerId = await insertUser('stranger');
    const note = await testDb.prisma.note.create({
      data: { ownerId, title: 'Private', sourceType: 'document', status: 'ready' },
    });
    const access = new NoteAccessService(db);

    await expect(access.require(ownerId, note.id, 'view')).resolves.toMatchObject({ role: 'owner' });
    await expect(access.require(strangerId, note.id, 'view')).rejects.toBeInstanceOf(NotFoundException);
    await expect(access.require(strangerId, randomUUID(), 'view')).rejects.toBeInstanceOf(NotFoundException);

    const userData = new NotesUserDataService(db, createFakeKvoxJobs());

    await expect(userData.summary(ownerId)).resolves.toEqual({ notes: 1, templates: 0 });
    await expect(userData.summary(strangerId)).resolves.toEqual({ notes: 0, templates: 0 });
  });

  it('detaches notes derived from another note, so both can be purged', async () => {
    const ownerId = await insertUser('derived');
    const source = await testDb.prisma.note.create({
      data: { ownerId, title: 'Source', sourceType: 'document', status: 'ready' },
    });
    const derived = await testDb.prisma.note.create({
      data: { ownerId, title: 'Derived', sourceType: 'note', sourceNoteId: source.id, status: 'ready' },
    });
    const userData = new NotesUserDataService(db, createFakeKvoxJobs());

    await expect(userData.clearDerivedReferences([source.id])).resolves.toBe(1);
    await expect(testDb.prisma.note.findUniqueOrThrow({ where: { id: derived.id } })).resolves.toMatchObject({
      sourceNoteId: null,
    });
    await expect(userData.clearDerivedReferences([])).resolves.toBe(0);
  });
});
