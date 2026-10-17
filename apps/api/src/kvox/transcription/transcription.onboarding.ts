import {
  type OnboardingFactDef,
  type OnboardingFacts,
  type OnboardingStepDef,
} from '@marinoscar/platform-api/onboarding';

import { TranscriptionConfigService } from '@marinoscar/kvox-api/transcription';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import { KVOX_ONBOARDING_FACTS } from '../../platform/onboarding/onboarding.facts';

// =============================================================================
// Transcription's onboarding contribution (issue #481; issues #274/#299, #460)
// =============================================================================
//
// The two administrator steps that are about transcription, and the one fact they (and
// `user.first_transcript`) depend on. Declared here, registered by `apps/api/src/kvox.manifest.ts`
// on the platform's onboarding registries; base code imports nothing from this folder.
//
// STEP IDS ARE PERMANENT (a user's `onboarding.skipped` stores them). Text, tiers, permissions
// and `skippable` flags moved verbatim from the retired `onboarding/` module; the status
// vocabulary is the platform's (`done`, `todo`, `blocked`).
// =============================================================================

/**
 * Whether this deployment can transcribe at all: `TranscriptionConfigService.getConfig().available`,
 * the four-fact conjunction that service documents (enabled, a provider chosen, that provider
 * registered in this build, a key stored for it). Read from that service rather than re-derived:
 * a second implementation of "is transcription usable" is how a checklist ends up green on a
 * deployment whose upload button is disabled.
 */
export const TRANSCRIPTION_AVAILABLE_FACT: OnboardingFactDef<boolean> = {
  id: KVOX_ONBOARDING_FACTS.TRANSCRIPTION_AVAILABLE,
  resolve: async (ctx) => (await ctx.get(TranscriptionConfigService).getConfig()).available,
};

export const TRANSCRIPTION_ONBOARDING_FACTS: readonly OnboardingFactDef[] = [
  TRANSCRIPTION_AVAILABLE_FACT,
];

function available(facts: OnboardingFacts): boolean {
  return facts[KVOX_ONBOARDING_FACTS.TRANSCRIPTION_AVAILABLE] as boolean;
}

export const ADMIN_TRANSCRIPTION_STEP: OnboardingStepDef = {
  id: 'admin.transcription',
  audience: 'admin',
  tier: 'required',
  // After the platform's `admin.storage` (10), before `admin.email` (20).
  order: 15,
  title: 'Connect a transcription provider',
  description:
    'Choose a speech-to-text provider and store its API key. Until this is done, nobody on this deployment can upload a recording.',
  actionLabel: 'Open transcription settings',
  href: '/admin/settings/transcription',
  // `transcription-settings.controller.ts` gates its reads on exactly this.
  permission: PERMISSIONS.SYSTEM_SETTINGS_READ,
  skippable: false,
  facts: [KVOX_ONBOARDING_FACTS.TRANSCRIPTION_AVAILABLE],
  evaluate: (facts) => ({ status: available(facts) ? 'done' : 'todo' }),
};

export const ADMIN_SMOKE_TEST_STEP: OnboardingStepDef = {
  id: 'admin.smoke_test',
  audience: 'admin',
  // RECOMMENDED, NOT REQUIRED, AND THAT IS WHAT MAKES IT SKIPPABLE (#299): the recording has to be
  // the administrator's own, it costs a real provider call, and a deployment can be correctly
  // configured by somebody who never intends to upload anything. A `required` step is never
  // skippable (refused at registration).
  tier: 'recommended',
  // After the platform's `admin.ai` (40), before `admin.push` (50).
  order: 45,
  title: 'Transcribe a test recording',
  description:
    'Upload a short recording and watch it come back as a transcript. This is the only step that proves the provider key you saved actually works.',
  actionLabel: 'Upload a recording',
  // The create surface, not a settings page: `POST /api/transcripts` enforces `transcripts:write`.
  href: '/transcripts/new',
  permission: PERMISSIONS.TRANSCRIPTS_WRITE,
  skippable: true,
  facts: [
    KVOX_ONBOARDING_FACTS.TRANSCRIPTION_AVAILABLE,
    KVOX_ONBOARDING_FACTS.OWN_READY_TRANSCRIPT_COUNT,
  ],
  evaluate: (facts) => {
    if ((facts[KVOX_ONBOARDING_FACTS.OWN_READY_TRANSCRIPT_COUNT] as number) > 0) {
      return { status: 'done' };
    }

    // BLOCKED, NOT TODO, while the provider is unconfigured. A skippable step especially must
    // distinguish "you cannot do this yet" from "you have declined this": an administrator who
    // reads an unexplained to-do as one they do not need would switch off the one check that
    // catches a wrong key.
    if (!available(facts)) {
      return {
        status: 'blocked',
        blockedReason:
          'Connect a transcription provider first — there is nothing to send a recording to yet.',
      };
    }

    return { status: 'todo' };
  },
};

export const TRANSCRIPTION_ONBOARDING_STEPS: readonly OnboardingStepDef[] = [
  ADMIN_TRANSCRIPTION_STEP,
  ADMIN_SMOKE_TEST_STEP,
];
