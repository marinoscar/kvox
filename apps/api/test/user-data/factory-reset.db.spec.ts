// =============================================================================
// Real-Postgres test: the admin factory reset on this app's data (issue #562)
// =============================================================================
//
// The platform's `admin.factory_reset` handler (`FactoryResetHandler`, the real
// one, over the real registries and the real composed schema) runs against a
// deployment seeded with the content this app owns: transcripts with their
// speakers, segments, versions and exports, notes (one derived from a
// transcript, one from another note, one from a document), custom note
// templates, a knowledge graph with its evidence and an export, a search index,
// Ask conversations, plain uploads, and a database backup object that must
// survive. Two users hold all of it: the actor (kept) and a second user.
//
// WHY THE ROLLBACK. A factory reset deletes the whole deployment, which a shared
// test database cannot absorb. The handler is therefore handed ONE interactive
// transaction as both its `runAsSystem` and its `system` client, the fixture is
// written inside it, and it is rolled back at the end: nothing persists, and
// every statement the handler sends still runs against real foreign keys. The
// graph's deferred `kg_assert_has_evidence` trigger would never fire on a
// rollback, so the test forces it with `SET CONSTRAINTS ALL IMMEDIATE`.
//
// What the suite is here to prove (each of these failed before the fix):
//
//   * the reset completes: the bare platform handler runs `storage_objects.deleteMany`
//     over `Restrict` foreign keys from transcripts, note sources and exports, version
//     snapshots and graph exports, and fails on the first transcript;
//   * the ACTOR's content goes too (the platform only reaches inline models, and this
//     app's content is delegated);
//   * no bytes are left: every storage key is deleted from the provider except the
//     surviving prefix; a provider refusal keeps the row and is counted;
//   * the search index, which has no foreign key to a document, is emptied;
//   * the built-in note templates the platform's owner-less sweep deletes are back;
//   * a re-run of the same job changes nothing.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  FactoryResetHandler,
  UserDataPlanService,
  UserPurgeRunner,
  composedSchemaDatamodel,
  resolveUserDataModuleOptions,
} from '@marinoscar/platform-api/user-data';
import { NOTE_BUILTIN_TEMPLATES } from '@marinoscar/kvox-api/notes/templates';

import '../../src/kvox.manifest';
import '../../src/app-registrations/registrations';
import '../../src/platform/storage/storage-key-prefix.manifest';
import '../../src/platform/user-data/user-data.manifest';

import { bindKvoxFactoryResetDeps } from '../../src/kvox-objects/factory-reset-storage.step';
import { connectTestPrisma } from '../graph/graph-read.fixtures';
import { createStorageObject } from '../helpers/storage-object.helper';
import { createTranscript } from '../helpers/transcript.helper';
import { resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb, dbReachable } = resolveDbSuite('factory-reset.db.spec');

class RolledBack extends Error {}

interface Seeded {
  userId: string;
  /** Every storage key written for the user, which must be deleted from the provider. */
  keys: string[];
  transcriptId: string;
  noteIds: string[];
}

describeWithDb('admin.factory_reset on this app’s data (real Postgres, rolled back)', () => {
  let prisma: PrismaClient;
  let deleted: string[] = [];
  let refused = new Set<string>();

  const storage = {
    delete: async (key: string) => {
      if (refused.has(key)) throw new Error(`provider refused ${key}`);
      deleted.push(key);
    },
    abortMultipartUpload: async () => undefined,
  };

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    deleted = [];
    refused = new Set();
  });

  afterEach(() => {
    bindKvoxFactoryResetDeps(undefined);
  });

  /** Runs `body` against a handler whose every statement is in one transaction that is rolled back. */
  async function inRolledBackReset(body: (ctx: { tx: any; handler: FactoryResetHandler }) => Promise<void>): Promise<void> {
    try {
      await prisma.$transaction(
        async (tx) => {
          const db = {
            runAsSystem: async (_reason: string, fn: (client: unknown) => Promise<unknown>) => fn(tx),
            system: () => tx,
          };
          const options = resolveUserDataModuleOptions({
            datamodel: composedSchemaDatamodel(__dirname),
            // The same two options `user-data.config.ts` passes.
            factoryReset: { keepJobsReferencedBy: [{ model: 'DatabaseBackupRun', field: 'jobId' }] },
          });
          const plans = new UserDataPlanService(options);
          const audit = { record: async () => undefined };
          const runner = new UserPurgeRunner(db as never, storage as never, plans, {} as never, audit as never, options);
          const handler = new FactoryResetHandler(
            { register: () => undefined } as never,
            db as never,
            storage as never,
            plans,
            runner,
            audit as never,
            options,
          );

          bindKvoxFactoryResetDeps({ db: db as never, storage: storage as never });
          await body({ tx, handler });
          throw new RolledBack();
        },
        { timeout: 240_000, maxWait: 30_000 },
      );
    } catch (error) {
      if (!(error instanceof RolledBack)) throw error;
    }
  }

  const key = (prefix: string, name: string) => `${prefix}${name}-${randomUUID()}`;

  /** One user's content: every table this app owns, wired the way production wires them. */
  async function seedUser(tx: any, label: string, options: { providerCopy: boolean }): Promise<Seeded> {
    const user = await tx.user.create({ data: { email: `factory-reset-${label}-${randomUUID()}@example.test` } });
    const keys: string[] = [];
    const object = async (storageKey: string, managedBy: 'transcripts' | 'notes' | 'graph' | null) => {
      keys.push(storageKey);

      return createStorageObject(tx, {
        data: { name: 'x', size: BigInt(1), mimeType: 'audio/mp4', storageKey, uploadedById: user.id, managedBy },
      });
    };

    await object(key('uploads/', 'plain'), null);

    // --- a transcript with everything hanging off it
    const source = await object(key('transcripts/', 'source'), 'transcripts');
    const playback = await object(key('transcripts/', 'playback'), 'transcripts');
    const snapshot = await object(key('transcripts/', 'snapshot'), 'transcripts');
    const exportObject = await object(key('transcripts/', 'export'), 'transcripts');
    const transcript = await createTranscript(tx, {
      data: {
        ownerId: user.id,
        title: `T ${label}`,
        sourceObjectId: source.id,
        playbackObjectId: playback.id,
        provider: 'assemblyai',
        ...(options.providerCopy ? { providerJobId: `remote-${randomUUID()}` } : {}),
      },
    });
    const speaker = await tx.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
    });
    const segment = await tx.transcriptSegment.create({
      data: { transcriptId: transcript.id, speakerId: speaker.id, startMs: 0, endMs: 10, ordinal: 1, text: 'hello', words: [] },
    });
    await tx.transcriptVersion.create({
      data: { transcriptId: transcript.id, version: 1, kind: 'ai_original', ops: [], snapshotObjectId: snapshot.id },
    });
    await tx.transcriptExport.create({
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
    const check = await tx.transcriptNameCheck.create({
      data: { transcriptId: transcript.id, mode: 'standard', basedOnVersion: 1, terms: [] },
    });
    void check;

    // --- notes: from a document, from that note, from the transcript; one custom template in use
    const template = await tx.noteTemplate.create({
      data: { ownerId: user.id, name: `tpl ${label}`, description: 'd', instructions: 'i', outputFormat: 'summary', structure: [] },
    });
    const noteSource = await object(key('notes/sources/', 'doc'), 'notes');
    const noteExportObject = await object(key('notes/', 'export'), 'notes');
    const n1 = await tx.note.create({
      data: {
        ownerId: user.id,
        title: 'N1',
        body: 'doc',
        status: 'ready',
        sourceType: 'document',
        sourceObjectId: noteSource.id,
        templateId: template.id,
      },
    });
    const n2 = await tx.note.create({
      data: { ownerId: user.id, title: 'N2', body: 'derived', status: 'ready', sourceType: 'note', sourceNoteId: n1.id },
    });
    const n3 = await tx.note.create({
      data: { ownerId: user.id, title: 'N3', body: 'from t', status: 'ready', sourceType: 'transcript', sourceTranscriptId: transcript.id },
    });
    await tx.noteVersion.create({ data: { noteId: n1.id, version: 1, kind: 'edit', body: 'doc' } });
    await tx.noteGeneration.create({
      data: {
        noteId: n1.id,
        kind: 'create',
        templateNameSnapshot: 'tpl',
        sourceType: 'document',
        providerId: 'p',
        model: 'm',
      },
    });
    await tx.noteExport.create({
      data: {
        noteId: n1.id,
        version: 1,
        format: 'md',
        options: {},
        optionsHash: 'h',
        requestedById: user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        objectId: noteExportObject.id,
      },
    });

    // --- the graph: curated rows need their evidence, in this same transaction
    const entity = async (name: string) => {
      const row = await tx.kgEntity.create({
        data: { ownerId: user.id, type: 'Person', label: name, props: {}, reviewStatus: 'accepted', ontologyVersion: '1.0.0' },
      });
      await tx.kgEntityAlias.create({
        data: { entityId: row.id, ownerId: user.id, alias: name, normalized: name.toLowerCase(), source: 'extraction' },
      });
      await tx.kgEvidence.create({
        data: { ownerId: user.id, subjectKind: 'entity', subjectId: row.id, quote: name, transcriptId: transcript.id, segmentId: segment.id },
      });

      return row.id as string;
    };
    const sarah = await entity(`Sarah ${label}`);
    const bob = await entity(`Bob ${label}`);
    const relation = await tx.kgRelation.create({
      data: { ownerId: user.id, type: 'KNOWS', fromId: sarah, toId: bob, reviewStatus: 'accepted', ontologyVersion: '1.0.0' },
    });
    await tx.kgEvidence.create({ data: { ownerId: user.id, subjectKind: 'relation', subjectId: relation.id, quote: 'knows' } });
    const item = await tx.kgItem.create({
      data: {
        ownerId: user.id,
        kind: 'claim',
        subjectId: sarah,
        statement: `claim ${label}`,
        status: 'active',
        statementHash: randomUUID(),
        reviewStatus: 'accepted',
        ontologyVersion: '1.0.0',
      },
    });
    await tx.kgEvidence.create({ data: { ownerId: user.id, subjectKind: 'item', subjectId: item.id, quote: 'claim' } });
    const graphExport = await object(key('graph/', `${user.id}/exports/g.jsonld`), 'graph');
    await tx.kgExport.create({
      data: {
        ownerId: user.id,
        format: 'jsonld',
        status: 'ready',
        graphFingerprint: 'f',
        ontologyVersion: '1.0.0',
        expiresAt: new Date(Date.now() + 3_600_000),
        objectId: graphExport.id,
      },
    });

    // --- the search index: no foreign key points at a document
    const chunk = await tx.searchChunk.create({
      data: { documentType: 'transcript', documentId: transcript.id, ordinal: 0, text: 'hello', contentHash: 'h', charStart: 0, charEnd: 5 },
    });
    await tx.$executeRawUnsafe(
      `INSERT INTO search_embeddings (id, chunk_id, model, dimensions, embedding) VALUES (gen_random_uuid(), $1::uuid, 'm', 1536, $2::vector)`,
      chunk.id,
      `[${new Array(1536).fill(0).join(',')}]`,
    );
    await tx.searchIndexState.create({ data: { documentType: 'transcript', documentId: transcript.id, ownerId: user.id } });

    // --- Ask
    const conversation = await tx.askConversation.create({ data: { ownerId: user.id, title: 'asks' } });
    await tx.askMessage.create({ data: { conversationId: conversation.id, role: 'user', content: 'q' } });

    return { userId: user.id, keys, transcriptId: transcript.id, noteIds: [n1.id, n2.id, n3.id] };
  }

  const TABLES = [
    'transcript',
    'transcriptSpeaker',
    'transcriptSegment',
    'transcriptVersion',
    'transcriptExport',
    'transcriptNameCheck',
    'note',
    'noteVersion',
    'noteGeneration',
    'noteExport',
    'kgEntity',
    'kgEntityAlias',
    'kgRelation',
    'kgItem',
    'kgEvidence',
    'kgExport',
    'searchChunk',
    'searchEmbedding',
    'searchIndexState',
    'askConversation',
    'askMessage',
    'kvoxObjectOwnership',
  ] as const;

  async function runningJob(tx: any, actorUserId: string) {
    return tx.job.create({ data: { type: 'admin.factory_reset', reason: 'rerun', status: 'running', payload: { actorUserId } } });
  }

  it('wipes every user’s content, the actor’s included, and keeps the backup, the actor and the built-in templates', async () => {
    await inRolledBackReset(async ({ tx, handler }) => {
      const actor = await seedUser(tx, 'actor', { providerCopy: false });
      const other = await seedUser(tx, 'other', { providerCopy: true });
      const backupKey = `database-backups/${randomUUID()}.dump`;

      await createStorageObject(tx, {
        data: { name: 'b.dump', size: BigInt(1), mimeType: 'application/octet-stream', storageKey: backupKey, status: 'ready' },
      });

      // A note of ANOTHER user derived from the actor's transcript: the Restrict the bare cascade trips on.
      await tx.note.create({
        data: {
          ownerId: other.userId,
          title: 'cross',
          body: 'b',
          status: 'ready',
          sourceType: 'transcript',
          sourceTranscriptId: actor.transcriptId,
        },
      });

      const job = await runningJob(tx, actor.userId);

      await handler.process(job);

      // The deferred no-orphans trigger of the graph: pending checks run now, not at a COMMIT that never comes.
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');

      expect((await tx.user.findMany({ select: { id: true } })).map((row: { id: string }) => row.id)).toEqual([actor.userId]);

      for (const table of TABLES) {
        expect({ table, rows: await tx[table].count() }).toEqual({ table, rows: 0 });
      }

      // Custom templates go (also the actor's, which a note still named); the built-ins are back.
      expect(await tx.noteTemplate.count({ where: { ownerId: { not: null } } })).toBe(0);
      const builtIns = await tx.noteTemplate.findMany({ where: { ownerId: null }, select: { id: true } });

      expect(builtIns.map((row: { id: string }) => row.id).sort()).toEqual(NOTE_BUILTIN_TEMPLATES.map((t) => t.id).sort());

      // Storage: only the surviving prefix is left, and every other key left the provider.
      const left = await tx.storageObject.findMany({ select: { storageKey: true } });

      expect(left.map((row: { storageKey: string }) => row.storageKey)).toEqual([backupKey]);
      for (const k of [...actor.keys, ...other.keys]) expect(deleted).toContain(k);
      expect(deleted).not.toContain(backupKey);

      const stored = await tx.job.findUnique({ where: { id: job.id } });
      const counts = (stored.payload as { result: { counts: Record<string, number> } }).result.counts;

      expect(counts['step.kvox.content.transcripts']).toBeGreaterThanOrEqual(2);
      expect(counts['step.kvox.content.notes']).toBeGreaterThanOrEqual(7);
      expect(counts['step.kvox.content.graphEntities']).toBeGreaterThanOrEqual(4);
      expect(counts['step.kvox.content.providerCopiesRemaining']).toBeGreaterThanOrEqual(1);
      expect(counts['step.kvox.storage-objects.storageObjectsDeleted']).toBeGreaterThanOrEqual(actor.keys.length + other.keys.length);
      expect(counts['step.kvox.storage-objects.storageObjectsFailed']).toBe(0);
      expect(counts['step.kvox.note-templates.builtInTemplatesRestored']).toBe(NOTE_BUILTIN_TEMPLATES.length);

      // A re-run of the same job finds nothing more to do and does not throw.
      await handler.process(stored);

      expect(await tx.user.count()).toBe(1);
      expect(await tx.noteTemplate.count({ where: { ownerId: null } })).toBe(NOTE_BUILTIN_TEMPLATES.length);
    });
  }, 300_000);

  it('keeps the row of an object the provider refuses, and counts it, without failing the reset', async () => {
    await inRolledBackReset(async ({ tx, handler }) => {
      const actor = await seedUser(tx, 'actor', { providerCopy: false });
      const refusedKey = actor.keys.find((k) => k.startsWith('uploads/')) as string;

      refused.add(refusedKey);

      const job = await runningJob(tx, actor.userId);

      await handler.process(job);

      const left = await tx.storageObject.findMany({ select: { storageKey: true } });

      expect(left.map((row: { storageKey: string }) => row.storageKey)).toContain(refusedKey);
      expect(deleted).not.toContain(refusedKey);

      const stored = await tx.job.findUnique({ where: { id: job.id } });
      const counts = (stored.payload as { result: { counts: Record<string, number> } }).result.counts;

      expect(counts['step.kvox.storage-objects.storageObjectsFailed']).toBe(1);
      // Everything that references an object is gone regardless: the Restrict never blocks.
      expect(await tx.transcript.count()).toBe(0);
    });
  }, 300_000);
});
