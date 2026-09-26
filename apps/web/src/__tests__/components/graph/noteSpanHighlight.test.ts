import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVIDENCE_HIGHLIGHT_NAME,
  findQuoteRange,
  highlightQuoteInElement,
  normalizeQuote,
} from '../../../components/graph/review/noteSpanHighlight';

function body(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('normalizeQuote', () => {
  it('drops markdown punctuation and collapses whitespace', () => {
    expect(normalizeQuote('  **ship** the  [flag](http://x)\n now ')).toBe('ship the flag now');
  });
});

describe('findQuoteRange', () => {
  it('finds a quote split across inline elements and lines', () => {
    const root = body('<p>We will <strong>ship the storage</strong>\n migration behind a flag.</p>');
    const range = findQuoteRange(root, 'ship the **storage** migration behind a flag');
    expect(range?.toString()).toBe('ship the storage\n migration behind a flag');
  });

  it('falls back to a case-insensitive match', () => {
    const root = body('<p>Northwind Robotics is hiring.</p>');
    expect(findQuoteRange(root, 'northwind robotics')?.toString()).toBe('Northwind Robotics');
  });

  it('returns null when the quote is absent', () => {
    const root = body('<p>Something else entirely.</p>');
    expect(findQuoteRange(root, 'not here')).toBeNull();
    expect(findQuoteRange(root, '   ')).toBeNull();
  });
});

describe('highlightQuoteInElement', () => {
  it('uses the CSS Custom Highlight API when available', () => {
    const set = vi.fn();
    class FakeHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    vi.stubGlobal('Highlight', FakeHighlight);
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } });
    const root = body('<p>ship the storage migration</p>');
    Element.prototype.scrollIntoView = vi.fn();

    expect(highlightQuoteInElement(root, 'storage migration')).toBe(true);
    expect(set).toHaveBeenCalledWith(EVIDENCE_HIGHLIGHT_NAME, expect.any(FakeHighlight));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('falls back to the selection', () => {
    const root = body('<p>ship the storage migration</p>');
    Element.prototype.scrollIntoView = vi.fn();
    expect(highlightQuoteInElement(root, 'the storage')).toBe(true);
    expect(window.getSelection()?.toString()).toBe('the storage');
  });

  it('reports a quote that cannot be found, or no body', () => {
    expect(highlightQuoteInElement(body('<p>x</p>'), 'missing')).toBe(false);
    expect(highlightQuoteInElement(null, 'x')).toBe(false);
  });
});
