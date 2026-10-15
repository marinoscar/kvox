import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  OMNIPOTENT,
  buildOnboardingKit,
  callerWith,
  requireStep,
  stepOf,
  type KitFacts,
} from '../../test/helpers/onboarding-service.kit';
import {
  onboardingFactRegistry,
  onboardingStepRegistry,
} from '../onboarding/onboarding.registries';
import type { OnboardingState } from '../onboarding/dto/onboarding-state.dto';
import { TranscriptionConfigService } from '../transcription/transcription-config.service';
import {
  TRANSCRIPTS_ONBOARDING_FACTS,
  TRANSCRIPTS_ONBOARDING_STEPS,
  TRANSCRIPTS_OWN_COUNT_FACT,
  TRANSCRIPTS_OWN_READY_COUNT_FACT,
} from './transcripts.onboarding';

// =============================================================================
// Transcripts' onboarding contribution (issue #460, step 7)
// =============================================================================
//
// `user.first_transcript` and the two transcript counts, moved from
// `onboarding/onboarding.service.spec.ts`. Driven through the real service and
// the registry the manifest built, with Prisma and `TranscriptionConfigService`
// stubbed.
// =============================================================================

interface DomainFacts extends KitFacts {
  transcriptionAvailable?: boolean;
  transcriptCount?: number;
}

function build(facts: DomainFacts = {}) {
  const kit = buildOnboardingKit(facts);
  kit.provide(TranscriptionConfigService, {
    getConfig: jest.fn(kit.counted({ available: facts.transcriptionAvailable ?? true })),
  });
  const count = jest.fn(kit.counted(facts.transcriptCount ?? 0));
  kit.prisma.transcript = { count };
  // A user request also resolves `notes.ownCount` (the user.first_note step).
  kit.prisma.note = { count: jest.fn(kit.counted(0)) };
  return { ...kit, count };
}

async function userState(facts: DomainFacts = {}): Promise<OnboardingState> {
  return build(facts).service.getUserState(OMNIPOTENT);
}

describe('transcripts onboarding', () => {
  it('registers both facts and the step', () => {
    expect(onboardingFactRegistry.has('transcripts.ownCount')).toBe(true);
    expect(onboardingFactRegistry.has('transcripts.ownReadyCount')).toBe(true);
    expect(onboardingStepRegistry.has('user.first_transcript')).toBe(true);
    expect(TRANSCRIPTS_ONBOARDING_FACTS).toEqual([
      TRANSCRIPTS_OWN_COUNT_FACT,
      TRANSCRIPTS_OWN_READY_COUNT_FACT,
    ]);
  });

  it('keeps the permanent key, order, tier and facts of user.first_transcript', () => {
    const [step] = TRANSCRIPTS_ONBOARDING_STEPS;
    expect([step.key, step.audience, step.order, step.tier, step.skippable]).toEqual([
      'user.first_transcript',
      'user',
      20,
      'required',
      false,
    ]);
    expect(step.facts).toEqual(['transcripts.ownCount', 'transcription.available']);
  });

  describe('the counts', () => {
    it('counts only rows that are not soft-deleted', async () => {
      const stubs = build();
      await stubs.service.getUserState(OMNIPOTENT);

      // ⚠ `deletedAt: null`, matching `transcripts.service.ts`'s own visibility
      // filter — NOT `status: { not: 'deleting' }`, which is the plausible-
      // looking filter that would leave a purged-but-not-yet-collected row
      // counted.
      expect(stubs.count).toHaveBeenCalledWith({
        where: { ownerId: 'user-1', deletedAt: null },
      });
    });

    it('a user request never resolves the admin-only ready count', async () => {
      const stubs = build();
      await stubs.service.getUserState(OMNIPOTENT);

      expect(stubs.count).toHaveBeenCalledTimes(1);
      expect(stubs.count).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'ready' }) }),
      );
    });

    it('a user whose only transcript is soft-deleted is not activated', async () => {
      // The count comes back 0 because the filter excluded the row, which is
      // the behaviour under test — the step must go back to `pending` rather
      // than staying satisfied on the strength of a deleted recording.
      const state = await userState({ transcriptCount: 0 });

      expect(requireStep(state, 'user.first_transcript').status).toBe('pending');
    });
  });

  describe('user.first_transcript', () => {
    it('satisfied once the caller owns a transcript', async () => {
      const state = await userState({ transcriptCount: 1 });
      expect(requireStep(state, 'user.first_transcript').status).toBe('satisfied');
    });

    it('blocked, naming the administrator, when transcription is unconfigured', async () => {
      const state = await userState({
        transcriptCount: 0,
        transcriptionAvailable: false,
      });
      const step = requireStep(state, 'user.first_transcript');

      expect(step.status).toBe('blocked');
      // ⚠ THE SENTENCE ITSELF IS THE BEHAVIOUR. `blocked` exists to tell a user
      // that a disabled button is not their to-do and not their mistake, and it
      // only does that if the reason names the person who has to act.
      expect(step.blockedReason).toBe(
        'Your administrator has not connected a transcription provider yet, so there is nothing to send a recording to.',
      );
    });

    it('pending when transcription works and the caller has not used it', async () => {
      const state = await userState({
        transcriptCount: 0,
        transcriptionAvailable: true,
      });
      expect(requireStep(state, 'user.first_transcript').status).toBe('pending');
    });

    it('absent for a caller without `transcripts:write`', async () => {
      const state = await build().service.getUserState(callerWith([]));
      expect(stepOf(state, 'user.first_transcript')).toBeUndefined();
    });

    it('a blocked step counts as outstanding', async () => {
      // It is not satisfied, and a deployment that cannot transcribe has not
      // finished being set up merely because the reason belongs to somebody
      // else — saying so is what the banner is for.
      const state = await userState({
        transcriptionAvailable: false,
        transcriptCount: 0,
        ai: { keyConfigured: true },
        displayName: 'Ada',
      });

      expect(requireStep(state, 'user.first_transcript').status).toBe('blocked');
      expect(state.requiredRemaining).toBe(1);
      expect(state.allRequiredSatisfied).toBe(false);
    });

    it('is visible with only the permission it names', async () => {
      const state = await build().service.getUserState(
        callerWith([PERMISSIONS.TRANSCRIPTS_WRITE]),
      );
      expect(stepOf(state, 'user.first_transcript')).toBeDefined();
    });
  });
});
