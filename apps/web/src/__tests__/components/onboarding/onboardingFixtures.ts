/**
 * Fixtures shared by the onboarding suites — issue #276, epic #271.
 *
 * NOT a `.test.ts` file, so `vitest.config.ts`'s
 * `include: ['src/**\/*.{test,spec}.{ts,tsx}']` never treats it as a suite with
 * no assertions in it — the same reason `home/homeFixtures.ts` is named the way
 * it is.
 *
 * Collected here rather than re-declared per file because three suites render
 * the same two shapes: a divergence between "the checklist the component test
 * renders" and "the checklist the provider test serves over MSW" is how a
 * component passes its own suite and fails in the surface that mounts it.
 *
 * The step keys and `href`s below are the REAL ones from
 * `apps/api/src/onboarding/onboarding-steps.ts`. A fixture with invented keys
 * would still exercise the rendering, but it would stop being able to catch a
 * skip recorded against a key the server does not know — and a skip is recorded
 * against exactly this string (#272).
 */

import type {
  OnboardingState,
  OnboardingStepState,
} from '../../../services/onboarding';

export function step(overrides: Partial<OnboardingStepState> = {}): OnboardingStepState {
  return {
    key: 'user.first_transcript',
    tier: 'required',
    title: 'Record your first conversation',
    description: 'Upload a recording and get a transcript that knows who spoke.',
    actionLabel: 'New transcript',
    href: '/transcripts/new',
    status: 'pending',
    blockedReason: null,
    skippable: false,
    skipped: false,
    ...overrides,
  };
}

/**
 * A checklist, with the three counts DERIVED from the steps unless overridden.
 *
 * Derived here so a fixture cannot accidentally assert against counts that
 * contradict its own rows — which would let `applySkipOverlay`'s recount pass a
 * test by agreeing with a number that was wrong to begin with. A test that
 * wants the server and the rows to disagree passes the counts explicitly, and
 * that is then visibly the point of the test.
 */
export function onboardingState(
  overrides: Partial<OnboardingState> = {},
): OnboardingState {
  const steps = overrides.steps ?? [step()];
  const remaining = steps.filter((s) => s.status !== 'satisfied' && !s.skipped);
  const requiredRemaining = remaining.filter((s) => s.tier === 'required').length;

  return {
    audience: 'user',
    steps,
    requiredRemaining,
    totalRemaining: remaining.length,
    allRequiredSatisfied: requiredRemaining === 0,
    ...overrides,
  };
}

/** The user checklist a fresh account sees: one required step, one optional one. */
export function userState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return onboardingState({
    audience: 'user',
    steps: [
      step(),
      step({
        key: 'user.profile',
        tier: 'optional',
        title: 'Set your display name and picture',
        description: 'How you appear to anyone you share a transcript with.',
        actionLabel: 'Edit profile',
        href: '/settings/profile',
        skippable: true,
      }),
    ],
    ...overrides,
  });
}

/** The deployment checklist an administrator sees. */
export function adminState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return onboardingState({
    audience: 'admin',
    steps: [
      step({
        key: 'admin.transcription',
        title: 'Configure transcription',
        description: 'Pick a speech-to-text provider and add its key.',
        actionLabel: 'Configure',
        href: '/admin/settings/transcription',
      }),
      step({
        key: 'admin.backup',
        tier: 'recommended',
        title: 'Schedule a database backup',
        description: 'Take a copy of the database on a schedule you choose.',
        actionLabel: 'Set up backups',
        href: '/admin/settings/db-backup',
        skippable: true,
      }),
    ],
    ...overrides,
  });
}
