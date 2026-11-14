import {
  centroid,
  cosineSimilarity,
  decideVoiceSuggestion,
  l2Normalize,
  selectVoiceprintWindows,
  VOICEPRINT_MAX_SAMPLES_PER_PERSON,
  VOICEPRINT_SUGGESTION_DEFAULTS,
  VOICEPRINT_WINDOW_DEFAULTS,
} from './voiceprint-policy.js';

describe('selectVoiceprintWindows', () => {
  it('drops short segments, trims the edges and sorts by start', () => {
    const r = selectVoiceprintWindows([
      { startMs: 10000, endMs: 14000 },
      { startMs: 0, endMs: 1499 },
      { startMs: 2000, endMs: 3500 },
    ]);
    expect(r.windows).toEqual([
      { startMs: 2200, endMs: 3300 },
      { startMs: 10200, endMs: 13800 },
    ]);
    expect(r.totalSpeechMs).toBe(1100 + 3600);
  });

  it('keeps a segment of exactly the minimum length', () => {
    expect(selectVoiceprintWindows([{ startMs: 0, endMs: 1500 }]).windows).toEqual([{ startMs: 200, endMs: 1300 }]);
  });

  it('takes the longest first and cuts the last window to the 30 s cap', () => {
    const segs = [
      { startMs: 0, endMs: 20000 },
      { startMs: 30000, endMs: 50000 },
      { startMs: 60000, endMs: 63000 },
    ];
    const r = selectVoiceprintWindows(segs);
    expect(r.totalSpeechMs).toBe(30000);
    expect(r.windows).toEqual([
      { startMs: 200, endMs: 19800 },
      { startMs: 30200, endMs: 40600 },
    ]);
  });

  it('honours overrides, returns nothing for no speech and exports its defaults', () => {
    expect(selectVoiceprintWindows([], {})).toEqual({ windows: [], totalSpeechMs: 0 });
    const r = selectVoiceprintWindows([{ startMs: 0, endMs: 1000 }], { minSegmentMs: 500, trimMs: 100 });
    expect(r.windows).toEqual([{ startMs: 100, endMs: 900 }]);
    expect(VOICEPRINT_WINDOW_DEFAULTS).toEqual({ minSegmentMs: 1500, trimMs: 200, maxTotalMs: 30000 });
    expect(VOICEPRINT_MAX_SAMPLES_PER_PERSON).toBe(10);
  });
});

describe('vector helpers', () => {
  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-2, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow();
  });

  it('normalises and averages', () => {
    expect(Array.from(l2Normalize([3, 4]))).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(Array.from(l2Normalize([0, 0]))).toEqual([0, 0]);
    const c = centroid([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(c[0]).toBeCloseTo(Math.SQRT1_2);
    expect(c[1]).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(...c)).toBeCloseTo(1);
    expect(() => centroid([])).toThrow();
    expect(() => centroid([[1], [1, 2]])).toThrow();
  });
});

describe('decideVoiceSuggestion', () => {
  it('exports the calibrated defaults', () => {
    expect(VOICEPRINT_SUGGESTION_DEFAULTS).toEqual({ threshold: 0.52, margin: 0.05 });
  });

  it('suggests the best candidate that clears the threshold and the margin', () => {
    const r = decideVoiceSuggestion([
      { entityId: 'b', score: 0.4 },
      { entityId: 'a', score: 0.7 },
    ]);
    expect(r?.entityId).toBe('a');
    expect(r?.score).toBe(0.7);
    expect(r?.margin).toBeCloseTo(0.3);
  });

  it('suggests a lone candidate on the threshold alone, inclusive', () => {
    expect(decideVoiceSuggestion([{ entityId: 'a', score: 0.52 }])?.entityId).toBe('a');
    expect(decideVoiceSuggestion([{ entityId: 'a', score: 0.5199 }])).toBeNull();
    expect(decideVoiceSuggestion([])).toBeNull();
  });

  it('refuses when the lead over the runner-up is below the margin, accepts at it', () => {
    expect(decideVoiceSuggestion([{ entityId: 'a', score: 0.7 }, { entityId: 'b', score: 0.66 }])).toBeNull();
    expect(decideVoiceSuggestion([{ entityId: 'a', score: 0.75 }, { entityId: 'b', score: 0.5 }])?.entityId).toBe('a');
    expect(decideVoiceSuggestion([{ entityId: 'a', score: 0.6 }, { entityId: 'b', score: 0.5 }], { margin: 0.1 })).not.toBeNull();
    expect(decideVoiceSuggestion([{ entityId: 'a', score: 0.6 }, { entityId: 'b', score: 0.51 }], { margin: 0.1 })).toBeNull();
  });

  it('honours a threshold override and ignores non-finite scores', () => {
    expect(decideVoiceSuggestion([{ entityId: 'a', score: 0.4 }], { threshold: 0.3 })?.entityId).toBe('a');
    expect(decideVoiceSuggestion([{ entityId: 'a', score: Number.NaN }, { entityId: 'b', score: 0.8 }])?.entityId).toBe('b');
  });
});
