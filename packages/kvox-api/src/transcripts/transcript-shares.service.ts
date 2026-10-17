// =============================================================================
// TranscriptSharesService (issue #485, epic #478; moved into the slice by #493) —
// DEPRECATED, one release
// =============================================================================
//
// A share is a host sharing record since #485 (the web edition: a platform `grants`
// row), and the host's own routes (`GET|POST /api/grants`, `PATCH|DELETE
// /api/grants/:id`, `GET /api/grants/shared-with-me`) are where clients go. These
// four methods keep the OLD routes alive for one release as thin adapters over the
// slice's `TranscriptSharing` extension point:
//
//   GET    /api/transcripts/:id/shares           list
//   POST   /api/transcripts/:id/shares           add (grant, or change a role)
//   PATCH  /api/transcripts/:id/shares/:userId   update
//   DELETE /api/transcripts/:id/shares/:userId   remove (revoke, or leave)
//
// SAME REQUEST AND RESPONSE SHAPES, SAME STATUS CODES, SAME BODIES. What the
// old service did that the platform does differently is restored here, so an
// old client sees no change:
//
//   * the access check is `TranscriptAccessService.require(...)` FIRST, with the
//     old levels and the old shared 404 body ('Transcript not found'), and the
//     403 naming `transcripts:write` for an owner who lost it;
//   * a recipient with no usable account answers the old generic 404
//     ('No user with that email'), so the lookup oracle stays closed; sharing with
//     yourself answers the old 400 message. The lookup throttle (429) is the host
//     sharing system's, inside its `TranscriptSharing`;
//   * `:userId` still names the RECIPIENT, never the grant row.
//
// WHAT CHANGED, AND CANNOT BE HIDDEN: a share's `id` is now the grant's id; the
// notification is the platform's `sharing.shared_with_you` (the old
// `transcripts.transcript_shared` is retired); audit rows are `grant:create`,
// `grant:update` and `grant:revoke`; a revoked share is soft-revoked
// (`revoked_at`) until the prune job removes it.
//
// Remove this file, the four routes and `transcript-share.dto.ts` in the release
// after clients moved to `/api/grants` (the web already has).
// =============================================================================

import { Injectable, NotFoundException } from '@nestjs/common';

import type {
  CreateTranscriptShareDto,
  TranscriptShareRoleName,
  UpdateTranscriptShareDto,
} from './dto/transcript-share.dto.js';
import {
  TRANSCRIPT_NOT_FOUND_MESSAGE,
  TranscriptAccessService,
} from './transcript-access.service.js';
import {
  SHARE_NOT_FOUND_MESSAGE,
  TranscriptSharing,
  type TranscriptGrant,
} from './sharing/transcript-sharing.js';
import type { TranscriptsActor } from './transcripts-actor.js';

export {
  SHARE_NOT_FOUND_MESSAGE,
  SHARE_RECIPIENT_NOT_FOUND_MESSAGE,
  SHARE_WITH_SELF_MESSAGE,
} from './sharing/transcript-sharing.js';

/** One share as the old routes return it. */
export interface TranscriptShareItem {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: TranscriptShareRoleName;
  grantedById: string;
  createdAt: string;
}

/**
 * TranscriptSharesService: wiring the slice registers itself; a host configures it through `TranscriptsModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class TranscriptSharesService {
  constructor(
    private readonly access: TranscriptAccessService,
    private readonly sharing: TranscriptSharing,
  ) {}

  /** `GET /api/transcripts/:id/shares`: the owner's list of user shares. */
  async list(transcriptId: string, user: TranscriptsActor): Promise<{ items: TranscriptShareItem[] }> {
    const { transcript, role } = await this.access.require(user.id, transcriptId, 'view');
    if (role !== 'owner') throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);

    const rows = await this.sharing.listGrants(actorOf(user), transcript);

    return { items: rows.map((row) => shape(row, transcript.ownerId)) };
  }

  /** `POST /api/transcripts/:id/shares`: share with one user (owner only). */
  async add(
    transcriptId: string,
    dto: CreateTranscriptShareDto,
    user: TranscriptsActor,
  ): Promise<TranscriptShareItem> {
    const { transcript } = await this.access.require(user.id, transcriptId, 'own', user.permissions);

    const grant = await this.sharing.grant(actorOf(user), transcript, { email: dto.email, role: dto.role });

    return shape(grant, transcript.ownerId);
  }

  /** `PATCH /api/transcripts/:id/shares/:userId`: change a recipient's role (owner only). */
  async update(
    transcriptId: string,
    recipientUserId: string,
    dto: UpdateTranscriptShareDto,
    user: TranscriptsActor,
  ): Promise<TranscriptShareItem> {
    const { transcript } = await this.access.require(user.id, transcriptId, 'own', user.permissions);

    const grant = await this.sharing.updateGrant(actorOf(user), transcript, recipientUserId, dto.role);
    if (!grant) throw new NotFoundException(SHARE_NOT_FOUND_MESSAGE);

    return shape(grant, transcript.ownerId);
  }

  /**
   * `DELETE /api/transcripts/:id/shares/:userId`: withdraw a share. The owner
   * removes anyone's; a recipient removes their own (leaves).
   */
  async remove(transcriptId: string, recipientUserId: string, user: TranscriptsActor): Promise<void> {
    const leaving = recipientUserId === user.id;

    const { transcript } = await this.access.require(
      user.id,
      transcriptId,
      leaving ? 'view' : 'own',
      leaving ? [] : user.permissions,
    );

    const removed = await this.sharing.revokeGrant(actorOf(user), transcript, recipientUserId);
    if (!removed) throw new NotFoundException(SHARE_NOT_FOUND_MESSAGE);
  }
}

/** The sharing system's view of a caller. */
function actorOf(user: TranscriptsActor): { userId: string; permissions: readonly string[] } {
  return { userId: user.id, permissions: user.permissions };
}

/** A grant as the old routes shape it. */
function shape(grant: TranscriptGrant, ownerId: string): TranscriptShareItem {
  return {
    id: grant.id,
    userId: grant.userId,
    email: grant.email,
    displayName: grant.displayName,
    role: grant.role === 'editor' ? 'editor' : 'viewer',
    grantedById: grant.grantedById ?? ownerId,
    createdAt: grant.createdAt,
  };
}
