import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Note, NoteGeneration, Prisma } from '@prisma/client';

import type { NoteFailedEmailData, NoteReadyEmailData } from '../../email';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SEARCH_DOC_NOTE } from '../../search/indexing/job-types';
import { SearchIndexService } from '../../search/indexing/search-index.service';
import { NoteTitleService } from './note-title.service';

// =============================================================================
// Persisting one generation (issue #49, epic #45, docs/specs/notes.md §5.1)
// =============================================================================
//
// Everything `note.generate` writes lives here, so the handler stays an
// orchestration of "resolve, budget, stream, settle" and the writes it settles
// with are readable in one place.
//
// -----------------------------------------------------------------------------
// THE NOTE IS COMPLETE AND DURABLE WHETHER OR NOT ANYBODY WAS WATCHING
// -----------------------------------------------------------------------------
//
// This is the single property the whole design is arranged around. The stream
// (#52) is a READER over `note_generations.content`, never the delivery
// mechanism: if it were, a closed tab would mean a generation whose tokens went
// nowhere, and the user would come back to a note that is permanently half
// written or empty. So every delta reaches the row on the way past, and
// completion writes the body, the version and the status in ONE transaction
// that no client is party to.
//
// -----------------------------------------------------------------------------
// THERE IS EXACTLY ONE WRITER OF A `note_generations` ROW
// -----------------------------------------------------------------------------
//
// Spec §1.2: the API only ever CREATES a row in `pending`; every transition
// after that is set by the job. That is what lets `flush` write the whole
// accumulated `content` rather than issuing a SQL string-concatenation append —
// there is no second writer whose text could be lost by a read-modify-write,
// because there is no second writer at all. The `last_event_id` bump travels in
// the SAME `UPDATE`, so the id sequence is gapless by construction (spec §5.1)
// rather than by two statements being kept in step.
//
// -----------------------------------------------------------------------------
// THE COMMIT IS ONE TRANSACTION, AND `notify` IS OUTSIDE IT
// -----------------------------------------------------------------------------
//
// `notes.body` and the `note_versions` row it must equal (schema, §4.1's
// invariant) are written together or not at all. The notification is raised
// AFTER that transaction commits and outside it, per CLAUDE.md's "Adding a
// Notification": a dispatch inside would hold the transaction open across an
// SMTP round trip, and a rollback after the send would mail somebody about a
// note that does not exist.
//
// -----------------------------------------------------------------------------
// TITLING SITS BETWEEN THOSE TWO, AND FOR BOTH OF THEIR REASONS (#182)
// -----------------------------------------------------------------------------
//
// `NoteTitleService` names the note from what it says. It is called AFTER the
// transaction and OUTSIDE it, for exactly the reason `notify` is: its first
// rank is a provider round trip, and a network call inside that transaction
// would hold it open across the internet. And it is called BEFORE `notify`,
// because the "your note is ready" email carries the note's title — raising it
// first would name a title the note stopped having a second later.
//
// ⚠ IT CANNOT FAIL THE NOTE, AND THAT IS ENFORCED TWICE. `titleNote` never
// throws (see its header) — and the call below catches anyway. By the time it
// runs the body, the version and `status: 'ready'` are durable, and a titling
// failure that propagated would turn a successful generation into a failed job
// in front of a user who had just watched their note being written. An
// invariant that expensive to get wrong is worth a second enforcement point;
// the catch at the call site is it.
// =============================================================================

/** A generation row with the note it belongs to (null for a preview). */
export type GenerationWithNote = NoteGeneration & { note: Note | null };

/** Which `note_generations.error_class` a terminal failure is recorded under. */
export type GenerationErrorClass = 'auth' | 'refusal' | 'rate_limit' | 'other';

/** What one terminal failure records and tells the owner. */
export interface MarkFailedInput {
  generation: GenerationWithNote;
  errorClass: GenerationErrorClass;
  /** The sentence the user reads. Written by this application, never a vendor's. */
  reason: string;
  /** Human-readable failure kind for the email/toast ("Your API key"). */
  category: string;
}

/** The assembled context one generation sent (or was about to send) to its provider (#307). */
export interface RecordContextInput {
  systemPrompt: string;
  userContent: string;
  /** The source version materialized into `userContent`; `null` for a document. */
  sourceVersion: number | null;
}

/** What one successful generation commits. */
export interface CommitInput {
  generation: GenerationWithNote;
  /** The full completion text. Becomes `notes.body` AND the version's `body`. */
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /** `AiProvider.label`, for the notification only. */
  providerLabel: string;
  /**
   * The generating template's body format (issue #334), snapshotted onto the
   * note together with the body it describes. Omitted (or unrecognised) means
   * `markdown`.
   */
  bodyFormat?: string | null;
}

@Injectable()
export class NoteGenerationService {
  private readonly logger = new Logger(NoteGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly titles: NoteTitleService,
    private readonly searchIndex: SearchIndexService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** The generation this job is about, or `null` if it is gone. */
  async loadForJob(payload: Prisma.JsonValue | null): Promise<GenerationWithNote | null> {
    const generationId = readGenerationId(payload);

    if (!generationId) return null;

    return this.prisma.noteGeneration.findUnique({
      where: { id: generationId },
      include: { note: true },
    });
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Snapshot WHAT IS ABOUT TO BE SENT to the provider (issue #307).
   *
   * Called after prompt assembly and the budget check and BEFORE the provider
   * request, so a generation that then fails still records what it asked. A
   * budget refusal happens earlier and records nothing — nothing was sent.
   * Previews run the same handler and so record the same snapshot on their own
   * row. A repeat (a retried job for the same row) simply overwrites: the last
   * assembly is the one that was sent.
   */
  async recordContext(generationId: string, input: RecordContextInput): Promise<void> {
    await this.prisma.noteGeneration.update({
      where: { id: generationId },
      data: {
        systemPrompt: input.systemPrompt,
        userContent: input.userContent,
        sourceVersion: input.sourceVersion,
        contextCapturedAt: new Date(),
      },
    });
  }

  /**
   * `pending → streaming`, and the note `→ generating`.
   *
   * Called IMMEDIATELY BEFORE the first provider request and not a moment
   * earlier (spec §1.1/§1.2): prompt assembly and the token-budget check have
   * to be able to fail without ever having claimed the note was generating.
   *
   * The note update is an `updateMany` with a status guard for the same reason
   * `TranscriptPipelineService.markFailed`'s is: an owner who asked for the
   * note to be deleted must not have it dragged back out of `deleting` by a job
   * that was already in flight when they clicked.
   */
  async markStreaming(generation: GenerationWithNote, startedAt: Date): Promise<void> {
    await this.prisma.noteGeneration.update({
      where: { id: generation.id },
      data: { status: 'streaming', startedAt },
    });

    if (generation.noteId) {
      await this.prisma.note.updateMany({
        where: { id: generation.noteId, deletedAt: null, status: { not: 'deleting' } },
        data: { status: 'generating', failureReason: null },
      });
    }
  }

  /**
   * Write the text received so far, and publish one stream event for it.
   *
   * ⚠ `content` IS THE WHOLE ACCUMULATED STRING, not the new fragment — see the
   * header on why a single writer makes that the simpler and equally correct
   * choice. `lastEventId` increments in the same statement, which is what makes
   * "the id a reader saw" and "the text that was there when they saw it"
   * impossible to disagree.
   */
  async flush(generationId: string, content: string): Promise<void> {
    await this.prisma.noteGeneration.update({
      where: { id: generationId },
      data: { content, lastEventId: { increment: 1 } },
    });
  }

  /**
   * Commit a finished generation: the buffer, the body, the version, the status.
   *
   * ⚠ EVERYTHING EXCEPT THE NOTIFICATION IS IN ONE TRANSACTION. `notes.body`
   * must equal the `note_versions` row named by `notes.current_version` — that
   * is the invariant the whole read path rests on — so a partial write here is
   * the one outcome that must be unrepresentable.
   *
   * A PREVIEW (`noteId === null`) settles the generation and stops: it has no
   * note to write a body to and no version to append, which is exactly why the
   * row denormalizes its own inputs.
   */
  async commit(input: CommitInput): Promise<void> {
    const { generation, content } = input;
    const completedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.noteGeneration.update({
        where: { id: generation.id },
        data: {
          status: 'succeeded',
          content,
          lastEventId: { increment: 1 },
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          completedAt,
        },
      });

      if (!generation.noteId) return;

      // Re-read INSIDE the transaction: the version number has to come from the
      // row as it is right now, not from the copy this job loaded minutes ago,
      // or two writers (this job and a `PATCH` edit that landed meanwhile)
      // would both claim the same `version` and the `@@unique([noteId,
      // version])` would reject one of them at random.
      const note = await tx.note.findUnique({
        where: { id: generation.noteId },
        select: { id: true, currentVersion: true, status: true, deletedAt: true },
      });

      if (!note || note.deletedAt !== null || note.status === 'deleting') {
        // The owner deleted it while the model was writing. The generation row
        // keeps its content — it is the record of what the provider produced
        // and what it cost — and nothing is resurrected.
        this.logger.log(
          `Note ${generation.noteId} was removed while generation ${generation.id} was ` +
            'streaming; the completion is recorded but no version was written',
        );

        return;
      }

      const version = note.currentVersion + 1;
      const bodyFormat = input.bodyFormat === 'plain_text' ? 'plain_text' : 'markdown';

      await tx.noteVersion.create({
        data: {
          noteId: note.id,
          version,
          kind: 'ai_generated',
          body: content,
          // ⚠ `null` MEANS THE AI, and it is a statement, not a missing value —
          // the identical convention `transcript_versions.author_id` uses.
          authorId: null,
          generationId: generation.id,
          // The version carries its own format (#337), the same value written
          // to the note below, so a later restore brings the format back too.
          bodyFormat,
        },
      });

      await tx.note.update({
        where: { id: note.id },
        data: {
          body: content,
          // ⚠ Written WITH the body it describes, in the same transaction
          // (#334): a regeneration that switched templates changes the format
          // only if it actually produces a new body, so a failed run can never
          // leave the old body labelled with the new template's format.
          bodyFormat,
          currentVersion: version,
          status: 'ready',
          failureReason: null,
          provider: generation.providerId,
          model: generation.model,
        },
      });
    });

    // ⚠ A PREVIEW IS NEVER TITLED, and returns before the call below. It has no
    // note to name, is never listed anywhere, and is hard-deleted at its
    // ten-minute TTL — spending a request and a user's tokens on a name nobody
    // will ever read is the one clearly wrong thing to do here.
    if (!generation.noteId) return;

    // AFTER the transaction, OUTSIDE it. `notify` is detached and never
    // rejects, so this cannot turn a committed note into a thrown job.
    const note = generation.note;

    if (!note) return;

    // NAME THE NOTE FIRST, TELL THE OWNER SECOND (#182). Both are outside the
    // transaction, and the order between them is not arbitrary: the email
    // carries the title, so a notification raised first would name the title
    // the note had a moment ago. `titleNote` returns the title the note carries
    // now, or `null` when it could not produce one, in which case the copy this
    // job loaded is the best we have.
    //
    // ⚠ THE CATCH IS A SECOND ENFORCEMENT POINT, NOT A DOUBT ABOUT `titleNote`.
    // Its contract is that it never throws — every rank is wrapped and its
    // outermost `try` covers even the database reads (see its header) — and
    // nothing here weakens or moves that. But by this line the body, the
    // version and `status: 'ready'` are already committed and durable, while
    // `commit()` itself runs inside `NoteGenerateHandler.generate()`'s try
    // block: anything escaping here would be classified `'other'`, handed to
    // `markFailed()`, and would flip an already-`ready` note to `failed` and
    // mail its owner `notes.note_failed` about a note they had just watched
    // being written. One belt, one pair of braces — the cost of that contract
    // being broken once, by a future bug here or a substituted implementation
    // that does not honour it, is a user losing a finished note over its name.
    // A throw is logged at `warn` so a broken contract is visible rather than
    // silent, and falls through to `note.title` exactly as a `null` does.
    let title: string | null = null;

    try {
      title = await this.titles.titleNote({
        noteId: note.id,
        ownerId: note.ownerId,
        body: content,
        providerId: generation.providerId,
        model: generation.model,
      });
    } catch (error) {
      this.logger.warn(
        `Titling note ${note.id} threw, which \`titleNote\`'s own contract forbids; ` +
          `the note keeps the title it has: ${String(error)}`,
      );
    }

    // -------------------------------------------------------------------------
    // Semantic index (#188, epic #165). AFTER TITLING, BEFORE NOTIFYING.
    // -------------------------------------------------------------------------
    //
    // The order is not arbitrary, and it is the same argument the titling/
    // notification order above makes one step earlier. `noteChunkPrefix(title)`
    // is prefixed onto EVERY chunk of a note, so the title is part of what gets
    // embedded and part of what gets hashed — indexing before `titleNote` ran
    // would embed the whole note under the placeholder title and then have to
    // re-embed all of it the moment the real one landed, on the owner's own
    // vendor account.
    //
    // ⚠ THIS IS ALSO WHY `POST /api/notes/:id/regenerate` HAS NO ENQUEUE OF ITS
    // OWN. A regeneration queues a fresh `note.generate`, whose body arrives
    // here; indexing at the moment the button was pressed would index the note
    // as it was BEFORE the regeneration, and then never again. Every AI-written
    // body reaches the index through this one line.
    //
    // Never throws into the job: `enqueue` is awaited inside a `try` because by
    // this point the body, the version and `status: 'ready'` are committed and
    // durable, while `commit()` runs inside `NoteGenerateHandler.generate()`'s
    // try block — anything escaping here would be classified `'other'`, flip an
    // already-`ready` note to `failed`, and mail its owner about a note they had
    // just watched being written. Exactly the reason the titling call above is
    // wrapped.
    try {
      await this.searchIndex.enqueue(SEARCH_DOC_NOTE, note.id);
    } catch (error) {
      this.logger.warn(
        `Could not queue a semantic index of note ${note.id}: ${String(error)}`,
      );
    }

    const payload: NoteReadyEmailData = {
      noteId: note.id,
      title: title ?? note.title,
      templateName: generation.templateNameSnapshot,
      providerLabel: input.providerLabel,
      model: generation.model,
      wordCount: countWords(content),
      appUrl: this.appUrl(),
    };

    await this.notifications.notify('notes.note_ready', note.ownerId, payload);
  }

  /**
   * Record a terminal failure on the generation and (when there is one) the note.
   *
   * ⚠ THE HANDLER RETURNS NORMALLY AFTER THIS for every domain class (spec
   * §2.2): the job SUCCEEDED at determining a permanent outcome, and retrying
   * would re-ask a question whose answer cannot change — against the user's own
   * billed account.
   */
  async markFailed(input: MarkFailedInput): Promise<void> {
    const { generation, errorClass, reason } = input;

    await this.prisma.noteGeneration.update({
      where: { id: generation.id },
      data: {
        status: 'failed',
        errorClass,
        errorDetail: reason,
        completedAt: new Date(),
      },
    });

    if (!generation.noteId || !generation.note) {
      // A preview has no note to fail and no note page to show it on. Spec's
      // `notes.preview_failed` event is the surface for that case and belongs
      // to the issue that adds previews; raising `notes.note_failed` here would
      // mail somebody a link to a note that does not exist.
      this.logger.warn(
        `Generation ${generation.id} failed (${errorClass}): ${reason}`,
      );

      return;
    }

    const updated = await this.prisma.note.updateMany({
      where: {
        id: generation.noteId,
        deletedAt: null,
        status: { notIn: ['failed', 'deleting'] },
      },
      data: { status: 'failed', failureReason: reason },
    });

    this.logger.warn(
      `Note ${generation.noteId} generation ${generation.id} failed (${errorClass}): ${reason}`,
    );

    if (updated.count === 0) {
      // Already terminal or already deleted — nothing changed, so there is
      // nothing to tell the owner about.
      return;
    }

    const payload: NoteFailedEmailData = {
      noteId: generation.note.id,
      title: generation.note.title,
      reason,
      category: input.category,
      appUrl: this.appUrl(),
    };

    await this.notifications.notify(
      'notes.note_failed',
      generation.note.ownerId,
      payload,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Absolute application root for an email CTA, or `undefined`.
   *
   * Same shape as `TranscriptPipelineService.appUrl()`; `undefined` makes the
   * template omit its button rather than render one that goes nowhere.
   */
  private appUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');

    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }
}

/**
 * The generation id inside a job payload, or `null`.
 *
 * TOTAL OVER GARBAGE, exactly like `readTranscriptId`: a payload is JSONB
 * written by an earlier process and possibly an earlier build — it can be null,
 * a string, an array, or an object with the wrong field. Every one of those
 * means "this job is about nothing", which a handler answers by returning
 * successfully rather than by throwing until the queue gives up.
 */
export function readGenerationId(payload: Prisma.JsonValue | null): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>).generationId;

  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The user a generation is billed to, when the job payload names one.
 *
 * ⚠ A SEAM FOR PREVIEWS, AND ONLY THAT. A `create`/`regenerate` generation's
 * user is its note's owner and is read from the row; a `kind: 'preview'` row
 * has no note and no user column of its own (schema, spec §4.4), so the only
 * place the requester can travel is the job payload. Reading it here keeps the
 * preview issue to "enqueue with `userId`" rather than a schema change.
 */
export function readPayloadUserId(payload: Prisma.JsonValue | null): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>).userId;

  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Words in the generated note, for the notification's size cue. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * The five template columns `assemblePrompt` reads, as a job payload may carry
 * them.
 *
 * ⚠ A SNAPSHOT, NOT A REFERENCE — and the ONLY case in which one travels. See
 * {@link readPayloadTemplate}.
 */
export interface PayloadTemplateSnapshot {
  instructions: string;
  outputFormat: string;
  /**
   * `markdown` or `plain_text` (issue #334). A payload written before the
   * field existed, or carrying anything unrecognised, reads as `markdown`.
   */
  bodyFormat: 'markdown' | 'plain_text';
  structure: string[];
  tone: string | null;
  length: string | null;
}

/**
 * The UNSAVED template a preview is generating from, when the payload names one.
 *
 * ⚠ A SEAM FOR PREVIEWS OF AN UNSAVED TEMPLATE, AND ONLY THAT — the exact
 * counterpart of {@link readPayloadUserId} above, added by the same issue (#50)
 * for the same reason. `POST /api/note-templates/preview` accepts a template
 * body INLINE so the editor can try edits it has not saved; `note_generations`
 * has columns for a generation's inputs but not for the five template columns,
 * so an inline body has nowhere but the payload to live. Reading it here keeps
 * the preview issue to "enqueue with a snapshot" rather than a schema change.
 *
 * ⚠ IT IS READ **ONLY** WHEN `template_id` IS NULL (see the handler). A preview
 * of a SAVED template — the common case — sets `template_id` and carries no
 * snapshot at all, so the job reads the row exactly as a real generation does.
 * That is what makes "one generation mechanism, two entry points" true by
 * construction rather than by two code paths being kept in step: there is only
 * ever one source for the template, and which one it is is decided by a column,
 * not by a merge.
 *
 * TOTAL OVER GARBAGE, like every other payload reader in this file: the payload
 * is JSONB written by a possibly-earlier build. Anything not positively
 * recognised is `null`, which the handler turns into a readable domain failure
 * rather than a crash. `structure` is passed through untouched — the handler
 * normalises it with `parseTemplateStructure`, the SAME total reader the stored
 * path uses, so a malformed entry is dropped identically on both paths.
 */
export function readPayloadTemplate(
  payload: Prisma.JsonValue | null,
): PayloadTemplateSnapshot | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>).template;

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const template = value as Record<string, unknown>;

  const instructions = template.instructions;
  const outputFormat = template.outputFormat;

  if (typeof instructions !== 'string' || typeof outputFormat !== 'string') {
    return null;
  }

  return {
    instructions,
    outputFormat,
    bodyFormat: template.bodyFormat === 'plain_text' ? 'plain_text' : 'markdown',
    structure: Array.isArray(template.structure)
      ? template.structure.filter((entry): entry is string => typeof entry === 'string')
      : [],
    tone: typeof template.tone === 'string' ? template.tone : null,
    length: typeof template.length === 'string' ? template.length : null,
  };
}
