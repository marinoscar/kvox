// =============================================================================
// SearchIndexService (issue #188, epic #165) — unit tests
// =============================================================================
//
// Three claims, each of which is a rule stated in the service's own header and
// each of which is cheap to break from a neighbouring file:
//
//   1. the enqueue carries the document as its SUBJECT, so a burst of edits
//      dedups into one run, and runs BEHIND anything a user is watching;
//   2. `skipDedup` is passed through, because the handler's own follow-up
//      enqueue is the one call that must get past its own dedup key;
//   3. `forget` deletes chunks and state, and deliberately does NOT delete
//      embeddings — those cascade from `search_chunks`, and a second
//      hand-maintained copy of that guarantee is the copy that goes wrong.
// =============================================================================

import { SEARCH_DOC_NOTE, SEARCH_DOC_TRANSCRIPT, SEARCH_INDEX_JOB_TYPE } from './job-types';
import { SearchIndexService } from './search-index.service';

const OWNER_ID = 'owner-1';
const DOC_ID = 'doc-1';

function harness() {
  const prisma = {
    searchChunk: { deleteMany: jest.fn(async () => ({ count: 3 })) },
    searchIndexState: {
      deleteMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => [{ documentId: 'a' }, { documentId: 'b' }]),
    },
    searchEmbedding: { deleteMany: jest.fn() },
  };

  const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1' })) };

  return { service: new SearchIndexService(prisma as never, jobs as never), prisma, jobs };
}

describe('SearchIndexService', () => {
  describe('enqueue', () => {
    it('makes the document the job subject, dedups by default, and runs behind the user', async () => {
      const { service, jobs } = harness();

      await service.enqueue(SEARCH_DOC_TRANSCRIPT, DOC_ID);

      expect(jobs.enqueue).toHaveBeenCalledWith({
        type: SEARCH_INDEX_JOB_TYPE,
        reason: 'upload',
        // The same string the chunks are stored under, and the same one every
        // other transcript job already uses for `subject_type`.
        subjectType: 'transcript',
        subjectId: DOC_ID,
        payload: { documentType: 'transcript', documentId: DOC_ID },
        // Positive: never ahead of an export or a transcription somebody is
        // watching, never as far back as the housekeeping sweeps at 100.
        priority: 10,
        skipDedup: false,
      });
    });

    it('passes `skipDedup` through — the handler needs to enqueue past itself', async () => {
      const { service, jobs } = harness();

      await service.enqueue(SEARCH_DOC_NOTE, DOC_ID, 'rerun', { skipDedup: true });

      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'rerun', skipDedup: true }),
      );
    });
  });

  describe('forget', () => {
    it('deletes the chunks and the state row, and leaves the vectors to cascade', async () => {
      const { service, prisma } = harness();

      await service.forget(SEARCH_DOC_NOTE, DOC_ID);

      expect(prisma.searchChunk.deleteMany).toHaveBeenCalledWith({
        where: { documentType: 'note', documentId: DOC_ID },
      });
      expect(prisma.searchIndexState.deleteMany).toHaveBeenCalledWith({
        where: { documentType: 'note', documentId: DOC_ID },
      });

      // ⚠ `SearchEmbedding.chunkId` IS a real foreign key and it cascades.
      // Deleting here too would be a second copy of a guarantee the schema
      // already makes — and the copy is the one that eventually disagrees.
      expect(prisma.searchEmbedding.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('forgetOwnerDocuments', () => {
    it('enumerates through the state rows, which is the only table that knows the owner', async () => {
      const { service, prisma } = harness();

      const count = await service.forgetOwnerDocuments(OWNER_ID, SEARCH_DOC_TRANSCRIPT);

      expect(count).toBe(2);
      expect(prisma.searchIndexState.findMany).toHaveBeenCalledWith({
        where: { ownerId: OWNER_ID, documentType: 'transcript' },
        select: { documentId: true },
      });
      expect(prisma.searchChunk.deleteMany).toHaveBeenCalledWith({
        where: { documentType: 'transcript', documentId: { in: ['a', 'b'] } },
      });
    });

    it('does nothing at all when the owner has no indexed documents of that kind', async () => {
      const { service, prisma } = harness();

      prisma.searchIndexState.findMany.mockResolvedValueOnce([]);

      expect(await service.forgetOwnerDocuments(OWNER_ID, SEARCH_DOC_NOTE)).toBe(0);
      expect(prisma.searchChunk.deleteMany).not.toHaveBeenCalled();
      expect(prisma.searchIndexState.deleteMany).not.toHaveBeenCalled();
    });
  });
});
