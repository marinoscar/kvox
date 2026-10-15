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
  NOTES_ONBOARDING_FACTS,
  NOTES_ONBOARDING_STEPS,
  NOTES_OWN_COUNT_FACT,
} from './notes.onboarding';

// =============================================================================
// Notes' onboarding contribution (issue #460, step 7)
// =============================================================================
//
// `user.first_note` and the caller's own note count, moved from
// `onboarding/onboarding.service.spec.ts`. Driven through the real service and
// the registry the manifest built, with Prisma stubbed. (The other registered
// user steps resolve `transcription.available`/`transcripts.ownCount` in the
// same request, so those providers are stubbed too.)
// =============================================================================

interface DomainFacts extends KitFacts {
  noteCount?: number;
}

function build(facts: DomainFacts = {}) {
  const kit = buildOnboardingKit(facts);
  kit.provide(TranscriptionConfigService, {
    getConfig: jest.fn(kit.counted({ available: true })),
  });
  const noteCount = jest.fn(kit.counted(facts.noteCount ?? 0));
  kit.prisma.note = { count: noteCount };
  kit.prisma.transcript = { count: jest.fn(kit.counted(0)) };
  return { ...kit, noteCount };
}

async function userState(facts: DomainFacts = {}): Promise<OnboardingState> {
  return build(facts).service.getUserState(OMNIPOTENT);
}

describe('notes onboarding', () => {
  it('registers the fact and the step', () => {
    expect(onboardingFactRegistry.has('notes.ownCount')).toBe(true);
    expect(onboardingStepRegistry.has('user.first_note')).toBe(true);
    expect(NOTES_ONBOARDING_FACTS).toEqual([NOTES_OWN_COUNT_FACT]);
  });

  it('keeps the permanent key, order, tier and facts of user.first_note', () => {
    const [step] = NOTES_ONBOARDING_STEPS;
    expect([step.key, step.audience, step.order, step.tier, step.skippable]).toEqual([
      'user.first_note',
      'user',
      30,
      'recommended',
      true,
    ]);
    expect(step.facts).toEqual(['notes.ownCount']);
  });

  it('counts only rows that are not soft-deleted', async () => {
    const stubs = build();
    await stubs.service.getUserState(OMNIPOTENT);

    // ⚠ `deletedAt: null`, matching `notes.service.ts`'s own visibility filter.
    expect(stubs.noteCount).toHaveBeenCalledWith({
      where: { ownerId: 'user-1', deletedAt: null },
    });
  });

  describe('user.first_note', () => {
    it('satisfied once the caller owns a note', async () => {
      const state = await userState({ noteCount: 1 });
      expect(requireStep(state, 'user.first_note').status).toBe('satisfied');
    });

    it('blocked, naming the administrator, when the deployment cannot generate', async () => {
      const state = await userState({
        noteCount: 0,
        ai: { available: false, keyConfigured: false },
      });
      const step = requireStep(state, 'user.first_note');

      expect(step.status).toBe('blocked');
      // ⚠ THE DEPLOYMENT'S READINESS IS CHECKED FIRST, and the reason proves
      // it: with no key AND no AI, pointing at `user.ai_key` would be pointing
      // at a step that may not even be in this list.
      expect(step.blockedReason).toBe(
        'Your administrator has not finished setting up AI generation for this deployment yet.',
      );
    });

    it("blocked, naming the caller's own key, when AI works but they have none", async () => {
      const state = await userState({
        noteCount: 0,
        ai: { available: true, keyConfigured: false },
      });
      const step = requireStep(state, 'user.first_note');

      expect(step.status).toBe('blocked');
      expect(step.blockedReason).toBe(
        'Add your own AI provider key first — notes are generated with it.',
      );
    });

    it('pending when everything is in place and nothing has been generated', async () => {
      const state = await userState({
        noteCount: 0,
        ai: { available: true, keyConfigured: true },
      });
      expect(requireStep(state, 'user.first_note').status).toBe('pending');
    });

    it('absent for a caller without `notes:write`', async () => {
      const state = await build().service.getUserState(
        callerWith([PERMISSIONS.TRANSCRIPTS_WRITE]),
      );
      expect(stepOf(state, 'user.first_note')).toBeUndefined();
    });
  });

  it('the checklist keeps first_transcript before first_note', async () => {
    const state = await userState({ ai: { keyConfigured: true } });
    const keys = state.steps.map((step) => step.key);
    expect(keys).toEqual([
      'user.ai_key',
      'user.first_transcript',
      'user.first_note',
      'user.profile',
    ]);
  });
});
