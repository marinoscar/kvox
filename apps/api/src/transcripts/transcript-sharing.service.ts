// =============================================================================
// TranscriptSharingService (issue #29, epic #19, spec §6.3)
// =============================================================================
//
// The MANAGEMENT surface around `TranscriptAccessService`. That service decides
// whether a caller may open a transcript; this one decides who is on the list.
// They are deliberately separate: enforcement is read on every single request
// and must stay a two-query function, while granting is a rare write with an
// email lookup, a notification and three audit actions behind it.
//
// -----------------------------------------------------------------------------
// FOUR OPERATIONS, AND ONLY ONE OF THEM IS NOT OWNER-ONLY
// -----------------------------------------------------------------------------
//
//   list / add / update  — `require(..., 'own')`, so a non-owner gets the same
//                          404 a stranger gets. Who a transcript is shared with
//                          is itself private: an editor learning that four
//                          other people can read the recording is a fact about
//                          those four people, not about the editor.
//   remove               — the owner, OR the recipient removing THEIR OWN row.
//                          "Leave" is the one action a share holder may take
//                          against the share list, and it is safe precisely
//                          because it can only ever reduce their own access.
//
// -----------------------------------------------------------------------------
// ⚠ THE NARROW EMAIL LOOKUP — WHY IT IS NOT `UsersService`
// -----------------------------------------------------------------------------
//
// Finding another user today means `GET /api/users`, which is gated on
// `users:read` and seeded to Admin alone. Reusing it would mean one of two
// things, and both are wrong: either sharing becomes an admin-only feature, or
// `users:read` gets handed to every role — which publishes the entire user
// directory, with emails, to everybody, to make a share dialog work.
//
// So this service does the narrowest possible thing instead, and the narrowness
// IS the security control:
//
//   1. ONE address at a time, supplied in full by the caller.
//   2. EXACT and case-insensitive. No prefix, no `contains`, no fuzzy match.
//   3. NOTHING IS RETURNED ON A MISS — not a count, not a "did you mean". The
//      answer is a 404 whose message names no address and no user.
//   4. NOTHING IS RETURNED ON A HIT EITHER, except through the share row the
//      call creates: the owner learns the display name of somebody they have
//      just granted access to, which they could equally have asked for.
//   5. THE LOOKUP IS RATE LIMITED PER CALLER (see
//      `share-lookup-throttle.service.ts`), because identical wording does not
//      stop an enumerator reading the status code instead.
//
// An INACTIVE account is a miss, byte for byte. A disabled user must not be
// distinguishable from a nonexistent one — `AuthService` already refuses their
// login, and a share that "worked" against a deactivated account would be a
// grant nobody can use and a signal that the address is real.
//
// -----------------------------------------------------------------------------
// REVOCATION IS IMMEDIATE, AND THERE IS NOTHING HERE TO MAKE IT SO
// -----------------------------------------------------------------------------
//
// There is no cache to invalidate, no JWT claim to re-issue, no in-memory grant
// map. `TranscriptAccessService` reads `transcript_shares` on every request, so
// deleting the row IS the revocation and the next request already sees it. The
// absence of code in this file is the guarantee; the `.db.spec.ts` proves it
// against a real database rather than asserting it.
// =============================================================================

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TranscriptSharedEmailData } from '../email/templates/transcript-shared.email';
import type {
  CreateTranscriptShareDto,
  TranscriptShareRoleName,
  UpdateTranscriptShareDto,
} from './dto/transcript-share.dto';
import { ShareLookupThrottleService } from './share-lookup-throttle.service';
import {
  TRANSCRIPT_NOT_FOUND_MESSAGE,
  TranscriptAccessService,
} from './transcript-access.service';

/** One share, as every response in this service returns it. */
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
 * ONE STRING, SHARED, exactly as `TRANSCRIPT_NOT_FOUND_MESSAGE` is — and it
 * names NO address, so it cannot be diffed against a hit. It must also never
 * grow a detail like "that account is deactivated", which would re-open the
 * oracle this whole design closes.
 */
export const SHARE_RECIPIENT_NOT_FOUND_MESSAGE = 'No user with that email';

/** Sharing with yourself. See the 400 branch in `add` for why it is not a 404. */
export const SHARE_WITH_SELF_MESSAGE = 'You already own this transcript';

/** Removing a share that is not there. Distinct only because the row is known. */
export const SHARE_NOT_FOUND_MESSAGE = 'That transcript is not shared with this user';

@Injectable()
export class TranscriptSharingService {
  private readonly logger = new Logger(TranscriptSharingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TranscriptAccessService,
    private readonly throttle: ShareLookupThrottleService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  // ===========================================================================
  // Read
  // ===========================================================================

  /** `GET /api/transcripts/:id/shares` — owner only. */
  async list(transcriptId: string, user: RequestUser): Promise<{ items: TranscriptShareItem[] }> {
    // ⚠ `'view'` PLUS AN EXPLICIT OWNER CHECK, RATHER THAN `'own'`, and the
    // difference is a permission rather than a level. `require` turns ANY level
    // above `view` into a `transcripts:write` check, because both of the levels
    // above it mutate — but READING the share list writes nothing, and an owner
    // whose role lost `transcripts:write` must still be able to see who they
    // shared with even though they can no longer change it. Asking for `view`
    // and rejecting a non-owner here gets the owner-only rule without borrowing
    // a write check to enforce it.
    //
    // Owner-only and NOT viewer-or-better: the share list is this recording's
    // address book, and a recipient enumerating the others would learn about
    // people who never agreed to be visible to them. They get the same 404 a
    // stranger gets, from the same shared message.
    const { role } = await this.access.require(user.id, transcriptId, 'view');

    if (role !== 'owner') throw new NotFoundException(TRANSCRIPT_NOT_FOUND_MESSAGE);

    return { items: await this.shareItems(transcriptId) };
  }

  // ===========================================================================
  // Write
  // ===========================================================================

  /**
   * `POST /api/transcripts/:id/shares` — grant, or change an existing grant.
   *
   * Re-sharing with somebody who already has a share UPDATES their role rather
   * than failing, because that is what the owner meant: the dialog's email
   * field does not know who is already on the list, and a 409 would make the
   * owner delete a row in order to type it again.
   */
  async add(
    transcriptId: string,
    dto: CreateTranscriptShareDto,
    user: RequestUser,
  ): Promise<TranscriptShareItem> {
    const { transcript } = await this.access.require(
      user.id,
      transcriptId,
      'own',
      user.permissions,
    );

    // BEFORE the query, not after: a limiter that ran afterwards would still
    // have answered the question it exists to stop being asked.
    this.throttle.assertAllowed(user.id);

    const recipient = await this.prisma.user.findFirst({
      // Exact, case-insensitive, one address. The stored column is already
      // lowercased on every write path in this application, and the DTO
      // lowercases the input — `mode: 'insensitive'` is the belt to that
      // braces, for a row written before that normalisation existed.
      where: { email: { equals: dto.email, mode: 'insensitive' } },
      select: { id: true, email: true, displayName: true, isActive: true },
    });

    // ⚠ ONE BRANCH FOR THREE DIFFERENT FACTS — no account, an inactive
    // account, and (below) your own address. The first two answer identically
    // because telling them apart is the enumeration oracle itself.
    if (!recipient || !recipient.isActive) {
      this.throttle.recordMiss(user.id);

      throw new NotFoundException(SHARE_RECIPIENT_NOT_FOUND_MESSAGE);
    }

    if (recipient.id === user.id) {
      // ⚠ 400, NOT the generic 404, and NOT throttled. The caller typed their
      // OWN address: there is nothing to conceal from somebody about their own
      // account, a generic 404 would read as "your account does not exist",
      // and charging the limiter would punish a typo rather than a probe.
      throw new BadRequestException(SHARE_WITH_SELF_MESSAGE);
    }

    const existing = await this.prisma.transcriptShare.findUnique({
      where: { transcriptId_userId: { transcriptId, userId: recipient.id } },
      select: { id: true, role: true },
    });

    const share = await this.prisma.transcriptShare.upsert({
      where: { transcriptId_userId: { transcriptId, userId: recipient.id } },
      create: {
        transcriptId,
        userId: recipient.id,
        role: dto.role,
        grantedById: user.id,
      },
      // `grantedBy` is re-stamped: whoever last set the role is the person who
      // answers for it, and today that is always the owner anyway.
      update: { role: dto.role, grantedById: user.id },
    });

    const changed = !existing || existing.role !== dto.role;

    await this.audit(
      user.id,
      existing ? 'transcript:share:update' : 'transcript:share:grant',
      transcriptId,
      { recipientUserId: recipient.id, role: dto.role, previousRole: existing?.role ?? null },
    );

    // AFTER the write has committed and OUTSIDE any transaction — `notify` is
    // detached, so it neither joins a transaction nor delays this response.
    //
    // ⚠ ONLY WHEN SOMETHING ACTUALLY CHANGED. Re-submitting the same email at
    // the same role is a no-op (an owner clicking twice, a retried request),
    // and mailing somebody again to tell them about access they already have
    // is how a useful notification becomes one people mute.
    if (changed) {
      await this.notifyRecipient(recipient.id, {
        transcriptId,
        title: transcript.title,
        role: dto.role,
        ownerName: await this.displayNameOf(user.id, user.email),
        appUrl: this.appUrl(),
      });
    }

    return this.shape({
      ...share,
      user: { email: recipient.email, displayName: recipient.displayName },
    });
  }

  /** `PATCH /api/transcripts/:id/shares/:userId` — owner only. */
  async update(
    transcriptId: string,
    recipientUserId: string,
    dto: UpdateTranscriptShareDto,
    user: RequestUser,
  ): Promise<TranscriptShareItem> {
    const { transcript } = await this.access.require(
      user.id,
      transcriptId,
      'own',
      user.permissions,
    );

    const existing = await this.prisma.transcriptShare.findUnique({
      where: { transcriptId_userId: { transcriptId, userId: recipientUserId } },
      select: { role: true },
    });

    if (!existing) throw new NotFoundException(SHARE_NOT_FOUND_MESSAGE);

    const share = await this.prisma.transcriptShare.update({
      where: { transcriptId_userId: { transcriptId, userId: recipientUserId } },
      data: { role: dto.role, grantedById: user.id },
      include: { user: { select: { email: true, displayName: true } } },
    });

    await this.audit(user.id, 'transcript:share:update', transcriptId, {
      recipientUserId,
      role: dto.role,
      previousRole: existing.role,
    });

    if (existing.role !== dto.role) {
      // A PROMOTION IS NEWS; A DEMOTION IS NOT NOTIFIED AT ALL BY THIS EVENT.
      // `transcripts.transcript_shared` says "X shared Y with you (Role)" — a
      // message that is simply wrong for "you can no longer correct this". A
      // demotion is silent and takes effect on the next request, which is the
      // same posture revocation has.
      if (dto.role === 'editor') {
        await this.notifyRecipient(recipientUserId, {
          transcriptId,
          title: transcript.title,
          role: dto.role,
          ownerName: await this.displayNameOf(user.id, user.email),
          appUrl: this.appUrl(),
        });
      }
    }

    return this.shape(share);
  }

  /**
   * `DELETE /api/transcripts/:id/shares/:userId` — revoke, or LEAVE.
   *
   * The one non-owner-only operation here. A recipient passing their own id is
   * giving up their own access, which needs no more authority than holding it
   * did — and requiring `own` would have meant asking the owner to remove you.
   */
  async remove(
    transcriptId: string,
    recipientUserId: string,
    user: RequestUser,
  ): Promise<void> {
    const leaving = recipientUserId === user.id;

    // `'view'` for a leave, `'own'` for a revoke — and either way the access
    // check is what turns "no such transcript" and "not yours" into the same
    // 404. A stranger guessing a transcript id and their own user id gets the
    // stranger's answer, because they hold no share to leave.
    //
    // ⚠ `permissions` is NOT passed on the leave path. Giving up access is not
    // a write against the transcript and must stay possible for a user whose
    // role lost `transcripts:write` — otherwise a permission change could trap
    // somebody in a share they want out of.
    await this.access.require(
      user.id,
      transcriptId,
      leaving ? 'view' : 'own',
      leaving ? [] : user.permissions,
    );

    const deleted = await this.prisma.transcriptShare.deleteMany({
      where: { transcriptId, userId: recipientUserId },
    });

    if (deleted.count === 0) throw new NotFoundException(SHARE_NOT_FOUND_MESSAGE);

    await this.audit(user.id, 'transcript:share:revoke', transcriptId, {
      recipientUserId,
      // Says which of the two shapes this was, so an audit reader does not have
      // to compare two ids to find out.
      left: leaving,
    });

    // NO NOTIFICATION ON REVOCATION, deliberately. There is no event for it in
    // the registry, and "your access was removed" is a message whose main
    // effect is to tell somebody they were discussed — the owner is entitled to
    // un-share a private conversation without composing an explanation.
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Every share on this transcript, oldest first, with its recipient. */
  private async shareItems(transcriptId: string): Promise<TranscriptShareItem[]> {
    const rows = await this.prisma.transcriptShare.findMany({
      where: { transcriptId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { user: { select: { email: true, displayName: true } } },
    });

    return rows.map((row) => this.shape(row));
  }

  /** The wire shape of one share row. */
  private shape(row: {
    id: string;
    userId: string;
    role: string;
    grantedById: string;
    createdAt: Date;
    user: { email: string; displayName: string | null };
  }): TranscriptShareItem {
    return {
      id: row.id,
      userId: row.userId,
      email: row.user.email,
      displayName: row.user.displayName,
      role: row.role === 'editor' ? 'editor' : 'viewer',
      grantedById: row.grantedById,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Tell the recipient, and NOBODY ELSE.
   *
   * `notify(key, recipientId, …)` addresses exactly one account — the same
   * one-person addressing `transcripts.transcript_ready` uses, and for the same
   * reason: a share is a fact about one person's access to one private
   * conversation, not about the deployment. There is no
   * `notifyPermissionHolders` call anywhere in this file and there must not be.
   */
  private async notifyRecipient(
    recipientUserId: string,
    payload: TranscriptSharedEmailData,
  ): Promise<void> {
    try {
      await this.notifications.notify(
        'transcripts.transcript_shared',
        recipientUserId,
        payload,
      );
    } catch (error) {
      // `notify` is detached and documented never to reject, but a share that
      // succeeded must not be reported as a failure if that ever changes: the
      // grant is already committed and is the thing the caller asked for.
      this.logger.warn(
        `Could not raise transcripts.transcript_shared: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** The owner's name for the message, falling back to their address. */
  private async displayNameOf(userId: string, fallback: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, providerDisplayName: true },
    });

    return user?.displayName || user?.providerDisplayName || fallback;
  }

  /** Absolute application root for the email CTA, or undefined when unset. */
  private appUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');

    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }

  /** One audit row. `targetType: 'transcript'`, matching `TranscriptsService`. */
  private async audit(
    userId: string,
    action: string,
    transcriptId: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'transcript',
        targetId: transcriptId,
        meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
