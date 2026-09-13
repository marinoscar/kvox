// =============================================================================
// The create-credential request body (issue #267, epic #254)
// =============================================================================
//
// Deliberately NOT `CreatePatDto`'s `{ durationValue, durationUnit }` pair.
// That pair exists on a PAT because a PAT MUST expire — `PersonalAccessToken
// .expiresAt` is a required column — so its request body has to make the
// caller say when, and the two-field shape ("30" + "days") is friendlier than
// a raw timestamp for a human filling in a form.
//
// A node credential's expiry is OPTIONAL, and the reason is written out in
// full above `NodeCredential.expiresAt` in `prisma/schema.prisma`: a worker
// node runs unattended for months, and a mandatory expiry turns a fleet going
// dark at 3am into the DEFAULT behaviour rather than an incident. So the
// field is optional here, and its absence is a real, supported answer —
// "never expires, authenticate indefinitely until revoked" — not a validation
// hole and not an unset value some later code has to fill in.
//
// WHY `expiresInDays` AND NOT AN ISO TIMESTAMP. A caller-supplied absolute
// `expiresAt` would have to be validated against the server's clock (is it in
// the past? is it absurdly far in the future?) and would silently encode the
// CALLER's idea of "now" — a CLI on a box with a skewed clock could mint a
// credential that is already expired, or one that outlives the deployment. A
// relative duration is interpreted by the server against the server's own
// clock, which is the same clock `validateToken` compares against, so the two
// can never disagree. Days rather than a unit enum because a node credential
// measured in minutes is not a use case anybody has: this credential exists
// precisely for the long-lived, unattended case.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Upper bound on `expiresInDays`: ten years, which is "effectively never" with a clock attached. */
export const MAX_NODE_CREDENTIAL_DAYS = 3650;

export const createNodeCredentialSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or less'),

  // Optional ON PURPOSE — see the file header. Omitted means `expiresAt: null`
  // in the row, which `validateToken` treats as "no expiry to check", not as
  // "expired" and not as "not configured yet".
  expiresInDays: z
    .number()
    .int('Expiry must be a whole number of days')
    .min(1, 'Expiry must be at least 1 day')
    .max(
      MAX_NODE_CREDENTIAL_DAYS,
      `Expiry must be at most ${MAX_NODE_CREDENTIAL_DAYS} days`,
    )
    .optional(),
});

export class CreateNodeCredentialDto extends createZodDto(
  createNodeCredentialSchema,
) {}
