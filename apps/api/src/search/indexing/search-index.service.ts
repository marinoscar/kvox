import { Injectable, Logger } from '@nestjs/common';
import type { JobReason } from '@prisma/client';

import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SEARCH_INDEX_JOB_TYPE,
  type SearchDocumentType,
} from './job-types';

// =============================================================================
// The enqueue-and-forget surface of the semantic index (issue #188, epic #165)
// =============================================================================
//
// Two verbs, and the whole reason this is a service rather than four call sites
// each doing the obvious thing:
//
//   • `enqueue(type, id)`   — this document's content moved; index it.
//   • `forget(type, id)`    — this document is gone; its rows must go with it.
//
// -----------------------------------------------------------------------------
// WHY `forget` EXISTS AT ALL, AND WHO OWES IT
// -----------------------------------------------------------------------------
//
// `search_chunks.document_id` and `search_index_state.document_id` carry NO
// FOREIGN KEY, in either direction. That is the same polymorphic-reference
// choice `Job.subjectType`/`subjectId` makes, for the same reason (the set of
// searchable document types is open-ended and code-owned), and the pgvector
// migration's header states its cost in one sentence: AN ORPHAN ROW IS
// POSSIBLE, and the deleting document's own purge handler owes the sweep.
// Nothing else will ever clean these up — there is no cascade to fire, and the
// deliberately absent `search.housekeeping` cron (see `job-types.ts`) is not
// going to come along later and notice.
//
// So `transcript.purge`, `note.purge` and `user.data.purge` call this, and this
// method is where the two-table delete lives so those three cannot drift into
// three subtly different sweeps.
//
// ⚠ `search_embeddings` IS NOT DELETED HERE, AND ITS ABSENCE IS CORRECT.
// `SearchEmbedding.chunkId` IS a real foreign key — it points INSIDE this
// module's own table rather than sideways into another module's — and it
// CASCADES. Deleting the chunks takes the vectors with them at the database
// level. Adding a `searchEmbedding.deleteMany` beside it would be a second,
// hand-maintained copy of a guarantee the schema already makes, and the copy is
// the one that would eventually be wrong.
// =============================================================================

@Injectable()
export class SearchIndexService {
  private readonly logger = new Logger(SearchIndexService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Enqueue
  // ---------------------------------------------------------------------------

  /**
   * Queue a re-index of one document.
   *
   * ⚠ NO `JobHandlerRegistry.get(...)` GUARD, UNLIKE `TranscriptPipelineService
   * .enqueueTranscode`/`enqueueSnapshot`, and the difference is structural
   * rather than an oversight. Those two guard because #25 declared their type
   * strings and #26/#27 registered the handlers — an intermediate build could
   * legitimately enqueue a type no worker could claim, which sits `pending`
   * forever as a permanent backlog of one in the admin job list. Here the
   * handler and this service are providers of the SAME module: a build that can
   * inject `SearchIndexService` has `SearchIndexHandler` registered, so the
   * guard would be dead code testing a state Nest cannot produce.
   *
   * ⚠ DEDUP IS LEFT ON, AND THE RACE IT OPENS IS CLOSED IN THE HANDLER, NOT
   * HERE. `(type, subjectType, subjectId)` deduplicates against any earlier job
   * that is still `pending` OR `running`, which is exactly what should happen to
   * a burst of ten corrections in ten seconds: one index run, over the final
   * text. But it also means an edit landing while a run is mid-flight is
   * collapsed onto a job that has already read the older content — the edit
   * would then never be indexed, with nothing anywhere reporting it. The
   * handler re-reads the document's revision after it settles and queues a
   * follow-up (with `skipDedup: true`, which is the only way to enqueue past
   * ONESELF) when it moved. See `SearchIndexHandler.process`'s closing section;
   * `TranscriptPipelineService.enqueuePoll` is the same trap written down.
   */
  async enqueue(
    documentType: SearchDocumentType,
    documentId: string,
    reason: JobReason = 'upload',
    options: { skipDedup?: boolean } = {},
  ): Promise<void> {
    await this.jobs.enqueue({
      type: SEARCH_INDEX_JOB_TYPE,
      reason,
      // The document IS the subject, and the subject type string is the same
      // one the chunks are stored under — see `SEARCH_DOC_TRANSCRIPT`.
      subjectType: documentType,
      subjectId: documentId,
      payload: { documentType, documentId },
      // ⚠ BEHIND THE READER, NOT IN FRONT OF THEM. `transcript.export` runs at
      // −10 because somebody is watching a spinner; indexing is the opposite
      // kind of work — nobody is waiting for it, and a document that becomes
      // semantically searchable a minute later than it might have has cost
      // nobody anything. A positive priority keeps it from queueing ahead of an
      // export or a transcription the user is actually looking at, without
      // putting it behind the housekeeping sweeps at 100.
      priority: 10,
      skipDedup: options.skipDedup ?? false,
    });
  }

  // ---------------------------------------------------------------------------
  // Forget
  // ---------------------------------------------------------------------------

  /**
   * Remove every search row belonging to one document.
   *
   * IDEMPOTENT BY CONSTRUCTION (`deleteMany`, never `delete`), because every
   * caller is a purge handler whose whole recovery strategy is being safe to
   * run twice.
   *
   * ORDER: chunks first, state second. Neither delete depends on the other —
   * there is no foreign key between them — so the order is not a correctness
   * requirement but it is not arbitrary either: a crash between the two leaves
   * a `search_index_state` row saying "indexed, N chunks" for a document with
   * no chunks, which is legible as a bug. The opposite order leaves chunks with
   * no state row, which is indistinguishable from a document mid-index.
   */
  async forget(documentType: SearchDocumentType, documentId: string): Promise<void> {
    // Vectors go with the chunks via `SearchEmbedding.chunkId`'s cascade — see
    // the file header for why they are not deleted explicitly.
    const chunks = await this.prisma.searchChunk.deleteMany({
      where: { documentType, documentId },
    });

    const state = await this.prisma.searchIndexState.deleteMany({
      where: { documentType, documentId },
    });

    if (chunks.count > 0 || state.count > 0) {
      this.logger.log(
        `Forgot ${documentType} ${documentId} from the semantic index: ` +
          `${chunks.count} chunk(s), ${state.count} state row(s)`,
      );
    }
  }

  /**
   * Remove every search row for every document of one kind owned by one user.
   *
   * The bulk counterpart of {@link forget}, for `user.data.purge`. It exists
   * because that job's per-item fan-out is not, on its own, a complete answer:
   * it soft-deletes each document and queues a `transcript.purge`/`note.purge`
   * that will call `forget`, but those jobs run LATER and may themselves fail
   * and exhaust their attempts. A user who pressed the button that says their
   * transcripts will be destroyed should not be left with the text of those
   * transcripts sitting in `search_chunks` because a purge job three hops away
   * gave up. Every document of this kind owned by this user is being destroyed,
   * so deleting all of their rows here is not a heuristic — it is the same set,
   * reached sooner.
   *
   * ⚠ IT ENUMERATES THROUGH `search_index_state`, WHICH IS THE ONLY TABLE THAT
   * KNOWS THE OWNER. `search_chunks` carries no `owner_id` (the state row is
   * the per-document legibility surface; the chunk row is content), so there is
   * no single `deleteMany` that can express this. A document with chunks and no
   * state row is therefore NOT reached here — a state that only exists between
   * the two statements of a crashed `forget`, and one the per-item purge fan-out
   * still covers.
   */
  async forgetOwnerDocuments(
    ownerId: string,
    documentType: SearchDocumentType,
  ): Promise<number> {
    const states = await this.prisma.searchIndexState.findMany({
      where: { ownerId, documentType },
      select: { documentId: true },
    });

    if (states.length === 0) return 0;

    const documentIds = states.map((state) => state.documentId);

    await this.prisma.searchChunk.deleteMany({
      where: { documentType, documentId: { in: documentIds } },
    });

    await this.prisma.searchIndexState.deleteMany({
      where: { ownerId, documentType },
    });

    this.logger.log(
      `Forgot ${documentIds.length} ${documentType}(s) owned by ${ownerId} from the semantic index`,
    );

    return documentIds.length;
  }
}
