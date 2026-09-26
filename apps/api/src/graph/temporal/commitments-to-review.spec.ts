import {
  commitmentsToReview,
  type TemporalEdge,
  type TemporalPlan,
  type ValidRange,
} from './index';

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const open = (from: string): ValidRange => ({ from: d(from), to: null });
const edge = (id: string, type: string, fromId: string, toId: string): TemporalEdge => ({
  id,
  type,
  fromId,
  toId,
  props: {},
  valid: open('2019-01-01'),
  precision: 'year',
  reviewStatus: 'accepted',
});
const closing = (...edgeIds: string[]): TemporalPlan => ({
  action: 'create',
  closes: edgeIds.map((edgeId) => ({ edgeId, newTo: d('2026-03-01') })),
  supersedes: edgeIds[edgeIds.length - 1] ?? null,
  candidateTo: null,
  flags: [],
  overlapsWith: [],
});

const commitments = [
  { id: 'c3', ownerPersonId: 'joe', counterpartyId: null },
  { id: 'c1', ownerPersonId: 'ann', counterpartyId: 'joe' },
  { id: 'c2', ownerPersonId: 'ann', counterpartyId: 'acme' },
  { id: 'c4', ownerPersonId: null, counterpartyId: null },
  { id: 'c5', ownerPersonId: 'joe', counterpartyId: 'joe' },
];

describe('commitmentsToReview', () => {
  it('flags open commitments owned by or owed to the person whose WORKS_FOR closes', () => {
    const worksFor = edge('w1', 'WORKS_FOR', 'joe', 'acme');
    expect(commitmentsToReview(closing('w1'), [worksFor], commitments)).toEqual(['c1', 'c3', 'c5']);
  });

  it.each(['HAS_ROLE', 'REPORTS_TO'])('flags nothing for a %s close', (type) => {
    const e = edge('e1', type, 'joe', 'acme');
    expect(commitmentsToReview(closing('e1'), [e], commitments)).toEqual([]);
  });

  it('flags nothing when the plan closes nothing, or attaches evidence', () => {
    const worksFor = edge('w1', 'WORKS_FOR', 'joe', 'acme');
    expect(commitmentsToReview(closing(), [worksFor], commitments)).toEqual([]);
    expect(
      commitmentsToReview(
        { action: 'attach_evidence', edgeId: 'w1', reason: 'restated' },
        [worksFor],
        commitments
      )
    ).toEqual([]);
  });

  it('ignores a supplied edge the plan does not close', () => {
    const worksFor = edge('w1', 'WORKS_FOR', 'joe', 'acme');
    expect(commitmentsToReview(closing('other'), [worksFor], commitments)).toEqual([]);
  });

  it('covers several people when several WORKS_FOR edges close, de-duplicated and sorted', () => {
    const edges = [edge('w1', 'WORKS_FOR', 'joe', 'acme'), edge('w2', 'WORKS_FOR', 'ann', 'beta')];
    const dupes = [...commitments, commitments[0]];
    expect(commitmentsToReview(closing('w1', 'w2'), edges, dupes)).toEqual([
      'c1',
      'c2',
      'c3',
      'c5',
    ]);
  });
});
