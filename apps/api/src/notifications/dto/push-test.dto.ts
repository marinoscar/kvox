import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// POST /api/admin/push-config/test — request and response (issue #449)
// =============================================================================
//
// "Push doesn't work" is five different failures wearing one symptom: no key
// pair is active, the key pair is internally inconsistent, this browser
// subscribed against a DIFFERENT public key, the push service refused the
// signed request, or the push service accepted it and the device/OS never
// showed it. The admin page cannot tell those apart from the outside, so this
// endpoint sends a real test push to the CALLER'S OWN subscriptions and
// returns, link by link, what it found. See `PushTestService` for the checks.
//
// -----------------------------------------------------------------------------
// WHAT IS NOT HERE — AND MUST NEVER BE
// -----------------------------------------------------------------------------
//
// The VAPID private key (not even a hint), a subscription's `p256dh`/`auth`,
// and a subscription's full `endpoint` (an endpoint is a bearer capability to
// push to that device; only `endpointPreview` — host plus the last 8 chars —
// is returned). A compile-time proof at the bottom of this file refuses a
// secret-named field anywhere in the response's top-level or nested shapes.
// =============================================================================

// -----------------------------------------------------------------------------
// Request
// -----------------------------------------------------------------------------

/**
 * Base64url alphabet, optionally padded. The browser's
 * `subscription.options.applicationServerKey` is an ArrayBuffer the client
 * encodes; some encoders pad, some do not, so `=` padding is accepted here
 * and normalised away before comparison.
 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

export const pushTestRequestSchema = z
  .object({
    /**
     * THIS browser's current `PushSubscription.endpoint`, if it has one.
     * Used only to mark which listed subscription is "this browser" and to
     * report whether it is registered server-side. Never echoed back in full.
     */
    endpoint: z.url().max(2048).optional(),

    /**
     * The `applicationServerKey` THIS browser's subscription was created
     * with, base64url-encoded. Compared against the ACTIVE VAPID public key:
     * a mismatch is the classic "keys were rotated, the browser never
     * re-subscribed" failure, which the push service reports as a 403.
     */
    applicationServerKey: z
      .string()
      .max(200)
      .regex(BASE64URL_PATTERN, 'applicationServerKey must be base64url-encoded')
      .optional(),
  })
  .strict();

export type PushTestRequest = z.infer<typeof pushTestRequestSchema>;

export class PushTestRequestDto extends createZodDto(pushTestRequestSchema) {}

// -----------------------------------------------------------------------------
// Response
// -----------------------------------------------------------------------------

export const PUSH_TEST_OVERALL = [
  'sent',
  'partial',
  'failed',
  'not_configured',
  'no_subscriptions',
] as const;

export type PushTestOverall = (typeof PUSH_TEST_OVERALL)[number];

export const PUSH_TEST_CONFIG_SOURCES = ['admin', 'env', 'none'] as const;

export type PushTestConfigSource = (typeof PUSH_TEST_CONFIG_SOURCES)[number];

export const PUSH_TEST_SEND_STATUSES = [
  'sent',
  'failed',
  'pruned',
  'skipped',
] as const;

export type PushTestSendStatus = (typeof PUSH_TEST_SEND_STATUSES)[number];

export const pushTestConfigDiagnosticsSchema = z.object({
  /**
   * Where the configuration comes from. `admin` = a `webPush`
   * `system_settings` row exists (it wins, even over env vars, and an
   * explicit disable there does NOT fall back to env); `env` = no row, the
   * deploy-time `VAPID_*` env vars are active; `none` = neither.
   */
  source: z.enum(PUSH_TEST_CONFIG_SOURCES),

  /** The admin row's `enabled` flag. `null` for `env`/`none` (or an unreadable row). */
  enabled: z.boolean().nullable(),

  /** A usable key pair is active right now (`resolveActiveVapidConfig() !== null`). */
  active: z.boolean(),

  /** The ACTIVE public key. Not secret. `null` when nothing is active. */
  publicKey: z.string().nullable(),

  /** `publicKey` base64url-decodes to a 65-byte uncompressed P-256 point (leading `0x04`). */
  publicKeyValid: z.boolean(),

  /**
   * The public key derived from the stored private key equals `publicKey`.
   * `null` when nothing is active. The private key itself is never returned.
   */
  privateKeyMatchesPublicKey: z.boolean().nullable(),

  /** The subject the VAPID JWT is signed with (fallback applied). */
  subject: z.string().nullable(),

  /** `subject` is `mailto:user@host.tld` or an `https://` URL. */
  subjectValid: z.boolean(),

  /** Human-readable problems found in the checks above. Empty when all is well. */
  problems: z.array(z.string()),
});

export type PushTestConfigDiagnostics = z.infer<
  typeof pushTestConfigDiagnosticsSchema
>;

export const pushTestBrowserDiagnosticsSchema = z.object({
  /** The request carried this browser's `endpoint`. */
  endpointProvided: z.boolean(),

  /**
   * The provided endpoint is one of the caller's `push_subscriptions` rows.
   * `null` when no endpoint was provided.
   */
  endpointRegistered: z.boolean().nullable(),

  /**
   * The provided `applicationServerKey` equals the active public key (padding
   * normalised). `null` when either side is missing.
   */
  keyMatchesServer: z.boolean().nullable(),
});

export type PushTestBrowserDiagnostics = z.infer<
  typeof pushTestBrowserDiagnosticsSchema
>;

export const pushTestEventDiagnosticsSchema = z.object({
  eventKey: z.string(),
  label: z.string(),
  mandatory: z.boolean(),
  /** The deployment-wide admin policy keeps the `push` channel for this event. */
  policyAllows: z.boolean(),
  /** The caller's stored preferences keep `push` for this event (mandatory => true). */
  preferenceAllows: z.boolean(),
});

export type PushTestEventDiagnostics = z.infer<
  typeof pushTestEventDiagnosticsSchema
>;

export const pushTestSendResultSchema = z.object({
  status: z.enum(PUSH_TEST_SEND_STATUSES),
  /** The push service's HTTP status, when one was received. */
  statusCode: z.number().int().nullable(),
  /** The error message, when the send failed. Never carries key material. */
  message: z.string().nullable(),
  /** The push service's response body on failure, truncated to 500 chars. */
  responseBody: z.string().nullable(),
  durationMs: z.number(),
});

export type PushTestSendResult = z.infer<typeof pushTestSendResultSchema>;

export const pushTestSubscriptionResultSchema = z.object({
  id: z.string(),
  /** The endpoint's hostname, e.g. `fcm.googleapis.com`. */
  pushService: z.string(),
  /** `${host}/…${last 8 chars}` — never the full endpoint. */
  endpointPreview: z.string(),
  /** This row's endpoint equals the endpoint the request carried. */
  isThisBrowser: z.boolean(),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSuccessAt: z.iso.datetime().nullable(),
  failureCount: z.number().int(),
  result: pushTestSendResultSchema,
});

export type PushTestSubscriptionResult = z.infer<
  typeof pushTestSubscriptionResultSchema
>;

export const pushTestResponseSchema = z.object({
  ranAt: z.iso.datetime(),
  durationMs: z.number(),
  overall: z.enum(PUSH_TEST_OVERALL),
  /** `push-test-<uuid>`; also the `id` in the pushed payload. */
  testId: z.string(),
  config: pushTestConfigDiagnosticsSchema,
  browser: pushTestBrowserDiagnosticsSchema,
  events: z.array(pushTestEventDiagnosticsSchema),
  subscriptions: z.array(pushTestSubscriptionResultSchema),
  /** Actionable plain-English suggestions derived from everything above. */
  hints: z.array(z.string()),
});

/** The response body, as sent (inside the global `{ data }` envelope). */
export type PushTestResponse = z.infer<typeof pushTestResponseSchema>;

export class PushTestResponseDto extends createZodDto(pushTestResponseSchema) {}

// -----------------------------------------------------------------------------
// Compile-time proof that no response shape grew a secret-bearing field
// -----------------------------------------------------------------------------
//
// Same technique as `push-config-response.dto.ts`, extended to the nested
// shapes, because the nested ones (`config`, `subscriptions[]`) are exactly
// where "just include the private key / the subscription keys for debugging"
// would land. If this went red, the field you are adding is the bug.

type SecretFieldNames =
  | 'privateKey'
  | 'vapidPrivateKey'
  | 'secret'
  | 'password'
  | 'apiKey'
  | 'ciphertext'
  | 'p256dh'
  | 'auth'
  | 'keys'
  | 'endpoint';

type NoSecretIn<T> = Extract<keyof T, SecretFieldNames> extends never ? true : never;

export type PushTestResponseCarriesNoSecret = NoSecretIn<PushTestResponse> &
  NoSecretIn<PushTestConfigDiagnostics> &
  NoSecretIn<PushTestBrowserDiagnostics> &
  NoSecretIn<PushTestSubscriptionResult> &
  NoSecretIn<PushTestSendResult>;

export const PUSH_TEST_RESPONSE_CARRIES_NO_SECRET: PushTestResponseCarriesNoSecret =
  true;
