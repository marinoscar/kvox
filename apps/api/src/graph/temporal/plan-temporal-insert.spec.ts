import {
  edgesAsOf,
  planTemporalInsert,
  type CandidateEdge,
  type TemporalEdge,
  type TemporalPlan,
  type TemporalReviewStatus,
  type TemporalRule,
  type ValidRange,
} from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const r = (from: string | null, to: string | null): ValidRange => ({
  from: from === null ? null : d(from),
  to: to === null ? null : d(to),
});

// The three relation rules §5.2 declares, as #350's ONTOLOGY would supply them.
const WORKS_FOR: TemporalRule = {
  temporal: true,
  exclusive: 'soft',
  exclusiveScope: 'from',
  identityProps: [],
};
const REPORTS_TO: TemporalRule = {
  temporal: true,
  exclusive: 'soft',
  exclusiveScope: 'from',
  identityProps: [],
};
const HAS_ROLE: TemporalRule = {
  temporal: true,
  exclusive: 'soft',
  exclusiveScope: 'from_to',
  identityProps: ['title'],
};
const ATTENDED: TemporalRule = {
  temporal: false,
  exclusive: 'none',
  exclusiveScope: 'from',
  identityProps: [],
};
/** A hypothetical temporal but non-exclusive relation. */
const MEMBER_OF: TemporalRule = {
  temporal: true,
  exclusive: 'none',
  exclusiveScope: 'from',
  identityProps: [],
};

const edge = (
  id: string,
  type: string,
  toId: string,
  valid: ValidRange | null,
  props: Record<string, unknown> = {},
  reviewStatus: TemporalReviewStatus = 'accepted',
  fromId = 'joe'
): TemporalEdge => ({
  id,
  type,
  fromId,
  toId,
  props,
  valid,
  precision: valid ? 'day' : 'unknown',
  reviewStatus,
});

const candidate = (
  type: string,
  toId: string,
  valid: ValidRange | null,
  props: Record<string, unknown> = {},
  fromId = 'joe'
): CandidateEdge => ({ type, fromId, toId, props, valid, precision: valid ? 'day' : 'unknown' });

const created = (
  partial: Partial<Extract<TemporalPlan, { action: 'create' }>> = {}
): TemporalPlan => ({
  action: 'create',
  closes: [],
  supersedes: null,
  candidateTo: null,
  flags: [],
  overlapsWith: [],
  ...partial,
});

// ---------------------------------------------------------------------------
// The issue's case table (#353, "Tests")
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  existing: TemporalEdge[];
  candidate: CandidateEdge;
  rule: TemporalRule;
  expected: TemporalPlan;
}

const cases: Case[] = [
  {
    name: '1. no existing edges → plain create',
    existing: [],
    candidate: candidate('WORKS_FOR', 'acme', r('2019-01-01', null)),
    rule: WORKS_FOR,
    expected: created(),
  },
  {
    name: '2. restated identical open edge → attach (restated)',
    existing: [edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null))],
    candidate: candidate('WORKS_FOR', 'acme', r('2019-01-01', null)),
    rule: WORKS_FOR,
    expected: { action: 'attach_evidence', edgeId: 'acme', reason: 'restated' },
  },
  {
    name: '3. restated inside a closed edge → attach (inside_existing), no split, no reopen',
    existing: [edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', '2026-01-01'))],
    candidate: candidate('WORKS_FOR', 'acme', r('2020-05-04', '2020-05-05')),
    rule: WORKS_FOR,
    expected: { action: 'attach_evidence', edgeId: 'acme', reason: 'inside_existing' },
  },
  {
    name: '4. candidate straddling the end of a closed identical edge → create, never merged',
    existing: [edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', '2024-01-01'))],
    candidate: candidate('WORKS_FOR', 'acme', r('2023-01-01', '2025-01-01')),
    rule: WORKS_FOR,
    expected: created(),
  },
  {
    name: '5. closing a single open edge',
    existing: [edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null))],
    candidate: candidate('WORKS_FOR', 'beta', r('2026-03-01', null)),
    rule: WORKS_FOR,
    expected: created({ closes: [{ edgeId: 'acme', newTo: d('2026-03-01') }], supersedes: 'acme' }),
  },
  {
    name: '6. two open different edges (a legit concurrent pair) → both closed, later one superseded',
    existing: [
      edge('board', 'WORKS_FOR', 'board', r('2021-01-01', null)),
      edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null)),
    ],
    candidate: candidate('WORKS_FOR', 'beta', r('2026-03-01', null)),
    rule: WORKS_FOR,
    expected: created({
      closes: [
        { edgeId: 'acme', newTo: d('2026-03-01') },
        { edgeId: 'board', newTo: d('2026-03-01') },
      ],
      supersedes: 'board',
    }),
  },
  {
    name: '7. older, open, different candidate → candidateTo at the next start, nothing closed',
    existing: [edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null))],
    candidate: candidate('WORKS_FOR', 'beta', r('2015-01-01', null)),
    rule: WORKS_FOR,
    expected: created({ candidateTo: d('2019-01-01') }),
  },
  {
    name: '8. older, bounded candidate that overlaps → overlaps, nothing closed',
    existing: [edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null))],
    candidate: candidate('WORKS_FOR', 'beta', r('2018-01-01', '2020-01-01')),
    rule: WORKS_FOR,
    expected: created({ flags: ['overlaps'], overlapsWith: ['acme'] }),
  },
  {
    name: '9. unknown-precision candidate against an open edge → unordered, nothing closed',
    existing: [edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null))],
    candidate: candidate('WORKS_FOR', 'beta', null),
    rule: WORKS_FOR,
    expected: created({ flags: ['unordered'] }),
  },
  {
    name: "10. exclusive: 'none' never closes (temporal)",
    existing: [edge('club', 'MEMBER_OF', 'club', r('2019-01-01', null))],
    candidate: candidate('MEMBER_OF', 'guild', r('2026-03-01', null)),
    rule: MEMBER_OF,
    expected: created(),
  },
  {
    name: "10b. exclusive: 'none', non-temporal (ATTENDED) → create a new meeting's edge",
    existing: [edge('att1', 'ATTENDED', 'meeting-1', null)],
    candidate: candidate('ATTENDED', 'meeting-2', null),
    rule: ATTENDED,
    expected: created(),
  },
  {
    name: '11a. a rejected existing edge is ignored',
    existing: [edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null), {}, 'rejected')],
    candidate: candidate('WORKS_FOR', 'beta', r('2026-03-01', null)),
    rule: WORKS_FOR,
    expected: created(),
  },
  {
    name: '11b. a merged existing edge is ignored — even as a same-fact match',
    existing: [edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null), {}, 'merged')],
    candidate: candidate('WORKS_FOR', 'acme', r('2019-01-01', null)),
    rule: WORKS_FOR,
    expected: created(),
  },
  {
    name: '12. title identity is case- and whitespace-insensitive',
    existing: [edge('eng', 'HAS_ROLE', 'acme', r('2019-01-01', null), { title: 'Staff Engineer' })],
    candidate: candidate('HAS_ROLE', 'acme', r('2020-06-01', null), { title: '  staff ENGINEER ' }),
    rule: HAS_ROLE,
    expected: { action: 'attach_evidence', edgeId: 'eng', reason: 'inside_existing' },
  },
  {
    name: '13. touching ranges [a,b) then [b,c) never overlap',
    existing: [edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', '2024-01-01'))],
    candidate: candidate('WORKS_FOR', 'beta', r('2024-01-01', '2025-01-01')),
    rule: WORKS_FOR,
    expected: created(),
  },
];

describe('planTemporalInsert — the issue #353 case table', () => {
  it.each(cases)('$name', ({ existing, candidate: c, rule, expected }) => {
    expect(planTemporalInsert(existing, c, rule)).toEqual(expected);
  });

  it('14. closes are sorted by edge id whatever the input order', () => {
    const ids = ['m', 'c', 'x', 'a', 'q'];
    const existing = ids.map((id, i) =>
      edge(id, 'WORKS_FOR', `org-${id}`, r(`201${i}-01-01`, null))
    );
    const c = candidate('WORKS_FOR', 'beta', r('2026-03-01', null));
    for (const order of [existing, [...existing].reverse()]) {
      const plan = planTemporalInsert(order, c, WORKS_FOR);
      expect(plan.action).toBe('create');
      if (plan.action !== 'create') return;
      expect(plan.closes.map((x) => x.edgeId)).toEqual(['a', 'c', 'm', 'q', 'x']);
      // supersedes is the LATEST start (2014, 'q'), not the last id.
      expect(plan.supersedes).toBe('q');
    }
  });

  it('14b. overlapsWith is sorted by edge id', () => {
    const existing = [
      edge('z', 'WORKS_FOR', 'z-org', r('2019-01-01', '2024-01-01')),
      edge('b', 'WORKS_FOR', 'b-org', r('2020-01-01', '2024-06-01')),
    ];
    const plan = planTemporalInsert(
      existing,
      candidate('WORKS_FOR', 'beta', r('2023-01-01', '2025-01-01')),
      WORKS_FOR
    );
    expect(plan).toEqual(created({ flags: ['overlaps'], overlapsWith: ['b', 'z'] }));
  });
});

// ---------------------------------------------------------------------------
// The acceptance criteria's worked examples (§5.4)
// ---------------------------------------------------------------------------

describe('planTemporalInsert — §5.4 worked examples', () => {
  it('a promotion closes Engineer at 2026-03-01 and supersedes it', () => {
    const engineer = edge('engineer', 'HAS_ROLE', 'acme', r('2019-01-01', null), {
      title: 'Engineer',
    });
    const plan = planTemporalInsert(
      [engineer],
      candidate('HAS_ROLE', 'acme', r('2026-03-01', null), { title: 'Staff Engineer' }),
      HAS_ROLE
    );
    expect(plan).toEqual(
      created({ closes: [{ edgeId: 'engineer', newTo: d('2026-03-01') }], supersedes: 'engineer' })
    );
  });

  it('a manager change closes Jane at 2026-03-01; as of 2024-01-15 reads Jane, not Will', () => {
    const jane = edge('jane', 'REPORTS_TO', 'jane', r('2020-01-01', null));
    const plan = planTemporalInsert(
      [jane],
      candidate('REPORTS_TO', 'will', r('2026-03-01', null)),
      REPORTS_TO
    );
    expect(plan).toEqual(
      created({ closes: [{ edgeId: 'jane', newTo: d('2026-03-01') }], supersedes: 'jane' })
    );

    // Apply the plan the way #366 would once a reviewer accepts the close.
    if (plan.action !== 'create') throw new Error('unreachable');
    const graph: TemporalEdge[] = [
      {
        ...jane,
        valid: { from: jane.valid!.from, to: plan.closes[0].newTo },
        reviewStatus: 'superseded',
      },
      edge('will', 'REPORTS_TO', 'will', r('2026-03-01', null)),
    ];
    expect(edgesAsOf(graph, d('2024-01-15')).map((e) => e.id)).toEqual(['jane']);
    expect(edgesAsOf(graph, d('2026-04-01')).map((e) => e.id)).toEqual(['will']);
  });

  it('out-of-order: a 2020 day-precision Acme fact inside [2019, 2026) attaches, no split or reopen', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', '2026-01-01'));
    expect(
      planTemporalInsert(
        [acme],
        candidate('WORKS_FOR', 'acme', r('2020-03-02', '2020-03-03')),
        WORKS_FOR
      )
    ).toEqual({ action: 'attach_evidence', edgeId: 'acme', reason: 'inside_existing' });
  });

  it('older different fact: Beta from 2015 → candidateTo 2019-01-01, nothing closed, no overlap', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null));
    expect(
      planTemporalInsert([acme], candidate('WORKS_FOR', 'beta', r('2015-01-01', null)), WORKS_FOR)
    ).toEqual(created({ candidateTo: d('2019-01-01') }));
  });

  it('soft overlap: Beta [2023, 2025) against closed Acme [2019, 2024) → overlaps, nothing closed', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', '2024-01-01'));
    expect(
      planTemporalInsert(
        [acme],
        candidate('WORKS_FOR', 'beta', r('2023-01-01', '2025-01-01')),
        WORKS_FOR
      )
    ).toEqual(created({ flags: ['overlaps'], overlapsWith: ['acme'] }));
  });

  it('HAS_ROLE scope from_to: a new role at Beta does not close a role at Acme', () => {
    const acmeRole = edge('acme-eng', 'HAS_ROLE', 'acme', r('2019-01-01', null), {
      title: 'Engineer',
    });
    expect(
      planTemporalInsert(
        [acmeRole],
        candidate('HAS_ROLE', 'beta', r('2026-03-01', null), { title: 'Advisor' }),
        HAS_ROLE
      )
    ).toEqual(created());
  });

  it('WORKS_FOR scope from: a new employer DOES close the old one (contrast with from_to)', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null));
    const plan = planTemporalInsert(
      [acme],
      candidate('WORKS_FOR', 'beta', r('2026-03-01', null)),
      WORKS_FOR
    );
    expect(plan).toEqual(
      created({ closes: [{ edgeId: 'acme', newTo: d('2026-03-01') }], supersedes: 'acme' })
    );
  });
});

// ---------------------------------------------------------------------------
// Further edge cases
// ---------------------------------------------------------------------------

describe('planTemporalInsert — further edge cases', () => {
  it('an unknown-range restatement of a known fact attaches (restated)', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null));
    expect(planTemporalInsert([acme], candidate('WORKS_FOR', 'acme', null), WORKS_FOR)).toEqual({
      action: 'attach_evidence',
      edgeId: 'acme',
      reason: 'restated',
    });
  });

  it('an unknown-range restatement prefers the open same-fact period over an older closed one', () => {
    const existing = [
      edge('acme-2', 'WORKS_FOR', 'acme', r('2022-01-01', null)),
      edge('acme-1', 'WORKS_FOR', 'acme', r('2015-01-01', '2018-01-01')),
    ];
    expect(planTemporalInsert(existing, candidate('WORKS_FOR', 'acme', null), WORKS_FOR)).toEqual({
      action: 'attach_evidence',
      edgeId: 'acme-2',
      reason: 'restated',
    });
  });

  it('a later open candidate inside an open same-fact edge attaches (inside_existing)', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null));
    expect(
      planTemporalInsert([acme], candidate('WORKS_FOR', 'acme', r('2021-01-01', null)), WORKS_FOR)
    ).toEqual({
      action: 'attach_evidence',
      edgeId: 'acme',
      reason: 'inside_existing',
    });
  });

  it('a same-fact candidate starting BEFORE an open edge is a different period → create', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null));
    expect(
      planTemporalInsert([acme], candidate('WORKS_FOR', 'acme', r('2015-01-01', null)), WORKS_FOR)
    ).toEqual(created());
  });

  it('a new period for the same fact after a closed one → create; different open facts still close', () => {
    const existing = [
      edge('acme-1', 'WORKS_FOR', 'acme', r('2015-01-01', '2018-01-01')),
      edge('beta', 'WORKS_FOR', 'beta', r('2018-01-01', null)),
    ];
    expect(
      planTemporalInsert(existing, candidate('WORKS_FOR', 'acme', r('2024-01-01', null)), WORKS_FOR)
    ).toEqual(
      created({ closes: [{ edgeId: 'beta', newTo: d('2024-01-01') }], supersedes: 'beta' })
    );
  });

  it('an open edge with an unbounded start is closable, and is superseded last by start order', () => {
    const existing = [
      edge('dated', 'WORKS_FOR', 'dated', r('2010-01-01', null)),
      edge('ancient', 'WORKS_FOR', 'ancient', r(null, null)),
    ];
    expect(
      planTemporalInsert(existing, candidate('WORKS_FOR', 'beta', r('2026-03-01', null)), WORKS_FOR)
    ).toEqual(
      created({
        closes: [
          { edgeId: 'ancient', newTo: d('2026-03-01') },
          { edgeId: 'dated', newTo: d('2026-03-01') },
        ],
        supersedes: 'dated',
      })
    );
  });

  it('an open edge starting on the SAME day as the candidate is neither closed nor back-dating → overlaps', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2026-03-01', null));
    expect(
      planTemporalInsert([acme], candidate('WORKS_FOR', 'beta', r('2026-03-01', null)), WORKS_FOR)
    ).toEqual(created({ flags: ['overlaps'], overlapsWith: ['acme'] }));
  });

  it('closes an open edge and back-dates against a later one in the same plan', () => {
    const existing = [
      edge('old', 'WORKS_FOR', 'old', r('2010-01-01', null)),
      edge('new', 'WORKS_FOR', 'new', r('2020-01-01', null)),
    ];
    // Candidate from 2015, open: `old` closes at 2015, the candidate ends at 2020.
    // `new` [2020, ) touches the candidate's final [2015, 2020) — no overlap.
    expect(
      planTemporalInsert(existing, candidate('WORKS_FOR', 'mid', r('2015-01-01', null)), WORKS_FOR)
    ).toEqual(
      created({
        closes: [{ edgeId: 'old', newTo: d('2015-01-01') }],
        supersedes: 'old',
        candidateTo: d('2020-01-01'),
      })
    );
  });

  it('candidateTo is the EARLIEST later start, closed edges included', () => {
    const existing = [
      edge('b', 'WORKS_FOR', 'b', r('2021-01-01', null)),
      edge('a', 'WORKS_FOR', 'a', r('2017-01-01', '2019-01-01')),
    ];
    expect(
      planTemporalInsert(existing, candidate('WORKS_FOR', 'x', r('2015-01-01', null)), WORKS_FOR)
    ).toEqual(created({ candidateTo: d('2017-01-01') }));
  });

  it('a bounded candidate is never back-dated', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null));
    expect(
      planTemporalInsert(
        [acme],
        candidate('WORKS_FOR', 'beta', r('2015-01-01', '2016-01-01')),
        WORKS_FOR
      )
    ).toEqual(created());
  });

  it('a left-unbounded candidate against an open edge is unordered AND overlapping', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', null));
    expect(
      planTemporalInsert([acme], candidate('WORKS_FOR', 'beta', r(null, '2020-01-01')), WORKS_FOR)
    ).toEqual(created({ flags: ['overlaps', 'unordered'], overlapsWith: ['acme'] }));
  });

  it('an unknown-range candidate with only closed different edges → plain create', () => {
    const acme = edge('acme', 'WORKS_FOR', 'acme', r('2019-01-01', '2020-01-01'));
    expect(planTemporalInsert([acme], candidate('WORKS_FOR', 'beta', null), WORKS_FOR)).toEqual(
      created()
    );
  });

  it('an undated existing different edge is never closed, and flags unordered', () => {
    const undated = edge('undated', 'WORKS_FOR', 'acme', null);
    expect(
      planTemporalInsert(
        [undated],
        candidate('WORKS_FOR', 'beta', r('2026-03-01', null)),
        WORKS_FOR
      )
    ).toEqual(created({ flags: ['unordered'] }));
  });

  it('an undated existing same-fact edge flags a dated candidate unordered rather than silently duplicating', () => {
    const undated = edge('undated', 'WORKS_FOR', 'acme', null);
    expect(
      planTemporalInsert(
        [undated],
        candidate('WORKS_FOR', 'acme', r('2019-01-01', null)),
        WORKS_FOR
      )
    ).toEqual(created({ flags: ['unordered'] }));
    // …while an undated restatement of it attaches.
    expect(planTemporalInsert([undated], candidate('WORKS_FOR', 'acme', null), WORKS_FOR)).toEqual({
      action: 'attach_evidence',
      edgeId: 'undated',
      reason: 'restated',
    });
  });

  it('edited edges are live; superseded and unreviewed ones are not', () => {
    const c = candidate('WORKS_FOR', 'beta', r('2026-03-01', null));
    expect(
      planTemporalInsert(
        [edge('e', 'WORKS_FOR', 'acme', r('2019-01-01', null), {}, 'edited')],
        c,
        WORKS_FOR
      )
    ).toEqual(created({ closes: [{ edgeId: 'e', newTo: d('2026-03-01') }], supersedes: 'e' }));
    for (const status of ['superseded', 'unreviewed'] as const) {
      expect(
        planTemporalInsert(
          [edge('e', 'WORKS_FOR', 'acme', r('2019-01-01', null), {}, status)],
          c,
          WORKS_FOR
        )
      ).toEqual(created());
    }
  });

  it("another person's edge, or another type, is out of scope even if the caller forgets to filter", () => {
    const existing = [
      edge('ann-acme', 'WORKS_FOR', 'acme', r('2019-01-01', null), {}, 'accepted', 'ann'),
      edge('joe-role', 'HAS_ROLE', 'acme', r('2019-01-01', null), { title: 'Engineer' }),
    ];
    expect(
      planTemporalInsert(existing, candidate('WORKS_FOR', 'beta', r('2026-03-01', null)), WORKS_FOR)
    ).toEqual(created());
  });

  it('HAS_ROLE: same org, same title (case-folded) inside the open period attaches', () => {
    const existing = [
      edge('eng', 'HAS_ROLE', 'acme', r('2019-01-01', null), { title: 'Engineer' }),
    ];
    expect(
      planTemporalInsert(
        existing,
        candidate('HAS_ROLE', 'acme', r('2019-06-01', '2019-06-02'), { title: 'engineer' }),
        HAS_ROLE
      )
    ).toEqual({ action: 'attach_evidence', edgeId: 'eng', reason: 'inside_existing' });
  });

  it('a missing identity prop only matches another missing one', () => {
    const existing = [edge('eng', 'HAS_ROLE', 'acme', r('2019-01-01', null), {})];
    expect(
      planTemporalInsert(
        existing,
        candidate('HAS_ROLE', 'acme', r('2020-01-01', null), { title: 'Engineer' }),
        HAS_ROLE
      )
    ).toEqual(created({ closes: [{ edgeId: 'eng', newTo: d('2020-01-01') }], supersedes: 'eng' }));
    expect(
      planTemporalInsert(
        existing,
        candidate('HAS_ROLE', 'acme', r('2020-01-01', null), {}),
        HAS_ROLE
      )
    ).toEqual({
      action: 'attach_evidence',
      edgeId: 'eng',
      reason: 'inside_existing',
    });
  });

  it("exclusive: 'none' never flags overlaps or unordered either", () => {
    const club = edge('club', 'MEMBER_OF', 'club', r('2019-01-01', null));
    expect(
      planTemporalInsert([club], candidate('MEMBER_OF', 'guild', r('2015-01-01', null)), MEMBER_OF)
    ).toEqual(created());
    expect(planTemporalInsert([club], candidate('MEMBER_OF', 'guild', null), MEMBER_OF)).toEqual(
      created()
    );
  });

  describe('rule 1: non-temporal relations', () => {
    it('restating the same edge attaches evidence', () => {
      const att = edge('att', 'ATTENDED', 'meeting-1', null);
      expect(planTemporalInsert([att], candidate('ATTENDED', 'meeting-1', null), ATTENDED)).toEqual(
        {
          action: 'attach_evidence',
          edgeId: 'att',
          reason: 'restated',
        }
      );
    });

    it('a rejected restatement target is ignored', () => {
      const att = edge('att', 'ATTENDED', 'meeting-1', null, {}, 'rejected');
      expect(planTemporalInsert([att], candidate('ATTENDED', 'meeting-1', null), ATTENDED)).toEqual(
        created()
      );
    });

    it('identity props decide sameness for a non-temporal relation too', () => {
      const rule: TemporalRule = { ...ATTENDED, identityProps: ['role'] };
      const att = edge('att', 'ATTENDED', 'meeting-1', null, { role: 'Chair' });
      expect(
        planTemporalInsert(
          [att],
          candidate('ATTENDED', 'meeting-1', null, { role: ' chair' }),
          rule
        )
      ).toEqual({
        action: 'attach_evidence',
        edgeId: 'att',
        reason: 'restated',
      });
      expect(
        planTemporalInsert(
          [att],
          candidate('ATTENDED', 'meeting-1', null, { role: 'Scribe' }),
          rule
        )
      ).toEqual(created());
    });
  });

  it('does not mutate its inputs', () => {
    const existing = Object.freeze([
      Object.freeze(edge('acme', 'WORKS_FOR', 'acme', Object.freeze(r('2019-01-01', null)))),
    ]);
    const c = Object.freeze(candidate('WORKS_FOR', 'beta', Object.freeze(r('2015-01-01', null))));
    expect(() => planTemporalInsert(existing, c, WORKS_FOR)).not.toThrow();
    expect(existing[0].valid).toEqual(r('2019-01-01', null));
  });

  it('is deterministic: the same input always yields the same plan', () => {
    const existing = [
      edge('b', 'WORKS_FOR', 'b', r('2012-01-01', null)),
      edge('a', 'WORKS_FOR', 'a', r('2011-01-01', null)),
      edge('c', 'WORKS_FOR', 'c', r('2019-01-01', '2027-01-01')),
    ];
    const c = candidate('WORKS_FOR', 'x', r('2026-03-01', null));
    const first = planTemporalInsert(existing, c, WORKS_FOR);
    expect(planTemporalInsert([...existing].reverse(), c, WORKS_FOR)).toEqual(first);
    expect(first).toEqual(
      created({
        closes: [
          { edgeId: 'a', newTo: d('2026-03-01') },
          { edgeId: 'b', newTo: d('2026-03-01') },
        ],
        supersedes: 'b',
        flags: ['overlaps'],
        overlapsWith: ['c'],
      })
    );
  });
});
