// =============================================================================
// TranscriptAccessService (issue #25, epic #19, spec §6.1)
// =============================================================================
//
// ONE FUNCTION, THREE LEVELS, AND A 404 FOR EVERYTHING ELSE.
//
//   require(userId, transcriptId, 'view' | 'edit' | 'own')
//
// Precedence: the OWNER satisfies every level; an `editor` share satisfies
// `view` and `edit`; a `viewer` share satisfies only `view`.
//
// -----------------------------------------------------------------------------
// ⚠ NO ACCESS IS A 404. NEVER A 403. THIS IS THE WHOLE POINT.
// -----------------------------------------------------------------------------
//
// A 403 confirms that transcript `abc123` exists and merely refuses the
// caller. A 404 reveals nothing either way. For a product whose stated privacy
// stance is that a transcript is a private conversation, the existence of a
// specific id is itself something a stranger has no business learning — and a
// system that answers identically for "does not exist" and "exists, but not
// for you" leaks nothing in either direction.
//
// The one shape that would quietly undo this is a controller that looks the
// row up itself, finds it, and only then asks this service. So the service
// RETURNS THE ROW: there is no reason for a caller to query `transcripts` on
// its own, and no code path where a caller holds a transcript it was not
// authorised for.
//
// -----------------------------------------------------------------------------
// `edit` ALSO REQUIRES `transcripts:write`, AND A SHARE CANNOT SUPPLY IT
// -----------------------------------------------------------------------------
//
// A share caps the CEILING an RBAC permission can raise a user to; it never
// raises the floor. An `editor` share held by an account whose roles do not
// carry `transcripts:write` grants read access and nothing more — which is why
// the permission set is a parameter here rather than something this service
// re-derives, and why `edit` is checked against BOTH facts rather than against
// whichever one happened to be convenient.
//
// ⚠ NOTE ON THE FAILURE MODE FOR A FAILED `edit`. A caller who can genuinely
// VIEW the transcript but lacks `transcripts:write` gets a 403, not a 404:
// they already know the transcript exists — they can read it — so there is
// nothing left to conceal, and a 404 would tell them their own transcript had
// vanished. The 404 rule protects the EXISTENCE of a row from somebody with no
// access at all; it is not a blanket instruction to lie to people who can see
// the thing.
// =============================================================================

import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Transcript } from '@prisma/client';

import { PERMISSIONS } from '../common/constants/roles.constants';
import { PrismaService } from '../prisma/prisma.service';

/** What a caller is asking to do. Ordered least to most. */
export type TranscriptAccessLevel = 'view' | 'edit' | 'own';

/** How this caller reaches this transcript. `owner` outranks both shares. */
export type TranscriptAccessRole = 'owner' | 'editor' | 'viewer';

/** The answer: the row, and the role that admitted the caller to it. */
export interface TranscriptAccess {
  transcript: Transcript;
  role: TranscriptAccessRole;
}

/**
 * The message every no-access answer uses, verbatim.
 *
 * ONE STRING, SHARED, so a "not found" and a "not yours" are byte-identical.
 * Two differently-worded 404s would reintroduce exactly the oracle the status
 * code was chosen to remove.
 */
export const TRANSCRIPT_NOT_FOUND_MESSAGE = 'Transcript not found';

@Injectable()
export class TranscriptAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Authorise, and return the row.
   *
   * `permissions` is the caller's effective permission list, as the JWT
   * carries it. It is only consulted for `edit`; passing it for a `view` check
   * costs nothing and keeps every call site uniform.
   */
  async require(
    userId: string,
    transcriptId: string,
    level: TranscriptAccessLevel,
    permissions: readonly string[] = [],
  ): Promise<TranscriptAccess> {
    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
    });

    // A soft-deleted transcript is gone as far as every read surface is
    // concerned — `transcript.purge` may still be working through its objects,
    // but the owner asked for it to be deleted and there is no path back.
    if (!transcript || transcript.deletedAt !== null) {
      throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);
    }

    if (transcript.ownerId === userId) {
      this.assertWritePermission(level, permissions);

      return { transcript, role: 'owner' };
    }

    // Only the owner may delete, retry or cancel. A non-owner asking for `own`
    // gets the SAME 404 a stranger gets, deliberately: "you may read this but
    // not delete it" is a fact about the share, and an editor who tried to
    // delete has learned nothing they did not already know.
    if (level === 'own') {
      throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);
    }

    const share = await this.prisma.transcriptShare.findUnique({
      where: { transcriptId_userId: { transcriptId, userId } },
      select: { role: true },
    });

    if (!share) {
      throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);
    }

    if (level === 'edit' && share.role !== 'editor') {
      // A viewer share asking to edit. 404 rather than 403 for the same reason
      // the `own` branch above does: the ROLE of a share is not something a
      // holder of a lesser one gets to enumerate.
      throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);
    }

    this.assertWritePermission(level, permissions);

    return { transcript, role: share.role === 'editor' ? 'editor' : 'viewer' };
  }

  /**
   * The caller's role on this transcript, or `null` if they have none.
   *
   * For the LIST and SUMMARY surfaces, which report a role per row and must
   * not throw for a row the caller cannot see — they simply never select one.
   * Kept here rather than in the service so that "how is a role decided" has
   * exactly one definition.
   */
  async roleFor(userId: string, transcript: Transcript): Promise<TranscriptAccessRole | null> {
    if (transcript.ownerId === userId) return 'owner';

    const share = await this.prisma.transcriptShare.findUnique({
      where: { transcriptId_userId: { transcriptId: transcript.id, userId } },
      select: { role: true },
    });

    if (!share) return null;

    return share.role === 'editor' ? 'editor' : 'viewer';
  }

  /**
   * `edit` and `own` both mutate, and both need `transcripts:write`.
   *
   * 403 rather than 404 — see the file header's note on why a caller who can
   * already see the row is told the truth about the permission.
   */
  private assertWritePermission(
    level: TranscriptAccessLevel,
    permissions: readonly string[],
  ): void {
    if (level === 'view') return;

    if (!permissions.includes(PERMISSIONS.TRANSCRIPTS_WRITE)) {
      throw new ForbiddenException(
        `This action requires the ${PERMISSIONS.TRANSCRIPTS_WRITE} permission.`,
      );
    }
  }
}
