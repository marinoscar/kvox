// =============================================================================
// The PDF note export (issue #54, docs/specs/notes.md §8.3)
// =============================================================================
//
// pdfkit, streamed, with the SAME three Noto faces transcript export bundles
// (`apps/api/src/export/pdf-fonts.ts`) — §8.3 names the fonts and the streaming
// `render(doc, options, out)` contract as the two pieces of infrastructure
// genuinely shared between transcript and note PDFs, and this file uses both.
// Not a headless browser (300 MB+ in the image, a sandbox, and a lot of memory
// per render) and not `pdfmake` (builds the whole document in memory).
//
// -----------------------------------------------------------------------------
// "INTENTIONALLY PRODUCED RATHER THAN SIMPLY PRINTED FROM A BROWSER"
// -----------------------------------------------------------------------------
//
// VISION.md's phrase, and issue #54 quotes it as the requirement rather than as
// an aspiration. Concretely, in this file: a title block with the note's name
// set at 22pt over a ruled provenance table; generous A4 margins; a running
// header carrying the note title from page two onward; page numbers in a
// footer that also names the version, so a printed page found on its own can
// still be traced back; real heading hierarchy at four distinct sizes rather
// than bold paragraphs; hanging indents on list items so wrapped text aligns
// under its own first word rather than under the bullet; and code set in the
// bundled mono face on a tinted panel.
//
// What it deliberately is NOT: an HTML dump. Nothing here renders markup — the
// body arrives as the block AST `markdown-ast.ts` parsed, and this file decides
// typography for each block kind.
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
// ⚠ THE MARGINS ARE ZEROED WHILE THE FOOTER IS DRAWN, and restored
// immediately. Writing at `page.height - FOOTER_BASELINE` is BELOW the bottom
// margin, and pdfkit responds to text below the margin by adding a new page —
// which, inside the loop that decorates every page, appends one page per page,
// forever. The zeroing is not a style choice; it is what stops that. The same
// trap `transcripts/export/pdf.exporter.ts` documents, and it is the same trap
// here because it is a property of pdfkit, not of transcripts.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Writable } from 'node:stream';
import PDFDocument from 'pdfkit';
import { APP_NAME } from '@app/shared';

import {
  optionsSchemaFor,
  type ExportOptionField,
  type ExportOptions,
} from '../../export/export-options';
import { PDF_FONTS, assertFontsPresent, registerExportFonts } from '../../export/pdf-fonts';
import { parseMarkdown, type MdBlock, type MdSpan } from './markdown-ast';
import {
  provenanceEntries,
  type NoteExportDocument,
} from './note-export-document';
import { NoteExporterRegistry, type NoteExporter } from './note-exporter.registry';

/** Page geometry, in PDF points (72 per inch). */
const MARGIN = 64;
/** Extra space at the top of every page for the running header. */
const HEADER_SPACE = 22;
/** Distance from the bottom edge to the footer's baseline. */
const FOOTER_BASELINE = 34;
/** A block needs at least this much room, or it starts on the next page. */
const MIN_BLOCK_ROOM = 48;
/** Indent one list level costs. */
const LIST_INDENT = 18;
/** Width reserved for a bullet or a number. */
const MARKER_WIDTH = 16;

const INK = '#111111';
const MUTED = '#666666';
const RULE = '#dddddd';
const PANEL = '#f4f4f5';
const LINK = '#1a4f8a';

/** Point size per heading level. Four distinct steps, then a floor. */
const HEADING_SIZE: Record<number, number> = { 1: 17, 2: 14, 3: 12, 4: 11, 5: 10.5, 6: 10.5 };

const BODY_SIZE = 10.5;

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

@Injectable()
export class PdfNoteExporter implements NoteExporter, OnModuleInit {
  private readonly logger = new Logger(PdfNoteExporter.name);

  readonly format = 'pdf';
  readonly label = 'PDF';
  readonly mimeType = 'application/pdf';
  readonly extension = 'pdf';
  readonly options = PDF_NOTE_EXPORT_OPTIONS;
  readonly optionsSchema = optionsSchemaFor(PDF_NOTE_EXPORT_OPTIONS);

  constructor(private readonly registry: NoteExporterRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async render(doc: NoteExportDocument, options: ExportOptions, out: Writable): Promise<void> {
    let finished: Promise<void>;

    // ⚠ EVERYTHING THAT CAN THROW IS INSIDE THE `try`, INCLUDING THE MISSING
    // FONTS CHECK AND THE `PDFDocument` CONSTRUCTOR. A throw before `out` was
    // destroyed leaves the destination open forever: `NoteObjectsService
    // .putStream`'s upload is waiting for an `end` that is never coming, and
    // its `done` promise never settles, so the job's own `Promise.all` rejects
    // while an upload hangs behind it. Destroying `out` on every failure path
    // is what turns that into a clean, observed failure.
    try {
      assertFontsPresent();

      const pdf = new PDFDocument({
        size: 'A4',
        bufferPages: true,
        autoFirstPage: true,
        margins: { top: MARGIN + HEADER_SPACE, bottom: MARGIN, left: MARGIN, right: MARGIN },
        info: {
          Title: doc.title,
          Author: doc.author?.displayName ?? APP_NAME,
          Creator: APP_NAME,
          Producer: APP_NAME,
          CreationDate: doc.exportedAt,
        },
      });

      registerExportFonts(pdf);

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

      drawTitleBlock(pdf, doc);
      drawBlocks(pdf, parseMarkdown(doc.body), MARGIN, contentWidth(pdf));
      decoratePages(pdf, doc, options.includePageNumbers !== false);
      pdf.end();
    } catch (error) {
      out.destroy(error instanceof Error ? error : new Error(String(error)));

      throw error;
    }

    await finished;

    this.logger.debug(`Rendered note ${doc.noteId} v${doc.version} to PDF`);
  }
}

/** The document pdfkit hands back. Narrowed so helpers stay readable. */
type Pdf = InstanceType<typeof PDFDocument>;

/** The note's name, then the provenance table, then a rule. */
export function drawTitleBlock(pdf: Pdf, doc: NoteExportDocument): void {
  const width = contentWidth(pdf);

  pdf.font(PDF_FONTS.bold).fontSize(22).fillColor(INK).text(doc.title, { width });
  pdf.moveDown(0.7);

  // A two-column table rather than a run-on line: a reader scanning for "which
  // recording was this?" finds the labels in a fixed place on every export.
  const labelWidth = 96;

  for (const entry of provenanceEntries(doc)) {
    const y = pdf.y;

    pdf
      .font(PDF_FONTS.bold)
      .fontSize(9)
      .fillColor(MUTED)
      .text(entry.label, MARGIN, y, { width: labelWidth, lineBreak: false });

    pdf
      .font(PDF_FONTS.body)
      .fontSize(9)
      .fillColor(INK)
      .text(entry.value, MARGIN + labelWidth, y, { width: width - labelWidth });

    pdf.y = Math.max(pdf.y, y + 13);
  }

  pdf.moveDown(0.8);
  rule(pdf, pdf.y);
  pdf.y += 18;
  pdf.x = MARGIN;
}

/**
 * Lay out a block list at one indent level.
 *
 * Recursive, because a list item holds blocks — a nested list, a paragraph
 * under a bullet, a fenced code sample inside a numbered step.
 */
export function drawBlocks(pdf: Pdf, blocks: readonly MdBlock[], left: number, width: number): void {
  for (const block of blocks) {
    ensureRoom(pdf);

    switch (block.type) {
      case 'heading': {
        pdf.moveDown(block.level <= 2 ? 0.6 : 0.4);
        drawSpans(pdf, block.spans, {
          left,
          width,
          size: HEADING_SIZE[block.level] ?? BODY_SIZE,
          font: PDF_FONTS.bold,
          color: INK,
        });
        pdf.moveDown(0.25);
        break;
      }

      case 'paragraph': {
        drawSpans(pdf, block.spans, { left, width, size: BODY_SIZE, color: INK });
        pdf.moveDown(0.5);
        break;
      }

      case 'list': {
        let ordinal = block.start;

        for (const item of block.items) {
          ensureRoom(pdf);

          const y = pdf.y;

          pdf
            .font(block.ordered ? PDF_FONTS.body : PDF_FONTS.bold)
            .fontSize(BODY_SIZE)
            .fillColor(MUTED)
            .text(block.ordered ? `${ordinal}.` : '•', left, y, {
              width: MARKER_WIDTH,
              lineBreak: false,
            });

          // ⚠ THE MARKER IS DRAWN WITHOUT ADVANCING `pdf.y`, then the item's
          // own blocks are laid out in the column beside it. That is what makes
          // a wrapped list item align under its own first word rather than
          // under the bullet — the hanging indent VISION.md's "intentionally
          // produced" line is actually about.
          pdf.y = y;
          drawBlocks(pdf, item, left + MARKER_WIDTH, width - MARKER_WIDTH);
          pdf.y = Math.max(pdf.y, y + 12);

          ordinal += 1;
        }

        pdf.moveDown(0.3);
        break;
      }

      case 'quote': {
        const top = pdf.y;

        drawBlocks(pdf, block.blocks, left + LIST_INDENT, width - LIST_INDENT);

        pdf
          .save()
          .lineWidth(2)
          .strokeColor(RULE)
          .moveTo(left + 3, top)
          .lineTo(left + 3, pdf.y - 4)
          .stroke()
          .restore();

        pdf.moveDown(0.3);
        break;
      }

      case 'code': {
        const text = block.text.length > 0 ? block.text : ' ';
        const height =
          pdf.font(PDF_FONTS.mono).fontSize(9).heightOfString(text, { width: width - 16 }) + 14;

        ensureRoom(pdf, height);

        pdf.save().fillColor(PANEL).rect(left, pdf.y, width, height).fill().restore();

        pdf
          .font(PDF_FONTS.mono)
          .fontSize(9)
          .fillColor(INK)
          .text(text, left + 8, pdf.y + 7, { width: width - 16 });

        pdf.moveDown(0.6);
        break;
      }

      case 'rule': {
        pdf.moveDown(0.4);
        rule(pdf, pdf.y, left, width);
        pdf.y += 10;
        break;
      }
    }

    pdf.x = left;
  }
}

/**
 * Draw one run of spans as continuous text, honouring each span's marks.
 *
 * `continued: true` on every span but the last is what keeps bold, italic and
 * code inline with the surrounding sentence instead of each starting its own
 * paragraph. pdfkit carries the wrap position across a continued run, so a
 * bolded phrase that lands at a line break still breaks correctly.
 */
function drawSpans(
  pdf: Pdf,
  spans: readonly MdSpan[],
  style: { left: number; width: number; size: number; font?: string; color?: string },
): void {
  if (spans.length === 0) {
    pdf.moveDown(0.4);

    return;
  }

  pdf.x = style.left;

  spans.forEach((span, index) => {
    const last = index === spans.length - 1;
    const bold = span.bold === true || style.font === PDF_FONTS.bold;

    pdf
      .font(span.code === true ? PDF_FONTS.mono : bold ? PDF_FONTS.bold : PDF_FONTS.body)
      .fontSize(span.code === true ? style.size - 0.5 : style.size)
      .fillColor(span.href ? LINK : (style.color ?? INK));

    const options: PDFKit.Mixins.TextOptions = {
      width: style.width,
      continued: !last,
      oblique: span.italic === true && span.code !== true,
      underline: span.href !== undefined,
      strike: span.strike === true,
    };

    if (span.href) options.link = span.href;

    pdf.text(span.text, options);
  });

  // pdfkit leaves `link`/`underline` armed on the document after a continued
  // run; clearing them explicitly stops the NEXT block inheriting a hyperlink
  // nobody wrote.
  pdf.fillColor(INK);
}

/**
 * The running header and the footer, stamped onto every buffered page.
 *
 * Page 1 gets no header: the title is already there at 22pt, and repeating it
 * 8pt above itself looks like a mistake.
 */
export function decoratePages(pdf: Pdf, doc: NoteExportDocument, pageNumbers: boolean): void {
  const range = pdf.bufferedPageRange();
  const total = range.count;

  for (let index = 0; index < total; index += 1) {
    pdf.switchToPage(range.start + index);

    const bottom = pdf.page.margins.bottom;
    const top = pdf.page.margins.top;

    // See the header: drawing outside the margins re-enters pagination.
    pdf.page.margins.bottom = 0;
    pdf.page.margins.top = 0;

    const width = pdf.page.width - MARGIN * 2;

    if (index > 0) {
      pdf
        .font(PDF_FONTS.body)
        .fontSize(8)
        .fillColor(MUTED)
        .text(doc.title, MARGIN, MARGIN - 4, { width, align: 'left', lineBreak: false });

      rule(pdf, MARGIN + 10);
    }

    if (pageNumbers) {
      pdf
        .font(PDF_FONTS.body)
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          noteFooterText(index + 1, total, doc.version),
          MARGIN,
          pdf.page.height - FOOTER_BASELINE,
          { width, align: 'center', lineBreak: false },
        );
    }

    pdf.page.margins.bottom = bottom;
    pdf.page.margins.top = top;
  }

  pdf.flushPages();
}

/**
 * The footer line.
 *
 * ⚠ `APP_NAME` FROM `@app/shared`, NEVER A LITERAL. The product name is one
 * field in `packages/shared/identity.json` and a fork renames it there;
 * `apps/cli/src/template-identity.test.ts` scans this tree for hardcoded
 * product names and fails the build on one, which is exactly the guard that
 * keeps a rebranded fork from shipping PDFs footed with somebody else's name.
 *
 * A pure function so the string can be asserted without rendering a PDF and
 * then trying to read glyph-encoded text back out of it.
 */
export function noteFooterText(page: number, total: number, version: number): string {
  return `Page ${page} of ${total} · Version ${version} · Exported from ${APP_NAME}`;
}

/** Start a new page when there is not enough room left for a whole block. */
function ensureRoom(pdf: Pdf, needed = MIN_BLOCK_ROOM): void {
  if (pdf.y + needed > pdf.page.height - pdf.page.margins.bottom) {
    pdf.addPage();
  }
}

/** Usable width between the margins. */
function contentWidth(pdf: Pdf): number {
  return pdf.page.width - MARGIN * 2;
}

/** A hairline at `y`. */
function rule(pdf: Pdf, y: number, left = MARGIN, width?: number): void {
  pdf
    .save()
    .lineWidth(0.5)
    .strokeColor(RULE)
    .moveTo(left, y)
    .lineTo(left + (width ?? pdf.page.width - MARGIN * 2), y)
    .stroke()
    .restore();
}
