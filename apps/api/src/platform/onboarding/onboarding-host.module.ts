import { Global, Module } from '@nestjs/common';
import { ONBOARDING_DATA } from '@marinoscar/platform-api/onboarding';

import { OnboardingDataAdapter } from './onboarding-data.adapter';

// =============================================================================
// The onboarding slice's host ports (issue #481, epic #478)
// =============================================================================
//
//   ONBOARDING_DATA      -> OnboardingDataAdapter   (this app's Prisma client)
//   ONBOARDING_FEATURES  -> not bound. No registered step names a `feature`, and an
//                           unbound gate only omits feature-gated steps. The AI
//                           step is gated by the Doctor's `ai.enabled` check
//                           instead, which reads the deployment's own policy.
//
// `@Global()` so the slice's services resolve the port from whichever module
// instantiates them (the arrangement of the other hosts).
// =============================================================================

@Global()
@Module({
  providers: [OnboardingDataAdapter, { provide: ONBOARDING_DATA, useExisting: OnboardingDataAdapter }],
  exports: [ONBOARDING_DATA],
})
export class OnboardingHostModule {}
