import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { pushConfigSchema } from '../push-config.schema';

// =============================================================================
// GET/PUT/POST(generate|rotate) /api/admin/push-config — response body
// (issue #355)
// =============================================================================
//
// The settings themselves, plus three things the admin page cannot work
// without and cannot derive — mirrors
// `../../email/dto/email-settings-response.dto.ts` one-for-one:
//
//   1. `configured` — a convenience flag: are BOTH halves of the key pair
//      actually present (`publicKey` here AND a stored private-key
//      credential)? A page can render "empty state" vs. "configured state"
//      off this one boolean instead of reasoning about two fields.
//
//   2. `privateKeyStatus` — IS a private key stored, and roughly which one.
//      Built from `CredentialsService.describe`, whose return type carries a
//      compile-time proof it cannot hold secret material, and whose query
//      does not select the ciphertext column — so for this request the
//      encrypted bytes never leave Postgres.
//
//   3. `version` / `updatedAt` / `updatedBy` — provenance and the optimistic-
//      concurrency token, matching `EmailSettingsResponseDto`.
//
//   4. `settingsError` — a stored-but-invalid configuration must not make the
//      page that repairs it un-renderable. See `PushConfigService`.
//
// -----------------------------------------------------------------------------
// WHAT IS NOT HERE
// -----------------------------------------------------------------------------
//
// The VAPID PRIVATE key, in any shape: not the plaintext, not the ciphertext,
// not a masked copy of the real bytes. `privateKeyStatus` is built from
// `CredentialsService.describe`, and there is a compile-time proof at the
// bottom of this file, mirroring the one in `email-settings-response.dto.ts`.
// =============================================================================

/**
 * What the admin page needs to know about the stored VAPID private key
 * without being told the key. Mirrors `SmtpPasswordStatus`.
 */
export const privateKeyStatusSchema = z.object({
  /** Is a private key stored at `(purpose 'push_vapid', name 'default')`? */
  configured: z.boolean(),

  /**
   * The store's non-secret mask, e.g. `••••x9fQ`. Null when nothing is
   * stored, and also null for a row written outside `CredentialsService`.
   */
  hint: z.string().nullable(),

  /** When the stored private key was last written. Null when nothing is stored. */
  updatedAt: z.iso.datetime().nullable(),

  /** Who last wrote it. Null when nothing is stored, or the user was deleted. */
  updatedByUserId: z.uuid().nullable(),
});

export const pushConfigResponseSchema = pushConfigSchema.extend({
  /**
   * Both halves of the key pair are present: `publicKey` is non-null AND a
   * private-key credential is stored. A page renders its "generate" empty
   * state exactly when this is `false`.
   */
  configured: z.boolean(),

  privateKeyStatus: privateKeyStatusSchema,

  /**
   * Why the stored configuration could not be read, when it could not be.
   * Null on the normal path. Contains FIELD PATHS ONLY, never stored values —
   * mirrors `EmailSettingsResponse.settingsError` exactly.
   */
  settingsError: z.string().nullable(),

  /** Bumped on every write; pass back as `If-Match` on `PUT`. */
  version: z.number().int(),

  updatedAt: z.iso.datetime().nullable(),

  updatedBy: z
    .object({
      id: z.uuid(),
      email: z.email(),
    })
    .nullable(),
});

/** The response body, as sent (inside the global `{ data }` envelope). */
export type PushConfigResponse = z.infer<typeof pushConfigResponseSchema>;

export class PushConfigResponseDto extends createZodDto(
  pushConfigResponseSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that the response grew no secret-bearing field
// -----------------------------------------------------------------------------
//
// The same technique as `email-settings-response.dto.ts`. `pushConfigSchema`
// proves the PERSISTED shape carries no secret; this proves the RESPONSE
// shape does not either — a separate claim, because this schema `.extend()`s
// that one and an extension is exactly where a convenience field ("just send
// the private key back so it can be copied elsewhere") would land.
//
// `privateKeyStatus` deliberately does not match: it is a status object built
// from `CredentialInfo`, which has its own proof that it cannot hold a
// secret. If you are here because this line went red, the field you are
// adding is the bug — the value it wants is unreadable by design.

type SecretFieldNames =
  | 'privateKey'
  | 'vapidPrivateKey'
  | 'secret'
  | 'password'
  | 'apiKey'
  | 'ciphertext';

export type PushConfigResponseCarriesNoSecret =
  Extract<keyof PushConfigResponse, SecretFieldNames> extends never
    ? true
    : never;

export const PUSH_CONFIG_RESPONSE_CARRIES_NO_SECRET: PushConfigResponseCarriesNoSecret =
  true;
