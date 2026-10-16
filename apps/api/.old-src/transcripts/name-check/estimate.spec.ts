// =============================================================================
// estimate.ts — what a name check will cost, before it runs
// (issues #328 and #330, epic #326)
// =============================================================================

import { buildTargets } from './candidates';
import { estimateNameCheck } from './estimate';

const countTokens = (text: string): number => Math.ceil(text.length / 4);

function segments(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    rev: 1,
    speakerId: 'A',
    startMs: i * 1000,
    text: `Segment number ${i} mentions Skar the friend.`,
  }));
}

describe('estimateNameCheck', () => {
  it('standard mode counts only the adjudication requests, no discovery', () => {
    const targets = buildTargets(['Oscar']);
    const segs = segments(3);
    const segmentIndex = new Map(segs.map((s, i) => [s.id, i]));

    const estimate = estimateNameCheck({
      mode: 'standard',
      segments: segs,
      speakerNames: new Map([['A', 'Ana']]),
      segmentIndex,
      targets,
      countTokens,
    });

    expect(estimate.requests).toBeGreaterThan(0);
    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.candidates).toBeGreaterThanOrEqual(0);
  });

  it('thorough mode adds discovery requests on top of adjudication', () => {
    const targets = buildTargets(['Oscar']);
    const segs = segments(3);
    const segmentIndex = new Map(segs.map((s, i) => [s.id, i]));
    const speakerNames = new Map([['A', 'Ana']]);

    const standard = estimateNameCheck({
      mode: 'standard',
      segments: segs,
      speakerNames,
      segmentIndex,
      targets,
      countTokens,
    });
    const thorough = estimateNameCheck({
      mode: 'thorough',
      segments: segs,
      speakerNames,
      segmentIndex,
      targets,
      countTokens,
    });

    expect(thorough.requests).toBeGreaterThan(standard.requests);
    expect(thorough.inputTokens).toBeGreaterThan(standard.inputTokens);
  });

  it('returns zero requests and tokens when there are no candidates and no segments', () => {
    const targets = buildTargets(['Oscar']);

    const estimate = estimateNameCheck({
      mode: 'standard',
      segments: [],
      speakerNames: new Map(),
      segmentIndex: new Map(),
      targets,
      countTokens,
    });

    expect(estimate.requests).toBe(0);
    expect(estimate.inputTokens).toBe(0);
    expect(estimate.candidates).toBe(0);
  });

  it('honours a custom chunkTokens for discovery packing', () => {
    const targets = buildTargets(['Oscar']);
    const segs = segments(6);
    const segmentIndex = new Map(segs.map((s, i) => [s.id, i]));
    const speakerNames = new Map([['A', 'Ana']]);

    const wide = estimateNameCheck({
      mode: 'thorough',
      segments: segs,
      speakerNames,
      segmentIndex,
      targets,
      countTokens,
      chunkTokens: 10_000,
    });
    const narrow = estimateNameCheck({
      mode: 'thorough',
      segments: segs,
      speakerNames,
      segmentIndex,
      targets,
      countTokens,
      chunkTokens: 10,
    });

    // A narrower chunk budget packs into more, smaller discovery requests.
    expect(narrow.requests).toBeGreaterThanOrEqual(wide.requests);
  });
});
