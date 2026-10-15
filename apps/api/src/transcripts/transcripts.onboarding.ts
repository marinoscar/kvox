// =============================================================================
// Transcripts' onboarding contribution (issue #460, step 7; issues #274/#275)
// =============================================================================
//
// The account step "transcribe your first recording" and the two facts about
// the caller's own transcripts: how many exist (the user checklist) and how many
// reached `ready` (the administrator's `admin.smoke_test`, declared in
// `transcription/transcription.onboarding.ts`). Declared here, registered by
// `apps/api/src/kvox.manifest.ts`; the onboarding module imports nothing from
// this folder.
//
// STEP KEYS ARE PERMANENT (persisted in `onboarding.skipped[]`). The step moved
// verbatim from `onboarding/onboarding-steps.ts`; `order` 20 keeps it second,
// after the base `user.ai_key` (10).
// =============================================================================

import { PERMISSIONS } from '../common/constants/roles.constants';
import type {
  OnboardingStep,
  OnboardingUserContext,
} from '../onboarding/onboarding-steps';
import type { OnboardingFactDef } from '../onboarding/onboarding.registries';
import { PrismaService } from '../prisma/prisma.service';

// Type-only: makes `transcription.available` visible to this file's steps.
import type {} from '../transcription/transcription.onboarding';

declare module '../onboarding/onboarding.registries' {
  interface OnboardingFactValues {
    /** Transcripts the caller owns that are not soft-deleted. */
    'transcripts.ownCount': number;
    /** Transcripts the caller owns that reached `ready` (not soft-deleted). */
    'transcripts.ownReadyCount': number;
  }
}

/**
 * How many transcripts this caller owns that are not soft-deleted.
 *
 * ⚠ EXCLUDES SOFT-DELETED ROWS (`deletedAt: null`, the same filter
 * `transcripts.service.ts`'s own list and summary queries use). A count that
 * included them would tell a user who deleted their only recording that they
 * are still activated, and the checklist would never come back.
 */
export const TRANSCRIPTS_OWN_COUNT_FACT: OnboardingFactDef<number, PrismaService> = {
  id: 'transcripts.ownCount',
  inject: PrismaService,
  resolve: (prisma, { callerId }) =>
    prisma.transcript.count({ where: { ownerId: callerId, deletedAt: null } }),
};

/**
 * Transcripts this caller owns that reached `ready` — the evidence behind
 * `admin.smoke_test`. Soft-deleted rows excluded, as above.
 */
export const TRANSCRIPTS_OWN_READY_COUNT_FACT: OnboardingFactDef<number, PrismaService> = {
  id: 'transcripts.ownReadyCount',
  inject: PrismaService,
  resolve: (prisma, { callerId }) =>
    prisma.transcript.count({
      where: { ownerId: callerId, deletedAt: null, status: 'ready' },
    }),
};

export const TRANSCRIPTS_ONBOARDING_FACTS: readonly OnboardingFactDef[] = [
  TRANSCRIPTS_OWN_COUNT_FACT,
  TRANSCRIPTS_OWN_READY_COUNT_FACT,
];

export const TRANSCRIPTS_ONBOARDING_STEPS: readonly OnboardingStep<OnboardingUserContext>[] =
  [
    {
      key: 'user.first_transcript',
      audience: 'user',
      order: 20,
      facts: ['transcripts.ownCount', 'transcription.available'],
      tier: 'required',
      title: 'Transcribe your first recording',
      description:
        'Upload or record audio and get back a speaker-separated, timestamped transcript you can correct.',
      actionLabel: 'New transcript',
      href: '/transcripts/new',
      permission: PERMISSIONS.TRANSCRIPTS_WRITE,
      skippable: false,
      applies: () => true,
      evaluate: (ctx) => {
        if (ctx.facts['transcripts.ownCount'] > 0) {
          return { status: 'satisfied' };
        }

        if (!ctx.facts['transcription.available']) {
          return {
            status: 'blocked',
            // ⚠ NAMES THE ADMINISTRATOR, because that is the entire difference
            // between this and `pending`. A user staring at a disabled upload
            // button needs to know this is not their to-do and not their
            // mistake — it is somebody else's, and no amount of trying again
            // will change it.
            blockedReason:
              'Your administrator has not connected a transcription provider yet, so there is nothing to send a recording to.',
          };
        }

        return { status: 'pending' };
      },
    },
  ];
