import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { readPayloadUserId } from '../generation/note-generation.service';

// =============================================================================
// Who may watch a generation (issue #52, epic #45, docs/specs/notes.md §6.1)
// =============================================================================
//
// Two entry points into one stream, so two ways of arriving at the same
// question — "is this generation yours?" — and one place that answers it:
//
//   GET /api/notes/:id/stream             → the note's CURRENT generation
//   GET /api/note-generations/:id/stream  → one generation directly (a preview
//                                           has no note, so this is its only
//                                           reachable form)
//
// -----------------------------------------------------------------------------
// ⚠ 404, NEVER 403 — AND THE SAME 404 FOR EVERY REASON
// -----------------------------------------------------------------------------
//
// Carried across from `TranscriptAccessService` and spec §6.1, not restated
// loosely: a 403 confirms that a specific id EXISTS and merely refuses the
// caller, and the existence of somebody's private note — derived from their
// private recorded conversation — is itself something a stranger has no
// business learning.
//
// Every refusal on this path therefore answers the SAME status with the SAME
// byte-identical message: no such row, somebody else's row, a soft-deleted
// note, a note that has never generated anything, a preview whose requester
// cannot be established. Two differently-worded 404s would reintroduce exactly
// the oracle the status code was chosen to remove — "no such generation" versus
// "not yours" tells an attacker precisely what a 403 would have.
//
// ⚠ This is the OPPOSITE posture from `NoteTemplateAccessService` next door,
// which answers 403 for a built-in. That is not an inconsistency: a built-in
// template is listed in every account's own catalogue, so its existence is not
// a secret and hiding it would mislead rather than protect. A generation is
// never visible to anyone but its owner. See that file's header for the full
// argument; do not "make these consistent".
//
// -----------------------------------------------------------------------------
// THE SERVICE RESOLVES THE TARGET, THE CALLER NEVER QUERIES
// -----------------------------------------------------------------------------
//
// Same discipline as every other access service here: the one shape that
// quietly undoes all of the above is a controller that looks the row up itself,
// finds it, and only then asks for permission. Nothing above this may touch
// `note_generations` or `notes` for a stream request.
// =============================================================================

/**
 * The message every refusal uses, verbatim. ONE STRING, SHARED — see the
 * header on why every no-access answer must be byte-identical.
 */
export const NOTE_GENERATION_NOT_FOUND_MESSAGE = 'Note generation not found';

/** An authorised stream target: the row to poll, and the note it belongs to. */
export interface NoteGenerationTarget {
  generationId: string;
  /** `null` for a template preview, which has no note by construction. */
  noteId: string | null;
}

@Injectable()
export class NoteGenerationAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The generation to watch for a note the caller owns.
   *
   * `notes.current_generation_id` is the pointer, exactly as spec §1.3
   * intends: it is set the moment a create or regenerate request enqueues, and
   * never cleared, so this resolves during generation AND afterwards (a late
   * attach to a finished note gets the buffer and an immediate `done` rather
   * than a 404, which is the whole point of §5.2's single code path).
   */
  async requireForNote(userId: string, noteId: string): Promise<NoteGenerationTarget> {
    const note = await this.prisma.note.findUnique({
      where: { id: noteId },
      select: {
        id: true,
        ownerId: true,
        deletedAt: true,
        currentGenerationId: true,
      },
    });

    if (
      !note ||
      note.deletedAt !== null ||
      note.ownerId !== userId ||
      !note.currentGenerationId
    ) {
      throw new NotFoundException(NOTE_GENERATION_NOT_FOUND_MESSAGE);
    }

    return { generationId: note.currentGenerationId, noteId: note.id };
  }

  /**
   * One generation directly, whether or not it has a note.
   *
   * ⚠ A PREVIEW'S OWNER LIVES IN THE JOB PAYLOAD, AND NOWHERE ELSE. A
   * `kind: 'preview'` row has no `note_id` and no user column of its own (spec
   * §4.4 — the row denormalizes its INPUTS, not its requester), so the only
   * place the requesting user travels is the `note.generate` payload's
   * `userId`, read with the same total reader the handler itself uses. A
   * payload that names nobody — an older build, a purged job row whose
   * `SetNull` cleared the link — resolves to no owner, which answers the
   * uniform 404 rather than opening somebody's preview to the world. Failing
   * CLOSED is the only acceptable direction for a fact this one cannot
   * reconstruct.
   */
  async require(userId: string, generationId: string): Promise<NoteGenerationTarget> {
    const generation = await this.prisma.noteGeneration.findUnique({
      where: { id: generationId },
      select: {
        id: true,
        noteId: true,
        note: { select: { ownerId: true, deletedAt: true } },
        job: { select: { payload: true } },
      },
    });

    if (!generation) {
      throw new NotFoundException(NOTE_GENERATION_NOT_FOUND_MESSAGE);
    }

    const owner = generation.note
      ? generation.note.deletedAt === null
        ? generation.note.ownerId
        : null
      : readPayloadUserId(generation.job?.payload ?? null);

    if (!owner || owner !== userId) {
      throw new NotFoundException(NOTE_GENERATION_NOT_FOUND_MESSAGE);
    }

    return { generationId: generation.id, noteId: generation.noteId };
  }
}
