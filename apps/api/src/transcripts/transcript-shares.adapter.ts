// =============================================================================
// TranscriptSharesAdapter (issue #485, epic #478) — DEPRECATED, one release
// =============================================================================
//
// A share is a platform `grants` row since #485, and the platform's own routes
// (`GET|POST /api/grants`, `PATCH|DELETE /api/grants/:id`, `GET /api/grants/shared-with-me`)
// are where clients go. These four methods keep the OLD routes alive for one
// release as thin adapters over `GrantsService`:
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
//     ('No user with that email') where the platform answers 422
//     `NOT_AN_ORG_MEMBER`, so the lookup oracle stays closed; sharing with
//     yourself answers the old 400 message. The lookup throttle (429) is the
//     platform's `MemberLookupThrottle`;
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

import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { GrantDto } from '@marinoscar/platform-contract/sharing';
import type { RequestUser } from '@marinoscar/platform-api/identity';
import { GrantsService, SHARING_ERROR_REASONS, SHARING_PERMISSIONS } from '@marinoscar/platform-api/sharing';

import { TRANSCRIPT_RESOURCE_TYPE } from '../app-registrations/sharing';
import { principalOf } from '../app-sharing/transcript-visibility';
import type {
  CreateTranscriptShareDto,
  TranscriptShareRoleName,
  UpdateTranscriptShareDto,
} from './dto/transcript-share.dto';
import {
  TRANSCRIPT_NOT_FOUND_MESSAGE,
  TranscriptAccessService,
} from './transcript-access.service';

/** One share, as every response in this adapter returns it (unchanged since #29). */
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
 * The answer for an address with no active account, verbatim.
 *
 * ONE STRING, SHARED, and it names NO address, so it cannot be diffed against a
 * hit. It must never grow a detail like "that account is deactivated", which
 * would re-open the oracle this whole design closes.
 */
export const SHARE_RECIPIENT_NOT_FOUND_MESSAGE = 'No user with that email';

/** Sharing with yourself. A 400, not a 404: there is nothing to conceal about your own account. */
export const SHARE_WITH_SELF_MESSAGE = 'You already own this transcript';

/** Removing a share that is not there. Distinct only because the row is known. */
export const SHARE_NOT_FOUND_MESSAGE = 'That transcript is not shared with this user';

/** Grants per page when the adapter walks a list (the platform's maximum). */
const PAGE_SIZE = 100;

/** The most pages a walk reads: a record holds at most 500 grants. */
const MAX_PAGES = 50;

@Injectable()
export class TranscriptSharesAdapter {
  constructor(
    private readonly access: TranscriptAccessService,
    private readonly grants: GrantsService,
  ) {}

  /** `GET /api/transcripts/:id/shares` — owner only. */
  async list(transcriptId: string, user: RequestUser): Promise<{ items: TranscriptShareItem[] }> {
    // `'view'` PLUS AN EXPLICIT OWNER CHECK, not `'own'`: `own` carries the
    // `transcripts:write` check, and reading the share list writes nothing (an
    // owner whose role lost it must still see who they shared with). A recipient
    // gets the same 404 a stranger gets.
    const { transcript, role } = await this.access.require(user.id, transcriptId, 'view');
    if (role !== 'owner') throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);

    const rows = await this.userGrants(transcript.orgId, user, transcriptId);

    return { items: rows.map((row) => shape(row, transcript.ownerId)) };
  }

  /** `POST /api/transcripts/:id/shares` — grant, or change an existing grant. */
  async add(
    transcriptId: string,
    dto: CreateTranscriptShareDto,
    user: RequestUser,
  ): Promise<TranscriptShareItem> {
    const { transcript } = await this.access.require(user.id, transcriptId, 'own', user.permissions);

    try {
      const grant = await this.grants.create(this.principal(user, transcript.orgId), {
        resourceType: TRANSCRIPT_RESOURCE_TYPE,
        resourceId: transcriptId,
        grantee: { kind: 'user', email: dto.email },
        role: dto.role,
      });

      return shape(grant, transcript.ownerId);
    } catch (error) {
      // ONE BRANCH FOR THREE FACTS — no account, an inactive account, and an
      // account outside the organization — as the platform answers them all with
      // `NOT_AN_ORG_MEMBER`. They stay indistinguishable.
      if (hasReason(error, SHARING_ERROR_REASONS.NOT_AN_ORG_MEMBER)) {
        throw new NotFoundException(SHARE_RECIPIENT_NOT_FOUND_MESSAGE);
      }
      if (hasReason(error, SHARING_ERROR_REASONS.SELF_GRANT)) {
        throw new BadRequestException(SHARE_WITH_SELF_MESSAGE);
      }
      throw error;
    }
  }

  /** `PATCH /api/transcripts/:id/shares/:userId` — owner only. */
  async update(
    transcriptId: string,
    recipientUserId: string,
    dto: UpdateTranscriptShareDto,
    user: RequestUser,
  ): Promise<TranscriptShareItem> {
    const { transcript } = await this.access.require(user.id, transcriptId, 'own', user.permissions);

    const existing = (await this.userGrants(transcript.orgId, user, transcriptId)).find(
      (row) => row.grantee.userId === recipientUserId,
    );
    if (!existing) throw new NotFoundException(SHARE_NOT_FOUND_MESSAGE);

    const grant = await this.grants.update(this.principal(user, transcript.orgId), existing.id, {
      role: dto.role,
    });

    return shape(grant, transcript.ownerId);
  }

  /** `DELETE /api/transcripts/:id/shares/:userId` — revoke, or LEAVE. */
  async remove(transcriptId: string, recipientUserId: string, user: RequestUser): Promise<void> {
    const leaving = recipientUserId === user.id;

    // `'view'` for a leave, `'own'` for a revoke. `permissions` is NOT passed on
    // the leave path: giving up access is not a write, and a role that lost
    // `transcripts:write` must not trap somebody in a share they want out of.
    const { transcript } = await this.access.require(
      user.id,
      transcriptId,
      leaving ? 'view' : 'own',
      leaving ? [] : user.permissions,
    );

    const grantId = leaving
      ? await this.ownGrantId(transcript.orgId, user, transcriptId)
      : (await this.userGrants(transcript.orgId, user, transcriptId)).find(
          (row) => row.grantee.userId === recipientUserId,
        )?.id;
    if (!grantId) throw new NotFoundException(SHARE_NOT_FOUND_MESSAGE);

    await this.grants.revoke(this.principal(user, transcript.orgId), grantId);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * The platform principal the adapter calls `GrantsService` as. The old
   * transcript rules (owner, `transcripts:write`) were enforced one step earlier by
   * `TranscriptAccessService`; `sharing:read` and `sharing:write` are added so the
   * platform's own permission checks inside the service do not narrow them again.
   */
  private principal(user: RequestUser, orgId: string) {
    return principalOf(user.id, orgId, [
      ...new Set([...user.permissions, SHARING_PERMISSIONS.SHARING_READ, SHARING_PERMISSIONS.SHARING_WRITE]),
    ]);
  }

  /** Every active user grant on the transcript, oldest first (the `share` action: owner only). */
  private async userGrants(orgId: string, user: RequestUser, transcriptId: string): Promise<GrantDto[]> {
    const rows: GrantDto[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.grants.list(this.principal(user, orgId), {
        resourceType: TRANSCRIPT_RESOURCE_TYPE,
        resourceId: transcriptId,
        page,
        pageSize: PAGE_SIZE,
      });
      rows.push(...result.items.filter((row) => row.grantee.kind === 'user'));
      if (rows.length >= result.total || result.items.length < PAGE_SIZE) break;
    }

    return rows;
  }

  /** The id of the caller's own grant on the transcript, from "shared with me". */
  private async ownGrantId(orgId: string, user: RequestUser, transcriptId: string): Promise<string | undefined> {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.grants.sharedWithMe(this.principal(user, orgId), {
        resourceType: TRANSCRIPT_RESOURCE_TYPE,
        page,
        pageSize: PAGE_SIZE,
      });
      const mine = result.items.find((item) => item.resourceId === transcriptId && item.via === 'user_grant');
      if (mine) return mine.grantId;
      if (page * PAGE_SIZE >= result.total || result.items.length < PAGE_SIZE) break;
    }

    return undefined;
  }
}

/** Whether `error` is the platform's 422/400 carrying `reason` in its details. */
function hasReason(error: unknown, reason: string): boolean {
  if (!(error instanceof UnprocessableEntityException) && !(error instanceof BadRequestException)) return false;

  const body = error.getResponse() as { details?: { reason?: string }; reason?: string } | string;

  return typeof body === 'object' && (body.details?.reason === reason || body.reason === reason);
}

/** The wire shape of one share (unchanged since #29). A grant whose grantor was deleted shows the owner. */
function shape(grant: GrantDto, ownerId: string): TranscriptShareItem {
  return {
    id: grant.id,
    userId: grant.grantee.userId ?? '',
    email: grant.grantee.email ?? '',
    displayName: grant.grantee.displayName,
    role: grant.role === 'editor' ? 'editor' : 'viewer',
    grantedById: grant.grantedById ?? ownerId,
    createdAt: grant.createdAt,
  };
}
