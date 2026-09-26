import { describe, it, expect } from 'vitest';

import {
  entityTypeLabel,
  formatPrecisionDate,
  humanizeKey,
  indexableEntityTypes,
  initials,
  monthGroupKey,
  relationTypeLabel,
} from '../../utils/graphDisplay';
import { buildGraphQuery } from '../../services/graph';
import { graphOntologyFixture } from '../mocks/graphData';

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
});
