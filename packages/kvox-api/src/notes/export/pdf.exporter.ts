// =============================================================================
// The PDF note export (issue #54, docs/specs/notes.md §8.3)
// =============================================================================
//
// pdfkit, streamed, with the SAME three Noto faces transcript export bundles
// (`apps/api/src/pdf/pdf-fonts.ts`) — §8.3 names the fonts and the streaming
// `render(doc, options, out)` contract as the two pieces of infrastructure
// genuinely shared between transcript and note PDFs, and this file uses both.
// Not a headless browser (300 MB+ in the image, a sandbox, and a lot of memory
// per render) and not `pdfmake` (builds the whole document in memory).
//
// -----------------------------------------------------------------------------
// THE DESIGN (shared with the Word export through `note-document-style.ts`)
// -----------------------------------------------------------------------------
//
// VISION.md asks for documents "intentionally produced rather than simply
// printed from a browser". Every colour, size and spacing comes from
// `note-document-style.ts` (so the PDF and the Word file cannot drift apart);
// this file only decides how pdfkit draws them:
//
//   * page 1: a masthead (vector brand mark, product name, export date) over a
//     2pt primary rule with an amber lead-in, a kicker (template name), the
//     title with an accent bar, and the provenance as a tinted two-column card;
//   * pages 2+: a running header (mark, product name, note title) and a footer
//     hairline with "Page x of y · Version n · Exported from <product>";
//   * body: coloured heading hierarchy (h1 underlined), hanging-indent lists
//     with vector task checkboxes, blockquotes with a primary bar that follows
//     the quote across pages, code blocks that split across pages line by
//     line, and tables with a primary header row, zebra body rows, rounded
//     corners and a header row repeated on every page the table spans.
//
// What it deliberately is NOT: an HTML dump. Nothing here renders markup — the
// body arrives as the block AST `markdown-ast.ts` parsed.
//
// -----------------------------------------------------------------------------
// `bufferPages`, AND WHAT IT DOES AND DOES NOT BUFFER
// -----------------------------------------------------------------------------
//
// The footer says "Page x of y", and `y` is unknowable until the last block has
// been laid out. pdfkit's `bufferPages: true` holds each page's METADATA so
// `switchToPage` can go back and draw on it; the page CONTENT streams out as it
// always did.
//
// ⚠ THE MARGINS ARE ZEROED WHILE THE FOOTER AND HEADER ARE DRAWN, and restored
// immediately. Writing at `page.height - FOOTER_BASELINE` is BELOW the bottom
// margin, and pdfkit responds to text below the margin by adding a new page —
// which, inside the loop that decorates every page, appends one page per page,
// forever. The zeroing is not a style choice; it is what stops that. The same
// trap `transcripts/export/pdf.exporter.ts` documents, and it is the same trap
// here because it is a property of pdfkit, not of transcripts. Table cells and
// code lines are drawn with the bottom margin zeroed for the same reason: their
// height was measured up front, and a rounding difference must not add a page.
//
// ⚠ pdfkit CARRIES `underline`, `strike`, `link` AND `oblique` FROM ONE
// CONTINUED TEXT CALL TO THE NEXT. Every run therefore passes all of them
// explicitly, and every continued run ends with a `continued: false` call.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { Writable } from 'node:stream';
import type PDFDocumentType from 'pdfkit';

import {
  DEFAULT_KVOX_BRAND,
  KVOX_BRAND,
  PDF_FONTS,
  assertFontsPresent,
  defaultPdfFontDir,
  drawBrandMark,
  registerPdfFonts,
  type KvoxBrand,
  type KvoxPdfDocument,
} from '../../core/index.js';
import {
  failStream,
  optionsSchemaFor,
  type ExportOptionField,
  type ExportOptions,
} from '../../transcripts/index.js';
import { NOTES_MODULE_OPTIONS, type ResolvedNotesOptions } from '../notes.options.js';
import { parseBody, type MdBlock, type MdSpan } from './markdown-ast.js';
import {
  NOTE_SPACING,
  NOTE_THEME,
  NOTE_TYPE,
  bulletGlyph,
  codeLanguageLabel,
  exportedLabel,
  headingColor,
  headingRule,
  kickerText,
  noteFooterText,
  orderedMarker,
  tableAlignment,
  tableColumnWeights,
} from './note-document-style.js';
import {
  provenanceEntries,
  type NoteExportDocument,
} from './note-export-document.js';
import { NoteExporterRegistry, type NoteExporter } from './note-exporter.registry.js';

/** Page geometry, in PDF points (72 per inch). A4 is 595.28 x 841.89. */
const MARGIN = 56;
/** Top margin of every page: room for the running header on pages 2+. */
const MARGIN_TOP = 66;
/** Bottom margin: room for the footer. */
const MARGIN_BOTTOM = 60;
/** Where page 1's masthead starts. */
const MASTHEAD_TOP = 40;
/** Distance from the bottom edge to the footer text's top. */
const FOOTER_TEXT_OFFSET = 40;
/** Distance from the bottom edge to the footer hairline. */
const FOOTER_RULE_OFFSET = 50;
/** Running-header geometry on pages 2+. */
const HEADER_TOP = 28;
const HEADER_MARK = 11;
const HEADER_RULE_Y = 46;

/** Rounded-corner radius of panels and tables. */
const PANEL_RADIUS = 4;
const TABLE_RADIUS = 3;
/** Width of the left bars (provenance card, blockquote). */
const BAR_WIDTH = 3;
/** The task checkbox. */
const CHECKBOX = 9;
/** Nesting guard for the layout width. */
const MIN_WIDTH = 60;

export const PDF_NOTE_EXPORT_OPTIONS: readonly ExportOptionField[] = [
  {
    key: 'includePageNumbers',
    label: 'Include page numbers',
    description:
      'Prints "Page x of y", the exported version and the application name in the footer of ' +
      'every page, so a printed page found on its own can still be traced back.',
    type: 'boolean',
    default: true,
  },
];

/**
 * Renders a note as a PDF.
 *
 * @stability experimental
 */
@Injectable()
export class PdfNoteExporter implements NoteExporter, OnModuleInit {
  private readonly logger = new Logger(PdfNoteExporter.name);

  readonly format = 'pdf';
  readonly label = 'PDF';
  readonly mimeType = 'application/pdf';
  readonly extension = 'pdf';
  readonly options = PDF_NOTE_EXPORT_OPTIONS;
  readonly optionsSchema = optionsSchemaFor(PDF_NOTE_EXPORT_OPTIONS);

  constructor(
    private readonly registry: NoteExporterRegistry,
    @Optional() @Inject(KVOX_BRAND) private readonly brand: KvoxBrand = DEFAULT_KVOX_BRAND,
    @Optional() @Inject(NOTES_MODULE_OPTIONS) private readonly resolved?: ResolvedNotesOptions,
  ) {}

  /** Registers the exporter with the registry. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  async render(doc: NoteExportDocument, options: ExportOptions, out: Writable): Promise<void> {
    let finished: Promise<void> | undefined;

    // ⚠ EVERYTHING THAT CAN THROW IS INSIDE THE `try`, INCLUDING THE MISSING
    // FONTS CHECK AND THE `PDFDocument` CONSTRUCTOR. A throw before `out` was
    // destroyed leaves the destination open forever: `NoteObjectsService
    // .putStream`'s upload is waiting for an `end` that is never coming, and
    // its `done` promise never settles, so the job's own `Promise.all` rejects
    // while an upload hangs behind it. Destroying `out` on every failure path
    // is what turns that into a clean, observed failure.
    try {
      const fontDir = this.resolved?.fontDir ?? defaultPdfFontDir();

      assertFontsPresent(fontDir);

      // Loaded here, not at import: `pdfkit` is an optional peer, and a host that never
      // renders a PDF must be able to import this slice without it.
      const PDFDocument = require('pdfkit') as typeof PDFDocumentType;

      const info: Record<string, unknown> = {
        Title: doc.title,
        Author: doc.author?.displayName ?? this.brand.appName,
        Subject: `Note version ${doc.version}`,
        Creator: this.brand.appName,
        Producer: this.brand.appName,
        CreationDate: doc.exportedAt,
      };

      if (doc.templateName?.trim()) info.Keywords = doc.templateName.trim();

      const pdf = new PDFDocument({
        size: 'A4',
        bufferPages: true,
        autoFirstPage: true,
        margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN, right: MARGIN },
        info,
      });

      registerPdfFonts(pdf, fontDir);

      // The promise settles on the DESTINATION's `finish`, not on the
      // document's `end`: the exporter contract promises every byte has been
      // handed on, and `doc.end()` only means pdfkit has stopped producing
      // them.
      finished = new Promise<void>((resolvePromise, reject) => {
        out.once('finish', resolvePromise);
        out.once('error', reject);
        pdf.once('error', reject);
      });

      pdf.pipe(out);

      drawTitleBlock(pdf, doc, this.brand.appName);
      drawBlocks(pdf, parseBody(doc.body, doc.bodyFormat), MARGIN, contentWidth(pdf));
      decoratePages(pdf, doc, options.includePageNumbers !== false, this.brand.appName);
      pdf.end();
    } catch (error) {
      // `finished` rejects on that destroy and nobody awaits it past this point.
      finished?.catch(() => undefined);
      failStream(out, error);

      throw error;
    }

    await finished;

    this.logger.debug(`Rendered note ${doc.noteId} v${doc.version} to PDF`);
  }
}

/** The document pdfkit hands back. Narrowed so helpers stay readable. */
type Pdf = InstanceType<typeof PDFDocumentType>;

// =============================================================================
// Page 1: masthead, kicker, title, provenance card
// =============================================================================

/** The masthead, the kicker, the note's name and the provenance card. */
export function drawTitleBlock(
  target: KvoxPdfDocument,
  doc: NoteExportDocument,
  appName: string = DEFAULT_KVOX_BRAND.appName,
): void {
  const pdf = target as Pdf;
  const width = contentWidth(pdf);
  const logo = 22;

  // --- masthead -------------------------------------------------------------
  drawBrandMark(pdf, MARGIN, MASTHEAD_TOP, logo);

  const mid = MASTHEAD_TOP + logo / 2;

  withoutBottomMargin(pdf, () => {
    const brandX = MARGIN + logo + 8;

    pdf.font(PDF_FONTS.bold).fontSize(NOTE_TYPE.brand).fillColor(NOTE_THEME.primary);
    pdf.text(appName, brandX, mid - pdf.currentLineHeight() / 2, {
      width: width - logo - 8,
      lineBreak: false,
    });

    pdf.font(PDF_FONTS.body).fontSize(NOTE_TYPE.meta).fillColor(NOTE_THEME.muted);
    pdf.text(exportedLabel(doc), MARGIN, mid - pdf.currentLineHeight() / 2, {
      width,
      align: 'right',
      lineBreak: false,
    });
  });

  const ruleY = MASTHEAD_TOP + logo + 9;

  pdf.save();
  pdf.rect(MARGIN, ruleY, width, 2).fill(NOTE_THEME.primary);
  pdf.rect(MARGIN, ruleY, 48, 2).fill(NOTE_THEME.accent);
  pdf.restore();

  // --- kicker and title -----------------------------------------------------
  pdf.y = ruleY + 26;
  pdf.x = MARGIN;

  pdf.font(PDF_FONTS.bold).fontSize(NOTE_TYPE.label).fillColor(NOTE_THEME.primary);
  pdf.text(kickerText(doc), MARGIN, pdf.y, { width, characterSpacing: 1, lineBreak: false });
  pdf.y += pdf.currentLineHeight() + 6;

  pdf.font(PDF_FONTS.bold).fontSize(NOTE_TYPE.title).fillColor(NOTE_THEME.ink);
  pdf.text(doc.title, MARGIN, pdf.y, { width, lineGap: 1 });

  pdf.y += 8;
  pdf.save();
  pdf.rect(MARGIN, pdf.y, 36, 3).fill(NOTE_THEME.accent);
  pdf.restore();
  pdf.y += 3 + 18;

  drawProvenanceCard(pdf, doc, width);

  pdf.y += 22;
  pdf.x = MARGIN;
}

/** The tinted two-column provenance card. Panel first, text after, heights measured. */
function drawProvenanceCard(pdf: Pdf, doc: NoteExportDocument, width: number): void {
  const entries = provenanceEntries(doc);

  if (entries.length === 0) return;

  const padX = 14;
  const padY = 11;
  const gapX = 18;
  const rowGap = 9;
  const innerLeft = MARGIN + BAR_WIDTH + padX;
  const columnWidth = (width - BAR_WIDTH - padX * 2 - gapX) / 2;

  // Measure every cell, then every row (two cells), before drawing anything.
  const cells = entries.map((entry) => {
    pdf.font(PDF_FONTS.bold).fontSize(NOTE_TYPE.label);
    const labelHeight = pdf.currentLineHeight();
    pdf.font(PDF_FONTS.body).fontSize(NOTE_TYPE.meta);
    const valueHeight = pdf.heightOfString(entry.value, { width: columnWidth });

    return { entry, labelHeight, valueHeight, height: labelHeight + 2 + valueHeight };
  });

  const rows: (typeof cells)[] = [];

  for (let index = 0; index < cells.length; index += 2) rows.push(cells.slice(index, index + 2));

  const rowHeights = rows.map((row) => Math.max(...row.map((cell) => cell.height)));
  const panelHeight =
    padY * 2 + rowHeights.reduce((sum, height) => sum + height, 0) + rowGap * (rows.length - 1);

  ensureRoom(pdf, panelHeight);

  const top = pdf.y;

  pdf.save();
  pdf.roundedRect(MARGIN, top, width, panelHeight, PANEL_RADIUS).fill(NOTE_THEME.primaryTint);
  // The bar sits inside the rounded clip so its outer corners follow the panel.
  pdf.roundedRect(MARGIN, top, width, panelHeight, PANEL_RADIUS).clip();
  pdf.rect(MARGIN, top, BAR_WIDTH, panelHeight).fill(NOTE_THEME.primary);
  pdf.restore();

  withoutBottomMargin(pdf, () => {
    let y = top + padY;

    rows.forEach((row, rowIndex) => {
      row.forEach((cell, column) => {
        const x = innerLeft + column * (columnWidth + gapX);

        pdf.font(PDF_FONTS.bold).fontSize(NOTE_TYPE.label).fillColor(NOTE_THEME.muted);
        pdf.text(cell.entry.label.toUpperCase(), x, y, {
          width: columnWidth,
          characterSpacing: 0.8,
          lineBreak: false,
        });

        pdf.font(PDF_FONTS.body).fontSize(NOTE_TYPE.meta).fillColor(NOTE_THEME.ink);
        pdf.text(cell.entry.value, x, y + cell.labelHeight + 2, {
          width: columnWidth,
          characterSpacing: 0,
        });
      });

      y += (rowHeights[rowIndex] ?? 0) + rowGap;
    });
  });

  pdf.y = top + panelHeight;
}

// =============================================================================
// The body
// =============================================================================

/** How a block's text is styled by the container it sits in. */
interface Ctx {
  /** Inside a list item: tighter spacing after paragraphs. */
  tight: boolean;
  /** Inside a blockquote: muted, oblique text. */
  quote: boolean;
  /** Muted text without the oblique (a finished task). */
  muted: boolean;
  /** List / quote nesting depth, 0-based. */
  depth: number;
}

const ROOT_CTX: Ctx = { tight: false, quote: false, muted: false, depth: 0 };

/**
 * Lay out a block list at one indent level.
 *
 * Recursive, because a list item holds blocks — a nested list, a paragraph
 * under a bullet, a fenced code sample inside a numbered step.
 */
export function drawBlocks(
  target: KvoxPdfDocument,
  blocks: readonly MdBlock[],
  left: number,
  width: number,
): void {
  drawBlockList(target as Pdf, blocks, left, Math.max(width, MIN_WIDTH), ROOT_CTX);
}

function drawBlockList(
  pdf: Pdf,
  blocks: readonly MdBlock[],
  left: number,
  width: number,
  ctx: Ctx,
): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        drawHeading(pdf, block.level, block.spans, left, width);
        break;

      case 'paragraph': {
        ensureRoom(pdf, lineHeightOf(pdf, NOTE_TYPE.body) * 2);
        drawRuns(pdf, runsOf(block.spans, bodyStyle(ctx)), {
          x: left,
          width,
          lineGap: bodyLineGap(),
        });
        pdf.y += ctx.tight ? NOTE_SPACING.listItemAfter : NOTE_SPACING.paragraphAfter;
        break;
      }

      case 'list':
        drawList(pdf, block, left, width, ctx);
        break;

      case 'quote':
        drawQuote(pdf, block.blocks, left, width, ctx);
        break;

      case 'code':
        drawCode(pdf, block.text, block.language, left, width);
        pdf.y += NOTE_SPACING.blockAfter;
        break;

      case 'table':
        drawTable(pdf, block, left, width);
        pdf.y += NOTE_SPACING.blockAfter;
        break;

      case 'rule': {
        ensureRoom(pdf, 24);
        pdf.y += 8;
        pdf.save();
        pdf.lineWidth(0.75).strokeColor(NOTE_THEME.divider);
        pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).stroke();
        pdf.restore();
        pdf.y += 14;
        break;
      }
    }

    pdf.x = left;
  }
}

function drawHeading(
  pdf: Pdf,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  spans: readonly MdSpan[],
  left: number,
  width: number,
): void {
  const size = NOTE_TYPE[`h${level}` as 'h1'];
  const before = NOTE_SPACING.headingBefore[level];
  const after = NOTE_SPACING.headingAfter;

  // Keep the heading with what follows: room for it plus about two body lines.
  ensureRoom(pdf, before + lineHeightOf(pdf, size) + after + lineHeightOf(pdf, NOTE_TYPE.body) * 2);

  if (pdf.y > pageTop(pdf) + 1) pdf.y += before;

  drawRuns(
    pdf,
    runsOf(spans, { size, bold: true, color: headingColor(level) }),
    { x: left, width, lineGap: 0 },
  );

  if (headingRule(level)) {
    pdf.y += 3;
    pdf.save();
    pdf.lineWidth(0.75).strokeColor(NOTE_THEME.divider);
    pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).stroke();
    pdf.restore();
  }

  pdf.y += after;
}

// --- lists --------------------------------------------------------------------

function drawList(
  pdf: Pdf,
  block: Extract<MdBlock, { type: 'list' }>,
  left: number,
  width: number,
  ctx: Ctx,
): void {
  let ordinal = block.start;

  block.items.forEach((item, index) => {
    const task = block.tasks?.[index] ?? null;
    const lineHeight = lineHeightOf(pdf, NOTE_TYPE.body);

    ensureRoom(pdf, lineHeight * 2);

    const y = pdf.y;
    const startPage = pageIndex(pdf);

    // ⚠ THE MARKER IS DRAWN WITHOUT ADVANCING `pdf.y`, then the item's own
    // blocks are laid out in the column beside it. That is what makes a wrapped
    // list item align under its own first word rather than under the marker.
    if (task !== null) {
      drawCheckbox(pdf, left + NOTE_SPACING.markerWidth - CHECKBOX - 1, y + (lineHeight - CHECKBOX) / 2, task);
    } else {
      if (block.ordered) {
        const marker = orderedMarker(ordinal, ctx.depth);

        withoutBottomMargin(pdf, () => {
          pdf.font(PDF_FONTS.bold).fontSize(NOTE_TYPE.body).fillColor(NOTE_THEME.primary);
          pdf.text(marker, left, y, {
            width: NOTE_SPACING.markerWidth,
            align: 'right',
            lineBreak: false,
            characterSpacing: 0,
          });
        });
      } else {
        drawBullet(pdf, bulletGlyph(ctx.depth), left + NOTE_SPACING.markerWidth - 3.5, y + lineHeight / 2);
      }
    }

    pdf.y = y;

    const inner: Ctx = {
      tight: true,
      quote: ctx.quote,
      muted: ctx.muted || task === true,
      depth: ctx.depth + 1,
    };
    const content = left + NOTE_SPACING.listIndent;

    drawBlockList(pdf, item, content, Math.max(width - NOTE_SPACING.listIndent, MIN_WIDTH), inner);

    // An item with no blocks (empty bullet) still occupies a line.
    if (pageIndex(pdf) === startPage && pdf.y < y + lineHeight) pdf.y = y + lineHeight;

    pdf.y += NOTE_SPACING.listItemAfter;
    ordinal += 1;
  });

  if (ctx.depth === 0) pdf.y += NOTE_SPACING.blockAfter - NOTE_SPACING.listItemAfter;
}

/**
 * A bullet as a vector shape. The Noto faces lack some of `bulletGlyph`'s
 * characters (`◦ ▪ ▫`), so the glyph only chooses the shape: filled or hollow,
 * round or square. `cx`/`cy` is the centre.
 */
function drawBullet(pdf: Pdf, glyph: string, cx: number, cy: number): void {
  const hollow = glyph === '◦' || glyph === '▫';
  const square = glyph === '▪' || glyph === '▫';
  const r = square ? 1.7 : 2;

  pdf.save();
  pdf.lineWidth(0.9);

  if (square) pdf.rect(cx - r, cy - r, r * 2, r * 2);
  else pdf.circle(cx, cy, r);

  if (hollow) pdf.stroke(NOTE_THEME.primary);
  else pdf.fill(NOTE_THEME.primary);

  pdf.restore();
}

function drawCheckbox(pdf: Pdf, x: number, y: number, done: boolean): void {
  pdf.save();

  if (done) {
    pdf.roundedRect(x, y, CHECKBOX, CHECKBOX, 2).fill(NOTE_THEME.primary);
    pdf
      .lineWidth(1.3)
      .lineCap('round')
      .lineJoin('round')
      .strokeColor(NOTE_THEME.onPrimary)
      .moveTo(x + CHECKBOX * 0.24, y + CHECKBOX * 0.54)
      .lineTo(x + CHECKBOX * 0.43, y + CHECKBOX * 0.74)
      .lineTo(x + CHECKBOX * 0.78, y + CHECKBOX * 0.28)
      .stroke();
  } else {
    pdf
      .lineWidth(1)
      .roundedRect(x + 0.5, y + 0.5, CHECKBOX - 1, CHECKBOX - 1, 2)
      .fillAndStroke(NOTE_THEME.paper, NOTE_THEME.faint);
  }

  pdf.restore();
}

// --- blockquote ---------------------------------------------------------------

function drawQuote(
  pdf: Pdf,
  blocks: readonly MdBlock[],
  left: number,
  width: number,
  ctx: Ctx,
): void {
  ensureRoom(pdf, lineHeightOf(pdf, NOTE_TYPE.body) * 2);

  const startPage = pageIndex(pdf);
  const startY = pdf.y;

  drawBlockList(
    pdf,
    blocks,
    left + NOTE_SPACING.quoteIndent,
    Math.max(width - NOTE_SPACING.quoteIndent, MIN_WIDTH),
    { tight: ctx.tight, quote: true, muted: false, depth: ctx.depth + 1 },
  );

  const endPage = pageIndex(pdf);
  const endY = Math.max(startY, pdf.y - NOTE_SPACING.paragraphAfter);
  const barX = left + 1;
  const cursor = { x: pdf.x, y: pdf.y };

  // The bar follows the quote across pages: one segment per page it touches.
  for (let page = startPage; page <= endPage; page += 1) {
    pdf.switchToPage(page);

    const top = page === startPage ? startY : pageTop(pdf);
    const bottom = page === endPage ? endY : pdf.page.height - pdf.page.margins.bottom;

    if (bottom > top) {
      pdf.save();
      pdf.rect(barX, top, BAR_WIDTH, bottom - top).fill(NOTE_THEME.primary);
      pdf.restore();
    }
  }

  pdf.switchToPage(endPage);
  pdf.x = cursor.x;
  pdf.y = cursor.y + (ctx.depth === 0 ? NOTE_SPACING.blockAfter - NOTE_SPACING.paragraphAfter : 0);
}

// --- code ---------------------------------------------------------------------

function drawCode(
  pdf: Pdf,
  text: string,
  language: string | null,
  left: number,
  width: number,
): void {
  const pad = NOTE_SPACING.codePad;
  const size = NOTE_TYPE.code;
  const lineHeight = size * 1.5;
  const textWidth = Math.max(width - pad * 2, MIN_WIDTH);

  // Hard-wrap each source line to the panel (the face is monospaced, so a
  // character count is exact; a wide glyph merely runs a little long).
  pdf.font(PDF_FONTS.mono).fontSize(size);
  const advance = pdf.widthOfString('M') || size * 0.6;
  const perLine = Math.max(1, Math.floor(textWidth / advance));

  const lines: string[] = [];

  for (const source of (text.length > 0 ? text : ' ').split('\n')) {
    if (source.length <= perLine) {
      lines.push(source);
      continue;
    }

    for (let at = 0; at < source.length; at += perLine) lines.push(source.slice(at, at + perLine));
  }

  const label = codeLanguageLabel(language);
  let index = 0;
  let first = true;

  while (index < lines.length) {
    const wanted = Math.min(3, lines.length - index);

    ensureRoom(pdf, pad * 2 + lineHeight * wanted);

    const room = pageBottom(pdf) - pdf.y - pad * 2;
    // Always draw at least one line so a pathological page cannot loop.
    const fit = Math.max(1, Math.min(lines.length - index, Math.floor(room / lineHeight)));
    const panelHeight = pad * 2 + fit * lineHeight;
    const top = pdf.y;

    pdf.save();
    pdf.lineWidth(0.75);
    pdf
      .roundedRect(left + 0.375, top + 0.375, width - 0.75, panelHeight - 0.75, PANEL_RADIUS)
      .fillAndStroke(NOTE_THEME.surface, NOTE_THEME.divider);
    pdf.restore();

    withoutBottomMargin(pdf, () => {
      pdf.font(PDF_FONTS.mono).fontSize(size).fillColor(NOTE_THEME.ink);

      for (let line = 0; line < fit; line += 1) {
        const value = lines[index + line] ?? '';

        if (value.length > 0) {
          pdf.text(value, left + pad, top + pad + line * lineHeight + (lineHeight - size) / 2 - 1, {
            lineBreak: false,
            characterSpacing: 0,
          });
        }
      }

      if (first && label) {
        pdf.font(PDF_FONTS.bold).fontSize(NOTE_TYPE.label).fillColor(NOTE_THEME.faint);
        pdf.text(label, left, top + 5, {
          width: width - 8,
          align: 'right',
          lineBreak: false,
          characterSpacing: 0.8,
        });
      }
    });

    pdf.y = top + panelHeight;
    index += fit;
    first = false;

    if (index < lines.length) pdf.addPage();
  }
}

// --- tables -------------------------------------------------------------------

interface TableChunk {
  /** Body-row indexes drawn on this page. */
  rows: number[];
  /** Whether this chunk carries the header (always true; the header repeats). */
  height: number;
}

function drawTable(
  pdf: Pdf,
  table: Extract<MdBlock, { type: 'table' }>,
  left: number,
  width: number,
): void {
  const weights = tableColumnWeights(table);
  const columns = weights.length;

  if (columns === 0) return;

  const widths = weights.map((weight) => weight * width);
  // A very wide table shrinks its type and padding rather than breaking every word.
  const size = columns > 12 ? 6.5 : columns > 8 ? 8 : NOTE_TYPE.table;
  const padX = columns > 8 ? 2.5 : NOTE_SPACING.tableCellPadX;
  const padY = NOTE_SPACING.tableCellPadY;
  const aligns = widths.map((_, c) => tableAlignment(table.align[c] ?? null));
  const gap = bodyLineGap(size);

  const cellRuns = (spans: readonly MdSpan[] | undefined, header: boolean): Run[] =>
    runsOf(spans ?? [], {
      size,
      bold: header,
      color: header ? NOTE_THEME.onPrimary : NOTE_THEME.ink,
    });

  const measureRow = (cells: readonly (readonly MdSpan[] | undefined)[], header: boolean): number => {
    let tallest = 0;

    for (let c = 0; c < columns; c += 1) {
      const runs = cellRuns(cells[c], header);
      const text = runs.map((run) => run.text).join('');

      pdf
        .font(header || runs.some((run) => run.font === PDF_FONTS.bold) ? PDF_FONTS.bold : PDF_FONTS.body)
        .fontSize(size);

      const height = text.length > 0
        ? pdf.heightOfString(text, { width: Math.max(widths[c]! - padX * 2, 8), lineGap: gap }) + 0.5
        : 0;

      tallest = Math.max(tallest, height);
    }

    return Math.max(tallest, lineHeightOf(pdf, size)) + padY * 2;
  };

  const headerHeight = measureRow(table.header, true);
  const rowHeights = table.rows.map((row) => measureRow(row, false));

  // --- plan the pages before drawing anything -------------------------------
  ensureRoom(pdf, headerHeight + (rowHeights[0] ?? 0));

  const chunks: TableChunk[] = [];
  let current: TableChunk = { rows: [], height: headerHeight };
  let y = pdf.y + headerHeight;

  rowHeights.forEach((height, rowIndex) => {
    if (y + height > pageBottom(pdf) && current.rows.length > 0) {
      chunks.push(current);
      current = { rows: [], height: headerHeight };
      y = pageTop(pdf) + headerHeight;
    }

    current.rows.push(rowIndex);
    current.height += height;
    y += height;
  });

  chunks.push(current);

  // --- draw ------------------------------------------------------------------
  chunks.forEach((chunk, chunkIndex) => {
    if (chunkIndex > 0) pdf.addPage();

    const top = pdf.y;

    withoutBottomMargin(pdf, () => {
      pdf.save();
      pdf.roundedRect(left, top, width, chunk.height, TABLE_RADIUS).clip();

      const drawRow = (
        cells: readonly (readonly MdSpan[] | undefined)[],
        rowTop: number,
        height: number,
        fill: string,
        header: boolean,
      ): void => {
        let x = left;

        for (let c = 0; c < columns; c += 1) {
          const cellWidth = widths[c]!;

          pdf.rect(x, rowTop, cellWidth, height).fill(fill);

          const runs = cellRuns(cells[c], header);

          if (runs.some((run) => run.text.length > 0)) {
            drawRuns(pdf, runs, {
              x: x + padX,
              y: rowTop + padY,
              width: Math.max(cellWidth - padX * 2, 8),
              align: aligns[c],
              lineGap: gap,
            });
          }

          x += cellWidth;
        }
      };

      let rowTop = top;

      drawRow(table.header, rowTop, headerHeight, NOTE_THEME.primary, true);
      rowTop += headerHeight;

      chunk.rows.forEach((rowIndex, position) => {
        const height = rowHeights[rowIndex]!;

        drawRow(
          table.rows[rowIndex] ?? [],
          rowTop,
          height,
          position % 2 === 0 ? NOTE_THEME.paper : NOTE_THEME.surface,
          false,
        );
        rowTop += height;
      });

      // Grid lines, inside the clip so the outer corners stay round.
      pdf.lineWidth(0.5).strokeColor(NOTE_THEME.divider);

      let lineY = top + headerHeight;

      for (const rowIndex of chunk.rows) {
        pdf.moveTo(left, lineY).lineTo(left + width, lineY).stroke();
        lineY += rowHeights[rowIndex]!;
      }

      let lineX = left;

      for (let c = 0; c < columns - 1; c += 1) {
        lineX += widths[c]!;
        pdf.moveTo(lineX, top + headerHeight).lineTo(lineX, top + chunk.height).stroke();
      }

      pdf.restore();

      // The outer border, over the clipped content.
      pdf.save();
      pdf.lineWidth(0.5);
      pdf
        .roundedRect(left, top, width, chunk.height, TABLE_RADIUS)
        .stroke(NOTE_THEME.divider);
      pdf.restore();
    });

    pdf.y = top + chunk.height;
  });
}

// =============================================================================
// Inline text
// =============================================================================

/** One styled piece of text, ready for pdfkit. */
interface Run {
  text: string;
  font: string;
  size: number;
  color: string;
  oblique: boolean;
  underline: boolean;
  strike: boolean;
  link?: string;
}

interface BaseStyle {
  size: number;
  bold?: boolean;
  color: string;
  italic?: boolean;
}

function bodyStyle(ctx: Ctx): BaseStyle {
  return {
    size: NOTE_TYPE.body,
    color: ctx.quote || ctx.muted ? NOTE_THEME.muted : NOTE_THEME.ink,
    italic: ctx.quote,
  };
}

/** Spans to runs: marks to fonts and colours. Empty runs are dropped. */
function runsOf(spans: readonly MdSpan[], base: BaseStyle): Run[] {
  const runs: Run[] = [];

  for (const span of spans) {
    if (span.image) {
      runs.push({
        text: '[image] ',
        font: PDF_FONTS.body,
        size: base.size,
        color: NOTE_THEME.muted,
        oblique: false,
        underline: false,
        strike: false,
      });
    }

    if (span.text.length === 0) continue;

    const code = span.code === true;
    const linked = span.href !== undefined;
    const run: Run = {
      text: span.text,
      font: code ? PDF_FONTS.mono : span.bold === true || base.bold === true ? PDF_FONTS.bold : PDF_FONTS.body,
      size: code ? base.size - 0.75 : base.size,
      color: linked ? NOTE_THEME.link : code ? NOTE_THEME.primaryDark : base.color,
      oblique: !code && (span.italic === true || base.italic === true),
      underline: linked,
      strike: span.strike === true,
    };

    if (span.href) run.link = span.href;

    runs.push(run);
  }

  return runs;
}

/**
 * Draw one run list as continuous, wrapped text.
 *
 * `continued: true` on every run but the last keeps bold, italic and code inline
 * with the surrounding sentence. EVERY option is passed on EVERY run because
 * pdfkit would otherwise carry `link`/`underline`/`strike`/`oblique` from the
 * previous run, and the last run is always `continued: false`.
 */
function drawRuns(
  pdf: Pdf,
  runs: readonly Run[],
  box: { x: number; y?: number; width: number; align?: 'left' | 'center' | 'right'; lineGap: number },
): void {
  const y = box.y ?? pdf.y;

  if (runs.length === 0) {
    pdf.y = y;

    return;
  }

  runs.forEach((run, index) => {
    const options = {
      width: box.width,
      align: box.align ?? 'left',
      lineGap: box.lineGap,
      continued: index < runs.length - 1,
      oblique: run.oblique,
      underline: run.underline,
      strike: run.strike,
      link: run.link ?? null,
      characterSpacing: 0,
    } as PDFKit.Mixins.TextOptions;

    pdf.font(run.font).fontSize(run.size).fillColor(run.color);

    if (index === 0) pdf.text(run.text, box.x, y, options);
    else pdf.text(run.text, options);
  });

  pdf.x = box.x;
}

/** Extra leading between lines, derived from the shared line-height multiple. */
function bodyLineGap(size: number = NOTE_TYPE.body): number {
  // The Noto faces already carry about 1.36 of built-in leading.
  return Math.max(0, size * (NOTE_SPACING.lineHeight - 1) * 0.35);
}

// =============================================================================
// Running header and footer, stamped onto every buffered page
// =============================================================================

/**
 * The running header (pages 2+) and the footer, stamped onto every buffered page.
 *
 * Page 1 gets no running header: its masthead and title are already there.
 */
export function decoratePages(
  target: KvoxPdfDocument,
  doc: NoteExportDocument,
  pageNumbers: boolean,
  appName: string = DEFAULT_KVOX_BRAND.appName,
): void {
  const pdf = target as Pdf;
  const range = pdf.bufferedPageRange();
  const total = range.count;

  for (let index = 0; index < total; index += 1) {
    pdf.switchToPage(range.start + index);

    const bottom = pdf.page.margins.bottom;
    const top = pdf.page.margins.top;

    // See the header comment: drawing outside the margins re-enters pagination.
    pdf.page.margins.bottom = 0;
    pdf.page.margins.top = 0;

    const width = pdf.page.width - MARGIN * 2;

    if (index > 0) {
      drawBrandMark(pdf, MARGIN, HEADER_TOP, HEADER_MARK);

      const mid = HEADER_TOP + HEADER_MARK / 2;
      const nameX = MARGIN + HEADER_MARK + 5;

      pdf.font(PDF_FONTS.bold).fontSize(NOTE_TYPE.header).fillColor(NOTE_THEME.primary);
      const nameWidth = pdf.widthOfString(appName);
      pdf.text(appName, nameX, mid - pdf.currentLineHeight() / 2, {
        lineBreak: false,
        characterSpacing: 0,
      });

      const titleX = nameX + nameWidth + 16;

      pdf.font(PDF_FONTS.body).fontSize(NOTE_TYPE.header).fillColor(NOTE_THEME.muted);
      pdf.text(
        fitText(pdf, doc.title, MARGIN + width - titleX),
        titleX,
        mid - pdf.currentLineHeight() / 2,
        { width: MARGIN + width - titleX, align: 'right', lineBreak: false, characterSpacing: 0 },
      );

      pdf.save();
      pdf.lineWidth(0.5).strokeColor(NOTE_THEME.divider);
      pdf.moveTo(MARGIN, HEADER_RULE_Y).lineTo(MARGIN + width, HEADER_RULE_Y).stroke();
      pdf.restore();
    }

    if (pageNumbers) {
      const height = pdf.page.height;

      pdf.save();
      pdf.lineWidth(0.5).strokeColor(NOTE_THEME.divider);
      pdf
        .moveTo(MARGIN, height - FOOTER_RULE_OFFSET)
        .lineTo(MARGIN + width, height - FOOTER_RULE_OFFSET)
        .stroke();
      pdf.restore();

      pdf.font(PDF_FONTS.body).fontSize(NOTE_TYPE.footer).fillColor(NOTE_THEME.muted);
      pdf.text(
        noteFooterText(index + 1, total, doc.version, appName),
        MARGIN,
        height - FOOTER_TEXT_OFFSET,
        { width, align: 'center', lineBreak: false, characterSpacing: 0 },
      );
    }

    pdf.page.margins.bottom = bottom;
    pdf.page.margins.top = top;
  }

  pdf.flushPages();
}

export { noteFooterText };

/** `value` shortened with an ellipsis until it fits `maxWidth` in the current font. */
function fitText(pdf: Pdf, value: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (pdf.widthOfString(value) <= maxWidth) return value;

  let end = value.length;

  while (end > 1 && pdf.widthOfString(`${value.slice(0, end).trimEnd()}…`) > maxWidth) end -= 1;

  return `${value.slice(0, end).trimEnd()}…`;
}

// =============================================================================
// Geometry helpers
// =============================================================================

/** The lowest y content may reach on this page. */
function pageBottom(pdf: Pdf): number {
  return pdf.page.height - pdf.page.margins.bottom;
}

/** The first y content may use on this page. */
function pageTop(pdf: Pdf): number {
  return pdf.page.margins.top;
}

/** Index of the page the cursor is on. */
function pageIndex(pdf: Pdf): number {
  const range = pdf.bufferedPageRange();

  return range.start + range.count - 1;
}

/** Start a new page when there is not enough room left for `needed` points. */
function ensureRoom(pdf: Pdf, needed: number): void {
  if (pdf.y + needed > pageBottom(pdf) && pdf.y > pageTop(pdf) + 1) {
    pdf.addPage();
  }
}

/** One line of the body face at `size`, in points. */
function lineHeightOf(pdf: Pdf, size: number): number {
  pdf.font(PDF_FONTS.body).fontSize(size);

  return pdf.currentLineHeight();
}

/** Usable width between the margins. */
function contentWidth(pdf: Pdf): number {
  return pdf.page.width - MARGIN * 2;
}

/**
 * Run `draw` with the bottom margin at zero, so text whose height was measured
 * up front can never start a page of its own on a rounding difference.
 */
function withoutBottomMargin(pdf: Pdf, draw: () => void): void {
  const { margins } = pdf.page;
  const bottom = margins.bottom;

  margins.bottom = 0;

  try {
    draw();
  } finally {
    margins.bottom = bottom;
  }
}
