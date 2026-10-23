import { NotFoundException } from '@nestjs/common';

import { ExtractionRetryService } from './extraction-retry.service.js';

const actor = { id: 'u1', permissions: ['graph:write'] };

function make(over: { batch?: unknown; proposals?: any[]; extracted?: number | null } = {}) {
  const prisma = {
    noteImportBatch: { findFirst: jest.fn(async () => (over.batch === undefined ? { id: 'b1' } : over.batch)) },
    noteImportBatchItem: { findMany: jest.fn(async () => [{ noteId: 'n1' }, { noteId: 'n2' }, { noteId: 'n3' }, { noteId: null }]) },
    note: { findMany: jest.fn(async () => [{ id: 'n1', currentVersion: 1 }, { id: 'n2', currentVersion: 1 }, { id: 'n3', currentVersion: 1 }]) },
    noteLibraryFile: { findMany: jest.fn(async () => [{ noteId: 'n3', extractedVersion: 1 }]) },
    kgProposal: {
      findMany: jest.fn(async () =>
        over.proposals ?? [
          { noteId: 'n1', noteVersion: 1, status: 'failed' },
          { noteId: 'n2', noteVersion: 1, status: 'draft' },
        ],
      ),
    },
  };
  const extraction = { enqueueForReadyNote: jest.fn(async () => 'p') };
  return { svc: new ExtractionRetryService(prisma as never, extraction as never), extraction, prisma };
}

describe('ExtractionRetryService (#716)', () => {
  it('re-queues only the failed note, as an explicit bulk request', async () => {
    const t = make();
    await expect(t.svc.retry(actor, 'b1')).resolves.toEqual({ requeued: 1 });
    expect(t.extraction.enqueueForReadyNote).toHaveBeenCalledTimes(1);
    expect(t.extraction.enqueueForReadyNote).toHaveBeenCalledWith('n1', 'u1', { bulk: true, origin: 'library', explicit: true });
  });

  it('also queues a note that was never extracted', async () => {
    const t = make({ proposals: [] });
    await expect(t.svc.retry(actor, 'b1')).resolves.toEqual({ requeued: 2 }); // n1, n2 (n3 is up to date)
  });

  it('answers 404 for a batch that is not the caller\'s', async () => {
    const t = make({ batch: null });
    await expect(t.svc.retry(actor, 'b9')).rejects.toBeInstanceOf(NotFoundException);
    expect(t.prisma.noteImportBatch.findFirst).toHaveBeenCalledWith({ where: { id: 'b9', ownerId: 'u1' }, select: { id: true } });
  });
});
