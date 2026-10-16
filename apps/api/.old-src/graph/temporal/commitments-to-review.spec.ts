import {
  COMMITMENT_REVIEW_RELATION,
  commitmentsToReview,
  type TemporalEdge,
  type TemporalPlan,
} from './index';

const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

function edge(id: string, type: string, fromId: string, toId: string): TemporalEdge {
  return {
    id,
    type,
    fromId,
    toId,
    props: {},
    valid: { from: d('2019-01-01'), to: null },
    precision: 'year',
    reviewStatus: 'accepted',
  };
}

const create = (closes: string[]): TemporalPlan => ({
  action: 'create',
  closes: closes.map((edgeId) => ({ edgeId, newTo: d('2026-03-01') })),
  supersedes: closes[closes.length - 1] ?? null,
  candidateTo: null,
  flags: [],
  overlapsWith: [],
});

const commitments = [
  { id: 'c-owner', ownerPersonId: 'joe', counterpartyId: 'org-x' },
  { id: 'c-counterparty', ownerPersonId: 'ann', counterpartyId: 'joe' },
  { id: 'c-both', ownerPersonId: 'joe', counterpartyId: 'joe' },
  { id: 'c-other', ownerPersonId: 'ann', counterpartyId: 'bob' },
  { id: 'c-nulls', ownerPersonId: null, counterpartyId: null },
];

describe('commitmentsToReview', () => {
  it('is keyed on WORKS_FOR', () => {
    expect(COMMITMENT_REVIEW_RELATION).toBe('WORKS_FOR');
  });

  it('flags open commitments where the person whose WORKS_FOR closes is owner or counterparty', () => {
    const works = edge('w-acme', 'WORKS_FOR', 'joe', 'acme');
    expect(commitmentsToReview(create(['w-acme']), [works], commitments)).toEqual([
      'c-both',
      'c-counterparty',
      'c-owner',
    ]);
  });

  it.each(['HAS_ROLE', 'REPORTS_TO'])('flags nothing when a %s edge closes', (type) => {
    const closed = edge('e1', type, 'joe', 'acme');
    expect(commitmentsToReview(create(['e1']), [closed], commitments)).toEqual([]);
  });

  it('flags nothing for attach_evidence or a create that closes nothing', () => {
    const works = edge('w-acme', 'WORKS_FOR', 'joe', 'acme');
    const attach: TemporalPlan = {
      action: 'attach_evidence',
      edgeId: 'w-acme',
      reason: 'restated',
    };
    expect(commitmentsToReview(attach, [works], commitments)).toEqual([]);
    expect(commitmentsToReview(create([]), [works], commitments)).toEqual([]);
  });

  it('ignores supplied edges the plan does not close', () => {
    const works = edge('w-acme', 'WORKS_FOR', 'joe', 'acme');
    const unrelated = edge('w-ann', 'WORKS_FOR', 'ann', 'beta');
    expect(commitmentsToReview(create(['w-acme']), [works, unrelated], commitments)).toEqual([
      'c-both',
      'c-counterparty',
      'c-owner',
    ]);
  });

  it('covers several closing people, deduplicated and sorted', () => {
    const joe = edge('w-joe', 'WORKS_FOR', 'joe', 'acme');
    const ann = edge('w-ann', 'WORKS_FOR', 'ann', 'acme');
    const dup = [...commitments, { id: 'c-owner', ownerPersonId: 'joe', counterpartyId: null }];
    expect(commitmentsToReview(create(['w-joe', 'w-ann']), [joe, ann], dup)).toEqual([
      'c-both',
      'c-counterparty',
      'c-other',
      'c-owner',
    ]);
  });

  it('returns nothing when no commitment names the person', () => {
    const works = edge('w-zed', 'WORKS_FOR', 'zed', 'acme');
    expect(commitmentsToReview(create(['w-zed']), [works], commitments)).toEqual([]);
  });
});
