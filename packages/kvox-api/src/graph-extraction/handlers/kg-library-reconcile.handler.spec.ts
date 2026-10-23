import { KgLibraryReconcileHandler } from './kg-library-reconcile.handler.js';
import { jobsMock } from '../__fixtures__/jobs-mock.js';

const OWNER = '22222222-2222-4222-8222-222222222222';
const job = (payload: unknown = { ownerId: OWNER }) => ({ id: 'j1', type: 'kg.library_reconcile', payload }) as never;

function harness(opts: { files?: any[]; notes?: any[]; proposals?: any[]; can?: boolean } = {}) {
  const files = opts.files ?? [];
  const prisma = {
    noteLibraryFile: { findMany: jest.fn(async (_args?: any): Promise<any[]> => files) },
    note: { findMany: jest.fn(async () => opts.notes ?? []) },
    kgProposal: { findMany: jest.fn(async () => opts.proposals ?? []) },
  };
  const extraction = { canExtractFor: jest.fn(async () => opts.can ?? true), enqueueForReadyNote: jest.fn(async () => 'prop') };
  const enqueuer = { enqueue: jest.fn(async () => ({ id: 'j2', deduplicated: false })) };
  const jobs = jobsMock();
  const handler = new KgLibraryReconcileHandler(jobs as never, prisma as never, extraction as never, enqueuer as never);
  return { handler, prisma, extraction, enqueuer, jobs };
}

describe('KgLibraryReconcileHandler (#716)', () => {
  it('declares its profile and is server-only', () => {
    const { handler, jobs } = harness();
    handler.onModuleInit();
    expect(handler.type).toBe('kg.library_reconcile');
    expect(handler.profile).toEqual({ maxRuntimeMs: 120_000, maxAttempts: 2 });
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
  });

  it('queues only stale library notes, bulk, for the owner', async () => {
    const h = harness({
      files: [
        { id: 'f1', noteId: 'n1', extractedVersion: 1 },
        { id: 'f2', noteId: 'n2', extractedVersion: 2 },
        { id: 'f3', noteId: 'n3', extractedVersion: null },
      ],
      notes: [
        { id: 'n1', currentVersion: 2 },
        { id: 'n2', currentVersion: 2 },
        { id: 'n3', currentVersion: 1 },
      ],
      proposals: [{ noteId: 'n3', noteVersion: 1, status: 'extracting' }],
    });
    await h.handler.process(job());
    expect(h.extraction.enqueueForReadyNote).toHaveBeenCalledTimes(1);
    expect(h.extraction.enqueueForReadyNote).toHaveBeenCalledWith('n1', OWNER, { bulk: true, origin: 'library' });
    expect(h.prisma.noteLibraryFile.findMany.mock.calls[0]![0].where.library).toEqual({ ownerId: OWNER, autoExtract: true });
    expect(h.enqueuer.enqueue).not.toHaveBeenCalled();
  });

  it('narrows to a batch and a library', async () => {
    const h = harness();
    const batchId = '33333333-3333-4333-8333-333333333333';
    const libraryId = '44444444-4444-4444-8444-444444444444';
    await h.handler.process(job({ ownerId: OWNER, batchId, libraryId }));
    const where = h.prisma.noteLibraryFile.findMany.mock.calls[0]![0].where;
    expect(where.batchItems).toEqual({ some: { batchId } });
    expect(where.library).toEqual({ ownerId: OWNER, autoExtract: true, id: libraryId });
  });

  it('does nothing when the owner cannot extract (graph off, no graph:write, preference off)', async () => {
    const h = harness({ can: false });
    await h.handler.process(job());
    expect(h.prisma.noteLibraryFile.findMany).not.toHaveBeenCalled();
  });

  it('caps a run at 500 notes and queues a continuation', async () => {
    const files = Array.from({ length: 600 }, (_, i) => ({ id: `f${i}`, noteId: `n${i}`, extractedVersion: null }));
    const notes = files.map((f) => ({ id: f.noteId, currentVersion: 1 }));
    const h = harness({ files, notes });
    await h.handler.process(job());
    expect(h.extraction.enqueueForReadyNote).toHaveBeenCalledTimes(500);
    expect(h.enqueuer.enqueue).toHaveBeenCalledWith({ ownerId: OWNER }, { continuation: true });
  });

  it('an unreadable payload is a no-op', async () => {
    const h = harness();
    await h.handler.process(job({ x: 1 }));
    expect(h.extraction.canExtractFor).not.toHaveBeenCalled();
  });
});
