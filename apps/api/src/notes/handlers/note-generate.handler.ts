import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import {
  AiAuthError,
  AiBudgetError,
  AiInputError,
  AiRefusedError,
} from '../../ai/ai-errors';
import {
  modelKnowledgeOf,
  resolveAllowedModel,
} from '../../ai/ai-model-resolution';
import { AiProviderRegistry } from '../../ai/ai-provider.registry';
import type { AiAllowedModel } from '../../ai/ai-settings.schema';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { createProviderContext } from '../../ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { JobHandler } from '../../jobs/job-handler.interface';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { PrismaService } from '../../prisma/prisma.service';
import { aiProviderThrottleKey, NOTE_GENERATE_JOB_TYPE } from '../job-types';
import {
  NoteGenerationService,
  readPayloadTemplate,
  readPayloadUserId,
  type GenerationErrorClass,
  type GenerationWithNote,
} from '../generation/note-generation.service';
import { NoteSourceService } from '../generation/note-source.service';
import { assemblePrompt, parseTemplateStructure } from '../generation/prompt';
import { StreamFlusher } from '../generation/stream-flusher';
import { assertWithinBudget, computeTokenBudget } from '../generation/token-budget';

// =============================================================================
// `note.generate` (issue #49, epic #45) — the heart of the epic
// =============================================================================
//
// A template, plus a source, plus optional context, becomes a note. A model
// call takes ten seconds to several minutes, so CLAUDE.md's rule — any activity
// that outlives the HTTP request that started it MUST be a registered
// `JobHandler` — settles the shape before anything else does.
//
// Two properties have to hold at once, and they pull against each other:
//
//   • the user wants to WATCH the text appear; and
//   • the user must be able to close the tab, walk away, and come back to a
//     finished note.
//
// A generation that only exists inside an open connection satisfies the first
// and fails the second. So the job writes every delta into
// `note_generations.content` on the way past (spec §5.1) and #52's stream is a
// READER over that column — never the delivery mechanism. Nothing in this file
// knows or cares whether anybody is watching.
//
// -----------------------------------------------------------------------------
// `profile: { maxRuntimeMs: 10 min, maxAttempts: 1 }` — ONE ATTEMPT, DELIBERATELY
// -----------------------------------------------------------------------------
//
// Everywhere else in this queue the "unrecognised failure" class auto-retries,
// correctly: `transcription.submit`'s network hiccup should simply be tried
// again, because trying again has no side effect the user can see or pay for
// twice. Here a retry would call the SAME provider with the USER'S OWN KEY a
// second time, and because a completion is non-deterministic it would show them
// DIFFERENT text than the partial stream they already watched fail. So nothing
// about this type auto-retries, ever. `POST /api/notes/:id/regenerate` (#53) is
// the only retry path, it enqueues a brand-new job with its own fresh
// one-attempt budget, and it is a person pressing a button.
//
// The lease and its renewal interval are DERIVED from `maxRuntimeMs`
// (`job-execution-profile.ts`), which is why there is no `leaseMs` here and
// must never be one.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, PERMANENTLY — AND FOR A DIFFERENT REASON THAN THE TRANSCRIPT JOBS
// -----------------------------------------------------------------------------
//
// This handler declares NEITHER `nodeResultSchema` NOR `persistNodeResult`, so
// `JobHandlerRegistry.serverOnlyTypes()` reports `note.generate` and no node
// can ever claim it. Node eligibility is DERIVED from those two members and
// there is no flag to disagree with the derivation.
//
// The reason is specific: the credential is the CALLING USER'S OWN long-lived
// account key. `db.backup.run` is node-eligible because PostgreSQL can mint a
// short-lived, SELECT-only role scoped to one job (`pg-job-role.broker.ts`);
// no vendor here offers a job-scoped sub-key, so there is nothing a
// `nodeSecretBroker` could broker and shipping somebody's personal API key to a
// machine this deployment does not own is not an alternative.
//
// -----------------------------------------------------------------------------
// FAILURE: FOUR DOMAIN CLASSES RETURN, A 429 THROWS, EVERYTHING ELSE THROWS
// -----------------------------------------------------------------------------
//
// Following docs/specs/transcription.md §1.6 exactly, with this epic's
// taxonomy (spec §2.2):
//
//   • `AiAuthError`, `AiInputError`, `AiRefusedError`, `AiBudgetError` →
//     `failure_reason` + `status: 'failed'`, and the job RETURNS NORMALLY. It
//     succeeded at determining a permanent outcome; a thrown error here would
//     spend the attempt rediscovering a fact that cannot change.
//   • `RateLimitError` (429) → rethrown, so `JobTerminalService` DEFERS the job
//     without charging an attempt and without the note ever showing a failure.
//     A rate limit is an invisible backoff, not an outcome.
//   • anything else → the note is marked failed AND the error is rethrown, so
//     `Job.lastError` records what actually happened. `maxAttempts: 1` means
//     the throw costs no retry; reporting the job as succeeded would hide a
//     genuine bug behind a user-facing failure message.
// =============================================================================

/** Ten minutes. Also the lease, indirectly — see the header. */
export const NOTE_GENERATE_MAX_RUNTIME_MS = 10 * 60 * 1000;

/** How a thrown error is recorded and described. */
interface Classified {
  errorClass: GenerationErrorClass;
  /** The words the email and the toast use for the KIND of failure. */
  category: string;
}

@Injectable()
export class NoteGenerateHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(NoteGenerateHandler.name);

  readonly type = NOTE_GENERATE_JOB_TYPE;

  /** See the header. Two numbers, and deliberately only two. */
  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: NOTE_GENERATE_MAX_RUNTIME_MS,
    maxAttempts: 1,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly providers: AiProviderRegistry,
    private readonly settings: AiSettingsService,
    private readonly credentials: UserAiCredentialsService,
    private readonly generations: NoteGenerationService,
    private readonly sources: NoteSourceService,
    private readonly throttle: ProviderThrottleService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);

    // ⚠ NO `registerProviderKey` HERE, UNLIKE EVERY TRANSCRIPTION HANDLER, and
    // the absence is the point. Those three share one deployment-owned vendor
    // account, so one static key registered at startup is exactly right. Here
    // the bucket is PER USER (spec §2.3), and a user is not known until a job
    // is running — so the key is registered inside `process`, immediately
    // before the provider call. See `aiProviderThrottleKey`.
  }

  async process(job: Job): Promise<void> {
    const generation = await this.generations.loadForJob(job.payload);

    if (!generation) {
      this.logger.log(`Generate job ${job.id} names no live generation; nothing to do`);

      return;
    }

    if (generation.status === 'succeeded' || generation.status === 'failed') {
      // Already settled — a duplicate delivery, or a manual retry of a job row
      // whose generation someone else finished. At-least-once means this is
      // ordinary, not an error.
      this.logger.log(
        `Generation ${generation.id} is already ${generation.status}; job ${job.id} is a no-op`,
      );

      return;
    }

    if (generation.note && (generation.note.deletedAt !== null || generation.note.status === 'deleting')) {
      this.logger.log(
        `Note ${generation.note.id} is being deleted; generation ${generation.id} is a no-op`,
      );

      return;
    }

    try {
      await this.generate(generation, job);
    } catch (error) {
      // A 429 is NOT a failure. Straight back to the queue, which defers this
      // job against the per-user bucket registered below without charging an
      // attempt and without the note ever showing anything to the user.
      if (error instanceof RateLimitError) {
        throw error;
      }

      const classified = classify(error);

      await this.generations.markFailed({
        generation,
        errorClass: classified.errorClass,
        reason: describe(error),
        category: classified.category,
      });

      // DOMAIN FAILURES RETURN; everything else is rethrown so `Job.lastError`
      // carries it. See the header.
      if (classified.errorClass === 'other') {
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The generation itself
  // ---------------------------------------------------------------------------

  private async generate(generation: GenerationWithNote, job: Job): Promise<void> {
    // -------------------------------------------------------------------------
    // 1. Whose key, and whose bucket?
    // -------------------------------------------------------------------------
    const userId = generation.note?.ownerId ?? readPayloadUserId(job.payload);

    if (!userId) {
      throw new AiInputError(
        'This generation is not attached to a note or to a user, so there is no API key to use.',
      );
    }

    // -------------------------------------------------------------------------
    // 2. Deployment policy, provider, model.
    // -------------------------------------------------------------------------
    const policy = await this.settings.get();

    if (!policy.enabled) {
      throw new AiInputError(
        'AI features are switched off for this deployment. An administrator can enable them in system settings.',
      );
    }

    const provider = this.providers.get(generation.providerId);

    if (!provider) {
      throw new AiInputError(
        `This note was set up to use the "${generation.providerId}" provider, which this ` +
          'version of the application does not have.',
      );
    }

    const allowed = readAllowedModelEntries(policy.providers, provider.id);
    const entry = allowed.find((model) => model.id === generation.model);

    if (!entry) {
      throw new AiInputError(
        `The model "${generation.model}" is not permitted by this deployment. ` +
          'Choose one your administrator has allowed and generate again.',
      );
    }

    // ⚠ RESOLVED WITH THE SHARED HELPER (#78), not by looking the id up in
    // `capabilities.models` directly. A policy entry may carry its own context
    // window for a model this build has never heard of, and that is exactly the
    // model an administrator adopts from the discovery dropdown. Looking only
    // at the build catalogue here would let `GET /api/ai/config` offer such a
    // model, let the request-time budget check pass, and then fail the job —
    // after the note row exists and the user is watching it generate.
    //
    // ⚠ `modelKnowledgeOf` RATHER THAN THE BARE CATALOGUE (#97). The provider's
    // family derivation and conservative floor are two more ranks of the same
    // precedence, and this is the LAST place it is applied before a user's own
    // money is spent: a job resolving fewer ranks than `GET /api/ai/config` did
    // would fail exactly the models the picker had just offered.

    const descriptor = resolveAllowedModel(entry, modelKnowledgeOf(provider));

    if (!descriptor) {
      throw new AiInputError(
        `This deployment has no context window recorded for the model "${generation.model}", ` +
          'so it cannot work out how much text will fit. An administrator can add one on the AI settings page.',
      );
    }

    const settingsParse = provider.settingsSchema.safeParse(
      (policy.providers as Record<string, unknown>)[provider.id] ?? {},
    );

    if (!settingsParse.success) {
      throw new AiInputError(
        `This deployment's configuration for provider "${provider.id}" is invalid. ` +
          'An administrator must correct it before notes can be generated.',
      );
    }

    // -------------------------------------------------------------------------
    // 3. The user's own key. Resolved as late as possible and never stored.
    // -------------------------------------------------------------------------
    const apiKey = await this.credentials.getSecret(userId, provider.id);

    if (!apiKey) {
      throw new AiAuthError(
        `No ${provider.label} API key is saved for your account. Add one in your settings and generate again.`,
        provider.id,
      );
    }

    // -------------------------------------------------------------------------
    // 4. The template, and the source AS THE USER CORRECTED IT.
    // -------------------------------------------------------------------------
    //
    // ⚠ ONE SOURCE FOR THE TEMPLATE, CHOSEN BY A COLUMN, NEVER A MERGE (#50).
    // `template_id` set means the stored row, every time — that is a real note's
    // path and a preview OF A SAVED TEMPLATE's path, and they are the same code
    // rather than two codes that agree. `template_id` NULL means this is a
    // preview of an UNSAVED body, whose five columns can only have travelled in
    // the job payload because `note_generations` has no columns for them.
    //
    // This branch is what makes "one generation mechanism, two entry points"
    // (issue #50) structural: whichever way the template arrived, everything
    // below this point — assembly, budget, streaming, the error taxonomy — is
    // the identical code operating on the identical five values.
    const template = generation.templateId
      ? await this.prisma.noteTemplate.findUnique({ where: { id: generation.templateId } })
      : readPayloadTemplate(job.payload);

    if (!template) {
      // Two ways to get here, one sentence each, because they have different
      // causes and different fixes.
      //
      // A STORED TEMPLATE THAT IS GONE: `note_generations.template_id` is
      // `SetNull`, so the template this note was set up with can legitimately
      // have been deleted between the request and this job. The snapshot NAME
      // survives (that is what it is for), but the instructions do not, and
      // generating from a guessed default would produce a note the user never
      // asked for.
      //
      // A PREVIEW WHOSE PAYLOAD CARRIES NO READABLE SNAPSHOT: a payload written
      // by another build, or hand-edited. Same outcome — there is nothing to
      // generate from — reported as a domain failure rather than a crash.
      throw new AiInputError(
        `The template "${generation.templateNameSnapshot}" no longer exists, so this note ` +
          'cannot be generated from it. Choose another template and try again.',
      );
    }

    const source = await this.sources.resolve({
      sourceType: generation.sourceType,
      sourceTranscriptId: generation.sourceTranscriptId,
      sourceNoteId: generation.sourceNoteId,
      sourceObjectId: generation.sourceObjectId,
    });

    // -------------------------------------------------------------------------
    // 5. Assemble, then budget — BOTH BEFORE THE PROVIDER IS TOUCHED.
    // -------------------------------------------------------------------------
    const prompt = assemblePrompt({
      templateInstructions: template.instructions,
      templateOutputFormat: template.outputFormat,
      templateStructure: parseTemplateStructure(template.structure),
      templateTone: template.tone,
      templateLength: template.length,
      contextText: generation.contextText,
      sourceText: source.text,
    });

    const budget = computeTokenBudget({
      contextWindowTokens: descriptor.contextWindowTokens,
      modelMaxOutputTokens: descriptor.maxOutputTokens,
      policyMaxOutputTokens: policy.maxOutputTokens,
      policyMaxInputTokens: policy.maxInputTokens,
    });

    const promptTokens = provider.countTokens(
      `${prompt.systemPrompt}\n${prompt.userContent}`,
      generation.model,
    );

    // ⚠ THROWS `AiBudgetError` — never truncates, and never after a request has
    // been made. Once the provider has been called the input tokens are billed
    // to the user whether or not the answer is any good, so this is the last
    // moment a refusal is free. See `token-budget.ts`.
    assertWithinBudget({
      promptTokens,
      availableInputTokens: budget.availableInputTokens,
      model: generation.model,
      providerId: provider.id,
    });

    // -------------------------------------------------------------------------
    // 6. Stream.
    // -------------------------------------------------------------------------
    await this.generations.markStreaming(generation, new Date());

    // ⚠ THE PER-USER BUCKET, registered immediately before the call so a 429
    // this generation provokes defers THIS user's queued generations and
    // nobody else's (spec §2.3). `ProviderThrottleService` maps job type → key,
    // so registering here rather than at `onModuleInit` is what makes a
    // per-user key expressible at all; the cooldown state it trips is genuinely
    // per user, which is the property that matters — one user's exhausted quota
    // can never park another user's work behind it.
    this.throttle.registerProviderKey(this.type, aiProviderThrottleKey(userId));

    const flusher = new StreamFlusher();
    let finishReason: string | null = null;
    let usagePromptTokens: number | null = null;
    let usageCompletionTokens: number | null = null;

    const ctx = createProviderContext(apiKey, settingsParse.data);

    for await (const event of provider.generate(ctx, {
      model: generation.model,
      systemPrompt: prompt.systemPrompt,
      userContent: prompt.userContent,
      maxOutputTokens: budget.maxOutputTokens,
      timeoutMs: policy.requestTimeoutMs,
      // #87. DEPLOYMENT POLICY, passed through unchanged — not a per-note or
      // per-template choice. ⚠ It does NOT widen `maxOutputTokens` above:
      // reasoning tokens are billed and counted as output and are drawn from
      // that same budget, so a higher effort buys thinking out of the note's
      // own room rather than out of thin air. See `ai.reasoningEffort`.
      reasoningEffort: policy.reasoningEffort,
    })) {
      if (event.kind === 'delta') {
        flusher.append(event.text);

        if (flusher.shouldFlush()) {
          await this.generations.flush(generation.id, flusher.content);
          flusher.commit();
        }

        continue;
      }

      finishReason = event.finishReason;
      usagePromptTokens = event.usage.promptTokens;
      usageCompletionTokens = event.usage.completionTokens;
    }

    // -------------------------------------------------------------------------
    // 7. Settle.
    // -------------------------------------------------------------------------
    if (finishReason === 'content_filter') {
      // The model produced something and then refused to finish it. Whatever is
      // in the buffer is a fragment of a refused answer, not a note.
      throw new AiRefusedError(
        `${provider.label} declined to finish this note because of its content policy.`,
        undefined,
        provider.id,
      );
    }

    if (flusher.content.trim().length === 0) {
      // A stream that ended cleanly having produced nothing. Committing it
      // would set the note `ready` with an empty body, which reads exactly like
      // a note the model decided was empty.
      throw new AiRefusedError(
        `${provider.label} returned no text for this note. Try again, or use a different model.`,
        undefined,
        provider.id,
      );
    }

    await this.generations.commit({
      generation,
      content: flusher.content,
      // The provider's own counts when it reported them; this build's estimate
      // otherwise. Never zero — a zero reads as "this generation was free",
      // which is the one wrong answer about somebody's own bill.
      promptTokens: usagePromptTokens ?? promptTokens,
      completionTokens: usageCompletionTokens,
      providerLabel: provider.label,
    });

    this.logger.log(
      `Generation ${generation.id} completed from ${source.describe} ` +
        `(${flusher.content.length} characters, finish reason ${finishReason ?? 'unreported'})`,
    );
  }
}

/**
 * Which error class a thrown value belongs to, and what to call it.
 *
 * TOTAL AND NEVER THROWS — it is called from a failure path on a value that is
 * `unknown` by construction. Anything not positively recognised is `other`,
 * which is the class that gets rethrown, so an unfamiliar failure stays visible
 * in `Job.lastError` rather than being quietly filed as a user-facing excuse.
 */
export function classify(error: unknown): Classified {
  if (error instanceof AiAuthError) {
    return { errorClass: 'auth', category: 'Your API key' };
  }

  if (error instanceof AiBudgetError) {
    return { errorClass: 'refusal', category: 'Too large' };
  }

  if (error instanceof AiRefusedError) {
    return { errorClass: 'refusal', category: 'Declined by the provider' };
  }

  if (error instanceof AiInputError) {
    return { errorClass: 'refusal', category: 'This request' };
  }

  return { errorClass: 'other', category: 'Unexpected error' };
}

/**
 * The sentence the user is shown.
 *
 * ⚠ NEVER AN ECHO OF A RAW VENDOR BODY FOR AN UNKNOWN ERROR. A domain error's
 * message is written by this application (`ai-errors.ts` forbids key material
 * in one); anything else gets a fixed sentence, because an arbitrary thrown
 * value's `message` is exactly where a stack frame, a connection string or a
 * header would turn up.
 */
export function describe(error: unknown): string {
  if (
    error instanceof AiAuthError ||
    error instanceof AiBudgetError ||
    error instanceof AiRefusedError ||
    error instanceof AiInputError
  ) {
    return error.message;
  }

  return 'This note could not be generated because of an unexpected error. Try again.';
}

/**
 * The models this deployment permits for one provider, as normalised entries.
 *
 * TOTAL OVER THE SETTINGS BLOB, which is JSONB that a rollback across a
 * settings change can leave in any shape at all. An unreadable block permits
 * NOTHING rather than everything: the deployment's allow-list is its only lever
 * over which vendor models its content reaches, so the safe direction when the
 * lever cannot be read is closed.
 *
 * ⚠ IT ACCEPTS BOTH ENTRY SHAPES, AND MUST (#78). Two of them exist in live
 * data at the same time: the bare `"gpt-4o"` every pre-#78 row contains, and
 * the `{ id, contextWindowTokens, maxOutputTokens }` object an administrator
 * saves after picking a model this build has never heard of. A reader that
 * understood only strings would silently drop every object entry — and because
 * this function is what decides whether a model is PERMITTED, the symptom would
 * be every generation against a newly adopted model failing with "not permitted
 * by this deployment" while the settings page cheerfully showed it permitted.
 */
export function readAllowedModelEntries(
  providers: unknown,
  providerId: string,
): AiAllowedModel[] {
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    return [];
  }

  const block = (providers as Record<string, unknown>)[providerId];

  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    return [];
  }

  const models = (block as Record<string, unknown>).allowedModels;

  if (!Array.isArray(models)) return [];

  return models
    .map((model): AiAllowedModel | null => {
      if (typeof model === 'string') return { id: model };

      if (typeof model !== 'object' || model === null || Array.isArray(model)) {
        return null;
      }

      const record = model as Record<string, unknown>;
      if (typeof record.id !== 'string' || record.id.length === 0) return null;

      return {
        id: record.id,
        label: typeof record.label === 'string' ? record.label : undefined,
        // Read defensively field by field rather than spread: this is raw
        // JSONB, and a `contextWindowTokens` that arrived as the string
        // `"128000"` must read as absent (so the catalogue answers, or the
        // model is refused) rather than as a number the budget then compares
        // against.
        contextWindowTokens:
          typeof record.contextWindowTokens === 'number'
            ? record.contextWindowTokens
            : undefined,
        maxOutputTokens:
          typeof record.maxOutputTokens === 'number'
            ? record.maxOutputTokens
            : undefined,
      };
    })
    .filter((entry): entry is AiAllowedModel => entry !== null);
}
