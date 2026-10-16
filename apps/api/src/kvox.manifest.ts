// =============================================================================
// The app's composition root for static registries (issue #459)
// =============================================================================
//
// IMPORT THIS FIRST. Every entry point (`main.ts`, `scripts/dump-openapi.ts`,
// `scripts/ask-eval/run.ts`, `scripts/kg-eval.ts`, `app.module.ts`,
// `test/setup.ts`) imports it before anything that reads the settings
// registries, because the request/response DTOs, the composed settings schemas
// and `DEFAULT_SYSTEM_SETTINGS` are COMPOSED FROM THEM AT IMPORT TIME. The
// composers throw ("Settings namespaces are not registered: import
// apps/api/src/kvox.manifest first") on an empty registry, so a mis-wired entry
// point fails on start instead of silently stripping a namespace from every
// PATCH.
//
// This is the one file that knows every settings namespace, base and domain
// alike. The settings module itself imports no domain code: `transcription` and
// `graph` are declared beside their own modules and only REGISTERED here, which
// is the whole point of the registry (and of
// `test/architecture/base-domain-boundary.spec.ts`, which exempts this file by
// name).
//
// ORDER IS THE STORED KEY ORDER AND THE OPENAPI ORDER: append, never insert.
//   system: notifications, jobs, nodes, databaseBackup, maintenance,
//           transcription, ai
//   user:   dataTables, navigation, notifications, onboarding, graph
// (`theme` and `profile` are core fields placed ahead of the user namespaces by
// the composers.) Since #466 the namespaces are registered by
// `settings/registry/` (the platform's declarations folded with this app's from
// `app-registrations/settings.ts`) and `kvox.settings-manifest.ts` only triggers it.
//
// Registration is idempotent per process: Jest imports this from `setup.ts` and
// a spec may import it again, and registering a namespace twice is a
// `DUPLICATE_ID` error.
// =============================================================================

// MUST stay the FIRST import: it registers the settings namespaces, and every
// domain module imported below can pull in a DTO that is COMPOSED FROM THEM AT
// IMPORT TIME (`settings/dto/*`). ES imports evaluate in order, so this file's
// side effect has to run before any of them is loaded. See that file's header.
import './kvox.settings-manifest';
// The onboarding slice's registries (#481): the platform's facts and steps, and this app's base
// ones, register on import (the stored `onboarding` namespace's merge reads the step registry, so
// every entry point that handles settings needs it filled). The domain halves are registered below.
import './platform/onboarding/onboarding.manifest';
import {
  registerOnboardingFact,
  registerOnboardingStep,
} from '@marinoscar/platform-api/onboarding';
import { NOTES_ONBOARDING_FACTS, NOTES_ONBOARDING_STEPS } from './notes/notes.onboarding';
import {
  TRANSCRIPTION_ONBOARDING_FACTS,
  TRANSCRIPTION_ONBOARDING_STEPS,
} from './transcription/transcription.onboarding';
import {
  TRANSCRIPTS_ONBOARDING_FACTS,
  TRANSCRIPTS_ONBOARDING_STEPS,
} from './transcripts/transcripts.onboarding';

import { registerCredentialPurpose } from '@marinoscar/platform-api/credentials';

import { TRANSCRIPTION_CREDENTIAL_PURPOSE_DEF } from './transcription/transcription-credential.constants';

let registered = false;

if (!registered) {
  registered = true;

  // ---- issue #460: domain registrations, in dependency order ---------------
  // Each section is owned by one registry; append your calls under your marker.
  // [registry:credential-purposes]
  // The platform's `CredentialsService` refuses a write to a purpose nobody
  // registered (#466). The platform's own purposes (`smtp`, `email_ses`,
  // `push_vapid`) are registered by `app-registrations/registrations.ts`.
  registerCredentialPurpose(TRANSCRIPTION_CREDENTIAL_PURPOSE_DEF);
  // [registry:job-labels]
  // None: since #468 every job handler declares its own `label`, which the
  // platform registry records when the handler registers. The labels of the
  // retired example types are registered in `app-registrations/jobs.ts`.
  // [registry:email-templates]
  // None here since #470: the email templates and the notification events are the
  // platform's slice, registered (platform channels, rendering context, platform
  // templates, this app's templates, then the events) by
  // `platform/notifications/notification.manifest.ts`, imported by
  // `platform/notifications/notifications.config.ts`.
  // [registry:notifications]
  // See above: `notifications-registry/*.notifications.ts`.
  // [registry:onboarding]
  // The platform's facts and steps and this app's base ones (AI) are registered on import of
  // `platform/onboarding/onboarding.manifest.ts`; the domain half is here. `order` (per audience)
  // fixes the rendered sequence, so the call order is not load-bearing, and
  // `assertOnboardingRegistries` checks at boot that every fact a step names is registered.
  registerOnboardingFact(
    ...TRANSCRIPTION_ONBOARDING_FACTS,
    ...TRANSCRIPTS_ONBOARDING_FACTS,
    ...NOTES_ONBOARDING_FACTS,
  );
  registerOnboardingStep(
    ...TRANSCRIPTION_ONBOARDING_STEPS,
    ...TRANSCRIPTS_ONBOARDING_STEPS,
    ...NOTES_ONBOARDING_STEPS,
  );
  // [registry:user-data]
  // None here since #480: the categories, scopes and model hints are the platform
  // user-data slice's registries, filled by `platform/user-data/user-data.manifest.ts`,
  // imported by `platform/user-data/user-data.config.ts`.
}
