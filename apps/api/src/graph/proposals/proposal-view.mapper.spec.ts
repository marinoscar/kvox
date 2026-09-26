import { computeEffectiveSchema } from '@app/shared/ontology';

import {
  countsOf,
  displayOf,
  evidenceViewOf,
  formatDateAtPrecision,
  formatPeriod,
  groupKeyOf,
  itemViewOf,
  orderItemViews,
  precheckedOf,
  refLabelsOf,
  summaryOf,
  type EvidenceRowInput,
  type ProposalItemRowInput,
  type ViewLookups,
} from './proposal-view.mapper';

const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const SARAH = '0f000000-0000-4000-8000-000000000001';

function lookups(extra: Partial<ViewLookups> = {}): ViewLookups {
  return {
    schema,
    entityLabels: new Map([[SARAH, 'Sarah Chen']]),
    segments: new Map(),
    noteVersions: new Map(),
    prechecked: new Set(),
    ...extra,
  };
}

function row(over: Partial<ProposalItemRowInput>): ProposalItemRowInput {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    kind: 'entity',
    origin: 'ai',
    decision: 'pending',
    payload: {},
    editedPayload: null,
    resolution: null,
    mergeIntoId: null,
    distinctFrom: [],
    flags: [],
    committedRefId: null,
    sortOrder: 0,
    ...over,
  };
}

describe('proposal view mapper', () => {
  describe('groupKeyOf', () => {
    it.each([
      ['entity', { type: 'Person' }, 'Person'],
      ['entity', { type: 'Meeting' }, 'Meeting'],
      ['entity', { type: 'Hobby' }, 'Other'],
      ['item', { kind: 'person_fact' }, 'PersonFact'],
      ['item', { kind: 'commitment' }, 'Commitment'],
      ['relation', { type: 'WORKS_FOR' }, 'relations'],
      ['closing', {}, 'closings'],
    ] as const)('%s %j → %s', (kind, payload, key) => {
      expect(groupKeyOf(kind, payload)).toBe(key);
    });
  });

  describe('dates at precision', () => {
    it('formats a date at its precision', () => {
      expect(formatDateAtPrecision('2026-03-04', 'day')).toBe('Mar 4, 2026');
      expect(formatDateAtPrecision('2026-03-04', 'month')).toBe('Mar 2026');
      expect(formatDateAtPrecision('2026-03-04', 'year')).toBe('2026');
      expect(formatDateAtPrecision('soon', 'day')).toBe('soon');
    });

    it('formats a period, or null when unknown', () => {
      expect(formatPeriod('2019-01-01', '2025-12-31', 'year')).toBe('2019 → 2025');
      expect(formatPeriod('2026-03-01', null, 'month')).toBe('since Mar 2026');
      expect(formatPeriod(null, '2026-03-01', 'month')).toBe('until Mar 2026');
      expect(formatPeriod('2026-03-01', null, 'unknown')).toBeNull();
      expect(formatPeriod('2026-01-01', '2026-06-01', 'year')).toBe('2026');
    });
  });

  describe('display strings', () => {
    const refs = new Map([['e2', 'Northwind Robotics']]);

    it('entity: label, type label and a meeting date', () => {
      expect(displayOf('entity', { type: 'Meeting', label: 'Kickoff', occurredAt: '2026-03-04' }, refs, lookups())).toEqual({
        title: 'Kickoff',
        subtitle: 'Meeting · Mar 4, 2026',
      });
    });

    it('relation: endpoints by ref and by entity id, the lower-cased relation label, the period', () => {
      const d = displayOf(
        'relation',
        { type: 'WORKS_FOR', from: { entityId: SARAH }, to: { ref: 'e2' }, validFrom: '2019-01-01', validTo: null, precision: 'year' },
        refs,
        lookups(),
      );
      expect(d).toEqual({ title: 'Sarah Chen → works for → Northwind Robotics', subtitle: 'Works for · since 2019' });
    });

    it('commitment: owner and due date', () => {
      const d = displayOf(
        'item',
        { kind: 'commitment', title: 'Send the deck', owner: { entityId: SARAH }, dueAt: '2026-03-10', precision: 'unknown' },
        refs,
        lookups(),
      );
      expect(d).toEqual({ title: 'Send the deck', subtitle: 'Commitment · Sarah Chen · due Mar 10, 2026' });
    });

    it("closing: #365's 'Closes: …' copy", () => {
      const d = displayOf(
        'closing',
        {
          relationType: 'HAS_ROLE',
          fromLabel: 'Sarah Chen',
          toLabel: 'Northwind Robotics',
          roleTitle: 'Director',
          previousValid: { from: '2019-01-01', to: null, precision: 'year' },
          closeAt: '2026-03-01',
          precision: 'month',
          affectedCommitments: [{ itemId: SARAH, title: 'x', role: 'owner' }],
        },
        refs,
        lookups(),
      );
      expect(d).toEqual({
        title: 'Closes: Sarah Chen has role Northwind Robotics, as Director, 2019 → Mar 2026',
        subtitle: 'Affects 1 open commitment',
      });
    });
  });

  describe('evidence stale rules', () => {
    const base: EvidenceRowInput = {
      id: 'b0000000-0000-4000-8000-000000000001',
      subjectId: 'x',
      transcriptId: null,
      segmentId: null,
      segmentRev: null,
      startMs: null,
      endMs: null,
      noteId: null,
      noteVersion: null,
      charStart: 0,
      charEnd: 4,
      quote: 'text',
    };
    const seg = { ...base, transcriptId: 't', segmentId: 's', segmentRev: 2, startMs: 0, endMs: 10 };
    const note = { ...base, noteId: 'n', noteVersion: 3 };

    it('segment: fresh at its rev, stale at another rev or once the segment is gone', () => {
      const l = lookups({ segments: new Map([['s', { rev: 2, speakerName: 'Sarah Chen' }]]) });
      expect(evidenceViewOf(seg, l)).toEqual(expect.objectContaining({ source: 'segment', stale: false, speakerName: 'Sarah Chen' }));
      expect(evidenceViewOf({ ...seg, segmentRev: 1 }, l).stale).toBe(true);
      expect(evidenceViewOf({ ...seg, segmentId: null }, l)).toEqual(expect.objectContaining({ source: 'segment', stale: true }));
    });

    it('note: fresh at the current version, stale otherwise or once the note is gone', () => {
      const l = lookups({ noteVersions: new Map([['n', 3]]) });
      expect(evidenceViewOf(note, l)).toEqual(expect.objectContaining({ source: 'note', stale: false, speakerName: null }));
      expect(evidenceViewOf({ ...note, noteVersion: 2 }, l).stale).toBe(true);
      expect(evidenceViewOf({ ...note, noteId: null }, l).stale).toBe(true);
    });
  });

  describe('items, ordering and counts', () => {
    const rows = [
      row({ id: 'r1', kind: 'relation', decision: 'accept', payload: { type: 'WORKS_FOR', from: { ref: 'e1' }, to: { ref: 'e2' } } }),
      row({ id: 'e2', decision: 'reject', payload: { ref: 'e2', type: 'Organization', label: 'Northwind' } }),
      row({ id: 'e1', decision: 'edit', payload: { ref: 'e1', type: 'Person', label: 'Sara' }, editedPayload: { ref: 'e1', type: 'Person', label: 'Sarah' } }),
      row({ id: 'c1', kind: 'closing', payload: {} }),
      row({ id: 'k1', kind: 'item', decision: 'merge_into', flags: ['known'], payload: { kind: 'claim', title: 'Known' } }),
    ];

    it('counts by decision, by flag and by every group', () => {
      const counts = countsOf(rows);
      expect(counts).toEqual(expect.objectContaining({ total: 5, pending: 1, accepted: 3, rejected: 1, known: 1 }));
      expect(counts.byGroup).toEqual(expect.objectContaining({ Person: 1, Organization: 1, relations: 1, closings: 1, Claim: 1, Project: 0, Other: 0 }));
      expect(Object.keys(counts.byGroup)).toHaveLength(11);
    });

    it('effective payload is the edit; ref labels come from it', () => {
      expect(refLabelsOf(rows).get('e1')).toBe('Sarah');
      const view = itemViewOf(rows[2], [], refLabelsOf(rows), lookups({ prechecked: new Set(['e1']) }));
      expect(view.effectivePayload.label).toBe('Sarah');
      expect(view.prechecked).toBe(true);
    });

    it('orders by the Contract group order, then title', () => {
      const refs = refLabelsOf(rows);
      const views = rows.map((r) => itemViewOf(r, [], refs, lookups()));
      const ordered = orderItemViews(views, new Map(rows.map((r, i) => [r.id, i])));
      expect(ordered.map((v) => v.groupKey)).toEqual(['Person', 'Organization', 'Claim', 'relations', 'closings']);
    });

    it('resolution carries the label of its ref or merge target', () => {
      const view = itemViewOf(
        row({ resolution: { ref: SARAH, score: 0.9, source: 'alias', candidates: [], adjudication: null }, payload: { ref: 'e9', type: 'Person', label: 'S' } }),
        [],
        new Map(),
        lookups(),
      );
      expect(view.resolution?.refLabel).toBe('Sarah Chen');
    });
  });

  it('summary: failure, guidance, prechecked hidden from stats', () => {
    const summary = summaryOf(
      {
        id: 'p',
        kind: 'extraction',
        status: 'failed',
        noteId: 'n',
        noteVersion: 1,
        model: 'm',
        provider: 'openai',
        userGuidance: { pinnedEntityIds: [], instructions: 'focus' },
        stats: { phase: 'ready', prechecked: ['x'], failure: { errorClass: 'refusal', message: 'no' } },
        committedAt: null,
        revertedAt: null,
        createdAt: new Date('2026-03-04T00:00:00.000Z'),
      },
      { title: 'Kickoff', currentVersion: 2 },
      countsOf([]),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        noteTitle: 'Kickoff',
        noteCurrentVersion: 2,
        providerId: 'openai',
        failure: { errorClass: 'refusal', message: 'no' },
        userGuidance: { pinnedEntityIds: [], instructions: 'focus' },
      }),
    );
    expect(summary.stats).not.toHaveProperty('prechecked');
    expect(precheckedOf({ prechecked: ['a', 1] })).toEqual(new Set(['a']));
  });
});
