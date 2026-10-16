import { createECDH, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, PushSubscription } from '@prisma/client';
import * as webpush from 'web-push';
import { WebPushError } from 'web-push';

import { PrismaService } from '../prisma/prisma.service';
import { describeThrown } from './describe-thrown';
import { NOTIFICATION_EVENTS } from './notification-events';
import { policyChannels } from './notification-policy';
import { NotificationPolicyService } from './notification-policy.service';
import {
  isChannelEnabled,
  readNotificationPreferences,
} from './notification-preferences';
import { DEFAULT_VAPID_SUBJECT, pushConfigSchema } from './push-config.schema';
import {
  type ActiveVapidConfig,
  PUSH_CONFIG_KEY,
  PushConfigService,
} from './push-config.service';
import type {
  PushTestBrowserDiagnostics,
  PushTestConfigDiagnostics,
  PushTestConfigSource,
  PushTestEventDiagnostics,
  PushTestOverall,
  PushTestRequest,
  PushTestResponse,
  PushTestSendResult,
  PushTestSubscriptionResult,
} from './dto/push-test.dto';

// =============================================================================
// PushTestService — "send me a test push and tell me what broke" (issue #449)
// =============================================================================
//
// Backs `POST /api/admin/push-config/test`. An admin reporting "push doesn't
// work" needs to know WHICH LINK fails, and there are several, each checked
// here and reported separately:
//
//   1. CONFIG   — is a key pair active, where does it come from (admin row vs.
//                 env), is the public key a real P-256 point, does the stored
//                 private key actually derive that public key, is the subject
//                 something a push service will accept?
//   2. BROWSER  — is the endpoint THIS browser holds registered for the
//                 caller, and was it created against the key that is active
//                 NOW (a rotation the browser never noticed is the classic
//                 silent failure: the push service answers 403)?
//   3. ROUTING  — for each event that can travel by push, do the admin policy
//                 and the caller's own preferences keep the channel open? A
//                 perfect send path is useless if every broadcast is muted.
//   4. DELIVERY — a real, signed send to each of the caller's OWN
//                 subscriptions, with the push service's status and body.
//
// …and then `hints`: plain-English next steps derived from all of the above.
//
// -----------------------------------------------------------------------------
// WHY THIS IS NOT A QUEUE JOB (CLAUDE.md: "every long-running activity is a
// queue job")
// -----------------------------------------------------------------------------
//
// It does not outlive the request that started it. The work is bounded: only
// the CALLER'S OWN subscriptions (a handful of devices), sent in parallel,
// each capped by a 10 s socket timeout, and the admin needs the result INLINE
// — a diagnostic you have to poll for is a worse diagnostic. Nothing is
// detached (`void …`), and nothing continues after the response is written.
//
// -----------------------------------------------------------------------------
// WHY IT DOES NOT GO THROUGH `notify()` / `PushNotificationChannel`
// -----------------------------------------------------------------------------
//
// A test is not a notification. `notify()` would write a `notifications` row
// (a bell entry for "Test push notification") and a `notification_deliveries`
// row, and its channel swallows per-endpoint detail into a single
// success/failure — exactly the detail this endpoint exists to surface. So it
// calls `webpush.sendNotification` itself, with the SAME `vapidDetails` the
// channel builds from the SAME `resolveActiveVapidConfig()`, and keeps the
// channel's bookkeeping rules where they are about the ENDPOINT rather than
// the notification: success clears `failureCount`/stamps `lastSuccessAt`,
// 404/410 prunes the row. It deliberately does NOT increment `failureCount`
// on other failures — an admin clicking "test" repeatedly while debugging a
// bad key pair must not be able to prune their own healthy subscriptions.
//
// -----------------------------------------------------------------------------
// SECRETS
// -----------------------------------------------------------------------------
//
// The VAPID private key is used for two things only — signing the sends and
// deriving its public half for the match check — and is never returned,
// logged or audited. Neither are `p256dh`/`auth`, nor a full endpoint (only
// host + last 8 chars). See the compile-time proof in `dto/push-test.dto.ts`.
// =============================================================================

/** Sent as the payload's `eventKey`; not a registry event, and never persisted. */
export const PUSH_TEST_EVENT_KEY = 'push.test';

/** Where the service worker's click lands: the page that ran the test. */
const PUSH_TEST_LINK = '/admin/settings/push';

/** Per-send socket timeout handed to `web-push`. */
const SEND_TIMEOUT_MS = 10_000;

/** How long the push service may hold a test message for an offline device. */
const TEST_TTL_SECONDS = 60;

/** Cap on a push service's error body echoed back to the admin. */
const MAX_RESPONSE_BODY_LENGTH = 500;

/** How many trailing endpoint characters `endpointPreview` shows. */
const ENDPOINT_PREVIEW_TAIL = 8;

/** Length of an uncompressed P-256 public point: 0x04 || X(32) || Y(32). */
const UNCOMPRESSED_P256_POINT_LENGTH = 65;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

@Injectable()
export class PushTestService {
  private readonly logger = new Logger(PushTestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushConfig: PushConfigService,
    private readonly policy: NotificationPolicyService,
  ) {}

  /**
   * Run every check, send a test push to the caller's own subscriptions, and
   * return the full diagnostic. Never throws for a failed SEND — a failure is
   * the answer, reported in the body with HTTP 200. It can still throw on an
   * unexpected database error, which is a real 500.
   */
  async runTest(userId: string, input: PushTestRequest): Promise<PushTestResponse> {
    const startedAt = Date.now();
    const ranAt = new Date(startedAt);
    const testId = `push-test-${randomUUID()}`;

    const [active, settingsRow, subscriptions, userSettings, policy] =
      await Promise.all([
        this.pushConfig.resolveActiveVapidConfig(),
        this.prisma.systemSettings.findUnique({
          where: { key: PUSH_CONFIG_KEY },
          select: { value: true },
        }),
        this.prisma.pushSubscription.findMany({
          where: { userId },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.userSettings.findUnique({
          where: { userId },
          select: { value: true },
        }),
        this.policy.getPolicy(),
      ]);

    const config = this.diagnoseConfig(active, settingsRow);
    const browser = this.diagnoseBrowser(input, active, subscriptions);
    const events = this.diagnoseEvents(userSettings?.value, policy);

    const payload = JSON.stringify({
      id: testId,
      eventKey: PUSH_TEST_EVENT_KEY,
      title: 'Test push notification',
      body: `If you can see this, Web Push works on this device. Sent at ${ranAt.toISOString()}.`,
      link: PUSH_TEST_LINK,
      test: true,
    });

    const results: PushTestSendResult[] = active
      ? await this.sendAll(active, subscriptions, payload)
      : subscriptions.map(() => ({
          status: 'skipped',
          statusCode: null,
          message: 'Not sent: Web Push is not configured or is disabled.',
          responseBody: null,
          durationMs: 0,
        }));

    const now = new Date();
    const subscriptionResults: PushTestSubscriptionResult[] = subscriptions.map(
      (subscription, index) => {
        const result = results[index];
        const sent = result.status === 'sent';
        return {
          id: subscription.id,
          pushService: endpointHost(subscription.endpoint),
          endpointPreview: endpointPreview(subscription.endpoint),
          isThisBrowser:
            input.endpoint !== undefined && subscription.endpoint === input.endpoint,
          userAgent: subscription.userAgent,
          createdAt: subscription.createdAt.toISOString(),
          // Reflect what the success bookkeeping just wrote, so the page
          // shows post-test truth without a second fetch.
          lastSuccessAt: sent
            ? now.toISOString()
            : (subscription.lastSuccessAt?.toISOString() ?? null),
          failureCount: sent ? 0 : subscription.failureCount,
          result,
        };
      },
    );

    const overall = computeOverall(config.active, subscriptionResults);

    const response: PushTestResponse = {
      ranAt: ranAt.toISOString(),
      durationMs: Date.now() - startedAt,
      overall,
      testId,
      config,
      browser,
      events,
      subscriptions: subscriptionResults,
      hints: [],
    };
    response.hints = buildHints(response);

    const counts = countStatuses(subscriptionResults);
    const hosts = [...new Set(subscriptionResults.map((s) => s.pushService))];

    // One line, counts and hosts only — no endpoint, no key, no payload.
    this.logger.log(
      `Push test ${testId} by user ${userId}: ${overall} ` +
        `(${counts.sent} sent, ${counts.failed} failed, ${counts.pruned} pruned, ` +
        `${counts.skipped} skipped of ${subscriptionResults.length}; ` +
        `hosts: ${hosts.join(', ') || 'none'})`,
    );

    await this.audit(userId, testId, overall, counts, hosts);

    return response;
  }

  // ---------------------------------------------------------------------------
  // 1. Config
  // ---------------------------------------------------------------------------

  private diagnoseConfig(
    active: ActiveVapidConfig | null,
    settingsRow: { value: Prisma.JsonValue } | null,
  ): PushTestConfigDiagnostics {
    const problems: string[] = [];

    // Source mirrors `resolveActiveVapidConfig`'s precedence: ANY `webPush`
    // row makes the admin configuration authoritative (an explicit disable
    // there does not fall back to env), and only its absence consults env.
    let source: PushTestConfigSource;
    let enabled: boolean | null = null;

    if (settingsRow) {
      source = 'admin';
      const parsed = pushConfigSchema.safeParse(settingsRow.value);

      if (!parsed.success) {
        problems.push(
          'The stored Web Push configuration is invalid, so push is off. Re-save it on this page to repair it.',
        );
      } else {
        enabled = parsed.data.enabled;
        if (!parsed.data.enabled) {
          problems.push('Web Push is disabled in the admin configuration.');
        } else if (!parsed.data.publicKey) {
          problems.push(
            'Web Push is enabled but no public key is stored. Generate or rotate the key pair.',
          );
        } else if (!active) {
          problems.push(
            'Web Push is enabled and a public key is stored, but the private-key credential is missing. Rotate the key pair.',
          );
        }
      }
    } else if (active) {
      source = 'env';
    } else {
      source = 'none';
      problems.push(
        'No VAPID key pair is configured: there is no admin configuration and no VAPID_* environment variables.',
      );
    }

    if (!active) {
      return {
        source,
        enabled,
        active: false,
        publicKey: null,
        publicKeyValid: false,
        privateKeyMatchesPublicKey: null,
        subject: null,
        subjectValid: false,
        problems,
      };
    }

    const publicKeyValid = isValidVapidPublicKey(active.publicKey);
    if (!publicKeyValid) {
      problems.push(
        'The active VAPID public key is not a valid uncompressed P-256 key (65 bytes, base64url, starting with 0x04).',
      );
    }

    const privateKeyMatchesPublicKey = privateKeyDerivesPublicKey(
      active.privateKey,
      active.publicKey,
    );
    if (!privateKeyMatchesPublicKey) {
      problems.push(
        'The stored VAPID private key does not match the public key. Every push will be rejected; rotate the key pair.',
      );
    }

    const subjectValid = isValidVapidSubject(active.subject);
    if (!subjectValid) {
      problems.push(
        `The VAPID subject "${active.subject}" is not a mailto:user@host address or an https:// URL. Some push services (notably Apple's) reject it.`,
      );
    } else if (active.subject === DEFAULT_VAPID_SUBJECT) {
      problems.push(
        `No VAPID subject is configured, so the generic fallback "${DEFAULT_VAPID_SUBJECT}" is used. Set a real contact address.`,
      );
    }

    return {
      source,
      enabled,
      active: true,
      publicKey: active.publicKey,
      publicKeyValid,
      privateKeyMatchesPublicKey,
      subject: active.subject,
      subjectValid,
      problems,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Browser
  // ---------------------------------------------------------------------------

  private diagnoseBrowser(
    input: PushTestRequest,
    active: ActiveVapidConfig | null,
    subscriptions: readonly PushSubscription[],
  ): PushTestBrowserDiagnostics {
    const endpointProvided = input.endpoint !== undefined;

    return {
      endpointProvided,
      endpointRegistered: endpointProvided
        ? subscriptions.some((s) => s.endpoint === input.endpoint)
        : null,
      keyMatchesServer:
        input.applicationServerKey !== undefined && active
          ? normalizeBase64Url(input.applicationServerKey) ===
            normalizeBase64Url(active.publicKey)
          : null,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Routing — reuses the dispatcher's own pure functions
  // ---------------------------------------------------------------------------

  /**
   * One row per registry event that declares `push`. `policyChannels` and
   * `isChannelEnabled` are the exact functions `resolveChannels` composes for
   * the dispatcher, so this cannot disagree with what a real `notify()` does.
   */
  private diagnoseEvents(
    settingsValue: Prisma.JsonValue | undefined,
    policy: Awaited<ReturnType<NotificationPolicyService['getPolicy']>>,
  ): PushTestEventDiagnostics[] {
    const preferences = readNotificationPreferences(settingsValue);

    return NOTIFICATION_EVENTS.filter((event) =>
      event.channels.includes('push'),
    ).map((event) => ({
      eventKey: event.key,
      label: event.label,
      mandatory: event.mandatory === true,
      policyAllows: policyChannels(event, policy).includes('push'),
      preferenceAllows: isChannelEnabled(event, 'push', preferences),
    }));
  }

  // ---------------------------------------------------------------------------
  // 4. Delivery
  // ---------------------------------------------------------------------------

  private async sendAll(
    active: ActiveVapidConfig,
    subscriptions: readonly PushSubscription[],
    payload: string,
  ): Promise<PushTestSendResult[]> {
    const vapidDetails = {
      subject: active.subject,
      publicKey: active.publicKey,
      privateKey: active.privateKey,
    };

    // `allSettled`, never `all`: one dead endpoint must not hide the others'
    // results. Each send is wrapped so a synchronous validation throw inside
    // `web-push` (a malformed key, a bad subject) becomes that row's failure
    // rather than a 500 for the whole test.
    const settled = await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        const started = Date.now();
        try {
          const res = await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            payload,
            {
              vapidDetails,
              TTL: TEST_TTL_SECONDS,
              urgency: 'high',
              timeout: SEND_TIMEOUT_MS,
            },
          );
          return { ok: true as const, durationMs: Date.now() - started, res };
        } catch (err) {
          return { ok: false as const, durationMs: Date.now() - started, err };
        }
      }),
    );

    return Promise.all(
      settled.map(async (outcome, index): Promise<PushTestSendResult> => {
        const subscription = subscriptions[index];

        // The inner function never rejects; this branch is belt and braces.
        if (outcome.status === 'rejected') {
          return failedResult(outcome.reason, 0);
        }

        const { value } = outcome;

        if (value.ok) {
          await this.prisma.pushSubscription
            .update({
              where: { id: subscription.id },
              data: { lastSuccessAt: new Date(), failureCount: 0 },
            })
            .catch((err) => {
              this.logger.warn(
                `Push test: could not record success for subscription ${subscription.id}: ${describeThrown(err)}`,
              );
            });

          return {
            status: 'sent',
            statusCode: value.res?.statusCode ?? null,
            message: null,
            responseBody: null,
            durationMs: value.durationMs,
          };
        }

        const err = value.err;

        // 404/410: the endpoint is gone for good — prune, exactly as
        // `PushNotificationChannel` does.
        if (
          err instanceof WebPushError &&
          (err.statusCode === 404 || err.statusCode === 410)
        ) {
          await this.prisma.pushSubscription
            .delete({ where: { id: subscription.id } })
            .catch((deleteErr) => {
              this.logger.warn(
                `Push test: could not prune dead subscription ${subscription.id}: ${describeThrown(deleteErr)}`,
              );
            });

          return { ...failedResult(err, value.durationMs), status: 'pruned' };
        }

        // Anything else: reported, NOT counted toward `failureCount` — see
        // the file header.
        return failedResult(err, value.durationMs);
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  /**
   * Record that an admin ran a test. Counts and hosts only. Best effort: an
   * audit write failing must not turn a completed diagnostic into a 500.
   */
  private async audit(
    userId: string,
    testId: string,
    overall: PushTestOverall,
    counts: Record<PushTestSendResult['status'], number>,
    hosts: string[],
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action: 'push_config:test',
          targetType: 'system_settings',
          targetId: PUSH_CONFIG_KEY,
          meta: { testId, overall, counts, hosts } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Push test ${testId}: could not record the audit event: ${describeThrown(err)}`,
      );
    }
  }
}

// =============================================================================
// Pure helpers (exported for tests)
// =============================================================================

/** Strip base64url padding so padded and unpadded encodings compare equal. */
export function normalizeBase64Url(value: string): string {
  return value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** A VAPID public key is a base64url-encoded, 65-byte uncompressed P-256 point. */
export function isValidVapidPublicKey(publicKey: string): boolean {
  if (!BASE64URL_PATTERN.test(publicKey)) return false;
  const bytes = Buffer.from(normalizeBase64Url(publicKey), 'base64url');
  return bytes.length === UNCOMPRESSED_P256_POINT_LENGTH && bytes[0] === 0x04;
}

/**
 * Does `privateKey` derive `publicKey`? Computes the P-256 public point from
 * the private scalar and compares bytes. `false` for anything malformed —
 * `setPrivateKey` throws on an out-of-range or wrong-length scalar.
 */
export function privateKeyDerivesPublicKey(
  privateKey: string,
  publicKey: string,
): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(normalizeBase64Url(privateKey), 'base64url'));
    const derived = ecdh.getPublicKey();
    const expected = Buffer.from(normalizeBase64Url(publicKey), 'base64url');
    return derived.equals(expected);
  } catch {
    return false;
  }
}

/** `mailto:user@host.tld`, or an `https://` URL with a host. */
export function isValidVapidSubject(subject: string): boolean {
  if (subject.startsWith('mailto:')) {
    return /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject);
  }
  try {
    const url = new URL(subject);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '(invalid endpoint)';
  }
}

function endpointPreview(endpoint: string): string {
  return `${endpointHost(endpoint)}/…${endpoint.slice(-ENDPOINT_PREVIEW_TAIL)}`;
}

function failedResult(err: unknown, durationMs: number): PushTestSendResult {
  const isPushError = err instanceof WebPushError;
  return {
    status: 'failed',
    statusCode: isPushError ? err.statusCode : null,
    message: describeThrown(err),
    responseBody:
      isPushError && typeof err.body === 'string' && err.body.length > 0
        ? err.body.slice(0, MAX_RESPONSE_BODY_LENGTH)
        : null,
    durationMs,
  };
}

function countStatuses(
  subscriptions: readonly PushTestSubscriptionResult[],
): Record<PushTestSendResult['status'], number> {
  const counts = { sent: 0, failed: 0, pruned: 0, skipped: 0 };
  for (const s of subscriptions) counts[s.result.status]++;
  return counts;
}

function computeOverall(
  active: boolean,
  subscriptions: readonly PushTestSubscriptionResult[],
): PushTestOverall {
  if (!active) return 'not_configured';
  if (subscriptions.length === 0) return 'no_subscriptions';
  const sent = subscriptions.filter((s) => s.result.status === 'sent').length;
  if (sent === subscriptions.length) return 'sent';
  if (sent > 0) return 'partial';
  return 'failed';
}

/**
 * Plain-English next steps. Ordered roughly by where in the chain the break
 * is (config → browser → delivery → routing), de-duplicated.
 */
export function buildHints(result: PushTestResponse): string[] {
  const hints: string[] = [];
  const add = (hint: string) => {
    if (!hints.includes(hint)) hints.push(hint);
  };
  const { config, browser, subscriptions, events } = result;

  // --- Config ----------------------------------------------------------------
  if (!config.active) {
    if (config.source === 'none') {
      add('Web Push is not configured. Use "Generate & enable" on this page to create a VAPID key pair.');
    } else if (config.source === 'admin' && config.enabled === false) {
      add('Web Push is switched off. Enable it on this page, then run the test again.');
    } else {
      add('Web Push is enabled but its key pair is incomplete or unreadable. Rotate the key pair to repair it, then reload the app so browsers re-subscribe.');
    }
  } else {
    if (!config.publicKeyValid || config.privateKeyMatchesPublicKey === false) {
      add('The VAPID key pair is broken (the public key is malformed or does not match the private key). Rotate the key pair, then reload the app on each device so it re-subscribes.');
    }
    if (!config.subjectValid) {
      add('Set the VAPID subject to a real mailto: address (e.g. mailto:ops@yourdomain.com) or an https:// URL. Apple\'s push service rejects invalid subjects with 403 BadJwtToken.');
    } else if (config.subject === DEFAULT_VAPID_SUBJECT) {
      add('Set a real VAPID subject (your contact mailto: address). The generic fallback works with most push services but can be rejected.');
    }
    if (config.source === 'env') {
      add('The keys come from VAPID_* environment variables. Generating keys on this page will take over from them.');
    }
  }

  // --- Browser ---------------------------------------------------------------
  if (!browser.endpointProvided) {
    add('This browser did not report a push subscription. Allow notifications for this site in the browser, then reload the page so it subscribes.');
  } else if (browser.endpointRegistered === false) {
    add('No subscription for this browser is registered on the server. Grant notification permission and reload the page so it re-subscribes.');
  }
  if (browser.keyMatchesServer === false) {
    add('This browser\'s subscription was created with a different VAPID key, so the push service will reject pushes to it. Reload the page so it re-subscribes with the current key.');
  }

  // --- Delivery --------------------------------------------------------------
  if (result.overall === 'no_subscriptions') {
    add('You have no push subscriptions. Open the app in a browser, allow notifications, and reload, then run the test again.');
  }

  for (const sub of subscriptions) {
    const { status, statusCode } = sub.result;
    const where = `${sub.pushService}${sub.isThisBrowser ? ' (this browser)' : ''}`;

    if (status === 'pruned') {
      add(`The subscription at ${where} has expired or been revoked (HTTP ${statusCode}) and was removed. Reload the app on that device to re-subscribe.`);
      continue;
    }
    if (status !== 'failed') continue;

    if (statusCode === 403) {
      add(`403 from ${where}: this usually means the VAPID key pair does not match the one the subscription was created with (keys were rotated or changed). Reload the app on that device so it re-subscribes.`);
      if (sub.pushService.endsWith('push.apple.com')) {
        add('Apple\'s push service also returns 403 (BadJwtToken) when the VAPID subject is not a real mailto: or https:// contact.');
      }
    } else if (statusCode === 401) {
      add(`401 from ${where}: the push service rejected the VAPID signature. Check the subject and that the key pair is valid.`);
    } else if (statusCode === 400) {
      add(`400 from ${where}: the push service rejected the request as malformed. Check the response body; re-subscribing the device often fixes a corrupted subscription.`);
    } else if (statusCode === 413) {
      add(`413 from ${where}: the payload is too large for the push service.`);
    } else if (statusCode === 429) {
      add(`429 from ${where}: the push service is rate-limiting this server. Wait a few minutes before testing again.`);
    } else if (statusCode !== null && statusCode >= 500) {
      add(`${statusCode} from ${where}: the push service had an error. This is usually temporary; try again shortly.`);
    } else if (statusCode === null) {
      add(`Could not reach ${where} (${sub.result.message ?? 'network error'}). Check that this server can make outbound HTTPS requests to the push service (firewall, proxy, DNS).`);
    } else {
      add(`${where} answered HTTP ${statusCode}. See the response body for the push service's explanation.`);
    }
  }

  if (subscriptions.some((s) => s.result.status === 'sent')) {
    add('The push service accepted the test. If no notification appeared, check the OS notification settings and Focus/Do Not Disturb, the site\'s notification permission in the browser, and that the app\'s service worker is installed.');
  }

  // --- Routing ---------------------------------------------------------------
  for (const event of events) {
    if (!event.policyAllows) {
      add(`Push is turned off for "${event.label}" by the deployment's notification policy.`);
    }
    if (!event.preferenceAllows) {
      add(`You have turned off push for "${event.label}" in your notification preferences, so real ones will not reach you by push even though this test can.`);
    }
  }

  return hints;
}
