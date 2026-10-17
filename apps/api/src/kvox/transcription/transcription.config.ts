// FIRST: sets how the routes are documented before `forRoot` documents them.
import '../auth-documenter';

import { TranscriptionModule } from '@marinoscar/kvox-api/transcription';

import { PERMISSIONS } from '../../common/constants/roles.constants';

// =============================================================================
// The web edition's configuration of the transcription slice (issue #492, epic #491)
// =============================================================================
//
// The only place this application configures `@marinoscar/kvox-api/transcription`.
// Everything else the slice needs comes from the ports `PlatformKvoxModule` binds
// (settings, secrets, identity, audit).
//
//   providers        the built-in AssemblyAI provider, on. A fork adds another
//                    provider class to `extraProviders`; it becomes selectable
//                    as the `provider` setting with no other change.
//   permissions      the exact strings the admin settings card names (the Settings
//                    UI Pattern: a card's permission is the string the controller
//                    enforces): `system_settings:read|write` for
//                    `/api/transcription-settings`, `transcripts:read` for the
//                    capability probe every signed-in account may read.
//
// What stays out of the slice and lives beside this file, because it uses the
// platform: the system-settings manifest entry (`transcription.system-settings.ts`),
// the credential purpose (`transcription.credential-purpose.ts`), the onboarding
// step and facts (`transcription.onboarding.ts`) and the Doctor check
// (`transcription-configured.doctor-check.ts`, provided by `TranscriptionBindingModule`).
// =============================================================================

export const TranscriptionConfig = TranscriptionModule.forRoot({
  providers: { assemblyai: true },
  extraProviders: [],
  permissions: {
    settingsRead: PERMISSIONS.SYSTEM_SETTINGS_READ,
    settingsWrite: PERMISSIONS.SYSTEM_SETTINGS_WRITE,
    configRead: PERMISSIONS.TRANSCRIPTS_READ,
  },
});
