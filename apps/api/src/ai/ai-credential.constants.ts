// =============================================================================
// AI credential encryption purpose (issue #47, epic #45)
// =============================================================================
//
// A LEAF MODULE THAT IMPORTS NOTHING, exactly like
// `transcription/transcription-credential.constants.ts` and
// `email/smtp-credential.constants.ts`, and for the identical reason spelled
// out there: with `emitDecoratorMetadata`, a require cycle is not a style
// problem — `design:paramtypes` is evaluated at class-decoration time, so
// whichever module CommonJS begins loading second sees `undefined` where a
// constructor parameter type should be, and Nest fails to resolve the
// dependency at boot.
//
// ⚠ THERE IS NO `name` HELPER HERE, AND THAT ABSENCE IS THE POINT. Every other
// credential in this application is addressed `(purpose, name)` in the shared
// `credentials` table. A per-user AI key is NOT: it is a row in
// `user_ai_credentials`, addressed `(user_id, provider)` behind a CASCADING
// FOREIGN KEY, because the alternative — encoding a user id into a `name`
// string — leaves an encrypted personal key in the database forever when its
// owner is deleted. See the block comment above the `UserAiCredential` model in
// `prisma/schema.prisma`. The only thing the two schemes share is the cipher,
// and this constant is that one shared thing.
// =============================================================================

/**
 * The AES-GCM sub-key domain for a user's AI provider key.
 *
 * ⚠ CHANGING THIS STRING IS NOT A RENAME. `purpose` is the derivation label
 * (`common/crypto/secret-cipher.ts`), so a different value derives a different
 * key: every already-stored AI credential would remain in the table and become
 * permanently unreadable, with the failure surfacing as "the provider refused
 * this key" for every user at once.
 *
 * DISTINCT FROM `'transcription'` AND `'smtp'` on purpose — that separation is
 * what makes a ciphertext lifted out of `credentials` and pasted into
 * `user_ai_credentials.secret` fail authentication rather than decrypting into
 * a context where it means something else.
 */
export const AI_CREDENTIAL_PURPOSE = 'ai-key';

/**
 * Length ceiling on a submitted key.
 *
 * Generous — provider keys are typically 50-200 characters, and some vendors
 * issue JWT-shaped credentials of several hundred. The bound exists to stop a
 * megabyte of junk reaching the cipher, not to validate a format this
 * application has no business knowing.
 */
export const MAX_AI_API_KEY_LENGTH = 4096;

/** Ceiling on the user-supplied, non-secret label beside a stored key. */
export const MAX_AI_CREDENTIAL_LABEL_LENGTH = 100;
