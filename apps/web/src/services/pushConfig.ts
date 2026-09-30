/**
 * The runtime-configurable Web Push (VAPID) admin API, as the web app sees it.
 *
 * Issue #355 — see `docs/specs/browser-notifications.md` and the parallel
 * backend work in `apps/api/src/notifications/push-config.*`. Shaped after
 * `services/dbBackup.ts`: `services/api.ts` stays the transport (the
 * `ApiService` instance, the refresh dance, the maintenance recogniser), and
 * this module holds the five `/admin/push-config` calls next to the types
 * they produce.
 *
 * =============================================================================
 * THE PRIVATE KEY IS NEVER ON THE WIRE, IN EITHER DIRECTION
 * =============================================================================
 *
 * No endpoint below ever returns plaintext key material — only
 * `PrivateKeyStatus`, a masked hint mirroring `SmtpPasswordStatus`
 * (`types/index.ts`). Nothing in this module, or in any component built on
 * it, should ever grow a field that could hold the real private key.
 *
 * =============================================================================
 * TWO CONFIRMATION LITERALS, DELIBERATELY DIFFERENT WORDS
 * =============================================================================
 *
 * `ROTATE` and `REMOVE` are Zod literals on the API's DTOs, exactly like
 * `RESTORE`/`ROLLBACK` in `services/dbBackup.ts` — two different words so a
 * confirmation typed for one destructive action can never accidentally
 * satisfy the other. The dialog compares what an admin typed against these
 * constants rather than a string re-typed a second time in a component.
 */

import { api } from './api';

/**
 * What the UI may know about the stored private key. Mirrors
 * `SmtpPasswordStatus` field for field: never the plaintext, only enough to
 * say WHICH key is live and when it was last set.
 */
export interface PrivateKeyStatus {
  /** Is a private key stored at all? */
  configured: boolean;
  /** A masked hint (e.g. `"••••ab12"`), or `null` when nothing is stored. NEVER the real key. */
  hint: string | null;
  /** When the stored key was last written. `null` when nothing is stored. */
  updatedAt: string | null;
  /** Who last wrote it. `null` when nothing is stored, or that user was deleted. */
  updatedByUserId: string | null;
}

/**
 * `GET /api/admin/push-config`, and the body every write below returns.
 *
 * `publicKey` is the ONE piece of key material this view carries in full —
 * it is not secret, and an admin needs to be able to read and copy it (it is
 * what a client-side `pushManager.subscribe` call is given). The private key
 * never appears here or anywhere else; see {@link PrivateKeyStatus}.
 */
export interface PushConfigAdminView {
  enabled: boolean;
  configured: boolean;
  publicKey: string | null;
  subject: string | null;
  privateKeyStatus: PrivateKeyStatus;
  /**
   * Set when the stored row could not be read — mirrors
   * `EmailSettings.settingsError`. When present, the fields above are
   * defaults, not this deployment's real configuration.
   */
  settingsError?: string | null;
  /** Bumped on every write. Pass back as `If-Match` on the next `PUT`. */
  version: number;
  updatedAt: string | null;
  /**
   * Who last wrote the settings row — an object, NOT a string (issue #449:
   * the page used to interpolate it and print `[object Object]`). `null` when
   * nobody has, or that user was deleted.
   */
  updatedBy?: PushConfigUpdatedBy | null;
}

/** The user who last wrote the push settings row. */
export interface PushConfigUpdatedBy {
  id: string;
  email: string;
}

/** `PUT /api/admin/push-config` — non-destructive; keys are retained either way. */
export interface UpdatePushConfigInput {
  enabled: boolean;
  subject: string | null;
}

/** `POST /api/admin/push-config/generate` and `/rotate` both take an optional subject. */
export interface PushConfigSubjectInput {
  subject?: string | null;
}

/** The exact strings the API's Zod literals require. Two different words, deliberately. */
export const ROTATE_CONFIRMATION = 'ROTATE';
export const REMOVE_CONFIRMATION = 'REMOVE';

const BASE = '/admin/push-config';

/** `GET` — `push:read`. */
export async function getPushConfig(): Promise<PushConfigAdminView> {
  return api.get<PushConfigAdminView>(BASE);
}

/**
 * `PUT` — `push:write`. Full replacement of `{ enabled, subject }`, with
 * `If-Match` for optimistic concurrency, copied from `updateEmailSettings`
 * in `services/api.ts`. `409` on a version conflict, or when `enabled: true`
 * is requested with nothing configured yet.
 *
 * `expectedVersion` is passed through as-is, including `0` — the check on
 * the header is `undefined`, never a truthiness test, so the very first save
 * on a fresh deployment is still guarded.
 */
export async function updatePushConfig(
  input: UpdatePushConfigInput,
  expectedVersion?: number,
): Promise<PushConfigAdminView> {
  return api.put<PushConfigAdminView>(BASE, input, {
    headers: expectedVersion === undefined ? undefined : { 'If-Match': String(expectedVersion) },
  });
}

/**
 * `POST /generate` — `push:write`. First-time setup only: `409` if a key
 * pair is already configured.
 */
export async function generatePushConfig(
  input: PushConfigSubjectInput = {},
): Promise<PushConfigAdminView> {
  return api.post<PushConfigAdminView>(`${BASE}/generate`, input);
}

/**
 * `POST /rotate` — `push:write`, DESTRUCTIVE. Every existing push
 * subscriber goes dark until their client re-subscribes; see the confirm
 * dialog for the full consequence. The confirmation literal comes from the
 * constant above rather than being typed here a second time.
 */
export async function rotatePushConfig(
  input: PushConfigSubjectInput = {},
): Promise<PushConfigAdminView> {
  return api.post<PushConfigAdminView>(`${BASE}/rotate`, {
    confirmation: ROTATE_CONFIRMATION,
    ...input,
  });
}

/**
 * `DELETE` — `push:write`, DESTRUCTIVE. Deletes both the credential and the
 * settings row; the public key disappears entirely, so this is strictly
 * worse for existing subscribers than a rotation.
 */
export async function removePushConfig(): Promise<PushConfigAdminView> {
  return api.delete<PushConfigAdminView>(BASE, {
    body: JSON.stringify({ confirmation: REMOVE_CONFIRMATION }),
  });
}

// =============================================================================
// Test & diagnostics — issue #449
// =============================================================================

/** `POST /admin/push-config/test` body. Both fields optional. */
export interface PushTestInput {
  /** This browser's subscription endpoint, so the server can flag "this browser". */
  endpoint?: string;
  /** base64url (no padding) of the subscription's `options.applicationServerKey`. */
  applicationServerKey?: string;
}

export type PushTestOverall = 'sent' | 'partial' | 'failed' | 'not_configured' | 'no_subscriptions';

export type PushTestSubscriptionStatus = 'sent' | 'failed' | 'pruned' | 'skipped';

export interface PushTestConfigCheck {
  source: 'admin' | 'env' | 'none';
  enabled: boolean | null;
  active: boolean;
  publicKey: string | null;
  publicKeyValid: boolean;
  privateKeyMatchesPublicKey: boolean | null;
  subject: string | null;
  subjectValid: boolean;
  problems: string[];
}

export interface PushTestBrowserCheck {
  endpointProvided: boolean;
  endpointRegistered: boolean | null;
  keyMatchesServer: boolean | null;
}

export interface PushTestEventCheck {
  eventKey: string;
  label: string;
  mandatory: boolean;
  policyAllows: boolean;
  preferenceAllows: boolean;
}

export interface PushTestSubscriptionResult {
  id: string;
  pushService: string;
  endpointPreview: string;
  isThisBrowser: boolean;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
  result: {
    status: PushTestSubscriptionStatus;
    statusCode: number | null;
    message: string | null;
    responseBody: string | null;
    durationMs: number;
  };
}

/** `POST /admin/push-config/test` response. */
export interface PushTestResult {
  ranAt: string;
  durationMs: number;
  overall: PushTestOverall;
  /** `push-test-<uuid>` — also the `id` of the push payload the worker receives. */
  testId: string;
  config: PushTestConfigCheck;
  browser: PushTestBrowserCheck;
  events: PushTestEventCheck[];
  subscriptions: PushTestSubscriptionResult[];
  hints: string[];
}

/**
 * `POST /test` — `push:write`. Sends a test push to every subscription the
 * CALLER holds and reports, per subscription, what the push service said.
 */
export async function sendPushTest(input: PushTestInput = {}): Promise<PushTestResult> {
  return api.post<PushTestResult>(`${BASE}/test`, input);
}
