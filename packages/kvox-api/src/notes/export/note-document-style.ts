// =============================================================================
// note-document-style: the shared design decisions of the note PDF and Word exports
// =============================================================================
//
// The single place the PDF and Word renderers take typography, colour and layout
// decisions from, so both formats look identical. Pure: no pdfkit, no docx. All
// sizes and spacings are in POINTS (Word converts: half-points = pt x 2,
// twips = pt x 20).
// =============================================================================

import { DEFAULT_KVOX_BRAND, KVOX_DOCUMENT_THEME } from '../../core/index.js';
import { spansText, type MdAlign, type MdSpan } from './markdown-ast.js';
import { formatDate, type NoteExportDocument } from './note-export-document.js';

/** The print palette (alias of `KVOX_DOCUMENT_THEME`). */
export const NOTE_THEME = KVOX_DOCUMENT_THEME;

/** The type scale, in points. */
export const NOTE_TYPE = {
  title: 26,
  h1: 18,
  h2: 14.5,
  h3: 12.5,
  h4: 11,
  h5: 10.5,
  h6: 10.5,
  body: 10.5,
  table: 9.5,
  code: 8.5,
  meta: 8.5,
  label: 7.5,
  header: 8,
  footer: 8,
  brand: 11,
} as const;

/** Spacing and indents, in points (`lineHeight` is a multiplier). */
export const NOTE_SPACING = {
  paragraphAfter: 7,
  headingBefore: { 1: 18, 2: 14, 3: 11, 4: 9, 5: 8, 6: 8 } as Record<1 | 2 | 3 | 4 | 5 | 6, number>,
  headingAfter: 5,
  listItemAfter: 2.5,
  blockAfter: 9,
  lineHeight: 1.35,
  tableCellPadX: 6,
  tableCellPadY: 4,
  codePad: 8,
  quoteIndent: 14,
  listIndent: 16,
  markerWidth: 14,
} as const;

/** Heading colour by level: 1 primaryDark, 2 ink, 3 primary, 4 ink, 5/6 muted. */
export function headingColor(level: number): string {
  switch (level) {
    case 1:
      return NOTE_THEME.primaryDark;
    case 3:
      return NOTE_THEME.primary;
    case 5:
    case 6:
      return NOTE_THEME.muted;
    default:
      return NOTE_THEME.ink;
  }
}

/** Whether a heading level carries a divider-coloured underline (h1 only). */
export function headingRule(level: number): boolean {
  return level === 1;
}

const BULLETS = ['•', '◦', '▪', '▫'] as const;

/** The bullet glyph for a list nesting depth (0-based), cycling. */
export function bulletGlyph(depth: number): string {
  const d = Math.max(0, Math.trunc(depth));
  return BULLETS[d % BULLETS.length]!;
}

function lowerLetters(n: number): string {
  let out = '';
  let v = Math.max(1, Math.trunc(n));
  while (v > 0) {
    v -= 1;
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26);
  }
  return out;
}

function lowerRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let v = Math.min(3999, Math.max(1, Math.trunc(n)));
  let out = '';
  for (const [value, glyph] of table) {
    while (v >= value) {
      out += glyph;
      v -= value;
    }
  }
  return out;
}

/** An ordered-list marker: depth%3 gives `1.` / `a.` / `i.` styles. */
export function orderedMarker(n: number, depth: number): string {
  switch (Math.max(0, Math.trunc(depth)) % 3) {
    case 1:
      return `${lowerLetters(n)}.`;
    case 2:
      return `${lowerRoman(n)}.`;
    default:
      return `${Math.trunc(n)}.`;
  }
}

/**
 * Relative column widths from content length (cells capped at 60 chars), floored at
 * `minShare` (default 0.08) of the total. Sums to 1; an empty table is equal shares.
 */
export function tableColumnWeights(
  table: { header: readonly (readonly MdSpan[])[]; rows: readonly (readonly (readonly MdSpan[])[])[] },
  opts: { minShare?: number } = {},
): number[] {
  const columns = Math.max(table.header.length, ...table.rows.map((r) => r.length), 0);
  if (columns === 0) return [];
  const equal = Array.from({ length: columns }, () => 1 / columns);
  const minShare = Math.min(opts.minShare ?? 0.08, 1 / columns);

  const lengths = Array.from({ length: columns }, (_, c) => {
    const cells = [table.header[c], ...table.rows.map((r) => r[c])];
    return Math.max(
      1,
      ...cells.map((cell) => (cell ? Math.min(60, spansText(cell).length) : 0)),
    );
  });
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= 0) return equal;

  let shares = lengths.map((l) => l / total);
  // Raise short columns to the floor, taking the difference proportionally from the rest.
  for (let pass = 0; pass < columns; pass += 1) {
    const low = shares.map((s) => s < minShare);
    if (!low.some(Boolean)) break;
    const fixed = low.filter(Boolean).length * minShare;
    const freeSum = shares.reduce((a, s, i) => a + (low[i] ? 0 : s), 0);
    shares = shares.map((s, i) => (low[i] ? minShare : (s / freeSum) * (1 - fixed)));
  }
  const sum = shares.reduce((a, b) => a + b, 0);
  return shares.map((s) => s / sum);
}

/** A column alignment with the unspecified case resolved to `left`. */
export function tableAlignment(align: MdAlign): 'left' | 'center' | 'right' {
  return align ?? 'left';
}

/** The short uppercase label for a code block's language, or null. */
export function codeLanguageLabel(language: string | null): string | null {
  const label = (language ?? '').trim().split(/\s+/)[0] ?? '';
  return label === '' ? null : label.slice(0, 12).toUpperCase();
}

/** `Exported Sep 12, 2026`. */
export function exportedLabel(doc: Pick<NoteExportDocument, 'exportedAt'>): string {
  return `Exported ${formatDate(doc.exportedAt)}`;
}

/** The small uppercase line above the title: the template name, else `NOTE`. */
export function kickerText(doc: Pick<NoteExportDocument, 'templateName'>): string {
  const name = doc.templateName?.trim();
  return (name ? name : 'Note').toUpperCase();
}

/**
 * The footer line. The product name comes from the host's brand, never a literal.
 * Pure so the string is assertable without rendering a PDF.
 */
export function noteFooterText(
  page: number,
  total: number,
  version: number,
  appName: string = DEFAULT_KVOX_BRAND.appName,
): string {
  return `Page ${page} of ${total} · Version ${version} · Exported from ${appName}`;
}

/** Task-list glyphs for Word (the PDF draws vectors). */
export const TASK_GLYPH = { done: '☑', open: '☐' } as const;
