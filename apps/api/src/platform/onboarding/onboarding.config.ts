import { OnboardingModule } from '@marinoscar/platform-api/onboarding';

// The steps and facts register at import time, and the stored `onboarding` namespace's merge
// reads the step registry, so the manifest is also imported by `kvox.manifest.ts` (every entry
// point). Importing it here keeps this file correct when it is read on its own.
import './onboarding.manifest';
import { OnboardingHostModule } from './onboarding-host.module';

// =============================================================================
// The onboarding slice's composition (issue #481, epic #478)
// =============================================================================
//
// `OnboardingModule.forRoot` replaces this app's own `onboarding/` folder:
//
//   GET /api/onboarding                   the caller's stored UI state, the `user` checklist
//                                         and, for a holder of `system_settings:read`, the
//                                         `admin` checklist (`user_settings:read`, which every
//                                         role holds)
//   GET /api/admin/onboarding/metrics     aggregate activation metrics (`system_settings:read`)
//
// There is no separate `GET /api/admin/onboarding`: the admin block rides on the one route.
// The admin gate stays the platform default, `system_settings:read`, which is also what the
// Doctor's report (the source of the admin steps) is gated on.
//
// Completion is derived on every read and never stored. Only the caller's intent is stored,
// in the platform's `onboarding` user-settings namespace (registered in
// `app-registrations/settings.ts`).
// =============================================================================

export const onboardingModule = OnboardingModule.forRoot({ imports: [OnboardingHostModule] });
