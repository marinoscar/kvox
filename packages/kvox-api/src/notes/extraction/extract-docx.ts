// =============================================================================
// Word (.docx) to Markdown (epic #708, issue #711)
// =============================================================================
//
// WHAT IS KEPT, AND WHY. A note source is read by a model and by a person, so the
// structure that carries meaning survives and the layout that does not is dropped:
//
//   kept     headings (by style name or outline level), bullet and numbered lists
//            with their nesting, bold and italic, tables (as GFM), hyperlink
//            targets, tracked insertions, content controls (`w:sdt`)
//   dropped  tracked DELETIONS (text the author removed), footnotes and endnotes,
//            headers and footers, images, comments, fonts, colours, page layout
//
// HEADINGS. Word names its built-in styles "heading 1".."heading 9" and "Title"
// in `styles.xml` (the style ID, `Heading1`, is a different, localisable thing),
// so the style NAME is the key; a paragraph or style outline level
// (`w:outlineLvl`, 0-based) is the fallback for a custom heading style. Heading
// text is written without bold/italic markers: a heading style is usually bold
// already and `# **Title**` is noise.
//
// LISTS. `numbering.xml` says, per (numId, level), whether the number format is
// `bullet` (or `none`) or a counting one. Counting lists are numbered from 1 and
// restart after a shallower item, which is what a reader expects.
//
// WHY THE RESULT CARRIES A `title`. `docProps/core.xml` holds the author-set
// title; `documentToNoteBody` prefers it over a heading guess.
//
// ⚠ PURE. No Nest, no I/O. A malformed XML part is `corrupt_file`, never a throw.
// =============================================================================

import type { ExtractedDocument, ExtractionOutcome } from './extraction-result.js';
import {
  gfmTable,
  parseRelationships,
  readCoreTitle,
  type OoxmlRelationship,
} from './ooxml-common.js';
import { child, childrenNamed, OoxmlXmlError, parseXml, type XmlElement } from './ooxml-xml.js';
import { openOoxmlPackage, partText } from './ooxml-zip.js';

/**
 * A successful Office extraction: the text plus the document's own title, if it has one.
 *
 * @stability experimental
 */
export interface OoxmlExtractedDocument extends ExtractedDocument {
  /** `dc:title` from `docProps/core.xml`, or `null`. */
  title: string | null;
}

/**
 * The outcome of {@link extractDocxMarkdown}: assignable to {@link ExtractionOutcome}.
 *
 * @stability experimental
 */
export type OoxmlExtractionOutcome = OoxmlExtractedDocument | Exclude<ExtractionOutcome, ExtractedDocument>;

interface StyleInfo {
  /** Lower-cased style name (`heading 1`, `title`, `list paragraph`). */
  name: string;
  outlineLvl: number | null;
  numId: string | null;
  ilvl: number | null;
}

interface NumberingInfo {
  /** numId to abstractNumId */
  nums: Map<string, string>;
  /** abstractNumId to ilvl to numFmt */
  formats: Map<string, Map<number, string>>;
}

interface Context {
  styles: Map<string, StyleInfo>;
  numbering: NumberingInfo;
  rels: Map<string, OoxmlRelationship>;
  /** Counters for numbered lists: numId to per-level running count. */
  counters: Map<string, number[]>;
}

interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Already-rendered Markdown (a link); never merged or re-marked. */
  raw?: boolean;
}

function intAttr(element: XmlElement | undefined, name: string): number | null {
  const value = element?.attrs[name];
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A toggle property (`w:b`): on unless its `w:val` is false/0/off/none. */
function isOn(property: XmlElement | undefined): boolean {
  if (!property) return false;
  const value = property.attrs['w:val'];
  return value === undefined || !['0', 'false', 'off', 'none'].includes(value.toLowerCase());
}

function parseStyles(xml: string | undefined): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (xml === undefined) return styles;

  for (const style of childrenNamed(parseXml(xml), 'style')) {
    const id = style.attrs['w:styleId'];
    if (id === undefined) continue;
    const pPr = child(style, 'pPr');
    const numPr = child(pPr, 'numPr');
    styles.set(id, {
      name: (child(style, 'name')?.attrs['w:val'] ?? id).toLowerCase(),
      outlineLvl: intAttr(child(pPr, 'outlineLvl'), 'w:val'),
      numId: child(numPr, 'numId')?.attrs['w:val'] ?? null,
      ilvl: intAttr(child(numPr, 'ilvl'), 'w:val'),
    });
  }
  return styles;
}

function parseNumbering(xml: string | undefined): NumberingInfo {
  const info: NumberingInfo = { nums: new Map(), formats: new Map() };
  if (xml === undefined) return info;

  const root = parseXml(xml);
  for (const abstract of childrenNamed(root, 'abstractNum')) {
    const id = abstract.attrs['w:abstractNumId'];
    if (id === undefined) continue;
    const levels = new Map<number, string>();
    for (const lvl of childrenNamed(abstract, 'lvl')) {
      const ilvl = intAttr(lvl, 'w:ilvl');
      if (ilvl !== null) levels.set(ilvl, child(lvl, 'numFmt')?.attrs['w:val'] ?? 'decimal');
    }
    info.formats.set(id, levels);
  }
  for (const num of childrenNamed(root, 'num')) {
    const numId = num.attrs['w:numId'];
    const abstractId = child(num, 'abstractNumId')?.attrs['w:val'];
    if (numId !== undefined && abstractId !== undefined) info.nums.set(numId, abstractId);
  }
  return info;
}

/** Wraps `text` in emphasis markers, keeping surrounding whitespace outside them. */
function emphasize(text: string, bold: boolean, italic: boolean): string {
  if (!bold && !italic) return text;
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [, lead = '', core = '', trail = ''] = match ?? [];
  if (core === '') return text;
  const mark = bold && italic ? '***' : bold ? '**' : '*';
  return `${lead}${mark}${core}${mark}${trail}`;
}

function escapeInline(text: string): string {
  return text.replace(/\*/g, '\\*');
}

function renderSegments(segments: readonly Segment[]): string {
  // Merge neighbours with the same formatting first, so `**a** **b**` runs become `**a b**`.
  const merged: Segment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (
      last &&
      !last.raw &&
      !segment.raw &&
      last.bold === segment.bold &&
      last.italic === segment.italic
    ) {
      last.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged
    .map((s) => (s.raw ? s.text : emphasize(escapeInline(s.text), s.bold, s.italic)))
    .join('');
}

/** Collects the inline content of a paragraph (or hyperlink) into segments. */
function collectInline(
  parent: XmlElement,
  ctx: Context,
  out: Segment[],
  plain: boolean,
): void {
  for (const node of parent.children) {
    switch (node.name) {
      case 'r': {
        const rPr = child(node, 'rPr');
        const bold = !plain && isOn(child(rPr, 'b'));
        const italic = !plain && isOn(child(rPr, 'i'));
        let text = '';
        for (const part of node.children) {
          if (part.name === 't') text += part.text;
          else if (part.name === 'tab') text += '\t';
          else if (part.name === 'noBreakHyphen') text += '-';
          else if (part.name === 'cr' || (part.name === 'br' && (part.attrs['w:type'] ?? 'textWrapping') === 'textWrapping')) {
            text += '\n';
          }
        }
        if (text !== '') out.push({ text, bold, italic });
        break;
      }
      case 'hyperlink': {
        const inner: Segment[] = [];
        collectInline(node, ctx, inner, plain);
        const relId = node.attrs['r:id'];
        const rel = relId === undefined ? undefined : ctx.rels.get(relId);
        const label = renderSegments(inner);
        if (rel?.external && rel.target !== '' && label.trim() !== '' && !plain) {
          out.push({ text: `[${label}](${rel.target.replace(/\)/g, '%29')})`, bold: false, italic: false, raw: true });
        } else {
          out.push(...inner);
        }
        break;
      }
      case 'del':
      case 'moveFrom':
        // Tracked deletion: text the author removed.
        break;
      case 'ins':
      case 'moveTo':
      case 'smartTag':
      case 'fldSimple':
      case 'sdt':
      case 'sdtContent':
      case 'customXml':
        collectInline(node, ctx, out, plain);
        break;
      default:
        break;
    }
  }
}

function inlineText(paragraph: XmlElement, ctx: Context, plain: boolean): string {
  const segments: Segment[] = [];
  collectInline(paragraph, ctx, segments, plain);
  return renderSegments(segments);
}

function headingLevel(paragraph: XmlElement, ctx: Context): number | null {
  const pPr = child(paragraph, 'pPr');
  const styleId = child(pPr, 'pStyle')?.attrs['w:val'];
  const style = styleId === undefined ? undefined : ctx.styles.get(styleId);
  const name = (style?.name ?? styleId ?? '').toLowerCase();

  if (name === 'title') return 1;
  const byName = /^heading\s*([1-9])$/.exec(name);
  if (byName) return Math.min(Number(byName[1]), 6);

  const outline = intAttr(child(pPr, 'outlineLvl'), 'w:val') ?? style?.outlineLvl ?? null;
  if (outline !== null && outline >= 0 && outline <= 8) return Math.min(outline + 1, 6);
  return null;
}

/** The list a paragraph belongs to, or `null`. */
function listMembership(paragraph: XmlElement, ctx: Context): { numId: string; ilvl: number } | null {
  const pPr = child(paragraph, 'pPr');
  const numPr = child(pPr, 'numPr');
  const styleId = child(pPr, 'pStyle')?.attrs['w:val'];
  const style = styleId === undefined ? undefined : ctx.styles.get(styleId);

  const numId = child(numPr, 'numId')?.attrs['w:val'] ?? style?.numId ?? null;
  if (numId === null || numId === '0') return null;
  const ilvl = intAttr(child(numPr, 'ilvl'), 'w:val') ?? style?.ilvl ?? 0;
  return { numId, ilvl: Math.max(0, Math.min(ilvl, 8)) };
}

function listMarker(numId: string, ilvl: number, ctx: Context): string {
  const abstractId = ctx.numbering.nums.get(numId);
  const format = (abstractId === undefined ? undefined : ctx.numbering.formats.get(abstractId)?.get(ilvl)) ?? 'bullet';
  if (format === 'bullet' || format === 'none') return '- ';

  const counters = ctx.counters.get(numId) ?? [];
  counters.length = ilvl + 1; // a shallower item restarts every deeper level
  for (let level = 0; level <= ilvl; level += 1) counters[level] = counters[level] ?? (level === ilvl ? 0 : 1);
  counters[ilvl] += 1;
  ctx.counters.set(numId, counters);
  return `${counters[ilvl]}. `;
}

interface Block {
  text: string;
  list: boolean;
}

function renderParagraph(paragraph: XmlElement, ctx: Context): Block | null {
  const heading = headingLevel(paragraph, ctx);
  if (heading !== null) {
    const text = inlineText(paragraph, ctx, true).replace(/\s*\n\s*/g, ' ').trim();
    return text === '' ? null : { text: `${'#'.repeat(heading)} ${text}`, list: false };
  }

  const text = inlineText(paragraph, ctx, false).replace(/[ \t]+$/g, '');
  const list = listMembership(paragraph, ctx);
  if (text.trim() === '') return null;

  if (list) {
    const indent = '  '.repeat(list.ilvl);
    const marker = listMarker(list.numId, list.ilvl, ctx);
    const continuation = indent + ' '.repeat(marker.length);
    return { text: `${indent}${marker}${text.trim().replace(/\n/g, `\n${continuation}`)}`, list: true };
  }
  return { text: text.trim(), list: false };
}

/** All text of a cell: its paragraphs (and nested tables, flattened) joined by `<br>`. */
function cellText(cell: XmlElement, ctx: Context): string {
  const parts: string[] = [];
  const visit = (node: XmlElement) => {
    for (const item of node.children) {
      if (item.name === 'p') {
        const text = inlineText(item, ctx, false).trim();
        if (text !== '') parts.push(text);
      } else if (item.name === 'tbl' || item.name === 'tr' || item.name === 'tc' || item.name === 'sdt' || item.name === 'sdtContent') {
        visit(item);
      }
    }
  };
  visit(cell);
  return parts.join('\n');
}

function renderTable(table: XmlElement, ctx: Context): string {
  const rows: string[][] = [];
  for (const row of childrenNamed(table, 'tr')) {
    const cells: string[] = [];
    for (const cell of childrenNamed(row, 'tc')) {
      const tcPr = child(cell, 'tcPr');
      const vMerge = child(tcPr, 'vMerge');
      const continued = vMerge !== undefined && (vMerge.attrs['w:val'] ?? 'continue') === 'continue';
      cells.push(continued ? '' : cellText(cell, ctx));
      const span = intAttr(child(tcPr, 'gridSpan'), 'w:val') ?? 1;
      for (let extra = 1; extra < Math.min(span, 64); extra += 1) cells.push('');
    }
    if (cells.length > 0) rows.push(cells);
  }
  return gfmTable(rows);
}

function renderBody(parent: XmlElement, ctx: Context, blocks: Block[]): void {
  for (const node of parent.children) {
    if (node.name === 'p') {
      const block = renderParagraph(node, ctx);
      if (block) blocks.push(block);
    } else if (node.name === 'tbl') {
      const text = renderTable(node, ctx);
      if (text !== '') blocks.push({ text, list: false });
    } else if (node.name === 'sdt' || node.name === 'sdtContent' || node.name === 'ins' || node.name === 'customXml') {
      renderBody(node, ctx, blocks);
    }
  }
}

function joinBlocks(blocks: readonly Block[]): string {
  let out = '';
  blocks.forEach((block, index) => {
    if (index > 0) out += block.list && blocks[index - 1].list ? '\n' : '\n\n';
    out += block.text;
  });
  return out;
}

/**
 * Turn a `.docx` into Markdown, or into the reason it cannot be.
 *
 * @param bytes - the uploaded file.
 * @stability experimental
 */
export function extractDocxMarkdown(bytes: Uint8Array): OoxmlExtractionOutcome {
  const pkg = openOoxmlPackage(
    bytes,
    (name) => /^word\/[^/]+\.xml$/.test(name) || name === 'word/_rels/document.xml.rels' || name === 'docProps/core.xml',
  );
  if (!pkg.ok) return { outcome: 'unextractable', reason: pkg.reason, pageCount: null };

  const documentXml = partText(pkg.files, 'word/document.xml');
  if (documentXml === undefined) return { outcome: 'unextractable', reason: 'corrupt_file', pageCount: null };

  try {
    const ctx: Context = {
      styles: parseStyles(partText(pkg.files, 'word/styles.xml')),
      numbering: parseNumbering(partText(pkg.files, 'word/numbering.xml')),
      rels: parseRelationships(partText(pkg.files, 'word/_rels/document.xml.rels')),
      counters: new Map(),
    };
    const body = child(parseXml(documentXml), 'body');
    const blocks: Block[] = [];
    if (body) renderBody(body, ctx, blocks);

    const text = joinBlocks(blocks).trim();
    if (text === '') return { outcome: 'unextractable', reason: 'empty_document', pageCount: null };

    return {
      outcome: 'extracted',
      text,
      pageCount: null,
      encoding: 'ooxml',
      title: readCoreTitle(partText(pkg.files, 'docProps/core.xml')),
    };
  } catch (error) {
    if (error instanceof OoxmlXmlError) return { outcome: 'unextractable', reason: 'corrupt_file', pageCount: null };
    throw error;
  }
}

/**
 * Same as {@link extractDocxMarkdown}, shaped like the other extractors (a promise).
 *
 * @stability experimental
 */
export function extractDocxText(bytes: Uint8Array): Promise<OoxmlExtractionOutcome> {
  return Promise.resolve(extractDocxMarkdown(bytes));
}
