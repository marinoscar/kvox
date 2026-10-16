/**
 * Fixtures shared by the onboarding suites (issue #481, epic #478).
 *
 * NOT a `.test.ts` file, so `vitest.config.ts`'s `include` never treats it as a suite with no
 * assertions in it (the reason `home/homeFixtures.ts` is named the way it is).
 *
 * The step ids and `href`s below are the REAL ones from the API's registries
 * (`apps/api/src/platform/onboarding/`, `transcripts/transcripts.onboarding.ts`, ...). A fixture
 * with invented ids would still exercise the rendering, but it would stop being able to catch a
 * skip recorded against an id the server does not know.
 */

import type {
  OnboardingBlock,
  OnboardingResponse,
  OnboardingStep,
} from '@marinoscar/platform-web/onboarding/headless';

export function step(overrides: Partial<OnboardingStep> = {}): OnboardingStep {
  return {
    id: 'user.first_transcript',
    audience: 'user',
    tier: 'required',
    status: 'todo',
    title: 'Transcribe your first recording',
    description: 'Upload or record audio and get back a transcript you can correct.',
    actionLabel: 'New transcript',
    href: '/transcripts/new',
    detail: null,
    blockedReason: null,
    skippable: false,
    skipped: false,
    ...overrides,
  };
}

/** A block, with the counts DERIVED from its steps so a fixture cannot contradict its own rows. */
export function block(steps: OnboardingStep[]): OnboardingBlock {
  return {
    steps,
    completed: steps.filter((s) => s.status === 'done').length,
    total: steps.length,
    requiredDone: steps.filter((s) => s.tier === 'required').every((s) => s.status === 'done'),
    allResolved: steps.every((s) => s.status === 'done' || s.skipped),
  };
}

/** A whole `GET /api/onboarding` body. */
export function onboardingResponse(
  overrides: Partial<{
    user: OnboardingStep[];
    admin: OnboardingStep[] | null;
    settings: Partial<OnboardingResponse['settings']>;
  }> = {},
): OnboardingResponse {
  return {
    settings: {
      welcomeSeenAt: null,
      checklistDismissedAt: null,
      adminDismissedAt: null,
      skipped: [],
      ...overrides.settings,
    },
    user: block(overrides.user ?? [step()]),
    admin: overrides.admin === null || overrides.admin === undefined ? null : block(overrides.admin),
  } as OnboardingResponse;
}

export const USER_STEPS: OnboardingStep[] = [
  step({
    id: 'user.ai_key',
    title: 'Add your AI provider key',
    actionLabel: 'Add your key',
    href: '/settings/ai',
  }),
  step({
    id: 'user.first_transcript',
    status: 'blocked',
    blockedReason: 'Your administrator has not connected a transcription provider yet, so there is nothing to send a recording to.',
  }),
  step({
    id: 'user.first_note',
    tier: 'recommended',
    skippable: true,
    status: 'blocked',
    blockedReason: 'Add your own AI provider key first — notes are generated with it.',
    title: 'Generate your first note',
    actionLabel: 'New note',
    href: '/notes/new',
  }),
];

export const ADMIN_STEPS: OnboardingStep[] = [
  step({
    id: 'admin.transcription',
    audience: 'admin',
    title: 'Connect a transcription provider',
    actionLabel: 'Open transcription settings',
    href: '/admin/settings/transcription',
  }),
  step({
    id: 'admin.smoke_test',
    audience: 'admin',
    tier: 'recommended',
    skippable: true,
    status: 'blocked',
    blockedReason: 'Connect a transcription provider first — there is nothing to send a recording to yet.',
    title: 'Transcribe a test recording',
    actionLabel: 'Upload a recording',
    href: '/transcripts/new',
  }),
];
