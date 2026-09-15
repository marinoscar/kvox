import { Injectable, Logger } from '@nestjs/common';

import { modelKnowledgeOf, resolveAllowedModel } from '../../ai/ai-model-resolution';
import { AiProviderRegistry } from '../../ai/ai-provider.registry';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { createProviderContext } from '../../ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_TITLE_CHARS } from '../dto/note.dto';
import { aiProviderThrottleKey, NOTE_GENERATE_JOB_TYPE } from '../job-types';
import { readAllowedModelEntries } from './allowed-models';
import { deriveTitleFromBody, truncateTitle } from './title-derivation';

// =============================================================================
// Naming a generated note (issue #182, epic #163)
// =============================================================================
//
// Until this file, a note was called whatever its TEMPLATE was called, so a
// user who generated four notes from "Meeting notes" had four notes called
// "Meeting notes" and no way to tell them apart in a list. This service runs
// once, immediately after a generation's body has committed, and gives the note
// a name taken from what it actually says.
//
// THREE RANKS, EACH A FALLBACK FOR THE ONE ABOVE IT:
//
//   1. A DEDICATED TITLING COMPLETION against the committed body — the same
//      provider, model, policy and USER'S OWN KEY the body was generated with,
//      resolved the same way `note-generate.handler.ts` resolves them. It is a
//      second, tiny request rather than a line bolted onto the generation
//      prompt, because a note whose first line is its own title is a note the
//      user then has to delete a line from.
//   2. `deriveTitleFromBody` — the note's first heading, else its first
//      sentence. Pure, no provider, no key, no network: see
//      `title-derivation.ts` for why that is the whole point of it being a
//      separate file.
//   3. NOTHING. The note keeps the title it has, which is today's
//      template-name behaviour and is never wrong, only uninformative.
//
// -----------------------------------------------------------------------------
// ⚠ `titleNote` MUST NEVER THROW, AND THAT IS THE LOAD-BEARING PROPERTY
// -----------------------------------------------------------------------------
//
// By the time this runs the note is ALREADY COMMITTED AND DURABLE: the body,
// the version row and `notes.status = 'ready'` were written by the transaction
// that called us. A title is a garnish on work that has already succeeded. So
// an auth failure, a refusal, a 429, a timeout, a provider this build does not
// have, a key the user erased between the generation and now, or `ai.enabled`
// switched off mid-flight must all fall through to rank 2 and then rank 3 —
// never out of this method. An exception escaping here would turn a successful
// generation into a FAILED JOB and a failed note, and the user would lose the
// note they had just watched being written, for the sake of naming it.
//
// Every rank is wrapped, the outermost `try` covers even the database reads,
// and each fallthrough is logged with its reason at `warn` (something went
// wrong) or `debug` (nothing went wrong; this deployment simply cannot title).
//
// ⚠ A RATE LIMIT IS CAUGHT HERE AND NEVER RETHROWN. Everywhere else in this
// codebase a `RateLimitError` is re-thrown so the queue defers the job without
// charging an attempt — correct there, because the work has not been done yet.
// Here deferring would re-run a job whose entire remaining purpose is one
// 32-token request, and would leave the user looking at a note that is finished
// but reported as still working. Catch it, log it, take rank 2.
//
// -----------------------------------------------------------------------------
// `titleSource: 'user'` IS STICKY, AND THIS IS THE CHECK THE COLUMN EXISTS FOR
// -----------------------------------------------------------------------------
//
// The note is re-read INSIDE this method rather than trusted from the caller's
// copy, because minutes of streaming may have passed since that copy was taken
// and the owner may have renamed the note in the meantime. A title a person
// chose is theirs; nothing here overwrites one. The final write is an
// `updateMany` guarded on `titleSource: { not: 'user' }` as well, so a rename
// that lands in the window between the read and the write still wins the race —
// the guard is in the WHERE clause, where a race cannot get between the two.
// =============================================================================

/** What titling one note needs. Everything the caller already has in hand. */
export interface TitleNoteInput {
  noteId: string;
  /** Whose key rank 1 spends, and whose throttle bucket it draws on. */
  ownerId: string;
  /** The body as just committed — never re-read, so the two cannot disagree. */
  body: string;
  /** `note_generations.provider_id`. `null` skips rank 1. */
  providerId: string | null;
  /** `note_generations.model`. `null` skips rank 1. */
  model: string | null;
}

/**
 * Characters of the body rank 1 is shown.
 *
 * ⚠ AN EXCERPT, NOT THE WHOLE NOTE, AND THE SIZE IS A JUDGEMENT WITH A REASON.
 * A title describes what a document is about, and a document says what it is
 * about at the top — the opening heading and first two or three paragraphs.
 * Sending the whole body would bill the user a second full pass over their own
 * note for information the first 2,000 characters already carried, and would
 * put this call back inside the token budget's reach, where a long note could
 * make TITLING the thing that fails. 2,000 characters is roughly 500 tokens:
 * enough for a heading plus several paragraphs, small enough that it fits every
 * model this build can reach without a budget check of its own.
 */
export const TITLE_EXCERPT_CHARS = 2_000;

/**
 * Tokens rank 1 may spend answering.
 *
 * A title is at most eight words. 32 tokens is several times that in every
 * language, and a ceiling this low is also the cheapest possible guard against
 * a model that ignores the instruction and starts writing prose.
 */
export const TITLE_MAX_OUTPUT_TOKENS = 32;

/**
 * How long rank 1 may take before it is abandoned for rank 2.
 *
 * ⚠ DELIBERATELY SHORTER THAN `ai.requestTimeoutMs`, which is the ceiling for
 * generating a whole note and may legitimately be minutes. This request sends
 * ~500 tokens and asks for ~32; it does not need minutes, and it is spending
 * time that belongs to a `note.generate` job whose own `maxRuntimeMs` is ten
 * minutes and whose real work is already finished. A titling call that ran long
 * enough to push the job into its runtime ceiling would mark a FAILED job for a
 * note that succeeded — the exact outcome this file's never-throws rule exists
 * to prevent, arrived at from the other direction. The effective timeout is the
 * SMALLER of this and the policy's, so a deployment that has deliberately
 * tightened `requestTimeoutMs` is still respected.
 */
export const TITLE_REQUEST_TIMEOUT_MS = 30_000;

/** What rank 1 is told to produce. Short, because the answer is short. */
const TITLE_SYSTEM_PROMPT = [
  'You name documents.',
  'You are given the opening of a document. Reply with a title for it and nothing else.',
  '',
  'Rules:',
  '- At most 8 words.',
  '- Write the title in the same language as the document.',
  '- Plain text only: no quotation marks, no Markdown, no emoji, no trailing full stop.',
  '- No preamble. Do not write "Title:" and do not explain your choice.',
  '- Name what the document is about, specifically. "Meeting notes" is not a title.',
].join('\n');

@Injectable()
export class NoteTitleService {
  private readonly logger = new Logger(NoteTitleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: AiProviderRegistry,
    private readonly settings: AiSettingsService,
    private readonly credentials: UserAiCredentialsService,
    private readonly throttle: ProviderThrottleService,
  ) {}

  /**
   * Give this note a title taken from its own content.
   *
   * ⚠ NEVER THROWS — see the header. Returns the title the note carries when
   * this method is done with it: the new one when it wrote one, the existing
   * one when it did not, and `null` only when it could not read the note at
   * all. The caller uses the return value for the "your note is ready"
   * notification, so that the email cannot name a title the note no longer has.
   */
  async titleNote(input: TitleNoteInput): Promise<string | null> {
    try {
      return await this.run(input);
    } catch (error) {
      // The backstop for everything the ranks below did not already catch — a
      // database blip, a bug in this file. It is logged and swallowed, because
      // the note this would fail is already written.
      this.logger.warn(
        `Titling note ${input.noteId} failed unexpectedly; its title is unchanged: ${describeError(error)}`,
      );

      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // The three ranks
  // ---------------------------------------------------------------------------

  private async run(input: TitleNoteInput): Promise<string | null> {
    const note = await this.prisma.note.findUnique({
      where: { id: input.noteId },
      select: { id: true, title: true, titleSource: true, status: true, deletedAt: true },
    });

    if (!note) return null;

    if (note.deletedAt !== null || note.status === 'deleting') {
      // The owner deleted it while the model was writing. Naming it now would
      // be a write to a row on its way out.
      this.logger.debug(`Note ${note.id} is being deleted; it is not titled`);

      return note.title;
    }

    if (note.titleSource === 'user') {
      // ⚠ THE CHECK THE COLUMN EXISTS FOR. A person named this note; that name
      // is theirs and no titling pass overwrites it, ever.
      this.logger.debug(`Note ${note.id} has a user-chosen title; it is left alone`);

      return note.title;
    }

    const proposed = (await this.proposeWithModel(input)) ?? deriveTitleFromBody(input.body, MAX_TITLE_CHARS);

    if (!proposed) {
      // RANK 3. A body with no heading and no sentence — nothing usable — so
      // the note keeps the template's name, which is what it had anyway.
      this.logger.debug(`Note ${note.id} yielded no usable title; it keeps "${note.title}"`);

      return note.title;
    }

    if (proposed === note.title) return note.title;

    const updated = await this.prisma.note.updateMany({
      // ⚠ THE `titleSource` GUARD IS IN THE WHERE CLAUSE, not in an `if` above
      // it: a rename that landed while the model was thinking must win, and
      // only the database can decide that without a window between the check
      // and the write.
      where: { id: note.id, deletedAt: null, titleSource: { not: 'user' } },
      data: { title: proposed, titleSource: 'ai' },
    });

    if (updated.count === 0) {
      // Renamed or deleted underneath us. Whatever is there now is the truth.
      const current = await this.prisma.note.findUnique({
        where: { id: note.id },
        select: { title: true },
      });

      this.logger.debug(
        `Note ${note.id} was renamed or removed while it was being titled; the proposed title was discarded`,
      );

      return current?.title ?? null;
    }

    this.logger.log(`Note ${note.id} titled "${proposed}"`);

    return proposed;
  }

  /**
   * RANK 1: ask the model that wrote the note what it would call it.
   *
   * Returns `null` for every reason this cannot happen, and throws for none of
   * them — the caller's next line is rank 2 either way, so distinguishing
   * "refused" from "not configured" here would only move the same fallthrough
   * one frame outwards.
   */
  private async proposeWithModel(input: TitleNoteInput): Promise<string | null> {
    try {
      return await this.callProvider(input);
    } catch (error) {
      // ⚠ INCLUDING `RateLimitError` — see the header. Nothing is deferred and
      // nothing is retried: the work this job existed to do is already durable.
      this.logger.warn(
        `Could not title note ${input.noteId} with the model; falling back to its own text: ${describeError(error)}`,
      );

      return null;
    }
  }

  private async callProvider(input: TitleNoteInput): Promise<string | null> {
    const { providerId, model, ownerId } = input;

    if (!providerId || !model) {
      this.logger.debug(`Note ${input.noteId} names no provider or model; rank 1 is skipped`);

      return null;
    }

    // -------------------------------------------------------------------------
    // Policy, provider, model, settings, key — the SAME resolution
    // `note-generate.handler.ts` performs, in the same order, deliberately not
    // a second shape of it. A model this deployment has withdrawn, or a key the
    // user has since erased, must stop this pass exactly where it would stop a
    // generation.
    // -------------------------------------------------------------------------
    const policy = await this.settings.get();

    if (!policy.enabled) {
      this.logger.debug('AI is switched off for this deployment; rank 1 is skipped');

      return null;
    }

    const provider = this.providers.get(providerId);

    if (!provider) {
      this.logger.debug(`Provider "${providerId}" is not in this build; rank 1 is skipped`);

      return null;
    }

    const entry = readAllowedModelEntries(policy.providers, provider.id).find(
      (allowed) => allowed.id === model,
    );

    if (!entry) {
      this.logger.debug(`Model "${model}" is no longer permitted; rank 1 is skipped`);

      return null;
    }

    const descriptor = resolveAllowedModel(entry, modelKnowledgeOf(provider));

    if (!descriptor) {
      this.logger.debug(`Model "${model}" has no resolvable limits; rank 1 is skipped`);

      return null;
    }

    const settings = provider.settingsSchema.safeParse(
      (policy.providers as Record<string, unknown>)[provider.id] ?? {},
    );

    if (!settings.success) {
      this.logger.debug(
        `Provider "${provider.id}" is misconfigured for this deployment; rank 1 is skipped`,
      );

      return null;
    }

    const apiKey = await this.credentials.getSecret(ownerId, provider.id);

    if (!apiKey) {
      // The key was erased between the generation and now — an ordinary thing
      // for a user to do, and not a failure of anything.
      this.logger.debug(`No ${provider.label} key is saved for this note's owner; rank 1 is skipped`);

      return null;
    }

    // ⚠ THE PER-USER BUCKET, NEVER A SHARED DEPLOYMENT ONE. Every user brings
    // their own vendor account with their own rate limit, so a 429 against user
    // A's key is evidence about user A and about nobody else; a shared
    // `'ai-provider'` key would let one busy user's quota park every other
    // user's generations behind it — a relationship between the accounts that
    // does not exist (`aiProviderThrottleKey`, docs/specs/notes.md §2.3). This
    // pass runs inside `note.generate`, so it registers that type's key, which
    // the handler has already set to this same value for this same user.
    this.throttle.registerProviderKey(NOTE_GENERATE_JOB_TYPE, aiProviderThrottleKey(ownerId));

    const ctx = createProviderContext(apiKey, settings.data);

    let answer = '';
    let finishReason: string | null = null;

    for await (const event of provider.generate(ctx, {
      model,
      systemPrompt: TITLE_SYSTEM_PROMPT,
      userContent: buildTitleUserContent(input.body),
      // Never more than the model itself will produce, which is what
      // `descriptor` is resolved for — a ceiling above a model's own is a
      // request some vendors reject outright.
      maxOutputTokens: Math.min(TITLE_MAX_OUTPUT_TOKENS, descriptor.maxOutputTokens),
      timeoutMs: Math.min(TITLE_REQUEST_TIMEOUT_MS, policy.requestTimeoutMs),
      // ⚠ `'none'`, NOT `policy.reasoningEffort`, AND THIS IS NOT AN OVERSIGHT.
      // Reasoning tokens are billed and counted as OUTPUT, drawn from the same
      // ceiling as the answer (`AiGenerateRequest.reasoningEffort`'s own
      // warning) — so at 32 tokens a thinking model would spend the entire
      // budget thinking and emit no title at all. The deployment's effort
      // policy is a statement about generating a note's content, not about
      // naming it.
      reasoningEffort: 'none',
    })) {
      if (event.kind === 'delta') {
        answer += event.text;

        continue;
      }

      finishReason = event.finishReason;
    }

    if (finishReason === 'content_filter') {
      // The provider declined to name it. That is an answer, and it is "no".
      this.logger.debug(`Titling note ${input.noteId} was declined by ${provider.label}`);

      return null;
    }

    // The handful of tokens this costs is billed to the note's owner along with
    // the generation itself and is deliberately not recorded anywhere:
    // `note_generations` counts what produced the NOTE, and a per-note token
    // total that silently included its title would be a number nobody could
    // reconcile against their vendor invoice.
    return sanitizeModelTitle(answer);
  }
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/** The one user message rank 1 sends: an excerpt, and nothing else. */
export function buildTitleUserContent(body: string): string {
  const excerpt = body.slice(0, TITLE_EXCERPT_CHARS).trim();

  return `Document:\n\n${excerpt}`;
}

/**
 * The model's answer, as a title — or `null` when it is not usable as one.
 *
 * TOTAL AND NEVER THROWS. It is handed whatever a vendor streamed back, which
 * on a bad day is an empty string, a paragraph, a quoted phrase, a Markdown
 * heading, or the word "Title:" followed by the title. Anything that cannot be
 * reduced to one plain line is `null`, which is rank 2's cue.
 */
export function sanitizeModelTitle(answer: string): string | null {
  // MULTI-LINE MEANS THE FIRST LINE. A model that explained itself put the
  // title on line one and the explanation after it.
  const firstLine = answer.split(/\r?\n/).find((line) => line.trim().length > 0);

  if (!firstLine) return null;

  // A leading `#` is the model formatting its answer as a heading.
  const unheaded = firstLine.trim().replace(/^#{1,6}\s*/, '');

  // TWICE, BECAUSE THE TWO HABITS COMBINE. A model that labelled its answer may
  // also have quoted it — either just the title (`Title: "x"`) or the whole
  // thing including the label (`"Title: x"`) — and one pass can only reach
  // whichever of the two is on the outside.
  const cleaned = stripWrappers(stripWrappers(unheaded)).replace(/\s+/g, ' ').trim();

  // Nothing left once the wrapping came off — an answer that was ONLY a label
  // or only quotes. Rank 2 takes it from here.
  if (cleaned.length === 0) return null;

  // Over the column's ceiling is not a refusal — it is a title that ran long,
  // and `truncateTitle` is the same cut rank 2 makes, for the same reason.
  return truncateTitle(cleaned, MAX_TITLE_CHARS);
}

/**
 * One layer of the decoration a model puts around a title it was asked for
 * bare: a `Title:` label, then whatever quotes surround what is left.
 *
 * The label goes FIRST so that `Title: "x"` loses it before the quotes are
 * considered; {@link sanitizeModelTitle} runs the pair twice so `"Title: x"`,
 * where the quotes are on the outside, comes out just as clean.
 */
function stripWrappers(text: string): string {
  return (
    text
      // The model announced its answer instead of just giving it. ⚠ THE
      // PUNCTUATION IS MANDATORY, and that is the whole guard: an optional
      // separator would match the bare word, so `Title Deeds Explained` would
      // be filed under `Deeds Explained`. A model that labels without
      // punctuation keeps the word — a rare quirk, against a title a user may
      // really have. (`\b` is belt and braces for `Titled`/`Titles`.)
      .replace(/^title\b\s*[:\-\u2014\u2013]\s*/i, '')
      // Surrounding quotes, straight or curly, single or double.
      .replace(/^["'“”‘’«»]+/, '')
      .replace(/["'“”‘’«»]+$/, '')
      .trim()
  );
}

/**
 * One line about a thrown value, for a log.
 *
 * ⚠ FOR A LOG LINE ONLY — it is never shown to a user and never written to a
 * row. Nothing in this file has a user-facing failure to report, because
 * nothing in this file is allowed to fail the note: `Job.lastError` and
 * `notes.failure_reason` belong to the generation, which already succeeded.
 * The stack is deliberately left off, so an operator reading a `warn` about a
 * garnish gets one line rather than twenty.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;

  return 'an unrecognised error';
}
