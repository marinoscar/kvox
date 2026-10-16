// =============================================================================
// The platform credentials store (issue #466, epic #462)
// =============================================================================
//
// `CredentialsModule` is the encrypted `(purpose, name)` store that replaces
// this app's own `credentials/` folder: the same table, the same cipher and the
// same sub-key domain, so existing ciphertext decrypts unchanged. NOT global: a
// module that reads a plaintext secret imports it explicitly, so the list of
// readers stays visible in a diff.
//
// `UserCredentialsModule` and `OrgCredentialsModule` are mounted but unused:
// this app keeps no per-user or per-organization credential in these tables
// (every AI key lives in the platform's `user_ai_keys`).
//
// The purposes are registered at import time, before the registries freeze at
// bootstrap: the platform's (`smtp`, `email_ses`, `push_vapid`) by
// `app-registrations/registrations.ts` (`registerKvoxCredentialPurposes`), and
// the app's own `transcription` by `kvox.manifest.ts`
// (`[registry:credential-purposes]`).
// =============================================================================

import {
  CredentialsModule,
  OrgCredentialsModule,
  UserCredentialsModule,
} from '@marinoscar/platform-api/credentials';

export { CredentialsModule, OrgCredentialsModule, UserCredentialsModule };
