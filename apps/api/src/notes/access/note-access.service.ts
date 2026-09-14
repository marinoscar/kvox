// =============================================================================
// NoteAccessService (issue #53, epic #45, docs/specs/notes.md §6.1)
// =============================================================================
//
// ONE FUNCTION, THREE LEVELS, AND A 404 FOR EVERYTHING ELSE.
//
//   require(userId, noteId, 'view' | 'edit' | 'own')
//
// -----------------------------------------------------------------------------
// ⚠ THREE LEVELS THAT ALL COLLAPSE TO ONE OWNERSHIP CHECK — ON PURPOSE
// -----------------------------------------------------------------------------
//
// There is no `note_shares` table in v1 (spec §6.2: note sharing is out of
// scope for epic #45 entirely, so that when it is built it can be modelled
// directly on `transcript_shares`' already-proven shape rather than inventing a
// second sharing model that disagrees with the first). So today only the owner
// satisfies any level and everybody else gets the same 404.
//
// Keeping the three-level interface NOW — rather than a bare
// `requireOwner(userId, noteId)` — is the entire point of this file existing as
// a service at all: the day sharing lands it slots in here exactly the way
// `transcript_shares` slots into `TranscriptAccessService`, with ZERO call-site
// changes anywhere that already asked for `'view'`, `'edit'` or `'own'`. A
// codebase that wrote `requireOwner` everywhere would have to revisit every
// call site and decide, one at a time and under time pressure, which of them
// meant "view" and which meant "own" — and would get some of them wrong.
//
// -----------------------------------------------------------------------------
// ⚠ NO ACCESS IS A 404. NEVER A 403. ON EVERY ROUTE.
// -----------------------------------------------------------------------------
//
// Carried across from `TranscriptAccessService` and spec §6.1, not restated
// loosely: a 403 confirms that note `abc123` exists and merely refuses the
// caller. A note is derived from somebody's private recorded conversation, and
// the existence of a specific id is itself something a stranger has no business
// learning. Read, patch, version, restore and delete all answer identically —
// with the SAME status and the SAME byte-identical message, because two
// differently-worded 404s would reintroduce exactly the oracle the status code
// was chosen to remove.
//
// ⚠ This is the OPPOSITE posture from `NoteTemplateAccessService` next door,
// which answers 403 for a built-in. That is not an inconsistency — a built-in
// template is listed in every account's own catalogue, so its existence is not
// a secret. See that file's header; do not "make these consistent".
//
// -----------------------------------------------------------------------------
// THE SERVICE RETURNS THE ROW
// -----------------------------------------------------------------------------
//
// The one shape that quietly undoes all of the above is a caller that looks the
// row up itself, finds it, and only then asks for permission. So `require`
// returns the note: there is no reason for anything above this to query `notes`
// on its own, and no code path where a caller holds a note it was not
// authorised for.
//
// -----------------------------------------------------------------------------
// `edit`/`own` ALSO REQUIRE `notes:write`, AND THAT ONE IS A 403
// -----------------------------------------------------------------------------
//
// Exactly as `TranscriptAccessService.assertWritePermission` reasons: a caller
// who can genuinely SEE the note already knows it exists, so there is nothing
// left to conceal and a 404 would tell them their own note had vanished. The
// 404 rule protects the EXISTENCE of a row from somebody with no access at all;
// it is not a blanket instruction to lie to people who can see the thing.
// =============================================================================

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Note } from '@prisma/client';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import { PrismaService } from '../../prisma/prisma.service';

/** What a caller is asking to do. Ordered least to most. */
export type NoteAccessLevel = 'view' | 'edit' | 'own';

/**
 * How this caller reaches this note.
 *
 * Only `owner` is reachable in this epic. The union is declared with the shape
 * sharing will need (`editor`/`viewer`, exactly `TranscriptAccessRole`'s
 * members) so that adding them later is a change to this file and to nothing
 * that consumes it.
 */
export type NoteAccessRole = 'owner' | 'editor' | 'viewer';

/** The answer: the row, and the role that admitted the caller to it. */
export interface NoteAccess {
  note: Note;
  role: NoteAccessRole;
}

/**
 * The message every no-access answer uses, verbatim.
 *
 * ONE STRING, SHARED, so "not found" and "not yours" are byte-identical. See
 * the header.
 */
export const NOTE_NOT_FOUND_MESSAGE = 'Note not found';

@Injectable()
export class NoteAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Authorise, and return the row.
   *
   * `permissions` is the caller's effective permission list, as the JWT carries
   * it. It is only consulted for `edit`/`own`; passing it for a `view` check
   * costs nothing and keeps every call site uniform.
   *
   * `includeDeleted` exists for exactly one caller — the purge path, which must
   * be able to reason about a row every read surface has already stopped
   * showing. Nothing routed from a controller passes it.
   */
  async require(
    userId: string,
    noteId: string,
    level: NoteAccessLevel,
    permissions: readonly string[] = [],
    options: { includeDeleted?: boolean } = {},
  ): Promise<NoteAccess> {
    const note = await this.prisma.note.findUnique({ where: { id: noteId } });

    // A soft-deleted note is gone as far as every read surface is concerned —
    // `note.purge` may still be working through its objects, but the owner
    // asked for it to be deleted and there is no path back.
    if (!note || (note.deletedAt !== null && options.includeDeleted !== true)) {
      throw new NotFoundException(NOTE_NOT_FOUND_MESSAGE);
    }

    if (note.ownerId !== userId) {
      // ⚠ THE SAME 404 A STRANGER GETS, for every level. When sharing lands,
      // this is where the `note_shares` lookup goes — and only here.
      throw new NotFoundException(NOTE_NOT_FOUND_MESSAGE);
    }

    this.assertWritePermission(level, permissions);

    return { note, role: 'owner' };
  }

  /**
   * The caller's role on this note, or `null` if they have none.
   *
   * For the LIST and SUMMARY surfaces, which must not throw for a row the
   * caller cannot see — they simply never select one. Kept here rather than in
   * the service so that "how is a role decided" has exactly one definition, the
   * same arrangement `TranscriptAccessService.roleFor` has.
   */
  roleFor(userId: string, note: Pick<Note, 'ownerId'>): NoteAccessRole | null {
    return note.ownerId === userId ? 'owner' : null;
  }

  /**
   * `edit` and `own` both mutate, and both need `notes:write`.
   *
   * 403 rather than 404 — see the file header's note on why a caller who can
   * already see the row is told the truth about the permission.
   */
  private assertWritePermission(
    level: NoteAccessLevel,
    permissions: readonly string[],
  ): void {
    if (level === 'view') return;

    if (!permissions.includes(PERMISSIONS.NOTES_WRITE)) {
      throw new ForbiddenException(
        `This action requires the ${PERMISSIONS.NOTES_WRITE} permission.`,
      );
    }
  }
}
