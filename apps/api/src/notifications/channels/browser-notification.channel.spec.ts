import {
  BrowserNotificationChannel,
  EVENT_BROWSER_TEMPLATES,
  sanitizeLink,
} from './browser-notification.channel';
import { NOTIFICATION_EVENTS } from '../notification-events';
import type {
  NotificationDispatchContext,
  NotificationRecipient,
} from '../notification.types';

// =============================================================================
// BrowserNotificationChannel — tests (issue #127, epic #109)
// =============================================================================
//
// `mockStream = { publish: jest.fn() }` — a plain jest mock, not a real
// `NotificationStreamService`. This suite is about the channel's own
// branching (render fallback, ordering, truncation, link sanitisation), not
// about the stream registry (see notification-stream.service.spec.ts for
// that).
//
// THE ORDERING CENTREPIECE: `prisma.notification.create` must be called and
// awaited BEFORE `stream.publish` — a durable row for a crashed/never-open
// stream, never the reverse. See the source file's header for why.
// =============================================================================

const recipient: NotificationRecipient = {
  userId: 'user-1',
  email: 'user@example.com',
  preferences: {},
};

/**
 * A payload each event's registered browser template can actually render.
 *
 * #128 registered one template (`security.role_changed`), and it reads fields
 * off the payload. Feeding it `{}` would exercise the render-throw branch
 * rather than the happy path, so the loops below say what a real dispatch
 * would carry. An event with no template ignores this entirely — the fallback
 * renders from the registry's own label and description.
 */
const SAMPLE_PAYLOADS: Record<string, unknown> = {
  'security.role_changed': {
    recipientEmail: 'user@example.com',
    previousRoles: ['admin'],
    currentRoles: ['viewer'],
    changedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  // #322's two broadcast keys share one renderer, and it is a projection of
  // the admin-composed payload — so, like the role-change template, `{}` would
  // exercise its throw branch rather than the happy path the loops below are
  // about.
  'admin.broadcast': {
    title: 'Planned maintenance this Saturday',
    body: 'The application will be unavailable from 22:00 UTC.',
    link: '/announcements/42',
  },
  'admin.broadcast_critical': {
    title: 'Unplanned outage',
    body: 'Sign-in is currently failing. We are working on it.',
    critical: true,
  },
  // #288's three browser-capable operational events (epic #254). Each renderer
  // reads real fields off its payload — and `nodes.node_offline` and
  // `db_backup.restore_completed` call `.toISOString()` on a `Date` — so `{}`
  // would exercise their throw branch rather than the happy path the loop
  // below is about. `jobs.job_failed` is deliberately absent from
  // `EVENT_BROWSER_TEMPLATES` and needs no entry here: it takes the registry
  // fallback, which is exactly what the loop asserts still works.
  'nodes.node_offline': {
    nodeId: 'node-1',
    nodeName: 'worker-a',
    lastHeartbeatAt: new Date('2026-01-01T00:00:00.000Z'),
    markedOfflineAt: new Date('2026-01-01T00:06:00.000Z'),
    staleAfterMinutes: 6,
  },
  'db_backup.backup_failed': {
    runId: 'run-1',
    outcome: 'failed',
    error: 'pg_dump exited with code 1',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    failedAt: new Date('2026-01-01T00:10:00.000Z'),
    trigger: 'scheduled',
  },
  'db_backup.restore_completed': {
    runId: 'run-1',
    backupTakenAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-02T00:00:00.000Z'),
    triggeredBy: 'ops@example.com',
    preRestoreBackupId: 'run-pre',
  },
};

function contextFor(eventKey: string, data: unknown = {}): NotificationDispatchContext {
  const event = NOTIFICATION_EVENTS.find((e) => e.key === eventKey);
  if (!event) {
    throw new Error(`Test fixture error: no such event '${eventKey}' in the registry.`);
  }
  return { event, recipient, data };
}

describe('BrowserNotificationChannel', () => {
  let channel: BrowserNotificationChannel;
  let mockPrisma: { notification: { create: jest.Mock } };
  let mockStream: { publish: jest.Mock };

  beforeEach(() => {
    mockPrisma = { notification: { create: jest.fn() } };
    mockStream = { publish: jest.fn() };

    channel = new BrowserNotificationChannel(mockPrisma as never, mockStream as never);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // resolveTo
  // ==========================================================================

  describe('resolveTo', () => {
    it('returns the recipient userId', () => {
      expect(channel.resolveTo(recipient)).toBe('user-1');
    });

    it('returns null when the recipient has no account (userId: null)', () => {
      expect(channel.resolveTo({ ...recipient, userId: null })).toBeNull();
    });
  });

  // ==========================================================================
  // EVENT_BROWSER_TEMPLATES is empty until #128
  // ==========================================================================

  describe('EVENT_BROWSER_TEMPLATES agrees with the registry (#128)', () => {
    it('registers no template for an event that does not declare the browser channel', () => {
      // The registry's per-event `channels` list is the source of truth. A
      // renderer for an event that never offers this channel is dead code
      // that reads as a live feature — `user.welcome` and
      // `allowlist.invitation` are email-only, the latter because its
      // recipient has no account and therefore no inbox row to write.
      const nonBrowserEvents = NOTIFICATION_EVENTS.filter(
        (event) => !event.channels.includes('browser'),
      ).map((event) => event.key);

      expect(nonBrowserEvents.length).toBeGreaterThan(0);

      for (const key of nonBrowserEvents) {
        expect(EVENT_BROWSER_TEMPLATES[key]).toBeUndefined();
      }
    });

    it('a browser-channel event without a template still delivers, via the fallback', () => {
      // Deliberately NOT "every browser event has a template". Unlike the
      // email channel, a miss here is not a failed delivery — it falls back to
      // the registry's label and description, which is truthful if generic.
      // See the source file's `render()` for why the two channels differ.
      for (const event of NOTIFICATION_EVENTS.filter((e) =>
        e.channels.includes('browser'),
      )) {
        expect(typeof event.label).toBe('string');
        expect(event.label.length).toBeGreaterThan(0);
        expect(typeof event.description).toBe('string');
        expect(event.description.length).toBeGreaterThan(0);
      }
    });
  });

  // ==========================================================================
  // ORDERING CENTREPIECE: create() awaited BEFORE publish()
  // ==========================================================================

  describe('deliver() ordering: the row is written before the stream is published to', () => {
    it('calls prisma.notification.create and awaits it before calling stream.publish', async () => {
      const callOrder: string[] = [];

      mockPrisma.notification.create.mockImplementation(async () => {
        callOrder.push('create');
        return { id: 'notif-1', createdAt: new Date('2026-01-01T00:00:00.000Z') };
      });
      mockStream.publish.mockImplementation(() => {
        callOrder.push('publish');
        return 1;
      });

      const context = contextFor('user.welcome');
      const result = await channel.deliver(context, 'user-1');

      expect(callOrder).toEqual(['create', 'publish']);
      expect(result).toEqual({ success: true, messageId: 'notif-1' });
    });
  });

  // ==========================================================================
  // The `toast` flag (#226): admin policy reaches the bubble, not the row
  // ==========================================================================

  describe('the published event carries a server-computed `toast` flag', () => {
    beforeEach(() => {
      mockPrisma.notification.create.mockResolvedValue({
        id: 'notif-toast',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      mockStream.publish.mockReturnValue(1);
    });

    it('is true when the context carries no policy at all', async () => {
      await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(mockStream.publish).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ toast: true }),
      );
    });

    it('is false when the deployment-wide switch is off — and the row is STILL written', async () => {
      // The invariant of #226, at the level of the one class that could break
      // it: the INSERT happens above the flag, not because of it.
      const context = {
        ...contextFor(
          'security.role_changed',
          SAMPLE_PAYLOADS['security.role_changed'],
        ),
        policy: { browserEnabled: false, disabledEvents: [] },
      };

      const result = await channel.deliver(context, 'user-1');

      expect(result.success).toBe(true);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      expect(mockStream.publish).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          eventKey: 'security.role_changed',
          toast: false,
        }),
      );
    });

    it('is false for a specifically suppressed event and true for its neighbour', async () => {
      const policy = {
        browserEnabled: true,
        disabledEvents: ['security.role_changed'],
      };

      await channel.deliver(
        {
          ...contextFor(
            'security.role_changed',
            SAMPLE_PAYLOADS['security.role_changed'],
          ),
          policy,
        },
        'user-1',
      );
      await channel.deliver(
        { ...contextFor('user.welcome'), policy },
        'user-1',
      );

      expect(mockStream.publish.mock.calls[0]![1].toast).toBe(false);
      expect(mockStream.publish.mock.calls[1]![1].toast).toBe(true);
    });
  });

  // ==========================================================================
  // Render fallback: a miss falls back to the registry's label/description
  // ==========================================================================

  describe('render() fallback when no template is registered (true for every current event)', () => {
    it('deliver() succeeds using event.label/event.description as title/body', async () => {
      mockPrisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      mockStream.publish.mockReturnValue(0);

      const event = NOTIFICATION_EVENTS.find((e) => e.key === 'user.welcome')!;
      const context = contextFor('user.welcome');

      const result = await channel.deliver(context, 'user-1');

      expect(result.success).toBe(true);
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: event.label,
            body: event.description,
          }),
        }),
      );
    });

    it('delivers successfully for every registered event, template or fallback', async () => {
      mockPrisma.notification.create.mockResolvedValue({
        id: 'notif-x',
        createdAt: new Date(),
      });
      mockStream.publish.mockReturnValue(0);

      for (const event of NOTIFICATION_EVENTS) {
        const context = contextFor(event.key, SAMPLE_PAYLOADS[event.key] ?? {});
        await expect(channel.deliver(context, 'user-1')).resolves.toMatchObject({
          success: true,
        });
      }
    });

    it('the #128 role-change template renders the before/after delta, not just the new state', async () => {
      // The one registered template, asserted on directly: "you are now a
      // Viewer" cannot tell the reader whether they gained access or lost it,
      // which is why the delta is the alertable fact (see
      // role-changed.email.ts for the same argument on the email side).
      mockPrisma.notification.create.mockResolvedValue({
        id: 'notif-role',
        createdAt: new Date(),
      });
      mockStream.publish.mockReturnValue(0);

      const context = contextFor(
        'security.role_changed',
        SAMPLE_PAYLOADS['security.role_changed'],
      );

      await channel.deliver(context, 'user-1');

      const written = mockPrisma.notification.create.mock.calls[0]![0].data;
      expect(written.title).toBe('Your roles changed');
      expect(written.body).toContain('Admin');
      expect(written.body).toContain('Viewer');
      // No link: this application has no page showing a user their own roles.
      expect(written.link).toBeNull();
    });
  });

  // ==========================================================================
  // Database failure: create() rejects
  // ==========================================================================

  describe('when prisma.notification.create rejects', () => {
    it('returns { success: false, error } and never calls stream.publish', async () => {
      mockPrisma.notification.create.mockRejectedValue(new Error('db unavailable'));

      const context = contextFor('user.welcome');
      const result = await channel.deliver(context, 'user-1');

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('db unavailable');
      expect(mockStream.publish).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Truncation, and a throwing template
  // ==========================================================================
  //
  // `EVENT_BROWSER_TEMPLATES` is a plain (non-frozen) object exported for
  // #128 to populate later. It is empty today, but nothing stops a test from
  // registering a temporary entry at runtime to exercise `render()`'s other
  // two branches — a template that returns oversized content, and one that
  // throws — without touching the source file. Removed in `afterEach` so it
  // never leaks into another test.
  // ==========================================================================

  describe('title/body truncation (registered template returns oversized content)', () => {
    const EVENT_KEY = 'user.welcome';

    afterEach(() => {
      delete EVENT_BROWSER_TEMPLATES[EVENT_KEY];
    });

    it('caps title at 200 chars and body at 2000 chars, each ending with an ellipsis', async () => {
      const oversizedTitle = 'T'.repeat(250);
      const oversizedBody = 'B'.repeat(2500);

      EVENT_BROWSER_TEMPLATES[EVENT_KEY] = () => ({
        title: oversizedTitle,
        body: oversizedBody,
      });

      mockPrisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        createdAt: new Date(),
      });
      mockStream.publish.mockReturnValue(0);

      const context = contextFor(EVENT_KEY);
      await channel.deliver(context, 'user-1');

      const [[createArgs]] = mockPrisma.notification.create.mock.calls as unknown as [
        [{ data: { title: string; body: string } }],
      ];

      expect(createArgs.data.title).toHaveLength(200);
      expect(createArgs.data.title.endsWith('…')).toBe(true);
      expect(createArgs.data.body).toHaveLength(2000);
      expect(createArgs.data.body.endsWith('…')).toBe(true);
    });

    it('leaves content under the cap untouched, with no ellipsis added', async () => {
      EVENT_BROWSER_TEMPLATES[EVENT_KEY] = () => ({
        title: 'Short title',
        body: 'Short body.',
      });

      mockPrisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        createdAt: new Date(),
      });
      mockStream.publish.mockReturnValue(0);

      const context = contextFor(EVENT_KEY);
      await channel.deliver(context, 'user-1');

      const [[createArgs]] = mockPrisma.notification.create.mock.calls as unknown as [
        [{ data: { title: string; body: string } }],
      ];
      expect(createArgs.data.title).toBe('Short title');
      expect(createArgs.data.body).toBe('Short body.');
    });
  });

  describe('when a registered template throws', () => {
    const EVENT_KEY = 'user.welcome';

    afterEach(() => {
      delete EVENT_BROWSER_TEMPLATES[EVENT_KEY];
    });

    it('deliver() returns { success: false, error } WITHOUT ever calling prisma.notification.create', async () => {
      EVENT_BROWSER_TEMPLATES[EVENT_KEY] = () => {
        throw new Error('template blew up');
      };

      const context = contextFor(EVENT_KEY);
      const result = await channel.deliver(context, 'user-1');

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('template blew up');
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      expect(mockStream.publish).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // sanitizeLink — exported, tested directly
  // ==========================================================================

  describe('sanitizeLink', () => {
    describe('accepted', () => {
      it.each([
        ['/settings', '/settings'],
        ['/admin/users?tab=roles', '/admin/users?tab=roles'],
        ['/x#frag', '/x#frag'],
        [' /settings ', '/settings'], // trimmed then accepted
      ])('accepts %j -> %j', (input, expected) => {
        expect(sanitizeLink(input)).toBe(expected);
      });
    });

    describe('rejected -> null', () => {
      it.each([
        ['protocol-relative', '//evil.example/x'],
        ['absolute https URL', 'https://evil/x'],
        ['javascript scheme', 'javascript:alert(1)'],
        ['data URL', 'data:text/html,x'],
        ['relative without leading slash', 'settings'],
        ['backslash after slash', '/\\evil.example'],
        ['embedded tab', '/settings\tpath'],
        ['embedded newline', '/settings\npath'],
        ['embedded carriage return', '/settings\rpath'],
        ['empty string', ''],
      ])('rejects %s (%j) -> null', (_label, input) => {
        expect(sanitizeLink(input)).toBeNull();
      });

      it('rejects undefined -> null', () => {
        expect(sanitizeLink(undefined)).toBeNull();
      });
    });
  });
});
