// =============================================================================
// Credential purposes (issue #466, epic #462)
// =============================================================================
//
// The platform's `CredentialsService` refuses to write a purpose nobody
// registered, and a credential's PURPOSE IS ALSO ITS AES-GCM SUB-KEY DOMAIN:
// changing a string orphans every secret stored under it. So each purpose below
// is the string this app has ALWAYS stored, and no stored row is rewritten:
//
//   smtp           platform `SMTP_CREDENTIAL_PURPOSE_DEF`   (same string as this app's)
//   email_ses      platform `SES_CREDENTIAL_PURPOSE_DEF`    (this app stores no SES secret)
//   push_vapid     platform `PUSH_VAPID_CREDENTIAL_PURPOSE_DEF` (same string as this app's)
//   storage        platform `STORAGE_CREDENTIAL_PURPOSE_DEF` (#469; the object store's secret
//                  access key, `storage/default`, entered at /admin/settings/storage)
//
// `transcription` (the speech-to-text provider key, name '<providerId>') is this app's
// own and is registered by `kvox.manifest.ts` (`[registry:credential-purposes]`):
// base code here may not import the transcription folder.
//
// Verified when this file was written: the platform strings `smtp` and
// `push_vapid` equal `SMTP_CREDENTIAL_PURPOSE` / `PUSH_VAPID_CREDENTIAL_PURPOSE`
// in `email/smtp-credential.constants.ts` and
// `notifications/push-vapid-credential.constants.ts`, so no app-level
// re-registration under this app's own string was needed.
//
// NOT HERE: `ai-key`. Every AI key is per user in `user_ai_credentials`, never
// in `credentials`; that table uses the cipher (`encryptSecret` /
// `decryptSecret` with purpose `'ai-key'`) but no `credentials` row.
// =============================================================================

import { registerCredentialPurpose } from '@marinoscar/platform-api/credentials';
import { SES_CREDENTIAL_PURPOSE_DEF, SMTP_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/email';
import { PUSH_VAPID_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/notifications';
import { STORAGE_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/storage';

let registered = false;

/** Registers the platform's credential purposes this deployment stores. Idempotent per process. */
export function registerKvoxCredentialPurposes(): void {
  if (registered) return;
  registered = true;

  registerCredentialPurpose(SMTP_CREDENTIAL_PURPOSE_DEF);
  registerCredentialPurpose(SES_CREDENTIAL_PURPOSE_DEF);
  registerCredentialPurpose(PUSH_VAPID_CREDENTIAL_PURPOSE_DEF);
  registerCredentialPurpose(STORAGE_CREDENTIAL_PURPOSE_DEF);
}
