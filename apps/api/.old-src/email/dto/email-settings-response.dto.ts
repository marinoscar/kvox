import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { emailSettingsSchema } from '../email-settings.schema';

// =============================================================================
// GET/PUT /api/email-settings — response body (issue #124, epic #109)
// =============================================================================
//
// The settings themselves, plus three things the admin page cannot work
// without and cannot derive:
//
//   1. `smtpPasswordStatus` — IS a password stored, and roughly which one.
//      Without it the page renders an empty box and has no way to tell the
//      admin whether that means "none set" or "one is set and you cannot see
//      it". Those two states demand opposite actions, and #115's blank-
//      preserves contract is unusable if the admin cannot tell them apart:
//      submitting blank is correct in one case and leaves the form broken in
//      the other.
//
//   2. `version` / `updatedAt` / `updatedBy` — provenance and the optimistic-
//      concurrency token, matching `SystemSettingsResponseDto`.
//
//   3. `settingsError` — see the note on the field. A stored-but-invalid
//      configuration must not make the page that repairs it un-renderable.
//
// -----------------------------------------------------------------------------
// WHAT IS NOT HERE
// -----------------------------------------------------------------------------
//
// The SMTP password, in any shape: not the plaintext, not the ciphertext, not
// its length, not a "masked" copy of the real characters. `smtpPasswordStatus`
// is built from `CredentialsService.describe`, whose return type
// (`CredentialInfo`) carries its own compile-time proof that it has no field
// able to hold a secret — and whose query does not even SELECT the ciphertext
// column, so the encrypted bytes never leave Postgres for a presentation read.
//
// `hint` below is the store's own mask ('••••' plus at most the last four
// characters, and nothing at all for a secret shorter than eight). It is
// derived once, on write, by the store; nothing here can widen it.
//
// There is a compile-time proof at the bottom of this file, mirroring the one
// in ../email-settings.schema.ts.
// =============================================================================

/**
 * What the admin page needs to know about the stored SMTP password without
 * being told the password.
 *
 * A flat `smtpPasswordConfigured: boolean` was the alternative and is worse:
 * an admin who has just rotated a credential wants to see WHICH one is live,
 * and "when, and by whom" is the difference between "my change saved" and "I
 * am looking at a colleague's value from last March".
 */
export const smtpPasswordStatusSchema = z.object({
  /** Is a password stored at `(purpose 'smtp', name 'default')`? */
  configured: z.boolean(),

  /**
   * The store's non-secret mask, e.g. `••••x9fQ`. Null when nothing is stored,
   * and also null for a row written outside `CredentialsService`.
   */
  hint: z.string().nullable(),

  /** When the stored password was last written. Null when nothing is stored. */
  updatedAt: z.iso.datetime().nullable(),

  /** Who last wrote it. Null when nothing is stored, or the user was deleted. */
  updatedByUserId: z.uuid().nullable(),
});

export const emailSettingsResponseSchema = emailSettingsSchema.extend({
  smtpPasswordStatus: smtpPasswordStatusSchema,

  /**
   * Why the stored configuration could not be read, when it could not be.
   *
   * `EmailSettingsService.get()` THROWS on a stored-but-invalid row, and that
   * is right for a send path — a hand-edited row or a bad migration must not
   * be reported to a caller as the benign "email is not configured" (see the
   * long note in that file).
   *
   * It is the wrong answer for THIS endpoint, and only this one. A 500 here
   * makes the settings page fail to render, which means the one screen capable
   * of repairing the row is the one screen the broken row takes down — the
   * admin is left with no in-app route back to a working state.
   *
   * So the read endpoint degrades instead: it returns the defaults, sets this
   * field to the validator's field-path message, and the page renders a form
   * the admin can correct and re-save. That is NOT the silent substitution the
   * service refuses; the failure is reported in the payload, in the place the
   * person who can fix it is already looking.
   *
   * Null on the normal path. Contains FIELD PATHS ONLY, never stored values —
   * the service's error text is built that way on purpose.
   */
  settingsError: z.string().nullable(),

  /** Bumped on every write; pass back as `If-Match` on PUT. */
  version: z.number().int(),

  updatedAt: z.iso.datetime().nullable(),

  updatedBy: z
    .object({
      id: z.uuid(),
      email: z.email(),
    })
    .nullable(),
});

/** The GET/PUT response body, as sent (inside the global `{ data }` envelope). */
export type EmailSettingsResponse = z.infer<typeof emailSettingsResponseSchema>;

export class EmailSettingsResponseDto extends createZodDto(
  emailSettingsResponseSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that the response grew no secret-bearing field
// -----------------------------------------------------------------------------
//
// The same technique as ../email-settings.schema.ts, applied one layer out.
// `emailSettingsSchema` proves the PERSISTED shape carries no secret; this
// proves the RESPONSE shape does not either — which is a separate claim,
// because this schema `.extend()`s that one and an extension is exactly where
// a convenience field ("just send the password back so the form can prefill
// it") would land.
//
// `smtpPasswordStatus` deliberately does not match: it is a status object
// built from `CredentialInfo`, which has its own proof that it cannot hold a
// secret. If you are here because this line went red, the field you are adding
// is the bug — the value it wants is unreadable by design.

type SecretFieldNames =
  | 'smtpPassword'
  | 'password'
  | 'secret'
  | 'apiKey'
  | 'accessKeyId'
  | 'secretAccessKey'
  | 'ciphertext';

export type EmailSettingsResponseCarriesNoSecret =
  Extract<keyof EmailSettingsResponse, SecretFieldNames> extends never
    ? true
    : never;

export const EMAIL_SETTINGS_RESPONSE_CARRIES_NO_SECRET: EmailSettingsResponseCarriesNoSecret =
  true;
