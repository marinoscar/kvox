import {
  ONBOARDING_FACTS,
  ONBOARDING_STEP_IDS,
  PLATFORM_ONBOARDING_STEPS,
  evaluateDoctorChecks,
  type OnboardingEvaluation,
  type OnboardingFacts,
  type OnboardingStepDef,
} from '@marinoscar/platform-api/onboarding';
import type { DoctorCheckReport } from '@marinoscar/platform-contract/doctor';

import { KVOX_ONBOARDING_FACTS, type KvoxAiOnboardingReadiness } from './onboarding.facts';

// =============================================================================
// This app's base onboarding steps (issue #481, epic #478)
// =============================================================================
//
// Two steps that read only base facts (the AI readiness of `ai-port/`):
//
//   user.ai_key   required     add your own AI provider key
//   admin.ai      recommended  the platform's built-in step, plus "at least one model" (below)
//
// The other five steps this app adds are declared beside their domain (base code may not
// import domain code) and registered by `kvox.manifest.ts`:
//
//   admin.transcription, admin.smoke_test   transcription/transcription.onboarding.ts
//   user.first_transcript                   transcripts/transcripts.onboarding.ts
//   user.first_note                         notes/notes.onboarding.ts
//
// The platform's other built-ins (`admin.storage`, `admin.email`, `admin.access`,
// `admin.push`, `admin.backup`, `user.profile`, `user.notifications`) are registered
// unchanged by `onboarding.manifest.ts`. They carry the ids this app's own steps had,
// so the stored `skipped` ids keep meaning the same step.
//
// STEP IDS ARE PERMANENT (a user's `onboarding.skipped` stores them). Titles, hrefs, tiers,
// permissions and skippable flags moved from the retired `apps/api/src/onboarding/` verbatim.
//
// A step never issues a query: every `evaluate` is a pure function of the facts it names
// (`onboarding.facts.ts`), which is what lets the engine bound a request's cost.
//
// ORDER. Within an audience the response sorts by `order`, then id, and the pages group
// by tier. The platform's steps own 10..70 (admin) and 10..20 (user). This app's sit between
// them (admin: transcription 15, after storage and before email; the smoke test 45, after AI)
// or ahead of them (user: ai_key 1, first_transcript 2, first_note 3, before the profile).
// `admin.email` (20) before `admin.access` (30) is the platform's, and still the right order:
// inviting somebody before outbound email works sends nothing at all.
// =============================================================================

/** `admin.ai` is the platform's step id. */
export const ADMIN_AI_STEP_ID = ONBOARDING_STEP_IDS.AI;

function ai(facts: OnboardingFacts): KvoxAiOnboardingReadiness {
  return facts[KVOX_ONBOARDING_FACTS.AI_READINESS] as KvoxAiOnboardingReadiness;
}

// -- user.ai_key ----------------------------------------------------------------

export const USER_AI_KEY_STEP: OnboardingStepDef = {
  id: 'user.ai_key',
  audience: 'user',
  tier: 'required',
  order: 1,
  title: 'Add your AI provider key',
  description:
    'Notes are generated with your own API key, billed to your own account. Nobody else on this deployment can see it.',
  actionLabel: 'Add your key',
  href: '/settings/ai',
  // NO PERMISSION ON THE STEP. The resource is the caller's own credential, scoped by the
  // caller's id in the query itself (the platform's `/api/ai/keys`).
  skippable: false,
  facts: [KVOX_ONBOARDING_FACTS.AI_READINESS],
  // Keyed on the provider slot being on, not on the deployment being fully set up: a
  // deployment whose OpenAI slot is off has no vendor a key could belong to, so the step is
  // absent rather than pending against nothing. Never blocked: a user may save a key before
  // the administrator has finished.
  applies: (facts) => ai(facts).providerSet,
  evaluate: (facts) => ({ status: ai(facts).hasKey ? 'done' : 'todo' }),
};

// -- admin.ai -------------------------------------------------------------------

const PLATFORM_ADMIN_AI = PLATFORM_ONBOARDING_STEPS.find((step) => step.id === ADMIN_AI_STEP_ID);

/**
 * `admin.ai`: the platform's built-in step, with one condition added.
 *
 * WHY NOT THE BUILT-IN AS IT IS. Its Doctor checks (`ai.enabled`, `ai.providers`) answer "AI is
 * on and a provider is enabled and able to serve a call". Under this app's `byok` policy they
 * need no deployment key, so they agree with this app's posture. They do NOT ask whether a
 * model is enabled in the catalogue, and this app's step always did: a deployment with OpenAI
 * on and an empty `ai_models` list cannot generate a note, and the built-in would call it done.
 * So the step is `done` only when the Doctor passes AND `kvox.aiReadiness.available` holds (AI
 * on, slot on, at least one model enabled, i.e. the old step's own test).
 *
 * Everything else is the platform's, copied from the built-in at load time: title, description,
 * href, permission (`ai_config:read`), tier (recommended), skippable, Doctor checks and order.
 * There is exactly ONE `admin.ai` in the registry: `onboarding.manifest.ts` registers this one
 * and leaves the built-in out, and `test/onboarding/onboarding-steps.spec.ts` pins the count.
 */
// PLATFORM-ADOPTION-SHIM(upstream platform: the built-in admin.ai ignores the model catalogue)
export const ADMIN_AI_STEP: OnboardingStepDef = (() => {
  if (!PLATFORM_ADMIN_AI) {
    throw new Error(`the platform no longer ships a built-in "${ADMIN_AI_STEP_ID}" step`);
  }
  const checks = PLATFORM_ADMIN_AI.doctorChecks ?? [];
  return {
    ...PLATFORM_ADMIN_AI,
    facts: [...PLATFORM_ADMIN_AI.facts, KVOX_ONBOARDING_FACTS.AI_READINESS],
    evaluate: (facts): OnboardingEvaluation => {
      const doctor = evaluateDoctorChecks(
        checks,
        facts[ONBOARDING_FACTS.DOCTOR] as ReadonlyMap<string, DoctorCheckReport> | undefined,
      );
      if (doctor.status !== 'done') return doctor;
      return ai(facts).available
        ? { status: 'done' }
        : {
            status: 'todo',
            detail: 'Enable at least one model on the AI settings page; notes cannot be generated without one.',
          };
    },
  };
})();

/** The steps the base registers beside the platform's (the domain steps are declared by the domains). */
export const KVOX_BASE_ONBOARDING_STEP_DEFS: readonly OnboardingStepDef[] = [ADMIN_AI_STEP, USER_AI_KEY_STEP];
