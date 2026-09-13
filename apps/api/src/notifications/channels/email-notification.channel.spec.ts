import {
  EVENT_EMAIL_TEMPLATES,
  EmailNotificationChannel,
} from './email-notification.channel';
import { NOTIFICATION_EVENTS } from '../notification-events';
import type { NotificationEventDef } from '../notification-events';
import type {
  NotificationDispatchContext,
  NotificationRecipient,
} from '../notification.types';

// =============================================================================
// EmailNotificationChannel — tests (issue #125, epic #109)
// =============================================================================
//
// #128 wired real templates for the three seeded events, so the interesting
// state is no longer "the map is empty" but "the map and the registry agree".
// This suite locks in two things:
//
//   1. EVERY event declaring the `email` channel has a template. A missing one
//      is an event that can never be sent, and this is the only place that is
//      caught before an operator finds it in `notification_deliveries`.
//   2. An event with NO registered template still records a failed delivery
//      with a clear, specific reason — not a throw, and not a silent success.
//      That path is no longer reachable through the seeded registry, so it is
//      exercised with a synthetic event def instead of a real key.
//
// `EmailSettingsService`/`SesEmailProvider`/`SmtpEmailProvider` are injected
// as bare `{ get: jest.fn() }`/`{ send: jest.fn() }` stand-ins, following
// email-test-send.service.spec.ts's pattern — this suite is about the
// channel's own branching, not the transports underneath it.
// =============================================================================

const recipient: NotificationRecipient = {
  userId: 'user-1',
  email: 'user@example.com',
  preferences: {},
};

describe('EmailNotificationChannel', () => {
  let channel: EmailNotificationChannel;
  let mockEmailSettings: { get: jest.Mock };
  let mockSes: { send: jest.Mock };
  let mockSmtp: { send: jest.Mock };

  beforeEach(() => {
    mockEmailSettings = { get: jest.fn() };
    mockSes = { send: jest.fn() };
    mockSmtp = { send: jest.fn() };

    channel = new EmailNotificationChannel(
      mockEmailSettings as never,
      mockSes as never,
      mockSmtp as never,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('EVENT_EMAIL_TEMPLATES agrees with the registry (#128)', () => {
    it('registers a template for every event that declares the email channel', () => {
      const emailEvents = NOTIFICATION_EVENTS.filter((event) =>
        event.channels.includes('email'),
      ).map((event) => event.key);

      expect(emailEvents.length).toBeGreaterThan(0);

      for (const key of emailEvents) {
        expect(EVENT_EMAIL_TEMPLATES[key]).toBeDefined();
      }
    });

    it('registers no template for an event that does not declare the email channel', () => {
      // Dead entries are not harmless: they read as a live delivery path for
      // a channel the registry never offers.
      const nonEmailEvents = NOTIFICATION_EVENTS.filter(
        (event) => !event.channels.includes('email'),
      ).map((event) => event.key);

      for (const key of nonEmailEvents) {
        expect(EVENT_EMAIL_TEMPLATES[key]).toBeUndefined();
      }
    });
  });

  describe('deliver() with no registered template', () => {
    // Synthetic, because since #128 every SEEDED event has a template. The
    // reachable route to this branch is a rolling deploy in which one build
    // declares an event the other has no template for.
    const unregistered: NotificationEventDef = {
      key: 'test.unregistered',
      label: 'Unregistered',
      description: 'An event with no template, for this suite only.',
      channels: ['email'],
      defaultEnabled: true,
    };

    const unregisteredContext: NotificationDispatchContext = {
      event: unregistered,
      recipient,
      data: {},
    };

    it('records a failed result with a clear reason, rather than throwing', async () => {
      const result = await channel.deliver(
        unregisteredContext,
        recipient.email as string,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "No email template is registered for event 'test.unregistered'.",
      );
    });

    it('does not read email settings or touch a transport before failing', async () => {
      // The template check happens first, before any I/O — a missing
      // template is a code-level omission and should not cost a settings
      // query to discover.
      await channel.deliver(unregisteredContext, recipient.email as string);

      expect(mockEmailSettings.get).not.toHaveBeenCalled();
      expect(mockSes.send).not.toHaveBeenCalled();
      expect(mockSmtp.send).not.toHaveBeenCalled();
    });

    it('never throws, even though deliver() is awaited directly here (not through the dispatcher\'s try/catch)', async () => {
      await expect(
        channel.deliver(unregisteredContext, recipient.email as string),
      ).resolves.toMatchObject({ success: false });
    });
  });

  describe('resolveTo', () => {
    it('returns the recipient email address', () => {
      expect(channel.resolveTo(recipient)).toBe('user@example.com');
    });

    it('returns null when the recipient has no email address', () => {
      expect(
        channel.resolveTo({ ...recipient, email: null }),
      ).toBeNull();
    });
  });
});
