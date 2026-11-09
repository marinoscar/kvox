// =============================================================================
// Real-Postgres test: the source-text evidence anchor (issue #789, epic #773)
// =============================================================================
//
// `20261107120000_add_kg_evidence_source_text` adds `kg_evidence.source_object_id`
// (the stored text a note was generated from, SetNull) and `source_text_length`
// (the length `char_start`/`char_end` index, and the durable marker of the
// anchor kind), a CHECK keeping the pair coherent, and an index on the FK. Only a
// database that ran the migration can show the CHECK, the SET NULL and, above
// all, that the DEFERRED no-orphans trigger (#355) still counts such a row as
// evidence. So, like `kg-schema.db.spec.ts` beside it, this is a `*.db.spec.ts`
// file: excluded from `npm test`, run by `npm run test:db`.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';
import { isKgInvariantViolation } from './package-internals';
import { resolveDbSuite } from '../jobs/db-test-support';
import { createStorageObject } from '../helpers/storage-object.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-evidence-source-text.db.spec');

const EMAIL_PREFIX = 'kg-source-text-test';

describeWithDb('kg_evidence source-text anchor (real Postgres)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!dbReachable) return;
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const owner = { owner: { email: { startsWith: EMAIL_PREFIX } } };
    // Subjects BEFORE evidence: deleting an accepted row's last citation while the row exists is
    // exactly what the trigger refuses.
    await prisma.kgEntity.deleteMany({ where: owner });
    await prisma.kgEvidence.deleteMany({ where: owner });
    await prisma.storageObject.deleteMany({ where: { uploadedBy: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.noteVersion.deleteMany({ where: { note: owner } });
    await prisma.note.deleteMany({ where: owner });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
  }

  /** A note generated from a document, and the stored text extracted from it. */
  async function createNoteWithSourceText(ownerId: string) {
    const upload = await createStorageObject(prisma, {
      data: {
        name: 'plan.pdf',
        size: BigInt(10),
        mimeType: 'application/pdf',
        storageKey: `${EMAIL_PREFIX}/${randomUUID()}`,
        managedBy: 'notes',
        uploadedById: ownerId,
      },
    });
    const text = await createStorageObject(prisma, {
      data: {
        name: 'plan.txt',
        size: BigInt(400),
        mimeType: 'text/plain',
        storageKey: `${EMAIL_PREFIX}/${randomUUID()}`,
        managedBy: 'notes',
        uploadedById: ownerId,
      },
    });
    const note = await prisma.note.create({
      data: { ownerId, title: 'Plan summary', body: 'Summary.', status: 'ready', sourceType: 'document', sourceObjectId: upload.id, currentVersion: 1 },
    });
    await prisma.noteVersion.create({ data: { noteId: note.id, version: 1, kind: 'edit', body: 'Summary.' } });
    return { note, text };
  }

  const citation = (ownerId: string, subjectId: string, noteId: string, sourceObjectId: string | null, over: Record<string, unknown> = {}) => ({
    ownerId,
    subjectKind: 'entity' as const,
    subjectId,
    noteId,
    noteVersion: 1,
    sourceObjectId,
    sourceTextLength: 400,
    charStart: 100,
    charEnd: 130,
    quote: 'Person K1 leads Project P1',
    ...over,
  });

  it('creates the FK index and the CHECK', async () => {
    const index = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE indexname = 'kg_evidence_source_object_id_idx'`;
    expect(index).toHaveLength(1);
    const check = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conname = 'kg_evidence_source_text_chk'`;
    expect(check).toHaveLength(1);
  });

  describe('kg_evidence_source_text_chk', () => {
    it('accepts a span inside the text, the whole text, and a row with no source anchor at all', async () => {
      const owner = await createUser('check-ok');
      const { note, text } = await createNoteWithSourceText(owner.id);

      await expect(prisma.kgEvidence.create({ data: citation(owner.id, randomUUID(), note.id, text.id) })).resolves.toMatchObject({
        sourceObjectId: text.id,
        sourceTextLength: 400,
      });
      await expect(
        prisma.kgEvidence.create({ data: citation(owner.id, randomUUID(), note.id, text.id, { charStart: 0, charEnd: 400 }) }),
      ).resolves.toBeDefined();
      // Every other anchor kind leaves both columns NULL.
      await expect(
        prisma.kgEvidence.create({ data: { ownerId: owner.id, subjectKind: 'entity', subjectId: randomUUID(), noteId: note.id, noteVersion: 1, charStart: 0, charEnd: 5, quote: 'Summ' } }),
      ).resolves.toMatchObject({ sourceObjectId: null, sourceTextLength: null });
    });

    it('rejects a text object without its length', async () => {
      const owner = await createUser('check-no-length');
      const { note, text } = await createNoteWithSourceText(owner.id);
      await expect(
        prisma.kgEvidence.create({ data: citation(owner.id, randomUUID(), note.id, text.id, { sourceTextLength: null }) }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });

    it('rejects a negative length and a span past the end of the text', async () => {
      const owner = await createUser('check-range');
      const { note, text } = await createNoteWithSourceText(owner.id);
      await expect(
        prisma.kgEvidence.create({ data: citation(owner.id, randomUUID(), note.id, text.id, { sourceTextLength: -1, charStart: null, charEnd: null }) }),
      ).rejects.toMatchObject({ code: 'P2039' });
      await expect(
        prisma.kgEvidence.create({ data: citation(owner.id, randomUUID(), note.id, text.id, { charEnd: 401 }) }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });
  });

  describe('ON DELETE SET NULL (the citation survives the text)', () => {
    it('clears the text object but keeps the length, the offsets, the note and the quote', async () => {
      const owner = await createUser('set-null');
      const { note, text } = await createNoteWithSourceText(owner.id);
      const row = await prisma.kgEvidence.create({ data: citation(owner.id, randomUUID(), note.id, text.id) });

      // The purge of the note deletes the extracted text object.
      await prisma.storageObject.delete({ where: { id: text.id } });

      await expect(prisma.kgEvidence.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({
        sourceObjectId: null,
        sourceTextLength: 400,
        charStart: 100,
        charEnd: 130,
        noteId: note.id,
        noteVersion: 1,
        quote: 'Person K1 leads Project P1',
      });
    });
  });

  describe('the deferred no-orphans trigger (#355) counts a source-text citation as evidence', () => {
    const entity = (ownerId: string, id: string) => ({
      id,
      ownerId,
      type: 'Person',
      label: 'Person K1',
      reviewStatus: 'accepted' as const,
      ontologyVersion: 'test',
    });

    it('commits an accepted entity whose ONLY evidence is a source-text citation', async () => {
      const owner = await createUser('trigger-ok');
      const { note, text } = await createNoteWithSourceText(owner.id);
      const id = randomUUID();

      await prisma.$transaction(async (tx) => {
        await tx.kgEntity.create({ data: entity(owner.id, id) });
        await tx.kgEvidence.create({ data: citation(owner.id, id, note.id, text.id) });
      });

      await expect(prisma.kgEntity.findUnique({ where: { id } })).resolves.not.toBeNull();
    });

    it('still refuses an accepted entity with no evidence at all', async () => {
      const owner = await createUser('trigger-none');
      const err = await prisma.kgEntity.create({ data: entity(owner.id, randomUUID()) }).catch((e: unknown) => e);
      expect(isKgInvariantViolation(err)).toBe(true);
    });

    it("refuses deleting the accepted entity's last citation, source-text or not", async () => {
      const owner = await createUser('trigger-delete');
      const { note, text } = await createNoteWithSourceText(owner.id);
      const id = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.kgEntity.create({ data: entity(owner.id, id) });
        await tx.kgEvidence.create({ data: citation(owner.id, id, note.id, text.id) });
      });

      const err = await prisma.kgEvidence.deleteMany({ where: { subjectId: id } }).catch((e: unknown) => e);
      expect(isKgInvariantViolation(err)).toBe(true);
      await expect(prisma.kgEvidence.count({ where: { subjectId: id } })).resolves.toBe(1);
    });

    it('is still satisfied after the text object was purged: the SET NULL row stays evidence', async () => {
      const owner = await createUser('trigger-purged');
      const { note, text } = await createNoteWithSourceText(owner.id);
      const id = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.kgEntity.create({ data: entity(owner.id, id) });
        await tx.kgEvidence.create({ data: citation(owner.id, id, note.id, text.id) });
      });

      // SET NULL updates `source_object_id`, not `subject_id`, so the evidence trigger does not fire
      // and the entity keeps its citation.
      await prisma.storageObject.delete({ where: { id: text.id } });

      await expect(prisma.kgEvidence.count({ where: { subjectId: id } })).resolves.toBe(1);
      await expect(prisma.kgEntity.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({ reviewStatus: 'accepted' });
    });
  });
});
