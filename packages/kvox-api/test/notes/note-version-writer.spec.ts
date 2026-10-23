import { ConflictException } from '@nestjs/common';
import { NOTE_CONFLICT_REASONS } from '../../src/notes/dto/note.dto.js';
import { NoteVersionWriter } from '../../src/notes/note-version-writer.js';

// =============================================================================
// NoteVersionWriter (issue #712) — the optimistic version commit
// =============================================================================

const NOTE_ID = 'note-1';

const makeClient = (claimed = 1) => ({
  note: {
    updateMany: jest.fn().mockResolvedValue({ count: claimed }),
    findUnique: jest.fn().mockResolvedValue({ id: NOTE_ID, currentVersion: 7 }),
  },
  noteVersion: { create: jest.fn().mockResolvedValue({}) },
});

const input = {
  noteId: NOTE_ID,
  baseVersion: 3,
  body: 'New body',
  bodyFormat: 'markdown' as const,
  kind: 'edit' as const,
  authorId: 'user-1',
};

describe('NoteVersionWriter', () => {
  it('claims the row at baseVersion, bumps it and writes the version row', async () => {
    const client = makeClient();
    const prisma = { ...client, $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(client)) };
    const writer = new NoteVersionWriter(prisma as never);

    await writer.commit({ ...input, summary: 's', clientBatchId: 'b1' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(client.note.updateMany).toHaveBeenCalledWith({
      where: { id: NOTE_ID, currentVersion: 3, deletedAt: null },
      data: { currentVersion: 4, body: 'New body', bodyFormat: 'markdown' },
    });
    expect(client.noteVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        noteId: NOTE_ID,
        version: 4,
        kind: 'edit',
        summary: 's',
        authorId: 'user-1',
        clientBatchId: 'b1',
        restoredFromVersion: null,
      }),
    });
  });

  it('throws the stale-base conflict with the real current version and writes no version', async () => {
    const client = makeClient(0);
    const prisma = { $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(client)) };
    const writer = new NoteVersionWriter(prisma as never);

    const error = await writer.commit(input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      details: { reason: NOTE_CONFLICT_REASONS.STALE_BASE_VERSION, currentVersion: 7 },
    });
    expect(client.noteVersion.create).not.toHaveBeenCalled();
  });

  it('switches sourceType to document and sourceObjectId in the same update', async () => {
    const client = makeClient();
    const prisma = { $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(client)) };
    const writer = new NoteVersionWriter(prisma as never);

    await writer.commit({ ...input, sourceObjectId: 'obj-9', title: 'T', noteStatus: 'failed' });

    expect(client.note.updateMany).toHaveBeenCalledTimes(1);
    expect(client.note.updateMany.mock.calls[0][0].data).toMatchObject({
      sourceType: 'document',
      sourceObjectId: 'obj-9',
      title: 'T',
      titleSource: 'user',
      status: 'ready',
      failureReason: null,
    });
  });

  it('runs inside a given transaction client and opens no transaction of its own', async () => {
    const client = makeClient();
    const prisma = { $transaction: jest.fn() };
    const writer = new NoteVersionWriter(prisma as never);

    await writer.commit(input, client as never);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(client.note.updateMany).toHaveBeenCalledTimes(1);
    expect(client.noteVersion.create).toHaveBeenCalledTimes(1);
  });
});
