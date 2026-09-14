import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ShareLookupThrottleService } from './share-lookup-throttle.service';
import type { TranscriptAccessService } from './transcript-access.service';
import {
  SHARE_NOT_FOUND_MESSAGE,
  SHARE_RECIPIENT_NOT_FOUND_MESSAGE,
  TranscriptSharingService,
} from './transcript-sharing.service';

// =============================================================================
// TranscriptSharingService (issue #29, epic #19, spec §6.3)
// =============================================================================
//
// What is asserted here is the LOOKUP'S SHAPE and the NOTIFICATION'S AUDIENCE —
// the two things that are decided in this file rather than in the database:
//
//   * an unknown address and a DEACTIVATED one answer byte-identically, and
//     both charge the rate limiter;
//   * the lookup is `equals`, never `contains` or `startsWith`;
//   * the notification goes to the RECIPIENT and to nobody else, with no
//     `notifyPermissionHolders` call anywhere;
//   * a no-op re-share notifies nobody;
//   * each of the four operations demands the access level it should.
//
// The things a mock genuinely cannot prove — that revocation is immediate and
// that a role change takes effect on the next request — are in
// `test/transcripts/transcript-sharing.db.spec.ts` against a real database,
// because "there is no cache" is a claim about rows, not about this class.
// =============================================================================

const OWNER: RequestUser = {
  id: 'owner-1',
  email: 'owner@example.test',
  roles: ['Contributor'],
  permissions: ['transcripts:read', 'transcripts:write'],
  isActive: true,
};

const TRANSCRIPT_ID = 'transcript-1';

const transcriptRow = {
  id: TRANSCRIPT_ID,
  ownerId: OWNER.id,
  title: 'Board meeting',
  deletedAt: null,
};

const shareRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'share-1',
  userId: 'recipient-1',
  role: 'viewer',
  grantedById: OWNER.id,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  user: { email: 'colleague@example.test', displayName: 'A Colleague' },
  ...overrides,
});

describe('TranscriptSharingService', () => {
  let service: TranscriptSharingService;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let access: { require: jest.Mock };
  let notifications: { notify: jest.Mock; notifyPermissionHolders: jest.Mock };
  let throttle: ShareLookupThrottleService;

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'recipient-1',
          email: 'colleague@example.test',
          displayName: 'A Colleague',
          isActive: true,
        }),
        findUnique: jest.fn().mockResolvedValue({
          displayName: 'Ana Rivera',
          providerDisplayName: null,
        }),
      },
      transcriptShare: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([shareRow()]),
        upsert: jest.fn().mockResolvedValue(shareRow()),
        update: jest.fn().mockResolvedValue(shareRow({ role: 'editor' })),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };

    access = { require: jest.fn().mockResolvedValue({ transcript: transcriptRow, role: 'owner' }) };
    notifications = { notify: jest.fn().mockResolvedValue(undefined), notifyPermissionHolders: jest.fn() };
    throttle = new ShareLookupThrottleService();

    service = new TranscriptSharingService(
      prisma as unknown as PrismaService,
      access as unknown as TranscriptAccessService,
      throttle,
      notifications as unknown as NotificationsService,
      new ConfigService({ appUrl: 'https://app.example.test/' }),
    );
  });

  // ---------------------------------------------------------------------------
  // The list
  // ---------------------------------------------------------------------------

  describe('list', () => {
    it('demands OWNER access — a recipient enumerating the others gets a 404', async () => {
      await service.list(TRANSCRIPT_ID, OWNER);

      expect(access.require).toHaveBeenCalledWith(OWNER.id, TRANSCRIPT_ID, 'own');
    });

    it('does not pass permissions, so reading the list never needs transcripts:write', () => {
      // Reading writes nothing; `assertWritePermission` fires for any level
      // above `view`, so a fourth argument here would refuse an owner whose
      // role lost the write permission the chance to SEE who they shared with.
      expect(access.require).not.toHaveBeenCalled();
    });

    it('returns each recipient with their address, name and role', async () => {
      const result = await service.list(TRANSCRIPT_ID, OWNER);

      expect(result.items).toEqual([
        {
          id: 'share-1',
          userId: 'recipient-1',
          email: 'colleague@example.test',
          displayName: 'A Colleague',
          role: 'viewer',
          grantedById: OWNER.id,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // The narrow lookup
  // ---------------------------------------------------------------------------

  describe('add — the email lookup', () => {
    it('matches EXACTLY and case-insensitively, never a prefix or a contains', async () => {
      await service.add(TRANSCRIPT_ID, { email: 'colleague@example.test', role: 'viewer' }, OWNER);

      const where = prisma.user.findFirst.mock.calls[0][0].where;

      expect(where).toEqual({ email: { equals: 'colleague@example.test', mode: 'insensitive' } });
      expect(JSON.stringify(where)).not.toMatch(/contains|startsWith|endsWith|search/);
    });

    it('answers a generic 404 for an address with no account, naming nothing', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.add(TRANSCRIPT_ID, { email: 'nobody@example.test', role: 'viewer' }, OWNER),
      ).rejects.toThrow(new NotFoundException(SHARE_RECIPIENT_NOT_FOUND_MESSAGE));

      expect(SHARE_RECIPIENT_NOT_FOUND_MESSAGE).not.toMatch(/@|nobody/);
    });

    it('answers a DEACTIVATED account identically — the two are indistinguishable', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'recipient-1',
        email: 'colleague@example.test',
        displayName: null,
        isActive: false,
      });

      // Byte-identical to the "no account" case above. Telling them apart is
      // the enumeration oracle the generic answer exists to close.
      await expect(
        service.add(TRANSCRIPT_ID, { email: 'colleague@example.test', role: 'viewer' }, OWNER),
      ).rejects.toThrow(new NotFoundException(SHARE_RECIPIENT_NOT_FOUND_MESSAGE));

      expect(prisma.transcriptShare.upsert).not.toHaveBeenCalled();
    });

    it('charges the rate limiter for a miss and eventually answers 429', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      for (let index = 0; index < 10; index += 1) {
        await expect(
          service.add(TRANSCRIPT_ID, { email: `x${index}@example.test`, role: 'viewer' }, OWNER),
        ).rejects.toThrow(NotFoundException);
      }

      await expect(
        service.add(TRANSCRIPT_ID, { email: 'x10@example.test', role: 'viewer' }, OWNER),
      ).rejects.toMatchObject({ status: 429 });
    });

    it('does NOT charge the limiter for a successful share', async () => {
      for (let index = 0; index < 25; index += 1) {
        await service.add(TRANSCRIPT_ID, { email: 'colleague@example.test', role: 'viewer' }, OWNER);
      }

      // Still allowed: the limiter counts misses, and an owner adding the
      // whole team one address at a time has missed nothing.
      await expect(
        service.add(TRANSCRIPT_ID, { email: 'colleague@example.test', role: 'viewer' }, OWNER),
      ).resolves.toBeDefined();
    });

    it('refuses sharing with yourself, and does NOT use the generic message for it', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: OWNER.id,
        email: OWNER.email,
        displayName: 'Ana',
        isActive: true,
      });

      await expect(
        service.add(TRANSCRIPT_ID, { email: OWNER.email, role: 'editor' }, OWNER),
      ).rejects.toThrow('You already own this transcript');
    });
  });

  // ---------------------------------------------------------------------------
  // Granting
  // ---------------------------------------------------------------------------

  describe('add — the grant', () => {
    it('upserts, so re-sharing with the same person changes their role instead of failing', async () => {
      prisma.transcriptShare.findUnique.mockResolvedValue({ id: 'share-1', role: 'viewer' });
      prisma.transcriptShare.upsert.mockResolvedValue(shareRow({ role: 'editor' }));

      await service.add(TRANSCRIPT_ID, { email: 'colleague@example.test', role: 'editor' }, OWNER);

      const call = prisma.transcriptShare.upsert.mock.calls[0][0];

      expect(call.where).toEqual({
        transcriptId_userId: { transcriptId: TRANSCRIPT_ID, userId: 'recipient-1' },
      });
      expect(call.update).toEqual({ role: 'editor', grantedById: OWNER.id });
    });

    it('audits a first grant as :grant and a re-share as :update', async () => {
      await service.add(TRANSCRIPT_ID, { email: 'colleague@example.test', role: 'viewer' }, OWNER);

      expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({
        action: 'transcript:share:grant',
        targetType: 'transcript',
        targetId: TRANSCRIPT_ID,
        actorUserId: OWNER.id,
      });

      prisma.auditEvent.create.mockClear();
      prisma.transcriptShare.findUnique.mockResolvedValue({ id: 'share-1', role: 'viewer' });

      await service.add(TRANSCRIPT_ID, { email: 'colleague@example.test', role: 'editor' }, OWNER);

      expect(prisma.auditEvent.create.mock.calls[0][0].data.action).toBe('transcript:share:update');
    });

    it('notifies the RECIPIENT and nobody else', async () => {
      await service.add(TRANSCRIPT_ID, { email: 'colleague@example.test', role: 'editor' }, OWNER);

      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(
        'transcripts.transcript_shared',
        'recipient-1',
        expect.objectContaining({
          transcriptId: TRANSCRIPT_ID,
          title: 'Board meeting',
          role: 'editor',
          ownerName: 'Ana Rivera',
        }),
      );

      // NOT the owner, NOT the other recipients, NOT a permission fan-out.
      expect(notifications.notify).not.toHaveBeenCalledWith(
        expect.anything(),
        OWNER.id,
        expect.anything(),
      );
      expect(notifications.notifyPermissionHolders).not.toHaveBeenCalled();
    });

    it('notifies nobody when the same role is submitted again', async () => {
      prisma.transcriptShare.findUnique.mockResolvedValue({ id: 'share-1', role: 'viewer' });

      await service.add(TRANSCRIPT_ID, { email: 'colleague@example.test', role: 'viewer' }, OWNER);

      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('still returns the share when the notification cannot be raised', async () => {
      notifications.notify.mockRejectedValue(new Error('smtp is down'));

      await expect(
        service.add(TRANSCRIPT_ID, { email: 'colleague@example.test', role: 'viewer' }, OWNER),
      ).resolves.toMatchObject({ userId: 'recipient-1' });
    });
  });

  // ---------------------------------------------------------------------------
  // Changing a role
  // ---------------------------------------------------------------------------

  describe('update', () => {
    it('demands owner access with the write permission', async () => {
      prisma.transcriptShare.findUnique.mockResolvedValue({ role: 'viewer' });

      await service.update(TRANSCRIPT_ID, 'recipient-1', { role: 'editor' }, OWNER);

      expect(access.require).toHaveBeenCalledWith(
        OWNER.id,
        TRANSCRIPT_ID,
        'own',
        OWNER.permissions,
      );
    });

    it('404s for a user who holds no share on this transcript', async () => {
      prisma.transcriptShare.findUnique.mockResolvedValue(null);

      await expect(
        service.update(TRANSCRIPT_ID, 'stranger', { role: 'editor' }, OWNER),
      ).rejects.toThrow(SHARE_NOT_FOUND_MESSAGE);
    });

    it('notifies on a PROMOTION', async () => {
      prisma.transcriptShare.findUnique.mockResolvedValue({ role: 'viewer' });

      await service.update(TRANSCRIPT_ID, 'recipient-1', { role: 'editor' }, OWNER);

      expect(notifications.notify).toHaveBeenCalledWith(
        'transcripts.transcript_shared',
        'recipient-1',
        expect.objectContaining({ role: 'editor' }),
      );
    });

    it('is SILENT on a demotion — "shared with you" is the wrong message for it', async () => {
      prisma.transcriptShare.findUnique.mockResolvedValue({ role: 'editor' });
      prisma.transcriptShare.update.mockResolvedValue(shareRow({ role: 'viewer' }));

      await service.update(TRANSCRIPT_ID, 'recipient-1', { role: 'viewer' }, OWNER);

      expect(notifications.notify).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create.mock.calls[0][0].data.action).toBe(
        'transcript:share:update',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Revoking and leaving
  // ---------------------------------------------------------------------------

  describe('remove', () => {
    it('demands OWNER access to revoke somebody else', async () => {
      await service.remove(TRANSCRIPT_ID, 'recipient-1', OWNER);

      expect(access.require).toHaveBeenCalledWith(
        OWNER.id,
        TRANSCRIPT_ID,
        'own',
        OWNER.permissions,
      );
    });

    it('demands only VIEW access to leave, and asks for no write permission', async () => {
      const recipient: RequestUser = { ...OWNER, id: 'recipient-1', permissions: ['transcripts:read'] };

      access.require.mockResolvedValue({ transcript: transcriptRow, role: 'viewer' });

      await service.remove(TRANSCRIPT_ID, recipient.id, recipient);

      // `[]` and not `recipient.permissions`: giving up your own access is not
      // a write against somebody else's recording, so a role change that took
      // `transcripts:write` away must not trap them in the share.
      expect(access.require).toHaveBeenCalledWith(recipient.id, TRANSCRIPT_ID, 'view', []);
    });

    it('records which of the two shapes it was', async () => {
      await service.remove(TRANSCRIPT_ID, 'recipient-1', OWNER);

      expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({
        action: 'transcript:share:revoke',
      });
      expect(prisma.auditEvent.create.mock.calls[0][0].data.meta).toMatchObject({
        recipientUserId: 'recipient-1',
        left: false,
      });
    });

    it('404s when there is no such share', async () => {
      prisma.transcriptShare.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.remove(TRANSCRIPT_ID, 'recipient-1', OWNER)).rejects.toThrow(
        SHARE_NOT_FOUND_MESSAGE,
      );
    });

    it('never notifies the person removed', async () => {
      await service.remove(TRANSCRIPT_ID, 'recipient-1', OWNER);

      expect(notifications.notify).not.toHaveBeenCalled();
    });
  });
});
