import { describe, it, expect } from 'vitest';

import {
  entityTypeLabel,
  formatPrecisionDate,
  humanizeKey,
  indexableEntityTypes,
  initials,
  monthGroupKey,
  relationPropsDisplay,
  relationTypeLabel,
} from '../../utils/graphDisplay';
import { buildGraphQuery } from '../../services/graph';
import { graphOntologyFixture, mockGraphOntology } from '../mocks/graphData';

describe('graphDisplay', () => {
  it('writes a date to its precision, in UTC', () => {
    const iso = '2026-03-04T00:00:00.000Z';
    expect(formatPrecisionDate(iso, 'year')).toBe('2026');
    expect(formatPrecisionDate(iso, 'month')).toBe('Mar 2026');
    expect(formatPrecisionDate(iso, 'day')).toBe('4 Mar 2026');
    expect(formatPrecisionDate(null, 'day')).toBe('Date unknown');
    expect(formatPrecisionDate('nope', 'day')).toBe('Date unknown');
  });

  it('groups by month, year for a year-precision date', () => {
    expect(monthGroupKey('2026-03-04T00:00:00.000Z', 'day')).toBe('March 2026');
    expect(monthGroupKey('2026-03-04T00:00:00.000Z', 'year')).toBe('2026');
    expect(monthGroupKey(null, 'unknown')).toBe('Undated');
  });

  it('labels relation and entity types from the ontology, humanizing unknown keys', () => {
    expect(humanizeKey('WORKS_FOR')).toBe('Works for');
    expect(relationTypeLabel('REPORTS_TO', graphOntologyFixture)).toBe('Reports to');
    expect(relationTypeLabel('BRAND_NEW', null)).toBe('Brand new');
    expect(entityTypeLabel('Organization', graphOntologyFixture)).toBe('Organization');
    expect(entityTypeLabel('Mystery', graphOntologyFixture)).toBe('Mystery');
  });

  it('derives initials', () => {
    expect(initials('Joe Rivera')).toBe('JR');
    expect(initials('Acme')).toBe('AC');
    expect(initials('  ')).toBe('?');
  });

  it('offers only live entity-storage types as index filters', () => {
    expect(indexableEntityTypes(graphOntologyFixture).map((t) => t.key)).toEqual([
      'Person',
      'Organization',
      'Meeting',
      'Project',
    ]);
    expect(indexableEntityTypes(null).map((t) => t.key)).toContain('Person');
  });

  it('builds query strings with csv arrays and drops empties', () => {
    expect(buildGraphQuery({ type: ['Person', 'Organization'], q: '', limit: 5, x: undefined, y: [] })).toBe(
      '?type=Person%2COrganization&limit=5',
    );
    expect(buildGraphQuery({})).toBe('');
  });

  describe('relationPropsDisplay (#442)', () => {
    it('labels HAS_ROLE props from the ontology, in declaration order', () => {
      expect(
        relationPropsDisplay('HAS_ROLE', { businessUnit: 'Consulting', title: 'Managing Director' }, graphOntologyFixture),
      ).toEqual([
        { key: 'title', label: 'Role', value: 'Managing Director' },
        { key: 'businessUnit', label: 'Business unit', value: 'Consulting' },
      ]);
    });

    it('is empty for {} and for an older response with no props', () => {
      expect(relationPropsDisplay('HAS_ROLE', {}, graphOntologyFixture)).toEqual([]);
      expect(relationPropsDisplay('HAS_ROLE', undefined, graphOntologyFixture)).toEqual([]);
    });

    it('renders primitives only, formats dates, select labels and booleans, and humanizes unknown keys', () => {
      const ontology = mockGraphOntology();
      const hasRole = ontology.relationTypes.find((rel) => rel.key === 'HAS_ROLE')!;
      const base = hasRole.props[0];
      hasRole.props = [
        ...hasRole.props,
        { ...base, key: 'since', label: 'Since', kind: 'date' },
        { ...base, key: 'band', label: 'Band', kind: 'select', options: { choices: [{ value: 'b7', label: 'Band 7' }] } },
        { ...base, key: 'acting', label: 'Acting', kind: 'boolean' },
      ];
      expect(
        relationPropsDisplay(
          'HAS_ROLE',
          { title: 'VP', nested: { a: 1 }, list: ['x'], since: '2024-03-04', band: 'b7', acting: true, extra_note: 3 },
          ontology,
        ).map(({ label, value }) => `${label}=${value}`),
      ).toEqual(['Role=VP', 'Since=4 Mar 2024', 'Band=Band 7', 'Acting=Yes', 'Extra note=3']);
    });
  });
});
