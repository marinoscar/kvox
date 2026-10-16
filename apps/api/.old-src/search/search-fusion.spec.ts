// =============================================================================
// `search-fusion.ts` — the arithmetic, with no database anywhere near it
// (issue #189, epic #165)
// =============================================================================
//
// Fusion is the one part of hybrid search whose correctness is a PROPERTY OF A
// FORMULA rather than of a query plan, so it is extracted into a pure function
// and pinned here. `search.service.spec.ts` asserts the SQL that produces the
// two rankings and `test/integration/search.db.spec.ts` proves the whole thing
// end to end against real vectors; what is asserted below is that the formula
// orders things the way the header claims, which neither of those could show
// without a corpus engineered to expose it.
//
// The two headline cases are the ones the design turns on:
//
//   - A DOCUMENT BOTH ARMS FOUND BEATS ONE A SINGLE ARM LOVED. That is the
//     entire reason to run two arms, and with a small `k` it would be false.
//   - AN ABSENT LIST CONTRIBUTES NOTHING - no imputed rank, no penalty term,
//     no stand-in. Anything else would be a normalisation in disguise.
// =============================================================================

import { reciprocalRankFusion, RRF_K } from './search-fusion';

describe('reciprocalRankFusion', () => {
  // ==========================================================================
  // The formula itself
  // ==========================================================================

  describe('the terms', () => {
    it('scores a document by 1 / (k + its 1-based position)', () => {
      const scores = reciprocalRankFusion([['a', 'b', 'c']]);

      expect(scores.get('a')).toBeCloseTo(1 / (RRF_K + 1), 12);
      expect(scores.get('b')).toBeCloseTo(1 / (RRF_K + 2), 12);
      expect(scores.get('c')).toBeCloseTo(1 / (RRF_K + 3), 12);
    });

    it('sums one term per list the document appears in', () => {
      const scores = reciprocalRankFusion([
        ['a', 'b'],
        ['b', 'a'],
      ]);

      // Both documents are rank 1 in one list and rank 2 in the other, so the
      // fused scores are equal — the function reports a genuine tie rather than
      // inventing a winner. Breaking it is the caller's job.
      expect(scores.get('a')).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 12);
      expect(scores.get('a')).toBeCloseTo(scores.get('b')!, 12);
    });

    it('uses 60 as k, the value the RRF literature settled on', () => {
      expect(RRF_K).toBe(60);
    });

    it('returns an empty map for no lists and for empty lists', () => {
      expect(reciprocalRankFusion([]).size).toBe(0);
      expect(reciprocalRankFusion([[], []]).size).toBe(0);
    });
  });

  // ==========================================================================
  // The headline ordering properties
  // ==========================================================================

  describe('agreement between arms beats a single arm', () => {
    it('ranks a document found 1st and 2nd above one found 1st and nowhere', () => {
      // `both` is rank 1 in the lexical list and rank 2 in the vector list.
      // `lexicalOnly` is rank 2 lexically and absent from the vector list
      // entirely. A ranking that let a single first place dominate would put
      // them the other way round.
      const scores = reciprocalRankFusion([
        ['both', 'lexicalOnly'],
        ['vectorOnly', 'both'],
      ]);

      expect(scores.get('both')!).toBeGreaterThan(scores.get('lexicalOnly')!);
      expect(scores.get('both')!).toBeGreaterThan(scores.get('vectorOnly')!);
    });

    it('ranks a document 2nd in BOTH lists above one 1st in ONE list only', () => {
      // ⚠ THE PROPERTY `k = 60` EXISTS FOR, stated at its sharpest. `k` damps
      // the head of each list — 1/61 and 1/62 are nearly equal — so two
      // second places (0.0323) comfortably beat one first place (0.0164).
      // At k = 0 this assertion is a tie; below 1 it inverts.
      const scores = reciprocalRankFusion([
        ['soleFirst', 'agreed'],
        ['otherFirst', 'agreed'],
      ]);

      expect(scores.get('agreed')!).toBeGreaterThan(scores.get('soleFirst')!);
      expect(scores.get('agreed')!).toBeGreaterThan(scores.get('otherFirst')!);
      expect(scores.get('agreed')).toBeCloseTo(2 / (RRF_K + 2), 12);
      expect(scores.get('soleFirst')).toBeCloseTo(1 / (RRF_K + 1), 12);
    });

    it('would order those two the other way at a small k — so 60 is load-bearing', () => {
      // The counter-example, asserted rather than described, so that nobody can
      // "tune" k downward and still pass the test above by coincidence.
      const damped = reciprocalRankFusion(
        [
          ['soleFirst', 'agreed'],
          ['otherFirst', 'agreed'],
        ],
        0,
      );

      expect(damped.get('agreed')).toBeCloseTo(1, 12);
      expect(damped.get('soleFirst')).toBeCloseTo(1, 12);
      expect(damped.get('agreed')!).not.toBeGreaterThan(damped.get('soleFirst')!);
    });
  });

  // ==========================================================================
  // Absence is absence
  // ==========================================================================

  describe('a document in only one list', () => {
    it('gets exactly one term, with no rank imputed for the list it is missing from', () => {
      const scores = reciprocalRankFusion([['only'], ['other']]);

      expect(scores.get('only')).toBeCloseTo(1 / (RRF_K + 1), 12);
      expect(scores.get('other')).toBeCloseTo(1 / (RRF_K + 1), 12);
    });

    it('is unaffected by how long the OTHER list is', () => {
      // ⚠ THE PROPERTY THAT MAKES THIS NOT A NORMALISATION. Imputing "the other
      // list's length plus one" — the most natural-looking way to fill the gap
      // — would make `solo`'s score depend on rows nobody looked at. Here the
      // corpus grows by eight irrelevant documents and `solo` does not move.
      const small = reciprocalRankFusion([['solo'], ['x']]);
      const large = reciprocalRankFusion([
        ['solo'],
        ['x', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      ]);

      expect(large.get('solo')).toBe(small.get('solo'));
    });

    it('keeps the relative order of every other document when an irrelevant one is added', () => {
      // The same property one level up: adding a document at the BOTTOM of one
      // list cannot reorder anything above it. Score blending over a min-maxed
      // result set has no such guarantee.
      const before = reciprocalRankFusion([
        ['a', 'b'],
        ['b', 'c'],
      ]);
      const after = reciprocalRankFusion([
        ['a', 'b'],
        ['b', 'c', 'irrelevant'],
      ]);

      const order = (scores: Map<string, number>) =>
        [...scores.entries()].sort((l, r) => r[1] - l[1]).map(([key]) => key);

      expect(order(after).filter((key) => key !== 'irrelevant')).toEqual(order(before));
    });
  });

  // ==========================================================================
  // The single-list case, which is what a caller with no API key gets
  // ==========================================================================

  describe('one list only', () => {
    it('is the identity on ORDER — strictly decreasing in rank', () => {
      // What makes "`semantic: false` answers exactly as the endpoint did
      // before epic #165" true by construction: fusing one list cannot reorder
      // it, at any length the candidate window allows.
      const list = Array.from({ length: 200 }, (_, index) => `doc-${index}`);
      const scores = reciprocalRankFusion([list]);

      const fusedOrder = [...scores.entries()]
        .sort((l, r) => r[1] - l[1])
        .map(([key]) => key);

      expect(fusedOrder).toEqual(list);
    });

    it('produces no ties within one list, even at the tail of a full window', () => {
      const list = Array.from({ length: 200 }, (_, index) => `doc-${index}`);
      const scores = reciprocalRankFusion([list]);

      expect(new Set(scores.values()).size).toBe(200);
    });
  });

  // ==========================================================================
  // Defensive
  // ==========================================================================

  describe('a key repeated inside one list', () => {
    it('contributes one term, at its best position', () => {
      // Cannot happen here — both arms roll up to one row per document before
      // they are ranked — but a document silently double-counted into the top
      // of the fused list is the failure the guard prevents.
      const scores = reciprocalRankFusion([['a', 'b', 'a']]);

      expect(scores.get('a')).toBeCloseTo(1 / (RRF_K + 1), 12);
      expect(scores.size).toBe(2);
    });
  });
});
