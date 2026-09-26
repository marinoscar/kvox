// =============================================================================
// The Ask evaluation's scorer: unit tests on hand-built messages (issue #382)
// =============================================================================

import type { AskCitation, AskMessageResponse } from '../../src/ask/dto/ask.dto';
import {
  scoreAnswer,
  scoreAnswerMatch,
  scoreCitationValidity,
  scoreCited,
  scoreCiteFromHit,
  scoreEntityRecall,
  scoreSensitiveLeak,
  type EvidenceSourceMap,
} from '../../scripts/ask-eval/scorer';
import type { AskEvalQuestion } from '../../scripts/ask-eval/question-schema';

function citation(over: Partial<AskCitation> = {}): AskCitation {
  return {
    marker: 'ev1',
    kind: 'evidence',
    id: 'ev-id-1',
    via: null,
    valid: true,
    label: null,
    documentKind: null,
    startMs: null,
    ...over,
  };
}

function question(over: Partial<AskEvalQuestion> = {}): AskEvalQuestion {
  return {
    id: 'q01',
    category: 'lookup',
    fixtures: ['m01'],
    scopeEntity: null,
    question: 'Who does Sarah Chen work for?',
    expected: { entities: [], answerAll: [], answerNone: [], citeFrom: [], notFound: false },
    ...over,
  };
}

function message(over: Partial<Pick<AskMessageResponse, 'content' | 'citations' | 'promptTokens' | 'completionTokens' | 'toolCalls'>> = {}) {
  return {
    content: 'Sarah Chen works for Northwind Robotics.[^ev1]',
    citations: [citation()],
    promptTokens: 100,
    completionTokens: 20,
    toolCalls: [],
    ...over,
  };
}

const evSource: EvidenceSourceMap = new Map([['ev-id-1', 'm01-s002']]);

describe('scoreCitationValidity', () => {
  it('is 1 with no citations at all', () => {
    expect(scoreCitationValidity([])).toBe(1);
  });
  it('is the fraction of valid citations', () => {
    expect(scoreCitationValidity([citation({ valid: true }), citation({ valid: false })])).toBe(0.5);
  });
  it('is 0 when every citation is invalid', () => {
    expect(scoreCitationValidity([citation({ valid: false })])).toBe(0);
  });
});

describe('scoreCited', () => {
  it('true with at least one valid citation', () => {
    expect(scoreCited([citation({ valid: false }), citation({ valid: true })])).toBe(true);
  });
  it('false with none valid', () => {
    expect(scoreCited([citation({ valid: false })])).toBe(false);
    expect(scoreCited([])).toBe(false);
  });
});

describe('scoreCiteFromHit', () => {
  it('true when nothing was required', () => {
    expect(scoreCiteFromHit([], [], evSource)).toBe(true);
  });
  it('true when a valid evidence citation resolves to a listed source', () => {
    expect(scoreCiteFromHit(['m01-s002'], [citation({ id: 'ev-id-1' })], evSource)).toBe(true);
  });
  it('false when the citation is invalid, even if its id would resolve', () => {
    expect(scoreCiteFromHit(['m01-s002'], [citation({ id: 'ev-id-1', valid: false })], evSource)).toBe(false);
  });
  it('false when the citation kind is not evidence (an entity citation cannot satisfy citeFrom)', () => {
    expect(scoreCiteFromHit(['m01-s002'], [citation({ id: 'ev-id-1', kind: 'entity' })], evSource)).toBe(false);
  });
  it('false when the resolved source is not in the listed set', () => {
    expect(scoreCiteFromHit(['m02-s001'], [citation({ id: 'ev-id-1' })], evSource)).toBe(false);
  });
  it('false when the id is unknown to the map', () => {
    expect(scoreCiteFromHit(['m01-s002'], [citation({ id: 'unknown-id' })], evSource)).toBe(false);
  });
});

describe('scoreEntityRecall', () => {
  it('1 when no entities were expected', () => {
    expect(scoreEntityRecall([], [])).toBe(1);
  });
  it('is the fraction of expected labels cited, case-insensitively', () => {
    const citations = [citation({ kind: 'entity', label: 'northwind robotics' })];
    expect(scoreEntityRecall(['Northwind Robotics', 'Sarah Chen'], citations)).toBe(0.5);
  });
  it('an invalid citation does not count toward recall', () => {
    const citations = [citation({ kind: 'entity', label: 'Northwind Robotics', valid: false })];
    expect(scoreEntityRecall(['Northwind Robotics'], citations)).toBe(0);
  });
});

describe('scoreSensitiveLeak', () => {
  it('false with no answerNone strings', () => {
    expect(scoreSensitiveLeak([], 'anything', [])).toBe(false);
  });
  it('true when the forbidden text is in the answer', () => {
    expect(scoreSensitiveLeak(['shellfish allergy'], 'He has a shellfish allergy.', [])).toBe(true);
  });
  it('true when the forbidden text is in a captured prompt but not the answer (the actual leak this gate exists for)', () => {
    expect(scoreSensitiveLeak(['shellfish allergy'], 'I could not find that.', ['...shellfish allergy...'])).toBe(true);
  });
  it('false when the forbidden text appears nowhere', () => {
    expect(scoreSensitiveLeak(['shellfish allergy'], 'He works at Halden Freight.', ['unrelated'])).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(scoreSensitiveLeak(['Shellfish Allergy'], 'a SHELLFISH ALLERGY was mentioned', [])).toBe(true);
  });
});

describe('scoreAnswerMatch', () => {
  const expected = (over: Partial<AskEvalQuestion['expected']> = {}): AskEvalQuestion['expected'] => ({
    entities: [],
    answerAll: [],
    answerNone: [],
    citeFrom: [],
    notFound: false,
    ...over,
  });

  it('passes when every answerAll group matches and nothing forbidden appears', () => {
    const { matched, reasons } = scoreAnswerMatch(expected({ answerAll: [['Northwind Robotics']] }), 'She works for Northwind Robotics.', []);
    expect(matched).toBe(true);
    expect(reasons).toEqual([]);
  });

  it('a group is satisfied by ANY alternative', () => {
    const { matched } = scoreAnswerMatch(expected({ answerAll: [['JJ', 'Jonah']] }), 'Jonah took it over.', []);
    expect(matched).toBe(true);
  });

  it('fails when a required group has no match (missing group)', () => {
    const { matched, reasons } = scoreAnswerMatch(expected({ answerAll: [['Northwind Robotics']] }), 'She works somewhere.', []);
    expect(matched).toBe(false);
    expect(reasons[0]).toMatch(/missing required phrase/);
  });

  it('fails when an answerNone string is present (answerNone hit)', () => {
    const { matched, reasons } = scoreAnswerMatch(expected({ answerNone: ['Estuary Cloud'] }), 'It now runs on Estuary Cloud.', []);
    expect(matched).toBe(false);
    expect(reasons[0]).toMatch(/forbidden phrase/);
  });

  it('a notFound question passes when it cites nothing valid and reads as not-found', () => {
    const { matched } = scoreAnswerMatch(expected({ notFound: true }), "I couldn't find that in your graph.", []);
    expect(matched).toBe(true);
  });

  it('a notFound question fails if it cites something valid anyway', () => {
    const { matched, reasons } = scoreAnswerMatch(expected({ notFound: true }), "I couldn't find that.", [citation({ valid: true })]);
    expect(matched).toBe(false);
    expect(reasons.some((r) => /cited something valid/.test(r))).toBe(true);
  });

  it('a notFound question fails if the answer does not read as a refusal', () => {
    const { matched, reasons } = scoreAnswerMatch(expected({ notFound: true }), 'Here is an answer anyway.', []);
    expect(matched).toBe(false);
    expect(reasons.some((r) => /could not find/.test(r))).toBe(true);
  });
});

describe('scoreAnswer (the full score)', () => {
  it('assembles every field, using capturedPrompts.length for steps', () => {
    const q = question({ expected: { entities: ['Northwind Robotics'], answerAll: [['Northwind Robotics']], answerNone: [], citeFrom: ['m01-s002'], notFound: false } });
    const msg = message({ citations: [citation({ kind: 'entity', label: 'Northwind Robotics' }), citation({ id: 'ev-id-1' })] });
    const score = scoreAnswer(q, msg, ['req-1', 'req-2'], evSource, { ms: 1234 });

    expect(score.questionId).toBe('q01');
    expect(score.category).toBe('lookup');
    expect(score.citationValidity).toBe(1);
    expect(score.cited).toBe(true);
    expect(score.citeFromHit).toBe(true);
    expect(score.answerMatch).toBe(true);
    expect(score.entityRecall).toBe(1);
    expect(score.sensitiveLeak).toBe(false);
    expect(score.steps).toBe(2);
    expect(score.promptTokens).toBe(100);
    expect(score.completionTokens).toBe(20);
    expect(score.ms).toBe(1234);
  });

  it('answerMatch is false when citeFrom is required but nothing resolves, even if answerAll matched', () => {
    const q = question({ expected: { entities: [], answerAll: [['Northwind Robotics']], answerNone: [], citeFrom: ['m01-s002'], notFound: false } });
    const msg = message({ citations: [] });
    const score = scoreAnswer(q, msg, [], evSource);
    expect(score.answerMatch).toBe(false);
    expect(score.notes.some((n) => /citeFrom/i.test(n) || /no valid citation/.test(n))).toBe(true);
  });

  it('flags a leak found only in a captured prompt', () => {
    const q = question({ expected: { entities: [], answerAll: [], answerNone: ['shellfish allergy'], citeFrom: [], notFound: false } });
    const msg = message({ content: "I couldn't find that.", citations: [] });
    const score = scoreAnswer(q, msg, ['tool result mentioning a shellfish allergy'], evSource);
    expect(score.sensitiveLeak).toBe(true);
  });
});
