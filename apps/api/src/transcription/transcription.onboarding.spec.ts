import {
  OMNIPOTENT,
  buildOnboardingKit,
  requireStep,
  type KitFacts,
} from '../../test/helpers/onboarding-service.kit';
import {
  onboardingFactRegistry,
  onboardingStepRegistry,
} from '../onboarding/onboarding.registries';
import type { OnboardingState } from '../onboarding/dto/onboarding-state.dto';
import { TranscriptionConfigService } from './transcription-config.service';
import {
  TRANSCRIPTION_AVAILABLE_FACT,
  TRANSCRIPTION_ONBOARDING_FACTS,
  TRANSCRIPTION_ONBOARDING_STEPS,
} from './transcription.onboarding';

// =============================================================================
// Transcription's onboarding contribution (issue #460, step 7)
// =============================================================================
//
// The transcription-specific cases that used to live in
// `onboarding/onboarding.service.spec.ts`: `admin.transcription`,
// `admin.smoke_test` and the `transcription.available` fact. They run through
// the REAL `OnboardingService` and the REAL registry the manifest built (this
// folder's steps and facts plus the transcripts fact `admin.smoke_test` reads),
// with `TranscriptionConfigService` and Prisma stubbed. That keeps the base
// spec free of domain imports while still proving the wiring end to end: the
// service finds the fact's provider through `ModuleRef`, resolves it once, and
// the step reads it from `ctx.facts`.
// =============================================================================

interface DomainFacts extends KitFacts {
  transcriptionAvailable?: boolean;
  readyTranscriptCount?: number;
}

function build(facts: DomainFacts = {}) {
  const kit = buildOnboardingKit(facts);
  const getConfig = jest.fn(kit.counted({ available: facts.transcriptionAvailable ?? true }));
  kit.provide(TranscriptionConfigService, { getConfig });
  kit.prisma.transcript = {
    count: jest.fn(kit.counted(facts.readyTranscriptCount ?? 0)),
  };
  return { ...kit, getConfig, transcriptCount: kit.prisma.transcript as { count: jest.Mock } };
}

async function adminState(facts: DomainFacts = {}): Promise<OnboardingState> {
  return build(facts).service.getAdminState(OMNIPOTENT);
}

describe('transcription onboarding', () => {
  describe('registration (as the manifest registered it)', () => {
    it('registers the fact and both steps', () => {
      expect(onboardingFactRegistry.has('transcription.available')).toBe(true);
      expect(onboardingStepRegistry.has('admin.transcription')).toBe(true);
      expect(onboardingStepRegistry.has('admin.smoke_test')).toBe(true);
    });

    it('keeps the permanent step keys, orders and tiers', () => {
      expect(
        TRANSCRIPTION_ONBOARDING_STEPS.map((s) => [s.key, s.audience, s.order, s.tier]),
      ).toEqual([
        ['admin.transcription', 'admin', 10, 'required'],
        ['admin.smoke_test', 'admin', 30, 'recommended'],
      ]);
    });

    it('a required step is not skippable; the recommended smoke test is', () => {
      const byKey = Object.fromEntries(TRANSCRIPTION_ONBOARDING_STEPS.map((s) => [s.key, s]));
      expect(byKey['admin.transcription'].skippable).toBe(false);
      expect(byKey['admin.smoke_test'].skippable).toBe(true);
    });

    it('declares exactly the facts each step reads', () => {
      const byKey = Object.fromEntries(TRANSCRIPTION_ONBOARDING_STEPS.map((s) => [s.key, s]));
      expect(byKey['admin.transcription'].facts).toEqual(['transcription.available']);
      expect(byKey['admin.smoke_test'].facts).toEqual([
        'transcription.available',
        'transcripts.ownReadyCount',
      ]);
    });

    it('exports the fact it declares', () => {
      expect(TRANSCRIPTION_ONBOARDING_FACTS).toEqual([TRANSCRIPTION_AVAILABLE_FACT]);
    });
  });

  describe('the transcription.available fact', () => {
    it('reads TranscriptionConfigService.getConfig().available', async () => {
      const getConfig = jest.fn(async () => ({ available: true }));
      await expect(
        TRANSCRIPTION_AVAILABLE_FACT.resolve({ getConfig } as unknown as TranscriptionConfigService, {
          callerId: 'user-1',
          audience: 'admin',
        }),
      ).resolves.toBe(true);

      getConfig.mockResolvedValue({ available: false });
      await expect(
        TRANSCRIPTION_AVAILABLE_FACT.resolve({ getConfig } as unknown as TranscriptionConfigService, {
          callerId: 'user-1',
          audience: 'user',
        }),
      ).resolves.toBe(false);
    });

    it('is injected from TranscriptionConfigService', () => {
      expect(TRANSCRIPTION_AVAILABLE_FACT.inject).toBe(TranscriptionConfigService);
    });

    it('is read once per request, however many steps use it', async () => {
      const stubs = build();
      await stubs.service.getAdminState(OMNIPOTENT);
      // admin.transcription and admin.smoke_test both name it.
      expect(stubs.getConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('admin.transcription', () => {
    it('satisfied when the deployment can transcribe', async () => {
      const state = await adminState({ transcriptionAvailable: true });
      expect(requireStep(state, 'admin.transcription').status).toBe('satisfied');
    });

    it('pending when it cannot', async () => {
      const state = await adminState({ transcriptionAvailable: false });
      expect(requireStep(state, 'admin.transcription').status).toBe('pending');
    });

    it('goes back to pending when the credential is removed, with nothing cleared', async () => {
      // The stored-completion failure mode, driven directly: the same caller,
      // the same everything, one fact flipped underneath — and no write anywhere
      // in between, because there is nothing to write.
      const configured = await adminState({ transcriptionAvailable: true });
      expect(requireStep(configured, 'admin.transcription').status).toBe('satisfied');

      const rotatedAway = await adminState({ transcriptionAvailable: false });
      expect(requireStep(rotatedAway, 'admin.transcription').status).toBe('pending');
    });
  });

  describe('admin.smoke_test', () => {
    it('satisfied once the caller owns a transcript that reached ready', async () => {
      const state = await adminState({ readyTranscriptCount: 1 });
      expect(requireStep(state, 'admin.smoke_test').status).toBe('satisfied');
    });

    it('stays satisfied after the provider is disconnected — the test did happen', async () => {
      const state = await adminState({
        readyTranscriptCount: 1,
        transcriptionAvailable: false,
      });
      expect(requireStep(state, 'admin.smoke_test').status).toBe('satisfied');
    });

    it('blocked, naming the step that has to land first, while no provider is connected', async () => {
      const state = await adminState({
        readyTranscriptCount: 0,
        transcriptionAvailable: false,
      });
      const step = requireStep(state, 'admin.smoke_test');

      expect(step.status).toBe('blocked');
      expect(step.blockedReason).toBe(
        'Connect a transcription provider first — there is nothing to send a recording to yet.',
      );
    });

    it('pending once a provider is connected and nothing has been transcribed', async () => {
      const state = await adminState({
        readyTranscriptCount: 0,
        transcriptionAvailable: true,
      });
      const step = requireStep(state, 'admin.smoke_test');

      expect(step.status).toBe('pending');
      expect(step.blockedReason).toBeNull();
    });

    it("counts only the caller's own READY transcripts", async () => {
      const stubs = build();
      await stubs.service.getAdminState(OMNIPOTENT);

      expect(stubs.transcriptCount.count).toHaveBeenCalledWith({
        where: { ownerId: 'user-1', deletedAt: null, status: 'ready' },
      });
    });
  });

  it('an administrator request resolves the admin facts and no step issues its own read', async () => {
    const stubs = build();
    await stubs.service.getAdminState(OMNIPOTENT);
    // 1 transcription config + 1 ready-transcript count, plus the base reads.
    expect(stubs.getConfig).toHaveBeenCalledTimes(1);
    expect(stubs.transcriptCount.count).toHaveBeenCalledTimes(1);
  });
});
