import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { GrantDto } from '@marinoscar/platform-contract/sharing';
import {
  AccessPolicy,
  GrantsService,
  SHARING_ERROR_REASONS,
  SHARING_PERMISSIONS,
  resourceKey,
  type AccessDecision,
} from '@marinoscar/platform-api/sharing';
import {
  SHARE_RECIPIENT_NOT_FOUND_MESSAGE,
  SHARE_WITH_SELF_MESSAGE,
  TranscriptSharing,
  type TranscriptGrant,
  type TranscriptShareAction,
  type TranscriptShareActor,
  type TranscriptShareDecision,
  type TranscriptShareRole,
  type TranscriptShareSubject,
} from '@marinoscar/kvox-api/transcripts';

import { TRANSCRIPT_RESOURCE_TYPE } from '../../app-registrations/sharing';
import { principalOf, sharedTranscriptsWhere } from '../../app-sharing/transcript-visibility';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// The web edition's sharing of a transcript (issue #485, epic #478; moved out of the
// transcripts module by issue #493, epic #491)
// =============================================================================
//
// `@marinoscar/kvox-api/transcripts` decides access through `TranscriptSharing` and
// leaves the host's sharing system to this class. A share is a platform `grants`
// row (`resource_type = 'transcript'`, `resource_id` = the transcript id);
// `AccessPolicy` decides what the owner, a viewer and an editor may do; `GrantsService`
// stores a share. The resource type is registered in `app-registrations/sharing.ts`
// (roles `viewer < editor`, `owner` implicit; `read: viewer`, `write: editor`,
// `share` and `delete`: owner; `write` and `delete` also need `transcripts:write`;
// a caller with no access gets a 404; users only, no group or link shares).
//
// The four deprecated `:id/shares` routes (`TranscriptSharesService` in the slice)
// keep their old behaviour through the grant calls below:
//
//   * a recipient with no usable account answers the old generic 404 where the platform
//     answers 422 `NOT_AN_ORG_MEMBER`, so the lookup oracle stays closed; sharing with
//     yourself answers the old 400 message. The lookup throttle (429) is the platform's
//     `MemberLookupThrottle`;
//   * `:userId` still names the RECIPIENT, never the grant row.
//
// WHAT CHANGED, AND CANNOT BE HIDDEN: a share's `id` is the grant's id; the notification
// is the platform's `sharing.shared_with_you` (the old `transcripts.transcript_shared` is
// retired); audit rows are `grant:create`, `grant:update` and `grant:revoke`; a revoked
// share is soft-revoked (`revoked_at`) until the prune job removes it.
//
// NOTHING IN THIS APP READS `grants` DIRECTLY (the `no-direct-access` check of the
// sharing conformance suite): every grant goes through the platform's helpers.
// =============================================================================

const PAGE_SIZE = 100;

const MAX_PAGES = 50;

@Injectable()
export class PlatformTranscriptSharing extends TranscriptSharing {
  constructor(
    private readonly policy: AccessPolicy,
    private readonly grants: GrantsService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async decide(
    actor: TranscriptShareActor,
    action: TranscriptShareAction,
    transcript: TranscriptShareSubject,
  ): Promise<TranscriptShareDecision> {
    // The organization is the transcript's own: this app runs ONE organization (every
    // transcript carries the default one, and a grant only exists for a member of it). A
    // multi-organization deployment passes the caller's `activeOrgId` instead.
    const decision = await this.policy.decide(
      principalOf(actor.userId, transcript.orgId, actor.permissions),
      action,
      { type: TRANSCRIPT_RESOURCE_TYPE, id: transcript.id },
    );

    return {
      allowed: decision.allowed,
      role: roleOf(decision.role),
      missingPermission: decision.missingPermission !== undefined,
    };
  }

  async roleFor(userId: string, transcript: TranscriptShareSubject): Promise<'editor' | 'viewer' | null> {
    const role = roleOf(
      await this.policy.roleFor(principalOf(userId, transcript.orgId, []), {
        type: TRANSCRIPT_RESOURCE_TYPE,
        id: transcript.id,
      }),
    );

    return role === 'editor' || role === 'viewer' ? role : null;
  }

  async rolesFor(
    userId: string,
    orgId: string,
    transcriptIds: readonly string[],
  ): Promise<Map<string, 'editor' | 'viewer'>> {
    const roles = new Map<string, 'editor' | 'viewer'>();
    const decisions = await this.policy.decideMany(
      principalOf(userId, orgId, []),
      'read',
      transcriptIds.map((id) => ({ type: TRANSCRIPT_RESOURCE_TYPE, id })),
    );

    for (const id of transcriptIds) {
      const role = roleOf(decisions.get(resourceKey({ type: TRANSCRIPT_RESOURCE_TYPE, id }))?.role ?? null);
      if (role === 'editor' || role === 'viewer') roles.set(id, role);
    }

    return roles;
  }

  sharedWhere(userId: string): Promise<Record<string, unknown>> {
    return sharedTranscriptsWhere(this.prisma, userId) as Promise<Record<string, unknown>>;
  }

  async listGrants(actor: TranscriptShareActor, transcript: TranscriptShareSubject): Promise<TranscriptGrant[]> {
    return (await this.userGrants(actor, transcript)).map(shape);
  }

  async grant(
    actor: TranscriptShareActor,
    transcript: TranscriptShareSubject,
    input: { email: string; role: 'viewer' | 'editor' },
  ): Promise<TranscriptGrant> {
    try {
      const grant = await this.grants.create(this.principal(actor, transcript.orgId), {
        resourceType: TRANSCRIPT_RESOURCE_TYPE,
        resourceId: transcript.id,
        grantee: { kind: 'user', email: input.email },
        role: input.role,
      });

      return shape(grant);
    } catch (error) {
      if (hasReason(error, SHARING_ERROR_REASONS.NOT_AN_ORG_MEMBER)) {
        throw new NotFoundException(SHARE_RECIPIENT_NOT_FOUND_MESSAGE);
      }
      if (hasReason(error, SHARING_ERROR_REASONS.SELF_GRANT)) {
        throw new BadRequestException(SHARE_WITH_SELF_MESSAGE);
      }
      throw error;
    }
  }

  async updateGrant(
    actor: TranscriptShareActor,
    transcript: TranscriptShareSubject,
    recipientUserId: string,
    role: 'viewer' | 'editor',
  ): Promise<TranscriptGrant | null> {
    const existing = (await this.userGrants(actor, transcript)).find((row) => row.grantee.userId === recipientUserId);
    if (!existing) return null;

    return shape(await this.grants.update(this.principal(actor, transcript.orgId), existing.id, { role }));
  }

  async revokeGrant(
    actor: TranscriptShareActor,
    transcript: TranscriptShareSubject,
    recipientUserId: string,
  ): Promise<boolean> {
    const leaving = recipientUserId === actor.userId;

    const grantId = leaving
      ? await this.ownGrantId(actor, transcript)
      : (await this.userGrants(actor, transcript)).find((row) => row.grantee.userId === recipientUserId)?.id;
    if (!grantId) return false;

    await this.grants.revoke(this.principal(actor, transcript.orgId), grantId);

    return true;
  }

  async forget(transcript: TranscriptShareSubject): Promise<void> {
    // `grants` names a record polymorphically (no foreign key) and is under forced row-level
    // security, hence `runInOrg` (the platform's `sharing.grants.prune` job sweeps whatever a
    // missed call leaves).
    await this.prisma.runInOrg({ orgId: transcript.orgId }, async (tx) => {
      await this.grants.deleteForResources(tx, TRANSCRIPT_RESOURCE_TYPE, [transcript.id]);
    });
  }

  private principal(actor: TranscriptShareActor, orgId: string) {
    return principalOf(actor.userId, orgId, [
      ...new Set([...actor.permissions, SHARING_PERMISSIONS.SHARING_READ, SHARING_PERMISSIONS.SHARING_WRITE]),
    ]);
  }

  private async userGrants(actor: TranscriptShareActor, transcript: TranscriptShareSubject): Promise<GrantDto[]> {
    const rows: GrantDto[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.grants.list(this.principal(actor, transcript.orgId), {
        resourceType: TRANSCRIPT_RESOURCE_TYPE,
        resourceId: transcript.id,
        page,
        pageSize: PAGE_SIZE,
      });
      rows.push(...result.items.filter((row) => row.grantee.kind === 'user'));
      if (rows.length >= result.total || result.items.length < PAGE_SIZE) break;
    }

    return rows;
  }

  private async ownGrantId(actor: TranscriptShareActor, transcript: TranscriptShareSubject): Promise<string | undefined> {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.grants.sharedWithMe(this.principal(actor, transcript.orgId), {
        resourceType: TRANSCRIPT_RESOURCE_TYPE,
        page,
        pageSize: PAGE_SIZE,
      });
      const mine = result.items.find((item) => item.resourceId === transcript.id && item.via === 'user_grant');
      if (mine) return mine.grantId;
      if (page * PAGE_SIZE >= result.total || result.items.length < PAGE_SIZE) break;
    }

    return undefined;
  }
}

/** An `AccessPolicy` role as the slice names it, or null. */
function roleOf(role: AccessDecision['role'] | null | undefined): TranscriptShareRole | null {
  if (role === 'owner') return 'owner';
  if (role === 'editor') return 'editor';
  if (role === 'viewer') return 'viewer';

  return null;
}

/** Whether a platform refusal carries the given `details.reason`. */
function hasReason(error: unknown, reason: string): boolean {
  if (!(error instanceof UnprocessableEntityException) && !(error instanceof BadRequestException)) return false;

  const body = error.getResponse() as { details?: { reason?: string }; reason?: string } | string;

  return typeof body === 'object' && (body.details?.reason === reason || body.reason === reason);
}

/** A platform grant as the slice's share shape. */
function shape(grant: GrantDto): TranscriptGrant {
  return {
    id: grant.id,
    userId: grant.grantee.userId ?? '',
    email: grant.grantee.email ?? '',
    displayName: grant.grantee.displayName,
    role: grant.role === 'editor' ? 'editor' : 'viewer',
    grantedById: grant.grantedById ?? null,
    createdAt: grant.createdAt,
  };
}
