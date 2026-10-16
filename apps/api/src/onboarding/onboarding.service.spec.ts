import { PERMISSIONS } from '../common/constants/roles.constants';
import { ONBOARDING_STEP_KEY_PATTERN } from '../common/schemas/user-settings-namespaces.schema';
import { resetRegistryForTests, withTemporaryEntries } from '../common/registry/testing';
import {
  OMNIPOTENT,
  buildOnboardingKit,
  callerWith,
  deepFreeze,
  requireStep,
  stepOf,
  type KitFacts,
} from '../../test/helpers/onboarding-service.kit';
import {
  ADMIN_ONBOARDING_STEPS,
  BASE_ADMIN_ONBOARDING_STEPS,
  BASE_USER_ONBOARDING_STEPS,
  USER_ONBOARDING_STEPS,
  type OnboardingAdminContext,
  type OnboardingStep,
  type OnboardingUserContext,
} from './onboarding-steps';
import {
  onboardingFactRegistry,
  onboardingStepRegistry,
  onboardingStepsFor,
  registerOnboardingStep,
  type OnboardingFactDef,
} from './onboarding.registries';
import type { OnboardingState } from './dto/onboarding-state.dto';

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
// SINCE #460 THE STEP CATALOGUE HAS TWO SOURCES. This file owns the BASE steps
// (`admin.ai`, `admin.email`, `admin.access`, `admin.push`, `admin.backup`,
// `user.ai_key`, `user.profile`). The four domain steps live beside their
// modules and are tested there (`transcription.onboarding.spec.ts`,
// `transcripts.onboarding.spec.ts`, `notes.onboarding.spec.ts`), against the
// real registered facts. So:
//
//   - 'the registry' below reads the FULL registry the manifest built (base +
//     domain), because the load-bearing order is a property of the whole list;
//   - everything that RUNS the service swaps the registry for the base steps
//     only, so this file imports no domain module and exercises no domain fact.
//     Test-time steps are added with `withTemporaryEntries`, which restores the
//     registry even when the body throws.
// =============================================================================

async function userState(facts: KitFacts = {}): Promise<OnboardingState> {
  return buildOnboardingKit(facts).service.getUserState(OMNIPOTENT);
}

async function adminState(facts: KitFacts = {}): Promise<OnboardingState> {
  return buildOnboardingKit(facts).service.getAdminState(OMNIPOTENT);
}

/** A step that exists only for a test; every field a real step has. */
function testStep(overrides: Partial<OnboardingStep> & { key: string }): OnboardingStep {
  return {
    audience: 'user',
    order: 1000,
    facts: [],
    tier: 'recommended',
    title: 'An extra step added at test time',
    description: 'Exists only to prove a property of the registry.',
    actionLabel: 'Go',
    href: '/',
    skippable: true,
    applies: () => true,
    evaluate: () => ({ status: 'pending' }),
    ...overrides,
  };
}

// =============================================================================

describe('OnboardingService', () => {
  // ---------------------------------------------------------------------------
  // Registry invariants — properties of the FULL registered catalogue
  // ---------------------------------------------------------------------------

  describe('the registry (base + domain steps, as the manifest registered them)', () => {
    const everyStep: OnboardingStep<never>[] = [
      ...(ADMIN_ONBOARDING_STEPS as readonly OnboardingStep<never>[]),
      ...(USER_ONBOARDING_STEPS as readonly OnboardingStep<never>[]),
    ];

    it('holds the base steps and the four domain steps', () => {
      expect(ADMIN_ONBOARDING_STEPS.map((step) => step.key)).toEqual([
        'admin.transcription',
        'admin.ai',
        'admin.smoke_test',
        'admin.email',
        'admin.access',
        'admin.push',
        'admin.backup',
      ]);
      expect(USER_ONBOARDING_STEPS.map((step) => step.key)).toEqual([
        'user.ai_key',
        'user.first_transcript',
        'user.first_note',
        'user.profile',
      ]);
    });

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

    it('every step declares the audience of the list it is in', () => {
      for (const step of ADMIN_ONBOARDING_STEPS) expect(step.audience).toBe('admin');
      for (const step of USER_ONBOARDING_STEPS) expect(step.audience).toBe('user');
    });

    it('every declared fact is registered', () => {
      for (const step of everyStep) {
        for (const id of step.facts) {
          expect([step.key, id, onboardingFactRegistry.has(id)]).toEqual([
            step.key,
            id,
            true,
          ]);
        }
      }
    });

    it('numbers each audience 10, 20, 30, ... in strictly increasing order', () => {
      for (const steps of [ADMIN_ONBOARDING_STEPS, USER_ONBOARDING_STEPS]) {
        const orders = steps.map((step) => step.order);
        expect(orders).toEqual(orders.map((_, index) => (index + 1) * 10));
      }
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
      // The registry renders in `(order, key)` order ('returns the registry
      // order' below pins that half), so this pair's `order` values ARE the
      // order an administrator reads. Without this assertion the dependency is
      // invisible and a later edit reverses it silently.
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
  // Everything below RUNS the service against the BASE steps only.
  // ---------------------------------------------------------------------------

  describe('against the base steps', () => {
    const savedSteps = onboardingStepRegistry._captureState();
    const savedFacts = onboardingFactRegistry._captureState();

    beforeAll(() => {
      resetRegistryForTests(onboardingFactRegistry);
      resetRegistryForTests(onboardingStepRegistry);
      registerOnboardingStep(...BASE_ADMIN_ONBOARDING_STEPS, ...BASE_USER_ONBOARDING_STEPS);
    });

    afterAll(() => {
      onboardingFactRegistry._restoreState(savedFacts);
      onboardingStepRegistry._restoreState(savedSteps);
    });

    // -------------------------------------------------------------------------
    // Invariant 1: purity — `ctx` is the only argument, and nothing else is read
    // -------------------------------------------------------------------------

    describe('step purity', () => {
      it('takes ctx as its only argument, mutates nothing, and reads no collaborator', async () => {
        const kit = buildOnboardingKit();

        // Build both contexts through the real service, then evaluate every step
        // against a FROZEN copy with the call counters cleared. Any read a step
        // performs for itself lands on a stub and is counted; any write to the
        // context it was handed throws.
        const userSnapshot = await kit.service.buildUserContext('user-1');
        const adminSnapshot = await kit.service.buildAdminContext('user-1');
        kit.resetReads();

        const frozenUser = deepFreeze(userSnapshot.context);
        const frozenAdmin = deepFreeze(adminSnapshot.context);

        for (const step of onboardingStepsFor<OnboardingUserContext>('user')) {
          expect(step.applies.length).toBeLessThanOrEqual(1);
          expect(step.evaluate.length).toBeLessThanOrEqual(1);
          step.applies(frozenUser);
          step.evaluate(frozenUser);
        }

        for (const step of onboardingStepsFor<OnboardingAdminContext>('admin')) {
          expect(step.applies.length).toBeLessThanOrEqual(1);
          expect(step.evaluate.length).toBeLessThanOrEqual(1);
          step.applies(frozenAdmin);
          step.evaluate(frozenAdmin);
        }

        // ⚠ THE ASSERTION THAT MATTERS: evaluating the WHOLE registry, twice
        // over, performed exactly zero reads.
        expect(kit.reads()).toBe(0);
        expect(kit.prisma.user.count).not.toHaveBeenCalled();
        expect(kit.prisma.allowedEmail.count).not.toHaveBeenCalled();
        expect(kit.emailSettings.describeForAdmin).not.toHaveBeenCalled();
        expect(kit.pushConfig.describeForAdmin).not.toHaveBeenCalled();
        expect(kit.moduleRef.get).not.toHaveBeenCalled();
      });
    });

    // -------------------------------------------------------------------------
    // Invariant 2: the read count does not grow with the registry
    // -------------------------------------------------------------------------

    describe('bounded read count', () => {
      it('adding a user step changes the number of reads by zero', async () => {
        const before = buildOnboardingKit();
        await before.service.getUserState(OMNIPOTENT);
        const baseline = before.reads();

        await withTemporaryEntries(
          onboardingStepRegistry,
          [testStep({ key: 'test.extra_step', audience: 'user' })],
          async () => {
            const after = buildOnboardingKit();
            const state = await after.service.getUserState(OMNIPOTENT);

            // The step really was evaluated — otherwise an unchanged read count
            // would prove nothing at all.
            expect(stepOf(state, 'test.extra_step')?.status).toBe('pending');
            expect(after.reads()).toBe(baseline);
          },
        );
      });

      it('adding an admin step changes the number of reads by zero', async () => {
        const before = buildOnboardingKit();
        await before.service.getAdminState(OMNIPOTENT);
        const baseline = before.reads();

        await withTemporaryEntries(
          onboardingStepRegistry,
          [testStep({ key: 'test.extra_step', audience: 'admin' })],
          async () => {
            const after = buildOnboardingKit();
            const state = await after.service.getAdminState(OMNIPOTENT);

            expect(stepOf(state, 'test.extra_step')?.status).toBe('pending');
            expect(after.reads()).toBe(baseline);
          },
        );
      });

      it('the user request never reads an admin-only fact', async () => {
        // The structural half of #275's argument, at the unit level: the
        // integration suite asserts the same thing through the wire.
        const kit = buildOnboardingKit();
        await kit.service.getUserState(OMNIPOTENT);

        expect(kit.emailSettings.describeForAdmin).not.toHaveBeenCalled();
        expect(kit.pushConfig.describeForAdmin).not.toHaveBeenCalled();
        expect(kit.systemSettings.getDatabaseBackupPolicy).not.toHaveBeenCalled();
        expect(kit.prisma.user.count).not.toHaveBeenCalled();
        expect(kit.prisma.allowedEmail.count).not.toHaveBeenCalled();
      });
    });

    // -------------------------------------------------------------------------
    // Facts (issue #460): resolved once, in parallel, before any step runs
    // -------------------------------------------------------------------------

    describe('facts', () => {
      function fact(
        id: string,
        resolve: OnboardingFactDef['resolve'],
        inject: string = 'test.provider',
      ): OnboardingFactDef {
        return { id, inject, resolve };
      }

      /** Register `facts`, then run `body` with them (and any steps) in place. */
      async function withFacts<R>(
        facts: OnboardingFactDef[],
        steps: OnboardingStep[],
        body: () => Promise<R>,
      ): Promise<R> {
        return withTemporaryEntries(onboardingFactRegistry, facts, () =>
          withTemporaryEntries(onboardingStepRegistry, steps, body),
        );
      }

      it('hands a step the value its fact resolved, as ctx.facts[id]', async () => {
        const kit = buildOnboardingKit();
        kit.provide('test.provider', { value: 42 });

        await withFacts(
          [fact('test.answer', async (provider: { value: number }, ctx) => provider.value + ctx.callerId.length)],
          [
            testStep({
              key: 'test.reads_fact',
              facts: ['test.answer'],
              evaluate: (ctx) => ({
                status: (ctx.facts as unknown as Record<string, number>)['test.answer'] === 48 ? 'satisfied' : 'pending',
              }),
            }),
          ],
          async () => {
            const state = await kit.service.getUserState(OMNIPOTENT);
            // 42 + 'user-1'.length (6)
            expect(requireStep(state, 'test.reads_fact').status).toBe('satisfied');
          },
        );
      });

      it('resolves a fact once however many steps name it, and counts it as one read', async () => {
        const baselineKit = buildOnboardingKit();
        await baselineKit.service.getUserState(OMNIPOTENT);
        const baseline = baselineKit.reads();

        const kit = buildOnboardingKit();
        const resolve = jest.fn(kit.counted(7));
        kit.provide('test.provider', {});

        await withFacts(
          [fact('test.shared', resolve)],
          [
            testStep({ key: 'test.first', facts: ['test.shared'] }),
            testStep({ key: 'test.second', facts: ['test.shared'] }),
            testStep({ key: 'test.third', facts: ['test.shared'] }),
          ],
          async () => {
            await kit.service.getUserState(OMNIPOTENT);
          },
        );

        expect(resolve).toHaveBeenCalledTimes(1);
        expect(kit.reads()).toBe(baseline + 1);
      });

      it('starts every fact before any of them settles, and before any step runs', async () => {
        const kit = buildOnboardingKit();
        kit.provide('test.provider', {});
        const log: string[] = [];
        let releaseFirst: () => void = () => undefined;
        const firstGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });

        await withFacts(
          [
            fact('test.slow', async () => {
              log.push('slow:start');
              await firstGate;
              log.push('slow:end');
              return 1;
            }),
            fact('test.quick', async () => {
              log.push('quick:start');
              releaseFirst();
              return 2;
            }),
          ],
          [
            testStep({
              key: 'test.after_facts',
              facts: ['test.slow', 'test.quick'],
              applies: () => {
                log.push('step:applies');
                return true;
              },
            }),
          ],
          async () => {
            await kit.service.getUserState(OMNIPOTENT);
          },
        );

        // Both started before the slow one finished (parallel, not sequential:
        // the quick fact is what releases the slow one), and the step ran last.
        expect(log).toEqual(['slow:start', 'quick:start', 'slow:end', 'step:applies']);
      });

      it('never resolves a fact only the other audience names', async () => {
        const kit = buildOnboardingKit();
        kit.provide('test.provider', {});
        const resolve = jest.fn(async () => 1);

        await withFacts(
          [fact('test.admin_only', resolve)],
          [testStep({ key: 'test.admin_step', audience: 'admin', facts: ['test.admin_only'] })],
          async () => {
            await kit.service.getUserState(OMNIPOTENT);
            expect(resolve).not.toHaveBeenCalled();

            await kit.service.getAdminState(OMNIPOTENT);
            expect(resolve).toHaveBeenCalledTimes(1);
          },
        );
      });

      it('fails the request when a fact rejects, rather than dropping the step', async () => {
        const kit = buildOnboardingKit();
        kit.provide('test.provider', {});

        await withFacts(
          [fact('test.broken', async () => Promise.reject(new Error('boom')))],
          [testStep({ key: 'test.needs_broken', facts: ['test.broken'] })],
          async () => {
            await expect(kit.service.getUserState(OMNIPOTENT)).rejects.toThrow('boom');
          },
        );
      });

      it('fails the request when the fact’s provider cannot be resolved', async () => {
        const kit = buildOnboardingKit(); // nothing provided under 'test.provider'

        await withFacts(
          [fact('test.orphan', async () => 1)],
          [testStep({ key: 'test.needs_orphan', facts: ['test.orphan'] })],
          async () => {
            await expect(kit.service.getUserState(OMNIPOTENT)).rejects.toThrow(
              /could not find/,
            );
          },
        );
      });

      it('looks the provider up across the whole application (strict: false)', async () => {
        const kit = buildOnboardingKit();
        kit.provide('test.provider', {});

        await withFacts(
          [fact('test.lookup', async () => 1)],
          [testStep({ key: 'test.needs_lookup', facts: ['test.lookup'] })],
          async () => {
            await kit.service.getUserState(OMNIPOTENT);
          },
        );

        expect(kit.moduleRef.get).toHaveBeenCalledWith('test.provider', { strict: false });
      });
    });

    // -------------------------------------------------------------------------
    // Rendering order and permission filtering
    // -------------------------------------------------------------------------

    describe('rendering', () => {
      it('renders in (order, key) order, whatever the registration order', async () => {
        await withTemporaryEntries(
          onboardingStepRegistry,
          [
            testStep({ key: 'test.zeta', order: 25 }),
            testStep({ key: 'test.alpha', order: 25 }),
            testStep({ key: 'test.first', order: 5 }),
          ],
          async () => {
            const state = await userState();
            expect(state.steps.map((step) => step.key)).toEqual([
              'test.first',
              'user.ai_key',
              'test.alpha',
              'test.zeta',
              'user.profile',
            ]);
          },
        );
      });

      it('shows each step only to a caller holding its permission', async () => {
        const state = await buildOnboardingKit().service.getAdminState(callerWith([]));
        // Every base admin step names a permission; a caller with none sees none.
        expect(state.steps).toEqual([]);

        const some = await buildOnboardingKit().service.getAdminState(
          callerWith([PERMISSIONS.PUSH_READ]),
        );
        expect(some.steps.map((step) => step.key)).toEqual(['admin.push']);
      });
    });

    // -------------------------------------------------------------------------
    // The admin truth table (base steps)
    // -------------------------------------------------------------------------

    describe('admin.ai', () => {
      it('satisfied when the deployment can run AI (switched on, a provider on, a default model enabled)', async () => {
        const state = await adminState({ aiPolicy: { configured: true } });
        expect(requireStep(state, 'admin.ai').status).toBe('satisfied');
      });

      it('pending when the deployment cannot run AI', async () => {
        const state = await adminState({ aiPolicy: { configured: false } });
        expect(requireStep(state, 'admin.ai').status).toBe('pending');
      });

      it('satisfied for an administrator who simply has no key of their own: that is user.ai_key', async () => {
        const state = await adminState({ ai: { keyConfigured: false } });
        expect(requireStep(state, 'admin.ai').status).toBe('satisfied');
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

    // -------------------------------------------------------------------------
    // The user truth table (base steps)
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // The derived counts
    // -------------------------------------------------------------------------

    describe('the derived counts', () => {
      it('counts only unsatisfied `required` steps into requiredRemaining', async () => {
        const state = await userState({
          ai: { keyConfigured: false }, // user.ai_key  required, pending
          displayName: null, //            user.profile optional, pending
        });

        expect(state.requiredRemaining).toBe(1);
        expect(state.totalRemaining).toBe(2);
        expect(state.allRequiredSatisfied).toBe(false);
      });

      it('allRequiredSatisfied is true with optional work still outstanding', async () => {
        const state = await userState({
          ai: { keyConfigured: true },
          displayName: null,
        });

        expect(state.requiredRemaining).toBe(0);
        expect(state.allRequiredSatisfied).toBe(true);
        expect(state.totalRemaining).toBe(1);
      });

      it('a blocked step counts as outstanding', async () => {
        // It is not satisfied, and a deployment that cannot transcribe has not
        // finished being set up merely because the reason belongs to somebody
        // else — saying so is what the banner is for.
        await withTemporaryEntries(
          onboardingStepRegistry,
          [
            testStep({
              key: 'test.blocked_required',
              tier: 'required',
              skippable: false,
              evaluate: () => ({ status: 'blocked', blockedReason: 'Somebody else first.' }),
            }),
          ],
          async () => {
            const state = await userState({
              ai: { keyConfigured: true },
              displayName: 'Ada',
            });

            expect(requireStep(state, 'test.blocked_required').status).toBe('blocked');
            expect(state.requiredRemaining).toBe(1);
            expect(state.allRequiredSatisfied).toBe(false);
          },
        );
      });

      it('a skipped step is returned, marked, and counted out', async () => {
        const state = await userState({
          displayName: null,
          ai: { keyConfigured: true },
          skipped: ['user.profile'],
        });

        const skipped = requireStep(state, 'user.profile');

        // ⚠ RETURNED, not filtered: a skip the user cannot see is a skip the user
        // cannot undo.
        expect(skipped.skipped).toBe(true);
        expect(skipped.status).toBe('pending');
        expect(state.totalRemaining).toBe(0);
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
          onboardingStepsFor('admin').map((step) => step.key),
        );
        expect(state.steps.map((step) => step.key)).toEqual([
          'admin.ai',
          'admin.email',
          'admin.access',
          'admin.push',
          'admin.backup',
        ]);
      });
    });
  });
});
