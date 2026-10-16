import type { OnboardingFactDef, OnboardingStepDef } from '@marinoscar/platform-api/onboarding';

import { PERMISSIONS } from '../common/constants/roles.constants';
import { KVOX_ONBOARDING_FACTS } from '../platform/onboarding/onboarding.facts';
import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// Transcripts' onboarding contribution (issue #481; issues #274/#275, #460)
// =============================================================================
//
// The account step "transcribe your first recording" and the two facts about the caller's own
// transcripts: how many exist (the user checklist) and how many reached `ready` (the
// administrator's `admin.smoke_test`, declared in `transcription/transcription.onboarding.ts`).
// Registered by `apps/api/src/kvox.manifest.ts`.
//
// STEP IDS ARE PERMANENT (a user's `onboarding.skipped` stores them).
// =============================================================================

/**
 * How many transcripts this caller owns that are not soft-deleted.
 *
 * ⚠ EXCLUDES SOFT-DELETED ROWS (`deletedAt: null`, the filter `transcripts.service.ts`'s own list
 * and summary queries use). A count that included them would tell a user who deleted their only
 * recording that they are still activated, and the checklist would never come back.
 */
export const TRANSCRIPTS_OWN_COUNT_FACT: OnboardingFactDef<number> = {
  id: KVOX_ONBOARDING_FACTS.OWN_TRANSCRIPT_COUNT,
  resolve: (ctx) =>
    ctx.get(PrismaService).transcript.count({ where: { ownerId: ctx.caller.id, deletedAt: null } }),
};

/** Transcripts this caller owns that reached `ready`: the evidence behind `admin.smoke_test`. */
export const TRANSCRIPTS_OWN_READY_COUNT_FACT: OnboardingFactDef<number> = {
  id: KVOX_ONBOARDING_FACTS.OWN_READY_TRANSCRIPT_COUNT,
  resolve: (ctx) =>
    ctx.get(PrismaService).transcript.count({
      where: { ownerId: ctx.caller.id, deletedAt: null, status: 'ready' },
    }),
};

export const TRANSCRIPTS_ONBOARDING_FACTS: readonly OnboardingFactDef[] = [
  TRANSCRIPTS_OWN_COUNT_FACT,
  TRANSCRIPTS_OWN_READY_COUNT_FACT,
];

export const USER_FIRST_TRANSCRIPT_STEP: OnboardingStepDef = {
  id: 'user.first_transcript',
  audience: 'user',
  tier: 'required',
  // Ahead of the platform's user steps (10, 20); after `user.ai_key` (1).
  order: 2,
  title: 'Transcribe your first recording',
  description:
    'Upload or record audio and get back a speaker-separated, timestamped transcript you can correct.',
  actionLabel: 'New transcript',
  href: '/transcripts/new',
  permission: PERMISSIONS.TRANSCRIPTS_WRITE,
  skippable: false,
  facts: [
    KVOX_ONBOARDING_FACTS.OWN_TRANSCRIPT_COUNT,
    KVOX_ONBOARDING_FACTS.TRANSCRIPTION_AVAILABLE,
  ],
  // The activation funnel: a cohort user who owns a live transcript.
  funnelSql:
    'EXISTS (SELECT 1 FROM transcripts t WHERE t.owner_id = c.id AND t.deleted_at IS NULL)',
  evaluate: (facts) => {
    if ((facts[KVOX_ONBOARDING_FACTS.OWN_TRANSCRIPT_COUNT] as number) > 0) {
      return { status: 'done' };
    }

    if (!(facts[KVOX_ONBOARDING_FACTS.TRANSCRIPTION_AVAILABLE] as boolean)) {
      return {
        status: 'blocked',
        // NAMES THE ADMINISTRATOR, because that is the entire difference between this and
        // `todo`: a user staring at a disabled upload button needs to know this is not their
        // to-do and not their mistake.
        blockedReason:
          'Your administrator has not connected a transcription provider yet, so there is nothing to send a recording to.',
      };
    }

    return { status: 'todo' };
  },
};

export const TRANSCRIPTS_ONBOARDING_STEPS: readonly OnboardingStepDef[] = [USER_FIRST_TRANSCRIPT_STEP];
