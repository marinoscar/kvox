// =============================================================================
// `transcript.snapshot` (issue #27, epic #19, spec §1.5.5 / §4.3)
// =============================================================================
//
// Writes a gzipped JSON copy of a transcript's materialized state to a managed
// storage object and records it on the version it belongs to, so that
// `materialize()` can answer for that version — and every version after it —
// without replaying a long chain of ops.
//
// -----------------------------------------------------------------------------
// REPEATABLE READ, AND WHY THE VERSION IS READ RATHER THAN TRUSTED
// -----------------------------------------------------------------------------
//
// The job is enqueued with the version that triggered it, but by the time a
// worker claims it a user may have saved again. Reading `current_version` and
// the state in two separate statements would then produce a snapshot LABELLED
// v7 containing v9's segments — a lie that `materialize()` would faithfully
// replay ops on top of, producing a version that never existed.
//
// So the read is one `REPEATABLE READ` transaction over `transcripts`,
// `transcript_speakers` and `transcript_segments` together, and the snapshot is
// attached to whatever version that consistent read ACTUALLY saw. The requested
// version is a hint about when to do the work, never a claim about what the
// work will contain.
//
// The consequence is worth stating plainly: a snapshot enqueued for v1 that
// runs after an edit lands snapshots v2 instead, and v1 then has no snapshot.
// `materialize(1)` answers 409 with an honest message rather than a wrong
// document, and the next snapshot the policy triggers repairs reachability from
// there forward. That is the correct trade — a missing answer is recoverable, a
// plausible wrong one is not.
//
// -----------------------------------------------------------------------------
// IDEMPOTENT, AND SERVER-ONLY
// -----------------------------------------------------------------------------
//
// The queue is at-least-once. A second run finds `snapshot_object_id` already
// set for the version it read and returns without writing anything, and the
// storage key is derived from `(transcriptId, version)` so even a re-run that
// races past that check overwrites the same key with the same bytes.
//
// SERVER-ONLY under CLAUDE.md rule 2's "reads several tables mid-computation"
// exemption: the whole job IS a multi-table consistent read. There is nothing
// for a worker node to compute — no CPU-bound transform, no provider call —
// only rows a node has no connection to.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  KVOX_JOBS,
  KVOX_PRISMA,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
} from '../../ports/index.js';
import type { KvoxTranscriptsDb } from '../data/transcripts-db.js';
import { TRANSCRIPT_SNAPSHOT_JOB_TYPE } from '../job-types.js';
import { TranscriptMaterializeService } from '../transcript-materialize.service.js';
import { TranscriptObjectsService } from '../transcript-objects.service.js';

/**
 * Ten minutes, and at most three attempts (issue #27).
 *
 * A ten-hour transcript is roughly 90,000 words: the read, the `JSON.stringify`
 * and the gzip are seconds, and the upload is the only part that can plausibly
 * stall. Ten minutes is generous for that and still short enough that a wedged
 * snapshot frees its worker slot the same hour. Three attempts because the
 * failure modes are transient (storage unavailable, a serialization conflict on
 * the repeatable read) and none of them is made worse by trying again.
 */
export const SNAPSHOT_MAX_RUNTIME_MS = 10 * 60 * 1000;

/**
 * TranscriptSnapshotHandler: wiring the slice registers itself; a host configures it through `TranscriptsModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class TranscriptSnapshotHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(TranscriptSnapshotHandler.name);

  readonly type = TRANSCRIPT_SNAPSHOT_JOB_TYPE;

  readonly label = 'Transcript snapshot';

  readonly profile: KvoxJobProfile = {
    maxRuntimeMs: SNAPSHOT_MAX_RUNTIME_MS,
    maxAttempts: 3,
  };

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxTranscriptsDb,
    private readonly materialize: TranscriptMaterializeService,
    private readonly objects: TranscriptObjectsService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const transcriptId = readString(job.payload, 'transcriptId');

    if (!transcriptId) {
      this.logger.warn(`Snapshot job ${job.id} names no transcript; nothing to do`);

      return;
    }

    // ------------------------------------------------------------------------
    // ONE consistent read. See the file header.
    // ------------------------------------------------------------------------
    const read = await this.prisma.$transaction(
      async (tx) => {
        const transcript = await tx.transcript.findUnique({
          where: { id: transcriptId },
          select: { id: true, ownerId: true, currentVersion: true, deletedAt: true },
        });

        if (!transcript || transcript.deletedAt !== null || transcript.currentVersion < 1) {
          return null;
        }

        const version = await tx.transcriptVersion.findUnique({
          where: {
            transcriptId_version: {
              transcriptId,
              version: transcript.currentVersion,
            },
          },
          select: { id: true, version: true, snapshotObjectId: true },
        });

        if (!version || version.snapshotObjectId) return null;

        // ⚠ LIVE NAMES, INCLUDING IDENTIFIED ONES (#323). A speaker named
        // "Oscar" without a version is stored as "Oscar" in this snapshot, not
        // as the "Speaker A" a pure replay would give. That is harmless, and
        // deliberately not "corrected": `materialize()` overlays the same name
        // onto the placeholder anyway (the overlay is idempotent), and the
        // speaker's `rev` — the only thing later ops are checked against — is
        // identical either way, because an identification never bumps it.
        const { state } = await this.materialize.loadLiveState(transcriptId, 'all', tx);

        return { transcript, version, state };
      },
      { isolationLevel: 'RepeatableRead', timeout: SNAPSHOT_MAX_RUNTIME_MS },
    );

    if (!read) {
      this.logger.log(
        `Transcript ${transcriptId} needs no snapshot right now (gone, unversioned, or ` +
          'its current version already has one)',
      );

      return;
    }

    const body = this.materialize.serializeSnapshot(transcriptId, read.version.version, read.state);

    // Storage first, row second — `TranscriptObjectsService.put` explains why
    // that order is the one whose failure mode is harmless.
    const object = await this.objects.put({
      storageKey: `transcripts/${transcriptId}/snapshots/v${read.version.version}.json.gz`,
      name: `${transcriptId}-v${read.version.version}.json.gz`,
      mimeType: 'application/gzip',
      body,
      ownerId: read.transcript.ownerId,
      metadata: {
        transcriptId,
        version: read.version.version,
        kind: 'version-snapshot',
        segments: read.state.segments.length,
        speakers: read.state.speakers.length,
      },
    });

    // ⚠ `updateMany` WITH `snapshotObjectId: null` IN THE PREDICATE, not a
    // plain `update`. Two snapshot jobs racing for the same version must not
    // both claim the row — the loser's object is left for the transcript's own
    // purge prefix sweep rather than overwriting a link somebody is already
    // materializing from.
    const claimed = await this.prisma.transcriptVersion.updateMany({
      where: { id: read.version.id, snapshotObjectId: null },
      data: { snapshotObjectId: object.id },
    });

    if (claimed.count === 0) {
      this.logger.warn(
        `Version ${read.version.version} of transcript ${transcriptId} was snapshotted by ` +
          `another run; object ${object.id} is redundant`,
      );

      await this.objects.deleteIfPresent(object.id);

      return;
    }

    this.logger.log(
      `Snapshotted transcript ${transcriptId} v${read.version.version}: ` +
        `${read.state.segments.length} segment(s), ${body.byteLength} gzipped byte(s)`,
    );
  }
}

/** One string field out of a job payload. */
function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const value = (payload as Record<string, unknown>)[key];

  return typeof value === 'string' && value.length > 0 ? value : null;
}
