import { BadRequestException, Injectable } from '@nestjs/common';

// =============================================================================
// TranscriptSharing: the extension point behind "who else may open this
// transcript" (issue #493, epic #491)
// =============================================================================
//
// `TranscriptAccessService` is the ONE access decision of the slice, and it
// answers 404-never-403. What it does NOT know is whether a transcript can be
// shared at all: a share is a row of the host's sharing system (the web edition
// stores it as a platform grant under row-level security), and the package must
// not import that system. So the decision about a NON-OWNER, the "shared with me"
// filter of the list and the four share routes go through this class.
//
// THE DEFAULT, {@link OwnerOnlyTranscriptSharing}, SHARES NOTHING. Only the owner
// reaches a transcript, "shared with me" is empty, and a share request is refused.
// A host with sharing passes its own class as `TranscriptsModuleOptions.sharing`
// (the web edition binds the platform's `AccessPolicy` and `GrantsService`).
//
// WHY AN ABSTRACT CLASS AND NOT A TOKEN: it is the injection token and the type in
// one, and `Type<TranscriptSharing>` is the shape every slice option takes.
// =============================================================================

/**
 * What a caller wants to do with a transcript: the platform sharing vocabulary
 * (`read` is `view`, `write` is `edit`, `delete` is `own`).
 *
 * @stability experimental
 */
export type TranscriptShareAction = 'read' | 'write' | 'delete';

/**
 * How a caller reaches a transcript.
 *
 * @stability experimental
 */
export type TranscriptShareRole = 'owner' | 'editor' | 'viewer';

/**
 * The three columns a decision is made from.
 *
 * @stability experimental
 */
export interface TranscriptShareSubject {
  /** The transcript's id. */
  id: string;
  /** Its owner. */
  ownerId: string;
  /** Its organization. */
  orgId: string;
}

/**
 * Who is asking: the caller, and the permissions they hold.
 *
 * @stability experimental
 */
export interface TranscriptShareActor {
  /** The caller. */
  userId: string;
  /** The permissions the caller holds (`transcripts:write`). */
  permissions: readonly string[];
}

/**
 * The answer to "may this caller do this?".
 *
 * @stability experimental
 */
export interface TranscriptShareDecision {
  /** Whether the action is allowed. */
  allowed: boolean;
  /** The role the caller holds on the transcript, whether or not the action was allowed. */
  role: TranscriptShareRole | null;
  /** True when the action was refused ONLY for lack of a permission the caller's role would otherwise satisfy. */
  missingPermission: boolean;
}

/**
 * One user's share of a transcript, as the owner sees it.
 *
 * @stability experimental
 */
export interface TranscriptGrant {
  /** The share's id. */
  id: string;
  /** The recipient. */
  userId: string;
  /** The recipient's address. */
  email: string;
  /** The recipient's display name, or `null`. */
  displayName: string | null;
  /** What the recipient may do. */
  role: 'viewer' | 'editor';
  /** Who shared it, or `null` when the host does not record it. */
  grantedById: string | null;
  /** When it was shared (ISO 8601). */
  createdAt: string;
}

/** The body of a 404 for an address that is not a member of the organization. @stability experimental */
export const SHARE_RECIPIENT_NOT_FOUND_MESSAGE = 'No user with that email';

/** The body of a 400 for sharing a transcript with its own owner. @stability experimental */
export const SHARE_WITH_SELF_MESSAGE = 'You already own this transcript';

/** The body of a 404 for a share that does not exist. @stability experimental */
export const SHARE_NOT_FOUND_MESSAGE = 'That transcript is not shared with this user';

/**
 * The host's sharing system, as the transcripts slice sees it.
 *
 * @extensionPoint option
 * @stability experimental
 */
export abstract class TranscriptSharing {
  /**
   * May the caller do `action` to the transcript? Called for a caller who is
   * NOT the owner as well as for the owner (the owner's `write` and `delete`
   * still need `transcripts:write`, which is why the permissions come along).
   *
   * @param actor - the caller and their permissions.
   * @param action - what they want to do.
   * @param transcript - the transcript.
   */
  abstract decide(
    actor: TranscriptShareActor,
    action: TranscriptShareAction,
    transcript: TranscriptShareSubject,
  ): Promise<TranscriptShareDecision>;

  /**
   * The role a non-owner caller holds, or `null`. For the list and summary
   * surfaces, which report a role per row.
   *
   * @param userId - the caller.
   * @param transcript - the transcript.
   */
  abstract roleFor(userId: string, transcript: TranscriptShareSubject): Promise<'editor' | 'viewer' | null>;

  /**
   * The role of a non-owner caller on each transcript of one organization, in
   * one batched decision. A transcript the caller holds no role on is absent.
   *
   * @param userId - the caller.
   * @param orgId - the organization the transcripts belong to.
   * @param transcriptIds - the transcripts.
   */
  abstract rolesFor(
    userId: string,
    orgId: string,
    transcriptIds: readonly string[],
  ): Promise<Map<string, 'editor' | 'viewer'>>;

  /**
   * A `where` for the `transcripts` table that matches the transcripts SHARED
   * WITH this user (any role). AND it with the ids you asked about, and OR it
   * with `{ ownerId }` for "owned or shared".
   *
   * @param userId - the caller.
   */
  abstract sharedWhere(userId: string): Promise<Record<string, unknown>>;

  /**
   * The user shares of a transcript, for its owner.
   *
   * @param actor - the owner.
   * @param transcript - the transcript.
   */
  abstract listGrants(actor: TranscriptShareActor, transcript: TranscriptShareSubject): Promise<TranscriptGrant[]>;

  /**
   * Shares a transcript with one user, by address.
   *
   * @param actor - the owner.
   * @param transcript - the transcript.
   * @param input - the recipient's address and the role.
   * @throws NotFoundException (`SHARE_RECIPIENT_NOT_FOUND_MESSAGE`) for an address with no member.
   * @throws BadRequestException (`SHARE_WITH_SELF_MESSAGE`) for the owner's own address.
   */
  abstract grant(
    actor: TranscriptShareActor,
    transcript: TranscriptShareSubject,
    input: { email: string; role: 'viewer' | 'editor' },
  ): Promise<TranscriptGrant>;

  /**
   * Changes a recipient's role.
   *
   * @param actor - the owner.
   * @param transcript - the transcript.
   * @param recipientUserId - the recipient.
   * @param role - the new role.
   * @returns the changed share, or `null` when the transcript is not shared with that user.
   */
  abstract updateGrant(
    actor: TranscriptShareActor,
    transcript: TranscriptShareSubject,
    recipientUserId: string,
    role: 'viewer' | 'editor',
  ): Promise<TranscriptGrant | null>;

  /**
   * Withdraws a recipient's share. When `recipientUserId` is the caller, the
   * caller is LEAVING a transcript shared with them.
   *
   * @param actor - the owner, or the recipient leaving.
   * @param transcript - the transcript.
   * @param recipientUserId - whose share to withdraw.
   * @returns false when the transcript is not shared with that user.
   */
  abstract revokeGrant(
    actor: TranscriptShareActor,
    transcript: TranscriptShareSubject,
    recipientUserId: string,
  ): Promise<boolean>;

  /**
   * Forgets every share of a transcript that is being purged.
   *
   * @param transcript - the transcript.
   */
  abstract forget(transcript: TranscriptShareSubject): Promise<void>;
}

/** The permission an owner's `write` and `delete` need, whatever the host's sharing says. */
const WRITE_PERMISSION = 'transcripts:write';

/**
 * The default {@link TranscriptSharing}: nothing is shared. The owner reaches
 * their own transcript; a `write` or `delete` additionally needs
 * `transcripts:write`; everybody else is a stranger.
 *
 * @stability experimental
 */
@Injectable()
export class OwnerOnlyTranscriptSharing extends TranscriptSharing {
  async decide(
    actor: TranscriptShareActor,
    action: TranscriptShareAction,
    transcript: TranscriptShareSubject,
  ): Promise<TranscriptShareDecision> {
    if (transcript.ownerId !== actor.userId) return { allowed: false, role: null, missingPermission: false };

    if (action !== 'read' && !actor.permissions.includes(WRITE_PERMISSION)) {
      return { allowed: false, role: 'owner', missingPermission: true };
    }

    return { allowed: true, role: 'owner', missingPermission: false };
  }

  async roleFor(): Promise<null> {
    return null;
  }

  async rolesFor(): Promise<Map<string, 'editor' | 'viewer'>> {
    return new Map();
  }

  async sharedWhere(): Promise<Record<string, unknown>> {
    return { id: { in: [] } };
  }

  async listGrants(): Promise<TranscriptGrant[]> {
    return [];
  }

  async grant(): Promise<TranscriptGrant> {
    throw new BadRequestException('Sharing is not available in this deployment');
  }

  async updateGrant(): Promise<null> {
    return null;
  }

  async revokeGrant(): Promise<boolean> {
    return false;
  }

  async forget(): Promise<void> {
    // Nothing is shared, so there is nothing to forget.
  }
}
