// =============================================================================
// Real-Postgres test: kg.speaker_link end to end (issue #356, epic #344;
// docs/specs/ontology.md §4 step 2, §5.1, §5.2, §8, §12)
// =============================================================================
//
// The reconcile's guarantees rest on things only a real database has: the
// per-transcript advisory lock, `kg_relations_speaker_link_uniq_idx` (a
// hand-written partial unique index), the deferred no-orphans trigger that
// must accept an edge/Person deleted TOGETHER with its evidence, and the
// `from_speaker_id` cascade. So this is a `*.db.spec.ts` file: excluded from
// `npm test`, run by `npm run test:db`.
//
// The scenario: an owner names speakers across two transcripts, renames one,
// clears one; an editor-share user names one (nothing is written); a deleted
// transcript and an owner without `graph:write` are no-ops; two concurrent
// runs converge on one end state.
//
// #405 adds the same rename → re-point and clear → unlink story driven through
// the REAL save path — `TranscriptEditingService.applyOperations`, whose
// identification and versioned branches each emit
// `transcript.speakers_identified` — rather than by writing
// `speaker_identities` directly, which a versioned rename never touches.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { buildDatabaseUrl } from '../../src/common/database-url';
import { GraphOntologyService } from '../../src/graph/ontology/graph-ontology.service';
import {
  SPEAKER_LINKED_ACTION,
  SPEAKER_UNLINKED_ACTION,
  SpeakerLinkReconciler,
} from '../../src/graph/speaker-link/speaker-link.reconciler';
import { EvidenceValidator } from '../../src/graph/write/evidence-validator.service';
import { GraphWriteService } from '../../src/graph/write/graph-write.service';
import { OP_TYPES } from '../../src/transcripts/editing';
import {
  TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT,
  type TranscriptSpeakersIdentifiedEvent,
} from '../../src/transcripts/events/transcript-speakers-identified.event';
import { TranscriptEditingService } from '../../src/transcripts/transcript-editing.service';
import { TranscriptMaterializeService } from '../../src/transcripts/transcript-materialize.service';
import { resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-speaker-link.db.spec');

const EMAIL_PREFIX = 'kg-speaker-link-test';

describeWithDb('kg.speaker_link reconcile (real Postgres)', () => {
  let prisma: PrismaClient;
  let reconciler: SpeakerLinkReconciler;
  // A role of this suite's own that carries `graph:write`. CI's smoke job runs
  // `test:db` BEFORE `prisma:seed`, so the seeded roles cannot be relied on.
  let graphWriterRoleId: string;

  beforeAll(async () => {
    if (!dbReachable) return;
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
    reconciler = new SpeakerLinkReconciler(
      new GraphWriteService(new EvidenceValidator()),
      new GraphOntologyService(prisma as never),
    );
    // Upsert by name, exactly as the seed does, so running the seed later is unaffected.
    const permission = await prisma.permission.upsert({
      where: { name: 'graph:write' },
      update: {},
      create: { name: 'graph:write' },
    });
    const role = await prisma.role.upsert({
      where: { name: `${EMAIL_PREFIX}-graph-writer` },
      update: {},
      create: { name: `${EMAIL_PREFIX}-graph-writer` },
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
    graphWriterRoleId = role.id;
  });

  afterAll(async () => {
    if (dbReachable && prisma) {
      // Cascades role_permissions and user_roles; the permission row is kept (the seed owns it).
      await prisma.role.deleteMany({ where: { name: `${EMAIL_PREFIX}-graph-writer` } });
    }
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const owner = { owner: { email: { startsWith: EMAIL_PREFIX } } };
    await prisma.auditEvent.deleteMany({
      where: {
        OR: [
          { action: { in: [SPEAKER_LINKED_ACTION, SPEAKER_UNLINKED_ACTION] } },
          { action: { startsWith: 'transcript.' } },
        ],
        actorUser: { email: { startsWith: EMAIL_PREFIX } },
      },
    });
    // Subjects BEFORE evidence (the trigger refuses the reverse).
    await prisma.kgRelation.deleteMany({ where: owner });
    await prisma.kgEntity.deleteMany({ where: owner });
    await prisma.kgEvidence.deleteMany({ where: owner });
    await prisma.transcriptShare.deleteMany({ where: { user: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.transcriptSegment.deleteMany({ where: { transcript: owner } });
    await prisma.transcriptSpeaker.deleteMany({ where: { transcript: owner } });
    await prisma.transcript.deleteMany({ where: owner });
    await prisma.storageObject.deleteMany({ where: { uploadedBy: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  /** A user holding this suite's `graph:write` role, or no role at all. */
  async function createUser(suffix: string, withRole = true) {
    const user = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
    if (withRole) {
      await prisma.userRole.create({ data: { userId: user.id, roleId: graphWriterRoleId } });
    }
    return user;
  }

  /** A transcript with one speaker per label, each with `segmentsEach` segments. */
  async function createTranscript(ownerId: string, labels: string[], segmentsEach = 4) {
    const source = await prisma.storageObject.create({
      data: {
        name: 'r.m4a',
        size: BigInt(1),
        mimeType: 'audio/mp4',
        storageKey: `${EMAIL_PREFIX}/${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: ownerId,
      },
    });
    const transcript = await prisma.transcript.create({
      data: { ownerId, title: 'T', sourceObjectId: source.id, provider: 'assemblyai' },
    });
    const speakers: Record<string, string> = {};
    let ordinal = 1000;
    for (const [i, label] of labels.entries()) {
      const speaker = await prisma.transcriptSpeaker.create({
        data: { transcriptId: transcript.id, label, displayName: `Speaker ${label}`, colorIndex: i },
      });
      speakers[label] = speaker.id;
      for (let n = 0; n < segmentsEach; n++) {
        await prisma.transcriptSegment.create({
          data: {
            transcriptId: transcript.id,
            speakerId: speaker.id,
            startMs: n * 1000,
            endMs: n * 1000 + 900,
            ordinal: (ordinal += 1000),
            text: `Line ${n} by ${label}`,
            words: [],
          },
        });
      }
    }
    return { transcriptId: transcript.id, speakers };
  }

  async function setIdentities(transcriptId: string, identities: Record<string, string>) {
    await prisma.transcript.update({
      where: { id: transcriptId },
      data: { speakerIdentities: identities as Prisma.InputJsonValue },
    });
  }

  function run(transcriptId: string, actorUserId: string) {
    return prisma.$transaction((tx) => reconciler.reconcile(tx, { transcriptId, actorUserId }), { timeout: 30_000 });
  }

  const persons = (ownerId: string) =>
    prisma.kgEntity.findMany({ where: { ownerId, type: 'Person' }, include: { aliases: true }, orderBy: { label: 'asc' } });
  const edges = (ownerId: string) =>
    prisma.kgRelation.findMany({ where: { ownerId, type: 'IDENTIFIED_AS' }, orderBy: { createdAt: 'asc' } });
  const evidenceCount = (subjectKind: 'entity' | 'relation', subjectId: string) =>
    prisma.kgEvidence.count({ where: { subjectKind, subjectId } });

  // ===========================================================================

  it('names, links across transcripts, renames and clears — with the cleanup rule', async () => {
    const owner = await createUser('owner');
    const t1 = await createTranscript(owner.id, ['A', 'B']);
    const t2 = await createTranscript(owner.id, ['C']);

    // --- The owner names Speaker A "Sarah Chen". ------------------------------
    await setIdentities(t1.transcriptId, { [t1.speakers.A]: 'Sarah Chen' });
    await expect(run(t1.transcriptId, owner.id)).resolves.toMatchObject({ linked: 1, created: 1, unlinked: 0 });

    let people = await persons(owner.id);
    expect(people).toHaveLength(1);
    const sarah = people[0];
    expect(sarah).toMatchObject({ label: 'Sarah Chen', reviewStatus: 'accepted' });
    expect(sarah.aliases.map((a) => [a.alias, a.source])).toEqual([['Sarah Chen', 'speaker_naming']]);

    let links = await edges(owner.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ fromSpeakerId: t1.speakers.A, fromId: null, toId: sarah.id });
    expect(links[0].props).toEqual({ transcriptId: t1.transcriptId, speakerId: t1.speakers.A });
    // 4 segments, capped at 3 citations each.
    await expect(evidenceCount('entity', sarah.id)).resolves.toBe(3);
    await expect(evidenceCount('relation', links[0].id)).resolves.toBe(3);

    // --- Speaker C "Sarah Chen" in a different transcript → the same Person. --
    await setIdentities(t2.transcriptId, { [t2.speakers.C]: 'sarah chen' });
    await expect(run(t2.transcriptId, owner.id)).resolves.toMatchObject({ linked: 1, created: 0 });
    expect(await persons(owner.id)).toHaveLength(1);
    links = await edges(owner.id);
    expect(links.map((e) => e.toId)).toEqual([sarah.id, sarah.id]);

    // --- Rename A → "Marcus Webb": the edge moves; Sarah keeps C's edge. ------
    await setIdentities(t1.transcriptId, { [t1.speakers.A]: 'Marcus Webb' });
    await expect(run(t1.transcriptId, owner.id)).resolves.toMatchObject({ linked: 1, created: 1 });
    people = await persons(owner.id);
    expect(people.map((p) => p.label)).toEqual(['Marcus Webb', 'Sarah Chen']);
    const marcus = people[0];
    const aEdges = await prisma.kgRelation.findMany({ where: { fromSpeakerId: t1.speakers.A } });
    expect(aEdges).toHaveLength(1);
    expect(aEdges[0].toId).toBe(marcus.id);

    // --- Name B "Dana Lee", then rename to "Dana Leigh": the naming-only -------
    // --- Person with no other ties is deleted with its aliases and evidence. --
    await setIdentities(t1.transcriptId, { [t1.speakers.A]: 'Marcus Webb', [t1.speakers.B]: 'Dana Lee' });
    await run(t1.transcriptId, owner.id);
    const dana = (await persons(owner.id)).find((p) => p.label === 'Dana Lee')!;
    expect(dana).toBeDefined();

    await setIdentities(t1.transcriptId, { [t1.speakers.A]: 'Marcus Webb', [t1.speakers.B]: 'Dana Leigh' });
    await run(t1.transcriptId, owner.id);
    await expect(prisma.kgEntity.findUnique({ where: { id: dana.id } })).resolves.toBeNull();
    await expect(prisma.kgEntityAlias.count({ where: { entityId: dana.id } })).resolves.toBe(0);
    await expect(evidenceCount('entity', dana.id)).resolves.toBe(0);

    // --- Clear B: its edge goes, and so does the naming-only "Dana Leigh". ----
    const leigh = (await persons(owner.id)).find((p) => p.label === 'Dana Leigh')!;
    await setIdentities(t1.transcriptId, { [t1.speakers.A]: 'Marcus Webb' });
    await expect(run(t1.transcriptId, owner.id)).resolves.toMatchObject({ linked: 0, unlinked: 1 });
    await expect(prisma.kgRelation.count({ where: { fromSpeakerId: t1.speakers.B } })).resolves.toBe(0);
    await expect(prisma.kgEntity.findUnique({ where: { id: leigh.id } })).resolves.toBeNull();

    // --- Clear C: Sarah's last edge goes, but her evidence cites T1 — she ------
    // --- has become knowledge beyond T2's naming, so she is kept. -------------
    await setIdentities(t2.transcriptId, {});
    await run(t2.transcriptId, owner.id);
    await expect(prisma.kgRelation.count({ where: { toId: sarah.id } })).resolves.toBe(0);
    await expect(prisma.kgEntity.findUnique({ where: { id: sarah.id } })).resolves.not.toBeNull();

    // --- Audits carry ids, never a name. --------------------------------------
    const audits = await prisma.auditEvent.findMany({
      where: { actorUserId: owner.id, action: { in: [SPEAKER_LINKED_ACTION, SPEAKER_UNLINKED_ACTION] } },
    });
    expect(audits.length).toBeGreaterThanOrEqual(6);
    for (const audit of audits) {
      expect(JSON.stringify(audit.meta)).not.toMatch(/Sarah|Marcus|Dana/i);
    }
  });

  // ===========================================================================
  // #405: through the real save path
  // ===========================================================================

  /**
   * The editing service on the real database, with the graph hand-off
   * observed: every `transcript.speakers_identified` it emits is recorded, and
   * `drain()` runs the reconcile each one would enqueue (what the listener +
   * `kg.speaker_link` handler do in production).
   */
  function editingService() {
    const events = new EventEmitter2();
    const emitted: TranscriptSpeakersIdentifiedEvent[] = [];
    events.on(TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT, (event: TranscriptSpeakersIdentifiedEvent) => {
      emitted.push(event);
    });
    const access = {
      require: async (_userId: string, id: string) => ({
        transcript: await prisma.transcript.findUniqueOrThrow({ where: { id } }),
        role: 'owner',
      }),
    };
    const pipeline = {
      enqueueSnapshot: async () => true,
      enqueueSearchIndex: async () => undefined,
    };
    const service = new TranscriptEditingService(
      prisma as never,
      access as never,
      new TranscriptMaterializeService(prisma as never, {} as never),
      pipeline as never,
      events,
    );
    const drain = async () => {
      const batch = emitted.splice(0);
      for (const event of batch) await run(event.transcriptId, event.actorUserId);
      return batch;
    };
    return { service, drain };
  }

  async function rename(
    service: TranscriptEditingService,
    owner: { id: string },
    transcriptId: string,
    speakerId: string,
    displayName: string,
  ) {
    const [transcript, speaker] = await Promise.all([
      prisma.transcript.findUniqueOrThrow({ where: { id: transcriptId } }),
      prisma.transcriptSpeaker.findUniqueOrThrow({ where: { id: speakerId } }),
    ]);
    return service.applyOperations(
      transcriptId,
      {
        baseVersion: transcript.currentVersion,
        clientBatchId: randomUUID(),
        ops: [{ op: OP_TYPES.RENAME_SPEAKER, speakerId, rev: speaker.rev, displayName }],
      } as never,
      {
        id: owner.id,
        email: 'owner@example.test',
        roles: [],
        permissions: ['transcripts:read', 'transcripts:write'],
        isActive: true,
      } as never,
    );
  }

  it('re-points on a versioned rename and unlinks on a clear, through the real save path (#405)', async () => {
    const owner = await createUser('save-path');
    const t = await createTranscript(owner.id, ['A']);
    await prisma.transcript.update({ where: { id: t.transcriptId }, data: { currentVersion: 1 } });
    const { service, drain } = editingService();
    const aEdge = () => prisma.kgRelation.findMany({ where: { fromSpeakerId: t.speakers.A } });

    // --- Identify: Speaker A → "Sarah Chen" (unversioned, #323). --------------
    await expect(rename(service, owner, t.transcriptId, t.speakers.A, 'Sarah Chen')).resolves.toMatchObject({
      version: 1,
    });
    expect((await drain()).map((e) => e.speakerIds)).toEqual([[t.speakers.A]]);
    const sarah = (await persons(owner.id)).find((p) => p.label === 'Sarah Chen')!;
    expect(sarah).toBeDefined();
    expect((await aEdge()).map((e) => e.toId)).toEqual([sarah.id]);

    // --- Rename: "Sarah Chen" → "Marcus Webb" is a VERSIONED correction. ------
    // speaker_identities still says "Sarah Chen"; the live row says "Marcus
    // Webb", and the live row is what the user sees.
    await expect(rename(service, owner, t.transcriptId, t.speakers.A, 'Marcus Webb')).resolves.toMatchObject({
      version: 2,
    });
    const identities = (await prisma.transcript.findUniqueOrThrow({ where: { id: t.transcriptId } }))
      .speakerIdentities;
    expect(identities).toEqual({ [t.speakers.A]: 'Sarah Chen' });

    expect((await drain()).map((e) => [e.actorUserId, e.speakerIds])).toEqual([[owner.id, [t.speakers.A]]]);
    const marcus = (await persons(owner.id)).find((p) => p.label === 'Marcus Webb')!;
    expect(marcus).toBeDefined();
    expect((await aEdge()).map((e) => e.toId)).toEqual([marcus.id]);
    // Sarah was a speaker-naming-only Person with no other ties: gone.
    await expect(prisma.kgEntity.findUnique({ where: { id: sarah.id } })).resolves.toBeNull();

    // --- Clear: back to the placeholder (versioned, retires the identity). ----
    await expect(rename(service, owner, t.transcriptId, t.speakers.A, 'Speaker A')).resolves.toMatchObject({
      version: 3,
    });
    expect((await drain()).map((e) => e.speakerIds)).toEqual([[t.speakers.A]]);
    await expect(aEdge()).resolves.toEqual([]);
    await expect(prisma.kgEntity.findUnique({ where: { id: marcus.id } })).resolves.toBeNull();
    expect(await persons(owner.id)).toEqual([]);
  });

  it('writes nothing for an editor-share user naming a speaker (§12)', async () => {
    const owner = await createUser('share-owner');
    const editor = await createUser('share-editor');
    const t = await createTranscript(owner.id, ['A']);
    await prisma.transcriptShare.create({
      data: { transcriptId: t.transcriptId, userId: editor.id, role: 'editor', grantedById: owner.id },
    });
    await setIdentities(t.transcriptId, { [t.speakers.A]: 'Sarah Chen' });

    await expect(run(t.transcriptId, editor.id)).resolves.toMatchObject({ skipped: 'not_owner' });
    await expect(prisma.kgEntity.count({ where: { ownerId: { in: [owner.id, editor.id] } } })).resolves.toBe(0);
    await expect(prisma.kgRelation.count({ where: { ownerId: { in: [owner.id, editor.id] } } })).resolves.toBe(0);
  });

  it('is a no-op for a deleted transcript, and for an owner without graph:write', async () => {
    const owner = await createUser('deleted');
    const t = await createTranscript(owner.id, ['A']);
    await setIdentities(t.transcriptId, { [t.speakers.A]: 'Sarah Chen' });
    await prisma.transcript.update({ where: { id: t.transcriptId }, data: { deletedAt: new Date() } });
    await expect(run(t.transcriptId, owner.id)).resolves.toMatchObject({ skipped: 'missing' });
    await expect(run(randomUUID(), owner.id)).resolves.toMatchObject({ skipped: 'missing' });

    const powerless = await createUser('no-perm', false);
    const t2 = await createTranscript(powerless.id, ['A']);
    await setIdentities(t2.transcriptId, { [t2.speakers.A]: 'Sarah Chen' });
    await expect(run(t2.transcriptId, powerless.id)).resolves.toMatchObject({ skipped: 'no_permission' });

    await expect(prisma.kgEntity.count({ where: { ownerId: { in: [owner.id, powerless.id] } } })).resolves.toBe(0);
  });

  it('converges: two concurrent runs produce the same end state as one', async () => {
    const owner = await createUser('concurrent');
    const t = await createTranscript(owner.id, ['A', 'B']);
    await setIdentities(t.transcriptId, { [t.speakers.A]: 'Sarah Chen', [t.speakers.B]: 'Marcus Webb' });

    await Promise.all([run(t.transcriptId, owner.id), run(t.transcriptId, owner.id)]);
    await run(t.transcriptId, owner.id);

    expect((await persons(owner.id)).map((p) => p.label)).toEqual(['Marcus Webb', 'Sarah Chen']);
    const links = await edges(owner.id);
    expect(links).toHaveLength(2);
    for (const link of links) await expect(evidenceCount('relation', link.id)).resolves.toBe(3);
  });

  it('holds kg_relations_speaker_link_uniq_idx, and cascades the edge with its speaker', async () => {
    const owner = await createUser('uniq');
    const t = await createTranscript(owner.id, ['A']);
    await setIdentities(t.transcriptId, { [t.speakers.A]: 'Sarah Chen' });
    await run(t.transcriptId, owner.id);
    const [link] = await edges(owner.id);

    // A second IDENTIFIED_AS edge for the same speaker is refused by the index.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO kg_relations (id, owner_id, type, from_speaker_id, to_id, review_status, ontology_version, updated_at)
         VALUES ($1::uuid, $2::uuid, 'IDENTIFIED_AS', $3::uuid, $4::uuid, 'unreviewed', 'test', now())`,
        randomUUID(),
        owner.id,
        t.speakers.A,
        link.toId,
      ),
    ).rejects.toThrow();

    // Deleting the transcript_speakers row cascades the edge.
    await prisma.transcriptSegment.deleteMany({ where: { speakerId: t.speakers.A } });
    await prisma.transcriptSpeaker.delete({ where: { id: t.speakers.A } });
    await expect(prisma.kgRelation.findUnique({ where: { id: link.id } })).resolves.toBeNull();
  });
});
