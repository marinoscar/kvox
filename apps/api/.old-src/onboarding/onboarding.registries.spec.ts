import { RegistryError } from '../common/registry';
import { withTemporaryEntries } from '../common/registry/testing';
import {
  BASE_ADMIN_ONBOARDING_STEPS,
  BASE_USER_ONBOARDING_STEPS,
  type OnboardingStep,
} from './onboarding-steps';
import {
  liveArray,
  onboardingFactRegistry,
  onboardingStepRegistry,
  onboardingStepsFor,
  registerOnboardingFact,
  registerOnboardingStep,
  type OnboardingFactDef,
} from './onboarding.registries';

// =============================================================================
// The onboarding registries (issue #460, step 7)
// =============================================================================
//
// What `registerOnboardingStep` / `registerOnboardingFact` refuse, and the order
// they hand back. Every case asserts the registry is UNCHANGED after a refusal
// (registration is all-or-nothing), and the valid-registration cases run inside
// `withTemporaryEntries` so the process-wide registries the manifest built are
// restored afterwards.
// =============================================================================

function step(overrides: Partial<OnboardingStep> = {}): OnboardingStep {
  return {
    key: 'test.step',
    audience: 'user',
    order: 1000,
    facts: [],
    tier: 'recommended',
    title: 'A test step',
    description: 'Exists only in this spec.',
    actionLabel: 'Go',
    href: '/somewhere',
    skippable: true,
    applies: () => true,
    evaluate: () => ({ status: 'pending' }),
    ...overrides,
  };
}

function fact(overrides: Partial<OnboardingFactDef> = {}): OnboardingFactDef {
  return { id: 'test.fact', inject: 'test.provider', resolve: async () => 1, ...overrides };
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof RegistryError ? err.code : `not a RegistryError: ${String(err)}`;
  }
  return undefined;
}

describe('onboarding registries', () => {
  describe('registerOnboardingStep', () => {
    it('throws on a duplicate step key', () => {
      const before = onboardingStepRegistry.size;
      expect(codeOf(() => registerOnboardingStep(step({ key: 'admin.ai' })))).toBe('DUPLICATE_ID');
      expect(onboardingStepRegistry.size).toBe(before);
    });

    it('throws on a duplicate inside one batch and registers neither', async () => {
      const before = onboardingStepRegistry.size;
      expect(codeOf(() => registerOnboardingStep(step(), step()))).toBe('DUPLICATE_ID');
      expect(onboardingStepRegistry.size).toBe(before);
      expect(onboardingStepRegistry.has('test.step')).toBe(false);
    });

    it('refuses a `required` step that is skippable', () => {
      expect(codeOf(() => registerOnboardingStep(step({ tier: 'required', skippable: true })))).toBe(
        'INVALID_ENTRY',
      );
      expect(onboardingStepRegistry.has('test.step')).toBe(false);
    });

    it('accepts a `required` step that is not skippable', async () => {
      await withTemporaryEntries(
        onboardingStepRegistry,
        [step({ tier: 'required', skippable: false })],
        () => {
          expect(onboardingStepRegistry.has('test.step')).toBe(true);
        },
      );
      expect(onboardingStepRegistry.has('test.step')).toBe(false);
    });

    it('refuses a key the onboarding namespace would reject (the step could not be skipped)', () => {
      for (const key of ['Admin.Thing', 'admin-thing', '1admin', 'admin thing', '']) {
        expect(codeOf(() => registerOnboardingStep(step({ key })))).toBe('INVALID_ID');
      }
    });

    it('refuses an href that is not root-relative', () => {
      for (const href of ['https://example.com/x', 'settings', '//evil.example/x', '']) {
        expect(codeOf(() => registerOnboardingStep(step({ href })))).toBe('INVALID_ENTRY');
      }
    });

    it('refuses `facts` that is not an array', () => {
      expect(
        codeOf(() => registerOnboardingStep(step({ facts: 'transcription.available' as never }))),
      ).toBe('INVALID_ENTRY');
    });

    it('refuses a fact id that is not registered', () => {
      expect(codeOf(() => registerOnboardingStep(step({ facts: ['nobody.registered.this'] })))).toBe(
        'INVALID_ENTRY',
      );
    });

    it('refuses an `evaluate` that is not a function', () => {
      expect(codeOf(() => registerOnboardingStep(step({ evaluate: 'nope' as never })))).toBe(
        'INVALID_ENTRY',
      );
    });

    it('refuses an `applies` that is not a function', () => {
      expect(codeOf(() => registerOnboardingStep(step({ applies: undefined as never })))).toBe(
        'INVALID_ENTRY',
      );
    });

    it('refuses an unknown audience, an unknown tier and a non-numeric order', () => {
      expect(codeOf(() => registerOnboardingStep(step({ audience: 'staff' as never })))).toBe('INVALID_ENTRY');
      expect(codeOf(() => registerOnboardingStep(step({ tier: 'mandatory' as never })))).toBe('INVALID_ENTRY');
      expect(codeOf(() => registerOnboardingStep(step({ order: Number.NaN })))).toBe('INVALID_ENTRY');
    });

    it('refuses registration once the registry is frozen', async () => {
      await withTemporaryEntries(onboardingStepRegistry, [], () => {
        onboardingStepRegistry.freeze();
        expect(codeOf(() => registerOnboardingStep(step()))).toBe('FROZEN');
      });
    });
  });

  describe('registerOnboardingFact', () => {
    it('throws on a duplicate fact id', () => {
      expect(codeOf(() => registerOnboardingFact(fact({ id: 'transcription.available' })))).toBe(
        'DUPLICATE_ID',
      );
    });

    it('refuses a fact with no resolver or no provider token', () => {
      expect(codeOf(() => registerOnboardingFact(fact({ resolve: undefined as never })))).toBe('INVALID_ENTRY');
      expect(codeOf(() => registerOnboardingFact(fact({ inject: undefined as never })))).toBe('INVALID_ENTRY');
    });

    it('lets a step name a fact registered before it', async () => {
      await withTemporaryEntries(onboardingFactRegistry, [fact()], async () => {
        await withTemporaryEntries(
          onboardingStepRegistry,
          [step({ facts: ['test.fact'] })],
          () => {
            expect(onboardingStepRegistry.require('test.step').facts).toEqual(['test.fact']);
          },
        );
      });
    });
  });

  describe('order', () => {
    it('lists each audience by (order, key), whatever the registration order', async () => {
      await withTemporaryEntries(
        onboardingStepRegistry,
        [
          step({ key: 'test.b', order: 5 }),
          step({ key: 'test.a', order: 5 }),
          step({ key: 'test.last', order: 9999 }),
          step({ key: 'test.admin', audience: 'admin', order: 1 }),
        ],
        () => {
          const user = onboardingStepsFor('user').map((s) => s.key);
          expect(user.slice(0, 2)).toEqual(['test.a', 'test.b']);
          expect(user[user.length - 1]).toBe('test.last');
          expect(onboardingStepsFor('admin')[0].key).toBe('test.admin');
          expect(user).not.toContain('test.admin');
        },
      );
    });
  });

  describe('the base step lists', () => {
    it('hold only steps that read no fact', () => {
      for (const s of [...BASE_ADMIN_ONBOARDING_STEPS, ...BASE_USER_ONBOARDING_STEPS]) {
        expect([s.key, s.facts]).toEqual([s.key, []]);
      }
    });
  });

  describe('liveArray', () => {
    it('re-reads on every access and behaves as a read-only array', () => {
      let items = [1, 2];
      const view = liveArray(() => items);

      expect(view.map((n) => n * 2)).toEqual([2, 4]);
      expect(view.length).toBe(2);
      expect([...view]).toEqual([1, 2]);
      expect(Array.isArray(view)).toBe(true);

      items = [1, 2, 3];
      expect(view.length).toBe(3);
      expect(view.map((n) => n)).toEqual([1, 2, 3]);
      expect(() => ((view as unknown as number[])[0] = 9)).toThrow();
    });
  });
});
