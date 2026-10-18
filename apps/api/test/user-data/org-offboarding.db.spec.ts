// =============================================================================
// Real-Postgres test: organization offboarding on this app's data (issue #568)
// =============================================================================
//
// The platform's `org.offboard` handler (`OrgOffboardHandler`, the real one, over the real
// registries and the real composed schema) runs against two organizations that each hold the
// content this app owns: transcripts with a speaker and a segment, a version and an export that
// reference storage objects, a share grant, search rows, a name check, a note derived from the
// transcript, a note from a document, a note export and a graph export (both Restrict their
// storage object). One organization is offboarded; the other must come out untouched. A database
// backup object in the default organization must survive.
//
// Unlike `factory-reset.db.spec.ts` this suite COMMITS: the handler opens one transaction per
// step, so a single rolled-back transaction would not exercise its real shape. Every row is
// created under organizations and users of its own and removed in `afterAll`.
//
// What the suite is here to prove (the first fails without the wrapper, which is the bug):
//
//   * WITHOUT the KVox steps the bare platform handler fails on a `Restrict` foreign key from a
//     transcript, a note or an export to `storage_objects`, and no byte leaves the bucket;
//   * WITH them (`wrapOrgOffboardHandler`) the job completes: the organization row is gone, the
//     bytes of ITS objects (and only those) were deleted from the provider;
//   * the other organization, the default organization's objects and the surviving prefix are
//     untouched, and so are the users and notes (a note keeps existing, with its references
//     to the deleted transcript and objects cleared);
//   * the search rows and the share grants of the deleted transcripts are gone;
//   * a retried run changes nothing, and a provider refusal fails the job, keeps the
//     organization and is finished by the next run.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  OrgOffboardHandler,
  UserDataPlanService,
  UserPurgeRunner,
  composedSchemaDatamodel,
  resolveUserDataModuleOptions,
} from '@marinoscar/platform-api/user-data';

import '../../src/kvox.manifest';
import '../../src/app-registrations/registrations';
import '../../src/platform/storage/storage-key-prefix.manifest';
import '../../src/platform/user-data/user-data.manifest';

import { runKvoxOrgContent, wrapOrgOffboardHandler } from '../../src/platform/user-data/offboarding.steps';
import { bindKvoxFactoryResetDeps, runKvoxOrgStorageObjects } from '../../src/kvox-objects/factory-reset-storage.step';
import { connectTestPrisma } from '../graph/graph-read.fixtures';
import { createStorageObject, defaultOrgId } from '../helpers/storage-object.helper';
import { createTranscript, shareTranscript } from '../helpers/transcript.helper';
import { resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb, dbReachable } = resolveDbSuite('org-offboarding.db.spec');

interface SeededOrg {
  orgId: string;
  userId: string;
  /** Every storage key written for the organization, which must leave the provider. */
  keys: string[];
  objectIds: string[];
  transcriptId: string;
  /** The note derived from the transcript, and the one derived from a document of the organization. */
  noteFromTranscriptId: string;
  noteFromDocumentId: string;
  /** The two exports that Restrict a storage object. */
  noteExportId: string;
  kgExportId: string;
}

describeWithDb('org.offboard on this app’s data (real Postgres)', () => {
  let prisma: PrismaClient;
  let deleted: string[] = [];
  let refused = new Set<string>();
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const looseObjectIds: string[] = [];

  const storage = {
    delete: async (key: string) => {
      if (refused.has(key)) throw new Error(`provider refused ${key}`);
      deleted.push(key);
    },
    abortMultipartUpload: async () => undefined,
  };

  // The handler's `runAsSystem` is a real interactive transaction; `system` is the plain client.
  // The suite connects as a superuser, which row-level security does not apply to.
  const db = {
    runAsSystem: async (_reason: string, fn: (client: unknown) => Promise<unknown>, options?: { timeout?: number }) =>
      prisma.$transaction((tx) => fn(tx), { timeout: options?.timeout ?? 60_000, maxWait: 30_000 }),
    system: () => prisma,
  };

  function buildHandler(wrapped: boolean): OrgOffboardHandler {
    const options = resolveUserDataModuleOptions({
      datamodel: composedSchemaDatamodel(__dirname),
      // The same option `user-data.config.ts` passes.
      factoryReset: { keepJobsReferencedBy: [{ model: 'DatabaseBackupRun', field: 'jobId' }] },
    });
    const plans = new UserDataPlanService(options);
    const audit = { record: async () => undefined };
    const runner = new UserPurgeRunner(db as never, storage as never, plans, {} as never, audit as never, options);
    const handler = new OrgOffboardHandler(
      { register: () => undefined } as never,
      db as never,
      storage as never,
      plans,
      runner,
      audit as never,
      options,
    );

    if (wrapped) wrapOrgOffboardHandler(handler, db as never, options.txTimeoutMs);

    return handler;
  }

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    if (!dbReachable) return;

    // Whatever a test left: the KVox content and objects of each organization still there, the
    // organization, the users (their notes cascade), the loose objects.
    for (const orgId of orgIds) {
      try {
        if (!(await prisma.organization.findUnique({ where: { id: orgId } }))) continue;

        bindKvoxFactoryResetDeps({ db: db as never, storage: { delete: async () => undefined, abortMultipartUpload: async () => undefined } as never });
        await prisma.$transaction((tx) => runKvoxOrgContent(tx, orgId), { timeout: 60_000 });
        await runKvoxOrgStorageObjects({ orgId, jobId: randomUUID() });
        await prisma.organization.deleteMany({ where: { id: orgId, isDefault: false } });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`org-offboarding.db.spec cleanup of ${orgId} failed: ${(error as Error).message}`);
      }
    }

    await prisma.storageObject.deleteMany({ where: { id: { in: looseObjectIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    bindKvoxFactoryResetDeps(undefined);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    deleted = [];
    refused = new Set();
    bindKvoxFactoryResetDeps({ db: db as never, storage: storage as never });
  });

  afterEach(() => {
    bindKvoxFactoryResetDeps(undefined);
  });

  const key = (prefix: string, name: string) => `${prefix}${name}-${randomUUID()}`;

  /** One non-default organization holding every kind of KVox content, wired the way production wires it. */
  async function seedOrg(label: string): Promise<SeededOrg> {
    const org = await prisma.organization.create({ data: { name: `Offboard ${label}`, slug: `offb-${randomUUID().slice(0, 12)}` } });
    const user = await prisma.user.create({ data: { email: `org-offboard-${label}-${randomUUID()}@example.test` } });
    const member = await prisma.user.create({ data: { email: `org-offboard-member-${label}-${randomUUID()}@example.test` } });
    const keys: string[] = [];
    const objectIds: string[] = [];

    orgIds.push(org.id);
    userIds.push(user.id, member.id);

    const role = await prisma.role.findFirst({ select: { id: true } });

    if (role) await prisma.membership.create({ data: { orgId: org.id, userId: member.id, roleId: role.id } });

    const object = async (prefix: string, name: string, managedBy: 'transcripts' | 'notes' | 'graph' | null) => {
      const storageKey = key(prefix, name);
      const row = await createStorageObject(prisma, {
        data: { name: 'x', size: BigInt(1), mimeType: 'audio/mp4', storageKey, uploadedById: user.id, managedBy, orgId: org.id },
      });

      keys.push(storageKey);
      objectIds.push(row.id);

      return row;
    };

    await object('uploads/', 'plain', null);

    // --- a transcript with everything hanging off it
    const source = await object('transcripts/', 'source', 'transcripts');
    const playback = await object('transcripts/', 'playback', 'transcripts');
    const snapshot = await object('transcripts/', 'snapshot', 'transcripts');
    const exportObject = await object('transcripts/', 'export', 'transcripts');
    const transcript = await createTranscript(prisma, {
      data: { orgId: org.id, ownerId: user.id, title: `T ${label}`, sourceObjectId: source.id, playbackObjectId: playback.id, provider: 'assemblyai' },
    });
    const speaker = await prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
    });

    await prisma.transcriptSegment.create({
      data: { transcriptId: transcript.id, speakerId: speaker.id, startMs: 0, endMs: 10, ordinal: 1, text: 'hello', words: [] },
    });
    await prisma.transcriptVersion.create({
      data: { transcriptId: transcript.id, version: 1, kind: 'ai_original', ops: [], snapshotObjectId: snapshot.id },
    });
    await prisma.transcriptExport.create({
      data: {
        transcriptId: transcript.id,
        version: 1,
        format: 'txt',
        options: {},
        optionsHash: 'h',
        requestedById: user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        objectId: exportObject.id,
      },
    });
    await prisma.transcriptNameCheck.create({
      data: { transcriptId: transcript.id, mode: 'standard', basedOnVersion: 1, terms: [] },
    });
    await shareTranscript(prisma, { transcriptId: transcript.id, userId: member.id, role: 'viewer', grantedById: user.id, orgId: org.id });

    // --- the search index: no foreign key points at a document
    const chunk = await prisma.searchChunk.create({
      data: { documentType: 'transcript', documentId: transcript.id, ordinal: 0, text: 'hello', contentHash: 'h', charStart: 0, charEnd: 5 },
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO search_embeddings (id, chunk_id, model, dimensions, embedding) VALUES (gen_random_uuid(), $1::uuid, 'm', 1536, $2::vector)`,
      chunk.id,
      `[${new Array(1536).fill(0).join(',')}]`,
    );
    await prisma.searchIndexState.create({ data: { documentType: 'transcript', documentId: transcript.id, ownerId: user.id } });

    // --- notes (user-owned): one from the transcript, one from a document of the organization
    const noteSource = await object('notes/sources/', 'doc', 'notes');
    const noteExportObject = await object('notes/', 'export', 'notes');
    const noteFromTranscript = await prisma.note.create({
      data: { ownerId: user.id, title: 'N-t', body: 'from t', status: 'ready', sourceType: 'transcript', sourceTranscriptId: transcript.id },
    });
    const noteFromDocument = await prisma.note.create({
      data: { ownerId: user.id, title: 'N-d', body: 'doc', status: 'ready', sourceType: 'document', sourceObjectId: noteSource.id },
    });
    const noteExport = await prisma.noteExport.create({
      data: {
        noteId: noteFromDocument.id,
        version: 1,
        format: 'md',
        options: {},
        optionsHash: 'h',
        requestedById: user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        objectId: noteExportObject.id,
      },
    });

    // --- a graph export (the graph itself is user-owned and stays)
    const graphExportObject = await object('graph/', `${user.id}/exports/g.jsonld`, 'graph');
    const kgExport = await prisma.kgExport.create({
      data: {
        ownerId: user.id,
        format: 'jsonld',
        status: 'ready',
        graphFingerprint: 'f',
        ontologyVersion: '1.0.0',
        expiresAt: new Date(Date.now() + 3_600_000),
        objectId: graphExportObject.id,
      },
    });

    return {
      orgId: org.id,
      userId: user.id,
      keys,
      objectIds,
      transcriptId: transcript.id,
      noteFromTranscriptId: noteFromTranscript.id,
      noteFromDocumentId: noteFromDocument.id,
      noteExportId: noteExport.id,
      kgExportId: kgExport.id,
    };
  }

  /** Everything this app keeps per transcript, counted by the transcript id (0 means it is gone). */
  async function transcriptRows(seed: SeededOrg) {
    const transcriptId = seed.transcriptId;

    return {
      transcripts: await prisma.transcript.count({ where: { id: transcriptId } }),
      speakers: await prisma.transcriptSpeaker.count({ where: { transcriptId } }),
      segments: await prisma.transcriptSegment.count({ where: { transcriptId } }),
      versions: await prisma.transcriptVersion.count({ where: { transcriptId } }),
      exports: await prisma.transcriptExport.count({ where: { transcriptId } }),
      nameChecks: await prisma.transcriptNameCheck.count({ where: { transcriptId } }),
      grants: await prisma.grant.count({ where: { resourceType: 'transcript', resourceId: transcriptId } }),
      searchChunks: await prisma.searchChunk.count({ where: { documentType: 'transcript', documentId: transcriptId } }),
      searchIndexState: await prisma.searchIndexState.count({ where: { documentType: 'transcript', documentId: transcriptId } }),
    };
  }

  const ALL_PRESENT = {
    transcripts: 1,
    speakers: 1,
    segments: 1,
    versions: 1,
    exports: 1,
    nameChecks: 1,
    grants: 1,
    searchChunks: 1,
    searchIndexState: 1,
  };
  const ALL_GONE = Object.fromEntries(Object.keys(ALL_PRESENT).map((name) => [name, 0]));

  async function runningJob(orgId: string, actorUserId: string) {
    return prisma.job.create({
      data: { type: 'org.offboard', reason: 'test', status: 'running', payload: { orgId, actorUserId, userDisposition: 'keep' } },
    });
  }

  it('WITHOUT the KVox steps the platform handler fails on the storage_objects foreign key and deletes no byte (the bug)', async () => {
    const seed = await seedOrg('bare');
    const job = await runningJob(seed.orgId, seed.userId);

    await expect(buildHandler(false).process(job as never)).rejects.toThrow(/foreign key|violat|Restrict|constraint/i);

    expect(deleted).toEqual([]);
    expect(await prisma.organization.count({ where: { id: seed.orgId } })).toBe(1);
    expect(await prisma.storageObject.count({ where: { orgId: seed.orgId } })).toBe(seed.keys.length);
  }, 120_000);

  it('completes through the wrapped process: bytes and rows of THIS organization go, everything else stays', async () => {
    const target = await seedOrg('target');
    const other = await seedOrg('other');
    const defaultOrg = await defaultOrgId(prisma);
    const backupKey = `database-backups/${randomUUID()}.dump`;
    const defaultObject = await createStorageObject(prisma, {
      data: { name: 'b.dump', size: BigInt(1), mimeType: 'application/octet-stream', storageKey: backupKey, status: 'ready', orgId: defaultOrg },
    });
    const defaultPlain = await createStorageObject(prisma, {
      data: { name: 'p', size: BigInt(1), mimeType: 'image/png', storageKey: key('uploads/', 'default'), orgId: defaultOrg },
    });

    looseObjectIds.push(defaultObject.id, defaultPlain.id);

    const job = await runningJob(target.orgId, target.userId);

    await buildHandler(true).process(job as never);

    // The organization row, its memberships and its objects are gone.
    expect(await prisma.organization.count({ where: { id: target.orgId } })).toBe(0);
    expect(await prisma.membership.count({ where: { orgId: target.orgId } })).toBe(0);
    expect(await prisma.storageObject.count({ where: { orgId: target.orgId } })).toBe(0);
    expect(await prisma.kvoxObjectOwnership.count({ where: { orgId: target.orgId } })).toBe(0);
    expect(await transcriptRows(target)).toEqual(ALL_GONE);

    // The bytes: exactly this organization's keys left the provider.
    expect([...deleted].sort()).toEqual([...target.keys].sort());
    for (const k of other.keys) expect(deleted).not.toContain(k);
    expect(deleted).not.toContain(backupKey);

    // The exports that Restricted the objects are gone; the notes they belonged to stay.
    expect(await prisma.noteExport.count({ where: { id: target.noteExportId } })).toBe(0);
    expect(await prisma.kgExport.count({ where: { id: target.kgExportId } })).toBe(0);

    const notes = await prisma.note.findMany({
      where: { id: { in: [target.noteFromTranscriptId, target.noteFromDocumentId] } },
      select: { id: true, sourceTranscriptId: true, sourceObjectId: true, ownerId: true },
    });

    expect(notes.map((n) => n.id).sort()).toEqual([target.noteFromTranscriptId, target.noteFromDocumentId].sort());
    for (const note of notes) {
      expect(note.sourceTranscriptId).toBeNull();
      expect(note.sourceObjectId).toBeNull();
      expect(note.ownerId).toBe(target.userId);
    }

    // Users are kept under the default `keep` disposition.
    expect(await prisma.user.count({ where: { id: target.userId } })).toBe(1);

    // The untouched organization keeps every row, every object and its note references.
    expect(await prisma.organization.count({ where: { id: other.orgId } })).toBe(1);
    expect(await transcriptRows(other)).toEqual(ALL_PRESENT);
    expect(await prisma.storageObject.count({ where: { orgId: other.orgId } })).toBe(other.keys.length);
    expect(await prisma.noteExport.count({ where: { id: other.noteExportId } })).toBe(1);
    expect(await prisma.kgExport.count({ where: { id: other.kgExportId } })).toBe(1);
    expect(
      await prisma.note.findUniqueOrThrow({ where: { id: other.noteFromTranscriptId }, select: { sourceTranscriptId: true } }),
    ).toEqual({ sourceTranscriptId: other.transcriptId });
    expect(
      await prisma.note.findUniqueOrThrow({ where: { id: other.noteFromDocumentId }, select: { sourceObjectId: true } }),
    ).toEqual({ sourceObjectId: expect.any(String) });

    // The default organization's objects, the backup among them, are untouched.
    expect(await prisma.storageObject.count({ where: { id: { in: [defaultObject.id, defaultPlain.id] } } })).toBe(2);

    // The job recorded its result.
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const counts = (stored.payload as { result: { counts: Record<string, number> } }).result.counts;

    expect(counts.organizations).toBe(1);
    // The KVox steps' own counts are logged, not recorded: the platform's storage plan is empty for this app.
    expect(counts.storageObjectsDeleted).toBeUndefined();
  }, 180_000);

  it('a retried run of a finished job changes nothing and does not throw', async () => {
    const target = await seedOrg('retry');
    const other = await seedOrg('retry-other');
    const handler = buildHandler(true);
    const job = await runningJob(target.orgId, target.userId);

    await handler.process(job as never);

    const afterFirst = [...deleted];
    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });

    await expect(handler.process(finished as never)).resolves.toBeUndefined();

    expect(deleted).toEqual(afterFirst);
    expect(await prisma.organization.count({ where: { id: target.orgId } })).toBe(0);
    expect(await transcriptRows(other)).toEqual(ALL_PRESENT);
    expect(await prisma.storageObject.count({ where: { orgId: other.orgId } })).toBe(other.keys.length);
  }, 180_000);

  it('a provider refusal fails the job after the sweep, keeps the organization, and the next run finishes it', async () => {
    const target = await seedOrg('refused');
    const refusedKey = target.keys.find((k) => k.startsWith('uploads/')) as string;
    const handler = buildHandler(true);
    const job = await runningJob(target.orgId, target.userId);

    refused.add(refusedKey);

    await expect(handler.process(job as never)).rejects.toThrow(/could not be deleted/);

    // The content is gone (no FK failure), the refused object and the organization are kept, and
    // every other object was still swept.
    expect(await transcriptRows(target)).toEqual(ALL_GONE);
    expect(await prisma.organization.count({ where: { id: target.orgId } })).toBe(1);
    expect(await prisma.storageObject.findMany({ where: { orgId: target.orgId }, select: { storageKey: true } })).toEqual([
      { storageKey: refusedKey },
    ]);
    expect(deleted).not.toContain(refusedKey);
    expect(deleted).toHaveLength(target.keys.length - 1);

    // The queue retries the same job once the provider recovers.
    refused.clear();

    const retried = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });

    await handler.process(retried as never);

    expect(await prisma.organization.count({ where: { id: target.orgId } })).toBe(0);
    expect(deleted).toContain(refusedKey);
    expect([...deleted].sort()).toEqual([...target.keys].sort());
  }, 180_000);

  it('refuses the default organization before any KVox step runs', async () => {
    const defaultOrg = await defaultOrgId(prisma);
    const owner = await prisma.user.create({ data: { email: `org-offboard-default-${randomUUID()}@example.test` } });

    userIds.push(owner.id);

    const job = await runningJob(defaultOrg, owner.id);

    await expect(buildHandler(true).process(job as never)).rejects.toThrow(/default organization is never offboarded/);
    expect(deleted).toEqual([]);
    expect(await prisma.organization.count({ where: { id: defaultOrg } })).toBe(1);
  }, 60_000);
});
