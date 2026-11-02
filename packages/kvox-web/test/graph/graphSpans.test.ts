import { describe, expect, it } from 'vitest';

import {
  locateQuoteInMarkdown,
  locateQuoteInText,
  segmentElementOf,
  textOffsetWithin,
} from '../../src/graph/headless/utils/graphSpans.js';

function slice(markdown: string, span: { charStart: number; charEnd: number } | null) {
  return span ? markdown.slice(span.charStart, span.charEnd) : null;
}

describe('locateQuoteInMarkdown', () => {
  it('finds an exact quote', () => {
    const md = 'We agreed to ship behind a flag.';
    const span = locateQuoteInMarkdown(md, 'ship behind a flag', 0.5);
    expect(span).toEqual({ charStart: 13, charEnd: 31 });
  });

  it('trims the selection before matching', () => {
    const md = 'Anders owns the rollback plan.';
    expect(slice(md, locateQuoteInMarkdown(md, '  the rollback plan \n', 0.5))).toBe('the rollback plan');
  });

  it('tolerates emphasis markup inside the rendered text', () => {
    const md = 'Met with **Sasha** Example about the pilot.';
    const span = locateQuoteInMarkdown(md, 'Sasha Example', 0.3);
    expect(slice(md, span)).toBe('Sasha** Example');
  });

  it('tolerates underscores, code and strike markers', () => {
    const md = 'Run _the_ `load test` and ~~skip~~ nothing.';
    expect(slice(md, locateQuoteInMarkdown(md, 'Run the load test and skip', 0))).toBe(
      'Run _the_ `load test` and ~~skip',
    );
  });

  it('tolerates link syntax around link text', () => {
    const md = 'Ask [Sasha Example](https://example.com/sasha) about it.';
    const span = locateQuoteInMarkdown(md, 'Ask Sasha Example about', 0);
    expect(slice(md, span)).toBe('Ask [Sasha Example](https://example.com/sasha) about');
  });

  it('collapses whitespace (a soft line break renders as a space)', () => {
    const md = 'Ship the storage\nmigration   behind a flag.';
    expect(slice(md, locateQuoteInMarkdown(md, 'storage migration behind', 0.3))).toBe('storage\nmigration   behind');
  });

  it('picks the occurrence nearest the selection among several', () => {
    const md = 'Anders said yes. Later, Bram said no. Finally Anders said yes.';
    const first = md.indexOf('Anders said yes');
    const last = md.lastIndexOf('Anders said yes');
    expect(locateQuoteInMarkdown(md, 'Anders said yes', 0.05)?.charStart).toBe(first);
    expect(locateQuoteInMarkdown(md, 'Anders said yes', 0.9)?.charStart).toBe(last);
  });

  it('picks the nearest among several tolerant matches too', () => {
    const md = '**Anders** said yes. Then **Anders** said yes again.';
    const span = locateQuoteInMarkdown(md, 'Anders said yes', 0.9);
    expect(span?.charStart).toBe(md.lastIndexOf('Anders'));
  });

  it('returns null when the text is not in the markdown', () => {
    expect(locateQuoteInMarkdown('Nothing to see here.', 'something else', 0.5)).toBeNull();
    expect(locateQuoteInMarkdown('Anything', '   ', 0.5)).toBeNull();
  });

  it('does not treat regex characters in the quote as a pattern', () => {
    const md = 'Budget (Q3) is $4.2m + VAT?';
    expect(slice(md, locateQuoteInMarkdown(md, '(Q3) is $4.2m + VAT?', 0))).toBe('(Q3) is $4.2m + VAT?');
  });
});

describe('locateQuoteInText', () => {
  it('finds a quote and one differing only in whitespace', () => {
    const text = 'Tobias will check with legal.';
    expect(locateQuoteInText(text, 'check with', 0.5)).toEqual({ charStart: 12, charEnd: 22 });
    expect(locateQuoteInText(text, 'check  with', 0.5)).toEqual({ charStart: 12, charEnd: 22 });
    expect(locateQuoteInText(text, 'nope', 0.5)).toBeNull();
  });
});

describe('DOM helpers', () => {
  it('measures a text offset through nested markup', () => {
    const root = document.createElement('p');
    root.innerHTML = 'Met with <strong>Sasha</strong> Example';
    const strongText = root.querySelector('strong')!.firstChild!;
    expect(textOffsetWithin(root, strongText, 2)).toBe('Met with Sa'.length);
  });

  it('finds the enclosing segment element', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p data-segment-id="s1" data-segment-rev="2"><span>hello</span></p>';
    const text = root.querySelector('span')!.firstChild!;
    expect(segmentElementOf(text)?.dataset.segmentId).toBe('s1');
    expect(segmentElementOf(root)).toBeNull();
  });
});
