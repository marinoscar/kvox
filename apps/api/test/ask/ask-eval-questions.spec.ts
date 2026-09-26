// =============================================================================
// The Ask golden question set: schema, coverage, referential integrity (#382)
// =============================================================================
//
// No database and no AI provider — this is a pure check of the committed
// `ask-questions.json` against #362's committed fixtures, so it runs in every
// `npm test`.
// =============================================================================

import { join } from 'path';

import { loadGoldenSet } from '../../scripts/kg-eval/load';
import {
  ASK_EVAL_CATEGORIES,
  loadAskEvalQuestions,
  selectAskEvalQuestions,
  type AskEvalCategory,
} from '../../scripts/ask-eval/question-schema';

const QUESTIONS_PATH = join(__dirname, '../fixtures/kg-golden/ask-questions.json');

describe('ask-questions.json', () => {
  const questions = loadAskEvalQuestions(QUESTIONS_PATH);
  const fixtures = loadGoldenSet();

  const allSegmentIds = new Set(fixtures.flatMap((f) => f.segments.map((s) => s.id)));
  const allNoteRefs = new Set(fixtures.map((f) => `${f.id}#note`));
  const fixtureIds = new Set(fixtures.map((f) => f.id));
  const allEntityLabels = new Set(
    fixtures.flatMap((f) => [...f.labels.entities.map((e) => e.label), ...f.knownEntities.map((k) => k.label)]),
  );

  it('has at least 40 questions', () => {
    expect(questions.length).toBeGreaterThanOrEqual(40);
  });

  it('has unique, permanent-shaped ids', () => {
    const ids = questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^q\d{2,3}$/);
  });

  it('covers every category with at least the committed counts', () => {
    // The exact counts this set ships with — a coverage regression (fewer
    // questions in a category) fails loudly rather than silently shrinking.
    const EXPECTED: Record<AskEvalCategory, number> = {
      lookup: 8,
      relationship: 6,
      temporal: 6,
      as_of: 5,
      commitments: 6,
      decisions: 4,
      multi_hop: 3,
      negative: 4,
    };
    const counts: Record<string, number> = {};
    for (const q of questions) counts[q.category] = (counts[q.category] ?? 0) + 1;
    for (const category of ASK_EVAL_CATEGORIES) {
      expect(counts[category] ?? 0).toBeGreaterThanOrEqual(EXPECTED[category]);
    }
    expect(questions.length).toBeGreaterThanOrEqual(
      Object.values(EXPECTED).reduce((a, b) => a + b, 0),
    );
  });

  it('every `fixtures` entry names a real, committed fixture id', () => {
    for (const q of questions) {
      for (const fid of q.fixtures) {
        expect(fixtureIds.has(fid)).toBe(true);
      }
    }
  });

  it('every `citeFrom` entry resolves to a real segment or note', () => {
    for (const q of questions) {
      for (const ref of q.expected.citeFrom) {
        if (ref.includes('#')) {
          expect(allNoteRefs.has(ref)).toBe(true);
        } else {
          expect(allSegmentIds.has(ref)).toBe(true);
        }
      }
    }
  });

  it('every expected entity label names a real entity in the golden set (or is a deliberately absent negative)', () => {
    for (const q of questions) {
      for (const label of q.expected.entities) {
        expect(allEntityLabels.has(label)).toBe(true);
      }
    }
  });

  it('a `notFound` question cites nothing and names no expected entity', () => {
    for (const q of questions.filter((x) => x.expected.notFound)) {
      expect(q.expected.citeFrom).toEqual([]);
      expect(q.expected.entities).toEqual([]);
    }
  });

  it('a non-negative question cites at least one segment or note', () => {
    for (const q of questions.filter((x) => x.category !== 'negative')) {
      expect(q.expected.citeFrom.length).toBeGreaterThan(0);
    }
  });

  it('is synthetic only: no real-looking email, phone number, or non-@example.test/.com address', () => {
    const text = JSON.stringify(questions);
    // The fixtures' own people/orgs are invented; questions must not smuggle
    // in a real-looking contact detail while asking about them.
    expect(text).not.toMatch(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/); // a phone-shaped number
    const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
    for (const email of emails) expect(email).toMatch(/@example\.(com|test)$/);
  });

  it('selectAskEvalQuestions narrows by id and by category, and rejects an unknown id', () => {
    expect(selectAskEvalQuestions(questions, ['q01', 'q02'], null).map((q) => q.id)).toEqual(['q01', 'q02']);
    expect(selectAskEvalQuestions(questions, null, 'negative').every((q) => q.category === 'negative')).toBe(true);
    expect(() => selectAskEvalQuestions(questions, ['q999'], null)).toThrow(/unknown question id/);
  });
});
