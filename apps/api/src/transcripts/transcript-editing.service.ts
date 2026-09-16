// =============================================================================
// The correction write path (issue #27, epic #19, spec §4–§5)
// =============================================================================
//
// "AI proposes. The user controls the truth." This is the half of that sentence
// the user holds: one endpoint that applies a batch of ops, records it as a
// version, and never loses what was there before.
//
// -----------------------------------------------------------------------------
// THE SHAPE OF ONE SAVE, AND WHY THE STEPS ARE IN THIS ORDER
// -----------------------------------------------------------------------------
//
//  1. **Idempotency first.** A repeated `clientBatchId` returns the ORIGINAL
//     result before anything is computed. A client that saved successfully but
//     never saw the response (a dropped connection, a backgrounded tab) must not
//     be charged a second version for pressing retry.
//
//  2. **Expand `transcript.find_replace` OUTSIDE the transaction.** It is the
//     only op that has to read every segment's text, and doing it inside the
//     write transaction would hold a row lock across that read. Doing it outside
//     is not a correctness compromise: the expansion stamps each op with the
//     `rev` it saw, and step 4 checks those revs inside the transaction — so a
//     segment that changed in between produces an honest 409 rather than a
//     silent overwrite.
//
//  3. **Bump `current_version` FIRST, conditionally.** `UPDATE … WHERE
//     current_version = $n` is both the version allocator and the lock: the
//     second of two racing batches blocks on that row until the first commits,
//     then sees `count === 0` and is retried from the top against the state the
//     winner produced. That is what makes "two editors changing different
//     segments both succeed" true — the retry's rev checks still pass, because
//     the winner touched other rows.
//
//  4. **Apply, diff, write.** The reducers produce a whole next state; the diff
//     turns it into the few rows that actually moved (see
//     `editing/state-diff.ts`).
//
//  5. **Enqueue the snapshot AFTER the commit** (CLAUDE.md rule 1). Never
//     inline: gzipping a ten-hour transcript is not work to do while somebody
//     waits for a typo correction to save.
//
// -----------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT LOCKED
// -----------------------------------------------------------------------------
//
// There is no `SELECT … FOR UPDATE` over the segment table, and there must not
// be. Spec §5's whole design is per-entity optimistic concurrency: the `rev` on
// each row IS the check, and it is checked inside the same transaction that
// writes. Pessimistically locking six thousand segments so that one word could
// be corrected would serialise every editor on a shared transcript behind every
// other one — the exact cost the optimistic scheme exists to avoid.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ApplyOperationsDto,
  RestoreVersionDto,
  TranscriptSearchQueryDto,
  TranscriptVersionsQueryDto,
} from './dto/transcript-editing.dto';
import { MAX_SEARCH_MATCHES } from './dto/transcript-editing.dto';
import {
  OP_TYPES,
  OpError,
  applyOps,
  countStateWords,
  diffState,
  findMatches,
  isAuditableBatch,
  matchPreview,
  replaceMatches,
  requiredWordSegmentIds,
  shouldSnapshot,
  sortForRead,
  summarizeOps,
  wordIndexAtCharOffset,
  type EditableSegment,
  type EditingState,
  type FindReplaceSummaryInput,
  type MergeUndoRecord,
  type OpConflict,
  type RecordedOp,
  type RequestOp,
  type StateDiff,
} from './editing';
import { TranscriptAccessService } from './transcript-access.service';
import { TranscriptMaterializeService } from './transcript-materialize.service';
import { TranscriptPipelineService } from './transcript-pipeline.service';

/**
 * The most concrete ops one `transcript.find_replace` batch may expand to.
 *
 * A replacement across a ten-hour transcript can legitimately touch thousands
 * of lines, and every one of them is recorded as a `segment.update_text` op
 * carrying the segment's FULL new text (spec §4.2 — the expansion is what makes
 * replay safe forever). Past this point the version row stops being a record of
 * an edit and becomes a copy of the document, so the request is refused with an
 * answer the user can act on — narrow it by speaker, or use a longer search
 * term — rather than silently writing a multi-megabyte version.
 */
export const MAX_EXPANDED_OPS = 5_000;

/** How many times a losing batch re-reads and re-applies before giving up. */
export const VERSION_RACE_RETRIES = 5;

/** Rows per statement when a merge re-points a large speaker. */
const REPOINT_CHUNK = 1_000;

/** The batch lost the `current_version` race and should be re-applied. */
class VersionRaceError extends Error {}

/** The batch found stale revs. Carries the whole 409 body (spec §5). */
class BatchConflictError extends Error {
  constructor(
    readonly currentVersion: number,
    readonly conflicts: OpConflict[],
  ) {
    super('This transcript changed while you were editing');
  }
}

/** What one applied batch produced. */
export interface OperationsResult {
  version: number;
  summary: string;
  idempotentReplay: boolean;
  speakers: Array<{
    id: string;
    label: string | null;
    displayName: string;
    colorIndex: number;
    rev: number;
  }>;
  segments: Array<{
    id: string;
    speakerId: string;
    startMs: number;
    endMs: number;
    ordinal: number;
    text: string;
    wordsAlignment: string;
    confidence: number | null;
    origin: string;
    rev: number;
    editedAt: string | null;
  }>;
  merges: MergeUndoRecord[];
}

@Injectable()
export class TranscriptEditingService {
  private readonly logger = new Logger(TranscriptEditingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TranscriptAccessService,
    private readonly materialize: TranscriptMaterializeService,
    private readonly pipeline: TranscriptPipelineService,
  ) {}

  // ===========================================================================
  // POST /api/transcripts/:id/operations
  // ===========================================================================

  async applyOperations(
    id: string,
    dto: ApplyOperationsDto,
    user: RequestUser,
  ): Promise<OperationsResult> {
    const { transcript } = await this.access.require(user.id, id, 'edit', user.permissions);

    if (transcript.currentVersion < 1) {
      throw new ConflictException(
        'This transcript has no transcript yet — wait for transcription to finish before ' +
          'correcting it',
      );
    }

    // ---- 1. Idempotency, before anything else is computed -------------------
    const replay = await this.findBatch(transcript.id, dto.clientBatchId);

    if (replay) return this.replayResult(transcript.id, replay);

    // ---- 2. Expansion, outside the transaction ------------------------------
    const expanded = await this.expand(transcript.id, dto.ops);

    if (expanded.ops.length === 0) {
      // A find & replace that matched nothing, and nothing else in the batch.
      // Recording an empty version would put a no-op in the history a restore
      // could later "undo" into nothing.
      return this.currentResult(transcript.id, transcript.currentVersion, 'No changes');
    }

    // ---- 3-5. The write, retried past a lost version race --------------------
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0) {
        // Somebody may have committed THIS VERY BATCH while we were losing the
        // race — two tabs of the same client, or a retry that overlapped the
        // original. Re-checking before re-applying turns that into the
        // idempotent answer instead of a conflict against our own write.
        const raced = await this.findBatch(transcript.id, dto.clientBatchId);

        if (raced) return this.replayResult(transcript.id, raced);
      }

      try {
        const saved = await this.saveBatch(transcript.id, user, dto, expanded);

        await this.afterCommit(transcript.id, saved, expanded, user);

        return saved.result;
      } catch (error) {
        if (error instanceof VersionRaceError && attempt < VERSION_RACE_RETRIES) {
          this.logger.debug(
            `Batch ${dto.clientBatchId} lost the version race on transcript ${transcript.id}; ` +
              `re-applying (attempt ${attempt + 2})`,
          );
          continue;
        }

        if (error instanceof VersionRaceError) {
          throw new ConflictException(
            'This transcript is being edited too quickly by too many people; please retry',
          );
        }

        if (error instanceof BatchConflictError) {
          // ⚠ CHECK IDEMPOTENCY BEFORE REPORTING A CONFLICT. A concurrent,
          // IDENTICAL batch that committed just before this transaction read
          // the state leaves every one of its ops naming a rev this batch's
          // own twin has already bumped — which looks exactly like a stale
          // client and is in fact this client's own successful save. Reporting
          // 409 there would tell a caller their save failed moments after it
          // succeeded, and a well-behaved client would then re-fetch and
          // re-apply the SAME edit a second time.
          const original = await this.findBatch(transcript.id, dto.clientBatchId);

          if (original) return this.replayResult(transcript.id, original);

          // ⚠ UNDER `details`, NOT AT THE TOP LEVEL. Spec §5 draws the body as
          // `{ currentVersion, conflicts }`, but this API's global
          // `HttpExceptionFilter` owns the envelope — it publishes `{ statusCode,
          // code, message, details }` as the `default` error response on every
          // operation in the OpenAPI document, reads only those keys, and drops
          // everything else. A top-level payload here would therefore reach the
          // client as a bare "An unexpected error occurred" with the conflict
          // list silently deleted. `details` is where endpoint-specific,
          // machine-readable data belongs (see that filter's own header), so the
          // spec's object travels there intact.
          throw new ConflictException({
            message: error.message,
            details: { currentVersion: error.currentVersion, conflicts: error.conflicts },
          });
        }

        if (error instanceof OpError) throw new BadRequestException(error.message);

        // A concurrent, IDENTICAL batch won the unique `(transcript_id,
        // client_batch_id)` race. That is the idempotency guarantee arriving
        // from the database instead of from the read above, and the answer is
        // the same: return the version that batch created.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const original = await this.findBatch(transcript.id, dto.clientBatchId);

          if (original) return this.replayResult(transcript.id, original);
        }

        throw error;
      }
    }
  }

  // ===========================================================================
  // GET /api/transcripts/:id/search
  // ===========================================================================

  async search(id: string, query: TranscriptSearchQueryDto, user: RequestUser) {
    const { transcript } = await this.access.require(user.id, id, 'view');

    const segments = await this.prisma.transcriptSegment.findMany({
      where: {
        transcriptId: transcript.id,
        ...(query.speakerId ? { speakerId: query.speakerId } : {}),
      },
      orderBy: [{ startMs: 'asc' }, { ordinal: 'asc' }],
      select: { id: true, speakerId: true, startMs: true, text: true },
    });

    const limit = query.limit ?? MAX_SEARCH_MATCHES;
    const options = { matchCase: query.matchCase, wholeWord: query.wholeWord };

    const matches: Array<{
      segmentId: string;
      speakerId: string;
      startMs: number;
      start: number;
      end: number;
      preview: string;
    }> = [];

    let total = 0;
    let segmentCount = 0;

    for (const segment of segments) {
      const hits = findMatches(segment.text, query.q, options);

      if (hits.length === 0) continue;

      total += hits.length;
      segmentCount += 1;

      for (const hit of hits) {
        // ⚠ The counting continues past the display limit on purpose. A find &
        // replace preview that said "50 matches" when the replacement will
        // rewrite 900 lines would be worse than no preview at all.
        if (matches.length >= limit) continue;

        matches.push({
          segmentId: segment.id,
          speakerId: segment.speakerId,
          startMs: segment.startMs,
          start: hit.start,
          end: hit.end,
          preview: matchPreview(segment.text, hit),
        });
      }
    }

    return {
      q: query.q,
      matchCase: query.matchCase,
      wholeWord: query.wholeWord,
      speakerId: query.speakerId ?? null,
      total,
      segmentCount,
      truncated: matches.length < total,
      matches,
    };
  }

  // ===========================================================================
  // GET /api/transcripts/:id/versions
  // ===========================================================================

  async listVersions(id: string, query: TranscriptVersionsQueryDto, user: RequestUser) {
    const { transcript } = await this.access.require(user.id, id, 'view');

    const limit = query.limit ?? 20;
    const cursor = decodeVersionCursor(query.cursor);

    const rows = await this.prisma.transcriptVersion.findMany({
      where: {
        transcriptId: transcript.id,
        ...(cursor === null ? {} : { version: { lt: cursor } }),
      },
      orderBy: { version: 'desc' },
      take: limit + 1,
      select: {
        version: true,
        kind: true,
        summary: true,
        restoredFromVersion: true,
        snapshotObjectId: true,
        ops: true,
        createdAt: true,
        author: { select: { id: true, name: true, email: true } },
      },
    });

    const page = rows.slice(0, limit);

    return {
      currentVersion: transcript.currentVersion,
      items: page.map((row) => ({
        version: row.version,
        kind: row.kind,
        summary: row.summary,
        author: row.author
          ? { id: row.author.id, name: row.author.name, email: row.author.email }
          : null,
        restoredFromVersion: row.restoredFromVersion,
        hasSnapshot: row.snapshotObjectId !== null,
        opCount: Array.isArray(row.ops) ? row.ops.length : 0,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit ? encodeVersionCursor(page[page.length - 1].version) : null,
    };
  }

  // ===========================================================================
  // GET /api/transcripts/:id/versions/:v
  // ===========================================================================

  async getVersion(id: string, version: number, user: RequestUser) {
    const { transcript } = await this.access.require(user.id, id, 'view');

    const row = await this.prisma.transcriptVersion.findUnique({
      where: { transcriptId_version: { transcriptId: transcript.id, version } },
      select: {
        version: true,
        kind: true,
        summary: true,
        restoredFromVersion: true,
        snapshotObjectId: true,
        ops: true,
        createdAt: true,
        author: { select: { id: true, name: true, email: true } },
      },
    });

    if (!row) {
      // A 404 here is unambiguous and leaks nothing: the access check above
      // already established that this caller may read this transcript, so the
      // only thing left to say is that the version number is not one of its.
      throw new NotFoundException(`Version ${version} does not exist for this transcript`);
    }

    const { state } = await this.materialize.materialize(transcript.id, version);

    return {
      version: row.version,
      kind: row.kind,
      summary: row.summary,
      author: row.author
        ? { id: row.author.id, name: row.author.name, email: row.author.email }
        : null,
      restoredFromVersion: row.restoredFromVersion,
      hasSnapshot: row.snapshotObjectId !== null,
      opCount: Array.isArray(row.ops) ? row.ops.length : 0,
      createdAt: row.createdAt.toISOString(),
      currentVersion: transcript.currentVersion,
      speakers: [...state.speakers].sort((a, b) => a.colorIndex - b.colorIndex),
      segments: sortForRead(state.segments).map((segment) => segmentShape(segment, null)),
    };
  }

  // ===========================================================================
  // POST /api/transcripts/:id/versions/:v/restore
  // ===========================================================================

  async restore(
    id: string,
    version: number,
    dto: RestoreVersionDto,
    user: RequestUser,
  ): Promise<OperationsResult> {
    const { transcript } = await this.access.require(user.id, id, 'edit', user.permissions);

    if (dto.baseVersion !== transcript.currentVersion) {
      // See `restoreVersionSchema`'s own note: unlike an op batch, a restore
      // carries no per-entity expectations, so a stale view means asking to
      // discard edits the caller has never seen.
      throw new ConflictException({
        message:
          `This transcript is at version ${transcript.currentVersion}; you were looking at ` +
          `version ${dto.baseVersion}. Reload and try again.`,
        details: { currentVersion: transcript.currentVersion, conflicts: [] },
      });
    }

    if (version === transcript.currentVersion) {
      throw new ConflictException('That version is already the current one');
    }

    // Materialized OUTSIDE the transaction — it may download and un-gzip a
    // snapshot, and holding the transcript row locked across object storage is
    // exactly the shape CLAUDE.md rule 1 exists to prevent.
    const target = await this.materialize.materialize(transcript.id, version);

    const nextVersion = transcript.currentVersion + 1;
    const summary = `Restored version ${version}`;

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const bumped = await tx.transcript.updateMany({
            where: { id: transcript.id, currentVersion: transcript.currentVersion },
            data: { currentVersion: nextVersion },
          });

          if (bumped.count === 0) throw new VersionRaceError();

          // ⚠ SEGMENTS BEFORE SPEAKERS, ALWAYS. `transcript_segments.speaker_id`
          // is `onDelete: Restrict` (spec §3.3), so a speaker with segments
          // still pointing at it cannot be deleted — which is the schema
          // enforcing the ordering rather than this code remembering it.
          await tx.transcriptSegment.deleteMany({ where: { transcriptId: transcript.id } });
          await tx.transcriptSpeaker.deleteMany({ where: { transcriptId: transcript.id } });

          await tx.transcriptSpeaker.createMany({
            data: target.state.speakers.map((speaker) => ({
              id: speaker.id,
              transcriptId: transcript.id,
              label: speaker.label,
              displayName: speaker.displayName,
              colorIndex: speaker.colorIndex,
              rev: speaker.rev,
            })),
          });

          await tx.transcriptSegment.createMany({
            data: target.state.segments.map((segment) => ({
              id: segment.id,
              transcriptId: transcript.id,
              speakerId: segment.speakerId,
              startMs: segment.startMs,
              endMs: segment.endMs,
              ordinal: segment.ordinal,
              text: segment.text,
              words: segment.words as unknown as Prisma.InputJsonValue,
              wordsAlignment: segment.wordsAlignment,
              confidence: segment.confidence,
              origin: segment.origin,
              rev: segment.rev,
              editedById: user.id,
              editedAt: new Date(),
            })),
          });

          await tx.transcriptVersion.create({
            data: {
              transcriptId: transcript.id,
              version: nextVersion,
              kind: 'restore',
              authorId: user.id,
              summary,
              ops: [
                { op: OP_TYPES.RESTORE, fromVersion: version },
              ] as unknown as Prisma.InputJsonValue,
              restoredFromVersion: version,
            },
          });

          await tx.transcript.update({
            where: { id: transcript.id },
            data: {
              speakerCount: target.state.speakers.length,
              wordCount: countStateWords(target.state),
            },
          });
        },
        { timeout: 60_000 },
      );
    } catch (error) {
      // Somebody saved between the access check and the swap. A restore has no
      // per-entity expectations to fall back on, so the only honest answer is
      // the same one a stale `baseVersion` gets: reload and decide again.
      if (error instanceof VersionRaceError) {
        throw new ConflictException(
          'This transcript changed while the restore was being prepared. Reload and try again.',
        );
      }

      throw error;
    }

    // Restores ALWAYS snapshot (spec §4.3) — they are one of the two versions a
    // user is most likely to return to.
    await this.pipeline.enqueueSnapshot(transcript.id, nextVersion);

    // A restore REPLACES the live segments with an older version's, so the text
    // a search should match changed exactly as much as an ordinary edit changed
    // it (#188). The job sorts out how much of it actually moved.
    await this.pipeline.enqueueSearchIndex(transcript.id);

    await this.audit(user.id, 'transcript.version_restored', transcript.id, {
      restoredFromVersion: version,
      version: nextVersion,
    });

    this.logger.log(
      `Transcript ${transcript.id} restored to v${version} as v${nextVersion} by ${user.id}`,
    );

    const now = new Date().toISOString();

    return {
      version: nextVersion,
      summary,
      idempotentReplay: false,
      speakers: [...target.state.speakers].sort((a, b) => a.colorIndex - b.colorIndex),
      segments: sortForRead(target.state.segments).map((segment) => segmentShape(segment, now)),
      merges: [],
    };
  }

  // ===========================================================================
  // The write itself
  // ===========================================================================

  private async saveBatch(
    transcriptId: string,
    user: RequestUser,
    dto: ApplyOperationsDto,
    expanded: ExpandedBatch,
  ): Promise<{ result: OperationsResult; version: number; kind: 'edit' }> {
    const wordsNeeded = requiredWordSegmentIds(expanded.ops);

    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.transcript.findUnique({
          where: { id: transcriptId },
          select: { currentVersion: true },
        });

        if (!row) throw new VersionRaceError();

        const nextVersion = row.currentVersion + 1;

        // ⚠ THE BUMP IS THE LOCK. See the file header, step 3.
        const bumped = await tx.transcript.updateMany({
          where: { id: transcriptId, currentVersion: row.currentVersion },
          data: { currentVersion: nextVersion },
        });

        if (bumped.count === 0) throw new VersionRaceError();

        const { state: before, editedAt } = await this.materialize.loadLiveState(
          transcriptId,
          wordsNeeded,
          tx,
        );

        const applied = applyOps(before, expanded.ops, { mode: 'live' });

        if (applied.conflicts.length > 0) {
          throw new BatchConflictError(row.currentVersion, applied.conflicts);
        }

        const diff = diffState(before, applied.state);
        const now = new Date();

        await this.persist(tx, transcriptId, diff, user.id, now);

        const speakerNames = new Map(
          applied.state.speakers.map((speaker) => [speaker.id, speaker.displayName]),
        );
        const summary = summarizeOps(expanded.ops, {
          findReplace: expanded.findReplace,
          speakerNames,
        });

        await tx.transcriptVersion.create({
          data: {
            transcriptId,
            version: nextVersion,
            kind: 'edit',
            authorId: user.id,
            summary,
            ops: expanded.ops as unknown as Prisma.InputJsonValue,
            clientBatchId: dto.clientBatchId,
          },
        });

        await tx.transcript.update({
          where: { id: transcriptId },
          data: {
            speakerCount: applied.state.speakers.length,
            wordCount: countStateWords(applied.state),
          },
        });

        const changed = new Set<string>([
          ...diff.segmentsCreated.map((segment) => segment.id),
          ...diff.segmentsUpdated.map((segment) => segment.id),
        ]);

        return {
          version: nextVersion,
          kind: 'edit' as const,
          result: {
            version: nextVersion,
            summary,
            idempotentReplay: false,
            speakers: [...applied.state.speakers].sort((a, b) => a.colorIndex - b.colorIndex),
            segments: sortForRead(applied.state.segments).map((segment) =>
              segmentShape(
                segment,
                changed.has(segment.id)
                  ? now.toISOString()
                  : (editedAt.get(segment.id)?.toISOString() ?? null),
              ),
            ),
            merges: applied.merges,
          },
        };
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Turn a diff into statements.
   *
   * ⚠ THE MERGE FAST PATH IS NOT A MICRO-OPTIMISATION. A `speaker.merge` on a
   * busy speaker re-points thousands of segments, each with an identical change
   * (`speaker_id`, and `rev` incremented). One `UPDATE … WHERE id IN (…)` per
   * thousand rows is the difference between a merge that returns in
   * milliseconds and one that issues six thousand round trips over a single
   * pooled connection while holding the transcript row locked.
   */
  private async persist(
    tx: Prisma.TransactionClient,
    transcriptId: string,
    diff: StateDiff,
    editorId: string,
    now: Date,
  ): Promise<void> {
    if (diff.speakersCreated.length > 0) {
      await tx.transcriptSpeaker.createMany({
        data: diff.speakersCreated.map((speaker) => ({
          id: speaker.id,
          transcriptId,
          label: speaker.label,
          displayName: speaker.displayName,
          colorIndex: speaker.colorIndex,
          rev: speaker.rev,
        })),
      });
    }

    for (const { id, patch } of diff.speakersUpdated) {
      await tx.transcriptSpeaker.update({ where: { id }, data: patch });
    }

    const repoints = new Map<string, string[]>();
    const individual: typeof diff.segmentsUpdated = [];

    for (const update of diff.segmentsUpdated) {
      const keys = Object.keys(update.patch).sort();

      if (keys.length === 2 && keys[0] === 'rev' && keys[1] === 'speakerId') {
        const speakerId = update.patch.speakerId as string;

        repoints.set(speakerId, [...(repoints.get(speakerId) ?? []), update.id]);
      } else {
        individual.push(update);
      }
    }

    for (const [speakerId, ids] of repoints) {
      for (let index = 0; index < ids.length; index += REPOINT_CHUNK) {
        const chunk = ids.slice(index, index + REPOINT_CHUNK);

        await tx.$executeRaw`
          UPDATE transcript_segments
             SET speaker_id = ${speakerId}::uuid,
                 rev = rev + 1,
                 edited_by_id = ${editorId}::uuid,
                 edited_at = ${now}
           WHERE id IN (${Prisma.join(chunk.map((id) => Prisma.sql`${id}::uuid`))})
        `;
      }
    }

    for (const { id, patch } of individual) {
      const { words, ...columns } = patch;

      await tx.transcriptSegment.update({
        where: { id },
        data: {
          ...columns,
          ...(words ? { words: words as unknown as Prisma.InputJsonValue } : {}),
          editedById: editorId,
          editedAt: now,
        },
      });
    }

    if (diff.segmentsDeleted.length > 0) {
      await tx.transcriptSegment.deleteMany({ where: { id: { in: diff.segmentsDeleted } } });
    }

    if (diff.segmentsCreated.length > 0) {
      await tx.transcriptSegment.createMany({
        data: diff.segmentsCreated.map((segment) => ({
          id: segment.id,
          transcriptId,
          speakerId: segment.speakerId,
          startMs: segment.startMs,
          endMs: segment.endMs,
          ordinal: segment.ordinal,
          text: segment.text,
          words: segment.words as unknown as Prisma.InputJsonValue,
          wordsAlignment: segment.wordsAlignment,
          confidence: segment.confidence,
          origin: segment.origin,
          rev: segment.rev,
          editedById: editorId,
          editedAt: now,
        })),
      });
    }

    // LAST: a speaker may only go once nothing references it (`onDelete:
    // Restrict`). Every re-point and every segment delete above has already
    // happened, so this is the moment the constraint can be satisfied.
    if (diff.speakersDeleted.length > 0) {
      await tx.transcriptSpeaker.deleteMany({ where: { id: { in: diff.speakersDeleted } } });
    }
  }

  // ===========================================================================
  // After the commit
  // ===========================================================================

  private async afterCommit(
    transcriptId: string,
    saved: { version: number; kind: 'edit' },
    expanded: ExpandedBatch,
    user: RequestUser,
  ): Promise<void> {
    const [lastSnapshot, bytes] = await Promise.all([
      this.prisma.transcriptVersion.findFirst({
        where: { transcriptId, snapshotObjectId: { not: null }, version: { lte: saved.version } },
        orderBy: { version: 'desc' },
        select: { version: true },
      }),
      this.opBytesSince(transcriptId, saved.version),
    ]);

    const wanted = shouldSnapshot({
      version: saved.version,
      kind: saved.kind,
      lastSnapshotVersion: lastSnapshot?.version ?? null,
      bytesSinceSnapshot: bytes,
    });

    if (wanted) await this.pipeline.enqueueSnapshot(transcriptId, saved.version);

    // ⚠ ON EVERY COMMITTED BATCH, AND UNCONDITIONALLY (#188, epic #165), unlike
    // the snapshot above which is rationed by `shouldSnapshot`. The two look
    // like they should share a gate and must not: a snapshot is a COMPACTION of
    // replay work, so skipping one costs only a slower rebuild later, while
    // skipping an index leaves the transcript findable only by the text it used
    // to contain — a wrong answer rather than a slow one.
    //
    // It costs almost nothing to be unconditional, which is the other half of
    // the argument. `search.index` dedups against any run still pending, so ten
    // corrections in ten seconds are one job; that job compares one fingerprint
    // and returns if nothing moved; and if something did move it re-embeds only
    // the chunks whose `content_hash` changed — one or two lines out of a
    // three-hour transcript, not the whole thing.
    await this.pipeline.enqueueSearchIndex(transcriptId);

    // AUDITED: a merge and a find & replace are the two corrections that change
    // many lines from one click, and therefore the two a reader of the audit log
    // would want to find later. An ordinary typo fix is already fully described
    // by its own version row.
    if (isAuditableBatch(expanded.ops, expanded.findReplace.length > 0)) {
      await this.audit(user.id, 'transcript.bulk_correction', transcriptId, {
        version: saved.version,
        ops: expanded.ops.length,
        merges: expanded.ops.filter((op) => op.op === OP_TYPES.MERGE_SPEAKERS).length,
        findReplace: expanded.findReplace.map((entry) => ({
          find: entry.find,
          replace: entry.replace,
          segments: entry.segments,
          occurrences: entry.occurrences,
        })),
      });
    }
  }

  /** `sum(octet_length(ops::text))` for every version after the last snapshot. */
  private async opBytesSince(transcriptId: string, upToVersion: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ bytes: bigint | number | null }>>`
      SELECT COALESCE(SUM(octet_length(ops::text)), 0) AS bytes
        FROM transcript_versions
       WHERE transcript_id = ${transcriptId}::uuid
         AND version <= ${upToVersion}
         AND version > COALESCE(
               (SELECT MAX(version) FROM transcript_versions
                 WHERE transcript_id = ${transcriptId}::uuid
                   AND snapshot_object_id IS NOT NULL
                   AND version <= ${upToVersion}),
               0)
    `;

    return Number(rows[0]?.bytes ?? 0);
  }

  // ===========================================================================
  // Expansion and normalisation
  // ===========================================================================

  /**
   * Turn what a client sent into what will be written down.
   *
   * Three things happen here and nowhere else, and all three exist so that a
   * recorded version replays identically forever (spec §4.2, §4.4):
   *
   *   • `transcript.find_replace` becomes concrete `segment.update_text` ops,
   *     so no future change to how matches are FOUND can change what a version
   *     from last year SAYS;
   *   • `segment.split` gets its `newSegmentId` minted and any `atCharOffset`
   *     resolved to a word index, so a replay produces the same id at the same
   *     seam rather than a fresh uuid every time;
   *   • `speaker.create` gets its `speakerId` and `colorIndex` chosen, for the
   *     same reason.
   */
  private async expand(
    transcriptId: string,
    requested: readonly RequestOp[],
  ): Promise<ExpandedBatch> {
    const ops: RecordedOp[] = [];
    const findReplace: FindReplaceSummaryInput[] = [];

    const needsSpeakers = requested.some((op) => op.op === OP_TYPES.CREATE_SPEAKER);
    const needsText =
      requested.some((op) => op.op === OP_TYPES.FIND_REPLACE) ||
      requested.some((op) => op.op === OP_TYPES.SPLIT);

    let nextColorIndex = 0;

    if (needsSpeakers) {
      const speakers = await this.prisma.transcriptSpeaker.findMany({
        where: { transcriptId },
        select: { colorIndex: true },
      });

      nextColorIndex = speakers.reduce((max, row) => Math.max(max, row.colorIndex + 1), 0);
    }

    /** Segment text as this batch has rewritten it so far. */
    const text = new Map<string, { text: string; rev: number; speakerId: string }>();

    if (needsText) {
      const rows = await this.prisma.transcriptSegment.findMany({
        where: { transcriptId },
        orderBy: [{ startMs: 'asc' }, { ordinal: 'asc' }],
        select: { id: true, text: true, rev: true, speakerId: true },
      });

      for (const row of rows) {
        text.set(row.id, { text: row.text, rev: row.rev, speakerId: row.speakerId });
      }
    }

    for (const op of requested) {
      switch (op.op) {
        case OP_TYPES.FIND_REPLACE: {
          let segments = 0;
          let occurrences = 0;

          for (const [segmentId, row] of text) {
            if (op.speakerId && row.speakerId !== op.speakerId) continue;

            const replaced = replaceMatches(row.text, op.find, op.replace, {
              matchCase: op.matchCase,
              wholeWord: op.wholeWord,
            });

            if (replaced.count === 0) continue;

            segments += 1;
            occurrences += replaced.count;

            // The working copy is updated so a SECOND find & replace in the
            // same batch operates on the first one's output, exactly as the
            // reducers will when they run in order.
            row.text = replaced.text;

            ops.push({
              op: OP_TYPES.UPDATE_TEXT,
              segmentId,
              rev: row.rev,
              text: replaced.text,
            });
          }

          if (occurrences > 0) {
            findReplace.push({ find: op.find, replace: op.replace, segments, occurrences });
          }

          break;
        }

        case OP_TYPES.SPLIT: {
          const row = text.get(op.segmentId);

          if (!row) {
            throw new BadRequestException(
              `segment.split names segment ${op.segmentId}, which is not in this transcript`,
            );
          }

          const atWordIndex =
            op.atWordIndex ?? wordIndexAtCharOffset(row.text, op.atCharOffset as number);

          ops.push({
            op: OP_TYPES.SPLIT,
            segmentId: op.segmentId,
            rev: op.rev,
            atWordIndex,
            newSpeakerId: op.newSpeakerId ?? null,
            newSegmentId: randomUUID(),
          });

          break;
        }

        case OP_TYPES.CREATE_SPEAKER: {
          ops.push({
            op: OP_TYPES.CREATE_SPEAKER,
            speakerId: randomUUID(),
            displayName: op.displayName,
            colorIndex: nextColorIndex,
          });

          nextColorIndex += 1;

          break;
        }

        default:
          ops.push(op);
          break;
      }

      if (ops.length > MAX_EXPANDED_OPS) {
        throw new BadRequestException(
          `This batch expands to more than ${MAX_EXPANDED_OPS} operations. Narrow the ` +
            'replacement to one speaker, or use a longer search term.',
        );
      }
    }

    return { ops, findReplace };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async findBatch(transcriptId: string, clientBatchId: string) {
    return this.prisma.transcriptVersion.findUnique({
      where: { transcriptId_clientBatchId: { transcriptId, clientBatchId } },
      select: { version: true, summary: true },
    });
  }

  /**
   * The answer to a retried `clientBatchId`: the version that batch created,
   * and the state as it was at that version.
   *
   * The cheap path is the common one — the retry arrives seconds later and the
   * version it created is still the current one, so the LIVE tables are that
   * state. Only a retry that arrives after somebody else has saved pays for a
   * materialization, which is the honest price of answering "what did MY save
   * produce" rather than "what does the transcript look like now".
   */
  private async replayResult(
    transcriptId: string,
    batch: { version: number; summary: string | null },
  ): Promise<OperationsResult> {
    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      select: { currentVersion: true },
    });

    if (transcript && transcript.currentVersion === batch.version) {
      return this.currentResult(transcriptId, batch.version, batch.summary ?? '', true);
    }

    const { state } = await this.materialize.materialize(transcriptId, batch.version);

    return {
      version: batch.version,
      summary: batch.summary ?? '',
      idempotentReplay: true,
      speakers: [...state.speakers].sort((a, b) => a.colorIndex - b.colorIndex),
      segments: sortForRead(state.segments).map((segment) => segmentShape(segment, null)),
      merges: [],
    };
  }

  /** The live tables, shaped like an operations result. */
  private async currentResult(
    transcriptId: string,
    version: number,
    summary: string,
    idempotentReplay = false,
  ): Promise<OperationsResult> {
    const { state, editedAt } = await this.materialize.loadLiveState(transcriptId, new Set());

    return {
      version,
      summary,
      idempotentReplay,
      speakers: [...state.speakers].sort((a, b) => a.colorIndex - b.colorIndex),
      segments: sortForRead(state.segments).map((segment) =>
        segmentShape(segment, editedAt.get(segment.id)?.toISOString() ?? null),
      ),
      merges: [],
    };
  }

  /** One audit row. `targetType: 'transcript'`, matching `TranscriptsService`. */
  private async audit(
    userId: string,
    action: string,
    transcriptId: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'transcript',
        targetId: transcriptId,
        meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}

/** The expanded, recordable form of one request batch. */
interface ExpandedBatch {
  ops: RecordedOp[];
  findReplace: FindReplaceSummaryInput[];
}

/** The wire shape of one segment. Words are never included — see the DTO. */
function segmentShape(segment: EditableSegment, editedAt: string | null) {
  return {
    id: segment.id,
    speakerId: segment.speakerId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    ordinal: segment.ordinal,
    text: segment.text,
    wordsAlignment: segment.wordsAlignment,
    confidence: segment.confidence,
    origin: segment.origin,
    rev: segment.rev,
    editedAt,
  };
}

/** `v<number>`, base64url — opaque to a client, trivially decodable here. */
export function encodeVersionCursor(version: number): string {
  return Buffer.from(`v${version}`, 'utf8').toString('base64url');
}

export function decodeVersionCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;

  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^v(\d+)$/.exec(decoded);

  if (!match) throw new BadRequestException('Invalid cursor');

  return Number(match[1]);
}

/** Re-exported so a test can name the state type without a second import. */
export type { EditingState };
