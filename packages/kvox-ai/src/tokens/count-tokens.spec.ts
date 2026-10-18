import { CHARS_PER_TOKEN, countTokens } from './count-tokens.js';

// The estimate every note budget is checked against (docs/specs/notes.md §3.3). It was
// moved unchanged from the retired provider, so these cases pin the numbers a budget
// has always produced.

describe('countTokens', () => {
  it('is zero for the empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('rounds characters / 4 up', () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(countTokens('a'.repeat(4))).toBe(1);
    expect(countTokens('a'.repeat(5))).toBe(2);
    expect(countTokens('a'.repeat(400))).toBe(100);
  });

  it('takes the word count when it is larger (short words, punctuation, CJK-like text)', () => {
    expect(countTokens('a b c d e f g h')).toBe(8);
    expect(countTokens('I am so ok')).toBe(4);
  });

  it('ignores the model id', () => {
    expect(countTokens('hello world, how are you', 'gpt-5.4')).toBe(countTokens('hello world, how are you'));
  });
});
