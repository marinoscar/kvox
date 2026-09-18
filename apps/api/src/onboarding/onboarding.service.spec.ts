import { PERMISSIONS } from '../common/constants/roles.constants';
import { ONBOARDING_STEP_KEY_PATTERN } from '../common/schemas/user-settings-namespaces.schema';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import type { AiConfigService } from '../ai/ai-config.service';
import type { EmailSettingsService } from '../email/email-settings.service';
import type { PushConfigService } from '../notifications/push-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import type { UserSettingsService } from '../settings/user-settings/user-settings.service';
import type { TranscriptionConfigService } from '../transcription/transcription-config.service';
import {
  ADMIN_ONBOARDING_STEPS,
  USER_ONBOARDING_STEPS,
  type OnboardingAdminContext,
  type OnboardingStep,
  type OnboardingUserContext,
} from './onboarding-steps';
import { OnboardingService } from './onboarding.service';
import type { OnboardingState, OnboardingStepState } from './dto/onboarding-state.dto';

// =============================================================================
// OnboardingService — the registry's truth table and its two invariants (#274)
// =============================================================================
//
// Three kinds of test live here, and the last two are the reason the file
// exists at all — the truth table would be worth writing anyway, but the
// invariants below are properties nothing else in the codebase can enforce.
//
//   1. A PER-STEP TRUTH TABLE. One case per status each step can produce,
//      including every `blockedReason`. A `blocked` status whose reason is
//      never asserted is a sentence a user reads and no test has ever seen.
//
//   2. PURITY. Every step is driven against a DEEP-FROZEN context with every
//      collaborator stub reset, and the suite then asserts that not one stub
//      was called. That is the executable form of "a step never issues its own
//      query": a step reaching for Prisma or a service would show up as a call
//      count, and a step mutating the context it was handed would throw on the
//      frozen object.
//
//   3. A BOUNDED READ COUNT. The suite counts the reads one request performs,
//      ADDS A STEP TO THE REGISTRY AT TEST TIME, and asserts the count is
//      unchanged while the new step still appears in the response. Asserting a
//      fixed number instead would pass just as happily on a design where every
//      step queried — it would only need updating, which is exactly what
//      somebody adding the eleventh step would do without noticing.
//
// The registries are typed `readonly ... []`, which is a compile-time
// statement about intent rather than a frozen array — so test 3 can push onto
// them through a cast and must put them back in a `finally`. That cast is
// confined to `withExtraStep` below and belongs nowhere else.
// =============================================================================

// -----------------------------------------------------------------------------
// Stubs. Every one of them counts its calls into a shared total, which is what
// makes tests 2 and 3 possible.
// -----------------------------------------------------------------------------

interface Stubs {
  service: OnboardingService;
  reads: () => number;
  resetReads: () => void;
  prisma: {
    transcript: { count: jest.Mock };
    note: { count: jest.Mock };
    user: { count: jest.Mock };
    allowedEmail: { count: jest.Mock };
  };
  emailSettings: { describeForAdmin: jest.Mock };
  pushConfig: { describeForAdmin: jest.Mock };
  systemSettings: { getAiPolicy: jest.Mock; getDatabaseBackupPolicy: jest.Mock };
}

interface Facts {
  transcriptionAvailable?: boolean;
  ai?: Partial<OnboardingUserContext['ai']>;
  aiPolicy?: Partial<OnboardingAdminContext['aiPolicy']>;
  emailProvider?: 'smtp' | null;
  emailEnabled?: boolean;
  pushConfigured?: boolean;
  pushEnabled?: boolean;
  backupEnabled?: boolean;
  transcriptCount?: number;
  readyTranscriptCount?: number;
  noteCount?: number;
  userCount?: number;
  allowedEmailCount?: number;
  displayName?: string | null;
  skipped?: string[];
}

function build(facts: Facts = {}): Stubs {
  let reads = 0;
  const counted =
    <T>(value: T) =>
    (): Promise<T> => {
      reads += 1;
      return Promise.resolve(value);
    };

  const transcriptCount = facts.transcriptCount ?? 0;
  const readyTranscriptCount = facts.readyTranscriptCount ?? 0;

  const prisma = {
    transcript: {
      // The admin builder asks for `status: 'ready'`; the user builder does
      // not. One mock serves both by reading the filter it was handed, which
      // also means a builder that silently dropped `deletedAt` would still be
      // caught by the dedicated assertion below rather than here.
      count: jest.fn((args: { where?: { status?: string } }) => {
        reads += 1;
        return Promise.resolve(
          args?.where?.status === 'ready' ? readyTranscriptCount : transcriptCount,
        );
      }),
    },
    note: { count: jest.fn(counted(facts.noteCount ?? 0)) },
    user: { count: jest.fn(counted(facts.userCount ?? 1)) },
    allowedEmail: { count: jest.fn(counted(facts.allowedEmailCount ?? 1)) },
  };

  const transcriptionConfig = {
    getConfig: jest.fn(counted({ available: facts.transcriptionAvailable ?? true })),
  };

  const aiConfig = {
    getConfig: jest.fn(
      counted({
        available: true,
        provider: 'openai',
        providerLabel: 'OpenAI',
        keyConfigured: true,
        ...facts.ai,
      }),
    ),
  };

  // ⚠ `in`, not `??`. Both of the facts below are legitimately `null`, and a
  // `??` default would quietly turn the two cases this suite most needs to
  // drive — no AI provider chosen, no display name set — back into the
  // configured ones, passing every assertion for the wrong reason.
  const displayName =
    'displayName' in facts ? (facts.displayName ?? null) : 'Ada Lovelace';
  const aiProvider =
    facts.aiPolicy && 'provider' in facts.aiPolicy
      ? (facts.aiPolicy.provider ?? null)
      : 'openai';

  const userSettings = {
    getSettings: jest.fn(
      counted({
        profile: { displayName },
        ...(facts.skipped ? { onboarding: { skipped: facts.skipped } } : {}),
      }),
    ),
  };

  const systemSettings = {
    getAiPolicy: jest.fn(
      counted({
        enabled: facts.aiPolicy?.enabled ?? true,
        provider: aiProvider,
        providers: {
          openai: {
            allowedModels: Array.from(
              { length: facts.aiPolicy?.allowedModelCount ?? 1 },
              (_, index) => ({ id: `model-${index}` }),
            ),
          },
        },
      }),
    ),
    getDatabaseBackupPolicy: jest.fn(counted({ enabled: facts.backupEnabled ?? true })),
  };

  const emailSettings = {
    describeForAdmin: jest.fn(
      counted({
        provider: facts.emailProvider === undefined ? 'smtp' : facts.emailProvider,
        enabled: facts.emailEnabled ?? true,
      }),
    ),
  };

  const pushConfig = {
    describeForAdmin: jest.fn(
      counted({
        configured: facts.pushConfigured ?? true,
        enabled: facts.pushEnabled ?? true,
      }),
    ),
  };

  const service = new OnboardingService(
    prisma as unknown as PrismaService,
    transcriptionConfig as unknown as TranscriptionConfigService,
    aiConfig as unknown as AiConfigService,
    userSettings as unknown as UserSettingsService,
    systemSettings as unknown as SystemSettingsService,
    emailSettings as unknown as EmailSettingsService,
    pushConfig as unknown as PushConfigService,
  );

  return {
    service,
    reads: () => reads,
    resetReads: () => {
      reads = 0;
      for (const stub of [
        prisma.transcript.count,
        prisma.note.count,
        prisma.user.count,
        prisma.allowedEmail.count,
        transcriptionConfig.getConfig,
        aiConfig.getConfig,
        userSettings.getSettings,
        systemSettings.getAiPolicy,
        systemSettings.getDatabaseBackupPolicy,
        emailSettings.describeForAdmin,
        pushConfig.describeForAdmin,
      ]) {
        stub.mockClear();
      }
    },
    prisma,
    emailSettings,
    pushConfig,
    systemSettings,
  };
}

/** A caller holding every permission any step names, so nothing is filtered. */
const OMNIPOTENT: RequestUser = {
  id: 'user-1',
  email: 'ada@example.com',
  roles: ['admin'],
  permissions: Object.values(PERMISSIONS),
  isActive: true,
};

function user(permissions: string[]): RequestUser {
  return { ...OMNIPOTENT, permissions };
}

function stepOf(state: OnboardingState, key: string): OnboardingStepState | undefined {
  return state.steps.find((step) => step.key === key);
}

/** The step named, asserted present — so a typo in a key fails loudly. */
function requireStep(state: OnboardingState, key: string): OnboardingStepState {
  const step = stepOf(state, key);
  if (!step) {
    throw new Error(`Expected step ${key} in the ${state.audience} checklist`);
  }
  return step;
}

async function userState(facts: Facts = {}): Promise<OnboardingState> {
  return build(facts).service.getUserState(OMNIPOTENT);
}

async function adminState(facts: Facts = {}): Promise<OnboardingState> {
  return build(facts).service.getAdminState(OMNIPOTENT);
}

// =============================================================================

describe('OnboardingService', () => {
  // ---------------------------------------------------------------------------
  // Registry invariants — properties of the entries themselves
  // ---------------------------------------------------------------------------

  describe('the registry', () => {
    const everyStep: OnboardingStep<never>[] = [
      ...(ADMIN_ONBOARDING_STEPS as readonly OnboardingStep<never>[]),
      ...(USER_ONBOARDING_STEPS as readonly OnboardingStep<never>[]),
    ];

    it('a `required` step is never skippable', () => {
      for (const step of everyStep) {
        if (step.tier === 'required') {
          expect([step.key, step.skippable]).toEqual([step.key, false]);
        }
      }
    });

    it("every `permission` is a real constant, not a string invented here", () => {
      // ⚠ ASSERTED AGAINST `PERMISSIONS` ITSELF rather than against a list of
      // literals copied into this file. A duplicated list would agree with a
      // typo as readily as with the truth — and the failure a step's permission
      // string can cause is silent in both directions: the step is either
      // advertised to people who will be refused at the destination, or hidden
      // from people who would not be.
      const known = new Set<string>(Object.values(PERMISSIONS));

      for (const step of everyStep) {
        if (step.permission !== undefined) {
          expect([step.key, known.has(step.permission)]).toEqual([step.key, true]);
        }
      }
    });

    it('every key is skippable-by-the-schema and unique', () => {
      // A key the `onboarding` namespace's own bound rejects is a step that
      // cannot be skipped: the PATCH recording the skip would 400 with no
      // checklist change in sight (#272).
      const keys = everyStep.map((step) => step.key);

      for (const key of keys) {
        expect([key, ONBOARDING_STEP_KEY_PATTERN.test(key)]).toEqual([key, true]);
      }

      expect(new Set(keys).size).toBe(keys.length);
    });

    it('every step declares the audience of the array it is in', () => {
      for (const step of ADMIN_ONBOARDING_STEPS) expect(step.audience).toBe('admin');
      for (const step of USER_ONBOARDING_STEPS) expect(step.audience).toBe('user');
    });

    it('orders `admin.email` before `admin.access`', () => {
      // ⚠ LOAD-BEARING ORDER, NOT EDITORIAL (#300), which is why it is pinned
      // here beside the other registry invariants rather than left to reading.
      //
      // Adding an address to the allowlist — `admin.access` — is what fires
      // `allowlist.invitation`, and that event declares `channels: ['email']`
      // and nothing else, because its recipient has no account, no session and
      // no open tab at the moment it fires. So an invitation issued before
      // outbound email works sends nothing at all, to nobody, with no failure
      // surfaced to either party. The checklist teaches the order that works.
      //
      // `OnboardingService.render` never sorts, so this array's order IS the
      // order an administrator reads ('returns the registry order' below pins
      // that half). Without this assertion the dependency is invisible and a
      // later edit reverses it silently.
      const keys = ADMIN_ONBOARDING_STEPS.map((step) => step.key);

      expect(keys).toContain('admin.email');
      expect(keys).toContain('admin.access');
      expect(keys.indexOf('admin.email')).toBeLessThan(keys.indexOf('admin.access'));
    });

    it('every href is root-relative', () => {
      for (const step of everyStep) {
        expect([step.key, step.href.startsWith('/')]).toEqual([step.key, true]);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Invariant 1: purity — `ctx` is the only argument, and nothing else is read
  // ---------------------------------------------------------------------------

  describe('step purity', () => {
    it('takes ctx as its only argument, mutates nothing, and reads no collaborator', async () => {
      const stubs = build();

      // Build both contexts through the real service, then evaluate every step
      // against a FROZEN copy with the call counters cleared. Any read a step
      // performs for itself lands on a stub and is counted; any write to the
      // context it was handed throws.
      const userSnapshot = await stubs.service.buildUserContext('user-1');
      const adminSnapshot = await stubs.service.buildAdminContext('user-1');
      stubs.resetReads();

      const frozenUser = deepFreeze(userSnapshot.context);
      const frozenAdmin = deepFreeze(adminSnapshot.context);

      for (const step of USER_ONBOARDING_STEPS) {
        expect(step.applies.length).toBeLessThanOrEqual(1);
        expect(step.evaluate.length).toBeLessThanOrEqual(1);
        step.applies(frozenUser);
        step.evaluate(frozenUser);
      }

      for (const step of ADMIN_ONBOARDING_STEPS) {
        expect(step.applies.length).toBeLessThanOrEqual(1);
        expect(step.evaluate.length).toBeLessThanOrEqual(1);
        step.applies(frozenAdmin);
        step.evaluate(frozenAdmin);
      }

      // ⚠ THE ASSERTION THAT MATTERS: evaluating the WHOLE registry, twice
      // over, performed exactly zero reads.
      expect(stubs.reads()).toBe(0);
      expect(stubs.prisma.transcript.count).not.toHaveBeenCalled();
      expect(stubs.prisma.note.count).not.toHaveBeenCalled();
      expect(stubs.prisma.user.count).not.toHaveBeenCalled();
      expect(stubs.prisma.allowedEmail.count).not.toHaveBeenCalled();
      expect(stubs.emailSettings.describeForAdmin).not.toHaveBeenCalled();
      expect(stubs.pushConfig.describeForAdmin).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Invariant 2: the read count does not grow with the registry
  // ---------------------------------------------------------------------------

  describe('bounded read count', () => {
    /**
     * Run `body` with one extra step appended to `registry`, then restore it.
     *
     * The cast is the only one in this file: the arrays are `readonly` as a
     * statement of intent, not as a frozen object, and this is the one test
     * that has a legitimate reason to make the registry longer.
     */
    async function withExtraStep<Ctx>(
      registry: readonly OnboardingStep<never>[],
      body: () => Promise<void>,
    ): Promise<void> {
      const mutable = registry as OnboardingStep<never>[];
      mutable.push({
        key: 'test.extra_step',
        audience: registry === (ADMIN_ONBOARDING_STEPS as unknown) ? 'admin' : 'user',
        tier: 'recommended',
        title: 'An extra step added at test time',
        description: 'Exists only to prove that adding a step costs no reads.',
        actionLabel: 'Go',
        href: '/',
        skippable: true,
        applies: () => true,
        evaluate: () => ({ status: 'pending' }),
      } as OnboardingStep<never>);

      try {
        await body();
      } finally {
        mutable.pop();
      }
    }

    it('adding a user step changes the number of reads by zero', async () => {
      const before = build();
      await before.service.getUserState(OMNIPOTENT);
      const baseline = before.reads();

      await withExtraStep(
        USER_ONBOARDING_STEPS as readonly OnboardingStep<never>[],
        async () => {
          const after = build();
          const state = await after.service.getUserState(OMNIPOTENT);

          // The step really was evaluated — otherwise an unchanged read count
          // would prove nothing at all.
          expect(stepOf(state, 'test.extra_step')?.status).toBe('pending');
          expect(after.reads()).toBe(baseline);
        },
      );
    });

    it('adding an admin step changes the number of reads by zero', async () => {
      const before = build();
      await before.service.getAdminState(OMNIPOTENT);
      const baseline = before.reads();

      await withExtraStep(
        ADMIN_ONBOARDING_STEPS as readonly OnboardingStep<never>[],
        async () => {
          const after = build();
          const state = await after.service.getAdminState(OMNIPOTENT);

          expect(stepOf(state, 'test.extra_step')?.status).toBe('pending');
          expect(after.reads()).toBe(baseline);
        },
      );
    });

    it('the user request never reads an admin-only fact', async () => {
      // The structural half of #275's argument, at the unit level: the
      // integration suite asserts the same thing through the wire.
      const stubs = build();
      await stubs.service.getUserState(OMNIPOTENT);

      expect(stubs.emailSettings.describeForAdmin).not.toHaveBeenCalled();
      expect(stubs.pushConfig.describeForAdmin).not.toHaveBeenCalled();
      expect(stubs.systemSettings.getDatabaseBackupPolicy).not.toHaveBeenCalled();
      expect(stubs.prisma.user.count).not.toHaveBeenCalled();
      expect(stubs.prisma.allowedEmail.count).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Soft deletion
  // ---------------------------------------------------------------------------

  describe('content counts', () => {
    it('counts only rows that are not soft-deleted', async () => {
      const stubs = build();
      await stubs.service.getUserState(OMNIPOTENT);

      // ⚠ `deletedAt: null`, matching `transcripts.service.ts` and
      // `notes.service.ts`'s own visibility filter — NOT `status: { not:
      // 'deleting' }`, which is the plausible-looking filter that would leave a
      // purged-but-not-yet-collected row counted.
      expect(stubs.prisma.transcript.count).toHaveBeenCalledWith({
        where: { ownerId: 'user-1', deletedAt: null },
      });
      expect(stubs.prisma.note.count).toHaveBeenCalledWith({
        where: { ownerId: 'user-1', deletedAt: null },
      });
    });

    it('a user whose only transcript is soft-deleted is not activated', async () => {
      // The count comes back 0 because the filter excluded the row, which is
      // the behaviour under test — the step must go back to `pending` rather
      // than staying satisfied on the strength of a deleted recording.
      const state = await userState({ transcriptCount: 0 });

      expect(requireStep(state, 'user.first_transcript').status).toBe('pending');
    });

    it("the admin smoke test counts only the caller's own READY transcripts", async () => {
      const stubs = build();
      await stubs.service.getAdminState(OMNIPOTENT);

      expect(stubs.prisma.transcript.count).toHaveBeenCalledWith({
        where: { ownerId: 'user-1', deletedAt: null, status: 'ready' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The admin truth table
  // ---------------------------------------------------------------------------

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

  describe('admin.ai', () => {
    it('satisfied when enabled, with a provider and at least one permitted model', async () => {
      const state = await adminState({
        aiPolicy: { enabled: true, provider: 'openai', allowedModelCount: 1 },
      });
      expect(requireStep(state, 'admin.ai').status).toBe('satisfied');
    });

    it('pending when the master switch is off', async () => {
      const state = await adminState({ aiPolicy: { enabled: false } });
      expect(requireStep(state, 'admin.ai').status).toBe('pending');
    });

    it('pending when no provider is chosen', async () => {
      const state = await adminState({ aiPolicy: { provider: null } });
      expect(requireStep(state, 'admin.ai').status).toBe('pending');
    });

    it('pending when no model is permitted', async () => {
      const state = await adminState({ aiPolicy: { allowedModelCount: 0 } });
      expect(requireStep(state, 'admin.ai').status).toBe('pending');
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
  });

  describe('admin.access', () => {
    it('satisfied when somebody besides the initial admin was allowlisted', async () => {
      const state = await adminState({ allowedEmailCount: 2, userCount: 1 });
      expect(requireStep(state, 'admin.access').status).toBe('satisfied');
    });

    it('satisfied when a second account exists', async () => {
      const state = await adminState({ allowedEmailCount: 1, userCount: 2 });
      expect(requireStep(state, 'admin.access').status).toBe('satisfied');
    });

    it('pending on a deployment with exactly the seeded admin', async () => {
      // ⚠ NOT `> 0`. The seed puts INITIAL_ADMIN_EMAIL on the allowlist and the
      // first login creates that account, so every fresh deployment has exactly
      // one of each — and `> 0` would report it satisfied on day zero.
      const state = await adminState({ allowedEmailCount: 1, userCount: 1 });
      expect(requireStep(state, 'admin.access').status).toBe('pending');
    });
  });

  describe('admin.email', () => {
    it('satisfied with a provider chosen and switched on', async () => {
      const state = await adminState({ emailProvider: 'smtp', emailEnabled: true });
      expect(requireStep(state, 'admin.email').status).toBe('satisfied');
    });

    it('pending with no provider', async () => {
      const state = await adminState({ emailProvider: null, emailEnabled: true });
      expect(requireStep(state, 'admin.email').status).toBe('pending');
    });

    it('pending with a provider that is switched off', async () => {
      const state = await adminState({ emailProvider: 'smtp', emailEnabled: false });
      expect(requireStep(state, 'admin.email').status).toBe('pending');
    });
  });

  describe('admin.push', () => {
    it('satisfied with a key pair present and the feature on', async () => {
      const state = await adminState({ pushConfigured: true, pushEnabled: true });
      expect(requireStep(state, 'admin.push').status).toBe('satisfied');
    });

    it('pending with keys generated but the feature off', async () => {
      const state = await adminState({ pushConfigured: true, pushEnabled: false });
      expect(requireStep(state, 'admin.push').status).toBe('pending');
    });

    it('pending with the feature on but no key pair', async () => {
      const state = await adminState({ pushConfigured: false, pushEnabled: true });
      expect(requireStep(state, 'admin.push').status).toBe('pending');
    });
  });

  describe('admin.backup', () => {
    it('satisfied when a schedule is enabled', async () => {
      const state = await adminState({ backupEnabled: true });
      expect(requireStep(state, 'admin.backup').status).toBe('satisfied');
    });

    it('pending when nothing is scheduled', async () => {
      const state = await adminState({ backupEnabled: false });
      expect(requireStep(state, 'admin.backup').status).toBe('pending');
    });
  });

  // ---------------------------------------------------------------------------
  // The user truth table
  // ---------------------------------------------------------------------------

  describe('user.ai_key', () => {
    it('absent when this deployment names no AI vendor at all', async () => {
      // ABSENT, not pending: there is no vendor a key could belong to, and a
      // step offering to add one would lead to a form that cannot be filled in.
      const state = await userState({ ai: { provider: null, available: false } });
      expect(stepOf(state, 'user.ai_key')).toBeUndefined();
    });

    it('satisfied once the caller has stored their own key', async () => {
      const state = await userState({ ai: { keyConfigured: true } });
      expect(requireStep(state, 'user.ai_key').status).toBe('satisfied');
    });

    it('pending — never blocked — while a vendor is named but AI is switched off', async () => {
      // ⚠ THE #83 CASE. `provider` is populated with AI off precisely so the
      // first administrator can save the key they need in order to load the
      // model list that turns AI on. Blocking here reinstates the deadlock in
      // which nobody can go first.
      const state = await userState({
        ai: { provider: 'openai', available: false, keyConfigured: false },
      });
      const step = requireStep(state, 'user.ai_key');

      expect(step.status).toBe('pending');
      expect(step.blockedReason).toBeNull();
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
      const state = await build().service.getUserState(user([]));
      expect(stepOf(state, 'user.first_transcript')).toBeUndefined();
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
        user([PERMISSIONS.TRANSCRIPTS_WRITE]),
      );
      expect(stepOf(state, 'user.first_note')).toBeUndefined();
    });
  });

  describe('user.profile', () => {
    it('satisfied with a display name', async () => {
      const state = await userState({ displayName: 'Ada' });
      expect(requireStep(state, 'user.profile').status).toBe('satisfied');
    });

    it('pending with none', async () => {
      const state = await userState({ displayName: null });
      expect(requireStep(state, 'user.profile').status).toBe('pending');
    });

    it('pending with a name made of whitespace', async () => {
      // It renders as nothing, so calling it satisfied leaves the user with no
      // way to work out why their initials are blank everywhere.
      const state = await userState({ displayName: '   ' });
      expect(requireStep(state, 'user.profile').status).toBe('pending');
    });
  });

  // ---------------------------------------------------------------------------
  // The derived counts
  // ---------------------------------------------------------------------------

  describe('the derived counts', () => {
    it('counts only unsatisfied `required` steps into requiredRemaining', async () => {
      const state = await userState({
        ai: { keyConfigured: false }, // user.ai_key       required, pending
        transcriptCount: 1, //           user.first_transcript required, satisfied
        noteCount: 0, //                 user.first_note  recommended, pending
        displayName: null, //            user.profile     optional, pending
      });

      expect(state.requiredRemaining).toBe(1);
      expect(state.totalRemaining).toBe(3);
      expect(state.allRequiredSatisfied).toBe(false);
    });

    it('allRequiredSatisfied is true with recommended work still outstanding', async () => {
      const state = await userState({
        ai: { keyConfigured: true },
        transcriptCount: 1,
        noteCount: 0,
        displayName: null,
      });

      expect(state.requiredRemaining).toBe(0);
      expect(state.allRequiredSatisfied).toBe(true);
      expect(state.totalRemaining).toBe(2);
    });

    it('a blocked step counts as outstanding', async () => {
      // It is not satisfied, and a deployment that cannot transcribe has not
      // finished being set up merely because the reason belongs to somebody
      // else — saying so is what the banner is for.
      const state = await userState({
        transcriptionAvailable: false,
        transcriptCount: 0,
        ai: { keyConfigured: true },
        noteCount: 1,
        displayName: 'Ada',
      });

      expect(requireStep(state, 'user.first_transcript').status).toBe('blocked');
      expect(state.requiredRemaining).toBe(1);
      expect(state.allRequiredSatisfied).toBe(false);
    });

    it('a skipped step is returned, marked, and counted out', async () => {
      const state = await userState({
        noteCount: 0,
        displayName: null,
        ai: { keyConfigured: true },
        transcriptCount: 1,
        skipped: ['user.first_note'],
      });

      const skipped = requireStep(state, 'user.first_note');

      // ⚠ RETURNED, not filtered: a skip the user cannot see is a skip the user
      // cannot undo.
      expect(skipped.skipped).toBe(true);
      expect(skipped.status).toBe('pending');
      expect(state.totalRemaining).toBe(1); // user.profile only
    });

    it('a skip recorded against a key no step uses is inert', async () => {
      const state = await userState({ skipped: ['user.retired_step'] });

      expect(state.steps.every((step) => step.skipped === false)).toBe(true);
    });
  });

  describe('audience', () => {
    it('labels each response with the checklist it is', async () => {
      expect((await userState()).audience).toBe('user');
      expect((await adminState()).audience).toBe('admin');
    });

    it('returns the registry order', async () => {
      const state = await adminState();
      expect(state.steps.map((step) => step.key)).toEqual(
        ADMIN_ONBOARDING_STEPS.map((step) => step.key),
      );
    });
  });
});

/** Recursively `Object.freeze`, so a step mutating its context throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
