import { z } from 'zod';

// =============================================================================
// Email settings — shape and validation (issue #122, epic #109)
// =============================================================================
//
// The admin-configurable half of email delivery: which transport, where it
// lives, who the mail claims to be from. Everything here is ORDINARY
// CONFIGURATION and is safe to return from an admin endpoint (#124).
//
// THE SMTP PASSWORD IS NOT HERE, AND MUST NEVER BE ADDED. It lives in the
// encrypted credential store (#115, epic #108) at
// `(purpose 'smtp', name 'default')` — see smtp-email.provider.ts. The reason
// is mechanical, not stylistic: this object is persisted as a settings blob
// and returned wholesale by the settings endpoints, so a secret in it is one
// careless response away from exposure, and "blank preserves" on an admin form
// would have to be reimplemented here (badly) instead of being inherited from
// CredentialsService, which already enforces it. There is a compile-time proof
// of the absence at the bottom of this file.
//
// Zod, not class-validator, matching the settings schemas in
// `common/schemas/settings.schema.ts`; the DTOs #124 adds should derive from
// this schema rather than restate it.
// =============================================================================

/**
 * Transports this app can send with.
 *
 * Derived type below rather than a hand-written union, so adding one widens
 * every `switch` in the same edit instead of silently falling through.
 */
export const EMAIL_PROVIDER_KINDS = ['ses', 'smtp'] as const;

/** A configured transport. See {@link EMAIL_PROVIDER_KINDS}. */
export type EmailProviderKind = (typeof EMAIL_PROVIDER_KINDS)[number];

/** Default SMTP submission port when the admin has not chosen one (RFC 6409). */
export const DEFAULT_SMTP_PORT = 587;

/** The port on which SMTP speaks TLS from the first byte, rather than STARTTLS. */
export const IMPLICIT_TLS_SMTP_PORT = 465;

export const emailSettingsSchema = z.object({
  /**
   * Which transport to use. `null` means "no transport chosen", which is the
   * state of every fresh installation.
   *
   * NULLABLE RATHER THAN OPTIONAL: "the admin has not picked one" is a real,
   * persisted state that the settings page renders, not an absent key whose
   * meaning has to be guessed. `enabled` is a separate axis so an admin can
   * switch mail off for a maintenance window without losing the configuration
   * they would otherwise have to retype.
   */
  provider: z.enum(EMAIL_PROVIDER_KINDS).nullable(),

  /** Master switch. Nothing is sent while this is false. */
  enabled: z.boolean(),

  /**
   * SES region override.
   *
   * Absent means "use `S3_REGION` from the environment" — see
   * ses-email.provider.ts. It exists because the mail region and the bucket
   * region genuinely differ in practice: SES is not available in every region,
   * and a verified sending identity is regional.
   */
  sesRegion: z.string().trim().min(1).optional(),

  smtpHost: z.string().trim().min(1).optional(),

  /**
   * Port bounds are validated here because the alternative is nodemailer
   * failing with a socket-level error that tells an admin nothing about which
   * field they mistyped.
   */
  smtpPort: z.number().int().min(1).max(65535).optional(),

  /**
   * Require TLS. Absent is treated as `true` by the provider — a mail
   * credential must not cross the network in the clear because a checkbox was
   * missing from a stored blob.
   */
  smtpUseTls: z.boolean().optional(),

  /**
   * SMTP username. Absent means unauthenticated submission, which is a real
   * configuration for an internal relay that authorises by source IP.
   */
  smtpUsername: z.string().trim().min(1).optional(),

  /**
   * Envelope/header sender. Validated as an address here so the failure is
   * "that is not an email address" on the settings form rather than an SES
   * rejection at send time, hours later, in a delivery record.
   *
   * The providers do NOT apply this — #123/#125 build the `from` on the
   * message. It is stored here because it is configuration, and read there.
   */
  fromAddress: z.email().optional(),

  /** Display name paired with `fromAddress`, e.g. `Acme <no-reply@acme.com>`. */
  fromName: z.string().trim().min(1).max(100).optional(),
});

/** Validated email settings. */
export type EmailSettings = z.infer<typeof emailSettingsSchema>;

/**
 * What a system with no email configuration looks like.
 *
 * Not `{}`: `provider` and `enabled` are required by the schema, so the
 * "nothing configured yet" state is spelled out rather than being an invalid
 * object that only survives because nobody validates it.
 */
export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  provider: null,
  enabled: false,
};

// -----------------------------------------------------------------------------
// Compile-time proof that no secret-bearing field crept in
// -----------------------------------------------------------------------------
//
// Mirrors the technique in credentials/interfaces/credential-info.interface.ts.
// Adding `smtpPassword` (or any of the other names below) to the schema above
// makes `EmailSettingsCarriesNoSecret` resolve to `never`, and this file stops
// compiling — a build break at the moment of the mistake, rather than a
// security review that has to notice a new optional string.
//
// If you are here because this line went red: you are trying to put a secret
// into a settings blob. Use CredentialsService instead.

type SecretFieldNames =
  | 'smtpPassword'
  | 'password'
  | 'secret'
  | 'apiKey'
  | 'accessKeyId'
  | 'secretAccessKey';

export type EmailSettingsCarriesNoSecret =
  Extract<keyof EmailSettings, SecretFieldNames> extends never ? true : never;

export const EMAIL_SETTINGS_CARRIES_NO_SECRET: EmailSettingsCarriesNoSecret =
  true;
