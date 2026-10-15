// =============================================================================
// Notes' onboarding contribution (issue #460, step 7; issues #274/#275)
// =============================================================================
//
// The account step "generate your first note" and the one fact behind it, the
// caller's own note count. Declared here, registered by
// `apps/api/src/kvox.manifest.ts`; the onboarding module imports nothing from
// this folder.
//
// STEP KEYS ARE PERMANENT (persisted in `onboarding.skipped[]`). The step moved
// verbatim from `onboarding/onboarding-steps.ts`; `order` 30 keeps it third,
// after `user.first_transcript` (20).
// =============================================================================

import { PERMISSIONS } from '../common/constants/roles.constants';
import type {
  OnboardingStep,
  OnboardingUserContext,
} from '../onboarding/onboarding-steps';
import type { OnboardingFactDef } from '../onboarding/onboarding.registries';
import { PrismaService } from '../prisma/prisma.service';

declare module '../onboarding/onboarding.registries' {
  interface OnboardingFactValues {
    /** Notes the caller owns that are not soft-deleted. */
    'notes.ownCount': number;
  }
}

/**
 * How many notes this caller owns that are not soft-deleted (`deletedAt: null`,
 * the same visibility filter `notes.service.ts` uses for its own lists). A count
 * that included soft-deleted rows would tell a user who deleted their only note
 * that they are still activated.
 */
export const NOTES_OWN_COUNT_FACT: OnboardingFactDef<number, PrismaService> = {
  id: 'notes.ownCount',
  inject: PrismaService,
  resolve: (prisma, { callerId }) =>
    prisma.note.count({ where: { ownerId: callerId, deletedAt: null } }),
};

export const NOTES_ONBOARDING_FACTS: readonly OnboardingFactDef[] = [NOTES_OWN_COUNT_FACT];

export const NOTES_ONBOARDING_STEPS: readonly OnboardingStep<OnboardingUserContext>[] = [
    {
      key: 'user.first_note',
      audience: 'user',
      order: 30,
      facts: ['notes.ownCount'],
      tier: 'recommended',
      title: 'Generate your first note',
      description:
        'Turn a transcript, a document or another note into a structured, editable note using a template.',
      actionLabel: 'New note',
      href: '/notes/new',
      permission: PERMISSIONS.NOTES_WRITE,
      skippable: true,
      applies: () => true,
      evaluate: (ctx) => {
        if (ctx.facts['notes.ownCount'] > 0) {
          return { status: 'satisfied' };
        }

        // ⚠ ORDER MATTERS, AND IT IS NOT ARBITRARY. The deployment's own
        // readiness is checked FIRST: when no vendor is configured `user.ai_key`
        // is absent from this list entirely, so "add your key first" would point
        // at a step the user cannot see. Whoever has to act is named in each
        // case, which is the one thing `blocked` is for.
        if (!ctx.ai.available) {
          return {
            status: 'blocked',
            blockedReason:
              'Your administrator has not finished setting up AI generation for this deployment yet.',
          };
        }

        if (!ctx.ai.keyConfigured) {
          return {
            status: 'blocked',
            blockedReason:
              'Add your own AI provider key first — notes are generated with it.',
          };
        }

        return { status: 'pending' };
      },
    },
];
