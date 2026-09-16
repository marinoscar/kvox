// =============================================================================
// `transcript.purge` (issue #25, epic #19, spec §1.5.7 and §10)
// =============================================================================
//
// Removes EVERY byte and EVERY row a deleted transcript ever owned: the
// original upload, the playback rendition, the gzipped raw provider result,
// every version snapshot, every export file, the provider's own copy, and only
// then the SQL rows.
//
// This is the concrete backstop behind the epic's "the user controls the
// truth": control includes the ability to make something disappear completely,
// not merely to hide it from a list.
//
// -----------------------------------------------------------------------------
// OBJECTS FIRST, ROWS LAST — AND THE ORDER IS NOT NEGOTIABLE
// -----------------------------------------------------------------------------
//
// The `transcripts` row is the ONLY index of which storage objects belong to
// this transcript. Deleting it first and then the objects means a crash in
// between orphans multi-gigabyte files with nothing left in the database that
// knows they exist — unattributable bytes an operator can only find by
// guessing at key prefixes. Deleting the objects first means a crash leaves a
// `deleting` transcript whose purge job retries and finishes the work, which is
// why every step below is written to tolerate "already gone".
//
// It is also why `transcripts.source_object_id` is `Restrict` rather than
// `Cascade` (spec §3.1): the foreign key physically prevents the wrong order.
//
// -----------------------------------------------------------------------------
// NO PROFILE
// -----------------------------------------------------------------------------
//
// Deleting a bounded, enumerable set of objects for one transcript does not
// resemble the multi-hour, must-never-auto-retry shape `maxRuntimeMs` and
// `maxAttempts: 1` exist for. The deployment-wide `JOBS_JOB_TIMEOUT_MS` and
// `JOBS_MAX_ATTEMPTS` are the right numbers, and retrying IS the recovery
// strategy here — which only works because the handler is re-entrant.
//
// SERVER-ONLY under rule 3 (`deleteRemote` needs the account API key) and rule
// 2 (it deletes across several tables as it goes).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { SEARCH_DOC_TRANSCRIPT } from '../../search/indexing/job-types';
import { SearchIndexService } from '../../search/indexing/search-index.service';
import { TRANSCRIPT_PURGE_JOB_TYPE } from '../job-types';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { readTranscriptId } from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';

@Injectable()
export class TranscriptPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TranscriptPurgeHandler.name);

  readonly type = TRANSCRIPT_PURGE_JOB_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly objects: TranscriptObjectsService,
    private readonly runtime: TranscriptionRuntimeService,
    private readonly searchIndex: SearchIndexService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const transcriptId = readTranscriptId(job.payload);

    if (!transcriptId) {
      this.logger.warn(`Purge job ${job.id} carries no transcript id; nothing to do`);

      return;
    }

    // ⚠ `findUnique`, NOT the pipeline's `loadForJob`. That helper filters out
    // soft-deleted rows, and a soft-deleted row is EXACTLY what this handler
    // exists to remove.
    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      include: {
        versions: { select: { snapshotObjectId: true } },
        exports: { select: { id: true, objectId: true } },
      },
    });

    if (!transcript) {
      this.logger.log(`Transcript ${transcriptId} is already gone; purge job ${job.id} is a no-op`);

      return;
    }

    // ------------------------------------------------------------------------
    // The provider's own copy, if it still has one.
    // ------------------------------------------------------------------------
    //
    // NEVER FATAL. A vendor that is briefly unavailable must not block the
    // deletion of everything this deployment controls — and the retry, plus
    // `transcripts.housekeeping`, are what keep trying. The alternative
    // (refusing to delete anything until the vendor answers) leaves the audio
    // in this application's own storage too, which is strictly worse for the
    // privacy outcome the deletion was asked for.
    if (transcript.providerJobId && transcript.remoteDeletedAt === null) {
      try {
        const { provider, ctx } = await this.runtime.resolve();

        await provider.deleteRemote(ctx, transcript.providerJobId);

        await this.prisma.transcript.update({
          where: { id: transcript.id },
          data: { remoteDeletedAt: new Date() },
        });
      } catch (error) {
        this.logger.error(
          `Could not delete the provider's copy of transcript ${transcript.id}: ` +
            `${error instanceof Error ? error.message : String(error)}. Continuing with ` +
            'local deletion.',
        );
      }
    }

    // ------------------------------------------------------------------------
    // Every managed object, in one enumerated list.
    // ------------------------------------------------------------------------
    //
    // ENUMERATED FROM THE ROWS rather than swept by key prefix: a prefix sweep
    // would delete whatever happens to sit under `transcripts/<id>/`, which is
    // the right answer only for as long as nothing else ever writes there. The
    // rows are the record of what this transcript owns.
    const derivedObjectIds = [
      transcript.playbackObjectId,
      transcript.rawResultObjectId,
      ...transcript.versions.map((version) => version.snapshotObjectId),
      ...transcript.exports.map((entry) => entry.objectId),
    ].filter((id): id is string => typeof id === 'string');

    let removed = 0;

    for (const objectId of new Set(derivedObjectIds)) {
      // ⚠ THE FOREIGN KEYS MUST BE CLEARED FIRST. Every one of these
      // references is `Restrict`, so the storage row cannot be deleted while
      // something still points at it — which is the protection working exactly
      // as designed, and the reason this handler nulls the references before it
      // asks for the bytes to go.
      await this.clearReferences(transcript.id, objectId);

      if (await this.objects.deleteIfPresent(objectId)) removed += 1;
    }

    // ------------------------------------------------------------------------
    // The rows. `Cascade` takes the children — speakers, segments, versions,
    // shares, exports — so one delete is enough.
    // ------------------------------------------------------------------------
    //
    // ⚠ THE SOURCE OBJECT IS DELETED AFTER THIS ROW, NOT BEFORE, AND THERE IS
    // NO CHOICE ABOUT IT. `transcripts.source_object_id` is NOT NULLABLE and
    // its foreign key is `Restrict`, so the storage row is unreachable for
    // deletion while the transcript exists — the reference cannot be cleared
    // the way every other one above can. That constraint is deliberate (spec
    // §3.1: no unrelated storage cleanup may ever remove a file a transcript
    // still depends on), and its cost is exactly this ordering.
    //
    // The failure window it opens is the harmless one: a crash between these
    // two statements leaves one orphaned storage object with no row referencing
    // it, which `transcripts.housekeeping` is not asked to find and which costs
    // storage rather than correctness. The opposite order is not available, and
    // would trade that for a `Restrict` violation on every purge.
    const sourceObjectId = transcript.sourceObjectId;

    // ------------------------------------------------------------------------
    // The semantic index (#188, epic #165). BEFORE the row, and not by accident.
    // ------------------------------------------------------------------------
    //
    // ⚠ NOTHING ELSE WILL EVER CLEAN THESE UP. `search_chunks.document_id` and
    // `search_index_state.document_id` carry NO FOREIGN KEY — the same
    // polymorphic-reference choice `Job.subjectType`/`subjectId` makes, for the
    // same reason — so deleting the transcript fires no cascade here, and there
    // is deliberately no `search.housekeeping` cron to come along later and
    // notice. The pgvector migration's header names THIS handler as the owner
    // of the sweep; this call is that promise being kept.
    //
    // Before the delete rather than after, because a crash between the two must
    // not be able to leave chunks of a conversation that no longer exists: the
    // only way back to them would be a `document_id` nothing in the database
    // still names. The opposite ordering has no upside — there is no constraint
    // between the two statements in either direction.
    //
    // (`search_embeddings` is not named: it cascades from `search_chunks`,
    // which IS a real foreign key inside that module's own tables.)
    await this.searchIndex.forget(SEARCH_DOC_TRANSCRIPT, transcript.id);

    await this.prisma.transcript.delete({ where: { id: transcript.id } });

    if (await this.objects.deleteIfPresent(sourceObjectId)) removed += 1;

    this.logger.log(
      `Purged transcript ${transcript.id}: ${removed} storage object(s) and every row`,
    );
  }

  /**
   * Null out every reference to `objectId` so the `Restrict` foreign keys let
   * the storage row go.
   *
   * `updateMany`, not `update`, so a reference that has already been cleared
   * by a previous, partially-completed run is a no-op rather than a throw —
   * this handler's whole recovery strategy is being safe to run twice.
   */
  private async clearReferences(transcriptId: string, objectId: string): Promise<void> {
    await this.prisma.transcript.updateMany({
      where: { id: transcriptId, playbackObjectId: objectId },
      data: { playbackObjectId: null },
    });

    await this.prisma.transcript.updateMany({
      where: { id: transcriptId, rawResultObjectId: objectId },
      data: { rawResultObjectId: null },
    });

    await this.prisma.transcriptVersion.updateMany({
      where: { transcriptId, snapshotObjectId: objectId },
      data: { snapshotObjectId: null },
    });

    await this.prisma.transcriptExport.updateMany({
      where: { transcriptId, objectId },
      data: { objectId: null },
    });

    // ⚠ `source_object_id` IS DELIBERATELY ABSENT FROM THIS METHOD. It is not
    // nullable, so it cannot be cleared; `process` deletes the transcript row
    // first and the source object second for exactly that reason.
  }
}
