/**
 * `SearchSnippet` — issue #176, epic #164.
 *
 * =============================================================================
 * THE ONE TEST THIS FILE EXISTS FOR
 * =============================================================================
 *
 * "renders a `&lt;script&gt;` payload as TEXT, with no script element anywhere".
 *
 * `snippet.html` is escaped by the API before it is sent, so in a correct
 * system that payload never arrives. The component parses the string anyway
 * rather than handing it to `dangerouslySetInnerHTML`, and this test is the
 * proof that the parse is what makes the difference: it feeds the component the
 * exact string a BROKEN server would send and asserts the browser gets markup
 * to read rather than markup to run.
 *
 * Deleting this test would leave the component's behaviour unpinned in the one
 * scenario where the behaviour matters — every other test here passes
 * identically against an `innerHTML` implementation.
 */

import { describe, it, expect } from 'vitest';

import { render } from '../../utils/test-utils';
import {
  SearchSnippet,
  parseSnippetHtml,
  unescapeSnippetText,
} from '../../../components/search/SearchSnippet';
import type { SearchSnippet as SearchSnippetData } from '../../../services/search';

function snippet(html: string, overrides: Partial<SearchSnippetData> = {}): SearchSnippetData {
  return { html, startMs: null, field: 'segment', ...overrides };
}

describe('parseSnippetHtml', () => {
  it('splits on the mark pair and flags the hit', () => {
    expect(parseSnippetHtml('we discussed the <mark>budget</mark> at length')).toEqual([
      { text: 'we discussed the ', marked: false },
      { text: 'budget', marked: true },
      { text: ' at length', marked: false },
    ]);
  });

  it('handles several marks, and a string that starts and ends inside one', () => {
    expect(parseSnippetHtml('<mark>a</mark> b <mark>c</mark>')).toEqual([
      { text: 'a', marked: true },
      { text: ' b ', marked: false },
      { text: 'c', marked: true },
    ]);
  });

  it('returns nothing for an empty string rather than one empty part', () => {
    expect(parseSnippetHtml('')).toEqual([]);
  });

  it('unescapes the five entities the server writes', () => {
    expect(unescapeSnippetText('Tom &amp; Jerry &lt;3 &gt;_&lt; &quot;hi&quot; &#39;x&#39;')).toBe(
      'Tom & Jerry <3 >_< "hi" \'x\'',
    );
  });

  it('decodes in ONE pass, so `&amp;lt;` stays the text `&lt;`', () => {
    // The whole reason the decode is a single regex pass. Decoding `&amp;`
    // first and `&lt;` second would re-manufacture the angle bracket the
    // server's escape existed to remove.
    expect(unescapeSnippetText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('leaves entities the server never writes alone', () => {
    // A user who literally typed `&copy;` gets `&copy;` back, not `©`.
    expect(unescapeSnippetText('&copy; 2026 &nbsp;')).toBe('&copy; 2026 &nbsp;');
  });
});

describe('SearchSnippet — rendering', () => {
  it('renders a hit as a real <mark> ELEMENT', () => {
    const { container } = render(
      <SearchSnippet snippet={snippet('we discussed the <mark>budget</mark> at length')} />,
    );

    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('budget');
    expect(container.textContent).toBe('we discussed the budget at length');
  });

  it('renders every mark in a multi-hit snippet', () => {
    const { container } = render(
      <SearchSnippet snippet={snippet('<mark>quarterly</mark> and <mark>pricing</mark>')} />,
    );

    expect(container.querySelectorAll('mark')).toHaveLength(2);
  });

  it('unescapes entities into their characters in the visible text', () => {
    const { container } = render(
      <SearchSnippet snippet={snippet('R&amp;D said &quot;<mark>ship</mark> it&quot;')} />,
    );

    expect(container.textContent).toBe('R&D said "ship it"');
    expect(container.querySelector('mark')).toHaveTextContent('ship');
  });

  it('⚠ renders a &lt;script&gt; payload as TEXT, with no script element in the DOM', () => {
    const { container } = render(
      <SearchSnippet
        snippet={snippet('a &lt;script&gt;alert(1)&lt;/script&gt; <mark>hit</mark>')}
      />,
    );

    // The assertion that matters: nothing executable was created, anywhere.
    expect(container.querySelector('script')).toBeNull();
    expect(document.querySelectorAll('script')).toHaveLength(0);
    // …and the user can SEE what the server sent, which is the whole point of
    // failing this way rather than silently.
    expect(container.textContent).toBe('a <script>alert(1)</script> hit');
  });

  it('does not create an element from a tag smuggled INSIDE a mark either', () => {
    const { container } = render(
      <SearchSnippet snippet={snippet('<mark>&lt;img src=x onerror=1&gt;</mark>')} />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('mark')).toHaveTextContent('<img src=x onerror=1>');
  });

  it('shows a timestamp for a snippet that has one', () => {
    const { container } = render(
      <SearchSnippet snippet={snippet('<mark>budget</mark>', { startMs: 3_725_000 })} />,
    );

    expect(container.textContent).toContain('1:02:05');
  });

  it('shows no timestamp when startMs is null — a note is not at a point in audio', () => {
    const { container } = render(
      <SearchSnippet snippet={snippet('<mark>budget</mark>', { field: 'body' })} />,
    );

    expect(container.textContent).toBe('budget');
  });
});
