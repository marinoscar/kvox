// =============================================================================
// Transcription's onboarding contribution (issue #460, step 7; issues #274/#299)
// =============================================================================
//
// The two administrator steps that are about transcription, and the one fact
// they (and the account checklist's `user.first_transcript`) depend on. They
// used to be entries of `ADMIN_ONBOARDING_STEPS` and a field of the onboarding
// context, which made the onboarding module import this one. Declared here,
// registered by `apps/api/src/kvox.manifest.ts`; the onboarding module imports
// nothing from this folder.
//
// STEP KEYS ARE PERMANENT. They are persisted in each user's
// `onboarding.skipped[]`; the text, tiers, permissions and `skippable` flags
// below moved verbatim from `onboarding/onboarding-steps.ts`. `order` 10 and 30
// slot them around the base `admin.ai` (20) exactly where the array position
// used to put them.
// =============================================================================

import { PERMISSIONS } from '../common/constants/roles.constants';
import type {
  OnboardingAdminContext,
  OnboardingStep,
} from '../onboarding/onboarding-steps';
import type { OnboardingFactDef } from '../onboarding/onboarding.registries';
// Type-only: makes `transcripts.ownReadyCount` visible to this file's steps.
import type {} from '../transcripts/transcripts.onboarding';
import { TranscriptionConfigService } from './transcription-config.service';

declare module '../onboarding/onboarding.registries' {
  interface OnboardingFactValues {
    /** Whether this deployment can transcribe at all. */
    'transcription.available': boolean;
  }
}

/**
 * Whether this deployment can transcribe at all —
 * `TranscriptionConfigService.getConfig().available`, the four-fact conjunction
 * that service's header describes (enabled, a provider chosen, that provider
 * registered in this build, a key stored for it).
 *
 * Read from that service rather than re-derived: a second implementation of
 * "is transcription usable" is how a checklist ends up green on a deployment
 * whose upload button is disabled.
 */
export const TRANSCRIPTION_AVAILABLE_FACT: OnboardingFactDef<
  boolean,
  TranscriptionConfigService
> = {
  id: 'transcription.available',
  inject: TranscriptionConfigService,
  resolve: async (config) => (await config.getConfig()).available,
};

export const TRANSCRIPTION_ONBOARDING_FACTS: readonly OnboardingFactDef[] = [
  TRANSCRIPTION_AVAILABLE_FACT,
];

export const TRANSCRIPTION_ONBOARDING_STEPS: readonly OnboardingStep<OnboardingAdminContext>[] =
  [
    {
      key: 'admin.transcription',
      audience: 'admin',
      order: 10,
      facts: ['transcription.available'],
      tier: 'required',
      title: 'Connect a transcription provider',
      description:
        'Choose a speech-to-text provider and store its API key. Until this is done, nobody on this deployment can upload a recording.',
      actionLabel: 'Open transcription settings',
      href: '/admin/settings/transcription',
      // `transcription-settings.controller.ts` gates its reads on exactly this.
      permission: PERMISSIONS.SYSTEM_SETTINGS_READ,
      skippable: false,
      applies: () => true,
      evaluate: (ctx) => ({
        // The whole four-fact conjunction, borrowed rather than re-derived —
        // see the `transcription.available` fact below.
        status: ctx.facts['transcription.available'] ? 'satisfied' : 'pending',
      }),
    },
    {
      key: 'admin.smoke_test',
      audience: 'admin',
      order: 30,
      facts: ['transcription.available', 'transcripts.ownReadyCount'],
      // ⚠ RECOMMENDED, NOT REQUIRED, AND THAT IS WHAT MAKES IT SKIPPABLE (#299).
      // This is the one admin step that is not a form, and it is the one an
      // administrator may legitimately decline: the recording has to be theirs,
      // it costs a real provider call against the deployment's own account, and
      // a deployment can be genuinely, correctly configured by somebody who
      // never intends to upload anything themselves. Leaving it `required` left
      // the checklist unable to settle for that administrator, with no control
      // to say so — and it could not simply gain one, because a `required` step
      // is never skippable (see `OnboardingStep.skippable`). Demoting the tier
      // is the honest fix rather than the convenient one: a step the
      // administrator may decline is, by definition, not required.
      tier: 'recommended',
      title: 'Transcribe a test recording',
      description:
        'Upload a short recording and watch it come back as a transcript. This is the only step that proves the provider key you saved actually works.',
      actionLabel: 'Upload a recording',
      href: '/transcripts/new',
      // The destination is the create surface, not a settings page:
      // `transcripts.controller.ts` enforces `transcripts:write` on `POST
      // /api/transcripts`. Seeded to all three roles, so this never hides the
      // step from an administrator.
      permission: PERMISSIONS.TRANSCRIPTS_WRITE,
      skippable: true,
      applies: () => true,
      evaluate: (ctx) => {
        if (ctx.facts['transcripts.ownReadyCount'] > 0) {
          return { status: 'satisfied' };
        }

        // ⚠ BLOCKED, NOT PENDING, while the provider is unconfigured. A
        // SKIPPABLE step especially must distinguish "you cannot do this yet"
        // from "you have declined this": the skip control sits right there, and
        // an administrator who reads an unexplained to-do as one they do not
        // need is making that decision on bad information — they would be
        // switching off the one check that would have caught a wrong key,
        // believing they had merely opted out of a chore. So the step says what
        // is in the way, and the fix is the step directly above this one, which
        // is worth saying out loud rather than leaving them to notice the
        // ordering.
        if (!ctx.facts['transcription.available']) {
          return {
            status: 'blocked',
            blockedReason:
              'Connect a transcription provider first — there is nothing to send a recording to yet.',
          };
        }

        return { status: 'pending' };
      },
    },
  ];
