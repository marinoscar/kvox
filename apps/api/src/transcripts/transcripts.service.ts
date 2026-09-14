// =============================================================================
// TranscriptsService (issue #25, epic #19)
// =============================================================================
//
// Everything `POST /api/transcripts` and the read/lifecycle endpoints do.
// The pipeline itself — which job runs next, what a failure writes, who gets
// told — lives in `TranscriptPipelineService`; this file is the request-facing
// half.
//
// -----------------------------------------------------------------------------
// CREATE IS TWO ROWS AND ONE ACTION
// -----------------------------------------------------------------------------
//
// A transcript and its multipart upload are created together, in that order,
// and returned together. The order matters: `storage_objects` must exist
// before `transcripts.source_object_id` can point at it, and the foreign key
// is `Restrict` precisely so nothing can remove it afterwards.
//
// THE THREE PRE-FLIGHT CHECKS ARE ALL 4xx, AND EACH HAS A DIFFERENT CODE:
//   • transcription not configured → 409. The request was well-formed; the
//     DEPLOYMENT is not ready. A 400 would blame the caller for an
//     administrator's unfinished setup.
//   • file too large, or a type the provider will not take → 400. The caller
//     can fix this by picking a different file, which is what 400 means.
//   • no `transcripts:write` → 403, from the guard, before any of this runs.
//
// All three are checked BEFORE `initUpload`, so a rejected request leaves no
// half-created multipart upload behind for the stale sweep to find.
//
// -----------------------------------------------------------------------------
// EVERY READ GOES THROUGH `TranscriptAccessService`
// -----------------------------------------------------------------------------
//
// There is no `findUnique` on `transcripts` anywhere in this file that is not
// preceded by an access check, because the access check RETURNS the row —
// which is the arrangement that makes "look it up, then authorise" impossible
// to write by accident. No access is a 404, never a 403 (spec §6.1).
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, Transcript, TranscriptSegment } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ObjectsService } from '../storage/objects/objects.service';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import {
  DEFAULT_WORDS_WINDOW_MS,
  MAX_WORDS_WINDOW_MS,
  type CreateTranscriptDto,
  type TranscriptListQueryDto,
  type TranscriptWordsQueryDto,
} from './dto/transcript.dto';
import { TRANSCRIPTS_MANAGED_BY } from './job-types';
import {
  TranscriptAccessService,
  type TranscriptAccessRole,
} from './transcript-access.service';
import { TranscriptObjectsService } from './transcript-objects.service';
import { TranscriptPipelineService } from './transcript-pipeline.service';
import { TranscriptionRuntimeService } from './transcription-runtime.service';

/** The list-row projection, as every read surface returns it. */
export interface TranscriptListItem {
  id: string;
  title: string;
  status: string;
  transcriptionStatus: string;
  playbackStatus: string;
  language: string | null;
  durationMs: number | null;
  speakerCount: number;
  wordCount: number;
  currentVersion: number;
  failureReason: string | null;
  access: TranscriptAccessRole;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class TranscriptsService {
  private readonly logger = new Logger(TranscriptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: ObjectsService,
    private readonly transcriptObjects: TranscriptObjectsService,
    private readonly access: TranscriptAccessService,
    private readonly pipeline: TranscriptPipelineService,
    private readonly runtime: TranscriptionRuntimeService,
  ) {}

  // ===========================================================================
  // Create
  // ===========================================================================

  async create(dto: CreateTranscriptDto, user: RequestUser) {
    const active = await this.runtime.activeProvider();

    if (!active) {
      throw new ConflictException(
        'Transcription is not configured for this deployment. An administrator can set it ' +
          'up under Settings → Transcription.',
      );
    }

    // Fact 4 of the availability conjunction: a provider chosen with no API
    // key stored is the most common half-finished state, because choosing a
    // provider and pasting its key are two fields and people save in between.
    if (!(await this.runtime.isAvailable())) {
      throw new ConflictException(
        `No API key is stored for the ${active.provider.label} transcription provider. An ` +
          'administrator can add one under Settings → Transcription.',
      );
    }

    const { capabilities } = active.provider;

    if (dto.source.size > capabilities.maxInputBytes) {
      throw new BadRequestException(
        `This file is ${dto.source.size} bytes, above the ${capabilities.maxInputBytes}-byte ` +
          `limit ${active.provider.label} accepts.`,
      );
    }

    // ⚠ THE TYPE CHECK IS DELIBERATELY PERMISSIVE HERE, AND THAT IS NOT AN
    // OVERSIGHT. A file the provider will not take directly is not necessarily
    // untranscribable: `media.audio.transcode` produces a rendition the
    // provider does accept, and `selectTranscriptionInput` is what decides
    // between them LATER, with the rendition's existence known. What is
    // rejected here is a type `ObjectsService.initUpload` itself refuses (not
    // audio at all) — which it does, with its own 400, using the same
    // extension-aware resolution mobile browsers make necessary.
    const upload = await this.objects.initUpload(
      {
        name: dto.source.name,
        size: dto.source.size,
        mimeType: dto.source.mimeType,
      },
      user.id,
      // ⚠ `managedBy` IS A SERVICE-LEVEL ARGUMENT AND UNREACHABLE OVER HTTP.
      // It is what makes this object invisible to `GET /api/storage/objects`
      // and undeletable through the generic `DELETE` — the ownership boundary
      // spec §9.3 describes, claimed here by the module that will own it.
      TRANSCRIPTS_MANAGED_BY,
    );

    const transcript = await this.prisma.transcript.create({
      data: {
        ownerId: user.id,
        title: dto.title?.trim() || defaultTitle(dto.source.name),
        language: dto.language ?? null,
        status: 'uploading',
        transcriptionStatus: 'waiting_input',
        playbackStatus: 'pending',
        sourceObjectId: upload.objectId,
        provider: active.provider.id,
        providerOptions: {
          speakersExpected: dto.speakersExpected ?? null,
          language: dto.language ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    await this.audit(user.id, 'transcript:create', transcript.id, {
      title: transcript.title,
      sourceName: dto.source.name,
      sourceSize: String(dto.source.size),
      provider: active.provider.id,
    });

    this.logger.log(
      `Transcript ${transcript.id} created for user ${user.id}; awaiting upload ` +
        `${upload.objectId} (${upload.totalParts} part(s))`,
    );

    return {
      transcript: await this.detailShape(transcript, 'owner'),
      upload,
    };
  }

  // ===========================================================================
  // Read
  // ===========================================================================

  /** `GET /api/transcripts` — cursor-paginated, `updatedAt` descending. */
  async list(query: TranscriptListQueryDto, userId: string) {
    const where = await this.scopeWhere(query, userId);
    const cursor = decodeCursor(query.cursor);

    if (cursor) {
      // KEYSET, NOT OFFSET. `(updatedAt, id)` as a compound tie-break, because
      // `updatedAt` alone is not unique and two rows sharing a millisecond
      // would make one of them unreachable.
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { updatedAt: { lt: cursor.updatedAt } },
            { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
          ],
        },
      ];
    }

    const rows = await this.prisma.transcript.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      // One more than asked for: the extra row is how "is there a next page?"
      // is answered without a second `count` query over the same predicate.
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const items = await this.withAccess(page, userId);

    return {
      items,
      nextCursor:
        rows.length > query.limit && page.length > 0
          ? encodeCursor(page[page.length - 1])
          : null,
    };
  }

  /**
   * `GET /api/transcripts/summary` — the home page's ONE request.
   *
   * Three lists and four counts in a single round trip, deliberately: the
   * alternative is a home page that fires four requests and renders in four
   * stages, and the queries are cheap enough (all covered by
   * `(owner_id, updated_at desc)`) that combining them costs nothing.
   */
  async summary(userId: string) {
    const shareIds = await this.sharedTranscriptIds(userId);

    const [inProgress, recent, shared, owned, failed] = await Promise.all([
      this.prisma.transcript.findMany({
        where: {
          deletedAt: null,
          status: { in: ['uploading', 'processing'] },
          OR: [{ ownerId: userId }, { id: { in: shareIds } }],
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
      this.prisma.transcript.findMany({
        where: { deletedAt: null, ownerId: userId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 8,
      }),
      this.prisma.transcript.findMany({
        where: { deletedAt: null, id: { in: shareIds } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 8,
      }),
      this.prisma.transcript.count({ where: { deletedAt: null, ownerId: userId } }),
      this.prisma.transcript.count({
        where: { deletedAt: null, ownerId: userId, status: 'failed' },
      }),
    ]);

    const [inProgressItems, recentItems, sharedItems] = await Promise.all([
      this.withAccess(inProgress, userId),
      this.withAccess(recent, userId),
      this.withAccess(shared, userId),
    ]);

    return {
      inProgress: inProgressItems,
      recent: recentItems,
      sharedWithMe: sharedItems,
      counts: {
        owned,
        shared: shareIds.length,
        inProgress: inProgressItems.length,
        failed,
      },
    };
  }

  /** `GET /api/transcripts/:id`. */
  async detail(id: string, user: RequestUser) {
    const { transcript, role } = await this.access.require(user.id, id, 'view');

    return this.detailShape(transcript, role);
  }

  /** `GET /api/transcripts/:id/segments` — compact, no word timings. */
  async segments(id: string, user: RequestUser) {
    const { transcript } = await this.access.require(user.id, id, 'view');

    const rows = await this.prisma.transcriptSegment.findMany({
      where: { transcriptId: transcript.id },
      orderBy: [{ startMs: 'asc' }, { ordinal: 'asc' }],
      select: {
        id: true,
        speakerId: true,
        startMs: true,
        endMs: true,
        ordinal: true,
        text: true,
        wordsAlignment: true,
        confidence: true,
        origin: true,
        rev: true,
        editedAt: true,
      },
    });

    return {
      currentVersion: transcript.currentVersion,
      segments: rows.map((row) => ({
        ...row,
        editedAt: row.editedAt ? row.editedAt.toISOString() : null,
      })),
    };
  }

  /**
   * `GET /api/transcripts/:id/words?fromMs&toMs` — timings for one window.
   *
   * ⚠ A WINDOW, NEVER THE WHOLE TRANSCRIPT. A ten-hour recording's word index
   * is the single largest thing in this schema; serving all of it on one
   * request is a response measured in hundreds of megabytes, produced by a
   * query a careless client can repeat on every scroll. The window is capped
   * here rather than left to the caller's good manners.
   */
  async words(id: string, query: TranscriptWordsQueryDto, user: RequestUser) {
    const { transcript } = await this.access.require(user.id, id, 'view');

    const fromMs = query.fromMs;
    const requestedTo = query.toMs ?? fromMs + DEFAULT_WORDS_WINDOW_MS;
    const toMs = Math.min(requestedTo, fromMs + MAX_WORDS_WINDOW_MS);

    const rows = await this.prisma.transcriptSegment.findMany({
      // OVERLAP, not containment: a segment straddling the window's start
      // carries the words a player is about to highlight, and a containment
      // test would drop exactly the one the caller is listening to.
      where: {
        transcriptId: transcript.id,
        startMs: { lt: toMs },
        endMs: { gte: fromMs },
      },
      orderBy: [{ startMs: 'asc' }, { ordinal: 'asc' }],
      select: {
        id: true,
        startMs: true,
        endMs: true,
        wordsAlignment: true,
        words: true,
      },
    });

    return {
      currentVersion: transcript.currentVersion,
      fromMs,
      toMs,
      segments: rows.map((row) => ({
        segmentId: row.id,
        startMs: row.startMs,
        endMs: row.endMs,
        wordsAlignment: row.wordsAlignment,
        words: readWords(row.words),
      })),
    };
  }

  /**
   * `GET /api/transcripts/:id/audio` — a signed URL, six-hour TTL.
   *
   * The rendition when it is ready, the original otherwise. The fallback is
   * not a nicety: a transcode that failed, or one that has not finished on a
   * transcript already readable, must not mean the audio is unplayable — most
   * browsers can play most uploads directly, and issue #30's player uses
   * `canPlayType` to decide whether to try.
   */
  async audio(id: string, user: RequestUser) {
    const { transcript } = await this.access.require(user.id, id, 'view');

    const ttl = this.transcriptObjects.playbackUrlTtlSeconds();

    if (transcript.playbackStatus === 'ready' && transcript.playbackObjectId) {
      const signed = await this.transcriptObjects.signedUrlFor(
        transcript.playbackObjectId,
        ttl,
      );

      if (signed) {
        return {
          url: signed.url,
          kind: 'playback' as const,
          mimeType: signed.object.mimeType,
          expiresAt: signed.expiresAt.toISOString(),
        };
      }
    }

    const original = await this.transcriptObjects.signedUrlFor(
      transcript.sourceObjectId,
      ttl,
    );

    if (!original) {
      throw new NotFoundException('This transcript has no playable audio');
    }

    return {
      url: original.url,
      kind: 'original' as const,
      mimeType: original.object.mimeType,
      expiresAt: original.expiresAt.toISOString(),
    };
  }

  // ===========================================================================
  // Write and lifecycle
  // ===========================================================================

  /** `PATCH /api/transcripts/:id` — the title, and nothing else. */
  async updateTitle(id: string, title: string, user: RequestUser) {
    const { transcript, role } = await this.access.require(
      user.id,
      id,
      'edit',
      user.permissions,
    );

    const updated = await this.prisma.transcript.update({
      where: { id: transcript.id },
      data: { title: title.trim() },
    });

    return this.detailShape(updated, role);
  }

  /**
   * `DELETE /api/transcripts/:id` — soft delete, then purge.
   *
   * ⚠ `deleting` IS A REAL, VISIBLE STATUS RATHER THAN AN IMMEDIATE ROW
   * DELETE. Removing a transcript means deleting multi-gigabyte objects and
   * calling a third party's delete endpoint, which is long-running work (rule
   * 1) — so the row has to exist long enough to say "this is going away" while
   * `transcript.purge` does it. There is no path back: a transcript the owner
   * asked to delete does not get a later `PATCH` that changes its mind.
   */
  async remove(id: string, user: RequestUser): Promise<void> {
    const { transcript } = await this.access.require(user.id, id, 'own', user.permissions);

    if (transcript.status === 'deleting') {
      // Already going. Idempotent rather than a 409: the caller asked for it
      // to be gone and it is on its way, which is success.
      return;
    }

    await this.prisma.transcript.update({
      where: { id: transcript.id },
      data: { status: 'deleting', deletedAt: new Date() },
    });

    await this.audit(user.id, 'transcript:delete', transcript.id, {
      title: transcript.title,
      status: transcript.status,
    });

    await this.pipeline.enqueuePurge(transcript.id);
  }

  /**
   * `POST /api/transcripts/:id/retry` — re-run the stage that failed.
   *
   * ⚠ THE STAGE IS DERIVED FROM THE ROW, not chosen by the caller. A client
   * that got to name the stage could ask for a re-submission of a transcript
   * that already has a `provider_job_id`, creating a second remote job and a
   * second bill for one recording. Here: a transcript that was submitted is
   * re-POLLED, and only one that never got a provider job is re-SUBMITTED.
   */
  async retry(id: string, user: RequestUser) {
    const { transcript, role } = await this.access.require(
      user.id,
      id,
      'own',
      user.permissions,
    );

    if (transcript.status === 'deleting') {
      throw new ConflictException('This transcript is being deleted');
    }

    if (transcript.status === 'ready') {
      throw new ConflictException('This transcript is already complete');
    }

    if (transcript.status === 'uploading') {
      throw new ConflictException(
        'The audio for this transcript has not finished uploading yet',
      );
    }

    const source = await this.prisma.storageObject.findUnique({
      where: { id: transcript.sourceObjectId },
      select: { status: true },
    });

    if (!source || source.status !== 'ready') {
      throw new ConflictException(
        'The audio for this transcript is no longer available, so it cannot be retried. ' +
          'Delete it and upload the file again.',
      );
    }

    await this.prisma.transcript.update({
      where: { id: transcript.id },
      data: { status: 'processing', failureReason: null },
    });

    if (transcript.providerJobId && transcript.transcriptionStatus !== 'cancelled') {
      // The provider already has the job. Re-poll rather than re-submit: the
      // remote job may well have finished while this transcript sat `failed`
      // after a poll chain died.
      await this.prisma.transcript.update({
        where: { id: transcript.id },
        data: { transcriptionStatus: 'submitted' },
      });

      await this.pipeline.enqueueFirstPoll(transcript.id, transcript.durationMs, 'rerun');
    } else {
      // ⚠ THE PROVIDER HANDLE IS CLEARED, because a cancelled remote job must
      // not be polled back to life and a re-submission needs the idempotency
      // check in `transcription.submit` to see an empty field.
      await this.prisma.transcript.update({
        where: { id: transcript.id },
        data: { providerJobId: null, submittedAt: null },
      });

      await this.pipeline.enqueueSubmit(transcript.id, 'rerun');
    }

    await this.audit(user.id, 'transcript:retry', transcript.id, {
      previousStatus: transcript.status,
      previousFailureReason: transcript.failureReason,
    });

    const fresh = await this.prisma.transcript.findUniqueOrThrow({
      where: { id: transcript.id },
    });

    return this.detailShape(fresh, role);
  }

  /**
   * `POST /api/transcripts/:id/cancel`.
   *
   * Cancels the PROVIDER side when the provider supports it, and marks the
   * transcript regardless. A provider without a `cancel` capability is not an
   * error: the remote job runs to completion and is deleted at the next
   * opportunity, and the user's own view stops waiting for it either way.
   */
  async cancel(id: string, user: RequestUser) {
    const { transcript, role } = await this.access.require(
      user.id,
      id,
      'own',
      user.permissions,
    );

    if (transcript.status === 'ready' || transcript.status === 'deleting') {
      throw new ConflictException(
        `A ${transcript.status} transcript cannot be cancelled`,
      );
    }

    if (transcript.providerJobId) {
      try {
        const { provider, ctx } = await this.runtime.resolve();

        if (provider.capabilities.cancel && provider.cancel) {
          await provider.cancel(ctx, transcript.providerJobId);
        }
      } catch (error) {
        // NEVER FATAL. The user asked to stop waiting; a vendor that will not
        // answer must not prevent that. The remote job is cleaned up by
        // `transcript.purge` or by the provider's own retention.
        this.logger.warn(
          `Could not cancel provider job ${transcript.providerJobId} for transcript ` +
            `${transcript.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const updated = await this.prisma.transcript.update({
      where: { id: transcript.id },
      data: {
        status: 'failed',
        transcriptionStatus: 'cancelled',
        failureReason: 'Cancelled by the owner.',
      },
    });

    await this.audit(user.id, 'transcript:cancel', transcript.id, {
      previousStatus: transcript.status,
      previousTranscriptionStatus: transcript.transcriptionStatus,
    });

    return this.detailShape(updated, role);
  }

  // ===========================================================================
  // Shapes and helpers
  // ===========================================================================

  /** The list-row projection. One definition, every surface. */
  private listShape(transcript: Transcript, access: TranscriptAccessRole): TranscriptListItem {
    return {
      id: transcript.id,
      title: transcript.title,
      status: transcript.status,
      transcriptionStatus: transcript.transcriptionStatus,
      playbackStatus: transcript.playbackStatus,
      language: transcript.language,
      durationMs: transcript.durationMs,
      speakerCount: transcript.speakerCount,
      wordCount: transcript.wordCount,
      currentVersion: transcript.currentVersion,
      failureReason: transcript.failureReason,
      access,
      createdAt: transcript.createdAt.toISOString(),
      updatedAt: transcript.updatedAt.toISOString(),
    };
  }

  /** The detail projection: the list row, plus speakers and source facts. */
  private async detailShape(transcript: Transcript, access: TranscriptAccessRole) {
    const [speakers, source] = await Promise.all([
      this.prisma.transcriptSpeaker.findMany({
        where: { transcriptId: transcript.id },
        orderBy: { colorIndex: 'asc' },
        select: { id: true, label: true, displayName: true, colorIndex: true, rev: true },
      }),
      this.prisma.storageObject.findUnique({
        where: { id: transcript.sourceObjectId },
        select: { name: true, mimeType: true, size: true },
      }),
    ]);

    return {
      ...this.listShape(transcript, access),
      speakers,
      provider: transcript.provider,
      remoteDeletedAt: transcript.remoteDeletedAt
        ? transcript.remoteDeletedAt.toISOString()
        : null,
      submittedAt: transcript.submittedAt ? transcript.submittedAt.toISOString() : null,
      completedAt: transcript.completedAt ? transcript.completedAt.toISOString() : null,
      sourceName: source?.name ?? '',
      sourceMimeType: source?.mimeType ?? '',
      // ⚠ A DECIMAL STRING, NOT A NUMBER. `storage_objects.size` is `BigInt`
      // because a multi-gigabyte recording is the ordinary case here, and
      // `JSON.stringify` throws on a BigInt rather than rounding it.
      sourceSizeBytes: source ? source.size.toString() : '0',
    };
  }

  /** Attach each row's access role, with one query for the caller's shares. */
  private async withAccess(
    rows: Transcript[],
    userId: string,
  ): Promise<TranscriptListItem[]> {
    if (rows.length === 0) return [];

    const shares = await this.prisma.transcriptShare.findMany({
      where: { userId, transcriptId: { in: rows.map((row) => row.id) } },
      select: { transcriptId: true, role: true },
    });

    const byId = new Map(shares.map((share) => [share.transcriptId, share.role]));

    return rows.map((row) =>
      this.listShape(
        row,
        row.ownerId === userId
          ? 'owner'
          : byId.get(row.id) === 'editor'
            ? 'editor'
            : 'viewer',
      ),
    );
  }

  /** Transcript ids shared with this user. */
  private async sharedTranscriptIds(userId: string): Promise<string[]> {
    const shares = await this.prisma.transcriptShare.findMany({
      where: { userId },
      select: { transcriptId: true },
    });

    return shares.map((share) => share.transcriptId);
  }

  /** The `where` clause for one list request, scope and filters included. */
  private async scopeWhere(
    query: TranscriptListQueryDto,
    userId: string,
  ): Promise<Prisma.TranscriptWhereInput> {
    const where: Prisma.TranscriptWhereInput = { deletedAt: null };

    if (query.scope === 'owned') {
      where.ownerId = userId;
    } else {
      const shareIds = await this.sharedTranscriptIds(userId);

      where.OR =
        query.scope === 'shared'
          ? [{ id: { in: shareIds } }]
          : [{ ownerId: userId }, { id: { in: shareIds } }];
    }

    if (query.status) where.status = query.status;

    if (query.q) {
      where.title = { contains: query.q, mode: 'insensitive' };
    }

    return where;
  }

  /** One audit row. `targetType: 'transcript'`, matching the subject naming. */
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

/** A filename without its extension, trimmed to the title limit. */
export function defaultTitle(filename: string): string {
  const base = filename.replace(/\.[^./\\]+$/, '').trim();

  return (base || filename).slice(0, 200);
}

/**
 * The word array off a segment's JSONB column.
 *
 * TOTAL OVER GARBAGE: the column is written by this application but read back
 * as `Prisma.JsonValue`, and a row written by an older build with a different
 * shape must not crash a player's fetch. Anything unrecognisable is an empty
 * window, which renders as "no timings" rather than as a 500.
 */
export function readWords(
  value: TranscriptSegment['words'],
): Array<{ t: string; s: number; e: number; c: number | null }> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];

    const record = entry as Record<string, unknown>;

    if (typeof record.t !== 'string') return [];
    if (typeof record.s !== 'number' || typeof record.e !== 'number') return [];

    return [
      {
        t: record.t,
        s: record.s,
        e: record.e,
        c: typeof record.c === 'number' ? record.c : null,
      },
    ];
  });
}

/** `updatedAt|id`, base64url. Opaque to the client, trivially decodable here. */
export function encodeCursor(transcript: Transcript): string {
  return Buffer.from(
    `${transcript.updatedAt.toISOString()}|${transcript.id}`,
    'utf8',
  ).toString('base64url');
}

/**
 * The other half of {@link encodeCursor}.
 *
 * Returns `null` for anything malformed rather than throwing: a cursor is a
 * value a client copied from a previous response, and a stale or truncated one
 * should restart the list from the top, not 500.
 */
export function decodeCursor(
  cursor: string | undefined,
): { updatedAt: Date; id: string } | null {
  if (!cursor) return null;

  try {
    const [timestamp, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');

    if (!timestamp || !id) return null;

    const updatedAt = new Date(timestamp);

    if (Number.isNaN(updatedAt.getTime())) return null;

    return { updatedAt, id };
  } catch {
    return null;
  }
}
