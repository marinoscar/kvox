// =============================================================================
// Web Push VAPID credential address (issue #355)
// =============================================================================
//
// The `(purpose, name)` pair the VAPID PRIVATE key is stored under in the
// encrypted credential store (#115, epic #108). Mirrors
// `../email/smtp-credential.constants.ts` exactly, including why this lives in
// its own leaf module: `PushConfigService` and `PushNotificationChannel` both
// need this address, and putting it in a file with no imports of its own keeps
// it safe to import from either side without inviting a module import cycle
// under `emitDecoratorMetadata` (see the SMTP file's header for the mechanical
// reason that matters at Nest boot).
//
// ONE DEFINITION, EVERY READER. `purpose` is ALSO the cipher's sub-key domain
// (see `CredentialsService`), so a second string literal that differs by a
// character produces a credential that saves without complaint and can never
// be decrypted back. There is deliberately nothing here to keep in sync.
//
// THE PUBLIC KEY IS **NOT** STORED HERE. It is not a secret — it is handed to
// every browser that calls `pushManager.subscribe` — so it lives in the
// `webPush` `system_settings` row (`push-config.schema.ts`) in full, the same
// way `smtpHost`/`smtpUsername` live in the `email` row while only the SMTP
// password goes through this store. Only the VAPID PRIVATE key belongs at this
// address.
// =============================================================================

/**
 * Credential store address for the VAPID private key: the sub-key domain.
 *
 * `purpose` is also the AES-GCM sub-key domain (see `CredentialsService`), so
 * changing this string orphans every already-stored VAPID private key — they
 * remain in the table and become permanently unreadable. It is not a rename.
 */
export const PUSH_VAPID_CREDENTIAL_PURPOSE = 'push_vapid';

/**
 * Discriminator within the purpose. 'default' because this app has one Web
 * Push identity; a future multi-tenant setup keys additional rows by tenant id
 * without touching anything above.
 */
export const PUSH_VAPID_CREDENTIAL_NAME = 'default';

/**
 * Human label written alongside the stored private key.
 *
 * NON-SECRET, and it must stay that way: `CredentialMeta` carries a
 * compile-time proof that it has no secret-bearing field, and this string is
 * shown verbatim in any credential listing.
 */
export const PUSH_VAPID_CREDENTIAL_LABEL = 'Web Push VAPID private key';
