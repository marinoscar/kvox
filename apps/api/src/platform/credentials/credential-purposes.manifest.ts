// =============================================================================
// Credential purposes (issue #466, epic #462)
// =============================================================================
//
// The platform's `CredentialsService` refuses to write a purpose nobody
// registered, and a credential's PURPOSE IS ALSO ITS AES-GCM SUB-KEY DOMAIN:
// changing a string orphans every secret stored under it. So each purpose below
// is the string KVox has ALWAYS stored, and no stored row is rewritten:
//
//   smtp           platform `SMTP_CREDENTIAL_PURPOSE_DEF`   (same string as KVox's)
//   email_ses      platform `SES_CREDENTIAL_PURPOSE_DEF`    (KVox stores no SES secret)
//   push_vapid     platform `PUSH_VAPID_CREDENTIAL_PURPOSE_DEF` (same string as KVox's)
//
// `transcription` (the speech-to-text provider key, name '<providerId>') is KVox's
// own and is registered by `kvox.manifest.ts` (`[registry:credential-purposes]`):
// base code here may not import the transcription folder.
//
// Verified when this file was written: the platform strings `smtp` and
// `push_vapid` equal `SMTP_CREDENTIAL_PURPOSE` / `PUSH_VAPID_CREDENTIAL_PURPOSE`
// in `email/smtp-credential.constants.ts` and
// `notifications/push-vapid-credential.constants.ts`, so no app-level
// re-registration under KVox's own string was needed.
//
// NOT HERE: `ai-key`. Every AI key is per user in `user_ai_credentials`, never
// in `credentials`; that table uses the cipher (`encryptSecret` /
// `decryptSecret` with purpose `'ai-key'`) but no `credentials` row.
// =============================================================================

import { registerCredentialPurpose } from '@marinoscar/platform-api/credentials';
import { SES_CREDENTIAL_PURPOSE_DEF, SMTP_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/email';
import { PUSH_VAPID_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/notifications';

let registered = false;

/** Registers the platform's credential purposes this deployment stores. Idempotent per process. */
export function registerKvoxCredentialPurposes(): void {
  if (registered) return;
  registered = true;

  registerCredentialPurpose(SMTP_CREDENTIAL_PURPOSE_DEF);
  registerCredentialPurpose(SES_CREDENTIAL_PURPOSE_DEF);
  registerCredentialPurpose(PUSH_VAPID_CREDENTIAL_PURPOSE_DEF);
}
