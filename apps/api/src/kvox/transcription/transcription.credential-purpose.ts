import type { CredentialPurposeDef } from '@marinoscar/platform-api/credentials';
import { TRANSCRIPTION_CREDENTIAL_PURPOSE } from '@marinoscar/kvox-api/transcription';

/**
 * The purpose's registration with the platform credential store (#466): its
 * `CredentialsService` refuses a write to a purpose nobody registered. Registered
 * by `kvox.manifest.ts` (`[registry:credential-purposes]`) before the application
 * is created, because base code (`platform/credentials/`) may not import this
 * folder. System tier only: the provider key is the deployment's, one row per
 * provider id.
 *
 * The slice itself declares the purpose through `KVOX_SECRETS.registerPurpose`
 * when it starts; the platform adapter keeps this registration (it carries the
 * owner and the tiers a label cannot).
 */
export const TRANSCRIPTION_CREDENTIAL_PURPOSE_DEF = {
  purpose: TRANSCRIPTION_CREDENTIAL_PURPOSE,
  owner: 'transcription',
  label: 'Transcription provider API key',
  tiers: ['system'],
} as const satisfies CredentialPurposeDef;
