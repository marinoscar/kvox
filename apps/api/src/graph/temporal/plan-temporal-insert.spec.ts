import { ONTOLOGY } from '@app/shared/ontology';
import {
  edgesAsOf,
  planTemporalInsert,
  temporalRuleFor,
  type CandidateEdge,
  type TemporalEdge,
  type TemporalPlan,
  type TemporalReviewStatus,
  type TemporalRule,
  type ValidPrecision,
  type ValidRange,
} from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const d = (s: string): Date => new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);
const r = (from: string | null, to: string | null): ValidRange => ({
  from: from === null ? null : d(from),
  to: to === null ? null : d(to),
});

function ruleOf(key: string): TemporalRule {
  const spec = ONTOLOGY.relationType(key);
  if (!spec) throw new Error(`no relation type ${key}`);
  return temporalRuleFor(spec);
}

const WORKS_FOR = ruleOf('WORKS_FOR');
const HAS_ROLE = ruleOf('HAS_ROLE');
const REPORTS_TO = ruleOf('REPORTS_TO');
const ATTENDED = ruleOf('ATTENDED');

interface EdgeSpec {
  id: string;
  type?: string;
  fromId?: string;
  toId: string;
  props?: Record<string, unknown>;
  valid: ValidRange | null;
  precision?: ValidPrecision | null;
  status?: TemporalReviewStatus;
}

function edge(s: EdgeSpec): TemporalEdge {
  return {
    id: s.id,
    type: s.type ?? 'WORKS_FOR',
    fromId: s.fromId ?? 'joe',
    toId: s.toId,
    props: s.props ?? {},
    valid: s.valid,
    precision: s.precision === undefined ? (s.valid ? 'year' : 'unknown') : s.precision,
    reviewStatus: s.status ?? 'accepted',
  };
}

function cand(s: Omit<EdgeSpec, 'id' | 'status'>): CandidateEdge {
  return {
    type: s.type ?? 'WORKS_FOR',
    fromId: s.fromId ?? 'joe',
    toId: s.toId,
    props: s.props ?? {},
    valid: s.valid,
    precision: (s.precision ?? (s.valid ? 'year' : 'unknown')) as ValidPrecision,
  };
}

function created(over: Partial<Extract<TemporalPlan, { action: 'create' }>> = {}): TemporalPlan {
  return {
    action: 'create',
    closes: [],
    supersedes: null,
    candidateTo: null,
    flags: [],
    overlapsWith: [],
    ...over,
  };
}

const close = (edgeId: string, newTo: string) => ({ edgeId, newTo: d(newTo) });

// ---------------------------------------------------------------------------
// temporalRuleFor
// ---------------------------------------------------------------------------

describe('temporalRuleFor', () => {
  it.each<[string, TemporalRule]>([
    ['WORKS_FOR', { temporal: true, exclusive: 'soft', exclusiveScope: 'from', identityProps: [] }],
    [
      'HAS_ROLE',
      { temporal: true, exclusive: 'soft', exclusiveScope: 'from_to', identityProps: ['title'] },
    ],
    [
      'REPORTS_TO',
      { temporal: true, exclusive: 'soft', exclusiveScope: 'from', identityProps: [] },
    ],
    ['ATTENDED', { temporal: false, exclusive: 'none', exclusiveScope: 'from', identityProps: [] }],
  ])('%s', (key, expected) => {
    expect(ruleOf(key)).toEqual(expected);
  });

  it('defaults exclusiveScope to from and sorts required props only', () => {
    expect(
      temporalRuleFor({
        temporal: true,
        exclusive: 'soft',
        props: {
          zeta: { kind: 'text', label: 'Z', description: 'z', required: true },
          alpha: { kind: 'text', label: 'A', description: 'a', required: true },
          optional: { kind: 'text', label: 'O', description: 'o' },
        },
      })
    ).toEqual({
      temporal: true,
      exclusive: 'soft',
      exclusiveScope: 'from',
      identityProps: ['alpha', 'zeta'],
    });
  });
});

// ---------------------------------------------------------------------------
// The issue's case table (1–14)
// ---------------------------------------------------------------------------

describe('planTemporalInsert — case table', () => {
  it.each<[string, TemporalEdge[], CandidateEdge, TemporalRule, TemporalPlan]>([
    [
      '1. no existing edges',
      [],
      cand({ toId: 'acme', valid: r('2019-01-01', null) }),
      WORKS_FOR,
      created(),
    ],
    [
      '2. restated identical open edge',
      [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })],
      cand({ toId: 'acme', valid: r('2019-01-01', null) }),
      WORKS_FOR,
      { action: 'attach_evidence', edgeId: 'acme', reason: 'restated' },
    ],
    [
      '3. restated inside a closed edge',
      [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', '2026-01-01') })],
      cand({ toId: 'acme', valid: r('2020-05-01', '2020-05-02'), precision: 'day' }),
      WORKS_FOR,
      { action: 'attach_evidence', edgeId: 'acme', reason: 'inside_existing' },
    ],
    [
      '4. straddling the end of a closed identical edge → create, never merged',
      [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', '2024-01-01') })],
      cand({ toId: 'acme', valid: r('2023-01-01', '2025-01-01') }),
      WORKS_FOR,
      created({ flags: ['overlaps'], overlapsWith: ['acme'] }),
    ],
    [
      '5. closing a single open edge',
      [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })],
      cand({ toId: 'beta', valid: r('2026-03-01', null), precision: 'month' }),
      WORKS_FOR,
      created({ closes: [close('acme', '2026-03-01')], supersedes: 'acme' }),
    ],
    [
      '6. two open different edges: both close, the later is superseded',
      [
        edge({ id: 'z-acme', toId: 'acme', valid: r('2019-01-01', null) }),
        edge({ id: 'a-board', toId: 'board', valid: r('2021-06-01', null) }),
      ],
      cand({ toId: 'beta', valid: r('2026-03-01', null) }),
      WORKS_FOR,
      created({
        closes: [close('a-board', '2026-03-01'), close('z-acme', '2026-03-01')],
        supersedes: 'a-board',
      }),
    ],
    [
      '7. older open candidate gets candidateTo',
      [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })],
      cand({ toId: 'beta', valid: r('2015-01-01', null) }),
      WORKS_FOR,
      created({ candidateTo: d('2019-01-01') }),
    ],
    [
      '8. older bounded candidate that overlaps → overlaps',
      [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })],
      cand({ toId: 'beta', valid: r('2015-01-01', '2020-01-01') }),
      WORKS_FOR,
      created({ flags: ['overlaps'], overlapsWith: ['acme'] }),
    ],
    [
      '9. unknown-precision candidate against an open edge → unordered',
      [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })],
      cand({ toId: 'beta', valid: null, precision: 'unknown' }),
      WORKS_FOR,
      created({ flags: ['unordered'] }),
    ],
    [
      "10. exclusive 'none' never closes",
      [edge({ id: 'm1', type: 'ATTENDED', toId: 'meeting-1', valid: null })],
      cand({ type: 'ATTENDED', toId: 'meeting-2', valid: null }),
      ATTENDED,
      created(),
    ],
    [
      '11a. a rejected existing edge is ignored',
      [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null), status: 'rejected' })],
      cand({ toId: 'beta', valid: r('2026-03-01', null) }),
      WORKS_FOR,
      created(),
    ],
    [
      '11b. a merged existing edge is ignored',
      [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null), status: 'merged' })],
      cand({ toId: 'acme', valid: r('2019-01-01', null) }),
      WORKS_FOR,
      created(),
    ],
    [
      '12. title identity is case- and whitespace-insensitive',
      [
        edge({
          id: 'eng',
          type: 'HAS_ROLE',
          toId: 'acme',
          props: { title: 'Staff Engineer' },
          valid: r('2026-03-01', null),
        }),
      ],
      cand({
        type: 'HAS_ROLE',
        toId: 'acme',
        props: { title: '  staff ENGINEER ' },
        valid: r('2026-03-01', null),
      }),
      HAS_ROLE,
      { action: 'attach_evidence', edgeId: 'eng', reason: 'restated' },
    ],
    [
      '13. touching ranges [a,b) then [b,c) never overlap',
      [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', '2024-01-01') })],
      cand({ toId: 'beta', valid: r('2024-01-01', '2025-01-01') }),
      WORKS_FOR,
      created(),
    ],
    [
      '14. closes are ordered by edge id, not input order or start',
      [
        edge({ id: 'e-3', toId: 'c', valid: r('2010-01-01', null) }),
        edge({ id: 'e-1', toId: 'a', valid: r('2020-01-01', null) }),
        edge({ id: 'e-2', toId: 'b', valid: r(null, null) }),
      ],
      cand({ toId: 'd', valid: r('2026-01-01', null) }),
      WORKS_FOR,
      created({
        closes: [
          close('e-1', '2026-01-01'),
          close('e-2', '2026-01-01'),
          close('e-3', '2026-01-01'),
        ],
        supersedes: 'e-1',
      }),
    ],
  ])('%s', (_label, existing, candidate, rule, expected) => {
    expect(planTemporalInsert(existing, candidate, rule)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// The issue's acceptance examples (§5.4 worked examples)
// ---------------------------------------------------------------------------

describe('planTemporalInsert — acceptance examples', () => {
  it('promotion: Staff Engineer closes Engineer and supersedes it', () => {
    const engineer = edge({
      id: 'engineer',
      type: 'HAS_ROLE',
      toId: 'acme',
      props: { title: 'Engineer' },
      valid: r('2019-01-01', null),
    });
    const plan = planTemporalInsert(
      [engineer],
      cand({
        type: 'HAS_ROLE',
        toId: 'acme',
        props: { title: 'Staff Engineer' },
        valid: r('2026-03-01', null),
      }),
      HAS_ROLE
    );
    expect(plan).toEqual(
      created({ closes: [close('engineer', '2026-03-01')], supersedes: 'engineer' })
    );
  });

  it('manager change: Jane closes at 2026-03-01 and as_of 2024-01-15 reads Jane, not Will', () => {
    const jane = edge({
      id: 'jane',
      type: 'REPORTS_TO',
      toId: 'jane',
      valid: r('2020-01-01', null),
    });
    const candidate = cand({
      type: 'REPORTS_TO',
      toId: 'will',
      valid: r('2026-03-01', null),
      precision: 'month',
    });
    const plan = planTemporalInsert([jane], candidate, REPORTS_TO);
    expect(plan).toEqual(created({ closes: [close('jane', '2026-03-01')], supersedes: 'jane' }));

    // Apply the plan the way the commit (#366) would, then ask the past.
    if (plan.action !== 'create') throw new Error('expected create');
    const closedJane: TemporalEdge = {
      ...jane,
      valid: { from: jane.valid!.from, to: plan.closes[0].newTo },
      reviewStatus: 'superseded',
    };
    const will = edge({ id: 'will', type: 'REPORTS_TO', toId: 'will', valid: candidate.valid });
    expect(edgesAsOf([closedJane, will], d('2024-01-15')).map((e) => e.id)).toEqual(['jane']);
    expect(edgesAsOf([closedJane, will], d('2026-03-01')).map((e) => e.id)).toEqual(['will']);
  });

  it('out-of-order: a 2020 day-precision Acme fact inside [2019, 2026) attaches, no split or reopen', () => {
    const acme = edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', '2026-01-01') });
    const plan = planTemporalInsert(
      [acme],
      cand({ toId: 'acme', valid: r('2020-06-15', '2020-06-16'), precision: 'day' }),
      WORKS_FOR
    );
    expect(plan).toEqual({ action: 'attach_evidence', edgeId: 'acme', reason: 'inside_existing' });
  });

  it('older different fact: Beta from 2015 is proposed closed at 2019, nothing closed, no overlap', () => {
    const acme = edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) });
    const plan = planTemporalInsert(
      [acme],
      cand({ toId: 'beta', valid: r('2015-01-01', null) }),
      WORKS_FOR
    );
    expect(plan).toEqual(created({ candidateTo: d('2019-01-01') }));
  });

  it('soft overlap: Beta [2023, 2025) against closed Acme [2019, 2024) flags, closes nothing', () => {
    const acme = edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', '2024-01-01') });
    const plan = planTemporalInsert(
      [acme],
      cand({ toId: 'beta', valid: r('2023-01-01', '2025-01-01') }),
      WORKS_FOR
    );
    expect(plan).toEqual(created({ flags: ['overlaps'], overlapsWith: ['acme'] }));
  });

  it('HAS_ROLE scope from_to: a new role at Beta does not close a role at Acme', () => {
    const acmeRole = edge({
      id: 'acme-eng',
      type: 'HAS_ROLE',
      toId: 'acme',
      props: { title: 'Engineer' },
      valid: r('2019-01-01', null),
    });
    const plan = planTemporalInsert(
      [acmeRole],
      cand({
        type: 'HAS_ROLE',
        toId: 'beta',
        props: { title: 'Advisor' },
        valid: r('2026-03-01', null),
      }),
      HAS_ROLE
    );
    expect(plan).toEqual(created());
  });

  it('unknown start: an unknown candidate range with an open different edge → unordered, no closes', () => {
    const acme = edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) });
    const plan = planTemporalInsert(
      [acme],
      cand({ toId: 'beta', valid: null, precision: 'unknown' }),
      WORKS_FOR
    );
    expect(plan).toEqual(created({ flags: ['unordered'] }));
  });
});

// ---------------------------------------------------------------------------
// Rule-by-rule edge cases
// ---------------------------------------------------------------------------

describe('planTemporalInsert — rule 1 (non-temporal)', () => {
  const attended = edge({ id: 'm1', type: 'ATTENDED', toId: 'meeting-1', valid: null });

  it.each<[string, TemporalEdge[], CandidateEdge, TemporalPlan]>([
    [
      'same from/to restates',
      [attended],
      cand({ type: 'ATTENDED', toId: 'meeting-1', valid: null }),
      { action: 'attach_evidence', edgeId: 'm1', reason: 'restated' },
    ],
    [
      'an edited edge counts as live',
      [{ ...attended, reviewStatus: 'edited' }],
      cand({ type: 'ATTENDED', toId: 'meeting-1', valid: null }),
      { action: 'attach_evidence', edgeId: 'm1', reason: 'restated' },
    ],
    [
      'a superseded edge is not live',
      [{ ...attended, reviewStatus: 'superseded' }],
      cand({ type: 'ATTENDED', toId: 'meeting-1', valid: null }),
      created(),
    ],
    [
      'an unreviewed edge is not live',
      [{ ...attended, reviewStatus: 'unreviewed' }],
      cand({ type: 'ATTENDED', toId: 'meeting-1', valid: null }),
      created(),
    ],
    [
      'a different owner is out of scope',
      [attended],
      cand({ type: 'ATTENDED', fromId: 'ann', toId: 'meeting-1', valid: null }),
      created(),
    ],
    [
      'a different type is out of scope even if the caller forgot to filter',
      [attended],
      cand({ type: 'DISCUSSED', toId: 'meeting-1', valid: null }),
      created(),
    ],
    [
      'a candidate range is ignored for a non-temporal relation',
      [attended],
      cand({ type: 'ATTENDED', toId: 'meeting-1', valid: r('2026-01-01', null) }),
      { action: 'attach_evidence', edgeId: 'm1', reason: 'restated' },
    ],
    [
      'several matches attach to the lowest id',
      [attended, { ...attended, id: 'm0' }],
      cand({ type: 'ATTENDED', toId: 'meeting-1', valid: null }),
      { action: 'attach_evidence', edgeId: 'm0', reason: 'restated' },
    ],
  ])('%s', (_label, existing, candidate, expected) => {
    expect(planTemporalInsert(existing, candidate, ATTENDED)).toEqual(expected);
  });
});

describe('planTemporalInsert — rule 3 (same fact)', () => {
  it('an unknown-range restatement attaches to the open period of that fact', () => {
    const existing = [
      edge({ id: 'acme-1', toId: 'acme', valid: r('2010-01-01', '2012-01-01') }),
      edge({ id: 'acme-2', toId: 'acme', valid: r('2019-01-01', null) }),
    ];
    expect(planTemporalInsert(existing, cand({ toId: 'acme', valid: null }), WORKS_FOR)).toEqual({
      action: 'attach_evidence',
      edgeId: 'acme-2',
      reason: 'restated',
    });
  });

  it('an unknown-range restatement of a closed-only fact attaches to its latest period', () => {
    const existing = [
      edge({ id: 'acme-1', toId: 'acme', valid: r('2010-01-01', '2012-01-01') }),
      edge({ id: 'acme-2', toId: 'acme', valid: r('2015-01-01', '2018-01-01') }),
    ];
    expect(planTemporalInsert(existing, cand({ toId: 'acme', valid: null }), WORKS_FOR)).toEqual({
      action: 'attach_evidence',
      edgeId: 'acme-2',
      reason: 'restated',
    });
  });

  it('an unknown-range restatement attaches to an undated edge of the same fact', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: null })];
    expect(planTemporalInsert(existing, cand({ toId: 'acme', valid: null }), WORKS_FOR)).toEqual({
      action: 'attach_evidence',
      edgeId: 'acme',
      reason: 'restated',
    });
  });

  it('a candidate contained in an open period attaches inside_existing', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })];
    expect(
      planTemporalInsert(existing, cand({ toId: 'acme', valid: r('2024-01-01', null) }), WORKS_FOR)
    ).toEqual({
      action: 'attach_evidence',
      edgeId: 'acme',
      reason: 'inside_existing',
    });
  });

  it('a later role at the same organization with a different title is not the same fact', () => {
    const existing = [
      edge({
        id: 'eng',
        type: 'HAS_ROLE',
        toId: 'acme',
        props: { title: 'Engineer' },
        valid: r('2019-01-01', null),
      }),
    ];
    const plan = planTemporalInsert(
      existing,
      cand({
        type: 'HAS_ROLE',
        toId: 'acme',
        props: { title: 'Engineering Manager' },
        valid: r('2024-01-01', null),
      }),
      HAS_ROLE
    );
    expect(plan).toEqual(created({ closes: [close('eng', '2024-01-01')], supersedes: 'eng' }));
  });

  it('an older period of the same fact, reaching outside it, is created and flagged against the known period', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })];
    const plan = planTemporalInsert(
      existing,
      cand({ toId: 'acme', valid: r('2015-01-01', null) }),
      WORKS_FOR
    );
    expect(plan).toEqual(created({ flags: ['overlaps'], overlapsWith: ['acme'] }));
  });

  it('a disjoint earlier period of the same fact is a quiet create', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })];
    const plan = planTemporalInsert(
      existing,
      cand({ toId: 'acme', valid: r('2010-01-01', '2012-01-01') }),
      WORKS_FOR
    );
    expect(plan).toEqual(created());
  });

  it('non-string identity props compare structurally, absent ≡ null', () => {
    const rule: TemporalRule = { ...HAS_ROLE, identityProps: ['level', 'title'] };
    const existing = [
      edge({
        id: 'e',
        type: 'HAS_ROLE',
        toId: 'acme',
        props: { title: 'Engineer', level: { band: 3, track: 'ic' } },
        valid: r('2019-01-01', null),
      }),
    ];
    expect(
      planTemporalInsert(
        existing,
        cand({
          type: 'HAS_ROLE',
          toId: 'acme',
          props: { title: 'engineer', level: { track: 'ic', band: 3 } },
          valid: r('2019-01-01', null),
        }),
        rule
      )
    ).toEqual({ action: 'attach_evidence', edgeId: 'e', reason: 'restated' });

    const nullTitle = [
      edge({ id: 'n', type: 'HAS_ROLE', toId: 'acme', props: { title: null }, valid: null }),
    ];
    expect(
      planTemporalInsert(
        nullTitle,
        cand({ type: 'HAS_ROLE', toId: 'acme', props: {}, valid: null }),
        HAS_ROLE
      )
    ).toEqual({ action: 'attach_evidence', edgeId: 'n', reason: 'restated' });
  });
});

describe('planTemporalInsert — rules 4–7', () => {
  it('an open edge with an unknown start is closed too', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: r(null, null) })];
    expect(
      planTemporalInsert(existing, cand({ toId: 'beta', valid: r('2026-03-01', null) }), WORKS_FOR)
    ).toEqual(created({ closes: [close('acme', '2026-03-01')], supersedes: 'acme' }));
  });

  it('an open edge starting on the same day is not closed (it would be empty) and is flagged', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: r('2026-03-01', null) })];
    expect(
      planTemporalInsert(existing, cand({ toId: 'beta', valid: r('2026-03-01', null) }), WORKS_FOR)
    ).toEqual(created({ flags: ['overlaps'], overlapsWith: ['acme'] }));
  });

  it('supersedes the latest by from with unknown starts first', () => {
    const existing = [
      edge({ id: 'a', toId: 'a', valid: r('2021-01-01', null) }),
      edge({ id: 'b', toId: 'b', valid: r(null, null) }),
    ];
    const plan = planTemporalInsert(
      existing,
      cand({ toId: 'c', valid: r('2026-01-01', null) }),
      WORKS_FOR
    );
    expect(plan).toMatchObject({ supersedes: 'a' });
  });

  it('a bounded new fact still closes an older open edge at its start', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })];
    expect(
      planTemporalInsert(
        existing,
        cand({ toId: 'beta', valid: r('2023-01-01', '2025-01-01') }),
        WORKS_FOR
      )
    ).toEqual(created({ closes: [close('acme', '2023-01-01')], supersedes: 'acme' }));
  });

  it('candidateTo is the earliest later start, even of a closed edge', () => {
    const existing = [
      edge({ id: 'late', toId: 'late', valid: r('2022-01-01', null) }),
      edge({ id: 'mid', toId: 'mid', valid: r('2019-01-01', '2021-01-01') }),
    ];
    expect(
      planTemporalInsert(existing, cand({ toId: 'old', valid: r('2015-01-01', null) }), WORKS_FOR)
    ).toEqual(created({ candidateTo: d('2019-01-01') }));
  });

  it('closing and clipping together: close the earlier open edge, clip at the later one', () => {
    const existing = [
      edge({ id: 'early', toId: 'early', valid: r('2010-01-01', null) }),
      edge({ id: 'later', toId: 'later', valid: r('2020-01-01', '2021-01-01') }),
    ];
    // `early` is still open, `later` is a closed period after the candidate's start.
    expect(
      planTemporalInsert(existing, cand({ toId: 'new', valid: r('2015-01-01', null) }), WORKS_FOR)
    ).toEqual(
      created({
        closes: [close('early', '2015-01-01')],
        supersedes: 'early',
        candidateTo: d('2020-01-01'),
      })
    );
  });

  it('a bounded candidate is never clipped', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })];
    expect(
      planTemporalInsert(
        existing,
        cand({ toId: 'beta', valid: r('2015-01-01', '2017-01-01') }),
        WORKS_FOR
      )
    ).toEqual(created());
  });

  it('unknown start with only closed different edges is not unordered', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', '2020-01-01') })];
    expect(planTemporalInsert(existing, cand({ toId: 'beta', valid: null }), WORKS_FOR)).toEqual(
      created()
    );
  });

  it('unknown start with an undated different edge is unordered', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: null })];
    expect(planTemporalInsert(existing, cand({ toId: 'beta', valid: null }), WORKS_FOR)).toEqual(
      created({ flags: ['unordered'] })
    );
  });

  it('a left-open candidate closes nothing, is unordered against an open edge, and flags the overlap', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })];
    expect(
      planTemporalInsert(existing, cand({ toId: 'beta', valid: r(null, '2025-01-01') }), WORKS_FOR)
    ).toEqual(created({ flags: ['overlaps', 'unordered'], overlapsWith: ['acme'] }));
  });

  it('a dated candidate against an undated different edge closes nothing and is unordered', () => {
    const existing = [edge({ id: 'acme', toId: 'acme', valid: null })];
    expect(
      planTemporalInsert(existing, cand({ toId: 'beta', valid: r('2026-01-01', null) }), WORKS_FOR)
    ).toEqual(created({ flags: ['unordered'] }));
  });

  it('overlapsWith is sorted by id and only lists edges still overlapping after the closes', () => {
    const existing = [
      edge({ id: 'z-open', toId: 'z', valid: r('2019-01-01', null) }), // closed at 2023 → touching
      edge({ id: 'b-closed', toId: 'b', valid: r('2022-01-01', '2024-01-01') }),
      edge({ id: 'a-closed', toId: 'a', valid: r('2020-01-01', '2023-06-01') }),
      edge({ id: 'c-before', toId: 'c', valid: r('2010-01-01', '2011-01-01') }),
    ];
    expect(
      planTemporalInsert(
        existing,
        cand({ toId: 'new', valid: r('2023-01-01', '2025-01-01') }),
        WORKS_FOR
      )
    ).toEqual(
      created({
        closes: [close('z-open', '2023-01-01')],
        supersedes: 'z-open',
        flags: ['overlaps'],
        overlapsWith: ['a-closed', 'b-closed'],
      })
    );
  });

  it('a rejected close leaves a concurrent pair, which the next plan treats as overlap, not error', () => {
    // A reviewer rejected closing Acme when Beta arrived: both stay open.
    const existing = [
      edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) }),
      edge({ id: 'beta', toId: 'beta', valid: r('2023-01-01', null) }),
    ];
    const plan = planTemporalInsert(
      existing,
      cand({ toId: 'acme', valid: r('2024-01-01', '2024-01-02') }),
      WORKS_FOR
    );
    expect(plan).toEqual({ action: 'attach_evidence', edgeId: 'acme', reason: 'inside_existing' });
  });

  it('exclusive none with temporal ranges neither closes, clips nor flags', () => {
    const rule: TemporalRule = { ...WORKS_FOR, exclusive: 'none' };
    const existing = [edge({ id: 'acme', toId: 'acme', valid: r('2019-01-01', null) })];
    expect(
      planTemporalInsert(existing, cand({ toId: 'beta', valid: r('2015-01-01', null) }), rule)
    ).toEqual(created());
    expect(
      planTemporalInsert(existing, cand({ toId: 'beta', valid: r('2026-01-01', null) }), rule)
    ).toEqual(created());
    expect(planTemporalInsert(existing, cand({ toId: 'beta', valid: null }), rule)).toEqual(
      created()
    );
  });

  it('REPORTS_TO scope is the person: a new manager closes the old one whoever it is', () => {
    const existing = [
      edge({ id: 'jane', type: 'REPORTS_TO', toId: 'jane', valid: r('2020-01-01', null) }),
      edge({
        id: 'other',
        type: 'REPORTS_TO',
        fromId: 'ann',
        toId: 'jane',
        valid: r('2020-01-01', null),
      }),
    ];
    expect(
      planTemporalInsert(
        existing,
        cand({ type: 'REPORTS_TO', toId: 'will', valid: r('2026-03-01', null) }),
        REPORTS_TO
      )
    ).toEqual(created({ closes: [close('jane', '2026-03-01')], supersedes: 'jane' }));
  });
});

describe('planTemporalInsert — determinism and purity', () => {
  const existing = [
    edge({ id: 'e-3', toId: 'c', valid: r('2010-01-01', null) }),
    edge({ id: 'e-1', toId: 'a', valid: r('2020-01-01', null) }),
    edge({ id: 'e-2', toId: 'b', valid: r('2021-01-01', '2027-01-01') }),
  ];
  const candidate = cand({ toId: 'd', valid: r('2026-01-01', null) });

  it('gives the same plan for every permutation of the input', () => {
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((order) => order.map((i) => existing[i]));
    const plans = permutations.map((p) => planTemporalInsert(p, candidate, WORKS_FOR));
    for (const plan of plans) expect(plan).toEqual(plans[0]);
    expect(plans[0]).toEqual(
      created({
        closes: [close('e-1', '2026-01-01'), close('e-3', '2026-01-01')],
        supersedes: 'e-1',
        flags: ['overlaps'],
        overlapsWith: ['e-2'],
      })
    );
  });

  it('does not mutate its inputs, and newTo is a fresh Date', () => {
    const snapshot = JSON.stringify({ existing, candidate });
    const plan = planTemporalInsert(Object.freeze([...existing]), candidate, WORKS_FOR);
    expect(JSON.stringify({ existing, candidate })).toBe(snapshot);
    if (plan.action !== 'create') throw new Error('expected create');
    expect(plan.closes[0].newTo).not.toBe(candidate.valid!.from);
  });
});
