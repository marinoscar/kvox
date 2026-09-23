// =============================================================================
// TranscriptNameCheckService (issues #328 and #330, epic #326)
// =============================================================================
//
// The request side of AI name correction: start a check, estimate one, read
// the latest run's suggestions, and accept or reject them. The check itself is
// the `transcript.name_check` job; this service never calls a model.
//
// -----------------------------------------------------------------------------
// ACCEPTING IS AN ORDINARY CORRECTION
// -----------------------------------------------------------------------------
//
// `apply` does not write `transcript_segments.text`. It turns the accepted
// suggestions into `segment.update_text` ops — ONE per segment, carrying the
// segment's CURRENT rev — and sends them through
// `TranscriptEditingService.applyOperations`, the same transaction, the same
// version history, the same 409-on-stale-rev and the same idempotency key
// mechanics every other correction uses. A suggestion table that could edit
// text on its own would be a second write path the version log does not know
// about, and `materialize()` could no longer rebuild what the user sees.
//
// -----------------------------------------------------------------------------
// ACCESS
// -----------------------------------------------------------------------------
//
// Exactly the transcript routes' posture: `transcripts:read` + view access for
// reads, `transcripts:write` + edit access for writes, and NO ACCESS IS A 404
// (`TranscriptAccessService`). A check or suggestion id that belongs to a
// different transcript is the same 404 — never "that check exists elsewhere".
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type TranscriptNameCheck } from '@prisma/client';
import { createHash } from 'node:crypto';

import { AiConfigService } from '../ai/ai-config.service';
import { AiProviderRegistry } from '../ai/ai-provider.registry';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { readKeyterms } from '../transcription/keyterms';
import {
  NAME_CHECK_CONFLICT_REASONS,
  type CreateNameCheckDto,
  type NameCheckDecisionDto,
  type NameCheckEstimateQueryDto,
} from './dto/transcript-name-check.dto';
import { MAX_OPS_PER_BATCH, OP_TYPES } from './editing/ops';
import { matchPreview } from './editing/find-matcher';
import { readTerms } from './handlers/transcript-name-check.handler';
import { TRANSCRIPT_NAME_CHECK_JOB_TYPE, TRANSCRIPT_SUBJECT_TYPE } from './job-types';
import { buildTargets } from './name-check/candidates';
import { estimateNameCheck, type NameCheckEstimate } from './name-check/estimate';
import { applySplices, resolveSpan } from './name-check/spans';
import { loadNameCheckInput, type NameCheckSpeaker } from './name-check-input';
import { TranscriptAccessService, TRANSCRIPT_NOT_FOUND_MESSAGE } from './transcript-access.service';
import { TranscriptEditingService, type OperationsResult } from './transcript-editing.service';

/**
 * Queue priority. Somebody is waiting for the result, but less urgently than
 * for an export (−10): the review panel is something they come back to, a
 * download is something they are staring at.
 */
export const NAME_CHECK_JOB_PRIORITY = -5;

const NOT_FOUND = 'Name check not found';

/** The generic label a speaker carries before anybody names them. */
const GENERIC_SPEAKER = /^(speaker\s*[a-z0-9]+|unknown.*)$/i;

type RunView = ReturnType<typeof toRunView>;

export interface CreateNameCheckResult {
  run: RunView;
  estimate: NameCheckEstimate;
}

export interface ApplyNameSuggestionsResult {
  applied: number;
  stale: number;
  version: number;
  segments: OperationsResult['segments'];
  speakers: OperationsResult['speakers'];
}

@Injectable()
export class TranscriptNameCheckService {
  private readonly logger = new Logger(TranscriptNameCheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TranscriptAccessService,
    private readonly editing: TranscriptEditingService,
    private readonly aiConfig: AiConfigService,
    private readonly providers: AiProviderRegistry,
    private readonly jobs: JobsService,
  ) {}

  // ===========================================================================
  // POST /api/transcripts/:id/name-checks
  // ===========================================================================

  async create(
    transcriptId: string,
    dto: CreateNameCheckDto,
    user: RequestUser,
  ): Promise<CreateNameCheckResult> {
    const { transcript } = await this.access.require(user.id, transcriptId, 'edit', user.permissions);
    assertReady(transcript);

    const ai = await this.resolveAi(user.id, true);
    await this.assertNoActiveRun(transcript.id);

    const input = await loadNameCheckInput(this.prisma, transcript.id, false);
    const terms = resolveTerms({
      speakers: input.speakers,
      speakerIds: dto.speakerIds,
      terms: dto.terms,
      providerOptions: transcript.providerOptions,
    });
    const targets = buildTargets(terms);
    if (targets.length === 0) {
      throw new BadRequestException(
        'There are no names to check. Rename at least one speaker or add a name, then check again.',
      );
    }

    const estimate = estimateNameCheck({
      mode: dto.mode,
      segments: input.segments,
      speakerNames: input.speakerNames,
      segmentIndex: input.segmentIndex,
      targets,
      countTokens: ai.countTokens,
    });

    const run = await this.prisma.transcriptNameCheck.create({
      data: {
        transcriptId: transcript.id,
        requestedById: user.id,
        mode: dto.mode,
        status: 'pending',
        basedOnVersion: transcript.currentVersion,
        // The resolved list as the user would recognise it; the job rebuilds
        // the comparison targets from it with the same `buildTargets`.
        terms: terms as Prisma.InputJsonValue,
        providerId: ai.providerId,
        model: ai.model,
      },
    });

    const job = await this.jobs.enqueue({
      type: TRANSCRIPT_NAME_CHECK_JOB_TYPE,
      // No "a user asked" member exists; `upload` would claim a lineage this
      // job does not have. Same choice `transcript.export` makes.
      reason: 'rerun',
      subjectType: TRANSCRIPT_SUBJECT_TYPE,
      subjectId: transcript.id,
      payload: { checkId: run.id },
      priority: NAME_CHECK_JOB_PRIORITY,
    });

    let linked: TranscriptNameCheck;
    try {
      linked = await this.prisma.transcriptNameCheck.update({
        where: { id: run.id },
        data: { jobId: job.id },
      });
    } catch (error) {
      // Dedup handed back a job another request's run already owns — two
      // requests raced past `assertNoActiveRun`. That run is the one that will
      // execute; ours never would, so it is removed and the loser told so.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.prisma.transcriptNameCheck.delete({ where: { id: run.id } }).catch(() => undefined);
        throw runningConflict();
      }
      throw error;
    }

    this.logger.log(
      `Queued name check ${run.id} (${dto.mode}, ${targets.length} names, ~${estimate.inputTokens} ` +
        `input tokens) for transcript ${transcript.id} as job ${job.id}`,
    );

    return { run: toRunView(linked), estimate };
  }

  // ===========================================================================
  // GET /api/transcripts/:id/name-checks/estimate
  // ===========================================================================

  async estimate(
    transcriptId: string,
    query: NameCheckEstimateQueryDto,
    user: RequestUser,
  ): Promise<NameCheckEstimate> {
    const { transcript } = await this.access.require(user.id, transcriptId, 'view', user.permissions);
    assertReady(transcript);

    // A key is not needed to COUNT tokens, only to spend them.
    const ai = await this.resolveAi(user.id, false);
    const input = await loadNameCheckInput(this.prisma, transcript.id, false);
    const targets = buildTargets(
      resolveTerms({ speakers: input.speakers, providerOptions: transcript.providerOptions }),
    );

    return estimateNameCheck({
      mode: query.mode,
      segments: input.segments,
      speakerNames: input.speakerNames,
      segmentIndex: input.segmentIndex,
      targets,
      countTokens: ai.countTokens,
    });
  }

  // ===========================================================================
  // GET /api/transcripts/:id/name-checks/latest
  // ===========================================================================

  async latest(transcriptId: string, user: RequestUser) {
    const { transcript } = await this.access.require(user.id, transcriptId, 'view', user.permissions);

    const run = await this.prisma.transcriptNameCheck.findFirst({
      where: { transcriptId: transcript.id },
      orderBy: { createdAt: 'desc' },
    });

    const counts = { pending: 0, accepted: 0, rejected: 0, stale: 0 };
    if (!run) return { run: null, suggestions: [], counts };

    const [grouped, pending] = await Promise.all([
      this.prisma.transcriptNameSuggestion.groupBy({
        by: ['status'],
        where: { checkId: run.id },
        _count: { _all: true },
      }),
      this.prisma.transcriptNameSuggestion.findMany({
        where: { checkId: run.id, status: 'pending' },
        include: { segment: { select: { text: true, speakerId: true, startMs: true } } },
      }),
    ]);

    for (const row of grouped) counts[row.status] = row._count._all;

    const suggestions = pending
      .map((s) => {
        const resolved = resolveSpan(s.segment.text, s);
        const span = resolved ?? { start: s.start, end: s.end };
        return {
          id: s.id,
          segmentId: s.segmentId,
          speakerId: s.segment.speakerId,
          startMs: s.segment.startMs,
          start: span.start,
          end: span.end,
          original: s.original,
          replacement: s.replacement,
          confidence: s.confidence,
          reason: s.reason,
          source: s.source,
          preview: matchPreview(
            s.segment.text,
            {
              start: Math.min(span.start, s.segment.text.length),
              end: Math.min(span.end, s.segment.text.length),
            },
            40,
          ),
          stale: resolved === null,
        };
      })
      .sort((a, b) => a.startMs - b.startMs || a.segmentId.localeCompare(b.segmentId) || a.start - b.start);

    return { run: toRunView(run), suggestions, counts };
  }

  // ===========================================================================
  // POST /api/transcripts/:id/name-checks/:checkId/apply
  // ===========================================================================

  async apply(
    transcriptId: string,
    checkId: string,
    dto: NameCheckDecisionDto,
    user: RequestUser,
  ): Promise<ApplyNameSuggestionsResult> {
    const { transcript } = await this.access.require(user.id, transcriptId, 'edit', user.permissions);
    await this.requireCheck(transcript.id, checkId);

    const suggestions = await this.prisma.transcriptNameSuggestion.findMany({
      where: { id: { in: dto.suggestionIds }, checkId, status: 'pending' },
    });

    const segmentIds = [...new Set(suggestions.map((s) => s.segmentId))];
    const segments = await this.prisma.transcriptSegment.findMany({
      where: { id: { in: segmentIds }, transcriptId: transcript.id },
      select: { id: true, rev: true, text: true, startMs: true, ordinal: true },
      orderBy: [{ startMs: 'asc' }, { ordinal: 'asc' }],
    });
    const byId = new Map(segments.map((s) => [s.id, s]));

    // ---- Resolve each suggestion against the CURRENT text ---------------------
    const stale = new Set<string>();
    const perSegment = new Map<string, Array<{ id: string; start: number; end: number; replacement: string }>>();
    for (const s of suggestions) {
      const segment = byId.get(s.segmentId);
      const span = segment ? resolveSpan(segment.text, s) : null;
      if (!segment || !span) {
        stale.add(s.id);
        continue;
      }
      const list = perSegment.get(segment.id) ?? [];
      list.push({ id: s.id, start: span.start, end: span.end, replacement: s.replacement });
      perSegment.set(segment.id, list);
    }

    // ---- One `segment.update_text` per segment, current rev -------------------
    const edits: Array<{ op: { op: typeof OP_TYPES.UPDATE_TEXT; segmentId: string; rev: number; text: string }; ids: string[] }> = [];
    for (const segment of segments) {
      const splices = perSegment.get(segment.id);
      if (!splices) continue;
      const result = applySplices(segment.text, splices);
      for (const id of result.skipped) stale.add(id);
      if (result.applied.length === 0 || result.text === segment.text) {
        for (const id of result.applied) stale.add(id);
        continue;
      }
      edits.push({
        op: { op: OP_TYPES.UPDATE_TEXT, segmentId: segment.id, rev: segment.rev, text: result.text },
        ids: result.applied,
      });
    }

    // ---- Apply in chunks of ≤ 200 ops, each its own idempotent batch ----------
    let applied = 0;
    let last: OperationsResult | null = null;
    let baseVersion = transcript.currentVersion;

    for (let i = 0; i < edits.length; i += MAX_OPS_PER_BATCH) {
      const chunk = edits.slice(i, i + MAX_OPS_PER_BATCH);
      const ids = chunk.flatMap((e) => e.ids).sort();
      const clientBatchId =
        `namecheck:${checkId}:` + createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 24);

      // A 409 (stale rev) propagates unchanged: earlier chunks are committed
      // and marked, this one and later ones stay pending for a re-review.
      last = await this.editing.applyOperations(
        transcript.id,
        { baseVersion, clientBatchId, ops: chunk.map((e) => e.op) },
        user,
        { summary: `Applied ${ids.length} AI name correction${ids.length === 1 ? '' : 's'}` },
      );
      baseVersion = last.version;

      await this.prisma.transcriptNameSuggestion.updateMany({
        where: { id: { in: ids }, checkId, status: 'pending' },
        data: { status: 'accepted', decidedAt: new Date(), decidedById: user.id },
      });
      applied += ids.length;
    }

    if (stale.size > 0) {
      await this.prisma.transcriptNameSuggestion.updateMany({
        where: { id: { in: [...stale] }, checkId, status: 'pending' },
        data: { status: 'stale', decidedAt: new Date(), decidedById: user.id },
      });
    }

    if (applied > 0 && last) {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: user.id,
          action: 'transcript.name_check.apply',
          targetType: 'transcript',
          targetId: transcript.id,
          meta: { checkId, applied, stale: stale.size, version: last.version },
        },
      });
    }

    const state = last ?? (await this.editing.currentResult(transcript.id, transcript.currentVersion, 'No changes'));

    return {
      applied,
      stale: stale.size,
      version: state.version,
      segments: state.segments,
      speakers: state.speakers,
    };
  }

  // ===========================================================================
  // POST /api/transcripts/:id/name-checks/:checkId/reject
  // ===========================================================================

  async reject(
    transcriptId: string,
    checkId: string,
    dto: NameCheckDecisionDto,
    user: RequestUser,
  ): Promise<{ rejected: number }> {
    const { transcript } = await this.access.require(user.id, transcriptId, 'edit', user.permissions);
    await this.requireCheck(transcript.id, checkId);

    const result = await this.prisma.transcriptNameSuggestion.updateMany({
      where: { id: { in: dto.suggestionIds }, checkId, status: 'pending' },
      data: { status: 'rejected', decidedAt: new Date(), decidedById: user.id },
    });

    return { rejected: result.count };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * The provider and model a check runs on, or the 409 `POST /api/notes`
   * answers — the same two reasons, the same wording shape.
   */
  private async resolveAi(
    userId: string,
    requireKey: boolean,
  ): Promise<{ providerId: string; model: string; countTokens: (text: string) => number }> {
    const config = await this.aiConfig.getConfig(userId);
    const provider = config.provider ? this.providers.get(config.provider) : undefined;

    if (!config.available || !provider || !config.defaultModel) {
      throw new ConflictException({
        message:
          'AI features are not configured for this deployment, so names cannot be checked. ' +
          'An administrator can enable them in system settings.',
        details: { reason: NAME_CHECK_CONFLICT_REASONS.AI_NOT_CONFIGURED },
      });
    }

    if (requireKey && !config.keyConfigured) {
      throw new ConflictException({
        message:
          'You have not saved an AI API key. A name check runs on your own provider account, so it ' +
          'needs your key. Add one in your settings and try again.',
        details: { reason: NAME_CHECK_CONFLICT_REASONS.AI_KEY_MISSING },
      });
    }

    const model = config.defaultModel;
    return {
      providerId: provider.id,
      model,
      countTokens: (text: string) => provider.countTokens(text, model),
    };
  }

  /**
   * 409 while a check is pending or running for this transcript.
   *
   * A run whose job is gone or already settled (an administrator deleted it,
   * or the process died between the job settling and the run being marked) is
   * NOT active — it is failed here, so a lost job can never block the button
   * forever.
   */
  private async assertNoActiveRun(transcriptId: string): Promise<void> {
    const active = await this.prisma.transcriptNameCheck.findMany({
      where: { transcriptId, status: { in: ['pending', 'running'] } },
      select: { id: true, job: { select: { status: true } } },
    });

    for (const run of active) {
      if (run.job && (run.job.status === 'pending' || run.job.status === 'running')) {
        throw runningConflict(run.id);
      }
      await this.prisma.transcriptNameCheck.updateMany({
        where: { id: run.id, status: { in: ['pending', 'running'] } },
        data: {
          status: 'failed',
          errorClass: 'other',
          error: 'This name check stopped unexpectedly. Try again.',
          completedAt: new Date(),
        },
      });
    }
  }

  private async requireCheck(transcriptId: string, checkId: string): Promise<void> {
    const check = await this.prisma.transcriptNameCheck.findFirst({
      where: { id: checkId, transcriptId },
      select: { id: true },
    });
    if (!check) throw new NotFoundException(NOT_FOUND);
  }
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

function runningConflict(checkId?: string): ConflictException {
  return new ConflictException({
    message: 'A name check is already running for this transcript. Wait for it to finish.',
    details: { reason: NAME_CHECK_CONFLICT_REASONS.NAME_CHECK_RUNNING, ...(checkId ? { checkId } : {}) },
  });
}

/** 409 unless the transcript has a transcript to check — the operations endpoint's rule. */
function assertReady(transcript: { status: string; currentVersion: number }): void {
  if (transcript.status === 'deleting') throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);
  if (transcript.currentVersion < 1 || transcript.status !== 'ready') {
    throw new ConflictException({
      message:
        'This transcript has no transcript yet — wait for transcription to finish before checking names.',
      details: { reason: NAME_CHECK_CONFLICT_REASONS.TRANSCRIPT_NOT_READY },
    });
  }
}

/**
 * The names a check looks for: the selected speakers' display names (generic
 * labels like "Speaker A" skipped), the caller's own terms, and the keyterms
 * given at upload — de-duplicated case-insensitively, first spelling wins.
 */
export function resolveTerms(input: {
  speakers: readonly NameCheckSpeaker[];
  speakerIds?: readonly string[];
  terms?: readonly string[];
  providerOptions: unknown;
}): string[] {
  let speakers = input.speakers;
  if (input.speakerIds && input.speakerIds.length > 0) {
    const known = new Set(input.speakers.map((s) => s.id));
    const unknown = input.speakerIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown speaker id(s) for this transcript: ${unknown.join(', ')}`);
    }
    const wanted = new Set(input.speakerIds);
    speakers = input.speakers.filter((s) => wanted.has(s.id));
  }

  const names = speakers
    .map((s) => s.displayName.trim())
    .filter((name, i) => {
      const label = speakers[i]!.label;
      return name.length > 1 && !GENERIC_SPEAKER.test(name) && (label === null || name !== label);
    });

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...names, ...(input.terms ?? []), ...readKeyterms(input.providerOptions)]) {
    const term = raw.trim().replace(/\s+/g, ' ');
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

export function toRunView(run: TranscriptNameCheck) {
  return {
    id: run.id,
    transcriptId: run.transcriptId,
    mode: run.mode,
    status: run.status,
    basedOnVersion: run.basedOnVersion,
    terms: readTerms(run.terms),
    providerId: run.providerId,
    model: run.model,
    candidateCount: run.candidateCount,
    suggestionCount: run.suggestionCount,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    errorClass: run.errorClass,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}
