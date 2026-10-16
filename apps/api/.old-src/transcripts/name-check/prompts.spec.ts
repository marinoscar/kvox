// =============================================================================
// prompts.ts — discovery packing/parsing, adjudication and the accept guards
// (issues #328 and #330, epic #326)
// =============================================================================

import type { CandidateSegment, NameCandidate, NameTarget } from './candidates';
import { buildTargets } from './candidates';
import {
  acceptResults,
  buildAdjudicationPrompt,
  buildDiscoveryPrompt,
  capCandidates,
  DISCOVERY_SCORE,
  extractJsonObject,
  locateDiscoveryFindings,
  markSpan,
  mergeCandidates,
  packDiscoveryChunks,
  parseAdjudicationAnswer,
  parseDiscoveryAnswer,
  replacementMatchesTarget,
  type AdjudicationResult,
  type DiscoveryFinding,
  type SourcedCandidate,
} from './prompts';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function segment(id: string, text: string, overrides: Partial<CandidateSegment> = {}): CandidateSegment {
  return { id, rev: 1, speakerId: 'A', startMs: 0, text, ...overrides };
}

const OSCAR: NameTarget = buildTargets(['Oscar'])[0]!;

function candidate(overrides: Partial<SourcedCandidate> = {}): SourcedCandidate {
  const base: NameCandidate = {
    segmentId: 's1',
    segmentRev: 1,
    start: 0,
    end: 4,
    original: 'Skar',
    target: 'Oscar',
    score: 0.9,
    signals: {
      jaroWinkler: 0.9,
      phonetic: 'near',
      comparison: 'concatenated',
      tokenCount: 1,
      minConfidence: null,
      lowConfidence: false,
      stopword: false,
    },
  };
  return { ...base, source: 'phonetic', ...overrides };
}

/** A token counter that counts words, so packing math is easy to reason about. */
const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

// -----------------------------------------------------------------------------
// extractJsonObject
// -----------------------------------------------------------------------------

describe('extractJsonObject', () => {
  it('parses a plain JSON object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a markdown code fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('tolerates preamble and trailing prose', () => {
    expect(extractJsonObject('Sure, here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it('never throws on garbage, and returns null', () => {
    expect(extractJsonObject('not json at all')).toBeNull();
    expect(extractJsonObject('{"a": }')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// packDiscoveryChunks
// -----------------------------------------------------------------------------

describe('packDiscoveryChunks', () => {
  const names = new Map([['A', 'Ana']]);

  it('packs multiple short segments into one chunk under the token budget', () => {
    const segments = [segment('s1', 'one two'), segment('s2', 'three four'), segment('s3', 'five six')];
    const chunks = packDiscoveryChunks(segments, names, wordCount, 100);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.indices).toEqual([0, 1, 2]);
  });

  it('splits into multiple chunks once the budget is exceeded, with ONE segment of overlap', () => {
    // Each rendered line ("[<n>] Ana: <text>") costs a few "tokens" under our
    // word-counting stub; force a tight budget so each is its own would-be
    // chunk, then check the overlap rule.
    const segments = [
      segment('s1', 'aaaa'),
      segment('s2', 'bbbb'),
      segment('s3', 'cccc'),
      segment('s4', 'dddd'),
    ];
    // Each line is "[<n>] Ana: aaaa" -> 3 words + 1 (newline) = 4 "tokens"; a
    // budget of 8 fits two lines per chunk, so the overlap can show up.
    const chunks = packDiscoveryChunks(segments, names, wordCount, 8);

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk after the first STARTS AT OR BEFORE the previous chunk's
    // last segment (one segment of overlap; never a gap that skips a segment).
    for (let i = 1; i < chunks.length; i++) {
      const prevLast = chunks[i - 1]!.indices.at(-1)!;
      expect(chunks[i]!.indices[0]).toBeLessThanOrEqual(prevLast);
    }
    // And every segment is covered by at least one chunk.
    const covered = new Set(chunks.flatMap((c) => c.indices));
    expect(covered.size).toBe(segments.length);
  });

  it('gives an oversized segment a chunk of its own rather than cutting it', () => {
    const huge = 'word '.repeat(50).trim();
    const segments = [segment('s1', 'short'), segment('s2', huge), segment('s3', 'short again')];
    const chunks = packDiscoveryChunks(segments, names, wordCount, 10);

    // The huge segment (index 1) must appear alone in some chunk, never fused
    // with a neighbour past the budget.
    const soloChunk = chunks.find((c) => c.indices.length === 1 && c.indices[0] === 1);
    expect(soloChunk).toBeDefined();
  });

  it('skips a blank segment entirely', () => {
    const segments = [segment('s1', 'hello'), segment('s2', '   '), segment('s3', 'world')];
    const chunks = packDiscoveryChunks(segments, names, wordCount, 1000);

    const allIndices = chunks.flatMap((c) => c.indices);
    expect(allIndices).not.toContain(1);
  });

  it('makes progress even when overlap alone would not advance', () => {
    const segments = [segment('s1', 'a'), segment('s2', 'b')];
    const chunks = packDiscoveryChunks(segments, names, wordCount, 1);

    // Must terminate (no infinite loop) and cover every segment.
    expect(chunks.flatMap((c) => c.indices).length).toBeGreaterThanOrEqual(1);
  });

  it('returns nothing for an empty transcript', () => {
    expect(packDiscoveryChunks([], names, wordCount)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// buildDiscoveryPrompt / parseDiscoveryAnswer
// -----------------------------------------------------------------------------

describe('buildDiscoveryPrompt', () => {
  it('lists the targets and includes the chunk text', () => {
    const chunk = { indices: [0], text: '[0] Ana: hello', tokens: 3 };
    const prompt = buildDiscoveryPrompt(chunk, [OSCAR]);

    expect(prompt.userContent).toContain('"Oscar"');
    expect(prompt.userContent).toContain('[0] Ana: hello');
  });
});

describe('parseDiscoveryAnswer', () => {
  it('parses a well-formed envelope', () => {
    const answer = '{"findings":[{"seg":0,"text":"Skar","target":"Oscar"}]}';
    expect(parseDiscoveryAnswer(answer)).toEqual([{ seg: 0, text: 'Skar', target: 'Oscar' }]);
  });

  it('returns null when the envelope itself is malformed', () => {
    expect(parseDiscoveryAnswer('not json')).toBeNull();
    expect(parseDiscoveryAnswer('{"nope":[]}')).toBeNull();
  });

  it('drops one malformed item without failing the whole answer', () => {
    const answer = '{"findings":[{"seg":0,"text":"Skar","target":"Oscar"},{"seg":"nope"}]}';
    expect(parseDiscoveryAnswer(answer)).toEqual([{ seg: 0, text: 'Skar', target: 'Oscar' }]);
  });

  it('accepts JSON wrapped in a markdown fence', () => {
    const answer = '```json\n{"findings":[{"seg":1,"text":"Oh scar","target":"Oscar"}]}\n```';
    expect(parseDiscoveryAnswer(answer)).toEqual([{ seg: 1, text: 'Oh scar', target: 'Oscar' }]);
  });
});

// -----------------------------------------------------------------------------
// locateDiscoveryFindings
// -----------------------------------------------------------------------------

describe('locateDiscoveryFindings', () => {
  const targets = buildTargets(['Oscar']);

  it('locates an exact substring and widens it to whole words', () => {
    const segments = [segment('s1', 'They called him Skar yesterday.')];
    const findings: DiscoveryFinding[] = [{ seg: 0, text: 'Skar', target: 'Oscar' }];

    const out = locateDiscoveryFindings(findings, segments, targets);

    expect(out).toHaveLength(1);
    expect(out[0]!.original).toBe('Skar');
    expect(out[0]!.source).toBe('discovery');
    expect(out[0]!.score).toBe(DISCOVERY_SCORE);
    expect(out[0]!.segmentId).toBe('s1');
  });

  it('skips a finding whose segment index does not exist', () => {
    const segments = [segment('s1', 'hello')];
    const findings: DiscoveryFinding[] = [{ seg: 5, text: 'hello', target: 'Oscar' }];
    expect(locateDiscoveryFindings(findings, segments, targets)).toEqual([]);
  });

  it('skips a finding naming a target that is not in the list', () => {
    const segments = [segment('s1', 'They called him Skar.')];
    const findings: DiscoveryFinding[] = [{ seg: 0, text: 'Skar', target: 'Not A Target' }];
    expect(locateDiscoveryFindings(findings, segments, targets)).toEqual([]);
  });

  it('skips a finding whose text cannot be located in the segment', () => {
    const segments = [segment('s1', 'nothing relevant here')];
    const findings: DiscoveryFinding[] = [{ seg: 0, text: 'Skar', target: 'Oscar' }];
    expect(locateDiscoveryFindings(findings, segments, targets)).toEqual([]);
  });

  it('skips text that is already inside a correctly-spelled word ("scar" inside "Oscars")', () => {
    // "scar" as a standalone word does not occur; the only occurrence of the
    // substring "scar" is inside "Oscars", and widening to the whole word
    // yields "Oscars" — which already spells the target (plural). So this must
    // be skipped, never proposing to "correct" a name that is already right.
    const segments = [segment('s1', 'We love the Oscars every year.')];
    const findings: DiscoveryFinding[] = [{ seg: 0, text: 'scar', target: 'Oscar' }];
    expect(locateDiscoveryFindings(findings, segments, targets)).toEqual([]);
  });

  it('is case-insensitive when no exact-case occurrence exists', () => {
    const segments = [segment('s1', 'they called him skar yesterday')];
    const findings: DiscoveryFinding[] = [{ seg: 0, text: 'Skar', target: 'Oscar' }];
    const out = locateDiscoveryFindings(findings, segments, targets);
    expect(out).toHaveLength(1);
    expect(out[0]!.original).toBe('skar');
  });

  it('does not reuse a span already covered by an "already" candidate', () => {
    const segments = [segment('s1', 'Skar met Skar again.')];
    const already: SourcedCandidate[] = [
      { ...candidate({ segmentId: 's1', start: 0, end: 4, original: 'Skar' }) },
    ];
    const findings: DiscoveryFinding[] = [{ seg: 0, text: 'Skar', target: 'Oscar' }];

    const out = locateDiscoveryFindings(findings, segments, targets, already);

    expect(out).toHaveLength(1);
    // The second occurrence, not the one already covered.
    expect(out[0]!.start).toBeGreaterThan(4);
  });
});

// -----------------------------------------------------------------------------
// mergeCandidates
// -----------------------------------------------------------------------------

describe('mergeCandidates', () => {
  const order = new Map([['s1', 0], ['s2', 1]]);

  it('phonetic wins over an overlapping discovery candidate', () => {
    const phonetic = [candidate({ segmentId: 's1', start: 0, end: 4, source: 'phonetic' })];
    const discovery = [candidate({ segmentId: 's1', start: 0, end: 4, source: 'discovery' })];

    const merged = mergeCandidates(phonetic, discovery, order);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe('phonetic');
  });

  it('keeps a non-overlapping discovery candidate', () => {
    const phonetic = [candidate({ segmentId: 's1', start: 0, end: 4, source: 'phonetic' })];
    const discovery = [candidate({ segmentId: 's1', start: 10, end: 14, source: 'discovery' })];

    const merged = mergeCandidates(phonetic, discovery, order);

    expect(merged).toHaveLength(2);
  });

  it('drops a later discovery candidate overlapping an earlier discovery candidate', () => {
    const discovery = [
      candidate({ segmentId: 's1', start: 0, end: 4, source: 'discovery' }),
      candidate({ segmentId: 's1', start: 2, end: 6, source: 'discovery' }),
    ];

    const merged = mergeCandidates([], discovery, order);

    expect(merged).toHaveLength(1);
  });

  it('returns results in reading order (segment order, then start offset)', () => {
    const phonetic = [
      candidate({ segmentId: 's2', start: 0, end: 4 }),
      candidate({ segmentId: 's1', start: 10, end: 14 }),
      candidate({ segmentId: 's1', start: 0, end: 4 }),
    ];
    const merged = mergeCandidates(phonetic, [], order);

    expect(merged.map((c) => `${c.segmentId}:${c.start}`)).toEqual(['s1:0', 's1:10', 's2:0']);
  });
});

// -----------------------------------------------------------------------------
// capCandidates
// -----------------------------------------------------------------------------

describe('capCandidates', () => {
  it('keeps everything under the cap, untruncated', () => {
    const list = [candidate({ score: 0.9 }), candidate({ score: 0.8 })];
    const { candidates, truncated } = capCandidates(list, 5);
    expect(candidates).toHaveLength(2);
    expect(truncated).toBe(false);
  });

  it('keeps the highest-scoring candidates and reports truncation', () => {
    const list = [
      candidate({ segmentId: 's1', start: 0, end: 1, score: 0.5 }),
      candidate({ segmentId: 's1', start: 2, end: 3, score: 0.95 }),
      candidate({ segmentId: 's1', start: 4, end: 5, score: 0.7 }),
    ];
    const { candidates, truncated } = capCandidates(list, 2);

    expect(truncated).toBe(true);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.score).sort()).toEqual([0.7, 0.95]);
  });

  it('returns the kept candidates in their original reading order, not score order', () => {
    const list = [
      candidate({ segmentId: 's1', start: 0, end: 1, score: 0.6 }),
      candidate({ segmentId: 's1', start: 2, end: 3, score: 0.99 }),
      candidate({ segmentId: 's1', start: 4, end: 5, score: 0.8 }),
    ];
    const { candidates } = capCandidates(list, 2);
    expect(candidates.map((c) => c.start)).toEqual([2, 4]);
  });
});

// -----------------------------------------------------------------------------
// buildAdjudicationPrompt
// -----------------------------------------------------------------------------

describe('buildAdjudicationPrompt', () => {
  const names = new Map([
    ['A', 'Ana'],
    ['B', 'Speaker B'],
  ]);

  it('marks the span with ⟦ ⟧ on the candidate segment line', () => {
    const segments = [segment('s1', 'They called him Skar yesterday.', { speakerId: 'A' })];
    const index = new Map([['s1', 0]]);
    const c = candidate({ segmentId: 's1', start: 16, end: 20, original: 'Skar' });

    const { prompt, items } = buildAdjudicationPrompt([c], segments, index, names);

    expect(items.size).toBe(1);
    expect(items.get('c1')).toBe(c);
    expect(prompt.userContent).toContain('⟦Skar⟧');
  });

  it('includes neighbouring lines with their speakers', () => {
    const segments = [
      segment('s0', 'Before line.', { speakerId: 'B' }),
      segment('s1', 'Skar was here.', { speakerId: 'A' }),
      segment('s2', 'After line.', { speakerId: 'B' }),
    ];
    const index = new Map([
      ['s0', 0],
      ['s1', 1],
      ['s2', 2],
    ]);
    const c = candidate({ segmentId: 's1', start: 0, end: 4, original: 'Skar' });

    const { prompt } = buildAdjudicationPrompt([c], segments, index, names);

    expect(prompt.userContent).toContain('Before line');
    expect(prompt.userContent).toContain('After line');
  });

  it('appends the JSON retry line only when retry is true', () => {
    const segments = [segment('s1', 'Skar', { speakerId: 'A' })];
    const index = new Map([['s1', 0]]);
    const c = candidate({ segmentId: 's1', start: 0, end: 4 });

    const noRetry = buildAdjudicationPrompt([c], segments, index, names, false);
    const retry = buildAdjudicationPrompt([c], segments, index, names, true);

    expect(noRetry.prompt.userContent).not.toContain('Return only valid JSON');
    expect(retry.prompt.userContent).toContain('Return only valid JSON');
  });
});

// -----------------------------------------------------------------------------
// markSpan
// -----------------------------------------------------------------------------

describe('markSpan', () => {
  it('wraps the exact span with the open/close markers', () => {
    expect(markSpan('They called him Skar yesterday.', 16, 20)).toContain('⟦Skar⟧');
  });

  it('adds ellipses only when the clip cuts off text', () => {
    const long = 'x'.repeat(500) + 'Skar' + 'y'.repeat(500);
    const marked = markSpan(long, 500, 504, 10);
    expect(marked.startsWith('…')).toBe(true);
    expect(marked.endsWith('…')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// parseAdjudicationAnswer
// -----------------------------------------------------------------------------

describe('parseAdjudicationAnswer', () => {
  it('parses a valid envelope', () => {
    const answer = '{"results":[{"id":"c1","verdict":"replace","replacement":"Oscar","confidence":0.9,"reason":"clear"}]}';
    expect(parseAdjudicationAnswer(answer)).toEqual([
      { id: 'c1', verdict: 'replace', replacement: 'Oscar', confidence: 0.9, reason: 'clear' },
    ]);
  });

  it('returns null for invalid JSON', () => {
    expect(parseAdjudicationAnswer('not json')).toBeNull();
  });

  it('returns null when the envelope has no results array', () => {
    expect(parseAdjudicationAnswer('{"foo":"bar"}')).toBeNull();
  });

  it('parses fenced JSON via extractJsonObject', () => {
    const answer = '```json\n{"results":[{"id":"c1","verdict":"keep"}]}\n```';
    expect(parseAdjudicationAnswer(answer)).toEqual([
      { id: 'c1', verdict: 'keep', replacement: undefined, confidence: undefined, reason: undefined },
    ]);
  });

  it('drops one malformed item and keeps the rest', () => {
    const answer =
      '{"results":[{"id":"c1","verdict":"replace"},{"id":"c2","verdict":"not-a-verdict"}]}';
    const parsed = parseAdjudicationAnswer(answer);
    expect(parsed).toHaveLength(1);
    expect(parsed![0]!.id).toBe('c1');
  });
});

// -----------------------------------------------------------------------------
// acceptResults + replacementMatchesTarget
// -----------------------------------------------------------------------------

describe('replacementMatchesTarget', () => {
  it('accepts the exact target', () => {
    expect(replacementMatchesTarget('Oscar', 'Oscar')).toBe(true);
  });

  it("accepts a possessive (Oscar's) for target Oscar", () => {
    expect(replacementMatchesTarget("Oscar's", 'Oscar')).toBe(true);
    expect(replacementMatchesTarget('Oscar’s', 'Oscar')).toBe(true);
  });

  it('accepts a plural (Oscars) for target Oscar', () => {
    expect(replacementMatchesTarget('Oscars', 'Oscar')).toBe(true);
  });

  it('is diacritic- and case-insensitive', () => {
    expect(replacementMatchesTarget('oscar', 'Oscar')).toBe(true);
    expect(replacementMatchesTarget('ÓSCAR', 'Oscar')).toBe(true);
  });

  it('rejects an unrelated replacement', () => {
    expect(replacementMatchesTarget('Bartholomew', 'Oscar')).toBe(false);
  });

  it('rejects an empty target', () => {
    expect(replacementMatchesTarget('Oscar', '')).toBe(false);
  });
});

describe('acceptResults', () => {
  it('accepts a replace verdict whose replacement is the target', () => {
    const c = candidate({ target: 'Oscar', original: 'Skar' });
    const items = new Map([['c1', c]]);
    const results: AdjudicationResult[] = [
      { id: 'c1', verdict: 'replace', replacement: 'Oscar', confidence: 0.9, reason: 'clear mishearing' },
    ];

    const out = acceptResults(items, results);

    expect(out).toHaveLength(1);
    expect(out[0]!.replacement).toBe('Oscar');
    expect(out[0]!.confidence).toBe(0.9);
    expect(out[0]!.reason).toBe('clear mishearing');
  });

  it("accepts Oscar's / Oscars as valid replacements for target Oscar", () => {
    const c = candidate({ target: 'Oscar', original: 'Skars' });
    const items = new Map([['c1', c]]);

    expect(
      acceptResults(items, [{ id: 'c1', verdict: 'replace', replacement: "Oscar's" }]),
    ).toHaveLength(1);
    expect(
      acceptResults(items, [{ id: 'c1', verdict: 'replace', replacement: 'Oscars' }]),
    ).toHaveLength(1);
  });

  it('drops a replace verdict whose replacement is unrelated to the target', () => {
    const c = candidate({ target: 'Oscar', original: 'Skar' });
    const items = new Map([['c1', c]]);
    const results: AdjudicationResult[] = [{ id: 'c1', verdict: 'replace', replacement: 'Bartholomew' }];

    expect(acceptResults(items, results)).toEqual([]);
  });

  it('drops a replace verdict whose replacement equals the original', () => {
    const c = candidate({ target: 'Oscar', original: 'Oscar' });
    const items = new Map([['c1', c]]);
    const results: AdjudicationResult[] = [{ id: 'c1', verdict: 'replace', replacement: 'Oscar' }];

    expect(acceptResults(items, results)).toEqual([]);
  });

  it('drops a keep verdict', () => {
    const c = candidate({ target: 'Oscar', original: 'Skar' });
    const items = new Map([['c1', c]]);
    const results: AdjudicationResult[] = [{ id: 'c1', verdict: 'keep', replacement: 'Oscar' }];

    expect(acceptResults(items, results)).toEqual([]);
  });

  it('drops a result naming an id this batch never sent', () => {
    const c = candidate({ target: 'Oscar', original: 'Skar' });
    const items = new Map([['c1', c]]);
    const results: AdjudicationResult[] = [{ id: 'c99', verdict: 'replace', replacement: 'Oscar' }];

    expect(acceptResults(items, results)).toEqual([]);
  });

  it('keeps only the first result for a repeated id', () => {
    const c = candidate({ target: 'Oscar', original: 'Skar' });
    const items = new Map([['c1', c]]);
    const results: AdjudicationResult[] = [
      { id: 'c1', verdict: 'replace', replacement: 'Oscar', reason: 'first' },
      { id: 'c1', verdict: 'replace', replacement: 'Oscar', reason: 'second' },
    ];

    const out = acceptResults(items, results);
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe('first');
  });

  it('falls back to the candidate target when no replacement is given', () => {
    const c = candidate({ target: 'Oscar', original: 'Skar' });
    const items = new Map([['c1', c]]);
    const results: AdjudicationResult[] = [{ id: 'c1', verdict: 'replace' }];

    const out = acceptResults(items, results);
    expect(out).toHaveLength(1);
    expect(out[0]!.replacement).toBe('Oscar');
  });

  it('is diacritic-insensitive when checking the replacement against the target', () => {
    const c = buildTargets(['José'])[0]!;
    const cand = candidate({ target: c.text, original: 'Hose' });
    const items = new Map([['c1', cand]]);
    const results: AdjudicationResult[] = [{ id: 'c1', verdict: 'replace', replacement: 'jose' }];

    expect(acceptResults(items, results)).toHaveLength(1);
  });
});
