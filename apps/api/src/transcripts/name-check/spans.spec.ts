// =============================================================================
// spans.ts — where a stored suggestion applies now (issue #328, epic #326)
// =============================================================================

import { applySplices, resolveSpan, type Splice, type StoredSpan } from './spans';

describe('resolveSpan', () => {
  it('uses the stored offsets when they still read the original text', () => {
    const text = 'They called him Skar yesterday.';
    const span: StoredSpan = { start: 16, end: 20, original: 'Skar' };

    expect(resolveSpan(text, span)).toEqual({ start: 16, end: 20 });
  });

  it('relocates to a unique whole-word occurrence when the offsets have shifted', () => {
    // An edit earlier in the line shifted everything after it, so the stored
    // offsets no longer point at "Skar" — but "Skar" still occurs exactly once.
    const text = 'They definitely called him Skar yesterday.';
    const span: StoredSpan = { start: 16, end: 20, original: 'Skar' };

    const resolved = resolveSpan(text, span);
    expect(resolved).not.toBeNull();
    expect(text.slice(resolved!.start, resolved!.end)).toBe('Skar');
  });

  it('returns null when the original text occurs more than once (ambiguous)', () => {
    const text = 'Skar met Skar for coffee.';
    const span: StoredSpan = { start: 99, end: 103, original: 'Skar' };

    expect(resolveSpan(text, span)).toBeNull();
  });

  it('returns null when the original text is missing entirely', () => {
    const text = 'Nothing relevant in this line.';
    const span: StoredSpan = { start: 99, end: 103, original: 'Skar' };

    expect(resolveSpan(text, span)).toBeNull();
  });

  it('does not match a partial word (whole-word only)', () => {
    const text = 'We love the Oscars every year.';
    const span: StoredSpan = { start: 99, end: 103, original: 'scar' };

    expect(resolveSpan(text, span)).toBeNull();
  });

  it('rejects out-of-range stored offsets and falls back to relocation', () => {
    const text = 'Skar was here.';
    const span: StoredSpan = { start: 1000, end: 1004, original: 'Skar' };

    const resolved = resolveSpan(text, span);
    expect(resolved).toEqual({ start: 0, end: 4 });
  });
});

describe('applySplices', () => {
  it('applies multiple splices right to left, preserving earlier offsets', () => {
    const text = 'Skar met Skar for coffee.';
    const splices: Splice[] = [
      { id: 'a', start: 0, end: 4, replacement: 'Oscar' },
      { id: 'b', start: 9, end: 13, replacement: 'Oscar' },
    ];

    const { text: out, applied, skipped } = applySplices(text, splices);

    expect(out).toBe('Oscar met Oscar for coffee.');
    expect(applied.sort()).toEqual(['a', 'b']);
    expect(skipped).toEqual([]);
  });

  it('skips a splice overlapping one already applied, never merging them', () => {
    const text = 'Skar was here.';
    const splices: Splice[] = [
      { id: 'a', start: 0, end: 4, replacement: 'Oscar' },
      // Overlaps [0,4).
      { id: 'b', start: 2, end: 6, replacement: 'XXXX' },
    ];

    const { text: out, applied, skipped } = applySplices(text, splices);

    // Right-to-left ordering means 'b' (start 2) is processed BEFORE 'a'
    // (start 0), so 'b' applies and 'a' is the one that overlaps and is
    // skipped.
    expect(applied).toEqual(['b']);
    expect(skipped).toEqual(['a']);
    expect(out).toBe('SkXXXXas here.');
  });

  it('returns the original text unchanged when every splice is skipped', () => {
    const text = 'hello';
    const splices: Splice[] = [
      { id: 'a', start: 0, end: 3, replacement: 'X' },
      { id: 'b', start: 1, end: 4, replacement: 'Y' },
    ];
    const { applied, skipped } = applySplices(text, splices);
    expect(applied).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it('handles an empty splice list', () => {
    expect(applySplices('hello', [])).toEqual({ text: 'hello', applied: [], skipped: [] });
  });
});
