// =============================================================================
// Transcript sharing request and response shapes (issue #29, epic #19, spec §6.3)
// =============================================================================
//
// ZOD, NOT class-validator, for the reason `transcript.dto.ts` states at
// length: `app.module.ts` registers `ZodValidationPipe` as this application's
// single global `APP_PIPE` and never registers Nest's `ValidationPipe`, so a
// `class-validator` decorator here would be inert metadata and the body would
// arrive COMPLETELY UNVALIDATED while looking validated.
//
// -----------------------------------------------------------------------------
// WHAT A SHARE ROW PUBLISHES, AND WHAT IT DELIBERATELY DOES NOT
// -----------------------------------------------------------------------------
//
// A share row is only ever read by the transcript's OWNER — the one caller who
// already knows, by construction, exactly which addresses they typed in. So it
// carries the recipient's `email` and `displayName` and nothing further: no
// `isActive`, no roles, no identity provider, no last-seen. The owner learns
// nothing about the recipient that the owner did not already supply.
//
// ⚠ AND THERE IS NO SEARCH SHAPE IN THIS FILE AT ALL. `POST` takes ONE exact
// address and answers a generic 404 for a miss (§6.3). A response type that
// could carry candidate matches is the first step toward the user-directory
// autocomplete issue #29 explicitly rejected, so none exists.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** The two levels a share can grant. `owner` is not a share — it is the row. */
export const TRANSCRIPT_SHARE_ROLES = ['viewer', 'editor'] as const;

export type TranscriptShareRoleName = (typeof TRANSCRIPT_SHARE_ROLES)[number];

/** Longest address this endpoint will even look at. RFC 5321's own ceiling. */
export const MAX_EMAIL_LENGTH = 254;

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

/**
 * `POST /api/transcripts/:id/shares`.
 *
 * ⚠ `email` IS TRIMMED AND LOWERCASED HERE, in the schema, rather than in the
 * service. The lookup is "exact, case-insensitive" (§6.3), and doing the
 * normalisation once at the edge means there is exactly one definition of what
 * "the same address" means — the alternative is a service that lowercases and
 * a rate limiter keyed on the raw string, where `A@x.test` and `a@x.test`
 * would be two separate buckets against the same account.
 */
export const createTranscriptShareSchema = z.object({
  email: z
    .string()
    .trim()
    .max(MAX_EMAIL_LENGTH, `An email address is at most ${MAX_EMAIL_LENGTH} characters`)
    .email('A valid email address is required')
    // Mirrors `allowlist/dto/add-email.dto.ts`, which normalises the same way
    // for the same reason: addresses are compared case-insensitively and
    // stored lowercased, so the edge is the one place that decides it.
    .transform((email) => email.toLowerCase()),
  role: z.enum(TRANSCRIPT_SHARE_ROLES),
});

export type CreateTranscriptShareDto = z.infer<typeof createTranscriptShareSchema>;

export class CreateTranscriptShareBodyDto extends createZodDto(
  createTranscriptShareSchema,
) {}

/** `PATCH /api/transcripts/:id/shares/:userId` — the role is the only field. */
export const updateTranscriptShareSchema = z.object({
  role: z.enum(TRANSCRIPT_SHARE_ROLES),
});

export type UpdateTranscriptShareDto = z.infer<typeof updateTranscriptShareSchema>;

export class UpdateTranscriptShareBodyDto extends createZodDto(
  updateTranscriptShareSchema,
) {}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

/** One person this transcript is shared with. */
export const transcriptShareSchema = z.object({
  /** The SHARE row's id. Never used as a path segment — `:userId` is. */
  id: z.string(),
  /** The recipient. This is what `DELETE /shares/:userId` is keyed on. */
  userId: z.string(),
  email: z.string(),
  /** May be null: a user provisioned by an allowlist invitation who never set one. */
  displayName: z.string().nullable(),
  role: z.enum(TRANSCRIPT_SHARE_ROLES),
  /** Who granted it. Today always the owner; recorded because that may change. */
  grantedById: z.string(),
  createdAt: z.string(),
});

export class TranscriptShareDto extends createZodDto(transcriptShareSchema) {}

/** `GET /api/transcripts/:id/shares` — everyone, unpaginated. */
export const transcriptSharesSchema = z.object({
  /**
   * Every share on this transcript, oldest first.
   *
   * NOT PAGINATED, and that is a statement about the feature rather than an
   * omission: this is the list rendered inside one dialog, for a private
   * conversation the owner shared by typing addresses one at a time. A
   * transcript with enough shares to need a cursor is a transcript that should
   * have been a link, and issue #29 rejected links for v1.
   */
  items: z.array(transcriptShareSchema),
});

export class TranscriptSharesDto extends createZodDto(transcriptSharesSchema) {}
