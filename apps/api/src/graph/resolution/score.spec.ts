import { bandFor, rankCandidates, scoreCandidate, sourceForArm, type CandidateFeatures } from './score';

const none: CandidateFeatures = {
  aliasExact: false,
  trigram: null,
  cosine: null,
  sameMeeting: false,
  orgCoMention: false,
  sharedNeighbour: false,
  recent: false,
};
const f = (over: Partial<CandidateFeatures>): CandidateFeatures => ({ ...none, ...over });
const thresholds = { autoLinkThreshold: 0.9, newThreshold: 0.55 };

describe('scoreCandidate (the §7 table)', () => {
  it('scores an exact alias/label match at 0.80', () => {
    expect(scoreCandidate(f({ aliasExact: true }))).toEqual({ score: 0.8, signals: ['alias_exact'], arm: 'alias_exact' });
  });

  it.each([
    [0.4, 0.4],
    [0.7, 0.6],
    [1, 0.8],
  ])('maps trigram similarity %s to base %s', (s, base) => {
    const r = scoreCandidate(f({ trigram: s }));
    expect(r.score).toBeCloseTo(base, 4);
    expect(r.arm).toBe('trigram');
  });

  it('ignores a trigram similarity below 0.4', () => {
    expect(scoreCandidate(f({ trigram: 0.39 }))).toEqual({ score: 0, signals: [], arm: null });
  });

  it.each([
    [0.5, 0.3],
    [0.75, 0.3],
    [0.875, 0.45],
    [1, 0.6],
  ])('maps a vector-only cosine %s to base %s', (c, base) => {
    const r = scoreCandidate(f({ cosine: c }));
    expect(r.score).toBeCloseTo(base, 4);
    expect(r.arm).toBe('vector');
  });

  it('takes the strongest arm as the base when several found the candidate', () => {
    expect(scoreCandidate(f({ aliasExact: true, trigram: 0.7, cosine: 0.99 })).arm).toBe('alias_exact');
    expect(scoreCandidate(f({ trigram: 0.55, cosine: 1 })).arm).toBe('vector');
  });

  it('adds +0.15 for a same-meeting attendee and +0.15 for an organization co-mention', () => {
    expect(scoreCandidate(f({ aliasExact: true, sameMeeting: true })).score).toBeCloseTo(0.95, 4);
    expect(scoreCandidate(f({ trigram: 0.4, orgCoMention: true })).score).toBeCloseTo(0.55, 4);
  });

  it('caps the strong signals together at +0.20', () => {
    const r = scoreCandidate(f({ trigram: 0.4, sameMeeting: true, orgCoMention: true }));
    expect(r.score).toBeCloseTo(0.6, 4);
    expect(r.signals).toEqual(['trigram', 'same_meeting', 'org_co_mention']);
  });

  it('adds +0.05 for a shared neighbour and +0.02 for recency', () => {
    expect(scoreCandidate(f({ trigram: 0.4, sharedNeighbour: true })).score).toBeCloseTo(0.45, 4);
    expect(scoreCandidate(f({ trigram: 0.4, recent: true })).score).toBeCloseTo(0.42, 4);
  });

  it('never exceeds 1', () => {
    const r = scoreCandidate(f({ aliasExact: true, sameMeeting: true, orgCoMention: true, sharedNeighbour: true, recent: true }));
    expect(r.score).toBe(1);
  });

  it('lets recency only break a tie, never cross a band on its own weight', () => {
    // A recent candidate outranks an otherwise identical one…
    const a = { entityId: 'a', ...scoreCandidate(f({ trigram: 0.7 })) };
    const b = { entityId: 'b', ...scoreCandidate(f({ trigram: 0.7, recent: true })) };
    const ranked = rankCandidates([a, b], thresholds);
    expect(ranked.candidates[0].entityId).toBe('b');
    // …but 0.02 is smaller than the ambiguity margin, so both stay "ambiguous".
    expect(ranked.ambiguous).toBe(true);
    // And an exact alias alone plus recency stays below auto-link.
    expect(scoreCandidate(f({ aliasExact: true, recent: true })).score).toBeLessThan(thresholds.autoLinkThreshold);
  });
});

describe('rankCandidates (the ambiguity rule)', () => {
  const c = (entityId: string, score: number) => ({ entityId, score, signals: ['alias_exact'], arm: 'alias_exact' as const });

  it('caps the best just below auto-link and flags it when the runner-up is within 0.05', () => {
    const r = rankCandidates([c('a', 0.95), c('b', 0.91)], thresholds);
    expect(r.ambiguous).toBe(true);
    expect(r.candidates[0]).toMatchObject({ entityId: 'a', score: 0.89 });
    expect(r.candidates[0].signals).toContain('ambiguous');
  });

  it('leaves a clear winner alone', () => {
    const r = rankCandidates([c('b', 0.6), c('a', 0.95)], thresholds);
    expect(r.ambiguous).toBe(false);
    expect(r.candidates.map((x) => [x.entityId, x.score])).toEqual([
      ['a', 0.95],
      ['b', 0.6],
    ]);
  });

  it('does not flag two candidates that are both below the new threshold', () => {
    expect(rankCandidates([c('a', 0.45), c('b', 0.44)], thresholds).ambiguous).toBe(false);
  });

  it('does not mutate its input', () => {
    const input = [c('a', 0.95), c('b', 0.93)];
    rankCandidates(input, thresholds);
    expect(input[0].score).toBe(0.95);
  });
});

describe('bandFor / sourceForArm', () => {
  it('splits scores into the three bands', () => {
    expect(bandFor(null, thresholds)).toBe('new');
    expect(bandFor(0.54, thresholds)).toBe('new');
    expect(bandFor(0.55, thresholds)).toBe('middle');
    expect(bandFor(0.89, thresholds)).toBe('middle');
    expect(bandFor(0.9, thresholds)).toBe('link');
  });

  it('names the resolution source after the arm', () => {
    expect(sourceForArm('alias_exact')).toBe('alias');
    expect(sourceForArm('trigram')).toBe('trigram');
    expect(sourceForArm('vector')).toBe('vector');
    expect(sourceForArm(null)).toBeNull();
  });
});
