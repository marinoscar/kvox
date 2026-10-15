import { RegistryError } from '../common/registry';
import { withTemporaryEntries } from '../common/registry/testing';
import {
  assertUserDataRegistriesConsistent,
  registerUserDataCategory,
  registerUserDataScope,
  userDataCategories,
  userDataCategoryRegistry,
  userDataPurgeSteps,
  userDataScopeIds,
  userDataScopeReaches,
  userDataScopeRegistry,
  type UserDataCategoryDef,
  type UserDataScopeDef,
} from './user-data.registries';

// =============================================================================
// User-data category and scope registries (issue #460)
// =============================================================================
//
// `kvox.manifest.ts` has filled both registries by the time this runs (the jest
// setup imports it), so these cases are about the REGISTRATION RULES and about
// the order the real registration produces; the scope x category matrix is
// `job-types.spec.ts` and the purge call order is
// `handlers/user-data-purge.handler.spec.ts`.
// =============================================================================

const category = (overrides: Partial<UserDataCategoryDef> = {}): UserDataCategoryDef => ({
  id: 'specCategory',
  label: 'Spec',
  description: 'A category only this spec registers.',
  content: true,
  ...overrides,
});

const scope = (overrides: Partial<UserDataScopeDef> = {}): UserDataScopeDef => ({
  id: 'specscope',
  label: 'Spec',
  description: 'A scope only this spec registers.',
  categories: ['files'],
  confirmation: 'SPECSCOPE',
  layer: 'user',
  ...overrides,
});

const hook = { inject: 'SPEC_HOOKS', run: async () => undefined };

describe('the real registration', () => {
  it('lists the scopes narrowest-first — the order the UI renders', () => {
    expect(userDataScopeIds()).toEqual(['transcripts', 'notes', 'files', 'content', 'everything']);
  });

  it('lists the categories in summary order', () => {
    expect(userDataCategories().map((c) => c.id)).toEqual([
      'transcripts',
      'notes',
      'files',
      'noteTemplates',
      'credentials',
      'graph',
      'ask',
      'onboarding',
    ]);
  });

  it('orders the purge steps ask 10, graph 20, credentials 30, notes 40, transcripts 50, noteTemplates 60, files 70, onboarding 80', () => {
    const steps = userDataPurgeSteps('everything').map((c) => [c.id, c.purge?.order]);

    expect(steps).toEqual([
      ['ask', 10],
      ['graph', 20],
      ['credentials', 30],
      ['notes', 40],
      ['transcripts', 50],
      ['noteTemplates', 60],
      ['files', 70],
      ['onboarding', 80],
    ]);
  });

  it('is internally consistent: every narrow scope names a registered category', () => {
    expect(() => assertUserDataRegistriesConsistent()).not.toThrow();
  });

  it('answers false for an unknown scope or category rather than throwing', () => {
    expect(userDataScopeReaches('nope', 'files')).toBe(false);
    expect(userDataScopeReaches('everything', 'nope')).toBe(false);
  });

  it('gives every registered scope the uppercased id as its confirmation', () => {
    for (const id of userDataScopeIds()) {
      expect(userDataScopeRegistry.require(id).confirmation).toBe(id.toUpperCase());
    }
  });
});

describe('category registration rules', () => {
  it('refuses a duplicate id', () => {
    expect(() => registerUserDataCategory(category({ id: 'files' }))).toThrow(RegistryError);
    try {
      registerUserDataCategory(category({ id: 'files' }));
    } catch (error) {
      expect((error as RegistryError).code).toBe('DUPLICATE_ID');
    }
  });

  it('refuses a duplicate summary key — two categories cannot share a response property', () => {
    const entry = category({
      summary: { key: 'files', schema: { safeParse: () => ({}) } as never, ...hook },
    });

    expect(() => registerUserDataCategory(entry)).toThrow(/summary.key "files".*"files"/);
  });

  it('refuses the reserved summary key `activeDeletion`', () => {
    const entry = category({
      summary: { key: 'activeDeletion', schema: { safeParse: () => ({}) } as never, ...hook },
    });

    expect(() => registerUserDataCategory(entry)).toThrow(/reserved/);
  });

  // ⚠ A TIE WOULD MAKE THE FK-CLEARING ORDER DEPEND ON REGISTRATION ORDER.
  it('refuses a purge order another category already uses', () => {
    const entry = category({ purge: { order: 40, ...hook } });

    expect(() => registerUserDataCategory(entry)).toThrow(/purge.order 40.*"notes"/);
  });

  it('refuses a non-integer purge order, a missing label and a non-boolean content flag', () => {
    expect(() => registerUserDataCategory(category({ purge: { order: 1.5, ...hook } }))).toThrow(
      /integer/,
    );
    expect(() => registerUserDataCategory(category({ label: '' }))).toThrow(/label/);
    expect(() => registerUserDataCategory(category({ content: 'yes' as never }))).toThrow(/content/);
  });

  it('refuses an id that is not camelCase', () => {
    expect(() => registerUserDataCategory(category({ id: 'Bad-Id' }))).toThrow(RegistryError);
  });

  it('accepts a well-formed category and lists it last when it declares no order', async () => {
    await withTemporaryEntries(userDataCategoryRegistry, [category()], () => {
      const ids = userDataCategories().map((c) => c.id);

      expect(ids[ids.length - 1]).toBe('specCategory');
    });
  });
});

describe('scope registration rules', () => {
  it('refuses a duplicate id', () => {
    expect(() => registerUserDataScope(scope({ id: 'notes', confirmation: 'NOTES' }))).toThrow(
      RegistryError,
    );
  });

  // ⚠ THE CONFIRMATION RULE: the scope, uppercased. A shared word would let a
  // token typed into one dialog authorise a different scope.
  it('refuses a confirmation that is not the scope uppercased', () => {
    expect(() => registerUserDataScope(scope({ confirmation: 'DELETE' }))).toThrow(
      /scope uppercased \("SPECSCOPE"\)/,
    );
    expect(() => registerUserDataScope(scope({ confirmation: 'specscope' }))).toThrow(/uppercased/);
  });

  it('refuses an empty or repeating category list, and any layer but "user"', () => {
    expect(() => registerUserDataScope(scope({ categories: [] }))).toThrow(/non-empty/);
    expect(() => registerUserDataScope(scope({ categories: ['files', 'files'] }))).toThrow(/repeat/);
    expect(() => registerUserDataScope(scope({ layer: 'org' as never }))).toThrow(/layer/);
  });

  it('flags a scope naming an unregistered category at boot, not at the first deletion', async () => {
    await withTemporaryEntries(userDataScopeRegistry, [scope({ categories: ['ghost'] })], () => {
      expect(() => assertUserDataRegistriesConsistent()).toThrow(/specscope.*ghost/);
    });
  });

  it('resolves a narrow scope to exactly its listed categories', async () => {
    await withTemporaryEntries(userDataScopeRegistry, [scope({ categories: ['files', 'ask'] })], () => {
      expect(userDataScopeReaches('specscope', 'files')).toBe(true);
      expect(userDataScopeReaches('specscope', 'ask')).toBe(true);
      expect(userDataScopeReaches('specscope', 'notes')).toBe(false);
    });
  });
});

describe('freezing', () => {
  it('refuses registrations after the application has bootstrapped (FROZEN)', () => {
    const savedCategories = userDataCategoryRegistry._captureState();
    const savedScopes = userDataScopeRegistry._captureState();

    try {
      userDataCategoryRegistry.freeze();
      userDataScopeRegistry.freeze();

      for (const attempt of [
        () => registerUserDataCategory(category()),
        () => registerUserDataScope(scope()),
      ]) {
        try {
          attempt();
          throw new Error('expected a FROZEN error');
        } catch (error) {
          expect((error as RegistryError).code).toBe('FROZEN');
        }
      }
    } finally {
      userDataCategoryRegistry._restoreState(savedCategories);
      userDataScopeRegistry._restoreState(savedScopes);
    }
  });
});
