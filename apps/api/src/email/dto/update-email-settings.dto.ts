import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { emailSettingsSchema } from '../email-settings.schema';

// =============================================================================
// PUT /api/email-settings — request body (issue #124, epic #109)
// =============================================================================
//
// DERIVED FROM `emailSettingsSchema`, NOT RESTATED. Every field below reaches
// into `emailSettingsSchema.shape`, so a rule that changes there — a tightened
// port range, a new provider kind — changes here in the same edit. A restated
// copy is how a settings page starts accepting a value the reader rejects,
// which surfaces as "I saved it and email still doesn't work" with nothing in
// the response to explain it.
//
// -----------------------------------------------------------------------------
// THE PASSWORD IS THE ONLY ADDITION, AND IT IS WRITE-ONLY
// -----------------------------------------------------------------------------
//
// `smtpPassword` exists on the REQUEST and on nothing else. It is never in
// `emailSettingsSchema` (that file carries a compile-time proof of its
// absence), never in the persisted blob — `emailSettingsSchema.parse()` in the
// service strips it, because zod drops unknown keys — and never in the
// response DTO next door, which carries its own proof.
//
// So the value's entire lifetime is: request body -> service ->
// `CredentialsService.setSecret` -> AES-GCM ciphertext in `credentials.secret`.
// There is no branch on which it can travel back out.
//
// -----------------------------------------------------------------------------
// BLANK PRESERVES — DO NOT "NORMALISE" THE PASSWORD
// -----------------------------------------------------------------------------
//
// The form renders the password box EMPTY, because the stored value is
// unreadable by design. An empty submission therefore means "keep what is
// stored" and can never mean "erase it" (#115 implements this; see
// `CredentialsService.setSecret`).
//
// That contract is easy to defeat from here, and the ways all look like
// tidying up:
//
//   * `.trim()` — a passphrase whose leading/trailing space is significant
//     becomes a different password, and authentication starts failing with no
//     visible cause.
//   * `.min(1)` — a blank submission becomes a 400, so an admin editing the
//     from-address can no longer save the form without retyping a secret they
//     cannot see.
//   * `.default('')` / coercion — turns "absent" into a value, and any code
//     downstream that distinguishes the two now sees the wrong one.
//
// So: `z.string()` with a length ceiling and nothing else. `.nullish()`
// because a JSON body deserialises an omitted field to `undefined` and an
// explicitly-cleared one to `null`, and the admin means the same thing by
// both. `CredentialsService.isBlankSecret` already treats `undefined`, `null`
// and `''` identically; this schema's job is to get all three there intact.
// =============================================================================

/**
 * Length ceiling on the submitted password.
 *
 * Not a security control — it is a bound on what an unauthenticated-shaped
 * mistake or a paste accident can push into an encrypted column, so a
 * multi-megabyte body is refused by the validator rather than by Postgres.
 * Generous enough for any real SMTP credential, including an app password or
 * a long API token used as one.
 */
const MAX_SMTP_PASSWORD_LENGTH = 1024;

/**
 * A settings field an admin has left empty.
 *
 * An HTML form has no way to say "absent": a cleared text input submits `''`,
 * and a controlled React field that was reset submits `null`. Both mean "this
 * is not configured", which for every optional field in `emailSettingsSchema`
 * is expressed as the key being missing.
 *
 * Accepted as a UNION rather than converted with `z.preprocess`, deliberately.
 * A preprocess is a `ZodTransform`, and `zod`'s `toJSONSchema` — which
 * nestjs-zod calls to publish this DTO into the OpenAPI document — throws on
 * an unrepresentable transform. The union is representable, so the published
 * schema stays honest about what the endpoint actually accepts.
 *
 * The conversion to "absent" happens once, in `EmailSettingsService.update`,
 * where it is a single documented step rather than seven scattered ones.
 *
 * NOT APPLIED TO `provider`: there `null` is a real, persisted state ("the
 * admin has not chosen a transport"), not an empty box. And NOT applied to
 * `smtpPassword`: there `''` is the blank-preserves signal and must survive.
 */
const unset = z.union([z.literal(''), z.null()]);

/** `emailSettingsSchema`'s rule for one field, plus the two "empty box" forms. */
function blankable<T extends z.ZodTypeAny>(inner: T) {
  return z.union([unset, inner]);
}

export const updateEmailSettingsSchema = emailSettingsSchema.extend({
  // Every optional field, widened to tolerate an emptied form control. The
  // rules themselves still come from `emailSettingsSchema.shape`.
  sesRegion: blankable(emailSettingsSchema.shape.sesRegion),
  smtpHost: blankable(emailSettingsSchema.shape.smtpHost),
  smtpPort: blankable(emailSettingsSchema.shape.smtpPort),
  smtpUseTls: blankable(emailSettingsSchema.shape.smtpUseTls),
  smtpUsername: blankable(emailSettingsSchema.shape.smtpUsername),
  fromAddress: blankable(emailSettingsSchema.shape.fromAddress),
  fromName: blankable(emailSettingsSchema.shape.fromName),

  /**
   * The SMTP password. WRITE-ONLY — see the header.
   *
   * Blank (absent, `null`, or `''`) preserves whatever is stored. Erasing a
   * stored password is `CredentialsService.deleteSecret`, reached from a
   * separate control, and is deliberately not expressible through this field.
   */
  smtpPassword: z.string().max(MAX_SMTP_PASSWORD_LENGTH).nullish(),
});

/** The parsed PUT body, password included. */
export type UpdateEmailSettingsInput = z.infer<typeof updateEmailSettingsSchema>;

export class UpdateEmailSettingsDto extends createZodDto(
  updateEmailSettingsSchema,
) {}
