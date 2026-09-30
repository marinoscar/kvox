import { Logger } from '@nestjs/common';
import { WebPushError } from 'web-push';

import { PrismaService } from '../prisma/prisma.service';
import { NOTIFICATION_EVENTS } from './notification-events';
import { DEFAULT_NOTIFICATION_POLICY } from './notification-policy';
import { NotificationPolicyService } from './notification-policy.service';
import { PUSH_CONFIG_KEY, PushConfigService } from './push-config.service';
import {
  PUSH_TEST_EVENT_KEY,
  PushTestService,
  isValidVapidPublicKey,
  isValidVapidSubject,
  normalizeBase64Url,
  privateKeyDerivesPublicKey,
} from './push-test.service';
import { pushTestResponseSchema } from './dto/push-test.dto';

// =============================================================================
// PushTestService — tests (issue #449)
// =============================================================================
//
// `web-push` is mocked the same way `push-notification.channel.spec.ts` does
// it: `sendNotification` is a jest.fn, while the REAL `WebPushError` and the
// REAL `generateVAPIDKeys` are kept — the former so `instanceof` works for the
// prune path, the latter so the key-pair match check runs against genuine
// P-256 key material rather than strings shaped like it.
// =============================================================================

jest.mock('web-push', () => {
  const actual = jest.requireActual('web-push');
  return { ...actual, sendNotification: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpush = jest.requireMock('web-push') as {
  sendNotification: jest.Mock;
  generateVAPIDKeys: () => { publicKey: string; privateKey: string };
};

const USER_ID = 'admin-1';
const PAIR = webpush.generateVAPIDKeys();
const OTHER_PAIR = webpush.generateVAPIDKeys();
const SUBJECT = 'mailto:ops@example.org';

const ACTIVE = { publicKey: PAIR.publicKey, privateKey: PAIR.privateKey, subject: SUBJECT };

function sub(
  overrides: Partial<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    failureCount: number;
    lastSuccessAt: Date | null;
  }> = {},
) {
  return {
    id: 'sub-1',
    userId: USER_ID,
    endpoint: 'https://fcm.googleapis.com/fcm/send/abcdefgh12345678',
    p256dh: 'P256DH-SECRET-MATERIAL',
    auth: 'AUTH-SECRET-MATERIAL',
    expirationTime: null,
    userAgent: 'Mozilla/5.0 Test',
    failureCount: 2,
    lastSuccessAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('PushTestService', () => {
  let service: PushTestService;
  let prisma: {
    systemSettings: { findUnique: jest.Mock };
    pushSubscription: { findMany: jest.Mock; update: jest.Mock; delete: jest.Mock };
    userSettings: { findUnique: jest.Mock };
    auditEvent: { create: jest.Mock };
    notification: { create: jest.Mock };
    notificationDelivery: { create: jest.Mock };
  };
  let pushConfig: { resolveActiveVapidConfig: jest.Mock };
  let policy: { getPolicy: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma = {
      systemSettings: {
        findUnique: jest.fn().mockResolvedValue({
          value: { enabled: true, publicKey: PAIR.publicKey, subject: SUBJECT },
        }),
      },
      pushSubscription: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      userSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
      notification: { create: jest.fn() },
      notificationDelivery: { create: jest.fn() },
    };
    pushConfig = { resolveActiveVapidConfig: jest.fn().mockResolvedValue(ACTIVE) };
    policy = { getPolicy: jest.fn().mockResolvedValue(DEFAULT_NOTIFICATION_POLICY) };

    webpush.sendNotification.mockReset();

    service = new PushTestService(
      prisma as unknown as PrismaService,
      pushConfig as unknown as PushConfigService,
      policy as unknown as NotificationPolicyService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  // ---------------------------------------------------------------------------
  // overall states
  // ---------------------------------------------------------------------------

  it('not_configured: lists subscriptions as skipped and sends nothing', async () => {
    pushConfig.resolveActiveVapidConfig.mockResolvedValue(null);
    prisma.systemSettings.findUnique.mockResolvedValue(null);
    prisma.pushSubscription.findMany.mockResolvedValue([sub()]);

    const result = await service.runTest(USER_ID, {});

    expect(result.overall).toBe('not_configured');
    expect(result.config).toMatchObject({
      source: 'none',
      enabled: null,
      active: false,
      publicKey: null,
      privateKeyMatchesPublicKey: null,
    });
    expect(result.config.problems.length).toBeGreaterThan(0);
    expect(result.subscriptions).toHaveLength(1);
    expect(result.subscriptions[0].result.status).toBe('skipped');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(pushTestResponseSchema.safeParse(result).success).toBe(true);
  });

  it('reports source admin + enabled false for an explicitly disabled row', async () => {
    pushConfig.resolveActiveVapidConfig.mockResolvedValue(null);
    prisma.systemSettings.findUnique.mockResolvedValue({
      value: { enabled: false, publicKey: PAIR.publicKey, subject: null },
    });

    const result = await service.runTest(USER_ID, {});

    expect(result.overall).toBe('not_configured');
    expect(result.config.source).toBe('admin');
    expect(result.config.enabled).toBe(false);
    expect(result.hints.some((h) => /switched off/i.test(h))).toBe(true);
  });

  it('reports source env when no admin row exists but a pair is active', async () => {
    prisma.systemSettings.findUnique.mockResolvedValue(null);

    const result = await service.runTest(USER_ID, {});

    expect(result.config.source).toBe('env');
    expect(result.config.enabled).toBeNull();
    expect(result.config.active).toBe(true);
  });

  it('no_subscriptions: active config, caller has none', async () => {
    const result = await service.runTest(USER_ID, {});

    expect(result.overall).toBe('no_subscriptions');
    expect(result.subscriptions).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(result.hints.some((h) => /no push subscriptions/i.test(h))).toBe(true);
  });

  it('sent: sends only to the caller, with the documented options and payload, and records success', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abcdefgh12345678';
    prisma.pushSubscription.findMany.mockResolvedValue([sub({ endpoint })]);
    webpush.sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });

    const result = await service.runTest(USER_ID, { endpoint });

    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
    expect(result.overall).toBe('sent');
    expect(result.testId).toMatch(/^push-test-[0-9a-f-]{36}$/);

    const [target, payload, options] = webpush.sendNotification.mock.calls[0];
    expect(target).toEqual({
      endpoint,
      keys: { p256dh: 'P256DH-SECRET-MATERIAL', auth: 'AUTH-SECRET-MATERIAL' },
    });
    expect(JSON.parse(payload)).toMatchObject({
      id: result.testId,
      eventKey: PUSH_TEST_EVENT_KEY,
      title: 'Test push notification',
      link: '/admin/settings/push',
      test: true,
    });
    expect(options).toEqual({
      vapidDetails: { subject: SUBJECT, publicKey: PAIR.publicKey, privateKey: PAIR.privateKey },
      TTL: 60,
      urgency: 'high',
      timeout: 10_000,
    });

    expect(prisma.pushSubscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { lastSuccessAt: expect.any(Date), failureCount: 0 },
    });

    const [s] = result.subscriptions;
    expect(s).toMatchObject({
      pushService: 'fcm.googleapis.com',
      endpointPreview: 'fcm.googleapis.com/…12345678',
      isThisBrowser: true,
      failureCount: 0,
      result: { status: 'sent', statusCode: 201, message: null, responseBody: null },
    });
    expect(s.lastSuccessAt).not.toBeNull();
    expect(result.browser).toEqual({
      endpointProvided: true,
      endpointRegistered: true,
      keyMatchesServer: null,
    });

    // A test is not a notification.
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();

    // Audited, counts only.
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: USER_ID,
        action: 'push_config:test',
        targetId: PUSH_CONFIG_KEY,
      }),
    });
    expect(pushTestResponseSchema.safeParse(result).success).toBe(true);
  });

  it('partial: one sent, one failed with 500 — failureCount is NOT incremented', async () => {
    prisma.pushSubscription.findMany.mockResolvedValue([
      sub({ id: 'ok', endpoint: 'https://fcm.googleapis.com/fcm/send/ok-endpoint' }),
      sub({ id: 'bad', endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/bad' }),
    ]);
    webpush.sendNotification.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint.includes('mozilla')) {
        throw new WebPushError('Received unexpected response code', 503, {}, 'x'.repeat(900), s.endpoint);
      }
      return { statusCode: 201, body: '', headers: {} };
    });

    const result = await service.runTest(USER_ID, {});

    expect(result.overall).toBe('partial');
    const bad = result.subscriptions.find((s) => s.id === 'bad')!;
    expect(bad.result).toMatchObject({ status: 'failed', statusCode: 503 });
    expect(bad.result.responseBody).toHaveLength(500);
    expect(bad.failureCount).toBe(2);
    expect(prisma.pushSubscription.update).toHaveBeenCalledTimes(1);
    expect(prisma.pushSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ok' } }),
    );
    expect(prisma.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it('410 prunes the subscription and reports it as pruned; overall failed', async () => {
    prisma.pushSubscription.findMany.mockResolvedValue([sub()]);
    webpush.sendNotification.mockRejectedValue(
      new WebPushError('gone', 410, {}, 'push subscription has unsubscribed or expired', 'x'),
    );

    const result = await service.runTest(USER_ID, {});

    expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
    expect(result.subscriptions[0].result).toMatchObject({
      status: 'pruned',
      statusCode: 410,
      responseBody: 'push subscription has unsubscribed or expired',
    });
    expect(result.overall).toBe('failed');
    expect(result.hints.some((h) => /expired or been revoked/.test(h))).toBe(true);
  });

  it('403 yields the key-mismatch hint', async () => {
    prisma.pushSubscription.findMany.mockResolvedValue([sub()]);
    webpush.sendNotification.mockRejectedValue(
      new WebPushError('Received unexpected response code', 403, {}, 'invalid JWT provided', 'x'),
    );

    const result = await service.runTest(USER_ID, {});

    expect(result.overall).toBe('failed');
    expect(result.subscriptions[0].result.statusCode).toBe(403);
    expect(
      result.hints.some((h) => h.startsWith('403') && /VAPID key pair does not match/.test(h)),
    ).toBe(true);
    expect(prisma.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it('a network error reports statusCode null and a reachability hint', async () => {
    prisma.pushSubscription.findMany.mockResolvedValue([sub()]);
    webpush.sendNotification.mockRejectedValue(new Error('Socket timeout'));

    const result = await service.runTest(USER_ID, {});

    expect(result.subscriptions[0].result).toMatchObject({
      status: 'failed',
      statusCode: null,
      message: 'Socket timeout',
      responseBody: null,
    });
    expect(result.hints.some((h) => /Could not reach fcm\.googleapis\.com/.test(h))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // browser checks
  // ---------------------------------------------------------------------------

  it('keyMatchesServer is false when the browser subscribed with another key', async () => {
    const result = await service.runTest(USER_ID, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/not-registered',
      applicationServerKey: OTHER_PAIR.publicKey,
    });

    expect(result.browser).toEqual({
      endpointProvided: true,
      endpointRegistered: false,
      keyMatchesServer: false,
    });
    expect(result.hints.some((h) => /different VAPID key/.test(h))).toBe(true);
    expect(result.hints.some((h) => /No subscription for this browser is registered/.test(h))).toBe(true);
  });

  it('keyMatchesServer is true regardless of base64url padding', async () => {
    const result = await service.runTest(USER_ID, {
      applicationServerKey: `${PAIR.publicKey}=`,
    });
    expect(result.browser.keyMatchesServer).toBe(true);
    expect(result.browser.endpointRegistered).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // config checks
  // ---------------------------------------------------------------------------

  it('privateKeyMatchesPublicKey is true for a real generated pair', async () => {
    const result = await service.runTest(USER_ID, {});
    expect(result.config).toMatchObject({
      publicKeyValid: true,
      privateKeyMatchesPublicKey: true,
      subjectValid: true,
      problems: [],
    });
  });

  it('privateKeyMatchesPublicKey is false for a mismatched pair', async () => {
    pushConfig.resolveActiveVapidConfig.mockResolvedValue({
      ...ACTIVE,
      privateKey: OTHER_PAIR.privateKey,
    });

    const result = await service.runTest(USER_ID, {});

    expect(result.config.publicKeyValid).toBe(true);
    expect(result.config.privateKeyMatchesPublicKey).toBe(false);
    expect(result.config.problems.some((p) => /does not match/.test(p))).toBe(true);
  });

  it('flags an invalid subject', async () => {
    pushConfig.resolveActiveVapidConfig.mockResolvedValue({ ...ACTIVE, subject: 'http://insecure.example' });
    const result = await service.runTest(USER_ID, {});
    expect(result.config.subjectValid).toBe(false);
    expect(result.hints.some((h) => /VAPID subject/.test(h))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // routing checks
  // ---------------------------------------------------------------------------

  it('lists only push-capable events and honours stored preferences (mandatory stays on)', async () => {
    const pushEvents = NOTIFICATION_EVENTS.filter((e) => e.channels.includes('push'));
    prisma.userSettings.findUnique.mockResolvedValue({
      value: {
        notifications: {
          push: Object.fromEntries(pushEvents.map((e) => [e.key, false])),
        },
      },
    });

    const result = await service.runTest(USER_ID, {});

    expect(result.events.map((e) => e.eventKey)).toEqual(pushEvents.map((e) => e.key));
    for (const event of result.events) {
      expect(event.policyAllows).toBe(true);
      expect(event.preferenceAllows).toBe(event.mandatory);
    }
    expect(result.hints.some((h) => /turned off push for/.test(h))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // secrets
  // ---------------------------------------------------------------------------

  it('never returns the private key, p256dh, auth or a full endpoint', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/VERY-SECRET-CAPABILITY-TOKEN-zz99';
    prisma.pushSubscription.findMany.mockResolvedValue([sub({ endpoint })]);
    webpush.sendNotification.mockRejectedValue(
      new WebPushError('Received unexpected response code', 403, {}, 'nope', endpoint),
    );

    const result = await service.runTest(USER_ID, { endpoint });
    const json = JSON.stringify(result);

    expect(json).not.toContain(PAIR.privateKey);
    expect(json).not.toContain('P256DH-SECRET-MATERIAL');
    expect(json).not.toContain('AUTH-SECRET-MATERIAL');
    expect(json).not.toContain('VERY-SECRET-CAPABILITY-TOKEN');

    const logged = (Logger.prototype.log as jest.Mock).mock.calls.flat().join(' ');
    expect(logged).not.toContain(PAIR.privateKey);
    expect(logged).not.toContain('VERY-SECRET-CAPABILITY-TOKEN');

    const audited = JSON.stringify(prisma.auditEvent.create.mock.calls);
    expect(audited).not.toContain(PAIR.privateKey);
    expect(audited).not.toContain('VERY-SECRET-CAPABILITY-TOKEN');
  });

  it('an audit write failure does not fail the test', async () => {
    prisma.auditEvent.create.mockRejectedValue(new Error('db down'));
    await expect(service.runTest(USER_ID, {})).resolves.toMatchObject({
      overall: 'no_subscriptions',
    });
  });
});

describe('push-test pure helpers', () => {
  it('normalizeBase64Url strips padding', () => {
    expect(normalizeBase64Url('abc==')).toBe('abc');
  });

  it('isValidVapidPublicKey', () => {
    expect(isValidVapidPublicKey(PAIR.publicKey)).toBe(true);
    expect(isValidVapidPublicKey('not a key')).toBe(false);
    expect(isValidVapidPublicKey(PAIR.privateKey)).toBe(false); // 32 bytes
  });

  it('privateKeyDerivesPublicKey', () => {
    expect(privateKeyDerivesPublicKey(PAIR.privateKey, PAIR.publicKey)).toBe(true);
    expect(privateKeyDerivesPublicKey(OTHER_PAIR.privateKey, PAIR.publicKey)).toBe(false);
    expect(privateKeyDerivesPublicKey('garbage', PAIR.publicKey)).toBe(false);
  });

  it('isValidVapidSubject', () => {
    expect(isValidVapidSubject('mailto:ops@example.org')).toBe(true);
    expect(isValidVapidSubject('https://example.org')).toBe(true);
    expect(isValidVapidSubject('mailto:nobody')).toBe(false);
    expect(isValidVapidSubject('http://example.org')).toBe(false);
  });
});
