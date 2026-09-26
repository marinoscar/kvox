import { GRAPH_PREFERENCE_DEFAULTS, type GraphPreferences } from '../preferences/graph-preferences.defaults';
import type { ProposalResolution } from '../proposals/proposal-payload.schema';
import { applyPrecheck, type PrecheckItem } from './precheck';

const EXISTING = '0f000000-0000-4000-8000-000000000001';

const prefs = (over: Partial<GraphPreferences['resolution']> = {}): GraphPreferences => ({
  ...GRAPH_PREFERENCE_DEFAULTS,
  resolution: { ...GRAPH_PREFERENCE_DEFAULTS.resolution, ...over },
});

const res = (over: Partial<ProposalResolution> = {}): ProposalResolution => ({
  ref: null,
  score: null,
  source: null,
  candidates: [],
  adjudication: null,
  ...over,
});

const candidate = (score: number) => ({ entityId: EXISTING, label: 'X', type: 'Person', score, signals: [] });

function entity(ref: string, resolution: ProposalResolution | null, flags: string[] = []): PrecheckItem {
  return { kind: 'entity', payload: { ref, type: 'Person', label: ref }, resolution, flags, decision: 'pending' };
}

function relation(from: object, to: object, flags: string[] = []): PrecheckItem {
  return { kind: 'relation', payload: { ref: 'r1', type: 'WORKS_FOR', from, to }, resolution: null, flags, decision: 'pending' };
}

function item(kind: string, endpoints: Record<string, object | null>, flags: string[] = []): PrecheckItem {
  return {
    kind: 'item',
    payload: { ref: 'i1', kind, subject: null, owner: null, counterparty: null, meeting: null, ...endpoints },
    resolution: null,
    flags,
    decision: 'pending',
  };
}

function run(items: PrecheckItem[], p: GraphPreferences = prefs()): string[] {
  applyPrecheck(items, p);
  return items.map((i) => i.decision);
}

describe('applyPrecheck (#363)', () => {
  describe('entities', () => {
    it('accepts a confident link at or above autoLinkThreshold', () => {
      expect(run([entity('a', res({ ref: EXISTING, score: 0.9, source: 'alias' }))])).toEqual(['accept']);
      expect(run([entity('a', res({ ref: EXISTING, score: 0.89, source: 'alias' }))])).toEqual(['pending']);
    });

    it('does not accept a link the adjudicator was uncertain about', () => {
      const uncertain = res({ ref: EXISTING, score: 0.99, adjudication: { verdict: 'uncertain', rationale: '', model: 'm' } });
      const same = res({ ref: EXISTING, score: 0.99, adjudication: { verdict: 'same', rationale: '', model: 'm' } });
      expect(run([entity('a', uncertain), entity('b', same)])).toEqual(['pending', 'accept']);
    });

    it('a linked entity with no score is pending', () => {
      expect(run([entity('a', res({ ref: EXISTING, score: null, source: 'model' }))])).toEqual(['pending']);
    });

    it('accepts a new entity with no candidates, or a top candidate below newThreshold', () => {
      expect(run([entity('a', null), entity('b', res()), entity('c', res({ candidates: [candidate(0.3), candidate(0.54)] }))])).toEqual([
        'accept',
        'accept',
        'accept',
      ]);
      expect(run([entity('d', res({ candidates: [candidate(0.55)] }))])).toEqual(['pending']);
    });

    it.each(['possible_duplicate', 'ambiguous', 'model_claimed_match'])('never accepts an entity flagged %s', (flag) => {
      expect(run([entity('a', res({ ref: EXISTING, score: 1 }), [flag]), entity('b', null, [flag])])).toEqual(['pending', 'pending']);
    });

    it('honours per-user thresholds', () => {
      const r = res({ ref: EXISTING, score: 0.8 });
      expect(run([entity('a', r)], prefs({ autoLinkThreshold: 0.75 }))).toEqual(['accept']);
    });
  });

  describe('relations and items', () => {
    it('accepts when every endpoint is an existing entity or an accepted proposal entity', () => {
      const items = [entity('e1', null), relation({ ref: 'e1' }, { entityId: EXISTING })];
      expect(run(items)).toEqual(['accept', 'accept']);
    });

    it('waits when an endpoint is a pending proposal entity', () => {
      const items = [entity('e1', null, ['ambiguous']), relation({ ref: 'e1' }, { entityId: EXISTING })];
      expect(run(items)).toEqual(['pending', 'pending']);
    });

    it('checks every item endpoint, the meeting included', () => {
      const items = [
        entity('meeting', res({ ref: null, score: 1, source: 'meeting' })),
        entity('e1', res({ candidates: [candidate(0.9)] })),
        item('commitment', { subject: { entityId: EXISTING }, owner: { entityId: EXISTING }, meeting: { ref: 'meeting' } }),
        item('decision', { subject: { ref: 'e1' }, meeting: { ref: 'meeting' } }),
      ];
      expect(run(items)).toEqual(['accept', 'pending', 'accept', 'pending']);
    });

    it.each(['possible_duplicate', 'overlaps', 'unordered', 'supersedes', 'previously_rejected', 'stale_ontology'])(
      'never accepts a row flagged %s',
      (flag) => {
        expect(run([relation({ entityId: EXISTING }, { entityId: EXISTING }, [flag])])).toEqual(['pending']);
        expect(run([item('claim', { subject: { entityId: EXISTING } }, [flag])])).toEqual(['pending']);
      },
    );

    it('a quote_not_located flag alone does not block', () => {
      expect(run([relation({ entityId: EXISTING }, { entityId: EXISTING }, ['quote_not_located'])])).toEqual(['accept']);
    });

    it('never pre-checks a person fact, sensitive or not', () => {
      expect(run([item('person_fact', { subject: { entityId: EXISTING } })])).toEqual(['pending']);
      expect(run([item('person_fact', { subject: { entityId: EXISTING } }, ['sensitive'])])).toEqual(['pending']);
    });

    it('never pre-checks a closing', () => {
      const closing: PrecheckItem = { kind: 'closing', payload: {}, resolution: null, flags: [], decision: 'accept' };
      expect(run([closing])).toEqual(['pending']);
    });
  });

  it('review_all leaves everything pending', () => {
    const items = [entity('e1', null), relation({ ref: 'e1' }, { entityId: EXISTING }), item('claim', { subject: { entityId: EXISTING } })];
    expect(run(items, prefs({ mode: 'review_all' }))).toEqual(['pending', 'pending', 'pending']);
  });
});
