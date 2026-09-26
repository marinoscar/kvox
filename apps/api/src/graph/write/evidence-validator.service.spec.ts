import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { EvidenceInput } from '../dto/graph-evidence.dto';
import { EvidenceValidator } from './evidence-validator.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const NOTE = '22222222-2222-4222-8222-222222222222';
const FOREIGN_NOTE = '33333333-3333-4333-8333-333333333333';
const TRANSCRIPT = '44444444-4444-4444-8444-444444444444';
const OTHER_TRANSCRIPT = '55555555-5555-4555-8555-555555555555';
const SEGMENT = '66666666-6666-4666-8666-666666666666';
const OTHER_SEGMENT = '77777777-7777-4777-8777-777777777777';

const noteEv = (noteId: string, noteVersion = 1) =>
  ({ noteId, noteVersion, charStart: 0, charEnd: 5, quote: 'Hello' }) as EvidenceInput;
const segEv = (transcriptId: string, segmentId: string) =>
  ({ transcriptId, segmentId, quote: 'Hello' }) as EvidenceInput;

/**
 * A fake transaction client answering from fixed data. Readability here is
 * exactly what the real queries encode: the owner's own live notes, versions
 * that exist, and transcripts the owner owns or holds a share on.
 */
function fakeTx() {
  const tx = {
    note: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] }; ownerId: string } }) =>
        where.id.in.filter((id) => id === NOTE && where.ownerId === OWNER).map((id) => ({ id })),
      ),
    },
    noteVersion: {
      findMany: jest.fn(async ({ where }: { where: { OR: { noteId: string; version: number }[] } }) =>
        where.OR.filter((p) => p.noteId === NOTE && p.version === 1),
      ),
    },
    transcript: {
      // TRANSCRIPT is shared with the owner (the query's OR matches it);
      // OTHER_TRANSCRIPT is somebody else's and not shared.
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => id === TRANSCRIPT).map((id) => ({ id })),
      ),
    },
    transcriptSegment: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, transcriptId: id === SEGMENT ? TRANSCRIPT : OTHER_TRANSCRIPT })),
      ),
    },
    storageObject: { findMany: jest.fn(async () => []) },
  };
  return tx;
}

describe('EvidenceValidator', () => {
  const validator = new EvidenceValidator();

  async function invalidIndexes(evidence: EvidenceInput[], tx = fakeTx()): Promise<number[] | null> {
    try {
      await validator.assertReadable(OWNER, evidence, tx as unknown as Prisma.TransactionClient);
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      return ((err as BadRequestException).getResponse() as { details: { invalidEvidence: number[] } }).details
        .invalidEvidence;
    }
  }

  it('accepts an owned note at an existing version, applying the DTO defaults', async () => {
    const tx = fakeTx();
    const parsed = await validator.assertReadable(OWNER, [noteEv(NOTE)], tx as unknown as Prisma.TransactionClient);
    expect(parsed[0]).toMatchObject({ noteId: NOTE, noteVersion: 1, transcriptId: null, sourceIri: null });
    expect(tx.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: OWNER, status: { not: 'deleting' }, deletedAt: null }),
      }),
    );
  });

  it("refuses another user's note", async () => {
    await expect(invalidIndexes([noteEv(NOTE), noteEv(FOREIGN_NOTE)])).resolves.toEqual([1]);
  });

  it('refuses a note version that does not exist', async () => {
    await expect(invalidIndexes([noteEv(NOTE, 9)])).resolves.toEqual([0]);
  });

  it('accepts a segment of a transcript shared with the owner', async () => {
    const tx = fakeTx();
    await expect(invalidIndexes([segEv(TRANSCRIPT, SEGMENT)], tx)).resolves.toBeNull();
    expect(tx.transcript.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          OR: [{ ownerId: OWNER }, { shares: { some: { userId: OWNER } } }],
        }),
      }),
    );
  });

  it('refuses a segment that belongs to another transcript', async () => {
    await expect(invalidIndexes([segEv(TRANSCRIPT, OTHER_SEGMENT)])).resolves.toEqual([0]);
  });

  it('refuses a transcript the owner cannot view', async () => {
    await expect(invalidIndexes([segEv(OTHER_TRANSCRIPT, OTHER_SEGMENT)])).resolves.toEqual([0]);
  });

  it('refuses a row the schema rejects (no anchor at all), by index', async () => {
    await expect(invalidIndexes([noteEv(NOTE), { quote: 'orphan' } as EvidenceInput])).resolves.toEqual([1]);
  });

  it('refuses an import object the owner did not upload', async () => {
    await expect(
      invalidIndexes([{ importObjectId: FOREIGN_NOTE, quote: 'x' } as EvidenceInput]),
    ).resolves.toEqual([0]);
  });

  it('makes at most one query per source table, whatever the batch size', async () => {
    const tx = fakeTx();
    const batch = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? noteEv(NOTE) : segEv(TRANSCRIPT, SEGMENT)));
    await validator.assertReadable(OWNER, batch, tx as unknown as Prisma.TransactionClient);

    expect(tx.note.findMany).toHaveBeenCalledTimes(1);
    expect(tx.noteVersion.findMany).toHaveBeenCalledTimes(1);
    expect(tx.transcript.findMany).toHaveBeenCalledTimes(1);
    expect(tx.transcriptSegment.findMany).toHaveBeenCalledTimes(1);
    expect(tx.storageObject.findMany).not.toHaveBeenCalled();
  });

  it('queries no table a batch does not cite', async () => {
    const tx = fakeTx();
    await validator.assertReadable(
      OWNER,
      [{ sourceIri: 'https://example.test/x', quote: 'x' } as EvidenceInput],
      tx as unknown as Prisma.TransactionClient,
    );
    for (const table of Object.values(tx)) expect(table.findMany).not.toHaveBeenCalled();
  });
});
