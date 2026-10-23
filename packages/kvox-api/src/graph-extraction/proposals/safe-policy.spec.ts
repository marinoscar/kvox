import { applySafePolicy, isSensitivePersonFact, type SafePolicyItem } from './safe-policy.js';

const base = (o: Partial<SafePolicyItem> & { id: string }): SafePolicyItem => ({
  kind: 'item',
  decision: 'pending',
  ref: null,
  itemKind: 'commitment',
  sensitivity: null,
  reviewOnly: false,
  flags: [],
  resolution: null,
  endpointRefs: [],
  ...o,
});
const opts = { minConfidence: 0.7 };
const reasonOf = (r: ReturnType<typeof applySafePolicy>, id: string) => r.waiting.find((w) => w.itemId === id)?.reason;

describe('applySafePolicy', () => {
  it('accepts a plain new entity and a row whose endpoint is accepted', () => {
    const r = applySafePolicy(
      [base({ id: 'e', kind: 'entity', itemKind: null, ref: 'e1' }), base({ id: 'c', endpointRefs: ['e1'] })],
      opts,
    );
    expect(r.accept.sort()).toEqual(['c', 'e']);
    expect(r.waiting).toEqual([]);
  });

  it('NEVER accepts a sensitive person fact, in every combination', () => {
    for (const sensitivity of ['personal', 'sensitive', null, 'weird'])
      for (const flags of [[], ['sensitive'], ['known'], ['sensitive', 'known']])
        for (const reviewOnly of [false, true])
          for (const minConfidence of [0, 0.5, 1])
            for (const withEndpoint of [false, true]) {
              const r = applySafePolicy(
                [
                  base({ id: 'e', kind: 'entity', itemKind: null, ref: 'e1' }),
                  base({ id: 'pf', itemKind: 'person_fact', sensitivity, flags, reviewOnly, endpointRefs: withEndpoint ? ['e1'] : [] }),
                ],
                { minConfidence },
              );
              expect(r.accept).not.toContain('pf');
              expect(reasonOf(r, 'pf')).toBe('sensitive');
            }
    expect(isSensitivePersonFact(base({ id: 'x', itemKind: 'person_fact', sensitivity: 'sensitive' }))).toBe(true);
  });

  it('accepts a business person fact', () => {
    const r = applySafePolicy([base({ id: 'pf', itemKind: 'person_fact', sensitivity: 'business' })], opts);
    expect(r.accept).toEqual(['pf']);
  });

  it('holds closings, merges, ambiguity, low confidence, review-only types and flagged rows', () => {
    const r = applySafePolicy(
      [
        base({ id: 'closing', kind: 'closing', itemKind: null }),
        base({ id: 'merge', kind: 'entity', itemKind: null, ref: 'm', resolution: { ref: 'x', score: 0.95 } }),
        base({ id: 'amb', kind: 'entity', itemKind: null, ref: 'a', flags: ['ambiguous'] }),
        base({ id: 'unc', kind: 'entity', itemKind: null, ref: 'u', resolution: { ref: null, score: null, adjudication: { verdict: 'uncertain' } } }),
        base({ id: 'low', kind: 'entity', itemKind: null, ref: 'l', resolution: { ref: null, score: 0.6 } }),
        base({ id: 'rev', kind: 'entity', itemKind: null, ref: 'r', reviewOnly: true }),
        base({ id: 'flag', flags: ['supersedes'] }),
      ],
      opts,
    );
    expect(r.accept).toEqual([]);
    expect(Object.fromEntries(r.waiting.map((w) => [w.itemId, w.reason]))).toEqual({
      closing: 'closing',
      merge: 'merge',
      amb: 'ambiguous',
      unc: 'ambiguous',
      low: 'low_confidence',
      rev: 'sensitive',
      flag: 'flagged',
    });
  });

  it('low confidence applies only below the threshold, for a scored new entity', () => {
    const ent = (score: number) => base({ id: 'x', kind: 'entity', itemKind: null, ref: 'x1', resolution: { ref: null, score } });
    expect(applySafePolicy([ent(0.25)], opts).accept).toEqual(['x']);
    expect(applySafePolicy([ent(0.31)], opts).waiting[0]?.reason).toBe('low_confidence');
  });

  it('a dependant waits when its endpoint entity waits or is rejected', () => {
    const r = applySafePolicy(
      [
        base({ id: 'e1', kind: 'entity', itemKind: null, ref: 'e1', flags: ['ambiguous'] }),
        base({ id: 'e2', kind: 'entity', itemKind: null, ref: 'e2', decision: 'reject' }),
        base({ id: 'a', endpointRefs: ['e1'] }),
        base({ id: 'b', endpointRefs: ['e2'] }),
      ],
      opts,
    );
    expect(r.accept).toEqual([]);
    expect(reasonOf(r, 'a')).toBe('blocked_endpoint');
    expect(reasonOf(r, 'b')).toBe('blocked_endpoint');
  });

  it('keeps rejected rows rejected and counts accepted rows as accepted', () => {
    const r = applySafePolicy(
      [
        base({ id: 'rej', decision: 'reject' }),
        base({ id: 'acc', decision: 'accept' }),
        base({ id: 'edit', decision: 'edit' }),
        base({ id: 'mg', kind: 'entity', itemKind: null, decision: 'merge_into' }),
        base({ id: 'e', kind: 'entity', itemKind: null, ref: 'e1', decision: 'accept' }),
        base({ id: 'dep', endpointRefs: ['e1'] }),
      ],
      opts,
    );
    expect(r.rejected).toEqual(['rej']);
    expect(r.alreadyAccepted.sort()).toEqual(['acc', 'e', 'edit', 'mg']);
    expect(r.accept).toEqual(['dep']);
  });

  it('a relation a waiting closing points to waits with it', () => {
    const r = applySafePolicy(
      [base({ id: 'rel', kind: 'relation', itemKind: null, ref: 'r1' }), base({ id: 'cl', kind: 'closing', itemKind: null, closedByRef: 'r1' })],
      opts,
    );
    expect(r.accept).toEqual([]);
    expect(reasonOf(r, 'rel')).toBe('flagged');
  });
});
