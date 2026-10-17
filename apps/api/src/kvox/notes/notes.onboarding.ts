import type { OnboardingFactDef, OnboardingStepDef } from '@marinoscar/platform-api/onboarding';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import type { KvoxAiOnboardingReadiness } from '../../platform/onboarding/onboarding.facts';
import { KVOX_ONBOARDING_FACTS } from '../../platform/onboarding/onboarding.facts';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// Notes' onboarding contribution (issue #481; issues #274/#275, #460)
// =============================================================================
//
// The account step "generate your first note" and the one fact behind it, the caller's own
// note count. Registered by `apps/api/src/kvox.manifest.ts`.
//
// STEP IDS ARE PERMANENT (a user's `onboarding.skipped` stores them).
// =============================================================================

/**
 * How many notes this caller owns that are not soft-deleted (`deletedAt: null`, the visibility
 * filter `notes.service.ts` uses for its own lists). A count that included soft-deleted rows
 * would tell a user who deleted their only note that they are still activated.
 */
export const NOTES_OWN_COUNT_FACT: OnboardingFactDef<number> = {
  id: KVOX_ONBOARDING_FACTS.OWN_NOTE_COUNT,
  resolve: (ctx) =>
    ctx.get(PrismaService).note.count({ where: { ownerId: ctx.caller.id, deletedAt: null } }),
};

export const NOTES_ONBOARDING_FACTS: readonly OnboardingFactDef[] = [NOTES_OWN_COUNT_FACT];

export const USER_FIRST_NOTE_STEP: OnboardingStepDef = {
  id: 'user.first_note',
  audience: 'user',
  tier: 'recommended',
  // After `user.first_transcript` (2), ahead of the platform's user steps (10, 20).
  order: 3,
  title: 'Generate your first note',
  description:
    'Turn a transcript, a document or another note into a structured, editable note using a template.',
  actionLabel: 'New note',
  href: '/notes/new',
  permission: PERMISSIONS.NOTES_WRITE,
  skippable: true,
  facts: [KVOX_ONBOARDING_FACTS.OWN_NOTE_COUNT, KVOX_ONBOARDING_FACTS.AI_READINESS],
  funnelSql: 'EXISTS (SELECT 1 FROM notes n WHERE n.owner_id = c.id AND n.deleted_at IS NULL)',
  evaluate: (facts) => {
    if ((facts[KVOX_ONBOARDING_FACTS.OWN_NOTE_COUNT] as number) > 0) {
      return { status: 'done' };
    }

    const ai = facts[KVOX_ONBOARDING_FACTS.AI_READINESS] as KvoxAiOnboardingReadiness;

    // ⚠ ORDER MATTERS. The deployment's own readiness is checked FIRST: when its provider slot is
    // off `user.ai_key` is absent from the list entirely, so "add your key first" would point at a
    // step the user cannot see. Whoever has to act is named in each case, which is the one thing
    // `blocked` is for.
    if (!ai.available) {
      return {
        status: 'blocked',
        blockedReason:
          'Your administrator has not finished setting up AI generation for this deployment yet.',
      };
    }

    if (!ai.hasKey) {
      return {
        status: 'blocked',
        blockedReason: 'Add your own AI provider key first — notes are generated with it.',
      };
    }

    return { status: 'todo' };
  },
};

export const NOTES_ONBOARDING_STEPS: readonly OnboardingStepDef[] = [USER_FIRST_NOTE_STEP];
