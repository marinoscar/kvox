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
// SINCE #485 THE DECISION ABOUT A NON-OWNER IS THE HOST'S SHARING SYSTEM'S. A
// share is a host record (the web edition stores a `grants` row and the platform's
// `AccessPolicy` decides): `view` is the `read` action, `edit` the `write`, `own`
// the `delete`. The slice reaches it through `TranscriptSharing`
// (`sharing/transcript-sharing.ts`; the default shares nothing, so only the owner
// reaches a transcript). This service keeps its public shape — `require(userId, id, level, permissions)` and
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

import { Inject, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';

import { KVOX_PRISMA } from '../ports/index.js';
import type { KvoxTranscriptsDb, TranscriptRow } from './data/transcripts-db.js';
import { TranscriptSharing, type TranscriptShareRole } from './sharing/transcript-sharing.js';
import { TRANSCRIPTS_WRITE_PERMISSION } from './transcripts.permissions.js';

type Transcript = TranscriptRow;

/**
 * What a caller is asking to do. Ordered least to most.
 *
 * @stability experimental
 */
export type TranscriptAccessLevel = 'view' | 'edit' | 'own';

/**
 * How this caller reaches this transcript. `owner` outranks both shares.
 *
 * @stability experimental
 */
export type TranscriptAccessRole = 'owner' | 'editor' | 'viewer';

/**
 * The three columns a role is decided from.
 *
 * @stability experimental
 */
export type TranscriptRef = Pick<TranscriptRow, 'id' | 'ownerId' | 'orgId'>;

/**
 * The answer: the row, and the role that admitted the caller to it.
 *
 * @stability experimental
 */
export interface TranscriptAccess {
  /** The transcript row. */
  transcript: TranscriptRow;
  /** The role that admitted the caller. */
  role: TranscriptAccessRole;
}

/**
 * The message every no-access answer uses, verbatim.
 *
 * ONE STRING, SHARED, so a "not found" and a "not yours" are byte-identical.
 * Two differently-worded 404s would reintroduce exactly the oracle the status
 * code was chosen to remove. (The platform's own refusal says "Resource not
 * found"; this service never lets it through.)
  *
  * @stability experimental
 */
export const TRANSCRIPT_NOT_FOUND_MESSAGE = 'Transcript not found';

/** The sharing action each level maps to. */
const ACTION_OF_LEVEL = { view: 'read', edit: 'write', own: 'delete' } as const;

/** The weakest role that satisfies each level. */
const MIN_ROLE_OF_LEVEL: Record<TranscriptAccessLevel, TranscriptAccessRole> = {
  view: 'viewer',
  edit: 'editor',
  own: 'owner',
};

const ROLE_RANK: Record<TranscriptAccessRole, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * The one place that decides whether a caller may open, edit, own or delete a transcript, and
 * answers with the 404 posture when not. It asks the host's {@link TranscriptSharing}.
 *
 * @stability experimental
 */
@Injectable()
export class TranscriptAccessService {
  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxTranscriptsDb,
    private readonly sharing: TranscriptSharing,
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

    // This method's signature carries a user id and a permission list, not a
    // principal, so notes, graph, search and Ask stay unchanged. The organization
    // is the transcript's own: a share only exists inside the organization the
    // transcript belongs to.
    const decision = await this.sharing.decide(
      { userId, permissions },
      ACTION_OF_LEVEL[level],
      { id: transcript.id, ownerId: transcript.ownerId, orgId: transcript.orgId },
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
        `This action requires the ${TRANSCRIPTS_WRITE_PERMISSION} permission.`,
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

    return roleOf(await this.sharing.roleFor(userId, transcript));
  }

  /**
   * The caller's role on each of `transcripts`, in ONE batched decision per
   * organization (`TranscriptSharing.rolesFor`).
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
      const decided = await this.sharing.rolesFor(
        userId,
        orgId,
        rows.map((row) => row.id),
      );

      for (const row of rows) {
        const role = roleOf(decided.get(row.id) ?? null);
        if (role) roles.set(row.id, role);
      }
    }

    return roles;
  }
}

/** A sharing role as this service names it, or null. */
function roleOf(role: TranscriptShareRole | null | undefined): TranscriptAccessRole | null {
  if (role === 'owner') return 'owner';
  if (role === 'editor') return 'editor';
  if (role === 'viewer') return 'viewer';

  return null;
}

/** Whether `role` is enough for `level`. */
function satisfies(role: TranscriptAccessRole | null, level: TranscriptAccessLevel): boolean {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[MIN_ROLE_OF_LEVEL[level]];
}
