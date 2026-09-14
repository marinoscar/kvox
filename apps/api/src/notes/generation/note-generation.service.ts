import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Note, NoteGeneration, Prisma } from '@prisma/client';

import type { NoteFailedEmailData, NoteReadyEmailData } from '../../email';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';

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

/** What one successful generation commits. */
export interface CommitInput {
  generation: GenerationWithNote;
  /** The full completion text. Becomes `notes.body` AND the version's `body`. */
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /** `AiProvider.label`, for the notification only. */
  providerLabel: string;
}

@Injectable()
export class NoteGenerationService {
  private readonly logger = new Logger(NoteGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
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
        },
      });

      await tx.note.update({
        where: { id: note.id },
        data: {
          body: content,
          currentVersion: version,
          status: 'ready',
          failureReason: null,
          provider: generation.providerId,
          model: generation.model,
        },
      });
    });

    if (!generation.noteId) return;

    // AFTER the transaction, OUTSIDE it. `notify` is detached and never
    // rejects, so this cannot turn a committed note into a thrown job.
    const note = generation.note;

    if (!note) return;

    const payload: NoteReadyEmailData = {
      noteId: note.id,
      title: note.title,
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
    structure: Array.isArray(template.structure)
      ? template.structure.filter((entry): entry is string => typeof entry === 'string')
      : [],
    tone: typeof template.tone === 'string' ? template.tone : null,
    length: typeof template.length === 'string' ? template.length : null,
  };
}
