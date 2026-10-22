// =============================================================================
// `graph.explorer.lenses` (GIC-17, #678): the schema's caps and the merge rules.
// =============================================================================

import { mergeGraphPreferences } from './graph-preferences.merge.js';
import {
  GRAPH_LENSES_MAX,
  GRAPH_LENS_PINS_MAX,
  graphPreferencesPatchSchema,
  graphPreferencesSchema,
} from './graph-preferences.schema.js';

const ID = '11111111-1111-4111-8111-111111111111';

const lens = (n: number, over: Record<string, unknown> = {}) => ({
  id: `lens-${n}`,
  name: `Lens ${n}`,
  seeds: [ID],
  types: ['Person'],
  relTypes: null,
  layout: 'force' as const,
  pins: { [ID]: { x: 1, y: 2 } },
  ...over,
});

describe('graph.explorer.lenses schema', () => {
  it('accepts a lens and an absent explorer', () => {
    expect(graphPreferencesSchema.safeParse({ explorer: { lenses: [lens(1)] } }).success).toBe(true);
    expect(graphPreferencesSchema.safeParse({}).success).toBe(true);
  });

  it(`refuses more than ${GRAPH_LENSES_MAX} lenses`, () => {
    const many = Array.from({ length: GRAPH_LENSES_MAX + 1 }, (_, i) => lens(i));
    expect(graphPreferencesSchema.safeParse({ explorer: { lenses: many } }).success).toBe(false);
    expect(graphPreferencesPatchSchema.safeParse({ explorer: { lenses: many } }).success).toBe(false);
  });

  it(`refuses more than ${GRAPH_LENS_PINS_MAX} pinned positions in one lens`, () => {
    const pins = Object.fromEntries(Array.from({ length: GRAPH_LENS_PINS_MAX + 1 }, (_, i) => [`n${i}`, { x: 0, y: 0 }]));
    expect(graphPreferencesSchema.safeParse({ explorer: { lenses: [lens(1, { pins })] } }).success).toBe(false);
    const ok = Object.fromEntries(Array.from({ length: GRAPH_LENS_PINS_MAX }, (_, i) => [`n${i}`, { x: 0, y: 0 }]));
    expect(graphPreferencesSchema.safeParse({ explorer: { lenses: [lens(1, { pins: ok })] } }).success).toBe(true);
  });

  it('refuses an unknown field, a blank name and a non-finite position', () => {
    expect(graphPreferencesSchema.safeParse({ explorer: { lenses: [lens(1, { extra: 1 })] } }).success).toBe(false);
    expect(graphPreferencesSchema.safeParse({ explorer: { lenses: [lens(1, { name: '  ' })] } }).success).toBe(false);
    expect(
      graphPreferencesSchema.safeParse({ explorer: { lenses: [lens(1, { pins: { a: { x: Infinity, y: 0 } } })] } }).success,
    ).toBe(false);
  });
});

describe('graph.explorer.lenses merge', () => {
  it('stores the list and leaves the other sub-objects alone', () => {
    const merged = mergeGraphPreferences({ domains: { work: true, personal: false } }, { explorer: { lenses: [lens(1)] } });
    expect(merged).toEqual({ domains: { work: true, personal: false }, explorer: { lenses: [lens(1)] } });
  });

  it('replaces the whole list on a write', () => {
    const merged = mergeGraphPreferences({ explorer: { lenses: [lens(1), lens(2)] } }, { explorer: { lenses: [lens(3)] } });
    expect(merged?.explorer?.lenses).toEqual([lens(3)]);
  });

  it('keeps the list when the patch names only another sub-object', () => {
    const merged = mergeGraphPreferences({ explorer: { lenses: [lens(1)] } }, { extraction: { autoExtract: false } });
    expect(merged?.explorer?.lenses).toEqual([lens(1)]);
  });

  it('deletes the list, then the namespace, on null', () => {
    expect(mergeGraphPreferences({ explorer: { lenses: [lens(1)] } }, { explorer: { lenses: null } })).toBeUndefined();
    expect(mergeGraphPreferences({ explorer: { lenses: [lens(1)] } }, { explorer: null })).toBeUndefined();
  });
});
