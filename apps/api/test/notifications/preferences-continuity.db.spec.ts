// =============================================================================
// Real-Postgres test: a stored notification preference still governs delivery
// (issue #470, epic #467)
// =============================================================================
//
// WHY THIS CANNOT BE A MOCK. #470 replaced this application's own
// `NotificationsService`, preference resolver and event registry with the
// platform's. The promise is "no data migration": the `notifications` namespace
// that users already have in `user_settings.value`, keyed
// `{ <channel id>: { <event key>: boolean } }`, keeps meaning what it meant.
// That is a statement about a REAL jsonb row read back through the platform's
// dispatcher (`loadRecipient` selects `user_settings.value` raw), so it is
// pinned against Postgres: a row written in the pre-migration shape is
// seeded, the platform `NotificationsService` is asked to deliver, and what is
// pinned is which channels it actually fans out over and what it records in
// `notification_deliveries`.
//
// What is pinned:
//   - a muted `email` pref removes the email delivery and keeps the browser one;
//   - an ABSENT key means enabled (the store is sparse);
//   - a `mandatory` event ignores a stored `false` on every channel;
//   - a key for an event that no longer exists is carried and ignored;
//   - the platform's user-settings service round-trips the namespace without
//     dropping a stored key when another key is patched.
//
// The senders are recording doubles: transports are the platform's and are not
// what this app promises. The dispatcher, the registries (filled by the app's
// own manifest), the preference resolver and the delivery ledger are real.
//
// THIS IS A `*.db.spec.ts` FILE: see `test/jobs/db-test-support.ts` for the
// run/skip mechanics. It deletes the users it creates (settings and delivery
// rows go with them).
// =============================================================================

import { dirname, join } from 'node:path';

import { PrismaClient, Prisma } from '@prisma/client';
import {
  DEFAULT_NOTIFICATION_POLICY,
  NotificationsService,
  readNotificationPreferences,
  type NotificationChannelSender,
} from '@marinoscar/platform-api/notifications';
import { UserSettingsService, type SettingsProfileImages } from '@marinoscar/platform-api/settings';
import type { PrincipalCache } from '@marinoscar/platform-api/identity';
import { normalizeProfileSettings } from '@marinoscar/platform-api/storage';

import '../../src/kvox.manifest';
import '../../src/platform/notifications/notification.manifest';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('preferences-continuity.db.spec');

// The delivery ledger service is the platform's, and the package index does not export it (only the
// dispatcher is public). Load the REAL class by absolute path from the installed package, which
// bypasses the `exports` map, so the ledger rows asserted below are written by the platform's own code
// and not by a double that this file would then be testing.
const { NotificationDeliveryService } = jest.requireActual(
  join(dirname(require.resolve('@marinoscar/platform-api/notifications')), 'notification-delivery.service'),
) as { NotificationDeliveryService: new (prisma: never) => object };

const EMAIL_PREFIX = 'prefs-continuity-470';

const TRANSCRIPT_READY = {
  transcriptId: 'tr-470',
  title: 'Board meeting',
  durationMs: 60_000,
  speakerCount: 2,
  wordCount: 120,
  providerLabel: 'Provider',
};

const NOTE_READY = {
  noteId: 'note-470',
  title: 'Board notes',
  templateName: 'Meeting notes',
  providerLabel: 'OpenAI',
  model: 'gpt-4o',
  wordCount: 412,
};

const ROLE_CHANGED = {
  recipientEmail: 'ignored@example.test',
  roles: ['viewer'],
  previousRoles: ['contributor'],
  changedBy: 'Ana Rivera',
};

describeWithDb('stored notification preferences still govern delivery (db)', () => {
  let prisma: PrismaClient;
  let service: NotificationsService;
  let users: UserSettingsService;
  const createdUserIds: string[] = [];
  /** Every delivery the recording senders were asked to make. */
  let delivered: Array<{ channel: string; eventKey: string; userId: string | null }>;

  function recordingSender(channel: 'email' | 'browser' | 'push'): NotificationChannelSender {
    return {
      channel,
      resolveTo: (recipient) => (channel === 'email' ? recipient.email : recipient.userId),
      deliver: async (context) => {
        delivered.push({ channel, eventKey: context.event.key, userId: context.recipient.userId });
        return { success: true, messageId: `${channel}-${delivered.length}` };
      },
    };
  }

  async function createUser(label: string, storedSettings?: unknown) {
    const user = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
    createdUserIds.push(user.id);
    if (storedSettings !== undefined) {
      await prisma.userSettings.create({
        data: { userId: user.id, value: storedSettings as Prisma.InputJsonValue },
      });
    }
    return user;
  }

  async function channelsDeliveredFor(userId: string, eventKey: string): Promise<string[]> {
    return delivered
      .filter((entry) => entry.eventKey === eventKey && entry.userId === userId)
      .map((entry) => entry.channel)
      .sort();
  }

  async function ledger(userId: string, eventKey: string) {
    return prisma.notificationDelivery.findMany({
      where: { userId, eventKey },
      orderBy: { channel: 'asc' },
    });
  }

  beforeAll(async () => {
    prisma = createDbClient();

    // The permissive default policy: the kill switch is on and no event is suppressed. The policy
    // layer has its own tests in the package; this suite is about the PER-USER preference rows.
    const policy = { getPolicy: async () => DEFAULT_NOTIFICATION_POLICY };

    service = new NotificationsService(
      prisma as never,
      new NotificationDeliveryService(prisma as never) as never,
      policy as never,
      [recordingSender('email'), recordingSender('browser')],
    );

    const profileImages: SettingsProfileImages = {
      normalize: normalizeProfileSettings,
      isUploadedAvatar: async () => false,
    };
    const principalCache = { invalidate: () => undefined } as unknown as PrincipalCache;
    users = new UserSettingsService(prisma as never, principalCache, profileImages);
  });

  beforeEach(() => {
    delivered = [];
  });

  afterAll(async () => {
    await service.flush();
    await prisma.notificationDelivery.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  // ===========================================================================
  // The stored shape, read as the platform reads it
  // ===========================================================================

  describe('the pre-migration row shape', () => {
    it('is read by the platform as { channel: { eventKey: boolean } }', () => {
      const stored = {
        theme: 'dark',
        notifications: {
          email: { 'transcripts.transcript_ready': false },
          browser: { 'notes.note_ready': false, 'transcripts.transcript_ready': true },
        },
      };

      expect(readNotificationPreferences(stored)).toEqual({
        email: { 'transcripts.transcript_ready': false },
        browser: { 'notes.note_ready': false, 'transcripts.transcript_ready': true },
      });
    });

    it('is empty (everything on) for a user with no stored namespace', () => {
      expect(readNotificationPreferences({ theme: 'dark' })).toEqual({});
      expect(readNotificationPreferences(null)).toEqual({});
    });
  });

  // ===========================================================================
  // Delivery
  // ===========================================================================

  describe('a stored row governs what the dispatcher fans out over', () => {
    it('a muted email preference removes the email delivery and keeps the browser one', async () => {
      const user = await createUser('mute-email', {
        notifications: { email: { 'transcripts.transcript_ready': false } },
      });

      await service.notifyNow('transcripts.transcript_ready', user.id, TRANSCRIPT_READY);

      expect(await channelsDeliveredFor(user.id, 'transcripts.transcript_ready')).toEqual(['browser']);
      const rows = await ledger(user.id, 'transcripts.transcript_ready');
      expect(rows.map((row) => row.channel)).toEqual(['browser']);
      expect(rows[0]?.status).toBe('sent');
    });

    it('a muted browser preference removes the browser delivery and keeps the email one', async () => {
      const user = await createUser('mute-browser', {
        notifications: { browser: { 'notes.note_ready': false } },
      });

      await service.notifyNow('notes.note_ready', user.id, NOTE_READY);

      expect(await channelsDeliveredFor(user.id, 'notes.note_ready')).toEqual(['email']);
      const rows = await ledger(user.id, 'notes.note_ready');
      expect(rows.map((row) => row.channel)).toEqual(['email']);
    });

    it('an ABSENT key means enabled: a stored preference for another event changes nothing here', async () => {
      const user = await createUser('sparse', {
        notifications: { email: { 'notes.note_failed': false }, browser: { 'notes.note_failed': false } },
      });

      await service.notifyNow('transcripts.transcript_ready', user.id, TRANSCRIPT_READY);

      expect(await channelsDeliveredFor(user.id, 'transcripts.transcript_ready')).toEqual(['browser', 'email']);
    });

    it('a user with no settings row at all receives every declared channel', async () => {
      const user = await createUser('no-row');

      await service.notifyNow('transcripts.transcript_ready', user.id, TRANSCRIPT_READY);

      expect(await channelsDeliveredFor(user.id, 'transcripts.transcript_ready')).toEqual(['browser', 'email']);
      expect((await ledger(user.id, 'transcripts.transcript_ready')).map((row) => row.channel)).toEqual([
        'browser',
        'email',
      ]);
    });

    it('both channels muted for an optional event deliver nothing and record nothing', async () => {
      const user = await createUser('mute-both', {
        notifications: {
          email: { 'transcripts.transcript_ready': false },
          browser: { 'transcripts.transcript_ready': false },
        },
      });

      await service.notifyNow('transcripts.transcript_ready', user.id, TRANSCRIPT_READY);

      expect(await channelsDeliveredFor(user.id, 'transcripts.transcript_ready')).toEqual([]);
      expect(await ledger(user.id, 'transcripts.transcript_ready')).toEqual([]);
    });

    it('a MANDATORY event ignores a stored false on every channel', async () => {
      const user = await createUser('mandatory', {
        notifications: {
          email: { 'security.role_changed': false },
          browser: { 'security.role_changed': false },
        },
      });

      await service.notifyNow('security.role_changed', user.id, ROLE_CHANGED);

      expect(await channelsDeliveredFor(user.id, 'security.role_changed')).toEqual(['browser', 'email']);
    });

    it('a key for an event that no longer exists is carried and ignored, never an error', async () => {
      const user = await createUser('stale-key', {
        notifications: { email: { 'removed.long_ago': false, 'transcripts.transcript_ready': false } },
      });

      await expect(
        service.notifyNow('transcripts.transcript_ready', user.id, TRANSCRIPT_READY),
      ).resolves.toBeDefined();

      expect(await channelsDeliveredFor(user.id, 'transcripts.transcript_ready')).toEqual(['browser']);
    });
  });

  // ===========================================================================
  // The platform's user-settings service keeps the namespace intact
  // ===========================================================================

  describe('the platform user-settings service', () => {
    it('returns the stored namespace unchanged', async () => {
      const stored = {
        email: { 'transcripts.transcript_ready': false },
        browser: { 'notes.note_ready': false },
      };
      const user = await createUser('read-back', { notifications: stored });

      const settings = (await users.getSettings(user.id)) as unknown as Record<string, unknown>;

      expect(settings.notifications).toEqual(stored);
    });

    it('patching one key leaves every other stored key in place, and the dispatcher honours the result', async () => {
      const user = await createUser('patch', {
        notifications: {
          email: { 'transcripts.transcript_ready': false },
          browser: { 'notes.note_ready': false },
        },
      });

      await users.patchSettings(user.id, { notifications: { email: { 'notes.note_failed': false } } } as never);

      const stored = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
      expect((stored.value as Record<string, unknown>).notifications).toEqual({
        email: { 'transcripts.transcript_ready': false, 'notes.note_failed': false },
        browser: { 'notes.note_ready': false },
      });

      await service.notifyNow('transcripts.transcript_ready', user.id, TRANSCRIPT_READY);
      expect(await channelsDeliveredFor(user.id, 'transcripts.transcript_ready')).toEqual(['browser']);
    });
  });
});
