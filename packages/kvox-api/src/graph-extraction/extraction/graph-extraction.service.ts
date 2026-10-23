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

import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, Inject, Optional } from '@nestjs/common';

import { GraphAiRunResolver, isUniqueViolation, GRAPH_CONFLICT_REASONS, KG_EXTRACT_JOB_TYPE, KG_SUBJECT_NOTE, GraphOntologyService, GraphPreferencesService, GRAPH_WRITE_PERMISSION } from '../../graph/index.js';
import type { GraphAiRun, KvoxGraphDb, GraphActor, InputJsonValue } from '../../graph/index.js';
import { NOTE_NOT_FOUND_MESSAGE, NoteAccessService, NoteLibraryPolicy, type NoteRow as Note } from '../../notes/index.js';
import { budgetRefusalMessage, computeTokenBudget, outputTokensForPrompt, type TokenBudget, Prisma } from '../../core/index.js';
import type { ExtractionStats } from '../proposals/proposal-payload.schema.js';
import type {
  ExtractionEstimate,
  RequestExtractionDto,
  RequestExtractionResponse,
  UserGuidance,
} from './dto/extraction.dto.js';
import { buildExtractionContext, type ExtractionContext } from './extraction-context.js';
import { ExtractionInputLoader } from './extraction-input.loader.js';
import { buildExtractionOutputSchema } from './output-schema.js';
import { assembleExtractionPrompt, type ExtractionPrompt } from './prompt.js';
import { extractionRowCaps, type ExtractionRowCaps } from './row-caps.js';
import {
  KVOX_AUDIT,
  KVOX_IDENTITY,
  KVOX_JOBS,
  KVOX_PRISMA,
  type KvoxAuditPort,
  type KvoxIdentityPort,
  type KvoxJobsPort,
} from '../../ports/index.js';

/** Queue priority (§11): ahead of housekeeping, behind a watched export. */
export const KG_EXTRACT_PRIORITY = -5;

/**
 * Queue priority of a bulk (library import / reconcile) extraction: behind imports and search
 * indexing, which run first (ADR-0007). Ascending is more urgent.
 *
 * @stability experimental
 */
export const KG_EXTRACT_BULK_PRIORITY = 50;

/**
 * How a ready note reached the graph hook.
 *
 * @stability experimental
 */
export interface EnqueueForReadyNoteOptions {
  /** One of many created by a bulk import: queued at {@link KG_EXTRACT_BULK_PRIORITY}. */
  bulk?: boolean;
  /** Where the note came from (`NoteReadyEvent.origin`). */
  origin?: 'generation' | 'import' | 'library';
  /** A person asked (retry): skip the auto-extract preference and the library switch. */
  explicit?: boolean;
}

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
  resolution: Pick<GraphAiRun, 'countTokens'>,
  prompt: { systemPrompt: string; userContent: string },
  schema: Record<string, unknown>,
): number {
  return resolution.countTokens(`${prompt.systemPrompt}\n${prompt.userContent}\n${JSON.stringify(schema)}`);
}

/**
 * The budget for one resolution (#436): the model's OWN limits
 * (`modelLimits`), the deployment's
 * optional spend caps, an optional per-task answer clamp, and the reasoning
 * effort this resolution will actually send. A call whose prompt can be large
 * requests `outputTokensForPrompt(budget, promptTokens)`, not
 * `budget.maxOutputTokens`.
 */
export function extractionBudget(
  resolution: Pick<GraphAiRun, 'modelLimits' | 'policy'> & Partial<Pick<GraphAiRun, 'reasoningEffort'>>,
  taskMaxOutputTokens?: number,
): TokenBudget {
  return computeTokenBudget({
    contextWindowTokens: resolution.modelLimits.contextWindowTokens,
    modelMaxOutputTokens: resolution.modelLimits.maxOutputTokens,
    policyMaxOutputTokens: resolution.policy.maxOutputTokens,
    policyMaxInputTokens: resolution.policy.maxInputTokens,
    taskMaxOutputTokens,
    reasoningEffort: resolution.reasoningEffort ?? resolution.policy.reasoningEffort,
  });
}

/** Everything one extraction call sends, sized together (#435/#436). */
export interface ExtractionPlan {
  prompt: ExtractionPrompt;
  schema: Record<string, unknown>;
  caps: ExtractionRowCaps;
  budget: TokenBudget;
  /** `measurePrompt` over `prompt` + `schema`. */
  promptTokens: number;
  /** What the call requests: `outputTokensForPrompt(budget, promptTokens)`. */
  maxOutputTokens: number;
}

/**
 * Plan one extraction call: the budget, the row caps sized from the output
 * the call will ACTUALLY be given (#435 — the ceiling shrunk to what the
 * window leaves for this prompt, #436), and the prompt and schema carrying
 * those caps. The estimate and the job both call this, so what a user is told
 * a run costs is what it sends. `capsOverride` is the truncation re-ask's
 * halved caps.
 */
export function planExtraction(
  resolution: Pick<GraphAiRun, 'modelLimits' | 'policy' | 'countTokens'> &
    Partial<Pick<GraphAiRun, 'reasoningEffort'>>,
  ctx: ExtractionContext,
  capsOverride?: ExtractionRowCaps,
): ExtractionPlan {
  const budget = extractionBudget(resolution);
  const effort = resolution.reasoningEffort ?? resolution.policy.reasoningEffort;

  const assemble = (caps: ExtractionRowCaps) => {
    const prompt = assembleExtractionPrompt(ctx, caps);
    const schema = buildExtractionOutputSchema(ctx, caps);
    return { caps, prompt, schema, promptTokens: measurePrompt(resolution, prompt, schema) };
  };

  let planned = assemble(capsOverride ?? extractionRowCaps(budget.maxOutputTokens, effort));
  const room = outputTokensForPrompt(budget, planned.promptTokens);
  if (!capsOverride && room < budget.maxOutputTokens) {
    // A large prompt leaves less than the ceiling: size the rows for what the
    // call will really get. Only the numbers in the prompt change.
    planned = assemble(extractionRowCaps(room, effort));
  }

  return {
    ...planned,
    budget,
    maxOutputTokens: outputTokensForPrompt(budget, planned.promptTokens),
  };
}

/**
 * GraphExtractionService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphExtractionService {
  private readonly logger = new Logger(GraphExtractionService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly notes: NoteAccessService,
    private readonly resolver: GraphAiRunResolver,
    private readonly preferences: GraphPreferencesService,
    private readonly ontology: GraphOntologyService,
    private readonly loader: ExtractionInputLoader,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_AUDIT) private readonly auditPort: KvoxAuditPort,
    @Inject(KVOX_IDENTITY) private readonly identity: KvoxIdentityPort,
    @Optional() private readonly libraryPolicy?: NoteLibraryPolicy,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /api/graph/notes/:noteId/extract
  // ---------------------------------------------------------------------------

  /**
   * Request.
   */
  async request(user: GraphActor, noteId: string, dto: RequestExtractionDto): Promise<RequestExtractionResponse> {
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

  /**
   * Estimate.
   */
  async estimate(user: GraphActor, noteId: string, model?: string): Promise<ExtractionEstimate> {
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
  async enqueueForReadyNote(noteId: string, ownerId: string, options: EnqueueForReadyNoteOptions = {}): Promise<string | null> {
    if (!(await this.canExtractFor(ownerId, options.explicit === true))) return null;

    // A library note follows its library's switch (ADR-0007). A library file whose note link is
    // not stored yet is left to the reconcile job, which only runs for `auto_extract` libraries.
    if (options.explicit !== true && this.libraryPolicy && (options.bulk === true || options.origin === 'library')) {
      const policy = await this.libraryPolicy.forNote(noteId);
      if (policy ? !policy.autoExtract : options.origin === 'library') return null;
    }

    let resolution: GraphAiRun;
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
      const proposal = await this.createProposal({
        userId: ownerId,
        note,
        resolution,
        guidance: null,
        reason: 'note_ready',
        bulk: options.bulk === true,
      });
      return proposal.id;
    } catch (error) {
      if (error instanceof ConflictException) return null; // already running
      throw error;
    }
  }

  /**
   * The gate every automatic extraction passes for an owner: the deployment's graph switch, their
   * `graph:write` and (unless a person asked) their `extraction.autoExtract` preference. The reconcile
   * job asks it once before looping over notes.
   */
  async canExtractFor(ownerId: string, explicit = false): Promise<boolean> {
    if (!(await this.resolver.graphEnabled())) return false;

    // The owner's EFFECTIVE permissions, through the host's identity port: a Contributor or
    // Viewer holds `graph:write` through the membership, not through a system role (#465).
    const holder = await this.identity.hasPermission(ownerId, GRAPH_WRITE_PERMISSION);
    if (!holder) return false;
    if (explicit) return true;

    const prefs = await this.preferences.get(ownerId);
    return prefs.extraction.autoExtract;
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
    resolution: GraphAiRun,
    userId: string,
    note: Note,
    guidance: UserGuidance | null,
  ): Promise<ExtractionEstimate> {
    const input = await this.loader.load({ userId, noteId: note.id, noteVersion: note.currentVersion, guidance });
    const plan = planExtraction(resolution, buildExtractionContext(input));
    const inputTokens = plan.promptTokens;
    return {
      providerId: resolution.providerId,
      model: resolution.model,
      inputTokens,
      // What the run would actually request for THIS prompt (#436).
      maxOutputTokens: plan.maxOutputTokens,
      availableInputTokens: plan.budget.availableInputTokens,
      fits: inputTokens <= plan.budget.availableInputTokens,
      requests: 1,
      keyConfigured: resolution.keyConfigured,
    };
  }

  /** Proposal (`extracting`) + job, one transaction. A running extraction is a 409. */
  private async createProposal(args: {
    userId: string;
    note: Note;
    resolution: GraphAiRun;
    guidance: UserGuidance | null;
    reason: ExtractionReason;
    bulk?: boolean;
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
            userGuidance: guidance ? (guidance as unknown as InputJsonValue) : Prisma.DbNull,
            stats: initialExtractionStats() as unknown as InputJsonValue,
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
          priority: args.bulk === true ? KG_EXTRACT_BULK_PRIORITY : KG_EXTRACT_PRIORITY,
          payload: payload as unknown as Record<string, unknown>,
        });
        return tx.kgProposal.update({ where: { id: created.id }, data: { jobId: job.id } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // `kg_proposals_note_extracting_uniq_idx`, or the job's own active
        // dedup key — either way an extraction of this note is in flight.
        throw new ConflictException({
          message: 'An extraction of this note is already running.',
          details: { reason: GRAPH_CONFLICT_REASONS.EXTRACTION_RUNNING },
        });
      }
      throw error;
    }

    await this.auditPort.record({
      actorUserId: userId,
      action: 'graph.extraction_requested',
      targetType: 'note',
      targetId: note.id,
      meta: { proposalId: proposal.id, model: resolution.model, reason, guidance: guidance !== null },
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
