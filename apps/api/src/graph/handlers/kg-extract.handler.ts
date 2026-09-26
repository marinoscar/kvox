// =============================================================================
// kg.extract (#363, epic #346; docs/specs/ontology.md §6, §8, §11, §20)
// =============================================================================
//
// One note in, one DRAFT PROPOSAL out — nothing in the graph until a person
// commits it (#366).
//
//   load → resolve the model (the payload's model, RE-VALIDATED against today's
//   policy) → budget → record the prompt on the proposal BEFORE the call →
//   register the per-user throttle key → ONE `generateStructured` call →
//   validate → persist items + evidence → run the registered stages in order →
//   pre-check → `extracting → draft`, superseding an older draft.
//
//   profile       { maxRuntimeMs: 10 min, maxAttempts: 1 } — a retry would
//                 re-spend the user's own key for a DIFFERENT, non-deterministic
//                 answer; re-extracting is a person pressing a button
//   node-eligible NO — no `nodeResultSchema`/`persistNodeResult`: the credential
//                 is the user's long-lived vendor key and no vendor offers a
//                 job-scoped sub-key (the `note.generate` argument)
//   throttle      `aiProviderThrottleKey(userId)`, registered immediately before
//                 the provider call — per user, never a shared bucket
//   subject       note / noteId, ordinary dedup
//
// Failure mapping: `RateLimitError` is rethrown (the queue defers without
// charging an attempt; the proposal stays `extracting`); an auth / refusal /
// budget / invalid-output failure — or a configuration refusal from the
// resolver — marks the proposal `failed` with `stats.failure` and the job
// RETURNS; anything else marks it `failed` and rethrows.
//
// ⚠ Logs carry ids, counts and the model id only — never note text, quotes,
// names or prompts.
// =============================================================================

import { HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import {
  AiAuthError,
  AiBudgetError,
  AiInputError,
  AiRefusedError,
  AiStructuredOutputError,
} from '../../ai/ai-errors';
import { AiTaskModelResolver, type AiModelResolution } from '../../ai/ai-task-model-resolver.service';
import { createProviderContext } from '../../ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { aiProviderThrottleKey } from '../../notes/job-types';
import { assertWithinBudget } from '../../notes/generation/token-budget';
import { PrismaService } from '../../prisma/prisma.service';
import { buildExtractionContext } from '../extraction/extraction-context';
import { ExtractionInputLoader } from '../extraction/extraction-input.loader';
import {
  extractionBudget,
  initialExtractionStats,
  measurePrompt,
} from '../extraction/graph-extraction.service';
import { EXTRACTION_SCHEMA_NAME, buildExtractionOutputSchema } from '../extraction/output-schema';
import { applyPrecheck, type PrecheckItem } from '../extraction/precheck';
import { ProposalStageRegistry } from '../extraction/proposal-stage';
import { ProposalWriter } from '../extraction/proposal-writer.service';
import { assembleExtractionPrompt } from '../extraction/prompt';
import { addDeterministicRows, validateExtraction } from '../extraction/validate';
import { KG_EXTRACT_JOB_TYPE } from '../job-types';
import { GraphPreferencesService } from '../preferences/graph-preferences.service';
import type {
  ExtractionFailureClass,
  ExtractionStats,
  ProposalResolution,
} from '../proposals/proposal-payload.schema';

export const KG_EXTRACT_MAX_RUNTIME_MS = 10 * 60_000;

const payloadSchema = z.object({
  proposalId: z.guid(),
  noteId: z.guid(),
  noteVersion: z.number().int().min(1),
  userId: z.guid(),
  model: z.string().min(1),
  reason: z.enum(['note_ready', 'user_request']),
});

export type KgExtractJobPayload = z.infer<typeof payloadSchema>;

export function readKgExtractPayload(payload: unknown): KgExtractJobPayload | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** A terminal outcome: the proposal is `failed`, the job returns. */
class TerminalExtractionError extends Error {
  constructor(
    readonly errorClass: ExtractionFailureClass,
    message: string,
  ) {
    super(message);
  }
}

/** A stage threw something other than a rate limit. */
class StageError extends Error {
  constructor(
    readonly stage: string,
    readonly cause: unknown,
  ) {
    super(`The '${stage}' step failed.`);
  }
}

/** Which failure class a thrown value belongs to. Total; never throws. */
export function classifyExtractionError(error: unknown): ExtractionFailureClass {
  if (error instanceof TerminalExtractionError) return error.errorClass;
  if (error instanceof AiAuthError) return 'auth';
  if (error instanceof AiBudgetError) return 'budget';
  if (error instanceof AiStructuredOutputError) return 'invalid_output';
  if (error instanceof AiRefusedError || error instanceof AiInputError) return 'refusal';
  return 'other';
}

/** The sentence stored on the proposal. Never an arbitrary thrown message. */
function describeFailure(error: unknown): string {
  if (error instanceof StageError) return `Extraction failed in the '${error.stage}' step.`;
  if (
    error instanceof TerminalExtractionError ||
    error instanceof AiAuthError ||
    error instanceof AiBudgetError ||
    error instanceof AiRefusedError ||
    error instanceof AiInputError ||
    error instanceof AiStructuredOutputError
  ) {
    return error.message;
  }
  return 'Extraction failed because of an unexpected error.';
}

@Injectable()
export class KgExtractHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(KgExtractHandler.name);

  readonly type = KG_EXTRACT_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: KG_EXTRACT_MAX_RUNTIME_MS, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly loader: ExtractionInputLoader,
    private readonly resolver: AiTaskModelResolver,
    private readonly credentials: UserAiCredentialsService,
    private readonly throttle: ProviderThrottleService,
    private readonly writer: ProposalWriter,
    private readonly stages: ProposalStageRegistry,
    private readonly preferences: GraphPreferencesService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = readKgExtractPayload(job.payload);
    if (!payload) {
      this.logger.warn(`${KG_EXTRACT_JOB_TYPE} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }
    const proposal = await this.prisma.kgProposal.findUnique({
      where: { id: payload.proposalId },
      select: { id: true, status: true, ownerId: true, stats: true },
    });
    if (!proposal || proposal.status !== 'extracting' || proposal.ownerId !== payload.userId) {
      this.logger.log(`${KG_EXTRACT_JOB_TYPE} proposal ${payload.proposalId} is not extracting; job ${job.id} is a no-op`);
      return;
    }

    const stats: ExtractionStats = { ...initialExtractionStats() };
    try {
      await this.extract(payload, stats);
    } catch (error) {
      if (error instanceof RateLimitError) throw error;

      const errorClass =
        error instanceof HttpException ? (isKeyMissing(error) ? 'auth' : 'refusal') : classifyExtractionError(error);
      const message = error instanceof HttpException ? httpMessage(error) : describeFailure(error);
      await this.writer.markFailed(payload.proposalId, stats, { errorClass, message });

      if (error instanceof StageError) {
        this.logger.warn(
          `${KG_EXTRACT_JOB_TYPE} proposal=${payload.proposalId}: stage '${error.stage}' failed: ` +
            `${error.cause instanceof Error ? error.cause.name : 'error'}`,
        );
        throw error.cause instanceof Error ? error.cause : error;
      }
      if (errorClass === 'other' && !(error instanceof HttpException) && !(error instanceof TerminalExtractionError)) {
        throw error;
      }
    }
  }

  private async extract(payload: KgExtractJobPayload, stats: ExtractionStats): Promise<void> {
    const started = Date.now();
    const { userId, noteId, proposalId } = payload;

    const note = await this.prisma.note.findUnique({
      where: { id: noteId },
      select: { id: true, ownerId: true, deletedAt: true, status: true },
    });
    if (!note || note.ownerId !== userId || note.deletedAt !== null || note.status === 'deleting') {
      throw new TerminalExtractionError('other', 'The note was deleted before it could be extracted.');
    }

    // Re-validated: an administrator may have narrowed the permitted models
    // since the request, and a user never reaches a model policy refuses.
    const resolution = await this.resolver.resolve(userId, 'graph.extract', payload.model);

    const guidanceRow = await this.prisma.kgProposal.findUnique({
      where: { id: proposalId },
      select: { userGuidance: true },
    });
    const guidance = (guidanceRow?.userGuidance ?? null) as KgExtractGuidance | null;

    const input = await this.loader.load({ userId, noteId, noteVersion: payload.noteVersion, guidance });
    const ctx = buildExtractionContext(input);
    const prompt = assembleExtractionPrompt(ctx);
    const schema = buildExtractionOutputSchema(ctx);

    // Recorded BEFORE anything can fail on the provider side.
    await this.writer.recordPrompt(proposalId, {
      model: resolution.model,
      provider: resolution.providerId,
      systemPrompt: prompt.systemPrompt,
      userContent: prompt.userContent,
    });

    const budget = extractionBudget(resolution);
    const promptTokens = measurePrompt(resolution, prompt, schema);
    assertWithinBudget({
      promptTokens,
      availableInputTokens: budget.availableInputTokens,
      model: resolution.model,
      providerId: resolution.providerId,
    });

    const result = await this.callProvider(resolution, userId, {
      systemPrompt: prompt.systemPrompt,
      userContent: prompt.userContent,
      schema,
      maxOutputTokens: budget.maxOutputTokens,
    });
    stats.usage = { inputTokens: result.usage.promptTokens, outputTokens: result.usage.completionTokens };

    const validated = validateExtraction(result.value, ctx);
    if (!validated.ok) throw new TerminalExtractionError('invalid_output', validated.message);
    const withMeeting = addDeterministicRows(ctx, validated);
    stats.proposed = withMeeting.stats.proposed;
    stats.dropped = withMeeting.stats.dropped;
    stats.quoteNotLocated = withMeeting.stats.quoteNotLocated;

    await this.writer.writeItems(proposalId, userId, withMeeting.rows, stats);

    // Stages, in order. Each sees the items as the previous one left them.
    const preferences = await this.preferences.get(userId);
    for (const stage of this.stages.ordered()) {
      const stageStats: Record<string, unknown> = {};
      try {
        await stage.run({ proposalId, userId, noteId, preferences, ai: null, prisma: this.prisma, stats: stageStats });
      } catch (error) {
        if (error instanceof RateLimitError) throw error;
        throw new StageError(stage.name, error);
      }
      stats[stage.name] = stageStats;
    }

    // Pre-check over the final rows.
    const items = await this.prisma.kgProposalItem.findMany({
      where: { proposalId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, kind: true, payload: true, resolution: true, flags: true, decision: true },
    });
    const precheck: Array<PrecheckItem & { id: string }> = items.map((item) => ({
      id: item.id,
      kind: item.kind,
      payload: (item.payload ?? {}) as Record<string, unknown>,
      resolution: (item.resolution ?? null) as ProposalResolution | null,
      flags: item.flags,
      decision: item.decision,
    }));
    applyPrecheck(precheck, preferences);

    stats.phase = 'ready';
    const finalized = await this.writer.finalize(
      proposalId,
      noteId,
      precheck.map((p) => ({ id: p.id, decision: p.decision === 'accept' ? 'accept' : 'pending' })),
      stats,
    );
    if (!finalized) {
      this.logger.log(`${KG_EXTRACT_JOB_TYPE} proposal=${proposalId} left 'extracting' while running; not finalized`);
      return;
    }

    this.logger.log(
      `${KG_EXTRACT_JOB_TYPE} proposal=${proposalId} note=${noteId} model=${resolution.model} ` +
        `entities=${stats.proposed.entities} relations=${stats.proposed.relations} items=${stats.proposed.items} ` +
        `dropped=${JSON.stringify(stats.dropped)} inputTokens=${stats.usage.inputTokens} ms=${Date.now() - started}`,
    );
  }

  private async callProvider(
    resolution: AiModelResolution,
    userId: string,
    request: { systemPrompt: string; userContent: string; schema: Record<string, unknown>; maxOutputTokens: number },
  ) {
    const provider = resolution.provider;
    if (typeof provider.generateStructured !== 'function') {
      throw new AiInputError(
        `The "${provider.id}" provider cannot return structured output, which graph extraction needs.`,
        undefined,
        provider.id,
      );
    }
    const settings = provider.settingsSchema.safeParse(
      (resolution.policy.providers as Record<string, unknown>)[provider.id] ?? {},
    );
    if (!settings.success) {
      throw new AiInputError(
        `This deployment's configuration for provider "${provider.id}" is invalid. An administrator must correct it.`,
        undefined,
        provider.id,
      );
    }
    const apiKey = await this.credentials.getSecret(userId, provider.id);
    if (!apiKey) {
      throw new AiAuthError(
        `No ${provider.label} API key is saved for your account. Add one in your settings and extract again.`,
        provider.id,
      );
    }

    this.throttle.registerProviderKey(this.type, aiProviderThrottleKey(userId));

    return provider.generateStructured(createProviderContext(apiKey, settings.data as never), {
      model: resolution.model,
      systemPrompt: request.systemPrompt,
      userContent: request.userContent,
      schema: request.schema,
      schemaName: EXTRACTION_SCHEMA_NAME,
      maxOutputTokens: request.maxOutputTokens,
      timeoutMs: resolution.policy.requestTimeoutMs,
      reasoningEffort: resolution.reasoningEffort,
    });
  }
}

type KgExtractGuidance = Parameters<ExtractionInputLoader['load']>[0]['guidance'];

function isKeyMissing(error: HttpException): boolean {
  const body = error.getResponse() as { details?: { reason?: string } } | string;
  return typeof body === 'object' && body.details?.reason === 'ai_key_missing';
}

function httpMessage(error: HttpException): string {
  const body = error.getResponse() as { message?: unknown } | string;
  if (typeof body === 'string') return body;
  return typeof body.message === 'string' ? body.message : error.message;
}
