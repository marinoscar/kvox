import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  StreamFlusher,
  aiProviderThrottleKey,
  assertWithinBudget,
  outputTokensForPrompt,
} from '../../core/index.js';
import {
  KVOX_AI,
  KVOX_JOBS,
  KVOX_PRISMA,
  KVOX_SETTINGS,
  KvoxAiError,
  KvoxRateLimitError,
  type KvoxAiPort,
  type KvoxAiTarget,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
  type KvoxSettingsPort,
} from '../../ports/index.js';
import type { KvoxNotesDb } from '../data/notes-db.js';
import { NOTE_GENERATE_JOB_TYPE } from '../job-types.js';
import {
  NOTE_GENERATE_AI_FEATURE,
  NoteInputError,
  budgetFromTarget,
  providerLabelOf,
  readAiTokenCaps,
} from '../generation/ai-support.js';
import {
  NoteGenerationService,
  readPayloadTemplate,
  readPayloadUserId,
  type GenerationErrorClass,
  type GenerationWithNote,
} from '../generation/note-generation.service.js';
import { NoteSourceService } from '../generation/note-source.service.js';
import { assemblePrompt, parseTemplateStructure } from '../generation/prompt.js';
import { NOTES_MODULE_OPTIONS, type ResolvedNotesOptions } from '../notes.options.js';

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
// the host's job port refuses any AI handler that declares them (`usesAi`), so no node
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
//   • an auth, input, refusal or budget failure (a `KvoxAiError` of class `auth`, `key_missing`,
//     `not_configured`, `capability`, `refusal` or `budget`, or a `NoteInputError`) →
//     `failure_reason` + `status: 'failed'`, and the job RETURNS NORMALLY. It
//     succeeded at determining a permanent outcome; a thrown error here would
//     spend the attempt rediscovering a fact that cannot change.
//   • a rate limit (a `KvoxAiError` of class `rate_limit`) → rethrown as a `KvoxRateLimitError` on
//     THIS USER'S bucket (`aiProviderThrottleKey(userId)`), so the queue DEFERS the job
//     without charging an attempt and without the note ever showing a failure.
//     A rate limit is an invisible backoff, not an outcome.
//   • anything else → the note is marked failed AND the error is rethrown, so
//     `Job.lastError` records what actually happened. `maxAttempts: 1` means
//     the throw costs no retry; reporting the job as succeeded would hide a
//     genuine bug behind a user-facing failure message.
// =============================================================================

/** Ten minutes. Also the lease, indirectly — see the header. */
/**
 * NOTE_GENERATE_MAX_RUNTIME_MS.
 *
 * @stability experimental
 */
export const NOTE_GENERATE_MAX_RUNTIME_MS = 10 * 60 * 1000;

/** How a thrown error is recorded and described. */
interface Classified {
  errorClass: GenerationErrorClass;
  /** The words the email and the toast use for the KIND of failure. */
  category: string;
}

/**
 * NoteGenerateHandler: wiring the slice registers itself; a host configures it through `NotesModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class NoteGenerateHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(NoteGenerateHandler.name);

  readonly type = NOTE_GENERATE_JOB_TYPE;

  readonly label = 'Note generation';

  /** The handler spends the owner's own provider key, so it can never be offered to a node. */
  readonly usesAi = true;

  /** See the header. Two numbers, and deliberately only two. */
  readonly profile: KvoxJobProfile = {
    maxRuntimeMs: NOTE_GENERATE_MAX_RUNTIME_MS,
    maxAttempts: 1,
  };

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb,
    @Inject(KVOX_AI) private readonly ai: KvoxAiPort,
    @Inject(KVOX_SETTINGS) private readonly settings: KvoxSettingsPort,
    @Inject(NOTES_MODULE_OPTIONS) private readonly options: ResolvedNotesOptions,
    private readonly generations: NoteGenerationService,
    private readonly sources: NoteSourceService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const payload = job.payload;
    const generation = await this.generations.loadForJob(payload);

    if (!generation) {
      this.logger.log(`Generate job ${job.id} names no live generation; nothing to do`);

      return;
    }

    // Terminal already: a duplicate delivery, or a manual re-queue of a finished
    // generation. Nothing to do, and certainly nothing to bill again.
    if (generation.status === 'succeeded' || generation.status === 'failed') {
      this.logger.log(
        `Generation ${generation.id} is already ${generation.status}; job ${job.id} is a no-op`,
      );

      return;
    }

    // The owner deleted the note while this job waited. Streaming into a row
    // that is being purged is wasted spend.
    if (generation.note && (generation.note.deletedAt !== null || generation.note.status === 'deleting')) {
      this.logger.log(
        `Note ${generation.note.id} is being deleted; generation ${generation.id} is a no-op`,
      );

      return;
    }

    try {
      await this.generate(generation, job);
    } catch (error) {
      if (error instanceof KvoxRateLimitError) {
        throw error;
      }

      // A 429 from the provider: defer the job against THIS user's bucket and nobody else's.
      const userId = generation.note?.ownerId ?? readPayloadUserId(payload);

      if (error instanceof KvoxAiError && error.errorClass === 'rate_limit' && userId) {
        throw new KvoxRateLimitError(aiProviderThrottleKey(userId), error.retryAfterMs, error.message);
      }

      const classified = classify(error);

      await this.generations.markFailed({
        generation,
        errorClass: classified.errorClass,
        reason: describe(error),
        category: classified.category,
      });

      // An unrecognised failure is rethrown so `Job.lastError` records what actually happened.
      if (classified.errorClass === 'other') {
        throw error;
      }
    }
  }

  private async generate(generation: GenerationWithNote, job: KvoxJob): Promise<void> {
    const payload = job.payload;
    const userId = generation.note?.ownerId ?? readPayloadUserId(payload);

    if (!userId) {
      throw new NoteInputError(
        'This generation is not attached to a note or to a user, so there is no API key to use.',
      );
    }

    // -----------------------------------------------------------------------
    // Deployment switch, model, key — in that order, and each with its own
    // sentence, because each has a different person who can fix it.
    // -----------------------------------------------------------------------
    const target = await this.resolveTarget(userId, generation);

    if (!(target.contextWindowTokens > 0)) {
      throw new NoteInputError(
        `This deployment has no context window recorded for the model "${generation.model}", ` +
          'so it cannot work out how much text will fit. An administrator can add one on the AI settings page.',
      );
    }

    const providerId = target.provider;
    const caps = await readAiTokenCaps(this.settings);

    // The template's CURRENT text when the row still exists; the snapshot a preview carries in
    // its job payload otherwise.
    const template = generation.templateId
      ? await this.prisma.noteTemplate.findUnique({ where: { id: generation.templateId } })
      : readPayloadTemplate(payload);

    if (!template) {
      throw new NoteInputError(
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

    const prompt = assemblePrompt({
      templateInstructions: template.instructions,
      templateOutputFormat: template.outputFormat,
      templateBodyFormat: template.bodyFormat,
      templateStructure: parseTemplateStructure(template.structure),
      templateTone: template.tone,
      templateLength: template.length,
      contextText: generation.contextText,
      sourceText: source.text,
    });

    // Refuse, with a number, BEFORE the provider is touched (spec §3.3). Never truncate.
    const budget = budgetFromTarget(target, caps)!;
    const promptTokens = this.ai.countTokens(target, `${prompt.systemPrompt}\n${prompt.userContent}`);

    assertWithinBudget({
      promptTokens,
      availableInputTokens: budget.availableInputTokens,
      model: generation.model,
    });

    // The context is durable BEFORE the model is called, so a failed run still shows what it sent.
    await this.generations.recordContext(generation.id, {
      systemPrompt: prompt.systemPrompt,
      userContent: prompt.userContent,
      sourceVersion: source.sourceVersion,
    });

    await this.generations.markStreaming(generation, new Date());

    const flusher = new StreamFlusher({
      ...(this.options.stream.flushIntervalMs !== undefined ? { intervalMs: this.options.stream.flushIntervalMs } : {}),
      ...(this.options.stream.flushChars !== undefined ? { chars: this.options.stream.flushChars } : {}),
    });
    let finishReason: string | null = null;
    let usagePromptTokens: number | null = null;
    let usageCompletionTokens: number | null = null;

    // THE STREAM IS A VIEW OVER THE ROW: every delta reaches `note_generations.content` on
    // the way past, whether or not anybody is watching.
    for await (const event of this.ai.generateText(
      { userId, orgId: null, feature: NOTE_GENERATE_AI_FEATURE },
      {
        target,
        system: prompt.systemPrompt,
        user: prompt.userContent,
        maxOutputTokens: outputTokensForPrompt(budget, promptTokens),
      },
    )) {
      if (event.type === 'delta') {
        flusher.append(event.text);

        if (flusher.shouldFlush()) {
          await this.generations.flush(generation.id, flusher.content);
          flusher.commit();
        }

        continue;
      }

      finishReason = event.finishReason;
      usagePromptTokens = event.usage.inputTokens;
      usageCompletionTokens = event.usage.outputTokens;
    }

    if (flusher.content.trim().length === 0) {
      throw new KvoxAiError(
        'refusal',
        `${providerLabelOf(providerId)} returned no text for this note. Try again, or use a different model.`,
      );
    }

    await this.generations.commit({
      generation,
      content: flusher.content,
      promptTokens: usagePromptTokens ?? promptTokens,
      completionTokens: usageCompletionTokens,
      providerLabel: providerLabelOf(providerId),
      bodyFormat: template.bodyFormat,
      jobId: job.id,
    });

    this.logger.log(
      `Generation ${generation.id} completed from ${source.describe} ` +
        `(${flusher.content.length} characters, finish reason ${finishReason ?? 'unreported'})`,
    );
  }

  /** The model this run was queued with, or the sentence that says what stops it. */
  private async resolveTarget(userId: string, generation: GenerationWithNote): Promise<KvoxAiTarget> {
    try {
      return await this.ai.resolveTask(
        { userId, orgId: null, feature: NOTE_GENERATE_AI_FEATURE },
        NOTE_GENERATE_AI_FEATURE,
        { model: generation.model },
      );
    } catch (error) {
      if (!(error instanceof KvoxAiError)) throw error;

      if (error.errorClass === 'not_configured') {
        throw new KvoxAiError(
          'not_configured',
          'AI features are switched off for this deployment. An administrator can enable them in system settings.',
        );
      }

      if (error.errorClass === 'capability') {
        throw new KvoxAiError(
          'capability',
          `The model "${generation.model}" is not permitted by this deployment. ` +
            'Choose one your administrator has allowed and generate again.',
        );
      }

      if (error.errorClass === 'key_missing') {
        throw new KvoxAiError(
          'key_missing',
          `No ${providerLabelOf(generation.providerId)} API key is saved for your account. Add one in your settings and generate again.`,
        );
      }

      throw error;
    }
  }
}

/**
 * The recorded class and the words for the kind of failure.
 *
 * Exported for the unit spec; `NoteGenerateHandler` is the only caller.
 */
export function classify(error: unknown): Classified {
  if (error instanceof KvoxAiError) {
    switch (error.errorClass) {
      case 'auth':
      case 'key_missing':
        return { errorClass: 'auth', category: 'Your API key' };
      case 'budget':
        return { errorClass: 'refusal', category: 'Too large' };
      case 'refusal':
        return { errorClass: 'refusal', category: 'Declined by the provider' };
      case 'not_configured':
      case 'capability':
        return { errorClass: 'refusal', category: 'This request' };
      default:
        return { errorClass: 'other', category: 'Unexpected error' };
    }
  }

  if (error instanceof NoteInputError) {
    return { errorClass: 'refusal', category: 'This request' };
  }

  return { errorClass: 'other', category: 'Unexpected error' };
}

/**
 * The sentence the user reads. Domain failures carry one written for a person; anything else
 * must NOT leak its message (it can carry a vendor's wording or a stack's), so it gets a
 * generic sentence.
 */
export function describe(error: unknown): string {
  if (error instanceof NoteInputError) return error.message;

  if (error instanceof KvoxAiError && classify(error).errorClass !== 'other') return error.message;

  return 'This note could not be generated because of an unexpected error. Try again.';
}
