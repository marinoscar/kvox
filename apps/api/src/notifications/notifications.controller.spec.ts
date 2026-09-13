import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { NotificationsController } from './notifications.controller';
import { NotificationPolicyService } from './notification-policy.service';
import { NotificationStoreService } from './notification-store.service';
import { NotificationStreamService } from './notification-stream.service';
import { PushSubscriptionService } from './push-subscription.service';
import { PatService } from '../pat/pat.service';
import { NodeCredentialService } from '../nodes/node-credential.service';

// =============================================================================
// NotificationsController — tests (issues #226/#229, epic #215)
// =============================================================================
//
// Unit-level: the controller instance's methods are called directly (no HTTP,
// no guards executed — `@Auth()`'s guards only run inside Nest's real request
// pipeline), matching the pattern in `email-settings.controller.spec.ts`. Every
// collaborator is a bare jest-mock stand-in; each collaborator's own behaviour
// has its own spec file (`push-subscription.service.spec.ts`,
// `notification-policy.spec.ts`, ...). What is under test here is purely the
// controller's OWN branching: what it forwards, what status it returns, and
// how it turns a service-level 409/404 into an HTTP response.
//
// End-to-end coverage of these same endpoints — status codes actually
// produced by a full `supertest` request, ownership genuinely enforced by a
// mocked-but-independent Prisma layer — lives in
// `test/notifications/push-subscriptions.integration.spec.ts`.
// =============================================================================

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let mockStore: {
    list: jest.Mock;
    unreadCount: jest.Mock;
    markRead: jest.Mock;
    markAllRead: jest.Mock;
  };
  let mockStreams: { subscribe: jest.Mock };
  let mockPolicy: { getPolicy: jest.Mock };
  let mockPushSubscriptions: {
    isEnabled: jest.Mock;
    getVapidPublicKey: jest.Mock;
    subscribe: jest.Mock;
    unsubscribe: jest.Mock;
  };

  beforeEach(async () => {
    mockStore = {
      list: jest.fn(),
      unreadCount: jest.fn(),
      markRead: jest.fn(),
      markAllRead: jest.fn(),
    };
    mockStreams = { subscribe: jest.fn() };
    mockPolicy = {
      getPolicy: jest.fn().mockResolvedValue({
        browserEnabled: true,
        disabledEvents: [],
      }),
    };
    mockPushSubscriptions = {
      isEnabled: jest.fn().mockReturnValue(false),
      getVapidPublicKey: jest.fn().mockReturnValue(null),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationStoreService, useValue: mockStore },
        { provide: NotificationStreamService, useValue: mockStreams },
        { provide: NotificationPolicyService, useValue: mockPolicy },
        { provide: PushSubscriptionService, useValue: mockPushSubscriptions },
        // Not exercised: guards attached via `@Auth()`'s `@UseGuards()` are
        // never invoked by calling a controller method directly (only Nest's
        // real request pipeline runs them), but this Nest version still
        // resolves `JwtAuthGuard`'s constructor dependencies at module-compile
        // time. A minimal stub is enough to satisfy that.
        { provide: PatService, useValue: { validateToken: jest.fn() } },
        // JwtAuthGuard gained a second opaque-bearer dependency in #267
        // (the `nod_` family). Stubbed the same way PatService is: this suite
        // never sends a bearer token, so neither validator is ever reached —
        // the provider exists only so the guard can be constructed.
        { provide: NodeCredentialService, useValue: { validateToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get<NotificationsController>(NotificationsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // GET /config — now backed by PushSubscriptionService (#229)
  // ==========================================================================

  // ==========================================================================
  // GET /events — the registry as the preferences page sees it
  // ==========================================================================

  describe('GET /events', () => {
    it("lists #288's four operational events with the channels and defaults the registry declares", async () => {
      // The acceptance criterion of #288, asserted at the endpoint the
      // preferences page actually reads rather than against the registry
      // constant — the endpoint applies the admin policy on the way out, and
      // "the event is registered" and "the endpoint offers it" are two
      // different claims.
      const events = await controller.listEvents();
      const byKey = new Map(events.map((event) => [event.key, event]));

      expect(byKey.get('jobs.job_failed')).toMatchObject({
        channels: ['email'],
        defaultEnabled: true,
        mandatory: false,
      });
      expect(byKey.get('nodes.node_offline')).toMatchObject({
        channels: ['email', 'browser'],
        defaultEnabled: true,
        mandatory: false,
      });
      expect(byKey.get('db_backup.backup_failed')).toMatchObject({
        channels: ['email', 'browser'],
        defaultEnabled: true,
        mandatory: false,
      });
      expect(byKey.get('db_backup.restore_completed')).toMatchObject({
        channels: ['email', 'browser'],
        defaultEnabled: true,
        // The one the user may not switch off.
        mandatory: true,
      });
    });

    it('gives every one of the four a non-empty label and description for the matrix to render', async () => {
      const events = await controller.listEvents();

      for (const key of [
        'jobs.job_failed',
        'nodes.node_offline',
        'db_backup.backup_failed',
        'db_backup.restore_completed',
      ]) {
        const event = events.find((candidate) => candidate.key === key);

        expect(event).toBeDefined();
        expect(event!.label.trim().length).toBeGreaterThan(0);
        expect(event!.description.trim().length).toBeGreaterThan(0);
      }
    });

    it('drops browser from the muteable operational events when the admin kill switch is off, but not from the mandatory one', async () => {
      // `channels` is capability ∩ policy, and a `mandatory` event is the
      // documented exception: its stored notification IS the delivery, so the
      // policy shows up as `toast: false` on the stream instead.
      mockPolicy.getPolicy.mockResolvedValue({
        browserEnabled: false,
        disabledEvents: [],
      });

      const events = await controller.listEvents();
      const byKey = new Map(events.map((event) => [event.key, event]));

      expect(byKey.get('nodes.node_offline')!.channels).toEqual(['email']);
      expect(byKey.get('db_backup.backup_failed')!.channels).toEqual(['email']);
      expect(byKey.get('db_backup.restore_completed')!.channels).toEqual([
        'email',
        'browser',
      ]);
    });
  });

  describe('GET /config', () => {
    it('reflects pushEnabled: false and vapidPublicKey: null when no VAPID keys are configured', async () => {
      mockPushSubscriptions.isEnabled.mockReturnValue(false);
      mockPushSubscriptions.getVapidPublicKey.mockReturnValue(null);

      const result = await controller.config();

      expect(result).toEqual({
        browserEnabled: true,
        pushEnabled: false,
        vapidPublicKey: null,
      });
    });

    it('reflects pushEnabled: true and the real public key once VAPID is configured', async () => {
      mockPushSubscriptions.isEnabled.mockReturnValue(true);
      mockPushSubscriptions.getVapidPublicKey.mockReturnValue('pub-key-123');

      const result = await controller.config();

      expect(result).toEqual({
        browserEnabled: true,
        pushEnabled: true,
        vapidPublicKey: 'pub-key-123',
      });
    });

    it('calls isEnabled() and getVapidPublicKey() rather than hardcoding either value', async () => {
      await controller.config();

      expect(mockPushSubscriptions.isEnabled).toHaveBeenCalledTimes(1);
      expect(mockPushSubscriptions.getVapidPublicKey).toHaveBeenCalledTimes(1);
    });

    it('still reports browserEnabled from the admin policy, independent of push', async () => {
      mockPolicy.getPolicy.mockResolvedValue({
        browserEnabled: false,
        disabledEvents: [],
      });

      const result = await controller.config();

      expect(result.browserEnabled).toBe(false);
    });
  });

  // ==========================================================================
  // POST /push/subscriptions
  // ==========================================================================

  describe('POST /push/subscriptions', () => {
    const dto = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
      expirationTime: null,
    } as any;

    it('success: 201 shape — delegates to the service and returns id/endpoint/createdAt', async () => {
      mockPushSubscriptions.subscribe.mockResolvedValue({
        id: 'sub-1',
        endpoint: dto.endpoint,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const result = await controller.subscribePush(
        'user-1',
        dto,
        'test-agent',
      );

      expect(result).toEqual({
        id: 'sub-1',
        endpoint: dto.endpoint,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(mockPushSubscriptions.subscribe).toHaveBeenCalledWith(
        'user-1',
        dto,
        'test-agent',
      );
    });

    it('propagates the service’s 409 ConflictException when push is not enabled on this deployment — NOT a 500', async () => {
      mockPushSubscriptions.subscribe.mockRejectedValue(
        new ConflictException('Web Push is not enabled on this deployment'),
      );

      await expect(
        controller.subscribePush('user-1', dto, 'test-agent'),
      ).rejects.toThrow(ConflictException);

      // Specifically a ConflictException instance (-> HTTP 409), not some
      // other error type that Nest's exception filter would turn into a 500.
      await expect(
        controller.subscribePush('user-1', dto, 'test-agent'),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('passes the caller id from @CurrentUser, never anything from the body', async () => {
      mockPushSubscriptions.subscribe.mockResolvedValue({
        id: 'sub-1',
        endpoint: dto.endpoint,
        createdAt: new Date(),
      });

      await controller.subscribePush('the-authenticated-user', dto, undefined);

      expect(mockPushSubscriptions.subscribe).toHaveBeenCalledWith(
        'the-authenticated-user',
        dto,
        undefined,
      );
    });
  });

  // ==========================================================================
  // DELETE /push/subscriptions
  // ==========================================================================

  describe('DELETE /push/subscriptions', () => {
    const dto = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' } as any;

    it('success: 204 — delegates to the service with the caller id and endpoint', async () => {
      mockPushSubscriptions.unsubscribe.mockResolvedValue(undefined);

      await expect(
        controller.unsubscribePush('user-1', dto),
      ).resolves.toBeUndefined();
      expect(mockPushSubscriptions.unsubscribe).toHaveBeenCalledWith(
        'user-1',
        dto.endpoint,
      );
    });

    it('propagates a 404 NotFoundException when the subscription does not belong to this user (or does not exist)', async () => {
      mockPushSubscriptions.unsubscribe.mockRejectedValue(
        new NotFoundException('Push subscription not found'),
      );

      await expect(controller.unsubscribePush('user-1', dto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
