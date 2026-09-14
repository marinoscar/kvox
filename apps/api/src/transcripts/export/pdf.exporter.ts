// =============================================================================
// The PDF export (issue #28, epic #19, spec §8.4)
// =============================================================================
//
// pdfkit, streamed, with the Noto faces bundled under `apps/api/assets/fonts`.
// Not a headless browser (300 MB+ in the image, a sandbox, and a lot of memory
// per render) and not `pdfmake` (builds the whole document in memory) — see
// spec §8.4 and §11 for the comparison in full.
//
// -----------------------------------------------------------------------------
// THE FONTS ARE BUNDLED, AND THE IMAGE MUST COPY THEM
// -----------------------------------------------------------------------------
//
// `node:24-alpine` ships NO fonts. A PDF exporter that relied on the host's
// installed families would render differently on a developer's machine and on
// the container, or fail outright — so the three faces are committed to this
// repository and `apps/api/Dockerfile`'s production stage has a `COPY` for the
// `assets` directory. `transcript-export-assets.spec.ts` asserts that COPY
// exists, because the failure mode without it is an image that builds green,
// starts fine, and throws on the first export anybody asks for.
//
// `FONT_DIR` resolves the same way from `src/` and from `dist/`
// (`apps/api/<either>/transcripts/export/../../../assets/fonts`), which is why
// there is no environment variable and no build-time copy step.
//
// ⚠ CJK AND RIGHT-TO-LEFT SCRIPTS ARE A DOCUMENTED v1 LIMITATION, not a gap
// discovered later. Noto Sans covers Latin, Greek and Cyrillic and has no CJK
// glyphs at all; pdfkit performs no bidirectional reordering, so an Arabic or
// Hebrew segment renders with individually-correct glyphs in the wrong visual
// order. Fixing either means bundling the relevant Noto CJK/Arabic families and
// adding a real bidi pass, and both are out of this epic's scope exactly as
// spec §8.4 states. `pdf.exporter.spec.ts` asserts the limitation (the bundled
// face reports no glyph for U+4E2D) so that it stays a known fact rather than
// becoming a surprise.
//
// -----------------------------------------------------------------------------
// `bufferPages`, AND WHAT IT DOES AND DOES NOT BUFFER
// -----------------------------------------------------------------------------
//
// The footer says "Page x of y", and `y` is unknowable until the last segment
// has been laid out. pdfkit's `bufferPages: true` holds each page's METADATA so
// `switchToPage` can go back and draw on it; the page CONTENT streams out as it
// always did. That distinction is the whole reason this is acceptable for a
// document that can run to hundreds of pages — the alternative (render once to
// count pages, then render again) doubles the work, and stamping no total at
// all makes a printed export unable to tell its reader a page is missing.
//
// ⚠ THE BOTTOM MARGIN IS ZEROED WHILE THE FOOTER IS DRAWN, and restored
// immediately. Writing at `page.height - FOOTER_BASELINE` is BELOW the bottom
// margin, and pdfkit responds to text below the margin by adding a new page —
// which, inside the loop that decorates every page, appends one page per page,
// forever. The zeroing is not a style choice; it is what stops that.
//
// -----------------------------------------------------------------------------
// THE ORPHAN CHECK BEFORE EACH TURN
// -----------------------------------------------------------------------------
//
// A speaker line drawn at the very bottom of a page would leave its name and
// timestamp stranded there with the words on the next page. `ensureRoom` adds
// the page FIRST when less than `MIN_TURN_ROOM` remains, so a turn always
// begins with at least its heading and one line of text together. It is a
// heuristic and it is deliberately a cheap one: a full pagination pass would
// mean measuring every segment twice.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';
import PDFDocument from 'pdfkit';
import { APP_NAME } from '@app/shared';

import {
  formatDuration,
  formatTimestamp,
  speakerIndex,
  type ExportDocument,
} from './export-document';
import {
  optionsSchemaFor,
  type ExportOptionField,
  type ExportOptions,
} from './export-options';
import { speakerColor } from './speaker-palette';
import {
  TranscriptExporterRegistry,
  type TranscriptExporter,
} from './transcript-exporter.interface';

/** Where the three committed faces live. See the header for the path rule. */
export const FONT_DIR = resolve(__dirname, '../../../assets/fonts');

/**
 * pdfkit font aliases, so no call site repeats a filename.
 *
 * Product-neutral on purpose: these are internal handles pdfkit resolves
 * `doc.font(...)` against, never anything a reader sees, and a rebrand must not
 * have to touch them (`apps/cli/src/template-identity.test.ts` enforces that).
 */
export const PDF_FONTS = {
  body: 'transcript-body',
  bold: 'transcript-bold',
  mono: 'transcript-mono',
} as const;

const FONT_FILES: Record<string, string> = {
  [PDF_FONTS.body]: 'NotoSans-Regular.ttf',
  [PDF_FONTS.bold]: 'NotoSans-Bold.ttf',
  [PDF_FONTS.mono]: 'NotoSansMono-Regular.ttf',
};

/** Page geometry, in PDF points (72 per inch). */
const MARGIN = 56;
/** Extra space at the top of every page for the running header. */
const HEADER_SPACE = 24;
/** The left column the timestamps sit in. */
const TIMESTAMP_GUTTER = 56;
/** Distance from the bottom edge to the footer's baseline. */
const FOOTER_BASELINE = 34;
/** A turn needs at least this much room, or it starts on the next page. */
const MIN_TURN_ROOM = 56;

const INK = '#111111';
const MUTED = '#666666';
const RULE = '#dddddd';

export const PDF_EXPORT_OPTIONS: readonly ExportOptionField[] = [
  {
    key: 'includeCover',
    label: 'Include the cover block',
    description:
      'A title block on the first page with the date, the duration and each participant ' +
      'with their share of the talking.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'includeTimestamps',
    label: 'Include timestamps',
    description: 'Prints the media position for each speaker turn in the left margin.',
    type: 'boolean',
    default: true,
  },
];

@Injectable()
export class PdfTranscriptExporter implements TranscriptExporter, OnModuleInit {
  private readonly logger = new Logger(PdfTranscriptExporter.name);

  readonly format = 'pdf';
  readonly label = 'PDF';
  readonly mimeType = 'application/pdf';
  readonly extension = 'pdf';
  readonly options = PDF_EXPORT_OPTIONS;
  readonly optionsSchema = optionsSchemaFor(PDF_EXPORT_OPTIONS);

  constructor(private readonly registry: TranscriptExporterRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async render(doc: ExportDocument, options: ExportOptions, out: Writable): Promise<void> {
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

    for (const [alias, file] of Object.entries(FONT_FILES)) {
      pdf.registerFont(alias, resolve(FONT_DIR, file));
    }

    // The promise settles on the DESTINATION's `finish`, not on the document's
    // `end`: the exporter contract promises every byte has been handed on, and
    // `doc.end()` only means pdfkit has stopped producing them.
    const finished = new Promise<void>((resolvePromise, reject) => {
      out.once('finish', resolvePromise);
      out.once('error', reject);
      pdf.once('error', reject);
    });

    pdf.pipe(out);

    try {
      if (options.includeCover !== false) drawCover(pdf, doc);

      drawBody(pdf, doc, options.includeTimestamps !== false);
      decoratePages(pdf, doc);
      pdf.end();
    } catch (error) {
      // A throw mid-render leaves `out` open and half-written. Destroying it
      // is what makes a failed export unable to reach storage looking complete
      // — the upload sees an errored stream rather than a clean end.
      out.destroy(error instanceof Error ? error : new Error(String(error)));

      throw error;
    }

    await finished;

    this.logger.debug(
      `Rendered ${doc.segments.length} segment(s) of transcript ${doc.transcriptId} ` +
        `v${doc.version} to PDF`,
    );
  }
}

/** The document pdfkit hands back. Narrowed so helpers stay readable. */
type Pdf = InstanceType<typeof PDFDocument>;

/** Title, date, duration and the participants with their share of the talking. */
export function drawCover(pdf: Pdf, doc: ExportDocument): void {
  const width = contentWidth(pdf);

  pdf.font(PDF_FONTS.bold).fontSize(22).fillColor(INK).text(doc.title, { width });
  pdf.moveDown(0.4);

  const facts = [
    doc.createdAt.toISOString().slice(0, 10),
    formatDuration(doc.durationMs),
    `Version ${doc.version}`,
  ];

  if (doc.language) facts.push(doc.language);

  pdf.font(PDF_FONTS.body).fontSize(10).fillColor(MUTED).text(facts.join('  ·  '), { width });

  if (doc.author) {
    pdf.text(`Edited by ${doc.author.displayName}`, { width });
  }

  pdf.moveDown(0.9);
  pdf
    .font(PDF_FONTS.bold)
    .fontSize(10)
    .fillColor(INK)
    .text(doc.speakers.length === 1 ? 'Participant' : 'Participants', { width });
  pdf.moveDown(0.3);

  for (const speaker of doc.speakers) {
    const y = pdf.y;

    pdf
      .font(PDF_FONTS.bold)
      .fontSize(10)
      .fillColor(speakerColor(speaker.colorIndex))
      .text(speaker.displayName, MARGIN, y, { width: width * 0.6, lineBreak: false });

    pdf
      .font(PDF_FONTS.mono)
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `${formatTimestamp(speaker.talkTimeMs)}  ${speaker.talkTimePercent.toFixed(1)}%`,
        MARGIN + width * 0.6,
        y,
        { width: width * 0.4, align: 'right', lineBreak: false },
      );

    pdf.y = y + 14;
  }

  pdf.moveDown(0.8);
  rule(pdf, pdf.y);
  pdf.y += 16;
}

/** One block per speaker turn: timestamp in the gutter, name, then the text. */
export function drawBody(pdf: Pdf, doc: ExportDocument, includeTimestamps: boolean): void {
  const speakers = speakerIndex(doc);
  const textX = MARGIN + (includeTimestamps ? TIMESTAMP_GUTTER : 0);
  const textWidth = contentWidth(pdf) - (includeTimestamps ? TIMESTAMP_GUTTER : 0);

  let previousSpeaker: string | null = null;

  for (const segment of doc.segments) {
    ensureRoom(pdf);

    const y = pdf.y;
    const speaker = speakers.get(segment.speakerId);
    const startsTurn = segment.speakerId !== previousSpeaker;

    previousSpeaker = segment.speakerId;

    if (includeTimestamps) {
      pdf
        .font(PDF_FONTS.mono)
        .fontSize(8)
        .fillColor(MUTED)
        .text(formatTimestamp(segment.startMs), MARGIN, y + 2, {
          width: TIMESTAMP_GUTTER - 10,
          align: 'right',
          lineBreak: false,
        });
    }

    if (startsTurn) {
      pdf
        .font(PDF_FONTS.bold)
        .fontSize(10)
        .fillColor(speakerColor(speaker?.colorIndex ?? 0))
        .text(speaker?.displayName ?? 'Unknown speaker', textX, y, { width: textWidth });
    }

    pdf
      .font(PDF_FONTS.body)
      .fontSize(10.5)
      .fillColor(INK)
      .text(segment.text, textX, startsTurn ? pdf.y : y, { width: textWidth, align: 'left' });

    pdf.moveDown(0.55);
  }
}

/**
 * The running header and the footer, stamped onto every buffered page.
 *
 * Page 1 gets no header when it carries the cover: the title is already there
 * at 22pt, and repeating it 8pt above itself looks like a mistake.
 */
export function decoratePages(pdf: Pdf, doc: ExportDocument): void {
  const range = pdf.bufferedPageRange();
  const total = range.count;

  for (let index = 0; index < total; index += 1) {
    const page = range.start + index;

    pdf.switchToPage(page);

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

    pdf
      .font(PDF_FONTS.body)
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        exportFooterText(index + 1, total, doc.version),
        MARGIN,
        pdf.page.height - FOOTER_BASELINE,
        { width, align: 'center', lineBreak: false },
      );

    pdf.page.margins.bottom = bottom;
    pdf.page.margins.top = top;
  }

  pdf.flushPages();
}

/**
 * The footer line, spec §8.4 verbatim.
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
export function exportFooterText(page: number, total: number, version: number): string {
  return `Page ${page} of ${total} · Version ${version} · Exported from ${APP_NAME}`;
}

/** Fail with a sentence an operator can act on, not with ENOENT from fontkit. */
export function assertFontsPresent(): void {
  const missing = Object.values(FONT_FILES).filter((file) => !existsSync(resolve(FONT_DIR, file)));

  if (missing.length > 0) {
    throw new Error(
      `The PDF exporter's bundled fonts are missing from ${FONT_DIR}: ${missing.join(', ')}. ` +
        'They are committed under apps/api/assets/fonts and the production image copies that ' +
        'directory; an image built without that COPY cannot export PDFs.',
    );
  }
}

/** Start a new page when there is not enough room left for a whole turn. */
function ensureRoom(pdf: Pdf): void {
  if (pdf.y + MIN_TURN_ROOM > pdf.page.height - pdf.page.margins.bottom) {
    pdf.addPage();
  }
}

/** Usable width between the margins. */
function contentWidth(pdf: Pdf): number {
  return pdf.page.width - MARGIN * 2;
}

/** A hairline across the content width at `y`. */
function rule(pdf: Pdf, y: number): void {
  pdf
    .save()
    .moveTo(MARGIN, y)
    .lineTo(pdf.page.width - MARGIN, y)
    .lineWidth(0.5)
    .strokeColor(RULE)
    .stroke()
    .restore();
}
