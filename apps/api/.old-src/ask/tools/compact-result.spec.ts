import { ASK_TOOL_RESULT_MAX_TOKENS, compactToBudget, estimateTokens, toolMessageBody } from './compact-result';

// =============================================================================
// Tool-result compaction (#377): halve the longest array until it fits,
// always valid JSON, always flagged.
// =============================================================================

const chars = (n: number) => 'x'.repeat(n);
const byChars = (text: string) => text.length;

describe('toolMessageBody', () => {
  it('spreads objects and wraps arrays', () => {
    expect(toolMessageBody({ a: 1 }, false)).toEqual({ a: 1, truncated: false });
    expect(toolMessageBody([1, 2], true)).toEqual({ items: [1, 2], truncated: true });
    expect(toolMessageBody(null, false)).toEqual({ items: [], truncated: false });
  });
});

describe('compactToBudget', () => {
  it('leaves a result under budget untouched', () => {
    const body = { items: [1, 2, 3], truncated: false };
    expect(compactToBudget(body, byChars, 1000)).toEqual({ json: JSON.stringify(body), truncated: false });
  });

  it('keeps an already-truncated flag', () => {
    expect(compactToBudget({ items: [], truncated: true }, byChars, 1000).truncated).toBe(true);
  });

  it('halves the longest array, keeping the head, until it fits', () => {
    const body = {
      small: [chars(10), chars(10)],
      big: Array.from({ length: 64 }, (_, i) => `${i}:${chars(50)}`),
      truncated: false,
    };
    const out = compactToBudget(body, byChars, 800);
    const parsed = JSON.parse(out.json);
    expect(out.truncated).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(out.json.length).toBeLessThanOrEqual(800);
    expect(parsed.small).toHaveLength(2);
    expect(parsed.big[0]).toMatch(/^0:/);
    expect(parsed.big.length).toBeLessThan(64);
    // the input object is never mutated
    expect(body.big).toHaveLength(64);
  });

  it('reaches into nested arrays', () => {
    const body = { sections: { a: Array.from({ length: 20 }, () => ({ text: chars(100) })), b: [] }, truncated: false };
    const out = compactToBudget(body, byChars, 500);
    expect(JSON.parse(out.json).sections.a.length).toBeLessThan(20);
    expect(out.json.length).toBeLessThanOrEqual(500);
  });

  it('returns valid, flagged JSON even when nothing more can be dropped', () => {
    const out = compactToBudget({ blob: chars(5000), items: [1, 2], truncated: false }, byChars, 100);
    expect(() => JSON.parse(out.json)).not.toThrow();
    expect(JSON.parse(out.json)).toEqual({ blob: chars(5000), items: [], truncated: true });
    expect(out.truncated).toBe(true);
  });

  it('uses a 3000-token budget and a conservative estimate by default', () => {
    expect(ASK_TOOL_RESULT_MAX_TOKENS).toBe(3000);
    expect(estimateTokens('abcdef')).toBe(2);
    const body = { items: Array.from({ length: 200 }, () => chars(100)), truncated: false };
    const out = compactToBudget(body, estimateTokens);
    expect(estimateTokens(out.json)).toBeLessThanOrEqual(3000);
  });
});
