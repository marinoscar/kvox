/**
 * `remarkAskCitations` — turn an Ask answer's `[^ev7]`-style markers into
 * inline citation nodes (#380, spec §21.3).
 *
 * `ask.respond` (#378) writes markers into the answer as the model emits them:
 * `[^evN]` (a source quote), `[^entN]` (an entity), `[^docN]` (a transcript or
 * note passage), and `[^itmN]`/`[^relN]` (resolved server-side to their first
 * evidence row). Once the turn completes, `citations` says which handles the
 * tools really issued in that turn.
 *
 *   - a VALID citation becomes a node rendered as a chip — evidence numbered by
 *     first appearance (the same source cited twice keeps one number), an
 *     entity as a label chip, a document as a title chip;
 *   - an INVALID or UNKNOWN marker is REMOVED from the rendered text. It stays
 *     in `content` (the buffer is append-only — the stream's offset contract),
 *     which is why the UI, not the server, drops it; {@link summarizeAskCitations}
 *     counts them for the "couldn't be verified" caption.
 *
 * ⚠ THE NODES ARE THIS APP'S OWN, NEVER HTML FROM THE MODEL. A citation node is
 * a `span` with `data-ask-*` properties built here from the validated
 * `citations` array; `AskMessageBubble` maps it onto a React chip. Nothing the
 * model wrote is ever treated as markup (`MarkdownView` has no raw-HTML path).
 *
 * Only TEXT nodes are rewritten, so a marker inside an inline code span or a
 * fenced block is left exactly as written. A marker GFM happened to parse as a
 * footnote reference (only possible when the model also wrote a matching
 * `[^ev7]: …` definition) is treated the same way, and such definitions are
 * dropped so no stray footnote section renders under the answer.
 */

import type { AskCitation } from '../clients/ask.js';

/**
 * Matches one marker. The shared constant is NEVER used for matching directly:
 * a global regex carries `lastIndex` between calls (and `matchAll` copies it),
 * so every use goes through a fresh instance.
 *
 * @stability experimental
 */
export const ASK_MARKER_RE = /\[\^(ev|ent|doc|itm|rel)(\d+)\]/g;

function markerRe(): RegExp {
  return new RegExp(ASK_MARKER_RE.source, 'g');
}

/** The same shape, anchored, for a footnote identifier/label (`ev7`). */
const MARKER_ID_RE = /^(ev|ent|doc|itm|rel)\d+$/;

/**
 * The `data-ask-citation` values a citation node carries.
 *
 * @stability experimental
 */
export type AskCitationNodeKind = 'evidence' | 'entity' | 'document';

/**
 * A minimal mdast node: only what the walker reads or writes.
 *
 * @stability experimental
 */
export interface AskMarkdownNode {
  /** The mdast node type (`text`, `footnoteReference`, ...). */
  type: string;
  /** The text of a `text` node. */
  value?: string;
  /** A footnote's identifier. */
  identifier?: string;
  /** A footnote's label. */
  label?: string;
  /** The node's children. */
  children?: AskMarkdownNode[];
  /** What `remark-rehype` turns the node into. */
  data?: {
    /** The HTML element name. */
    hName?: string;
    /** The element's properties. */
    hProperties?: Record<string, string | number>;
  };
}
type MdNode = AskMarkdownNode;

/**
 * Options of {@link remarkAskCitations}.
 *
 * @stability experimental
 */
export interface RemarkAskCitationsOptions {
  /** The message's resolved citations; a marker without a valid one is removed. */
  citations: readonly AskCitation[];
}

/** Marker text → citation, only for citations that can be rendered. */
function citableByMarker(citations: readonly AskCitation[]): Map<string, AskCitation> {
  const map = new Map<string, AskCitation>();
  for (const citation of citations) {
    if (citation.valid && citation.id) map.set(citation.marker, citation);
  }
  return map;
}

function citationNode(citation: AskCitation, number: number | null): MdNode {
  const properties: Record<string, string | number> = {
    dataAskCitation: citation.kind,
    dataAskId: citation.id ?? '',
    dataAskMarker: citation.marker,
  };
  if (number !== null) properties.dataAskNumber = number;
  if (citation.label) properties.dataAskLabel = citation.label;
  if (citation.documentKind) properties.dataAskDocumentKind = citation.documentKind;
  if (citation.startMs !== null) properties.dataAskStartMs = citation.startMs;
  return { type: 'askCitation', data: { hName: 'span', hProperties: properties }, children: [] };
}

/**
 * Tidy the seam a removed marker leaves: "discussed [^ev9]." must not render
 * as "discussed ." — a space immediately before punctuation (or the end of
 * the text) is dropped.
 */
function trimBeforeRemoval(before: string, after: string): string {
  if (before.endsWith(' ') && (after === '' || /^[\s.,;:!?)\]]/.test(after))) {
    return before.slice(0, -1);
  }
  return before;
}

/**
 * The markdown plugin: `[remarkAskCitations, { citations }]`.
 *
 * @param options - The message's citations.
 * @returns The transformer `react-markdown` runs over the tree.
 *
 * @stability experimental
 */
export function remarkAskCitations(options: RemarkAskCitationsOptions) {
  const citable = citableByMarker(options?.citations ?? []);

  return (tree: MdNode): void => {
    const numbers = new Map<string, number>();
    const numberFor = (citation: AskCitation): number | null => {
      if (citation.kind !== 'evidence' || !citation.id) return null;
      const known = numbers.get(citation.id);
      if (known !== undefined) return known;
      const next = numbers.size + 1;
      numbers.set(citation.id, next);
      return next;
    };

    const rewriteText = (value: string): MdNode[] | null => {
      if (!markerRe().test(value)) return null;
      const out: MdNode[] = [];
      let pending = '';
      let last = 0;
      for (const match of value.matchAll(markerRe())) {
        const start = match.index ?? 0;
        pending += value.slice(last, start);
        last = start + match[0].length;
        const citation = citable.get(`${match[1]}${match[2]}`);
        if (citation) {
          if (pending) out.push({ type: 'text', value: pending });
          pending = '';
          out.push(citationNode(citation, numberFor(citation)));
        } else {
          // Removed. Tidy the seam against the text up to the next marker.
          const rest = value.slice(last);
          const nextMarker = rest.search(markerRe());
          const following = nextMarker === -1 ? rest : rest.slice(0, nextMarker);
          pending = trimBeforeRemoval(pending, following);
        }
      }
      pending += value.slice(last);
      if (pending) out.push({ type: 'text', value: pending });
      return out;
    };

    const walk = (node: MdNode): void => {
      if (!node.children) return;
      const next: MdNode[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
          const replaced = rewriteText(child.value);
          if (replaced) next.push(...replaced);
          else next.push(child);
          continue;
        }
        if (child.type === 'footnoteReference') {
          const id = child.label ?? child.identifier ?? '';
          if (MARKER_ID_RE.test(id)) {
            const citation = citable.get(id);
            if (citation) next.push(citationNode(citation, numberFor(citation)));
            continue;
          }
        }
        if (child.type === 'footnoteDefinition') {
          const id = child.label ?? child.identifier ?? '';
          if (MARKER_ID_RE.test(id)) continue;
        }
        walk(child);
        next.push(child);
      }
      node.children = next;
    };

    walk(tree);
  };
}

// =============================================================================
// Counting — for the captions under an answer
// =============================================================================

/**
 * Removes code from markdown source, so markers inside it are not counted.
 * The plugin leaves those alone; this keeps the count in step with what renders.
 *
 * @param content - The markdown source.
 * @returns The source without fenced blocks and inline code spans.
 *
 * @stability experimental
 */
export function stripMarkdownCode(content: string): string {
  return content
    .replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, '$1')
    .replace(/(`+)[\s\S]*?\1/g, '');
}

/**
 * How many distinct markers of an answer rendered and how many were removed.
 *
 * @stability experimental
 */
export interface AskCitationSummary {
  /** Distinct markers that rendered as a chip. */
  validCount: number;
  /** Distinct markers that were removed: unissued, invalid, or never resolved. */
  invalidCount: number;
}

/**
 * Counts the distinct markers of an answer, for the captions under it.
 *
 * @param content - The answer.
 * @param citations - Its resolved citations.
 * @returns The two counts.
 *
 * @stability experimental
 */
export function summarizeAskCitations(
  content: string,
  citations: readonly AskCitation[],
): AskCitationSummary {
  const citable = citableByMarker(citations);
  const seen = new Set<string>();
  let validCount = 0;
  let invalidCount = 0;
  for (const match of stripMarkdownCode(content).matchAll(markerRe())) {
    const marker = `${match[1]}${match[2]}`;
    if (seen.has(marker)) continue;
    seen.add(marker);
    if (citable.has(marker)) validCount += 1;
    else invalidCount += 1;
  }
  return { validCount, invalidCount };
}

/**
 * Hides a marker that is still arriving. Mid-stream the answer can end in
 * `[^ev` — shown raw it would flash on screen for a moment and then vanish.
 *
 * @param content - The answer so far.
 * @returns The answer without a trailing partial marker.
 *
 * @stability experimental
 */
export function stripTrailingPartialMarker(content: string): string {
  return content.replace(/\[(\^((ev|ent|doc|itm|rel|e|en|d|do|i|it|r|re)\d*)?)?$/, '');
}
