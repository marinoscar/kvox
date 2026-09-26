// =============================================================================
// Real-Postgres test: GraphWriteService and the no-orphans trigger (issue
// #355, epic #344; docs/specs/ontology.md §3.3, §5.3, §8)
// =============================================================================
//
// A deferred constraint trigger only exists once its migration has run, and
// it only fires at a real COMMIT — neither is something a mocked `tx` can
// show. So, like `kg-schema.db.spec.ts` beside it, this is a `*.db.spec.ts`
// file: excluded from `npm test`, run by `npm run test:db` (CI's Smoke job).
//
// What it proves:
//   - the trigger: an evidence-less accepted row fails at COMMIT with SQLSTATE
//     23514; deleting an accepted row's last citation fails the same way;
//     deleting the subject WITH its evidence in one transaction passes; a merge
//     tombstone whose evidence was re-pointed passes; an `unreviewed` row needs
//     none, and promoting it to `accepted` without evidence fails;
//   - GraphWriteService end to end: the label stored as an alias with its
//     source, `valid` written through `toPgRange` and read back with
//     `lower()`/`upper()`, the live-statement unique index surfacing as
//     `GraphDuplicateError`, `person_fact` sensitivity defaulting to
//     `personal`, supersedes wiring, and evidence validation against real
//     notes, versions, shares and segments.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { computeEffectiveSchema, ONTOLOGY_VERSION } from '@app/shared/ontology';

import { buildDatabaseUrl } from '../../src/common/database-url';
import { EvidenceValidator } from '../../src/graph/write/evidence-validator.service';
import {
  GraphDuplicateError,
  isKgInvariantViolation,
  toGraphHttpException,
} from '../../src/graph/write/graph-write.errors';
import { GraphWriteService } from '../../src/graph/write/graph-write.service';
import { normalizeAlias } from '../../src/graph/write/normalize';
import type { EvidenceInput } from '../../src/graph/dto/graph-evidence.dto';
import { resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb, dbReachable } = resolveDbSuite('graph-write.db.spec');

const EMAIL_PREFIX = 'graph-write-test';
const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });

describeWithDb('GraphWriteService and the no-orphans invariant (real Postgres)', () => {
  let prisma: PrismaClient;
  let write: GraphWriteService;

  beforeAll(async () => {
    if (!dbReachable) return;
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
    write = new GraphWriteService(new EvidenceValidator());
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const owner = { owner: { email: { startsWith: EMAIL_PREFIX } } };
    // Subjects BEFORE evidence: deleting an accepted row's last citation while
    // the row still exists is exactly what the trigger refuses.
    await prisma.kgRelation.deleteMany({ where: owner });
    await prisma.kgItem.deleteMany({ where: owner });
    await prisma.kgEntity.deleteMany({ where: owner });
    await prisma.kgEvidence.deleteMany({ where: owner });
    await prisma.transcriptShare.deleteMany({ where: { user: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.transcriptSegment.deleteMany({ where: { transcript: owner } });
    await prisma.transcriptSpeaker.deleteMany({ where: { transcript: owner } });
    await prisma.transcript.deleteMany({ where: owner });
    await prisma.storageObject.deleteMany({ where: { uploadedBy: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.noteVersion.deleteMany({ where: { note: owner } });
    await prisma.note.deleteMany({ where: owner });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
  }

  async function createNote(ownerId: string, versions = 1) {
    const note = await prisma.note.create({
      data: { ownerId, title: 'Note', body: 'Body', status: 'ready', sourceType: 'document', currentVersion: versions },
    });
    for (let v = 1; v <= versions; v++) {
      await prisma.noteVersion.create({ data: { noteId: note.id, version: v, kind: 'edit', body: `Body v${v}` } });
    }
    return note;
  }

  async function createTranscript(ownerId: string) {
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
    const speaker = await prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
    });
    const segment = await prisma.transcriptSegment.create({
      data: {
        transcriptId: transcript.id,
        speakerId: speaker.id,
        startMs: 0,
        endMs: 1000,
        ordinal: 1000,
        text: 'Sarah joined Acme in 2019',
        words: [],
      },
    });
    return { transcript, speaker, segment };
  }

  const noteEvidence = (noteId: string, noteVersion = 1): EvidenceInput =>
    ({ noteId, noteVersion, charStart: 0, charEnd: 4, quote: 'Body' }) as EvidenceInput;

  const segmentEvidence = (transcriptId: string, segmentId: string): EvidenceInput =>
    ({ transcriptId, segmentId, quote: 'Sarah joined Acme' }) as EvidenceInput;

  async function rawEntity(ownerId: string, reviewStatus: string, label = 'Sarah Chen') {
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO kg_entities (id, owner_id, type, label, review_status, ontology_version, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Person', $3, $4::kg_review_status, 'test', now())`,
      id,
      ownerId,
      label,
      reviewStatus,
    );
    return id;
  }

  /** An accepted Person with one citation, via the service. */
  async function acceptedPerson(ownerId: string, noteId: string, label = 'Sarah Chen') {
    return prisma.$transaction((tx) =>
      write.createEntity(
        tx,
        { ownerId, type: 'Person', label, reviewStatus: 'accepted', labelSource: 'extraction', evidence: [noteEvidence(noteId)] },
        schema,
      ),
    );
  }

  // ===========================================================================
  // The trigger
  // ===========================================================================

  describe('the deferred no-orphans trigger', () => {
    it('refuses a raw accepted entity with no evidence at COMMIT, with SQLSTATE 23514', async () => {
      const owner = await createUser('raw-accepted');

      const err = await rawEntity(owner.id, 'accepted').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).toContain('23514');
      expect(isKgInvariantViolation(err)).toBe(true);
      await expect(prisma.kgEntity.count({ where: { ownerId: owner.id } })).resolves.toBe(0);

      // …and the HTTP mapping treats it as a writer bug, not a user error.
      const logger = { error: jest.fn() };
      expect(toGraphHttpException(err, logger)).toBeInstanceOf(InternalServerErrorException);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('kg no-orphans invariant violated'));
    });

    it('accepts an entity whose evidence is inserted later in the same transaction', async () => {
      const owner = await createUser('same-tx');
      const id = randomUUID();

      await prisma.$transaction(async (tx) => {
        await tx.kgEntity.create({ data: { id, ownerId: owner.id, type: 'Person', label: 'X', ontologyVersion: 'test' } });
        await tx.kgEvidence.create({ data: { ownerId: owner.id, subjectKind: 'entity', subjectId: id, quote: 'x' } });
      });

      await expect(prisma.kgEntity.findUnique({ where: { id } })).resolves.not.toBeNull();
    });

    it('needs no evidence for an unreviewed row, but refuses promoting it to accepted without any', async () => {
      const owner = await createUser('unreviewed');
      const id = await rawEntity(owner.id, 'unreviewed');

      await expect(
        prisma.kgEntity.update({ where: { id }, data: { reviewStatus: 'accepted' } }),
      ).rejects.toThrow(/kg no-orphans invariant/);
      await expect(prisma.kgEntity.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({
        reviewStatus: 'unreviewed',
      });
    });

    it("refuses deleting an accepted relation's last evidence in a committed transaction", async () => {
      const owner = await createUser('last-evidence');
      const note = await createNote(owner.id);
      const person = await acceptedPerson(owner.id, note.id);
      const org = await prisma.$transaction((tx) =>
        write.createEntity(
          tx,
          { ownerId: owner.id, type: 'Organization', label: 'Acme', reviewStatus: 'accepted', labelSource: 'user', evidence: [noteEvidence(note.id)] },
          schema,
        ),
      );
      // WORKS_FOR is temporal, so it needs a precision; 'unknown' means no range.
      const worksFor = await prisma.$transaction((tx) =>
        write.createRelation(
          tx,
          {
            ownerId: owner.id,
            type: 'WORKS_FOR',
            fromId: person.id,
            toId: org.id,
            validPrecision: 'unknown',
            reviewStatus: 'accepted',
            evidence: [noteEvidence(note.id)],
          },
          schema,
        ),
      );

      await expect(
        prisma.kgEvidence.deleteMany({ where: { subjectKind: 'relation', subjectId: worksFor.id } }),
      ).rejects.toThrow(/kg no-orphans invariant: relation/);
      await expect(
        prisma.kgEvidence.count({ where: { subjectKind: 'relation', subjectId: worksFor.id } }),
      ).resolves.toBe(1);
    });

    it('allows deleting an entity together with its evidence in one transaction', async () => {
      const owner = await createUser('delete-with-subject');
      const note = await createNote(owner.id);
      const person = await acceptedPerson(owner.id, note.id);

      await prisma.$transaction([
        prisma.kgEvidence.deleteMany({ where: { subjectKind: 'entity', subjectId: person.id } }),
        prisma.kgEntity.delete({ where: { id: person.id } }),
      ]);

      await expect(prisma.kgEntity.findUnique({ where: { id: person.id } })).resolves.toBeNull();
    });

    it('allows a merge that tombstones the loser and re-points its evidence to the survivor', async () => {
      const owner = await createUser('merge');
      const note = await createNote(owner.id);
      const survivor = await acceptedPerson(owner.id, note.id, 'Sarah Chen');
      const loser = await acceptedPerson(owner.id, note.id, 'S. Chen');

      await prisma.$transaction([
        prisma.kgEntity.update({ where: { id: loser.id }, data: { reviewStatus: 'merged', mergedIntoId: survivor.id } }),
        prisma.kgEvidence.updateMany({
          where: { subjectKind: 'entity', subjectId: loser.id },
          data: { subjectId: survivor.id },
        }),
      ]);

      await expect(
        prisma.kgEvidence.count({ where: { subjectKind: 'entity', subjectId: survivor.id } }),
      ).resolves.toBe(2);
    });
  });

  // ===========================================================================
  // GraphWriteService against the real schema
  // ===========================================================================

  describe('GraphWriteService', () => {
    it('stores the label as an alias with labelSource, deduplicating aliases by normalized form', async () => {
      const owner = await createUser('label-alias');
      const note = await createNote(owner.id);

      const entity = await prisma.$transaction((tx) =>
        write.createEntity(
          tx,
          {
            ownerId: owner.id,
            type: 'Person',
            label: 'Sarah Chen',
            reviewStatus: 'accepted',
            labelSource: 'speaker_naming',
            aliases: [
              { alias: '  SARAH   chen! ', source: 'user' },
              { alias: 'Sally', source: 'user' },
            ],
            evidence: [noteEvidence(note.id)],
          },
          schema,
        ),
      );

      expect(entity.ontologyVersion).toBe(ONTOLOGY_VERSION);
      const aliases = await prisma.kgEntityAlias.findMany({ where: { entityId: entity.id }, orderBy: { alias: 'asc' } });
      expect(aliases.map((a) => [a.alias, a.normalized, a.source])).toEqual([
        ['Sally', 'sally', 'user'],
        ['Sarah Chen', normalizeAlias('Sarah Chen'), 'speaker_naming'],
      ]);
    });

    it('writes a relation valid range through toPgRange and reads it back with lower()/upper()', async () => {
      const owner = await createUser('valid-range');
      const note = await createNote(owner.id);
      const person = await acceptedPerson(owner.id, note.id);
      const org = await prisma.$transaction((tx) =>
        write.createEntity(
          tx,
          { ownerId: owner.id, type: 'Organization', label: 'Acme', reviewStatus: 'accepted', labelSource: 'user', evidence: [noteEvidence(note.id)] },
          schema,
        ),
      );

      const from = new Date('2019-01-01T00:00:00.000Z');
      const to = new Date('2026-03-01T00:00:00.000Z');
      const relation = await prisma.$transaction((tx) =>
        write.createRelation(
          tx,
          {
            ownerId: owner.id,
            type: 'WORKS_FOR',
            fromId: person.id,
            toId: org.id,
            valid: { from, to },
            validPrecision: 'month',
            reviewStatus: 'accepted',
            evidence: [noteEvidence(note.id)],
          },
          schema,
        ),
      );

      const [row] = await prisma.$queryRaw<{ lo: Date; hi: Date; precision: string; version: string }[]>`
        SELECT lower(valid) AS lo, upper(valid) AS hi, valid_precision::text AS precision, ontology_version AS version
        FROM kg_relations WHERE id = ${relation.id}::uuid`;
      expect(row.lo.toISOString()).toBe(from.toISOString());
      expect(row.hi.toISOString()).toBe(to.toISOString());
      expect(row.precision).toBe('month');
      expect(row.version).toBe(ONTOLOGY_VERSION);
    });

    it('raises GraphDuplicateError for a second live item with the same (kind, subject, statement)', async () => {
      const owner = await createUser('duplicate');
      const note = await createNote(owner.id);
      const person = await acceptedPerson(owner.id, note.id);
      const claim = (statement: string) =>
        prisma.$transaction((tx) =>
          write.createItem(
            tx,
            {
              ownerId: owner.id,
              kind: 'claim',
              typeKey: 'Claim',
              subjectId: person.id,
              statement,
              reviewStatus: 'accepted',
              evidence: [noteEvidence(note.id)],
            },
            schema,
          ),
        );

      const first = await claim('Revenue grew 20%');
      const err = await claim('  revenue GREW 20%!! ').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(GraphDuplicateError);
      expect((err as GraphDuplicateError).existingId).toBe(first.id);
      await expect(prisma.kgItem.count({ where: { ownerId: owner.id } })).resolves.toBe(1);
    });

    it('stores a person_fact without a sensitivity as personal', async () => {
      const owner = await createUser('person-fact');
      const note = await createNote(owner.id);
      const person = await acceptedPerson(owner.id, note.id);

      const fact = await prisma.$transaction((tx) =>
        write.createItem(
          tx,
          {
            ownerId: owner.id,
            kind: 'person_fact',
            typeKey: 'PersonFact',
            subjectId: person.id,
            statement: 'Has two children',
            reviewStatus: 'accepted',
            evidence: [noteEvidence(note.id)],
          },
          schema,
        ),
      );

      await expect(prisma.kgItem.findUniqueOrThrow({ where: { id: fact.id } })).resolves.toMatchObject({
        sensitivity: 'personal',
        status: 'active',
      });
    });

    it('marks the superseded item and links superseded_by_id, even for a verbatim restatement', async () => {
      const owner = await createUser('supersedes');
      const note = await createNote(owner.id);
      const person = await acceptedPerson(owner.id, note.id);
      const create = (supersedesId?: string) =>
        prisma.$transaction((tx) =>
          write.createItem(
            tx,
            {
              ownerId: owner.id,
              kind: 'commitment',
              typeKey: 'Commitment',
              subjectId: person.id,
              statement: 'Send the deck',
              reviewStatus: 'accepted',
              supersedesId,
              evidence: [noteEvidence(note.id)],
            },
            schema,
          ),
        );

      const older = await create();
      const newer = await create(older.id);

      await expect(prisma.kgItem.findUniqueOrThrow({ where: { id: older.id } })).resolves.toMatchObject({
        reviewStatus: 'superseded',
        status: 'superseded',
        supersededById: newer.id,
      });
      expect(newer.status).toBe('open');
    });

    describe('evidence validation', () => {
      it("refuses another user's note and a version that does not exist, naming each index", async () => {
        const owner = await createUser('ev-owner');
        const stranger = await createUser('ev-stranger');
        const mine = await createNote(owner.id);
        const theirs = await createNote(stranger.id);

        const err = await prisma
          .$transaction((tx) =>
            write.createEntity(
              tx,
              {
                ownerId: owner.id,
                type: 'Person',
                label: 'X',
                reviewStatus: 'accepted',
                labelSource: 'user',
                evidence: [noteEvidence(mine.id), noteEvidence(theirs.id), noteEvidence(mine.id, 7)],
              },
              schema,
            ),
          )
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({ details: { invalidEvidence: [1, 2] } });
        await expect(prisma.kgEntity.count({ where: { ownerId: owner.id } })).resolves.toBe(0);
      });

      it('accepts a segment of a transcript shared with the owner, and refuses a segment of another transcript', async () => {
        const owner = await createUser('seg-owner');
        const sharer = await createUser('seg-sharer');
        const shared = await createTranscript(sharer.id);
        const other = await createTranscript(sharer.id);
        await prisma.transcriptShare.create({
          data: { transcriptId: shared.transcript.id, userId: owner.id, role: 'viewer', grantedById: sharer.id },
        });

        const create = (evidence: EvidenceInput) =>
          prisma.$transaction((tx) =>
            write.createEntity(
              tx,
              { ownerId: owner.id, type: 'Person', label: 'Sarah', reviewStatus: 'accepted', labelSource: 'user', evidence: [evidence] },
              schema,
            ),
          );

        await expect(create(segmentEvidence(shared.transcript.id, shared.segment.id))).resolves.toMatchObject({
          label: 'Sarah',
        });

        // A real segment, named under the wrong (but viewable) transcript.
        await expect(create(segmentEvidence(shared.transcript.id, other.segment.id))).rejects.toMatchObject({
          response: { details: { invalidEvidence: [0] } },
        });

        // A transcript that is not shared with the owner at all.
        await expect(create(segmentEvidence(other.transcript.id, other.segment.id))).rejects.toMatchObject({
          response: { details: { invalidEvidence: [0] } },
        });
      });
    });
  });
});
