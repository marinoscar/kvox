// =============================================================================
// `search-snippet.ts` — the escape, and the order it happens in
// (issue #175, epic #164)
// =============================================================================
//
// `ts_headline` copies its source text through verbatim. The source text is a
// transcript of whatever somebody said, a note body written by a model, or a
// title typed by anybody — and the result is rendered as HTML by every client,
// because that is the only way a highlight can exist. The tests below are the
// executable form of `search-snippet.ts`'s header.
// =============================================================================

import {
  escapeHtml,
  markLiteral,
  renderHeadlineHtml,
  SNIPPET_START,
  SNIPPET_STOP,
  HEADLINE_OPTIONS,
} from './search-snippet';

const headline = (text: string) => `${SNIPPET_START}${text}${SNIPPET_STOP}`;

describe('escapeHtml', () => {
  it('escapes every character HTML gives a meaning to', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('does not double-escape the ampersands it writes', () => {
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves the sentinels alone, because they are not HTML', () => {
    expect(escapeHtml(headline('x'))).toBe(headline('x'));
  });
});

describe('renderHeadlineHtml', () => {
  it('renders a script tag from the corpus as text, with no live markup', () => {
    // THE SUCCESS CRITERION, at the unit level. `search.db.spec.ts` proves the
    // same thing end to end through a real `ts_headline`.
    const html = renderHeadlineHtml(
      `<script>alert(1)</script> the ${headline('pricing')} model was discussed`,
    );

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script>');
  });

  it('turns the sentinel pairs into balanced <mark> elements', () => {
    expect(renderHeadlineHtml(`a ${headline('b')} c ${headline('d')} e`)).toBe(
      'a <mark>b</mark> c <mark>d</mark> e',
    );
  });

  it('emits <mark> and nothing else as markup', () => {
    const html = renderHeadlineHtml(`<b>${headline('<i>hit</i>')}</b>`);

    // Every tag in the output is a `<mark>`; the corpus's own `<b>` and `<i>`
    // are escaped text.
    expect(html.match(/<[^>]+>/g)).toEqual(['<mark>', '</mark>']);
  });

  it('strips an unpaired sentinel rather than emitting an unbalanced mark', () => {
    // A stray sentinel can only have come from the corpus (`ts_headline`
    // emits them in pairs). Leaving it in would break the surrounding
    // document's structure.
    expect(renderHeadlineHtml(`a ${SNIPPET_START} b`)).toBe('a  b');
    expect(renderHeadlineHtml(`a ${SNIPPET_STOP} b`)).toBe('a  b');
    expect(renderHeadlineHtml(`${SNIPPET_STOP}a${SNIPPET_START}`)).toBe('a');
  });

  it('handles a hit that is itself markup', () => {
    expect(renderHeadlineHtml(headline('<img src=x onerror=alert(1)>'))).toBe(
      '<mark>&lt;img src=x onerror=alert(1)&gt;</mark>',
    );
  });

  it('is a no-op on text with no hits', () => {
    expect(renderHeadlineHtml('nothing matched here')).toBe('nothing matched here');
  });
});

describe('HEADLINE_OPTIONS', () => {
  it('never asks Postgres for HTML delimiters', () => {
    // The default `StartSel`/`StopSel` ARE `<b>`/`</b>`. Asking for markup
    // here is what makes the escape and the highlight impossible to separate.
    expect(HEADLINE_OPTIONS).not.toContain('<');
    expect(HEADLINE_OPTIONS).not.toContain('>');
    expect(HEADLINE_OPTIONS).toContain(`StartSel="${SNIPPET_START}"`);
    expect(HEADLINE_OPTIONS).toContain(`StopSel="${SNIPPET_STOP}"`);
  });
});

describe('markLiteral', () => {
  it('marks a case-insensitive literal match inside escaped text', () => {
    expect(markLiteral('The <b>Pricing</b> Review', 'pricing')).toBe(
      'The &lt;b&gt;<mark>Pricing</mark>&lt;/b&gt; Review',
    );
  });

  it('marks every occurrence', () => {
    expect(markLiteral('and and', 'and')).toBe('<mark>and</mark> <mark>and</mark>');
  });

  it('escapes a match that is itself markup', () => {
    expect(markLiteral('x <script> y', '<script>')).toBe(
      'x <mark>&lt;script&gt;</mark> y',
    );
  });

  it('treats the needle literally, never as a regular expression', () => {
    expect(markLiteral('a.b', '.')).toBe('a<mark>.</mark>b');
    expect(markLiteral('axb', '.')).toBe('axb');
    expect(markLiteral('cost', '.*')).toBe('cost');
  });

  it('escapes with no highlight when case folding would move the offsets', () => {
    // `'İ'.toLowerCase()` is two code units, so every index into the
    // original string is off by one from there on. A missing mark is a
    // cosmetic loss; a mis-sliced one is a broken document.
    const title = 'İstanbul <notes>';

    expect(markLiteral(title, 'stanbul')).toBe('İstanbul &lt;notes&gt;');
  });

  it('escapes the whole string for an empty needle', () => {
    expect(markLiteral('<x>', '')).toBe('&lt;x&gt;');
  });
});
