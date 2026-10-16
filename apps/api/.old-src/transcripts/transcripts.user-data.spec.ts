import { createFakeManagedObjects } from '../../test/helpers/fake-managed-objects.helper';
import { SEARCH_DOC_TRANSCRIPT } from '../search/indexing/job-types';
import { userDataScopeReaches } from '../user-data/user-data.registries';
import { USER_DATA_PURGE_MAX_BATCHES } from '../user-data/user-data.support';
import { TRANSCRIPT_PURGE_JOB_TYPE, TRANSCRIPT_SUBJECT_TYPE } from './job-types';
import {
  TRANSCRIPTS_USER_DATA_CATEGORY,
  TRANSCRIPTS_USER_DATA_HOOKS,
  TRANSCRIPTS_USER_DATA_SCOPE,
} from './transcripts.user-data';
import { TranscriptsUserDataHooks } from './transcripts.user-data.hooks';

// =============================================================================
// Transcripts in the Danger Zone (issue #80; moved from the purge handler's and
// the summary service's specs by issue #460)
// =============================================================================
//
// The assertions this file exists for, per the hook's own comments:
//
//   1. FORCE SEMANTICS: `TranscriptsService.remove`'s "cited by a note" 409 does
//      NOT apply to a bulk deletion — the hook clears the blocking reference
//      directly and deletes through raw Prisma + the per-item PURGE job.
//   2. ORDER IS NOT STYLISTIC: the reference is cleared BEFORE the delete it
//      unblocks, and on OTHER users' notes too.
//   3. IT REUSES THE PER-ITEM PURGE MACHINERY — it deletes no bytes itself.
//   4. RE-ENTRANCY — every step re-reads what is left rather than carrying a
//      cursor.
// =============================================================================

const USER_ID = 'user-1';

function harness() {
  const prisma = {
    note: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    transcript: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    storageObject: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { size: null } }),
    },
    // The `enqueuePurges` live-job dedup check — "nothing already covers this
    // id" unless a test says otherwise.
    job: { findMany: jest.fn().mockResolvedValue([]) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const pipeline = { enqueuePurge: jest.fn().mockResolvedValue(undefined) };
  // #188: a bulk deletion clears the semantic index for every category it
  // destroys rather than trusting the per-item purge jobs to get there.
  const searchIndex = { forgetOwnerDocuments: jest.fn().mockResolvedValue(0) };

  const hooks = new TranscriptsUserDataHooks(
    prisma as never,
    pipeline as never,
    searchIndex as never,
    createFakeManagedObjects(prisma) as never,
  );

  return { hooks, prisma, pipeline, searchIndex };
}

describe('TranscriptsUserDataHooks — summary', () => {
  it('excludes already soft-deleted rows from the count', async () => {
    const { hooks, prisma } = harness();

    await hooks.summarize(USER_ID);

    expect(prisma.transcript.count).toHaveBeenCalledWith({
      where: { ownerId: USER_ID, deletedAt: null },
    });
  });

  it('reports bytes as a decimal STRING, never a number, so a large library cannot round silently', async () => {
    const { hooks, prisma } = harness();
    prisma.transcript.count.mockResolvedValue(3);
    prisma.storageObject.aggregate.mockResolvedValue({
      _sum: { size: BigInt('9007199254740993') }, // > Number.MAX_SAFE_INTEGER
    });

    const result = await hooks.summarize(USER_ID);

    expect(result).toEqual({ count: 3, bytes: '9007199254740993' });
    expect(typeof result.bytes).toBe('string');
  });

  // ⚠ ONE AGGREGATE OVER RELATION FILTERS, not five id lists summed in
  // JavaScript — a row reachable twice must be counted once.
  it('sums bytes with ONE aggregate over the five relations a transcript owns', async () => {
    const { hooks, prisma } = harness();

    await hooks.summarize(USER_ID);

    expect(prisma.storageObject.aggregate).toHaveBeenCalledTimes(1);

    const owned = { ownerId: USER_ID, deletedAt: null };
    expect(prisma.storageObject.aggregate).toHaveBeenCalledWith({
      where: {
        OR: [
          { transcriptsAsSource: { some: owned } },
          { transcriptsAsPlayback: { some: owned } },
          { transcriptsAsRawResult: { some: owned } },
          { transcriptVersionSnapshots: { some: { transcript: owned } } },
          { transcriptExportFiles: { some: { transcript: owned } } },
        ],
      },
      _sum: { size: true },
    });
  });
});

describe('TranscriptsUserDataHooks — force semantics override the per-item 409 guard', () => {
  it('deletes a transcript that a note cites — clearing sourceTranscriptId instead of refusing', async () => {
    const { hooks, prisma, pipeline } = harness();

    prisma.transcript.findMany
      .mockResolvedValueOnce([{ id: 'transcript-cited' }])
      .mockResolvedValue([]);

    await hooks.purge(USER_ID);

    expect(prisma.note.updateMany).toHaveBeenCalledWith({
      where: { sourceTranscriptId: { in: ['transcript-cited'] } },
      data: { sourceTranscriptId: null },
    });
    expect(pipeline.enqueuePurge).toHaveBeenCalledWith('transcript-cited');
  });

  it('clears sourceTranscriptId before soft-deleting the transcripts it pointed at', async () => {
    const { hooks, prisma, pipeline } = harness();

    prisma.transcript.findMany.mockResolvedValueOnce([{ id: 'transcript-1' }]).mockResolvedValue([]);

    await hooks.purge(USER_ID);

    const noteClearOrder = prisma.note.updateMany.mock.invocationCallOrder[0];
    const transcriptUpdateOrder = prisma.transcript.updateMany.mock.invocationCallOrder[0];
    const purgeOrder = pipeline.enqueuePurge.mock.invocationCallOrder[0];

    expect(noteClearOrder).toBeLessThan(transcriptUpdateOrder);
    expect(transcriptUpdateOrder).toBeLessThan(purgeOrder);
  });

  it('does NOT catch and silently retry a failure in the reference-clearing step — it fails loudly', async () => {
    const { hooks, prisma, pipeline } = harness();

    prisma.transcript.findMany.mockResolvedValueOnce([{ id: 'transcript-1' }]);

    const fkViolation = new Error('simulated foreign key violation');
    prisma.note.updateMany.mockImplementationOnce(() => Promise.reject(fkViolation));

    await expect(hooks.purge(USER_ID)).rejects.toBe(fkViolation);

    // Nothing downstream ran: no soft delete, no purge enqueue.
    expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
    expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
  });

  it('clears sourceTranscriptId with no ownerId scoping at all — a shared transcript can be cited by a stranger\'s note', async () => {
    const { hooks, prisma } = harness();

    prisma.transcript.findMany.mockResolvedValueOnce([{ id: 'transcript-1' }]).mockResolvedValue([]);

    await hooks.purge(USER_ID);

    const clearCall = prisma.note.updateMany.mock.calls.find(
      ([args]: [{ where: Record<string, unknown> }]) => 'sourceTranscriptId' in args.where,
    );

    expect(clearCall).toBeDefined();
    expect(clearCall[0]).toEqual({
      where: { sourceTranscriptId: { in: ['transcript-1'] } },
      data: { sourceTranscriptId: null },
    });
    // No `ownerId` restricting this to the deleting user's own notes — a "fix"
    // that added one would leave a stranger's note pointing at a transcript row
    // that is about to stop existing.
    expect(clearCall[0].where).not.toHaveProperty('ownerId');
  });
});

describe('TranscriptsUserDataHooks — fans out to the per-item purge machinery, deletes no bytes itself', () => {
  it('soft-deletes the batch and hands each transcript to TranscriptPipelineService.enqueuePurge', async () => {
    const { hooks, prisma, pipeline } = harness();

    prisma.transcript.findMany.mockResolvedValueOnce([{ id: 'transcript-1' }]).mockResolvedValue([]);

    await hooks.purge(USER_ID);

    expect(prisma.transcript.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['transcript-1'] } },
      data: { status: 'deleting', deletedAt: expect.any(Date) },
    });
    expect(pipeline.enqueuePurge).toHaveBeenCalledWith('transcript-1');
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'user_data:transcripts_deleted',
          meta: { count: 1 },
        }),
      }),
    );
  });

  it('skips enqueuing a purge for an id a live purge job already covers', async () => {
    const { hooks, prisma, pipeline } = harness();

    prisma.transcript.findMany
      .mockResolvedValueOnce([{ id: 'transcript-1' }, { id: 'transcript-2' }])
      .mockResolvedValue([]);
    prisma.job.findMany.mockResolvedValue([{ subjectId: 'transcript-1' }]);

    await hooks.purge(USER_ID);

    expect(pipeline.enqueuePurge).not.toHaveBeenCalledWith('transcript-1');
    expect(pipeline.enqueuePurge).toHaveBeenCalledWith('transcript-2');
  });

  it('checks purge coverage with ONE job.findMany per batch, against TRANSCRIPT_PURGE_JOB_TYPE / TRANSCRIPT_SUBJECT_TYPE', async () => {
    const { hooks, prisma } = harness();

    prisma.transcript.findMany
      .mockResolvedValueOnce([{ id: 'transcript-1' }, { id: 'transcript-2' }])
      .mockResolvedValue([]);

    await hooks.purge(USER_ID);

    expect(prisma.job.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.job.findMany).toHaveBeenCalledWith({
      where: {
        type: TRANSCRIPT_PURGE_JOB_TYPE,
        subjectType: TRANSCRIPT_SUBJECT_TYPE,
        subjectId: { in: ['transcript-1', 'transcript-2'] },
        status: { in: ['pending', 'running'] },
      },
      select: { subjectId: true },
    });
  });
});

describe('TranscriptsUserDataHooks — the semantic index', () => {
  it('forgets the owner\'s transcript index rows AFTER the delete fan-out', async () => {
    const { hooks, prisma, searchIndex } = harness();

    prisma.transcript.findMany.mockResolvedValueOnce([{ id: 'transcript-1' }]).mockResolvedValue([]);

    await hooks.purge(USER_ID);

    expect(searchIndex.forgetOwnerDocuments).toHaveBeenCalledWith(USER_ID, SEARCH_DOC_TRANSCRIPT);
    expect(prisma.transcript.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      searchIndex.forgetOwnerDocuments.mock.invocationCallOrder[0],
    );
  });

  // Never throws into the purge: the documents are already soft-deleted and
  // queued, and failing a destructive job part-way over a cleanup read would
  // leave the user with a `failed` row and no idea which half ran.
  it('swallows an index failure — the purge still completes', async () => {
    const { hooks, searchIndex } = harness();
    searchIndex.forgetOwnerDocuments.mockRejectedValue(new Error('index is down'));

    await expect(hooks.purge(USER_ID)).resolves.toBeUndefined();
  });
});

describe('TranscriptsUserDataHooks — re-entrancy and the bounded loop', () => {
  it('running purge() twice over partially-completed state finishes the work and does not throw', async () => {
    const { hooks, prisma, pipeline } = harness();

    // One transcript remains from an earlier partial run; once handled it is gone.
    let remaining = [{ id: 'transcript-straggler' }];
    prisma.transcript.findMany.mockImplementation(async () => {
      const batch = remaining;
      remaining = [];
      return batch;
    });

    await expect(hooks.purge(USER_ID)).resolves.toBeUndefined();
    expect(pipeline.enqueuePurge).toHaveBeenCalledWith('transcript-straggler');

    // Second run: everything the database can now see is already gone.
    await expect(hooks.purge(USER_ID)).resolves.toBeUndefined();
    expect(pipeline.enqueuePurge).toHaveBeenCalledTimes(1);
  });

  it('fails loudly, naming the step, when a selected row never stops matching the query', async () => {
    const { hooks, prisma } = harness();

    prisma.transcript.findMany.mockResolvedValue([{ id: 'transcript-stuck' }]);

    await expect(hooks.purge(USER_ID)).rejects.toThrow(
      new RegExp(`did not converge after ${USER_DATA_PURGE_MAX_BATCHES} batches`),
    );

    expect(prisma.transcript.findMany).toHaveBeenCalledTimes(USER_DATA_PURGE_MAX_BATCHES);
  });
});

describe('the `transcripts` declarations', () => {
  it('registers a narrow scope that maps to exactly its own category', () => {
    expect(TRANSCRIPTS_USER_DATA_SCOPE).toMatchObject({
      id: 'transcripts',
      confirmation: 'TRANSCRIPTS',
      categories: ['transcripts'],
    });

    for (const category of ['notes', 'noteTemplates', 'files', 'credentials', 'onboarding', 'graph', 'ask']) {
      expect(userDataScopeReaches('transcripts', category)).toBe(false);
    }
    expect(userDataScopeReaches('transcripts', 'transcripts')).toBe(true);
  });

  it('runs after notes (purge order 50 > 40): a note\'s source_transcript_id is Restrict', () => {
    expect(TRANSCRIPTS_USER_DATA_CATEGORY.purge?.order).toBe(50);
    expect(TRANSCRIPTS_USER_DATA_CATEGORY.summary?.key).toBe('transcripts');
  });

  it('resolves its hooks through the token TranscriptsModule provides', () => {
    expect(TRANSCRIPTS_USER_DATA_CATEGORY.summary?.inject).toBe(TRANSCRIPTS_USER_DATA_HOOKS);
    expect(TRANSCRIPTS_USER_DATA_CATEGORY.purge?.inject).toBe(TRANSCRIPTS_USER_DATA_HOOKS);
  });
});
