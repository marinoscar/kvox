import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type Job, type TranscriptNameCheck } from '@prisma/client';

import {
  AiAuthError,
  AiBudgetError,
  AiInputError,
  AiRefusedError,
  isTerminalAiError,
} from '../../ai/ai-errors';
import { modelKnowledgeOf, resolveAllowedModel } from '../../ai/ai-model-resolution';
import { AiProviderRegistry } from '../../ai/ai-provider.registry';
import { AiSettingsService } from '../../ai/ai-settings.service';
import {
  createProviderContext,
  type AiProvider,
  type AiProviderContext,
} from '../../ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import type { SystemAiValue } from '../../common/schemas/settings.schema';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { readAllowedModelEntries } from '../../notes/generation/allowed-models';
import { assertWithinBudget, computeTokenBudget } from '../../notes/generation/token-budget';
import { aiProviderThrottleKey } from '../../notes/job-types';
import { PrismaService } from '../../prisma/prisma.service';
import { TRANSCRIPT_NAME_CHECK_JOB_TYPE } from '../job-types';
import { buildTargets, type NameTarget } from '../name-check/candidates';
import { phoneticCandidates, promptTokens } from '../name-check/estimate';
import {
  acceptResults,
  batch,
  buildAdjudicationPrompt,
  buildDiscoveryPrompt,
  capCandidates,
  DISCOVERY_CHUNK_TOKENS,
  DISCOVERY_SYSTEM_PROMPT,
  JSON_RETRY_LINE,
  locateDiscoveryFindings,
  mergeCandidates,
  packDiscoveryChunks,
  parseAdjudicationAnswer,
  parseDiscoveryAnswer,
  type AcceptedSuggestion,
  type DiscoveryFinding,
  type NameCheckPrompt,
  type SourcedCandidate,
} from '../name-check/prompts';
import { loadNameCheckInput, type NameCheckInput } from '../name-check-input';

// =============================================================================
// `transcript.name_check` (issues #328 and #330, epic #326)
// =============================================================================
//
// After a user renames speaker "A" to "Oscar", the ASR text still says what the
// provider heard: "Skar", "Oh scar". This job PROPOSES corrections; it never
// makes one. Its output is `transcript_name_suggestions` rows, and accepting
// one is an ordinary `segment.update_text` through `TranscriptEditingService`
// — the same versioned path every other correction takes.
//
//   1. Read the transcript at `currentVersion` from the live tables.
//   2. Stage 1 — `findCandidates`: phonetic retrieval, deterministic, free.
//   3. Thorough mode only (#330) — DISCOVERY: the transcript in ~6k-token
//      chunks, the model asked for spans that mis-hear the listed names.
//   4. ADJUDICATION, both modes: every candidate, in batches of 40, shown to
//      the model in context; only `replace` verdicts that pass the guards in
//      `prompts.ts` become suggestions.
//   5. Persist the suggestions and settle the run.
//
// A model call per batch takes seconds and a two-hour transcript can need
// dozens of them, which is why this is a queue job at all (CLAUDE.md: anything
// that outlives its request is a registered `JobHandler`).
//
// -----------------------------------------------------------------------------
// `profile: { maxRuntimeMs: 20 min, maxAttempts: 1 }` — ONE ATTEMPT, DELIBERATELY
// -----------------------------------------------------------------------------
//
// Every request here is billed to the REQUESTING USER'S OWN AI KEY. An
// automatic retry would re-run discovery and adjudication from the top and
// charge them twice for one click — and because completions are
// non-deterministic it could propose a DIFFERENT set of corrections than a run
// they may already have half-reviewed. `note.generate` carries the same
// profile for the same reason. The retry path is the user pressing "Check
// names" again, which queues a new run with its own one-attempt budget.
// Twenty minutes rather than `note.generate`'s ten: a thorough check of a
// two-hour recording is ~7 discovery chunks plus up to 25 adjudication
// batches, sequentially. The lease is DERIVED from `maxRuntimeMs`.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, PERMANENTLY
// -----------------------------------------------------------------------------
//
// NEITHER `nodeResultSchema` NOR `persistNodeResult` is declared, so no node
// can claim this type. The credential is the user's own long-lived vendor key;
// no vendor here offers a job-scoped sub-key, so there is nothing a
// `nodeSecretBroker` could broker, and shipping a personal API key to a
// machine this deployment does not own is not an alternative. Same argument
// as `note.generate`.
//
// -----------------------------------------------------------------------------
// FAILURE
// -----------------------------------------------------------------------------
//
//   • `RateLimitError` → rethrown: the queue DEFERS the job against this
//     user's own bucket without charging the attempt. The run stays `running`
//     and the next claim starts it again from the top — nothing was persisted.
//   • `AiAuthError`/`AiInputError`/`AiRefusedError`/`AiBudgetError` → the run
//     is `failed` with an `errorClass` and a user-facing message, and the job
//     RETURNS NORMALLY: it determined a permanent outcome.
//   • Anything else → the run is `failed` AND the error is rethrown, so
//     `Job.lastError` records what actually happened.
//
// ⚠ A MALFORMED ANSWER FOR ONE BATCH IS NOT A FAILED RUN. It earns one retry
// with an explicit "return only valid JSON" line; failing that, the batch is
// skipped and logged. Only when EVERY request failed to produce a usable answer
// is the run failed (`refusal`), because "no suggestions" would then be a lie.
// =============================================================================

/** Twenty minutes. Also the lease, indirectly — see the header. */
export const TRANSCRIPT_NAME_CHECK_MAX_RUNTIME_MS = 20 * 60_000;

/** `transcript_name_checks.error_class`. */
export type NameCheckErrorClass = 'auth' | 'refusal' | 'input' | 'budget' | 'other';

/** Payload of a `transcript.name_check` job. Identifiers only. */
export interface TranscriptNameCheckPayload {
  checkId: string;
}

export function readNameCheckPayload(payload: unknown): TranscriptNameCheckPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { checkId } = payload as { checkId?: unknown };
  return typeof checkId === 'string' && checkId.length > 0 ? { checkId } : null;
}

/** Everything one provider call needs, resolved once per run. */
interface CallContext {
  provider: AiProvider<never>;
  ctx: AiProviderContext<unknown>;
  model: string;
  policy: SystemAiValue;
  userId: string;
  availableInputTokens: number;
  maxOutputTokens: number;
}

/** Running totals for one run. */
interface RunStats {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  usable: number;
}

@Injectable()
export class TranscriptNameCheckHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TranscriptNameCheckHandler.name);

  readonly type = TRANSCRIPT_NAME_CHECK_JOB_TYPE;

  /** See the header. Two numbers, and deliberately only two. */
  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: TRANSCRIPT_NAME_CHECK_MAX_RUNTIME_MS,
    maxAttempts: 1,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly providers: AiProviderRegistry,
    private readonly settings: AiSettingsService,
    private readonly credentials: UserAiCredentialsService,
    private readonly throttle: ProviderThrottleService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    // No `registerProviderKey` here: the bucket is PER USER and the user is
    // not known until a run is claimed — see `call()`.
  }

  async process(job: Job): Promise<void> {
    const payload = readNameCheckPayload(job.payload);
    if (!payload) {
      this.logger.warn(`Name-check job ${job.id} carries no checkId; nothing to do`);
      return;
    }

    const run = await this.prisma.transcriptNameCheck.findUnique({
      where: { id: payload.checkId },
      include: { transcript: { select: { id: true, status: true, deletedAt: true } } },
    });

    if (!run) {
      this.logger.log(`Name check ${payload.checkId} no longer exists; job ${job.id} is a no-op`);
      return;
    }

    if (run.status !== 'pending' && run.status !== 'running') {
      this.logger.log(`Name check ${run.id} is already ${run.status}; job ${job.id} is a no-op`);
      return;
    }

    if (run.transcript.deletedAt !== null || run.transcript.status === 'deleting') {
      this.logger.log(`Transcript ${run.transcriptId} is being deleted; name check ${run.id} is a no-op`);
      return;
    }

    await this.prisma.transcriptNameCheck.updateMany({
      where: { id: run.id, status: { in: ['pending', 'running'] } },
      data: { status: 'running', startedAt: new Date() },
    });

    try {
      await this.check(run);
    } catch (error) {
      if (error instanceof RateLimitError) throw error;

      const errorClass = classifyNameCheckError(error);
      await this.markFailed(run.id, errorClass, describeNameCheckError(error));

      if (errorClass === 'other') throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // The run
  // ---------------------------------------------------------------------------

  private async check(run: TranscriptNameCheck): Promise<void> {
    const call = await this.resolveCall(run);

    // 1. The transcript as it is now, read consistently with its version.
    const { input, version } = await this.prisma.$transaction(
      async (tx) => {
        const transcript = await tx.transcript.findUnique({
          where: { id: run.transcriptId },
          select: { currentVersion: true },
        });
        return {
          version: transcript?.currentVersion ?? 0,
          input: await loadNameCheckInput(tx, run.transcriptId, true),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 },
    );

    const targets = buildTargets(readTerms(run.terms));
    if (targets.length === 0) {
      throw new AiInputError(
        'There are no names to check. Rename at least one speaker or add a name, then check again.',
      );
    }

    const stats: RunStats = { inputTokens: 0, outputTokens: 0, requests: 0, usable: 0 };

    // 2. Stage 1.
    const phonetic = phoneticCandidates(input.segments, targets);

    // 3. Discovery (thorough only).
    let merged: SourcedCandidate[] = phonetic;
    if (run.mode === 'thorough') {
      const discovered = await this.discover(call, input, targets, phonetic, stats);
      merged = mergeCandidates(phonetic, discovered, input.segmentIndex);
    }

    const { candidates, truncated } = capCandidates(merged);
    if (truncated) {
      this.logger.log(
        `Name check ${run.id}: ${merged.length} candidates, adjudicating the top ${candidates.length}`,
      );
    }

    // 4. Adjudication.
    const accepted: AcceptedSuggestion[] = [];
    for (const group of batch(candidates)) {
      accepted.push(...(await this.adjudicate(call, input, group, stats)));
    }

    if (stats.requests > 0 && stats.usable === 0) {
      throw new AiRefusedError(
        `${call.provider.label} did not return a usable answer for this name check. ` +
          'Try again, or use a different model.',
        undefined,
        call.provider.id,
      );
    }

    // 5. Persist and settle.
    await this.prisma.$transaction(async (tx) => {
      const still = await tx.transcriptNameCheck.findUnique({
        where: { id: run.id },
        select: { status: true },
      });
      if (!still || still.status !== 'running') return;

      if (accepted.length > 0) {
        await tx.transcriptNameSuggestion.createMany({
          data: accepted.map((s) => ({
            checkId: run.id,
            segmentId: s.candidate.segmentId,
            segmentRev: s.candidate.segmentRev,
            start: s.candidate.start,
            end: s.candidate.end,
            original: s.candidate.original,
            replacement: s.replacement,
            confidence: s.confidence,
            reason: s.reason,
            source: s.candidate.source,
          })),
        });
      }

      await tx.transcriptNameCheck.update({
        where: { id: run.id },
        data: {
          status: 'ready',
          completedAt: new Date(),
          basedOnVersion: version,
          candidateCount: candidates.length,
          suggestionCount: accepted.length,
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
          providerId: call.provider.id,
          model: call.model,
          errorClass: null,
          error: null,
        },
      });
    });

    this.logger.log(
      `Name check ${run.id} (${run.mode}) on transcript ${run.transcriptId} v${version}: ` +
        `${phonetic.length} phonetic + ${merged.length - phonetic.length} discovered candidates, ` +
        `${accepted.length} suggestions, ${stats.requests} requests ` +
        `(${stats.requests - stats.usable} unusable), ${stats.inputTokens}/${stats.outputTokens} tokens`,
    );
  }

  // ---------------------------------------------------------------------------
  // Policy, provider, model, key — the resolution `note.generate` performs
  // ---------------------------------------------------------------------------

  private async resolveCall(run: TranscriptNameCheck): Promise<CallContext> {
    const userId = run.requestedById;
    if (!userId) {
      throw new AiInputError(
        'The account that requested this name check no longer exists, so there is no API key to use.',
      );
    }

    const policy = await this.settings.get();
    if (!policy.enabled) {
      throw new AiInputError(
        'AI features are switched off for this deployment. An administrator can enable them in system settings.',
      );
    }

    const providerId = run.providerId ?? policy.provider;
    const provider = providerId ? this.providers.get(providerId) : undefined;
    if (!provider) {
      throw new AiInputError(
        `The AI provider "${providerId ?? 'none'}" is not available in this version of the application.`,
      );
    }

    const allowed = readAllowedModelEntries(policy.providers, provider.id);
    const configuredDefault = (policy.providers as Record<string, { defaultModel?: string | null } | undefined>)[
      provider.id
    ]?.defaultModel;
    const model = run.model ?? configuredDefault ?? allowed[0]?.id ?? null;
    const entry = model ? allowed.find((m) => m.id === model) : undefined;
    if (!model || !entry) {
      throw new AiInputError(
        `The model "${model ?? 'none'}" is not permitted by this deployment. Ask an administrator to allow one.`,
      );
    }

    // Resolved with the shared helper, for `note.generate`'s reason: a policy
    // entry may carry the limits of a model this build has never heard of.
    const descriptor = resolveAllowedModel(entry, modelKnowledgeOf(provider));
    if (!descriptor) {
      throw new AiInputError(
        `This deployment has no context window recorded for the model "${model}". ` +
          'An administrator can add one on the AI settings page.',
      );
    }

    const settings = provider.settingsSchema.safeParse(
      (policy.providers as Record<string, unknown>)[provider.id] ?? {},
    );
    if (!settings.success) {
      throw new AiInputError(
        `This deployment's configuration for provider "${provider.id}" is invalid. ` +
          'An administrator must correct it first.',
      );
    }

    const apiKey = await this.credentials.getSecret(userId, provider.id);
    if (!apiKey) {
      throw new AiAuthError(
        `No ${provider.label} API key is saved for your account. Add one in your settings and check again.`,
        provider.id,
      );
    }

    const budget = computeTokenBudget({
      contextWindowTokens: descriptor.contextWindowTokens,
      modelMaxOutputTokens: descriptor.maxOutputTokens,
      policyMaxOutputTokens: policy.maxOutputTokens,
      policyMaxInputTokens: policy.maxInputTokens,
    });

    return {
      provider: provider as AiProvider<never>,
      ctx: createProviderContext(apiKey, settings.data as unknown),
      model,
      policy,
      userId,
      availableInputTokens: budget.availableInputTokens,
      maxOutputTokens: budget.maxOutputTokens,
    };
  }

  // ---------------------------------------------------------------------------
  // Discovery (#330)
  // ---------------------------------------------------------------------------

  private async discover(
    call: CallContext,
    input: NameCheckInput,
    targets: NameTarget[],
    phonetic: SourcedCandidate[],
    stats: RunStats,
  ): Promise<SourcedCandidate[]> {
    const count = (text: string): number => call.provider.countTokens(text, call.model);

    // A chunk must fit this model with room for the framing: never more than
    // the nominal 6k, less on a deployment whose budget is tighter.
    const framing = promptTokens(buildDiscoveryPrompt({ indices: [], text: '', tokens: 0 }, targets), count);
    const room = call.availableInputTokens - framing - count(JSON_RETRY_LINE) - 16;
    const chunkTokens = Math.max(256, Math.min(DISCOVERY_CHUNK_TOKENS, room));

    const chunks = packDiscoveryChunks(input.segments, input.speakerNames, count, chunkTokens);
    const findings: DiscoveryFinding[] = [];

    for (const chunk of chunks) {
      const prompt = buildDiscoveryPrompt(chunk, targets);
      const answer = await this.askJson(call, prompt, parseDiscoveryAnswer, stats, 'discovery');
      if (!answer) continue;
      // The model is told the indices it may name; anything else is dropped.
      const allowed = new Set(chunk.indices);
      findings.push(...answer.filter((f) => allowed.has(f.seg)));
    }

    return locateDiscoveryFindings(findings, input.segments, targets, phonetic);
  }

  // ---------------------------------------------------------------------------
  // Adjudication
  // ---------------------------------------------------------------------------

  /**
   * One batch. A batch whose prompt does not fit the budget is split in half
   * rather than refused — only a SINGLE candidate that cannot fit fails the
   * run (as a budget refusal, with the numbers).
   */
  private async adjudicate(
    call: CallContext,
    input: NameCheckInput,
    group: SourcedCandidate[],
    stats: RunStats,
  ): Promise<AcceptedSuggestion[]> {
    const count = (text: string): number => call.provider.countTokens(text, call.model);
    const built = buildAdjudicationPrompt(group, input.segments, input.segmentIndex, input.speakerNames);
    const tokens = promptTokens(built.prompt, count) + count(JSON_RETRY_LINE) + 2;

    if (tokens > call.availableInputTokens && group.length > 1) {
      const mid = Math.ceil(group.length / 2);
      return [
        ...(await this.adjudicate(call, input, group.slice(0, mid), stats)),
        ...(await this.adjudicate(call, input, group.slice(mid), stats)),
      ];
    }

    const results = await this.askJson(call, built.prompt, parseAdjudicationAnswer, stats, 'adjudication');
    return results ? acceptResults(built.items, results) : [];
  }

  // ---------------------------------------------------------------------------
  // The provider call
  // ---------------------------------------------------------------------------

  /**
   * Ask, parse, and — on an answer that is not the expected JSON — ask once
   * more with an explicit instruction. `null` after the second failure; the
   * caller skips the batch.
   */
  private async askJson<T>(
    call: CallContext,
    prompt: NameCheckPrompt,
    parse: (answer: string) => T | null,
    stats: RunStats,
    what: string,
  ): Promise<T | null> {
    stats.requests += 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      const effective =
        attempt === 0 ? prompt : { ...prompt, userContent: `${prompt.userContent}\n\n${JSON_RETRY_LINE}` };
      const { text, finishReason } = await this.call(call, effective, stats);
      const parsed = finishReason === 'content_filter' ? null : parse(text);
      if (parsed !== null) {
        stats.usable += 1;
        return parsed;
      }
      this.logger.warn(
        `Name-check ${what} answer was not usable (attempt ${attempt + 1}, finish reason ${finishReason ?? 'unreported'})`,
      );
    }
    return null;
  }

  private async call(
    call: CallContext,
    prompt: NameCheckPrompt,
    stats: RunStats,
  ): Promise<{ text: string; finishReason: string | null }> {
    const promptCount = promptTokens(prompt, (t) => call.provider.countTokens(t, call.model));

    // ⚠ Never after a request: once the provider is called, the user pays.
    assertWithinBudget({
      promptTokens: promptCount,
      availableInputTokens: call.availableInputTokens,
      model: call.model,
      providerId: call.provider.id,
    });

    // ⚠ THE PER-USER BUCKET, registered immediately before the call so a 429
    // defers THIS user's work and nobody else's (`aiProviderThrottleKey`).
    this.throttle.registerProviderKey(this.type, aiProviderThrottleKey(call.userId));

    let text = '';
    let finishReason: string | null = null;
    let usage: { promptTokens: number; completionTokens: number } | null = null;

    for await (const event of call.provider.generate(call.ctx as never, {
      model: call.model,
      systemPrompt: prompt.systemPrompt,
      userContent: prompt.userContent,
      maxOutputTokens: call.maxOutputTokens,
      timeoutMs: call.policy.requestTimeoutMs,
      reasoningEffort: call.policy.reasoningEffort,
      responseFormat: 'json',
    })) {
      if (event.kind === 'delta') {
        text += event.text;
        continue;
      }
      finishReason = event.finishReason;
      usage = event.usage;
    }

    // The provider's own counts when it reported them; this build's estimate
    // otherwise — never zero, which would read as "this was free".
    stats.inputTokens += usage?.promptTokens ?? promptCount;
    stats.outputTokens += usage?.completionTokens ?? call.provider.countTokens(text, call.model);

    return { text, finishReason };
  }

  private async markFailed(checkId: string, errorClass: NameCheckErrorClass, message: string): Promise<void> {
    await this.prisma.transcriptNameCheck.updateMany({
      where: { id: checkId, status: { in: ['pending', 'running'] } },
      data: { status: 'failed', errorClass, error: message, completedAt: new Date() },
    });
  }
}

/** `transcript_name_checks.terms` as a string list, defensively. */
export function readTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
}

/**
 * Which error class a thrown value belongs to. TOTAL AND NEVER THROWS;
 * anything not positively recognised is `other`, the class that is rethrown.
 */
export function classifyNameCheckError(error: unknown): NameCheckErrorClass {
  if (error instanceof AiAuthError) return 'auth';
  if (error instanceof AiBudgetError) return 'budget';
  if (error instanceof AiRefusedError) return 'refusal';
  if (error instanceof AiInputError) return 'input';
  // A domain error that lost its prototype crossing a boundary.
  if (isTerminalAiError(error)) return 'refusal';
  return 'other';
}

/**
 * The sentence the user is shown. A domain error's message is written by this
 * application; anything else gets a fixed sentence, never an echo of a raw
 * error that could carry a stack frame or a header.
 */
export function describeNameCheckError(error: unknown): string {
  if (classifyNameCheckError(error) !== 'other' && error instanceof Error) return error.message;
  return 'This name check could not be completed because of an unexpected error. Try again.';
}
