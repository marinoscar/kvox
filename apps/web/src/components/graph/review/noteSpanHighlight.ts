/**
 * "Show in note" — find an evidence quote in the RENDERED note body and mark
 * it (#367).
 *
 * The quote is a slice of the note's markdown SOURCE, while the page shows
 * rendered markdown: emphasis markers, heading hashes and list bullets are
 * gone and whitespace is re-flowed. So both sides are normalised before the
 * search — markdown punctuation dropped from the quote, whitespace ignored on
 * both sides — and the match is mapped back to a DOM
 * `Range` over the original text nodes.
 *
 * Highlighting uses the CSS Custom Highlight API
 * (`CSS.highlights.set('graph-evidence', …)`) where the browser has it, which
 * marks the text without touching the DOM React owns; elsewhere it falls back
 * to the document selection.
 */

export const EVIDENCE_HIGHLIGHT_NAME = 'graph-evidence';

/** Collapse whitespace; drop markdown punctuation that rendering removes. */
export function normalizeQuote(quote: string): string {
  return quote
    .normalize('NFC')
    .replace(/[*_`#>]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

interface CharPosition {
  node: Text;
  offset: number;
}

/**
 * The rendered text of `root` with ALL whitespace removed, and a map from each
 * remaining character back to its text node and offset. Whitespace is dropped
 * rather than collapsed because rendering moves it around unpredictably — an
 * inline `<strong>` splits a word across text nodes, a block boundary joins
 * two lines with none — while the order of the visible characters is stable.
 */
function flatten(root: Node): { text: string; positions: CharPosition[] } {
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  const positions: CharPosition[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const value = textNode.data;
    for (let i = 0; i < value.length; i += 1) {
      if (/\s/.test(value[i])) continue;
      text += value[i];
      positions.push({ node: textNode, offset: i });
    }
  }
  return { text, positions };
}

/** A DOM range over `quote` inside `root`, or null when it is not there. */
export function findQuoteRange(root: Node, quote: string): Range | null {
  const needle = normalizeQuote(quote).replace(/\s+/g, '');
  if (!needle) return null;
  const { text, positions } = flatten(root);
  let index = text.indexOf(needle);
  if (index < 0) index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return null;

  const start = positions[index];
  const end = positions[index + needle.length - 1];
  if (!start || !end) return null;
  const doc = root.ownerDocument ?? document;
  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, Math.min(end.offset + 1, end.node.data.length));
  return range;
}

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

function highlightRegistry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const ctor = (globalThis as { Highlight?: unknown }).Highlight;
  return css?.highlights && typeof ctor === 'function' ? css.highlights : null;
}

/** Remove any evidence highlight this module drew. */
export function clearQuoteHighlight(): void {
  highlightRegistry()?.delete(EVIDENCE_HIGHLIGHT_NAME);
}

/**
 * Scroll `quote` into view inside `root` and highlight it. Returns false when
 * the quote cannot be found (the note changed, or it is not rendered).
 */
export function highlightQuoteInElement(root: HTMLElement | null | undefined, quote: string): boolean {
  if (!root) return false;
  const range = findQuoteRange(root, quote);
  if (!range) return false;

  const anchor = range.startContainer.parentElement ?? root;
  anchor.scrollIntoView?.({ behavior: 'smooth', block: 'center' });

  const registry = highlightRegistry();
  if (registry) {
    const HighlightCtor = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown })
      .Highlight;
    registry.set(EVIDENCE_HIGHLIGHT_NAME, new HighlightCtor(range));
    return true;
  }

  const selection = root.ownerDocument?.getSelection?.() ?? window.getSelection?.();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}
