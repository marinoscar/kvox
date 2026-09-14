// =============================================================================
// Transcription credential address (issue #23, epic #19)
// =============================================================================
//
// The `(purpose, name)` pair a transcription provider's API key is stored under
// in the encrypted credential store (#115, epic #108).
//
// A LEAF MODULE THAT IMPORTS NOTHING, exactly like `email/smtp-credential
// .constants.ts`, and for the identical reason spelled out there: the write side
// lives in `TranscriptionSettingsService` and the read side lives in the
// provider, so putting the shared constants in either would make the two import
// each other — and with `emitDecoratorMetadata` a cycle is not a style problem.
// `design:paramtypes` is evaluated at class-decoration time, so whichever module
// CommonJS begins loading second sees `undefined` where a constructor parameter
// type should be, and Nest fails to resolve the dependency at boot.
//
// ONE DEFINITION, TWO SIDES. The write path and the read path must address the
// same row; `purpose` is ALSO the cipher's sub-key domain, so a second string
// literal differing by a character produces a credential that saves without
// complaint and can never be decrypted back. There is deliberately nothing to
// keep in sync.
//
// -----------------------------------------------------------------------------
// WHY `name` IS THE PROVIDER ID AND NOT 'default'
// -----------------------------------------------------------------------------
//
// SMTP uses `name: 'default'` because this application has one mail transport.
// Transcription has N vendors and an administrator switching between them must
// not have to re-enter a key they already proved works — which is the same
// argument `transcriptionProvidersSchema` makes for keeping every provider's
// settings block present. One row per provider id makes "switch to AssemblyAI,
// discover its transcript quality, switch back" free, and makes "remove the key
// for this one provider" expressible (`DELETE /api/transcription-settings
// /credentials/:provider`) without touching the others.
// =============================================================================

/**
 * Credential store address for a transcription API key: the sub-key domain.
 *
 * `purpose` is also the AES-GCM sub-key domain (see `CredentialsService`), so
 * changing this string orphans every already-stored transcription key — they
 * remain in the table and become permanently unreadable. It is not a rename.
 */
export const TRANSCRIPTION_CREDENTIAL_PURPOSE = 'transcription';

/**
 * The discriminator within the purpose: the provider's own id.
 *
 * A function rather than a constant precisely because there is one row per
 * provider. Callers pass `TranscriptionProviderId`; the indirection exists so
 * "how is a transcription credential addressed" has one answer that a future
 * change (a prefix, a tenant segment) can edit in one place.
 */
export function transcriptionCredentialName(providerId: string): string {
  return providerId;
}

/**
 * Human label written alongside the stored key.
 *
 * NON-SECRET, and it must stay that way: `CredentialMeta` carries a
 * compile-time proof that it has no secret-bearing field, and this string is
 * shown verbatim in any credential listing. It exists so a row in that listing
 * says what it is for rather than only `transcription/assemblyai`.
 */
export function transcriptionCredentialLabel(providerLabel: string): string {
  return `${providerLabel} API key`;
}
