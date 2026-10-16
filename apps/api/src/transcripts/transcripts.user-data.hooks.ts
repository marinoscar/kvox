// =============================================================================
// Transcripts' user-data hooks (issue #80; split out by issue #460)
// =============================================================================
//
// The count, byte total and `transcript.purge` fan-out for the `transcripts`
// category. The category and scope declarations are `transcripts.user-data.ts`,
// which is kept light for the manifest; this class is provided by
// `TranscriptsModule` under `TRANSCRIPTS_USER_DATA_HOOKS`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { KvoxManagedObjectsService } from '../kvox-objects/kvox-managed-objects.service';
import { PrismaService } from '../prisma/prisma.service';
import { SEARCH_DOC_TRANSCRIPT } from '../search/indexing/job-types';
import { SearchIndexService } from '../search/indexing/search-index.service';
import {
  auditUserData,
  enqueuePurges,
  USER_DATA_PURGE_BATCH,
  USER_DATA_PURGE_MAX_BATCHES,
} from '../user-data/user-data.support';
import { TRANSCRIPT_PURGE_JOB_TYPE, TRANSCRIPT_SUBJECT_TYPE } from './job-types';
import { TranscriptPipelineService } from './transcript-pipeline.service';

@Injectable()
export class TranscriptsUserDataHooks {
  private readonly logger = new Logger(TranscriptsUserDataHooks.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: TranscriptPipelineService,
    private readonly searchIndex: SearchIndexService,
    private readonly managedObjects: KvoxManagedObjectsService,
  ) {}

  /** `transcripts` in `GET /api/user-data/summary`. */
  async summarize(userId: string): Promise<{ count: number; bytes: string }> {
    const [count, bytes] = await Promise.all([
      this.prisma.transcript.count({ where: { ownerId: userId, deletedAt: null } }),
      this.transcriptBytes(userId),
    ]);

    return { count, bytes };
  }

  /**
   * Bytes of every storage object the caller's live transcripts own.
   *
   * ⚠ ONE AGGREGATE OVER RELATION FILTERS, not five id lists summed in
   * JavaScript. A transcript owns up to five kinds of object and the same row
   * can legitimately be reachable twice (a version snapshot of the version an
   * export was rendered from); summing per-relation totals would double-count
   * it, where a single `OR` over `storage_objects` counts each matching row
   * exactly once because it is one row either way.
   */
  private async transcriptBytes(userId: string): Promise<string> {
    const owned = { ownerId: userId, deletedAt: null };

    const bytes = await this.managedObjects.sumSize({
      OR: [
        { transcriptsAsSource: { some: owned } },
        { transcriptsAsPlayback: { some: owned } },
        { transcriptsAsRawResult: { some: owned } },
        { transcriptVersionSnapshots: { some: { transcript: owned } } },
        { transcriptExportFiles: { some: { transcript: owned } } },
      ],
    });

    return bytes.toString();
  }

  /** The destructive step: the transcripts, then their semantic-index rows. */
  async purge(userId: string): Promise<void> {
    await this.deleteTranscripts(userId);
    await this.forgetFromSearchIndex(userId);
  }

  // ===========================================================================
  // Step 3 — transcripts
  // ===========================================================================

  /**
   * Soft-delete every live transcript this user owns and hand each to
   * `transcript.purge`.
   *
   * ⚠ THE DEPENDENT-NOTE CHECK `TranscriptsService.remove` RUNS IS DELIBERATELY
   * ABSENT, replaced by clearing the pointer it would have refused over.
   */
  private async deleteTranscripts(userId: string): Promise<void> {
    let deleted = 0;

    for (let batch = 0; batch < USER_DATA_PURGE_MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.transcript.findMany({
        where: { ownerId: userId, deletedAt: null },
        select: { id: true },
        take: USER_DATA_PURGE_BATCH,
      });

      if (rows.length === 0) {
        if (deleted > 0) {
          await auditUserData(this.prisma, userId, 'user_data:transcripts_deleted', {
            count: deleted,
          });
        }

        this.logger.log(
          `User ${userId}: ${deleted} transcript(s) soft-deleted and queued for purge`,
        );

        return;
      }

      const ids = rows.map((row) => row.id);

      // ⚠ EVERY NOTE, NOT JUST SURVIVING ONES AND NOT JUST THIS USER'S.
      //
      // Another user's note: it was generated from a transcript they were
      // shared, and it keeps its content and loses its provenance link. That
      // is the deliberate trade described in the handler's header — the owner's
      // right to delete their own recording outranks a stranger's pointer to
      // it, and deleting the stranger's note instead would be far worse.
      //
      // This user's own already-soft-deleted note: it is queued for
      // `note.purge` but its row still exists and still holds the `Restrict`
      // reference, so leaving it would make the two purge jobs race — whichever
      // runs second wins, and the loser is a foreign-key violation in a job
      // list. Clearing removes the race rather than ordering it.
      await this.prisma.note.updateMany({
        where: { sourceTranscriptId: { in: ids } },
        data: { sourceTranscriptId: null },
      });

      await this.prisma.transcript.updateMany({
        where: { id: { in: ids } },
        data: { status: 'deleting', deletedAt: new Date() },
      });

      await enqueuePurges(
        this.prisma,
        ids,
        TRANSCRIPT_PURGE_JOB_TYPE,
        TRANSCRIPT_SUBJECT_TYPE,
        (id) => this.pipeline.enqueuePurge(id),
      );

      deleted += ids.length;
    }

    throw new Error(
      `Bulk transcript deletion for user ${userId} did not converge after ` +
        `${USER_DATA_PURGE_MAX_BATCHES} batches`,
    );
  }

  /**
   * Drop every `search_chunks` / `search_index_state` row for this user's
   * transcripts (#188, epic #165).
   *
   * ⚠ THIS IS NOT REDUNDANT WITH THE FAN-OUT ABOVE. `deleteTranscripts`
   * soft-deletes each document and QUEUES a per-item `transcript.purge`, and
   * that handler calls `SearchIndexService.forget` itself — so on the happy path
   * this call finds nothing left to do. But those jobs run LATER, and a job can
   * exhaust its attempts. A user who pressed a button that said their
   * transcripts would be destroyed must not be left with the TEXT of those
   * transcripts sitting in `search_chunks` because a purge job three hops away
   * gave up quietly. Every transcript owned by this user is on its way out, so
   * deleting all of their index rows now is the same set reached sooner, not a
   * guess. (The notes hook carries the same step and the full argument:
   * `NotesUserDataHooks.forgetFromSearchIndex`.)
   *
   * ⚠ IT DELETES ROWS RATHER THAN FANNING OUT: there are no bytes. A chunk is a
   * row of text and a vector in this database, with no object storage behind it
   * and no provider copy to revoke.
   *
   * ⚠ NOT CALLED FOR THE `files` SCOPE. An uploaded file is not a searchable
   * document in this epic — only transcripts and notes are chunked.
   *
   * Never throws into the purge: the documents are already soft-deleted and
   * queued, and failing a destructive job part-way because a cleanup read lost
   * a race would leave the user with a `failed` row and no idea which half ran.
   * A leftover index row is a storage cost the per-item purge still covers.
   */
  private async forgetFromSearchIndex(userId: string): Promise<void> {
    try {
      const forgotten = await this.searchIndex.forgetOwnerDocuments(
        userId,
        SEARCH_DOC_TRANSCRIPT,
      );

      if (forgotten > 0) {
        this.logger.log(
          `User ${userId}: ${forgotten} ${SEARCH_DOC_TRANSCRIPT}(s) removed from the semantic index`,
        );
      }
    } catch (error) {
      this.logger.error(
        `User ${userId}: could not clear the semantic index for ${SEARCH_DOC_TRANSCRIPT}s: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
