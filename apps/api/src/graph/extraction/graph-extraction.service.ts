// =============================================================================
// GraphExtractionService (#363, epic #346; docs/specs/ontology.md §6, §8, §12, §20)
// =============================================================================
//
// The two ways a `kg.extract` run starts, and the estimate:
//
//   - `request()` — `POST /api/graph/notes/:noteId/extract`: a person asks.
//   - `enqueueForReadyNote()` — the hook `NoteGenerationService.commit()` calls
//     once a note is `ready`. Silently a no-op unless every gate is open; it
//     never throws into note generation (the caller catches as well).
//   - `estimate()` — what a run would cost, counted over the exact prompt the
//     run would send. Needs no key.
//
// THE PROPOSAL IS CREATED HERE, NOT IN THE JOB (§8): the endpoint returns an id
// the UI can poll, and `extraction_running` is decided by #351's partial unique
// index `kg_proposals_note_extracting_uniq_idx` at INSERT — never a `findFirst`
// before it. The proposal and its job are written in one transaction.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Note } from '@prisma/client';

import type { AiModelResolution } from '../../ai/ai-task-model-resolver.service';
import { AiTaskModelResolver } from '../../ai/ai-task-model-resolver.service';
import { AiSettingsService } from '../../ai/ai-settings.service';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { JobsService } from '../../jobs/jobs.service';
import { NOTE_NOT_FOUND_MESSAGE, NoteAccessService } from '../../notes/access/note-access.service';
import { budgetRefusalMessage, computeTokenBudget } from '../../notes/generation/token-budget';
import { PrismaService } from '../../prisma/prisma.service';
import { GRAPH_CONFLICT_REASONS } from '../graph-conflict-reasons';
import { KG_EXTRACT_JOB_TYPE, KG_SUBJECT_NOTE } from '../job-types';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import { GraphPreferencesService } from '../preferences/graph-preferences.service';
import type { ExtractionStats } from '../proposals/proposal-payload.schema';
import type {
  ExtractionEstimate,
  RequestExtractionDto,
  RequestExtractionResponse,
  UserGuidance,
} from './dto/extraction.dto';
import { buildExtractionContext } from './extraction-context';
import { ExtractionInputLoader } from './extraction-input.loader';
import { buildExtractionOutputSchema } from './output-schema';
import { assembleExtractionPrompt } from './prompt';

/** Queue priority (§11): ahead of housekeeping, behind a watched export. */
export const KG_EXTRACT_PRIORITY = -5;

export type ExtractionReason = 'note_ready' | 'user_request';

/** What the job's payload carries — identifiers only. */
export interface KgExtractPayload {
  proposalId: string;
  noteId: string;
  noteVersion: number;
  userId: string;
  model: string;
  reason: ExtractionReason;
}

export const NOTE_NOT_READY_MESSAGE =
  'This note is not ready yet. Extraction reads a finished note; try again once it has been generated.';

/** The stats a proposal starts with. */
export function initialExtractionStats(): ExtractionStats {
  return {
    phase: 'extracting',
    proposed: { entities: 0, relations: 0, items: 0 },
    dropped: { uncited: 0, invalid: 0, unknownType: 0, dangling: 0 },
    quoteNotLocated: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/**
 * Tokens one prompt measures: system prompt, user content and the output
 * schema (sent with the request) — the same count the handler budgets with.
 */
export function measurePrompt(
  resolution: Pick<AiModelResolution, 'countTokens'>,
  prompt: { systemPrompt: string; userContent: string },
  schema: Record<string, unknown>,
): number {
  return resolution.countTokens(`${prompt.systemPrompt}\n${prompt.userContent}\n${JSON.stringify(schema)}`);
}

/** The budget for one resolution, from the model descriptor and the policy. */
export function extractionBudget(resolution: Pick<AiModelResolution, 'descriptor' | 'policy'>) {
  return computeTokenBudget({
    contextWindowTokens: resolution.descriptor.contextWindowTokens,
    modelMaxOutputTokens: resolution.descriptor.maxOutputTokens,
    policyMaxOutputTokens: resolution.policy.maxOutputTokens,
    policyMaxInputTokens: resolution.policy.maxInputTokens,
  });
}

@Injectable()
export class GraphExtractionService {
  private readonly logger = new Logger(GraphExtractionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notes: NoteAccessService,
    private readonly resolver: AiTaskModelResolver,
    private readonly aiSettings: AiSettingsService,
    private readonly preferences: GraphPreferencesService,
    private readonly ontology: GraphOntologyService,
    private readonly loader: ExtractionInputLoader,
    private readonly jobs: JobsService,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /api/graph/notes/:noteId/extract
  // ---------------------------------------------------------------------------

  async request(user: RequestUser, noteId: string, dto: RequestExtractionDto): Promise<RequestExtractionResponse> {
    const note = await this.requireOwnNote(user.id, noteId);
    // A ready note always has a version; one without is not extractable yet.
    if (note.status !== 'ready' || note.currentVersion < 1) {
      throw new ConflictException({
        message: NOTE_NOT_READY_MESSAGE,
        details: { reason: GRAPH_CONFLICT_REASONS.NOTE_NOT_READY },
      });
    }

    const resolution = await this.resolver.resolve(user.id, 'graph.extract', dto.model ?? null);
    const guidance = normalizeGuidance(dto.userGuidance);
    await this.assertGuidanceValid(user.id, guidance);

    const estimate = await this.estimateFor(resolution, user.id, note, guidance);
    if (!estimate.fits) {
      throw new BadRequestException({
        message: budgetRefusalMessage({
          promptTokens: estimate.inputTokens,
          availableInputTokens: estimate.availableInputTokens,
          model: resolution.model,
        }),
        details: {
          promptTokens: estimate.inputTokens,
          availableInputTokens: estimate.availableInputTokens,
          model: resolution.model,
        },
      });
    }

    const proposal = await this.createProposal({
      userId: user.id,
      note,
      resolution,
      guidance,
      reason: 'user_request',
    });

    return {
      proposal: {
        id: proposal.id,
        noteId: note.id,
        noteVersion: proposal.noteVersion as number,
        status: 'extracting',
        model: resolution.model,
        providerId: resolution.providerId,
        createdAt: proposal.createdAt.toISOString(),
      },
      estimate,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /api/graph/extract/estimate
  // ---------------------------------------------------------------------------

  async estimate(user: RequestUser, noteId: string, model?: string): Promise<ExtractionEstimate> {
    const note = await this.requireOwnNote(user.id, noteId);
    const resolution = await this.resolver.resolve(user.id, 'graph.extract', model ?? null, { requireKey: false });
    // Guidance is excluded: at most 2,000 characters, stated in the field description.
    return this.estimateFor(resolution, user.id, note, null);
  }

  // ---------------------------------------------------------------------------
  // The note-ready hook
  // ---------------------------------------------------------------------------

  /**
   * Queue an automatic extraction for a note that just became `ready`, when —
   * and only when — `ai.graphEnabled` is on, the owner holds `graph:write`,
   * their `extraction.autoExtract` preference is on, `graph.extract` resolves
   * for them (a 409/400 there is swallowed at `debug`), and no extraction for
   * this note is already running. Returns the proposal id, or null.
   */
  async enqueueForReadyNote(noteId: string, ownerId: string): Promise<string | null> {
    const policy = await this.aiSettings.get();
    if (!policy.graphEnabled) return null;

    const holder = await this.prisma.user.findFirst({
      where: {
        id: ownerId,
        isActive: true,
        userRoles: {
          some: { role: { rolePermissions: { some: { permission: { name: PERMISSIONS.GRAPH_WRITE } } } } },
        },
      },
      select: { id: true },
    });
    if (!holder) return null;

    const prefs = await this.preferences.get(ownerId);
    if (!prefs.extraction.autoExtract) return null;

    let resolution: AiModelResolution;
    try {
      resolution = await this.resolver.resolve(ownerId, 'graph.extract');
    } catch (error) {
      if (error instanceof HttpException) {
        this.logger.debug(`kg.extract auto-enqueue skipped for note ${noteId}: ${describeHttp(error)}`);
        return null;
      }
      throw error;
    }

    const note = await this.prisma.note.findUnique({ where: { id: noteId } });
    if (!note || note.ownerId !== ownerId || note.deletedAt !== null || note.status !== 'ready' || note.currentVersion < 1) {
      return null;
    }

    try {
      const proposal = await this.createProposal({ userId: ownerId, note, resolution, guidance: null, reason: 'note_ready' });
      return proposal.id;
    } catch (error) {
      if (error instanceof ConflictException) return null; // already running
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** The note, or the same 404 for missing, deleted and not-yours. */
  private async requireOwnNote(userId: string, noteId: string): Promise<Note> {
    // `view` with an explicit owner check, rather than `own`: `own` would also
    // demand `notes:write`, a permission this graph action does not need —
    // extracting reads the note, it never changes it.
    const { note, role } = await this.notes.require(userId, noteId, 'view');
    if (role !== 'owner' || note.status === 'deleting') throw new NotFoundException(NOTE_NOT_FOUND_MESSAGE);
    return note;
  }

  /** 400 for type keys outside the effective schema and pins that are not live entities of yours. */
  private async assertGuidanceValid(userId: string, guidance: UserGuidance | null): Promise<void> {
    if (!guidance) return;
    const schema = await this.ontology.effectiveSchemaFor(userId);
    const unknownTypes = [
      ...(guidance.entityTypes ?? []).filter((k) => !schema.entityType(k)),
      ...(guidance.relationTypes ?? []).filter((k) => !schema.relationType(k)),
    ];
    if (unknownTypes.length > 0) {
      throw new BadRequestException({
        message: `Unknown type${unknownTypes.length === 1 ? '' : 's'} in your guidance: ${unknownTypes.join(', ')}.`,
        details: { unknownTypes },
      });
    }
    const pins = [...new Set(guidance.pinnedEntityIds)];
    if (pins.length > 0) {
      const live = await this.prisma.kgEntity.findMany({
        where: { id: { in: pins }, ownerId: userId, mergedIntoId: null, reviewStatus: { in: ['accepted', 'edited'] } },
        select: { id: true },
      });
      const found = new Set(live.map((e) => e.id));
      const invalidPinnedIds = pins.filter((id) => !found.has(id));
      if (invalidPinnedIds.length > 0) {
        throw new BadRequestException({
          message: 'Some pinned entities are not live entities in your graph.',
          details: { invalidPinnedIds },
        });
      }
    }
  }

  private async estimateFor(
    resolution: AiModelResolution,
    userId: string,
    note: Note,
    guidance: UserGuidance | null,
  ): Promise<ExtractionEstimate> {
    const input = await this.loader.load({ userId, noteId: note.id, noteVersion: note.currentVersion, guidance });
    const ctx = buildExtractionContext(input);
    const prompt = assembleExtractionPrompt(ctx);
    const inputTokens = measurePrompt(resolution, prompt, buildExtractionOutputSchema(ctx));
    const budget = extractionBudget(resolution);
    return {
      providerId: resolution.providerId,
      model: resolution.model,
      inputTokens,
      maxOutputTokens: budget.maxOutputTokens,
      availableInputTokens: budget.availableInputTokens,
      fits: inputTokens <= budget.availableInputTokens,
      requests: 1,
      keyConfigured: resolution.keyConfigured,
    };
  }

  /** Proposal (`extracting`) + job, one transaction. A running extraction is a 409. */
  private async createProposal(args: {
    userId: string;
    note: Note;
    resolution: AiModelResolution;
    guidance: UserGuidance | null;
    reason: ExtractionReason;
  }) {
    const { userId, note, resolution, guidance, reason } = args;
    let proposal;
    try {
      proposal = await this.prisma.$transaction(async (tx) => {
        const created = await tx.kgProposal.create({
          data: {
            ownerId: userId,
            kind: 'extraction',
            status: 'extracting',
            noteId: note.id,
            noteVersion: note.currentVersion,
            model: resolution.model,
            provider: resolution.providerId,
            userGuidance: guidance ? (guidance as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            stats: initialExtractionStats() as unknown as Prisma.InputJsonValue,
          },
        });
        const payload: KgExtractPayload = {
          proposalId: created.id,
          noteId: note.id,
          noteVersion: note.currentVersion,
          userId,
          model: resolution.model,
          reason,
        };
        const job = await this.jobs.enqueueWithin(tx, {
          type: KG_EXTRACT_JOB_TYPE,
          reason: reason === 'note_ready' ? 'upload' : 'rerun',
          subjectType: KG_SUBJECT_NOTE,
          subjectId: note.id,
          priority: KG_EXTRACT_PRIORITY,
          payload: payload as unknown as Prisma.InputJsonValue,
        });
        return tx.kgProposal.update({ where: { id: created.id }, data: { jobId: job.id } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // `kg_proposals_note_extracting_uniq_idx`, or the job's own active
        // dedup key — either way an extraction of this note is in flight.
        throw new ConflictException({
          message: 'An extraction of this note is already running.',
          details: { reason: GRAPH_CONFLICT_REASONS.EXTRACTION_RUNNING },
        });
      }
      throw error;
    }

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'graph.extraction_requested',
        targetType: 'note',
        targetId: note.id,
        meta: { proposalId: proposal.id, model: resolution.model, reason, guidance: guidance !== null },
      },
    });
    return proposal;
  }
}

/** Guidance that asks for nothing is no guidance. */
function normalizeGuidance(guidance: UserGuidance | undefined): UserGuidance | null {
  if (!guidance) return null;
  return {
    pinnedEntityIds: guidance.pinnedEntityIds ?? [],
    ...(guidance.entityTypes !== undefined ? { entityTypes: guidance.entityTypes } : {}),
    ...(guidance.relationTypes !== undefined ? { relationTypes: guidance.relationTypes } : {}),
    instructions: guidance.instructions ?? '',
  };
}

function describeHttp(error: HttpException): string {
  const body = error.getResponse() as { details?: { reason?: string } } | string;
  const reason = typeof body === 'object' ? body.details?.reason : undefined;
  return `${error.getStatus()}${reason ? ` ${reason}` : ''}`;
}
