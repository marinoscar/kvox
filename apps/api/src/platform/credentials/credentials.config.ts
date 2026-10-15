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
// (every AI key lives in `user_ai_credentials`).
//
// The purposes are registered by `app-registrations/registrations.ts`
// (`registerKvoxCredentialPurposes`), which every entry point imports before the
// registries freeze at bootstrap.
// =============================================================================

import {
  CredentialsModule,
  OrgCredentialsModule,
  UserCredentialsModule,
} from '@marinoscar/platform-api/credentials';

export { CredentialsModule, OrgCredentialsModule, UserCredentialsModule };
