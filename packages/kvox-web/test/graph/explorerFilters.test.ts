import { describe, expect, it } from 'vitest';

import {
  hiddenFromSelected,
  hiddenFromShown,
  selectedTypesFromParam,
  shownParamFromHidden,
  typesParamFromSelected,
} from '../../src/graph/headless/utils/explorerFilters.js';

/**
 * The explorer's `types` URL parameter (#764): the type chips SELECT what shows.
 * Absent means every type; a list means exactly those; an empty list is never a
 * way to say "all".
 */

const ALL = ['Person', 'Organization', 'Meeting', 'Product', 'commitment'];

describe('selectedTypesFromParam / typesParamFromSelected', () => {
  it('absent or empty means nothing selected (every type shows)', () => {
    expect(selectedTypesFromParam(null, ALL).size).toBe(0);
    expect(selectedTypesFromParam('', ALL).size).toBe(0);
    expect(selectedTypesFromParam(' , ', ALL).size).toBe(0);
  });

  it('reads a list as exactly those types', () => {
    expect([...selectedTypesFromParam('Product', ALL)]).toEqual(['Product']);
    expect([...selectedTypesFromParam('Person, Organization', ALL)].sort()).toEqual(['Organization', 'Person']);
  });

  it('drops keys the ontology does not know, so a stale link reads as no filter rather than nothing', () => {
    expect([...selectedTypesFromParam('Product,Gadget', ALL)]).toEqual(['Product']);
    expect(selectedTypesFromParam('Gadget', ALL).size).toBe(0);
  });

  it('keeps every listed key while the known keys are not available yet', () => {
    expect([...selectedTypesFromParam('Gadget', [])]).toEqual(['Gadget']);
  });

  it('writes nothing for an empty selection, never an empty string', () => {
    expect(typesParamFromSelected(new Set(), ALL)).toBeNull();
  });

  it('writes the selection in ontology order, whatever order it was clicked in', () => {
    expect(typesParamFromSelected(new Set(['commitment', 'Person']), ALL)).toBe('Person,commitment');
  });

  it('round-trips every selection', () => {
    const selections = [[], ['Product'], ['Person', 'Organization'], ALL];
    for (const selection of selections) {
      const param = typesParamFromSelected(new Set(selection), ALL);
      expect([...selectedTypesFromParam(param, ALL)].sort()).toEqual([...selection].sort());
    }
  });
});

describe('hiddenFromSelected', () => {
  it('hides nothing when nothing is selected', () => {
    expect(hiddenFromSelected(new Set(), ALL).size).toBe(0);
  });

  it('hides every known type outside the selection', () => {
    expect([...hiddenFromSelected(new Set(['Product']), ALL)].sort()).toEqual(
      ['Meeting', 'Organization', 'Person', 'commitment'].sort(),
    );
  });

  it('never hides every type for a non-empty selection of known types', () => {
    for (const key of ALL) {
      expect(hiddenFromSelected(new Set([key]), ALL).size).toBe(ALL.length - 1);
    }
  });
});

describe('hiddenFromShown / shownParamFromHidden (relation types)', () => {
  it('round-trips a hidden set', () => {
    const hidden = new Set(['Meeting']);
    const param = shownParamFromHidden(hidden, ALL);
    expect(param).toBe('Person,Organization,Product,commitment');
    expect([...hiddenFromShown(param, ALL)]).toEqual(['Meeting']);
  });

  it('drops the parameter when nothing is hidden', () => {
    expect(shownParamFromHidden(new Set(), ALL)).toBeNull();
    expect(hiddenFromShown(null, ALL).size).toBe(0);
  });

  it('never writes an empty list, which would read back as "all"', () => {
    expect(shownParamFromHidden(new Set(ALL), ALL)).toBeNull();
  });
});
