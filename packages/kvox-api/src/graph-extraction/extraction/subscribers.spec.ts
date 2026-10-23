import { NOTE_IMPORT_BATCH_SETTLED_EVENT } from '@marinoscar/kvox-contract/notes';

import { GRAPH_PROPOSAL_DRAFTED_EVENT, KG_AUTOCOMMIT_JOB_TYPE, KG_LIBRARY_RECONCILE_JOB_TYPE } from '../../graph/index.js';
import { NOTE_READY_EVENT } from '../../notes/index.js';
import { GraphReconcileEnqueuer } from '../library/graph-reconcile.enqueuer.js';
import { ImportBatchSettledSubscriber } from '../library/import-batch-settled.subscriber.js';
import { jobsMock } from '../__fixtures__/jobs-mock.js';
import { NoteReadyExtractionSubscriber } from './note-ready-extraction.subscriber.js';
import { ProposalDraftedSubscriber } from './proposal-drafted.subscriber.js';

function bus() {
  const handlers = new Map<string, (p: unknown) => Promise<void> | void>();
  return {
    port: { emit: jest.fn(), subscribe: jest.fn((name: string, h: (p: unknown) => Promise<void> | void) => { handlers.set(name, h); return () => undefined; }) },
    fire: async (name: string, payload: unknown) => handlers.get(name)?.(payload),
  };
}

describe('note_ready subscriber (#716)', () => {
  it('threads bulk and origin into enqueueForReadyNote', async () => {
    const events = bus();
    const extraction = { enqueueForReadyNote: jest.fn(async () => null) };
    new NoteReadyExtractionSubscriber(events.port as never, extraction as never).onModuleInit();
    await events.fire(NOTE_READY_EVENT, { noteId: 'n', ownerId: 'u', version: 1, bulk: true, origin: 'library' });
    expect(extraction.enqueueForReadyNote).toHaveBeenCalledWith('n', 'u', { bulk: true, origin: 'library' });
    await events.fire(NOTE_READY_EVENT, { noteId: 'n', ownerId: 'u', version: 1 });
    expect(extraction.enqueueForReadyNote).toHaveBeenLastCalledWith('n', 'u', {});
  });
});

describe('ImportBatchSettledSubscriber (#716)', () => {
  it('only enqueues one reconcile job per owner, and swallows an enqueue failure', async () => {
    const events = bus();
    const jobs = jobsMock();
    new ImportBatchSettledSubscriber(events.port as never, new GraphReconcileEnqueuer(jobs as never)).onModuleInit();
    await events.fire(NOTE_IMPORT_BATCH_SETTLED_EVENT, { batchId: 'b', ownerId: 'u', libraryId: 'l' });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: KG_LIBRARY_RECONCILE_JOB_TYPE,
        subjectType: 'user',
        subjectId: 'u',
        priority: 50,
        payload: { ownerId: 'u', libraryId: 'l', batchId: 'b' },
      }),
    );
    expect(jobs.enqueue.mock.calls[0]![0]).not.toHaveProperty('skipDedup');
    jobs.enqueue.mockRejectedValueOnce(new Error('queue down'));
    await expect(events.fire(NOTE_IMPORT_BATCH_SETTLED_EVENT, { batchId: 'b', ownerId: 'u', libraryId: null })).resolves.toBeUndefined();
  });
});

describe('ProposalDraftedSubscriber (#718)', () => {
  it('only enqueues kg.autocommit for the proposal', async () => {
    const events = bus();
    const jobs = jobsMock();
    new ProposalDraftedSubscriber(events.port as never, jobs as never).onModuleInit();
    await events.fire(GRAPH_PROPOSAL_DRAFTED_EVENT, { proposalId: 'p', ownerId: 'u', noteId: 'n', noteVersion: 1, kind: 'extraction' });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: KG_AUTOCOMMIT_JOB_TYPE, subjectType: 'kg_proposal', subjectId: 'p', payload: { proposalId: 'p', ownerId: 'u' } }),
    );
    await events.fire(GRAPH_PROPOSAL_DRAFTED_EVENT, { proposalId: 'p2', ownerId: 'u', noteId: 'n', noteVersion: 1, kind: 'import' });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });
});
