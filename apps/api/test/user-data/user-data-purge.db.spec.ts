// =============================================================================
// Real-Postgres test: the user-data purge, scope by scope (issue #480, epic #478)
// =============================================================================
//
// The platform's `user.data.purge` job (`UserPurgeRunner`, the real one, over the
// real registries and the real composed schema) runs each of this app's five
// scopes against a seeded database, and then the delegate jobs it enqueued
// (`transcript.purge`, `note.purge`, `kg.purge`, `files.purge_unmanaged` and the
// per-item purges they fan out to) are drained through THEIR real handlers. Each
// scope's outcome is then asserted EXACTLY: what is gone, and what must remain.
// Excluded from `npm test`; run by `npm run test:db`.
//
// The fixture: user A (the subject) and user B (the bystander).
//
//   A: two plain uploads; transcript T1 (shared to B) with source audio and a
//      playback rendition; transcript T2 (B generated a note from it); notes N1
//      (a document note, template TPL1) and N2 (derived from N1); an unused
//      template TPL2 and a hidden built-in; a graph; an Ask conversation; an AI
//      key; a personal access token; a notification; settings; two search index
//      rows.
//   B: a plain upload, a transcript, NB (from A's T2), NB2 (derived from A's N1),
//      a note, a template, a graph, an Ask conversation, a PAT.
//
// What the suite is here to prove, beyond "each scope deletes its categories":
//
//   * a `files` deletion never touches an object in `kvox_object_ownership`, nor
//     the transcript or note that owns it;
//   * another user's note derived from my transcript (or my note) keeps its text
//     and loses only the provenance link, and is never counted as deleted;
//   * `content` keeps AI keys, tokens, notifications, settings and the display
//     name, and `everything` removes them (the documented widening);
//   * `kg.purge` is enqueued once per purge that includes `graph`;
//   * the bystander loses nothing, ever.
//
// The suite connects as a superuser, to which row-level security does not apply;
// the org scope is still opened by the gateway, as in production.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JobScope } from '@marinoscar/platform-api/jobs';
import {
  UserDataPlanService,
  UserPurgeRunner,
  composedSchemaDatamodel,
} from '@marinoscar/platform-api/user-data';

import '../../src/kvox.manifest';
import '../../src/app-registrations/registrations';
import '../../src/platform/user-data/user-data.manifest';

import { FilesPurgeUnmanagedHandler } from '../../src/kvox-objects/files-purge-unmanaged.handler';
import { KgPurgeHandler } from '../../src/graph/handlers/kg-purge.handler';
import { KgPurgeService } from '../../src/graph/purge/kg-purge.service';
import { NoteObjectsService, NotePurgeHandler, NotesUserDataService } from '@marinoscar/kvox-api/notes';
import { createNotesServiceTestFactory } from '@marinoscar/kvox-api/notes/testing';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { SearchIndexService } from '@marinoscar/kvox-api/search';
import {
  TranscriptObjectsService,
  TranscriptPurgeHandler,
  resolveTranscriptsOptions,
} from '@marinoscar/kvox-api/transcripts';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from '../graph/graph-read.fixtures';
import { createDbAudit, createDbManagedObjects, createDbObjectStore } from '../helpers/db-managed-objects.helper';
import { createStorageObject, defaultOrgId } from '../helpers/storage-object.helper';
import { resolveDbSuite } from '../jobs/db-test-support';
import { createTranscript as createTranscriptRow, shareTranscript } from '../helpers/transcript.helper';
import { createPlatformTranscriptSharing } from '../helpers/sharing-kit.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('user-data-purge.db.spec');

const EMAIL_PREFIX = 'user-data-purge-test';
const KEY_PREFIX = `${EMAIL_PREFIX}/`;

interface QueuedJob {
  id: string;
  type: string;
  subjectType: string | null;
  subjectId: string | null;
  payload: Record<string, unknown>;
  orgId: string | null;
}

describeWithDb('user.data.purge on the platform registries (real Postgres)', () => {
  let prisma: PrismaClient;
  let runner: UserPurgeRunner;
  let orgId: string;

  // The in-memory queue the delegates are enqueued on, and its full history.
  let queue: QueuedJob[] = [];
  let history: QueuedJob[] = [];
  // Every storage key the (fake) provider was asked to delete.
  let deletedKeys: string[] = [];

  const storage = {
    kind: 'fake',
    getBucket: () => 'test-bucket',
    delete: jest.fn(async (key: string) => {
      deletedKeys.push(key);
    }),
    abortMultipartUpload: jest.fn(async () => undefined),
  };

  const jobs = {
    enqueue: jest.fn(async (input: Partial<QueuedJob> & { type: string; payload?: Record<string, unknown> | null }) => {
      const existing = queue.find(
        (job) =>
          job.type === input.type &&
          job.subjectType === (input.subjectType ?? null) &&
          job.subjectId === (input.subjectId ?? null),
      );

      // The queue's active dedup: one pending job per (type, subject).
      if (existing) return existing;

      const job: QueuedJob = {
        id: randomUUID(),
        type: input.type,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        payload: (input.payload ?? {}) as Record<string, unknown>,
        orgId: input.orgId ?? null,
      };

      queue.push(job);
      history.push(job);

      return job;
    }),
  };

  let transcriptPurge: TranscriptPurgeHandler;
  let notePurge: NotePurgeHandler;
  let kgPurge: KgPurgeHandler;
  let filesPurge: FilesPurgeUnmanagedHandler;

  beforeAll(async () => {
    if (!dbReachable) return;

    prisma = connectTestPrisma();
    await prisma.$connect();
    orgId = await defaultOrgId(prisma);

    const registry = { register: jest.fn() } as never;
    const managed = createDbManagedObjects(prisma, storage as never);
    const searchIndex = new SearchIndexService(prisma as unknown as PrismaService, jobs as never);

    // The real per-item machinery, over the real gateway and the fake provider.
    transcriptPurge = new TranscriptPurgeHandler(
      { registerHandler: jest.fn() } as never,
      prisma as unknown as PrismaService,
      createDbAudit(prisma),
      new TranscriptObjectsService(createDbObjectStore(prisma, storage as never), resolveTranscriptsOptions({})),
      { resolve: jest.fn() } as never, // no transcript here has a provider copy
      searchIndex,
      {
        enqueuePurge: async (transcriptId: string) => {
          await jobs.enqueue({
            type: 'transcript.purge',
            orgId,
            subjectType: 'transcript',
            subjectId: transcriptId,
            payload: { transcriptId },
          });
        },
      } as never,
      createPlatformTranscriptSharing(prisma),
    );

    const notes = createNotesServiceTestFactory({
      prisma: prisma as never,
      audit: createDbAudit(prisma),
      access: null as never,
      sourceNames: null as never,
      templates: null as never,
      requests: null as never,
      sources: null as never,
      jobs: jobs as never,
      searchIndex: searchIndex as never,
    });

    const noteStore = createDbObjectStore(prisma, storage as never);

    notePurge = new NotePurgeHandler(
      jobs as never,
      prisma as never,
      createDbAudit(prisma),
      noteStore,
      new NoteObjectsService(noteStore),
      searchIndex,
      notes,
      new NotesUserDataService(prisma as never, jobs as never),
    );

    kgPurge = new KgPurgeHandler(
      registry,
      prisma as unknown as PrismaService,
      new KgPurgeService(prisma as unknown as PrismaService, { deleteIfPresent: async () => false } as never, managed),
      new EventEmitter2(),
    );

    // `ObjectsService.delete` is the platform's (bytes, then the row); this stands in for it
    // and records what it was asked to delete.
    filesPurge = new FilesPurgeUnmanagedHandler(
      registry,
      prisma as unknown as PrismaService,
      managed,
      {
        delete: async (id: string) => {
          const row = await prisma.storageObject.findUniqueOrThrow({ where: { id } });
          await storage.delete(row.storageKey);
          await prisma.storageObject.delete({ where: { id } });
        },
      } as never,
    );

    const db = {
      runAsSystem: async (_reason: string, fn: (tx: unknown) => Promise<unknown>, options?: { timeout?: number }) =>
        prisma.$transaction((tx) => fn(tx), { timeout: options?.timeout ?? 60_000 }),
      system: () => prisma,
    };
    const plans = new UserDataPlanService({ datamodel: composedSchemaDatamodel(__dirname) } as never);

    runner = new UserPurgeRunner(
      db as never,
      storage as never,
      plans,
      jobs as never,
      { record: jest.fn(async () => undefined) } as never,
      { txTimeoutMs: 60_000, userRemovalHooks: [] } as never,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    queue = [];
    history = [];
    deletedKeys = [];
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await cleanup();
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Cleanup: every row the fixture creates, whatever a test left behind
  // ---------------------------------------------------------------------------

  async function cleanup(): Promise<void> {
    const users = await prisma.user.findMany({
      where: { email: { startsWith: EMAIL_PREFIX } },
      select: { id: true },
    });
    const ids = users.map((user) => user.id);
    const owner = { ownerId: { in: ids } };
    const user = { userId: { in: ids } };

    // `replica` skips the foreign-key triggers for this transaction only (see
    // `cleanupGraphFixtures`): this is teardown of throwaway rows, not a write path.
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.askMessage.deleteMany({ where: { conversation: owner } });
        await tx.askConversation.deleteMany({ where: owner });
        await tx.userHiddenNoteTemplate.deleteMany({ where: user });
        await tx.noteTemplate.deleteMany({ where: owner });
        await tx.personalAccessToken.deleteMany({ where: user });
        await tx.userAiKey.deleteMany({ where: user });
        await tx.notification.deleteMany({ where: user });
        await tx.userSettings.deleteMany({ where: user });
        await tx.searchIndexState.deleteMany({ where: owner });
        await tx.grant.deleteMany({
          where: { resourceType: 'transcript', OR: [{ granteeUserId: { in: ids } }, { grantedById: { in: ids } }] },
        });
        await tx.kvoxObjectOwnership.deleteMany({ where: { object: { storageKey: { startsWith: KEY_PREFIX } } } });
        await tx.auditEvent.deleteMany({ where: { actorUserId: { in: ids } } });
        await tx.job.deleteMany({ where: { type: 'user.data.purge', subjectId: { in: ids } } });
      },
      { timeout: 120_000 },
    );
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }

  // ---------------------------------------------------------------------------
  // Fixture
  // ---------------------------------------------------------------------------

  const key = (name: string) => `${KEY_PREFIX}${name}-${randomUUID()}`;

  async function upload(ownerId: string, name: string, managedBy: 'transcripts' | 'notes' | null) {
    return createStorageObject(prisma, {
      data: {
        name,
        size: BigInt(10),
        mimeType: 'audio/mp4',
        storageKey: key(name),
        uploadedById: ownerId,
        managedBy,
      },
    });
  }

  async function transcript(ownerId: string, title: string, withPlayback = false) {
    const source = await upload(ownerId, `${title}-source`, 'transcripts');
    const playback = withPlayback ? await upload(ownerId, `${title}-playback`, 'transcripts') : null;
    const row = await createTranscriptRow(prisma, {
      data: {
        ownerId,
        title,
        sourceObjectId: source.id,
        playbackObjectId: playback?.id ?? null,
        provider: 'assemblyai',
      },
    });

    return { row, source, playback };
  }

  interface Seed {
    a: { id: string };
    b: { id: string };
    plainA1: { id: string; storageKey: string };
    plainA2: { id: string; storageKey: string };
    plainB: { id: string; storageKey: string };
    t1: Awaited<ReturnType<typeof transcript>>;
    t2: Awaited<ReturnType<typeof transcript>>;
    tB: Awaited<ReturnType<typeof transcript>>;
    n1: { id: string };
    n1Source: { id: string; storageKey: string };
    n2: { id: string };
    nb: { id: string }; // B's note from A's transcript T2
    nb2: { id: string }; // B's note derived from A's note N1
    nbOwn: { id: string };
    tpl1: { id: string };
    tpl2: { id: string };
    tplB: { id: string };
    builtin: { id: string };
    convA: { id: string };
    convB: { id: string };
    patA: { id: string };
    patB: { id: string };
    entityA: string;
    entityB: string;
  }

  async function seed(label: string): Promise<Seed> {
    const a = await createUser(prisma, EMAIL_PREFIX, `${label}-a`);
    const b = await createUser(prisma, EMAIL_PREFIX, `${label}-b`);

    await prisma.user.update({ where: { id: a.id }, data: { displayName: 'Ada Subject' } });

    const plainA1 = await upload(a.id, 'plain-a1', null);
    const plainA2 = await upload(a.id, 'plain-a2', null);
    const plainB = await upload(b.id, 'plain-b', null);

    const t1 = await transcript(a.id, 'T1', true);
    const t2 = await transcript(a.id, 'T2');
    const tB = await transcript(b.id, 'TB');

    await shareTranscript(prisma, { transcriptId: t1.row.id, userId: b.id, role: 'viewer', grantedById: a.id });

    const tpl = (ownerId: string | null, name: string) =>
      prisma.noteTemplate.create({
        data: {
          ownerId,
          name,
          description: 'd',
          instructions: 'i',
          outputFormat: 'summary',
          structure: [],
        },
      });
    const tpl1 = await tpl(a.id, 'used template');
    const tpl2 = await tpl(a.id, 'unused template');
    const tplB = await tpl(b.id, 'b template');
    const builtin = await tpl(null, `built-in ${randomUUID()}`);

    await prisma.userHiddenNoteTemplate.create({ data: { userId: a.id, templateId: builtin.id } });

    const n1Source = await upload(a.id, 'n1-source', 'notes');
    const n1 = await prisma.note.create({
      data: {
        ownerId: a.id,
        title: 'N1',
        body: 'a document note',
        status: 'ready',
        sourceType: 'document',
        sourceObjectId: n1Source.id,
        templateId: tpl1.id,
      },
    });
    const n2 = await prisma.note.create({
      data: { ownerId: a.id, title: 'N2', body: 'derived', status: 'ready', sourceType: 'note', sourceNoteId: n1.id },
    });
    const nb = await prisma.note.create({
      data: {
        ownerId: b.id,
        title: 'NB',
        body: 'B’s words about A’s recording',
        status: 'ready',
        sourceType: 'transcript',
        sourceTranscriptId: t2.row.id,
      },
    });
    const nb2 = await prisma.note.create({
      data: {
        ownerId: b.id,
        title: 'NB2',
        body: 'B’s words about A’s note',
        status: 'ready',
        sourceType: 'note',
        sourceNoteId: n1.id,
      },
    });
    const nbOwn = await prisma.note.create({
      data: { ownerId: b.id, title: 'NBOWN', body: 'mine', status: 'ready', sourceType: 'document' },
    });

    const convA = await prisma.askConversation.create({ data: { ownerId: a.id, title: 'A asks' } });
    await prisma.askMessage.create({ data: { conversationId: convA.id, role: 'user', content: 'q' } });
    const convB = await prisma.askConversation.create({ data: { ownerId: b.id, title: 'B asks' } });

    const entityA = await new GraphFixture(prisma, a.id).entity('Person', 'Sarah');
    const entityB = await new GraphFixture(prisma, b.id).entity('Person', 'Bob');

    await prisma.userAiKey.create({ data: { userId: a.id, provider: 'openai', secret: 'encrypted' } });
    const pat = (userId: string) =>
      prisma.personalAccessToken.create({
        data: {
          userId,
          name: 'cli',
          tokenHash: randomUUID(),
          tokenPrefix: 'pat_x',
          durationValue: 1,
          durationUnit: 'days',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    const patA = await pat(a.id);
    const patB = await pat(b.id);
    await prisma.notification.create({ data: { userId: a.id, eventKey: 'test.event', title: 't', body: 'b' } });
    await prisma.userSettings.create({
      data: { userId: a.id, value: { theme: 'dark', onboarding: { welcomeSeenAt: '2026-01-01T00:00:00.000Z' } } },
    });

    await prisma.searchIndexState.create({
      data: { documentType: 'transcript', documentId: t1.row.id, ownerId: a.id },
    });
    await prisma.searchIndexState.create({ data: { documentType: 'note', documentId: n1.id, ownerId: a.id } });

    return {
      a,
      b,
      plainA1,
      plainA2,
      plainB,
      t1,
      t2,
      tB,
      n1,
      n1Source,
      n2,
      nb,
      nb2,
      nbOwn,
      tpl1,
      tpl2,
      tplB,
      builtin,
      convA,
      convB,
      patA,
      patB,
      entityA,
      entityB,
    };
  }

  // ---------------------------------------------------------------------------
  // Running a scope: the platform job, then every delegate it queued, to the end
  // ---------------------------------------------------------------------------

  async function drain(): Promise<void> {
    for (let guard = 0; queue.length > 0; guard += 1) {
      if (guard > 500) throw new Error('the queue did not drain');

      const job = queue.shift() as QueuedJob;
      const row = { ...job, status: 'running' } as never;

      switch (job.type) {
        case 'transcript.purge':
          await transcriptPurge.process(row);
          break;
        case 'note.purge':
          await notePurge.process(row);
          break;
        case 'kg.purge':
          await kgPurge.process(row);
          break;
        case 'files.purge_unmanaged':
          await filesPurge.process(row);
          break;
        default:
          throw new Error(`no handler for the delegate ${job.type}`);
      }
    }
  }

  async function purge(userId: string, scope: string) {
    const job = await prisma.job.create({
      data: {
        type: 'user.data.purge',
        reason: 'rerun',
        status: 'running',
        subjectType: 'user',
        subjectId: userId,
        payload: { userId, scope },
      },
    });

    const result = await runner.runJob(job, { userId, scope });
    // Everything the purge itself enqueued, before the delegates enqueue their own per-item jobs.
    const delegated = history.map((entry) => entry.type);

    await drain();

    return { result, delegated };
  }

  // Existence probes -----------------------------------------------------------

  const has = {
    transcript: async (id: string) => (await prisma.transcript.count({ where: { id } })) === 1,
    note: async (id: string) => (await prisma.note.count({ where: { id } })) === 1,
    object: async (id: string) => (await prisma.storageObject.count({ where: { id } })) === 1,
    ownership: async (objectId: string) => (await prisma.kvoxObjectOwnership.count({ where: { objectId } })) === 1,
    template: async (id: string) => (await prisma.noteTemplate.count({ where: { id } })) === 1,
    conversation: async (id: string) => (await prisma.askConversation.count({ where: { id } })) === 1,
    entity: async (id: string) => (await prisma.kgEntity.count({ where: { id } })) === 1,
    pat: async (id: string) => (await prisma.personalAccessToken.count({ where: { id } })) === 1,
  };

  async function mine(userId: string) {
    return {
      aiKeys: await prisma.userAiKey.count({ where: { userId } }),
      notifications: await prisma.notification.count({ where: { userId } }),
      settings: await prisma.userSettings.count({ where: { userId } }),
      hidden: await prisma.userHiddenNoteTemplate.count({ where: { userId } }),
      user: await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }),
      searchState: (await prisma.searchIndexState.findMany({ where: { ownerId: userId }, select: { documentType: true } }))
        .map((row) => row.documentType)
        .sort(),
    };
  }

  /** Everything the bystander owns is still there, whatever the subject deleted. */
  async function expectBystanderUntouched(s: Seed): Promise<void> {
    expect(await has.transcript(s.tB.row.id)).toBe(true);
    expect(await has.object(s.tB.source.id)).toBe(true);
    expect(await has.object(s.plainB.id)).toBe(true);
    expect(await has.note(s.nbOwn.id)).toBe(true);
    expect(await has.template(s.tplB.id)).toBe(true);
    expect(await has.conversation(s.convB.id)).toBe(true);
    expect(await has.entity(s.entityB)).toBe(true);
    expect(await has.pat(s.patB.id)).toBe(true);
    expect(deletedKeys).not.toContain(s.tB.source.storageKey);
    expect(deletedKeys).not.toContain(s.plainB.storageKey);
  }

  const managedKeys = (s: Seed) => [
    s.t1.source.storageKey,
    s.t1.playback?.storageKey as string,
    s.t2.source.storageKey,
    s.n1Source.storageKey,
  ];

  // ---------------------------------------------------------------------------
  // The scopes
  // ---------------------------------------------------------------------------

  it('transcripts: deletes the subject’s transcripts and their objects, and nothing else', async () => {
    const s = await seed('transcripts');

    const { delegated } = await purge(s.a.id, 'transcripts');

    expect(delegated).toEqual(['transcript.purge']);

    // Gone: both transcripts, their share, their source audio and playback rendition.
    expect(await has.transcript(s.t1.row.id)).toBe(false);
    expect(await has.transcript(s.t2.row.id)).toBe(false);
    expect(await prisma.grant.count({ where: { resourceType: 'transcript', resourceId: s.t1.row.id } })).toBe(0);
    for (const object of [s.t1.source, s.t1.playback as { id: string }, s.t2.source]) {
      expect(await has.object(object.id)).toBe(false);
      expect(await has.ownership(object.id)).toBe(false);
    }
    expect(deletedKeys).toEqual(
      expect.arrayContaining([s.t1.source.storageKey, s.t1.playback?.storageKey, s.t2.source.storageKey]),
    );

    // B’s note from A’s transcript keeps its text and loses only the provenance link.
    const nb = await prisma.note.findUniqueOrThrow({ where: { id: s.nb.id } });
    expect(nb).toMatchObject({ title: 'NB', body: 'B’s words about A’s recording', sourceTranscriptId: null });

    // Kept: notes, templates, plain uploads, graph, Ask, credentials, settings.
    expect(await has.note(s.n1.id)).toBe(true);
    expect(await has.note(s.n2.id)).toBe(true);
    expect(await has.object(s.n1Source.id)).toBe(true);
    expect(await has.template(s.tpl1.id)).toBe(true);
    expect(await has.template(s.tpl2.id)).toBe(true);
    expect(await has.object(s.plainA1.id)).toBe(true);
    expect(await has.object(s.plainA2.id)).toBe(true);
    expect(await has.entity(s.entityA)).toBe(true);
    expect(await has.conversation(s.convA.id)).toBe(true);
    expect(await has.pat(s.patA.id)).toBe(true);
    expect(await mine(s.a.id)).toMatchObject({ aiKeys: 1, notifications: 1, settings: 1, hidden: 1 });
    // The semantic index forgets the transcript, not the note.
    expect((await mine(s.a.id)).searchState).toEqual(['note']);
    expect(deletedKeys).not.toContain(s.n1Source.storageKey);
    await expectBystanderUntouched(s);
  });

  it('notes: deletes the subject’s notes and their source documents, and nothing else', async () => {
    const s = await seed('notes');

    const { delegated } = await purge(s.a.id, 'notes');

    expect(delegated).toEqual(['note.purge']);

    expect(await has.note(s.n1.id)).toBe(false);
    expect(await has.note(s.n2.id)).toBe(false);
    expect(await has.object(s.n1Source.id)).toBe(false);
    expect(deletedKeys).toContain(s.n1Source.storageKey);

    // B’s note derived from A’s note keeps its text and loses only the provenance link.
    const nb2 = await prisma.note.findUniqueOrThrow({ where: { id: s.nb2.id } });
    expect(nb2).toMatchObject({ title: 'NB2', body: 'B’s words about A’s note', sourceNoteId: null });

    // The narrow `notes` scope leaves templates (used or not), transcripts, uploads, the rest.
    expect(await has.template(s.tpl1.id)).toBe(true);
    expect(await has.template(s.tpl2.id)).toBe(true);
    expect(await has.transcript(s.t1.row.id)).toBe(true);
    expect(await has.transcript(s.t2.row.id)).toBe(true);
    expect(await has.object(s.t1.source.id)).toBe(true);
    expect(await has.object(s.plainA1.id)).toBe(true);
    expect(await has.entity(s.entityA)).toBe(true);
    expect(await has.conversation(s.convA.id)).toBe(true);
    expect(await has.note(s.nb.id)).toBe(true);
    expect(await mine(s.a.id)).toMatchObject({ aiKeys: 1, notifications: 1, settings: 1, hidden: 1 });
    expect((await mine(s.a.id)).searchState).toEqual(['transcript']);
    await expectBystanderUntouched(s);
  });

  it('files: deletes only plain uploads, and never an object in kvox_object_ownership', async () => {
    const s = await seed('files');
    const managedBefore = await prisma.kvoxObjectOwnership.findMany({
      where: { object: { storageKey: { startsWith: KEY_PREFIX } } },
      orderBy: { objectId: 'asc' },
    });

    const { delegated } = await purge(s.a.id, 'files');

    expect(delegated).toEqual(['files.purge_unmanaged']);

    // Gone: exactly the two plain uploads, bytes and rows.
    expect(await has.object(s.plainA1.id)).toBe(false);
    expect(await has.object(s.plainA2.id)).toBe(false);
    expect(deletedKeys.sort()).toEqual([s.plainA1.storageKey, s.plainA2.storageKey].sort());

    // Every managed object (the subject’s AND the bystander’s) still has its row, its
    // ownership row and its bytes, and its transcript or note is intact.
    const managedAfter = await prisma.kvoxObjectOwnership.findMany({
      where: { object: { storageKey: { startsWith: KEY_PREFIX } } },
      orderBy: { objectId: 'asc' },
    });
    expect(managedAfter).toEqual(managedBefore);
    expect(managedAfter.length).toBe(5);
    for (const row of managedAfter) expect(await has.object(row.objectId)).toBe(true);
    for (const managedKey of managedKeys(s)) expect(deletedKeys).not.toContain(managedKey);
    for (const transcriptId of [s.t1.row.id, s.t2.row.id]) expect(await has.transcript(transcriptId)).toBe(true);
    for (const noteId of [s.n1.id, s.n2.id, s.nb.id, s.nb2.id]) expect(await has.note(noteId)).toBe(true);

    // Nothing else moved.
    expect((await prisma.note.findUniqueOrThrow({ where: { id: s.nb.id } })).sourceTranscriptId).toBe(s.t2.row.id);
    expect(await has.template(s.tpl2.id)).toBe(true);
    expect(await has.entity(s.entityA)).toBe(true);
    expect(await has.conversation(s.convA.id)).toBe(true);
    expect(await has.pat(s.patA.id)).toBe(true);
    expect(await mine(s.a.id)).toMatchObject({ aiKeys: 1, notifications: 1, settings: 1, hidden: 1 });
    await expectBystanderUntouched(s);
  });

  it('files: a provider failure keeps the row, is not thrown, and asking again retries it', async () => {
    const s = await seed('files-retry');

    storage.delete.mockImplementationOnce(async () => {
      throw new Error('provider down');
    });
    // The stand-in deletes bytes before the row, so a failing provider keeps the row.
    await purge(s.a.id, 'files');

    const survivors = [s.plainA1, s.plainA2].filter(Boolean);
    const remaining = (await Promise.all(survivors.map((o) => has.object(o.id)))).filter(Boolean);
    expect(remaining).toHaveLength(1);

    await purge(s.a.id, 'files');

    expect(await has.object(s.plainA1.id)).toBe(false);
    expect(await has.object(s.plainA2.id)).toBe(false);
    expect(await has.object(s.plainB.id)).toBe(true);
  });

  it('content: deletes everything the subject made, once per delegate, and keeps credentials and settings', async () => {
    const s = await seed('content');

    const { delegated } = await purge(s.a.id, 'content');

    // Every delegate once: the fifteen graph hints share ONE kg.purge job.
    expect(delegated.filter((type) => type === 'kg.purge')).toHaveLength(1);
    expect(history.filter((job) => job.type === 'kg.purge')).toHaveLength(1);
    expect([...new Set(delegated)].sort()).toEqual(
      ['files.purge_unmanaged', 'kg.purge', 'note.purge', 'transcript.purge'].sort(),
    );
    expect(history.find((job) => job.type === 'kg.purge')?.payload).toEqual({ scope: 'all', userId: s.a.id });

    // Gone: transcripts, notes and every object (managed and plain).
    for (const transcriptId of [s.t1.row.id, s.t2.row.id]) expect(await has.transcript(transcriptId)).toBe(false);
    for (const noteId of [s.n1.id, s.n2.id]) expect(await has.note(noteId)).toBe(false);
    for (const object of [s.plainA1, s.plainA2, s.t1.source, s.t1.playback as { id: string }, s.t2.source, s.n1Source]) {
      expect(await has.object(object.id)).toBe(false);
    }
    expect(deletedKeys).toEqual(
      expect.arrayContaining([...managedKeys(s), s.plainA1.storageKey, s.plainA2.storageKey]),
    );

    // B’s notes derived from A’s content keep their text and lose only the link.
    expect(await prisma.note.findUniqueOrThrow({ where: { id: s.nb.id } })).toMatchObject({
      body: 'B’s words about A’s recording',
      sourceTranscriptId: null,
    });
    expect(await prisma.note.findUniqueOrThrow({ where: { id: s.nb2.id } })).toMatchObject({
      body: 'B’s words about A’s note',
      sourceNoteId: null,
    });

    // The graph, Ask, the unused template and the hidden-template row are gone ...
    expect(await has.entity(s.entityA)).toBe(false);
    expect(await has.conversation(s.convA.id)).toBe(false);
    expect(await prisma.askMessage.count({ where: { conversationId: s.convA.id } })).toBe(0);
    expect(await has.template(s.tpl2.id)).toBe(false);
    expect((await mine(s.a.id)).hidden).toBe(0);
    // ... a template a note still used when the rows were deleted is KEPT (and not archived),
    // and the built-in is never deleted ...
    expect(await prisma.noteTemplate.findUniqueOrThrow({ where: { id: s.tpl1.id } })).toMatchObject({ isArchived: false });
    expect(await has.template(s.builtin.id)).toBe(true);

    // ... and content is not credentials: AI keys, tokens, notifications, settings and the
    // display name all survive, as does the account.
    expect(await has.pat(s.patA.id)).toBe(true);
    expect(await mine(s.a.id)).toMatchObject({
      aiKeys: 1,
      notifications: 1,
      settings: 1,
      user: { displayName: 'Ada Subject' },
      searchState: [],
    });
    await expectBystanderUntouched(s);
  });

  it('everything: deletes content plus credentials, AI history, notifications and settings, and keeps the account', async () => {
    const s = await seed('everything');

    const { delegated } = await purge(s.a.id, 'everything');

    expect(delegated.filter((type) => type === 'kg.purge')).toHaveLength(1);

    for (const transcriptId of [s.t1.row.id, s.t2.row.id]) expect(await has.transcript(transcriptId)).toBe(false);
    for (const noteId of [s.n1.id, s.n2.id]) expect(await has.note(noteId)).toBe(false);
    for (const object of [s.plainA1, s.plainA2, s.t1.source, s.t2.source, s.n1Source]) {
      expect(await has.object(object.id)).toBe(false);
    }
    expect(await has.entity(s.entityA)).toBe(false);
    expect(await has.conversation(s.convA.id)).toBe(false);
    expect(await has.template(s.tpl2.id)).toBe(false);
    expect(await has.template(s.builtin.id)).toBe(true);

    // The platform’s `all`: AI key, PAT, notifications and the whole settings row go, and the
    // display name is cleared. The user row survives.
    expect(await has.pat(s.patA.id)).toBe(false);
    expect(await mine(s.a.id)).toMatchObject({
      aiKeys: 0,
      notifications: 0,
      settings: 0,
      hidden: 0,
      user: { displayName: null },
    });
    expect(await prisma.user.count({ where: { id: s.a.id } })).toBe(1);

    await expectBystanderUntouched(s);
  });

  it('is re-entrant: running a scope again over what is left succeeds and deletes nothing more', async () => {
    const s = await seed('rerun');

    await purge(s.a.id, 'content');
    const { result } = await purge(s.a.id, 'content');

    expect(result.storageObjectsFailed).toBe(0);
    expect(await has.entity(s.entityA)).toBe(false);
    await expectBystanderUntouched(s);
  });
});
