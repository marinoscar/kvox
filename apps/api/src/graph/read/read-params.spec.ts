import { BadRequestException } from '@nestjs/common';
import { computeEffectiveSchema } from '@app/shared/ontology';

import {
  asOfOr400,
  parseCsv,
  resolveEntityTypes,
  resolveNodeTypes,
  resolveRelationTypes,
  resolveTimelineKinds,
} from './read-params';

// read-params.ts (#370): every filter key is checked against the caller's
// effective schema, and an unknown one is a 400 naming it.

const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const coreOnly = computeEffectiveSchema({ enabledDomains: ['core'], userAttributes: [] });

function badRequest(fn: () => unknown): { message: string; details: { unknown: string[] } } {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as never;
  }
  throw new Error('expected a 400');
}

describe('parseCsv', () => {
  it('splits, trims, drops empties and de-duplicates', () => {
    expect(parseCsv(' Person, Organization,,Person ')).toEqual(['Person', 'Organization']);
    expect(parseCsv(['A', ' A', 'B'])).toEqual(['A', 'B']);
    expect(parseCsv(' , ')).toBeUndefined();
    expect(parseCsv(undefined)).toBeUndefined();
  });
});

describe('filters', () => {
  it('accepts entity-storage types only for the entity index', () => {
    expect(resolveEntityTypes(schema, 'Person,Project')).toEqual(['Person', 'Project']);
    expect(badRequest(() => resolveEntityTypes(schema, 'Person,Commitment')).details.unknown).toEqual(['Commitment']);
    // A type of a domain the caller has not enabled is unknown to them.
    expect(badRequest(() => resolveEntityTypes(coreOnly, 'Project')).details.unknown).toEqual(['Project']);
  });

  it('mixes entity types, item type keys and item kinds for a node filter', () => {
    expect(resolveNodeTypes(schema, 'Person,Commitment,person_fact')).toEqual({
      entityTypes: ['Person'],
      itemKinds: ['commitment', 'person_fact'],
    });
    expect(resolveNodeTypes(schema, undefined)).toBeUndefined();
    expect(badRequest(() => resolveNodeTypes(schema, ['Person', 'Spaceship'])).details.unknown).toEqual(['Spaceship']);
  });

  it('accepts relation types of any representation', () => {
    expect(resolveRelationTypes(schema, 'WORKS_FOR,ABOUT')).toEqual(['WORKS_FOR', 'ABOUT']);
    expect(badRequest(() => resolveRelationTypes(schema, 'LOVES')).message).toContain('LOVES');
  });

  it('knows the six timeline kinds', () => {
    expect([...resolveTimelineKinds(undefined)].sort()).toEqual(
      ['claim', 'commitment', 'decision', 'meeting', 'person_fact', 'relation'].sort(),
    );
    expect([...resolveTimelineKinds('relation,meeting')]).toEqual(['relation', 'meeting']);
    expect(badRequest(() => resolveTimelineKinds('gossip')).details.unknown).toEqual(['gossip']);
  });

  it('maps a bad as_of to a 400', () => {
    expect(asOfOr400('2024-01-15').toISOString()).toBe('2024-01-15T00:00:00.000Z');
    expect(() => asOfOr400('2024-02-30')).toThrow(BadRequestException);
  });
});
