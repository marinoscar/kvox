import {
  ONBOARDING_STEP_IDS,
  PLATFORM_ONBOARDING_FACTS,
  PLATFORM_ONBOARDING_STEPS,
  registerOnboardingFact,
  registerOnboardingStep,
} from '@marinoscar/platform-api/onboarding';

import { KVOX_BASE_ONBOARDING_FACT_DEFS } from './onboarding.facts';
import { KVOX_BASE_ONBOARDING_STEP_DEFS } from './onboarding.steps';

// =============================================================================
// The base half of this app's onboarding manifest (issue #481, epic #478)
// =============================================================================
//
// Registers the platform's facts and steps, and the base facts and steps of this app:
// the AI readiness fact, `user.ai_key`, and `admin.ai`, which replaces the built-in of the
// same id (see `onboarding.steps.ts`: there is exactly one `admin.ai`).
//
// The domain halves (transcription, transcripts, notes) are registered by `kvox.manifest.ts`
// from `*/*.onboarding.ts`, because base code may not import domain code.
//
// Registration order is not load-bearing: a step's `order` fixes the rendered sequence and
// the boot-time `assertOnboardingRegistries` checks that every fact a step names exists. The
// registries are all-or-nothing per call, so a typo fails at import.
//
// IMPORTED BY `kvox.manifest.ts`, the composition root every entry point loads first, and by
// `onboarding.config.ts`. The stored `onboarding` namespace's merge refuses a `skipped` id
// that is not a registered, skippable step, so the registry must be filled in any process
// that can handle `PATCH /api/user-settings`, the OpenAPI dump and the specs included.
// Module scope runs once per module registry, so no guard flag is needed.
// =============================================================================

registerOnboardingFact(...PLATFORM_ONBOARDING_FACTS, ...KVOX_BASE_ONBOARDING_FACT_DEFS);

registerOnboardingStep(
  ...PLATFORM_ONBOARDING_STEPS.filter((step) => step.id !== ONBOARDING_STEP_IDS.AI),
  ...KVOX_BASE_ONBOARDING_STEP_DEFS,
);
