import { z } from 'zod';

// =============================================================================
// Web Push (VAPID) configuration — shape and validation (issue #355)
// =============================================================================
//
// The admin-configurable half of Web Push delivery: whether it is on, the
// public half of the VAPID key pair (safe to hand to every subscribing
// browser), and the contact subject `web-push` puts in the VAPID JWT.
// Everything here is ORDINARY CONFIGURATION and is safe to return from an
// admin endpoint.
//
// THE VAPID PRIVATE KEY IS NOT HERE, AND MUST NEVER BE ADDED. It lives in the
// encrypted credential store (#115, epic #108) at
// `(purpose 'push_vapid', name 'default')` — see
// `push-vapid-credential.constants.ts`. The reason is mechanical, matching
// `../email/email-settings.schema.ts` exactly: this object is persisted as a
// settings blob and returned wholesale by the admin GET, so a secret in it is
// one careless response away from exposure. There is a compile-time proof of
// the absence at the bottom of this file.
//
// Zod, not class-validator, matching every other settings schema in this
// codebase; the DTOs in `dto/` derive from this schema rather than restate it.
// =============================================================================

/**
 * The generic fallback subject used when nothing more specific is configured
 * (no `webPush.subject`, no `VAPID_SUBJECT` env var).
 *
 * `web-push`'s own README uses a generic `mailto:` as its example, and its
 * only real effect is what a push SERVICE operator sees if this deployment's
 * traffic looks abusive — never something a subscriber notices. Centralised
 * here so `PushConfigService.resolveActiveVapidConfig()` is the one place
 * that applies it, rather than every caller inventing its own default.
 */
export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@example.com';

/**
 * A VAPID subject: a `mailto:` address or an `http(s)://` URL.
 *
 * `web-push` REJECTS anything else at send time (`validateSubject` throws
 * "Vapid subject is not a URL or mailto address"), so validating the shape
 * here turns that failure into a 400 on the settings form instead of a
 * delivery-time error discovered hours later in a failed
 * `notification_deliveries` row.
 */
export const vapidSubjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value.startsWith('mailto:') ||
      value.startsWith('https://') ||
      value.startsWith('http://'),
    {
      message:
        'VAPID subject must be a mailto: address or an http(s):// URL',
    },
  );

export const pushConfigSchema = z.object({
  /**
   * Master switch. Nothing is pushed while this is false, REGARDLESS of
   * whether keys are stored — see `PushConfigService.resolveActiveVapidConfig`
   * for the full precedence, including why `false` here deliberately does NOT
   * fall back to an env-var VAPID pair.
   */
  enabled: z.boolean(),

  /**
   * The VAPID PUBLIC key. `null` means "no key pair generated yet", the state
   * of every fresh installation and of a deployment that has never touched
   * this admin surface.
   *
   * NOT SECRET: it is handed to every browser that calls
   * `pushManager.subscribe`, which is why it lives here in full rather than in
   * the credential store alongside the private half.
   */
  publicKey: z.string().min(1).nullable(),

  /**
   * Contact subject for the VAPID JWT. `null` means "use the generic
   * fallback" — see {@link DEFAULT_VAPID_SUBJECT} — which is a real,
   * persisted state, not an error.
   */
  subject: vapidSubjectSchema.nullable(),
});

/** Validated Web Push settings. */
export type PushConfig = z.infer<typeof pushConfigSchema>;

/**
 * What a system with no Web Push configuration looks like.
 *
 * Not `{}`: `enabled` and `publicKey` are required by the schema, so the
 * "nothing configured yet" state is spelled out rather than being an invalid
 * object that only survives because nobody validates it.
 */
export const DEFAULT_PUSH_CONFIG: PushConfig = {
  enabled: false,
  publicKey: null,
  subject: null,
};

// -----------------------------------------------------------------------------
// Compile-time proof that no secret-bearing field crept in
// -----------------------------------------------------------------------------
//
// Mirrors the technique in `../email/email-settings.schema.ts`. Adding
// `privateKey` (or any of the other names below) to the schema above makes
// `PushConfigCarriesNoSecret` resolve to `never`, and this file stops
// compiling — a build break at the moment of the mistake, rather than a
// security review that has to notice a new optional string.
//
// If you are here because this line went red: you are trying to put a secret
// into a settings blob. Use `CredentialsService` instead, at
// `(purpose 'push_vapid', name 'default')`.

type SecretFieldNames =
  | 'privateKey'
  | 'vapidPrivateKey'
  | 'secret'
  | 'password'
  | 'apiKey';

export type PushConfigCarriesNoSecret =
  Extract<keyof PushConfig, SecretFieldNames> extends never ? true : never;

export const PUSH_CONFIG_CARRIES_NO_SECRET: PushConfigCarriesNoSecret = true;
