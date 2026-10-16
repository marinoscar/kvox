// =============================================================================
// The budgets are calibrated, not guessed (issue #186, epic #165)
// =============================================================================
//
// These assertions are the arithmetic in `chunk.types.ts`'s comments, made
// executable. They exist so that raising `MAX_CHUNK_CHARS` "a bit" in 2027
// fails here rather than failing at an embedding provider, and so that the
// relationships between the constants (overlap smaller than the chunk, title
// prefix small enough to leave a body) cannot be broken one constant at a time.
// =============================================================================

import {
  CHARS_PER_TOKEN_FLOOR,
  CHUNK_OVERLAP_CHARS,
  EMBEDDING_INPUT_TOKEN_CEILING,
  HARD_SPLIT_BACKTRACK_CHARS,
  MAX_CHUNK_CHARS,
  MAX_SPEAKER_LABEL_CHARS,
  MAX_TITLE_PREFIX_CHARS,
  OVERLAP_SENTENCE_LOOKAHEAD_CHARS,
} from './chunk.types';

describe('chunking budgets', () => {
  it('stays far below the embedding model input ceiling', () => {
    const worstCaseTokens = MAX_CHUNK_CHARS / CHARS_PER_TOKEN_FLOOR;
    expect(worstCaseTokens).toBeLessThan(EMBEDDING_INPUT_TOKEN_CEILING);
    // Not merely "below" - the calibration is meant to be nowhere near binding,
    // so that a pessimistic tokenizer estimate is never the thing that breaks.
    expect(worstCaseTokens).toBeLessThan(EMBEDDING_INPUT_TOKEN_CEILING / 10);
  });

  it('keeps chunks in the few-hundred-token band retrieval quality wants', () => {
    const worstCaseTokens = MAX_CHUNK_CHARS / CHARS_PER_TOKEN_FLOOR;
    expect(worstCaseTokens).toBeGreaterThan(100);
    expect(worstCaseTokens).toBeLessThan(1000);
  });

  it('overlaps a minority of a chunk', () => {
    // Every character of overlap is embedded, stored and billed twice; an
    // overlap approaching half the chunk turns the corpus into near-duplicates
    // that crowd each other out of the top-k.
    expect(CHUNK_OVERLAP_CHARS).toBeGreaterThan(0);
    expect(CHUNK_OVERLAP_CHARS).toBeLessThan(MAX_CHUNK_CHARS / 4);
  });

  it('leaves a usable body after the largest possible prefix', () => {
    expect(MAX_TITLE_PREFIX_CHARS).toBeLessThan(MAX_CHUNK_CHARS / 4);
    expect(MAX_SPEAKER_LABEL_CHARS).toBeLessThan(MAX_TITLE_PREFIX_CHARS);
    // A chunk of a note with the longest allowed title must still be able to
    // carry a full overlap plus meaningfully more new text than the overlap.
    const body = MAX_CHUNK_CHARS - (MAX_TITLE_PREFIX_CHARS + 2);
    expect(body - CHUNK_OVERLAP_CHARS).toBeGreaterThan(CHUNK_OVERLAP_CHARS * 4);
  });

  it('bounds both boundary searches well inside what they search', () => {
    expect(OVERLAP_SENTENCE_LOOKAHEAD_CHARS).toBeGreaterThan(0);
    expect(OVERLAP_SENTENCE_LOOKAHEAD_CHARS).toBeLessThan(MAX_CHUNK_CHARS / 4);
    expect(HARD_SPLIT_BACKTRACK_CHARS).toBeGreaterThan(0);
    expect(HARD_SPLIT_BACKTRACK_CHARS).toBeLessThan(MAX_CHUNK_CHARS / 4);
  });

  it('keeps every budget a whole number of characters', () => {
    // A fractional character budget would make the boundary depend on floating
    // point rounding, which is exactly the kind of thing that differs between
    // builds and quietly re-cuts a corpus.
    for (const value of [
      MAX_CHUNK_CHARS,
      CHUNK_OVERLAP_CHARS,
      OVERLAP_SENTENCE_LOOKAHEAD_CHARS,
      HARD_SPLIT_BACKTRACK_CHARS,
      MAX_TITLE_PREFIX_CHARS,
      MAX_SPEAKER_LABEL_CHARS,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
