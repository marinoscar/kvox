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
// SINCE #485 THE DECISION IS THE PLATFORM'S. A share is a `grants` row, and
// `AccessPolicy` (`@marinoscar/platform-api/sharing`) decides: `view` is its
// `read` action, `edit` its `write`, `own` its `delete`
// (`app-registrations/sharing.ts` declares the roles and the actions). This
// service keeps its public shape — `require(userId, id, level, permissions)` and
// `roleFor` — so notes, graph, search and Ask are unchanged, and it keeps the
// two rules the platform's own refusal would blur: ONE shared 404 body, and a 403
// only for a caller who can already see the row.
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
import { AccessPolicy, resourceKey } from '@marinoscar/platform-api/sharing';
import type { AccessDecision } from '@marinoscar/platform-api/sharing';

import { PERMISSIONS } from '../common/constants/roles.constants';
import { principalOf } from '../app-sharing/transcript-visibility';
import { TRANSCRIPT_RESOURCE_TYPE } from '../app-registrations/sharing';
import { PrismaService } from '../prisma/prisma.service';

/** What a caller is asking to do. Ordered least to most. */
export type TranscriptAccessLevel = 'view' | 'edit' | 'own';

/** How this caller reaches this transcript. `owner` outranks both shares. */
export type TranscriptAccessRole = 'owner' | 'editor' | 'viewer';

/** The three columns a role is decided from. */
export type TranscriptRef = Pick<Transcript, 'id' | 'ownerId' | 'orgId'>;

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
 * code was chosen to remove. (The platform's own refusal says "Resource not
 * found"; this service never lets it through.)
 */
export const TRANSCRIPT_NOT_FOUND_MESSAGE = 'Transcript not found';

/** The `AccessPolicy` action each level maps to. */
const ACTION_OF_LEVEL = { view: 'read', edit: 'write', own: 'delete' } as const;

/** The weakest role that satisfies each level. */
const MIN_ROLE_OF_LEVEL: Record<TranscriptAccessLevel, TranscriptAccessRole> = {
  view: 'viewer',
  edit: 'editor',
  own: 'owner',
};

const ROLE_RANK: Record<TranscriptAccessRole, number> = { viewer: 1, editor: 2, owner: 3 };

@Injectable()
export class TranscriptAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: AccessPolicy,
  ) {}

  /**
   * Authorise, and return the row.
   *
   * `permissions` is the caller's effective permission list, as the JWT
   * carries it. It is only consulted for `edit` and `own`; passing it for a
   * `view` check costs nothing and keeps every call site uniform.
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
    // (`loadOwners` treats it as missing too; this is the cheap early exit.)
    if (!transcript || transcript.deletedAt !== null) {
      throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);
    }

    // PLATFORM-ADOPTION-SHIM(#493): this method's signature carries a user id and a
    // permission list, not a principal, so notes, graph, search and Ask stay
    // unchanged. The organization is the transcript's own: this app runs ONE
    // organization (every transcript carries the default one, and a grant only
    // exists for a member of it). A multi-organization deployment passes the
    // caller's `activeOrgId` instead (`app-sharing/transcript-visibility.ts`).
    const decision = await this.policy.decide(
      principalOf(userId, transcript.orgId, permissions),
      ACTION_OF_LEVEL[level],
      { type: TRANSCRIPT_RESOURCE_TYPE, id: transcript.id },
    );

    if (decision.allowed) {
      return { transcript, role: roleOf(decision.role) ?? 'viewer' };
    }

    // ⚠ A MISSING `transcripts:write` IS A 403 ONLY FOR SOMEBODY WHO CAN ALREADY
    // SEE THE ROW AT THE LEVEL ASKED FOR. The platform checks the permission
    // before the role, so a stranger without it is told "missing permission" —
    // which would confirm the transcript exists. The decision still carries the
    // role the caller holds (`decision.role`, shares only): a viewer share asking
    // to edit, like a stranger, gets the 404 the old code gave; the owner or an
    // editor without the permission gets the 403 naming it.
    if (decision.missingPermission && satisfies(roleOf(decision.role), level)) {
      throw new ForbiddenException(
        `This action requires the ${PERMISSIONS.TRANSCRIPTS_WRITE} permission.`,
      );
    }

    // Only the owner may delete, retry or cancel; a viewer asking to edit; a
    // stranger; a revoked or expired share. All the SAME 404, deliberately.
    throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);
  }

  /**
   * The caller's role on this transcript, or `null` if they have none.
   *
   * For the LIST and SUMMARY surfaces, which report a role per row and must
   * not throw for a row the caller cannot see — they simply never select one.
   * Kept here rather than in the service so that "how is a role decided" has
   * exactly one definition.
   */
  async roleFor(userId: string, transcript: TranscriptRef): Promise<TranscriptAccessRole | null> {
    if (transcript.ownerId === userId) return 'owner';

    return roleOf(
      await this.policy.roleFor(principalOf(userId, transcript.orgId, []), {
        type: TRANSCRIPT_RESOURCE_TYPE,
        id: transcript.id,
      }),
    );
  }

  /**
   * The caller's role on each of `transcripts`, in ONE batched decision per
   * organization (`AccessPolicy.decideMany`: one owner query and one grant query).
   * A transcript the caller holds no role on is absent from the map. For the list
   * surfaces, which attach a role to a page of rows.
   */
  async rolesFor(
    userId: string,
    transcripts: readonly TranscriptRef[],
  ): Promise<Map<string, TranscriptAccessRole>> {
    const roles = new Map<string, TranscriptAccessRole>();
    const byOrg = new Map<string, TranscriptRef[]>();

    for (const transcript of transcripts) {
      if (transcript.ownerId === userId) {
        roles.set(transcript.id, 'owner');
        continue;
      }
      byOrg.set(transcript.orgId, [...(byOrg.get(transcript.orgId) ?? []), transcript]);
    }

    for (const [orgId, rows] of byOrg) {
      const decisions = await this.policy.decideMany(
        principalOf(userId, orgId, []),
        'read',
        rows.map((row) => ({ type: TRANSCRIPT_RESOURCE_TYPE, id: row.id })),
      );

      for (const row of rows) {
        const role = roleOf(decisions.get(resourceKey({ type: TRANSCRIPT_RESOURCE_TYPE, id: row.id }))?.role ?? null);
        if (role) roles.set(row.id, role);
      }
    }

    return roles;
  }
}

/** An `AccessPolicy` role as this service names it, or null. */
function roleOf(role: AccessDecision['role']): TranscriptAccessRole | null {
  if (role === 'owner') return 'owner';
  if (role === 'editor') return 'editor';
  if (role === 'viewer') return 'viewer';

  return null;
}

/** Whether `role` is enough for `level`. */
function satisfies(role: TranscriptAccessRole | null, level: TranscriptAccessLevel): boolean {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[MIN_ROLE_OF_LEVEL[level]];
}
