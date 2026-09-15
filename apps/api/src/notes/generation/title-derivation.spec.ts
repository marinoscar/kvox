import { deriveTitleFromBody, truncateTitle } from './title-derivation';

// =============================================================================
// title-derivation.ts (issue #182, epic #163) — RANK 2
// =============================================================================
//
// Pure and cheap, so it is tested thoroughly rather than through a handful of
// representative cases: every branch `firstHeading`/`firstSentence`/
// `stripInlineMarkdown`/`truncateTitle` can take, exercised directly.
// =============================================================================

describe('deriveTitleFromBody — headings win', () => {
  it('takes an ATX heading at any level over later prose', () => {
    expect(deriveTitleFromBody('# Top level\n\nSome prose that follows it.', 200)).toBe('Top level');
    expect(deriveTitleFromBody('###### Deep dive\n\nSome prose that follows it.', 200)).toBe(
      'Deep dive',
    );
  });

  it('strips inline emphasis, backticks and links from the heading text', () => {
    expect(
      deriveTitleFromBody(
        '## **Overview** of [Q3](https://example.com/q3)\n\nRevenue grew this quarter.',
        200,
      ),
    ).toBe('Overview of Q3');
    expect(deriveTitleFromBody('## `snake_case` config\n\nSome prose.', 200)).toBe(
      'snake_case config',
    );
  });

  it('strips a closing run of `#` as decoration, not content', () => {
    expect(deriveTitleFromBody('## Overview ##\n\nSome prose.', 200)).toBe('Overview');
  });

  it('is checked here: a setext heading (underlined with `===`) IS handled, because the underline reads as a thematic break that ends the paragraph containing just the heading line', () => {
    expect(deriveTitleFromBody('Overview\n========\n\nSome prose that follows.', 200)).toBe(
      'Overview',
    );
    expect(deriveTitleFromBody('Overview\n--------\n\nSome prose that follows.', 200)).toBe(
      'Overview',
    );
  });

  it('does not treat a heading-shaped line inside a fenced code block as a heading', () => {
    expect(
      deriveTitleFromBody('```\n# not a heading\n```\n\nReal prose sentence here.', 200),
    ).toBe('Real prose sentence here');
    expect(
      deriveTitleFromBody('~~~\n# not a heading\n~~~\n\nReal prose sentence here.', 200),
    ).toBe('Real prose sentence here');
  });
});

describe('deriveTitleFromBody — no heading, falls back to the first sentence', () => {
  it('skips an unordered list and takes the first sentence of the prose paragraph after it', () => {
    expect(
      deriveTitleFromBody('- item one\n- item two\n\nActual prose sentence.', 200),
    ).toBe('Actual prose sentence');
  });

  it('skips an ordered list', () => {
    expect(
      deriveTitleFromBody('1. item one\n2. item two\n\nActual prose sentence.', 200),
    ).toBe('Actual prose sentence');
  });

  it('skips a block quote', () => {
    expect(deriveTitleFromBody('> a quote\n\nActual prose sentence.', 200)).toBe(
      'Actual prose sentence',
    );
  });

  it('skips a thematic break', () => {
    expect(deriveTitleFromBody('---\n\nActual prose sentence.', 200)).toBe(
      'Actual prose sentence',
    );
  });

  it('skips table rows', () => {
    expect(
      deriveTitleFromBody('| a | b |\n|---|---|\n\nActual prose sentence.', 200),
    ).toBe('Actual prose sentence');
  });

  it('terminates on `.`, `!` or `?` followed by whitespace, dropping the punctuation', () => {
    expect(deriveTitleFromBody('First sentence. Second sentence.', 200)).toBe('First sentence');
    expect(deriveTitleFromBody('Wow! More text follows.', 200)).toBe('Wow');
    expect(deriveTitleFromBody('Really? More text follows.', 200)).toBe('Really');
  });

  it('terminates on `.`, `!` or `?` at the very end of the input', () => {
    expect(deriveTitleFromBody('That is the whole point.', 200)).toBe('That is the whole point');
  });

  it('takes the whole paragraph when it has no terminator at all', () => {
    expect(deriveTitleFromBody('No terminator at all here', 200)).toBe('No terminator at all here');
  });

  it('leaves an identifier with underscores intact — the emphasis stripper must not eat them', () => {
    expect(
      deriveTitleFromBody('snake_case_name and note_generations are fine.', 200),
    ).toBe('snake_case_name and note_generations are fine');
  });
});

describe('deriveTitleFromBody — null for nothing usable', () => {
  it('is null for an empty body', () => {
    expect(deriveTitleFromBody('', 200)).toBeNull();
  });

  it('is null for a whitespace-only body', () => {
    expect(deriveTitleFromBody('   \n  \n\t', 200)).toBeNull();
  });

  it('is null for a body that is only a fenced code block', () => {
    expect(deriveTitleFromBody('```\ncode only, no prose\n```', 200)).toBeNull();
  });

  it('is null for a body that is only a block quote', () => {
    expect(deriveTitleFromBody('> just a quote', 200)).toBeNull();
  });

  it('is null when the ceiling itself is not usable (zero, negative, non-finite)', () => {
    expect(deriveTitleFromBody('# Heading\n\nSome prose.', 0)).toBeNull();
    expect(deriveTitleFromBody('# Heading\n\nSome prose.', -5)).toBeNull();
    expect(deriveTitleFromBody('# Heading\n\nSome prose.', Number.NaN)).toBeNull();
  });
});

describe('truncateTitle', () => {
  it('cuts on a word boundary and appends a single `…`', () => {
    const result = truncateTitle('The quick brown fox jumps over the lazy dog', 20);

    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toContain('...');
    expect(result).toBe('The quick brown…');
  });

  it('trims trailing punctuation left dangling by the cut, before adding the ellipsis', () => {
    expect(truncateTitle('Alpha, beta, gamma, delta', 12)).toBe('Alpha…');
  });

  it('still fits the ceiling when a single word is longer than the whole ceiling', () => {
    const result = truncateTitle('Supercalifragilisticexpialidocious', 10);

    expect(result.length).toBeLessThanOrEqual(10);
    expect(result).toBe('Supercali…');
  });

  it('does not truncate a string exactly at the ceiling', () => {
    const exact = 'Exactly twenty chars';

    expect(exact.length).toBe(20);
    expect(truncateTitle(exact, 20)).toBe(exact);
  });

  it('does not truncate a string under the ceiling', () => {
    expect(truncateTitle('Short title', 200)).toBe('Short title');
  });
});
