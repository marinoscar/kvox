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
//   telemetry_greptime  the telemetry slice's two GreptimeDB passwords (#471), names
//                  `reader` and `admin`. The slice exports the purpose string but no
//                  definition, so the definition is this app's.
//
// `transcription` (the speech-to-text provider key, name '<providerId>') is this app's
// own and is registered by `kvox.manifest.ts` (`[registry:credential-purposes]`):
// base code here may not import the transcription folder.
//
// Verified when this file was written, and again by #470 when this app's own
// `email/` and `notifications/` folders were deleted: the platform strings
// `smtp` and `push_vapid` equal the `SMTP_CREDENTIAL_PURPOSE` and
// `PUSH_VAPID_CREDENTIAL_PURPOSE` those folders held, so no app-level
// re-registration under this app's own string was needed. `email_ses` is new
// to this deployment's rows: the app's own SES provider read the key pair from
// the environment and stored no secret, so there is no ciphertext under it to
// orphan (the SES access key id and secret are now saved at
// `/admin/settings/email`).
//
// NOT HERE: `ai-key`. Every AI key is per user in `user_ai_credentials`, never
// in `credentials`; that table uses the cipher (`encryptSecret` /
// `decryptSecret` with purpose `'ai-key'`) but no `credentials` row.
// =============================================================================

import { AI_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/ai';
import { registerCredentialPurpose } from '@marinoscar/platform-api/credentials';
import { SES_CREDENTIAL_PURPOSE_DEF, SMTP_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/email';
import { PUSH_VAPID_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/notifications';
import { STORAGE_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/storage';
import { TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE } from '@marinoscar/platform-api/telemetry';

let registered = false;

/** Registers the platform's credential purposes this deployment stores. Idempotent per process. */
export function registerKvoxCredentialPurposes(): void {
  if (registered) return;
  registered = true;

  registerCredentialPurpose(SMTP_CREDENTIAL_PURPOSE_DEF);
  registerCredentialPurpose(SES_CREDENTIAL_PURPOSE_DEF);
  registerCredentialPurpose(PUSH_VAPID_CREDENTIAL_PURPOSE_DEF);
  registerCredentialPurpose(STORAGE_CREDENTIAL_PURPOSE_DEF);
  // The platform AI slice's deployment and organization provider keys (#473). A user's
  // own key is `user_ai_keys`, never a credential.
  registerCredentialPurpose(AI_CREDENTIAL_PURPOSE_DEF);
  registerCredentialPurpose({
    purpose: TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE,
    owner: 'telemetry',
    label: 'GreptimeDB passwords',
    tiers: ['system'],
  });
}
