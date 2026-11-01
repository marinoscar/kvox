import { GraphPreferencesService } from './graph-preferences.service.js';
import { GRAPH_PREFERENCE_DEFAULTS, effectiveAutoCommit, resolveGraphPreferences } from './graph-preferences.defaults.js';
import { mergeGraphPreferences } from './graph-preferences.merge.js';
import { graphPreferencesPatchSchema, graphPreferencesSchema } from './graph-preferences.schema.js';

// =============================================================================
// GraphPreferencesService (#369, epic #346; over the settings port by #496)
// =============================================================================
//
// The platform-composed PATCH body and the merge rules are specified beside the web edition's
// registration (`apps/api/test/graph/graph-preferences.spec.ts`).
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';

describe('GraphPreferencesService', () => {
  it('returns defaults for a user with no graph namespace, through a plain read', async () => {
    const settings = { readUser: jest.fn().mockResolvedValue(undefined), patchUser: jest.fn() };
    const service = new GraphPreferencesService(settings as never);

    await expect(service.get(USER)).resolves.toEqual(GRAPH_PREFERENCE_DEFAULTS);
    expect(settings.readUser).toHaveBeenCalledWith(USER, 'graph');
    expect(settings.patchUser).not.toHaveBeenCalled();
  });

  it('resolves a stored namespace over the defaults', async () => {
    const settings = {
      readUser: jest
        .fn()
        .mockResolvedValue({ resolution: { ...GRAPH_PREFERENCE_DEFAULTS.resolution, autoLinkThreshold: 0.93 } }),
    };
    const service = new GraphPreferencesService(settings as never);

    const resolved = await service.get(USER);
    expect(resolved.resolution.autoLinkThreshold).toBe(0.93);
    expect(resolved.domains.work).toBe(true);
  });
});

describe('auto-commit of safe rows (#779, ADR-0007)', () => {
  it('is on by default, and a row stored before it existed reads as on', () => {
    expect(GRAPH_PREFERENCE_DEFAULTS.review.autoCommitSafeRows).toBe(true);
    expect(resolveGraphPreferences(undefined).review.autoCommitSafeRows).toBe(true);
    const legacy = graphPreferencesSchema.parse({ review: { minConfidence: 0.8 } });
    expect(resolveGraphPreferences(legacy).review).toEqual({ minConfidence: 0.8, autoCommitSafeRows: true });
  });

  it('stores the choice only once a person made it, and null restores the default', () => {
    const patch = (value: unknown) => graphPreferencesPatchSchema.parse({ review: value });
    expect(mergeGraphPreferences(undefined, patch({ minConfidence: 0.8 }))?.review).toEqual({ minConfidence: 0.8 });
    const off = mergeGraphPreferences(undefined, patch({ autoCommitSafeRows: false }));
    expect(off?.review).toEqual({ minConfidence: 0.7, autoCommitSafeRows: false });
    expect(resolveGraphPreferences(off).review.autoCommitSafeRows).toBe(false);
    // a later minConfidence change keeps the choice
    expect(mergeGraphPreferences(off, patch({ minConfidence: 0.9 }))?.review).toEqual({ minConfidence: 0.9, autoCommitSafeRows: false });
    expect(mergeGraphPreferences(off, patch({ autoCommitSafeRows: null }))?.review).toEqual({ minConfidence: 0.7 });
  });

  describe('effectiveAutoCommit: the library setting, when it has one, beats the preference', () => {
    const on = { review: { minConfidence: 0.7, autoCommitSafeRows: true } };
    const off = { review: { minConfidence: 0.7, autoCommitSafeRows: false } };
    it.each([
      ['no library, preference on (default)', undefined, on, true],
      ['no library, preference off', undefined, off, false],
      ['library follows (null), preference on', null, on, true],
      ['library follows (null), preference off', null, off, false],
      ['library explicitly on, preference off', true, off, true],
      ['library explicitly off, preference on', false, on, false],
    ] as const)('%s', (_label, library, preferences, expected) => {
      expect(effectiveAutoCommit(library, preferences)).toBe(expected);
    });
  });
});

describe('self identity (#778)', () => {
  const ID = '0b1f1d1e-4f3a-4c52-9a77-3f4f6a2b9c10';
  const patch = (value: unknown) => graphPreferencesPatchSchema.parse({ self: value });

  it('defaults to no entity, and a stored namespace without it reads as none', () => {
    expect(GRAPH_PREFERENCE_DEFAULTS.self.entityId).toBeNull();
    expect(resolveGraphPreferences(undefined).self).toEqual({ entityId: null });
    expect(resolveGraphPreferences(graphPreferencesSchema.parse({ review: { minConfidence: 0.8 } })).self.entityId).toBeNull();
  });

  it('stores the id only once chosen, and null (or the sub-object null) clears it', () => {
    const chosen = mergeGraphPreferences(undefined, patch({ entityId: ID }));
    expect(chosen).toEqual({ self: { entityId: ID } });
    expect(resolveGraphPreferences(chosen).self.entityId).toBe(ID);
    expect(mergeGraphPreferences(chosen, patch({ entityId: null }))).toBeUndefined();
    expect(mergeGraphPreferences(chosen, patch(null))).toBeUndefined();
    // another sub-object's patch leaves the choice alone
    expect(mergeGraphPreferences(chosen, graphPreferencesPatchSchema.parse({ review: { minConfidence: 0.9 } }))?.self).toEqual({
      entityId: ID,
    });
  });

  it('refuses an id that is not a uuid', () => {
    expect(() => patch({ entityId: 'not-an-id' })).toThrow();
    expect(() => graphPreferencesSchema.parse({ self: { entityId: 'x' } })).toThrow();
  });
});
