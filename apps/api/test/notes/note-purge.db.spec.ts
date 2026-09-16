// =============================================================================
// Real-Postgres test: delete, then purge (issue #53, epic #45)
// =============================================================================
//
// ⚠ THE ACCEPTANCE CRITERION THIS FILE IS: "`DELETE` soft-deletes and queues
// `note.purge`; after purge the rows are gone and the source transcript is
// **untouched**."
//
// It is a `*.db.spec.ts` for one reason: every interesting claim here is about
// what the DATABASE does with foreign keys the application never states twice.
// `note_versions` and `note_generations` disappear because `note_id` CASCADEs;
// the transcript survives because `source_transcript_id` is `Restrict` and this
// handler does not reach through it. Both are properties of a migration, and a
// mock has no migrations.
//
// -----------------------------------------------------------------------------
// WHAT IS REAL AND WHAT IS A STAND-IN
// -----------------------------------------------------------------------------
//
// The database is real, `NotesService.remove`, `NoteAccessService` and
// `NotePurgeHandler` are real. `JobsService` is a recorder — this file asserts
// that the RIGHT job is queued, not how the queue inserts rows (which
// `jobs.service.spec.ts` already owns) — and `NoteObjectsService` is a recorder
// too, because deleting bytes needs an object store and the decision worth
// testing is WHICH objects were named, not whether S3 answered.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import { NoteAccessService } from '../../src/notes/access/note-access.service';
import { NotePurgeHandler } from '../../src/notes/handlers/note-purge.handler';
import { NOTE_PURGE_JOB_TYPE, NOTE_SUBJECT_TYPE } from '../../src/notes/job-types';
import type { NotesService } from '../../src/notes/notes.service';
import { buildNotesService } from './notes-service-test-factory';

/** Copied verbatim from `note-schema.db.spec.ts`; these files stay self-contained. */
function isPostgresReachable(host: string, port: number, timeoutMs = 2000): boolean {
  try {
    const probe = `
      const net = require('net');
      const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
      const done = (ok) => { try { socket.destroy(); } catch (_e) {} process.exit(ok ? 0 : 1); };
      socket.setTimeout(${timeoutMs});
      socket.on('connect', () => done(true));
      socket.on('timeout', () => done(false));
      socket.on('error', () => done(false));
    `;
    execFileSync(process.execPath, ['-e', probe, host, String(port)], {
      stdio: 'ignore',
      timeout: timeoutMs + 1000,
    });
    return true;
  } catch {
    return false;
  }
}

const postgresHost = process.env.POSTGRES_HOST;
const postgresPort = Number(process.env.POSTGRES_PORT) || 5432;
const dbReachable =
  Boolean(postgresHost) && isPostgresReachable(postgresHost as string, postgresPort);

if (!dbReachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[note-purge.db.spec] SKIPPED: no Postgres reachable at ` +
      `${postgresHost ?? '(POSTGRES_HOST unset)'}:${postgresPort}.\n`,
  );
}

const describeWithDb = dbReachable ? describe : describe.skip;

describeWithDb('Note delete and purge (real Postgres)', () => {
  let prisma: PrismaClient;
  let notes: NotesService;
  let purge: NotePurgeHandler;

  const queued: Array<Record<string, unknown>> = [];
  const deletedObjects: Array<string | null | undefined> = [];

  const EMAIL_PREFIX = 'note-purge-test';
  const TITLE_PREFIX = 'test-purge-note-';
  const KEY_PREFIX = 'test-purge/';

  const jobs = {
    enqueue: jest.fn(async (input: Record<string, unknown>) => {
      queued.push(input);

      return { id: randomUUID() };
    }),
  };

  const objects = {
    deleteIfPresent: jest.fn(async (objectId: string | null | undefined) => {
      deletedObjects.push(objectId);

      return Boolean(objectId);
    }),
  };

  beforeAll(async () => {
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();

    const access = new NoteAccessService(prisma as never);

    // Only the collaborators the exercised paths use: `remove` needs access,
    // prisma and the queue; nothing here creates or regenerates, so
    // `sourceNames`, `templates`, `requests` and `sources` are all stand-ins.
    // Named by role (see `notes-service-test-factory.ts`) so no argument can
    // land in the wrong slot the way #224's did.
    notes = buildNotesService({
      prisma: prisma as never,
      access,
      sourceNames: null as never, // not on the exercised path
      templates: null as never, // not on the exercised path
      requests: null as never, // not on the exercised path
      sources: null as never, // not on the exercised path
      jobs: jobs as never, // `remove` enqueues `note.purge` through this
      // #188's semantic indexer — but note `NotesService.remove` does NOT
      // reach it: `indexAfterCommit`/`.enqueue()` is only called from `update`
      // and `restore` (a rename or a body edit moves what search should match),
      // neither of which this file's `remove()` call exercises. This mock is a
      // stand-in like the four above it, not a reached collaborator; it stays a
      // harmless no-op mock rather than `null as never` only because nothing
      // here depends on distinguishing the two.
      searchIndex: { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    });

    purge = new NotePurgeHandler(
      { register: jest.fn() } as never,
      prisma as never,
      objects as never,
      // #188: the purge FORGETS the note's chunks before deleting the row —
      // `search_chunks.document_id` has no foreign key, so nothing else would
      // ever clean them up.
      { forget: jest.fn().mockResolvedValue(undefined) } as never,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    queued.length = 0;
    deletedObjects.length = 0;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await prisma.note.updateMany({
      where: { title: { startsWith: TITLE_PREFIX } },
      data: { currentGenerationId: null },
    });
    await prisma.noteVersion.deleteMany({
      where: { note: { title: { startsWith: TITLE_PREFIX } } },
    });
    await prisma.noteGeneration.deleteMany({
      where: { note: { title: { startsWith: TITLE_PREFIX } } },
    });
    await prisma.note.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.transcript.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.storageObject.deleteMany({ where: { storageKey: { startsWith: KEY_PREFIX } } });
    await prisma.auditEvent.deleteMany({ where: { targetType: 'note' } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  async function createUser() {
    return prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      },
    });
  }

  async function createObject(ownerId: string, name: string, metadata?: object) {
    return prisma.storageObject.create({
      data: {
        name,
        size: BigInt(1024),
        mimeType: 'application/pdf',
        storageKey: `${KEY_PREFIX}${randomUUID()}`,
        managedBy: 'notes',
        uploadedById: ownerId,
        metadata: metadata as never,
      },
    });
  }

  /** A transcript with its own (transcripts-managed) source object. */
  async function createTranscript(ownerId: string) {
    const audio = await prisma.storageObject.create({
      data: {
        name: 'audio.m4a',
        size: BigInt(2048),
        mimeType: 'audio/mp4',
        storageKey: `${KEY_PREFIX}${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: ownerId,
      },
    });

    return prisma.transcript.create({
      data: {
        ownerId,
        title: `${TITLE_PREFIX}transcript`,
        sourceObjectId: audio.id,
        provider: 'assemblyai',
      },
    });
  }

  /** A note with a version and a generation, exactly as a ready note has. */
  async function createReadyNote(
    ownerId: string,
    source: { transcriptId?: string; objectId?: string },
  ) {
    const note = await prisma.note.create({
      data: {
        ownerId,
        title: `${TITLE_PREFIX}${randomUUID().slice(0, 8)}`,
        body: '# Notes\n\nWe ship on Friday.',
        status: 'ready',
        currentVersion: 1,
        sourceType: source.transcriptId ? 'transcript' : 'document',
        sourceTranscriptId: source.transcriptId ?? null,
        sourceObjectId: source.objectId ?? null,
      },
    });

    const generation = await prisma.noteGeneration.create({
      data: {
        noteId: note.id,
        kind: 'create',
        status: 'succeeded',
        templateNameSnapshot: 'Concise Meeting Notes',
        sourceType: note.sourceType,
        sourceTranscriptId: note.sourceTranscriptId,
        sourceObjectId: note.sourceObjectId,
        providerId: 'openai',
        model: 'gpt-4o',
      },
    });

    await prisma.noteVersion.create({
      data: {
        noteId: note.id,
        version: 1,
        kind: 'ai_generated',
        body: note.body,
        // ⚠ `authorId: null` MEANS THE AI, which is why this row can exist with
        // no user attached at all.
        authorId: null,
        generationId: generation.id,
      },
    });

    return prisma.note.update({
      where: { id: note.id },
      data: { currentGenerationId: generation.id },
    });
  }

  const caller = (id: string) =>
    ({ id, email: 'x@example.test', roles: [], permissions: [PERMISSIONS.NOTES_WRITE] }) as never;

  it('soft-deletes, queues `note.purge`, and then leaves the transcript untouched', async () => {
    const owner = await createUser();
    const transcript = await createTranscript(owner.id);
    const note = await createReadyNote(owner.id, { transcriptId: transcript.id });

    await notes.remove(note.id, caller(owner.id));

    // ---- the soft delete ----------------------------------------------------
    const soft = await prisma.note.findUnique({ where: { id: note.id } });

    expect(soft?.status).toBe('deleting');
    expect(soft?.deletedAt).toBeInstanceOf(Date);

    // The versions are still there; nothing has been destroyed yet. That is the
    // point of soft-deleting: the user-visible delete is instant, the durable
    // cleanup is the queue's job.
    await expect(prisma.noteVersion.count({ where: { noteId: note.id } })).resolves.toBe(1);

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: NOTE_PURGE_JOB_TYPE,
      subjectType: NOTE_SUBJECT_TYPE,
      subjectId: note.id,
      payload: { noteId: note.id },
    });

    // ---- the purge ----------------------------------------------------------
    await purge.process({ id: 'job-1', payload: { noteId: note.id } } as never);

    await expect(prisma.note.findUnique({ where: { id: note.id } })).resolves.toBeNull();
    // CASCADE took both children with the note. Nothing in the handler names
    // them; the migration does.
    await expect(prisma.noteVersion.count({ where: { noteId: note.id } })).resolves.toBe(0);
    await expect(prisma.noteGeneration.count({ where: { noteId: note.id } })).resolves.toBe(0);

    // ⚠ THE TRANSCRIPT IS UNTOUCHED. A note is derived FROM a recording;
    // deleting the derivative must never delete the evidence.
    const survivor = await prisma.transcript.findUnique({ where: { id: transcript.id } });

    expect(survivor).not.toBeNull();
    expect(survivor?.deletedAt).toBeNull();
    expect(survivor?.sourceObjectId).toBe(transcript.sourceObjectId);

    // And no storage object was named at all: this note owned none.
    expect(deletedObjects).toEqual([]);
  });

  it('deletes the source document and its extraction when nothing else names them', async () => {
    const owner = await createUser();
    const extracted = await createObject(owner.id, 'document.txt');
    const source = await createObject(owner.id, 'document.pdf', {
      extractedObjectId: extracted.id,
    });
    const note = await createReadyNote(owner.id, { objectId: source.id });

    await notes.remove(note.id, caller(owner.id));
    await purge.process({ id: 'job-1', payload: { noteId: note.id } } as never);

    // The extraction first, then the upload it belongs to.
    expect(deletedObjects).toEqual([extracted.id, source.id]);
  });

  it('KEEPS the source document while a second note still points at it', async () => {
    const owner = await createUser();
    const source = await createObject(owner.id, 'document.pdf');
    const first = await createReadyNote(owner.id, { objectId: source.id });
    const second = await createReadyNote(owner.id, { objectId: source.id });

    await notes.remove(first.id, caller(owner.id));
    await purge.process({ id: 'job-1', payload: { noteId: first.id } } as never);

    expect(deletedObjects).toEqual([]);

    // ⚠ AND THE ROW IS STILL THERE — which is the real assertion, because
    // `notes.source_object_id` is `Restrict`: a purge that had tried anyway
    // would have raised a foreign-key violation rather than deleting anything.
    await expect(
      prisma.storageObject.findUnique({ where: { id: source.id } }),
    ).resolves.not.toBeNull();
    await expect(prisma.note.findUnique({ where: { id: second.id } })).resolves.not.toBeNull();
  });

  it('refuses the delete while another note was generated from this one', async () => {
    const owner = await createUser();
    const parent = await createReadyNote(owner.id, {});

    await prisma.note.create({
      data: {
        ownerId: owner.id,
        title: `${TITLE_PREFIX}derived`,
        sourceType: 'note',
        sourceNoteId: parent.id,
      },
    });

    // `notes.source_note_id` is `Restrict`, so the row delete the purge would
    // eventually perform is refused by PostgreSQL. Checking first turns that
    // into a 409 the caller can act on instead of a 500 out of a job minutes
    // after a 204 said the note was on its way out.
    await expect(notes.remove(parent.id, caller(owner.id))).rejects.toMatchObject({
      status: 409,
    });

    const untouched = await prisma.note.findUnique({ where: { id: parent.id } });

    expect(untouched?.status).toBe('ready');
    expect(untouched?.deletedAt).toBeNull();
    expect(queued).toHaveLength(0);
  });

  it('is re-entrant: purging twice is not an error', async () => {
    const owner = await createUser();
    const note = await createReadyNote(owner.id, {});

    await notes.remove(note.id, caller(owner.id));

    await purge.process({ id: 'job-1', payload: { noteId: note.id } } as never);
    await expect(
      purge.process({ id: 'job-1', payload: { noteId: note.id } } as never),
    ).resolves.toBeUndefined();
  });
});
