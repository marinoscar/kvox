// =============================================================================
// The Word (.docx) note export (issue #54, docs/specs/notes.md §8.3)
// =============================================================================
//
// THE FIRST `docx` EXPORTER IN THIS CODEBASE. It was explicitly deferred out of
// epic #19's scope (`docs/specs/transcription.md` §8's own scope line, restated
// in CLAUDE.md) and lands here, built for notes rather than retrofitted onto
// transcripts: VISION.md's "Information Should Be Portable" names Word
// explicitly, and a page or two of prose is a far more natural `.docx` document
// than a multi-thousand-segment transcript would be. Whether this is later
// generalised for transcript export is out of scope for #54 — but note that it
// renders from `markdown-ast.ts`, so what it would need is a markdown-shaped
// transcript document, not a second exporter.
//
// -----------------------------------------------------------------------------
// WHY `docx` (9.7.1, PINNED EXACTLY)
// -----------------------------------------------------------------------------
//
// OOXML is a ZIP of related XML parts with a relationship graph, a numbering
// definition per list, and a styles part — writing it by hand is not "generate
// some XML", it is implementing a spec, and Word rejects a document with a
// malformed `numbering.xml` outright rather than degrading. `docx` is the
// maintained library for this on npm, has no native build step (so the Alpine
// image needs nothing new), and — the property that actually decided it —
// publishes a real `require` condition, unlike every current markdown parser
// (see `markdown-ast.ts`'s header for that story). Pinned exactly, like
// `unpdf` and `web-push` already are in this package, because a document format
// library's patch releases change bytes.
//
// -----------------------------------------------------------------------------
// ⚠ `Packer.toStream` BUILDS THE ZIP IN MEMORY, AND THAT IS ACCEPTED HERE
// -----------------------------------------------------------------------------
//
// Stated plainly rather than left for somebody to discover: the `render`
// contract this implements is streaming, and this implementation satisfies the
// OBSERVABLE half of it (it writes to `out`, ends it, and settles only once
// every byte has been handed on) while the ZIP itself is assembled in memory
// first. That is a property of OOXML, not of this library — a `.docx` is a ZIP
// whose central directory is written last, so nothing can emit a valid one
// incrementally without buffering the entries anyway.
//
// The reason it is acceptable for NOTES and would not be for transcripts is the
// document: a note is prose a person reads in one sitting — kilobytes, or low
// megabytes for an extreme one — whereas a ten-hour recording's transcript is
// the document `docs/specs/transcription.md` §8.4 rejected `pdfmake` over. If a
// note-shaped document ever grows to transcript scale, this is the file that
// has to change, and this paragraph is why.
//
// -----------------------------------------------------------------------------
// THE DESIGN: STYLES FIRST, SAME VISUAL SPEC AS THE PDF
// -----------------------------------------------------------------------------
//
// Every colour, size and spacing comes from `note-document-style.ts` (the one place the PDF
// and Word exports share), and nearly all of it is declared as DOCUMENT STYLES (Normal run
// defaults, Heading1-6, Title, Hyperlink, Code, InlineCode, Quote, TableText, Header, Footer)
// rather than per-run formatting, so a colleague who edits the file gets on-brand styles in
// Word's own style gallery. The first page carries a masthead header (logo, product name,
// export date), later pages a slim running header, and the footer is built from PAGE and
// NUMPAGES field codes. Every ordered list gets its OWN numbering instance (and its own start
// value), so a second list never continues the first. Output is validated structurally in the
// spec: equal cell counts per row, a paragraph in every cell, no empty numbering levels.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LineRuleType,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlignTable,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
} from 'docx';
import type { Writable } from 'node:stream';

import {
  DEFAULT_KVOX_BRAND,
  KVOX_BRAND,
  brandMarkPng,
  brandMarkSvgBuffer,
  docxColor,
  type KvoxBrand,
} from '../../core/index.js';
import {
  failStream,
  optionsSchemaFor,
  type ExportOptionField,
  type ExportOptions,
} from '../../transcripts/index.js';
import { parseBody, type MdBlock, type MdSpan } from './markdown-ast.js';
import {
  NOTE_SPACING,
  NOTE_THEME,
  NOTE_TYPE,
  TASK_GLYPH,
  bulletGlyph,
  codeLanguageLabel,
  exportedLabel,
  headingColor,
  headingRule,
  kickerText,
  tableAlignment,
  tableColumnWeights,
} from './note-document-style.js';
import {
  provenanceEntries,
  type NoteExportDocument,
} from './note-export-document.js';
import { NoteExporterRegistry, type NoteExporter } from './note-exporter.registry.js';

// =============================================================================
// ⚠ THIS FILE IMPORTS `docx` STATICALLY, AND `NotesModule.forRoot` LOADS IT WITH
// `require` ONLY WHEN THE WORD EXPORTER IS ENABLED. `docx` is an optional peer: a host that
// turns the exporter off (`exporters: { docx: false }`) never loads this file, so it never
// needs the library. Nothing else imports this file, and the slice's index does not export it.
// =============================================================================

// ---- Units -----------------------------------------------------------------

/** Twips per point. */
const TW = 20;
/** Half-points per point (Word run sizes). */
const HP = 2;
const hp = (pt: number): number => Math.round(pt * HP);
const tw = (pt: number): number => Math.round(pt * TW);

/** A4 in twips. */
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
/** 0.8in side and bottom margins; a little more on top for the masthead. */
const MARGIN_SIDE = 1152;
const MARGIN_TOP = 1380;
const MARGIN_BOTTOM = 1152;
const HEADER_DISTANCE = 560;
const FOOTER_DISTANCE = 520;
/** The usable text width. */
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_SIDE;

const FONT_BODY = 'Calibri';
const FONT_CODE = 'Consolas';
const FONT_SYMBOL = 'Segoe UI Symbol';

const C = {
  primary: docxColor(NOTE_THEME.primary),
  primaryDark: docxColor(NOTE_THEME.primaryDark),
  primaryTint: docxColor(NOTE_THEME.primaryTint),
  accent: docxColor(NOTE_THEME.accent),
  ink: docxColor(NOTE_THEME.ink),
  muted: docxColor(NOTE_THEME.muted),
  faint: docxColor(NOTE_THEME.faint),
  divider: docxColor(NOTE_THEME.divider),
  surface: docxColor(NOTE_THEME.surface),
  paper: docxColor(NOTE_THEME.paper),
  onPrimary: docxColor(NOTE_THEME.onPrimary),
};

const LIST_INDENT = tw(NOTE_SPACING.listIndent);
const MARKER_WIDTH = tw(NOTE_SPACING.markerWidth);
const MAX_LIST_LEVEL = 5;
const LINE = Math.round(NOTE_SPACING.lineHeight * 240);

/** The numbering definition bullets reference. Ordered lists use `note-numbers-<start>`. */
const BULLET_REFERENCE = 'note-bullets';

export const WORD_NOTE_EXPORT_OPTIONS: readonly ExportOptionField[] = [
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
 * Renders a note as a Word document.
 *
 * @stability experimental
 */
@Injectable()
export class WordNoteExporter implements NoteExporter, OnModuleInit {
  private readonly logger = new Logger(WordNoteExporter.name);

  readonly format = 'docx';
  readonly label = 'Word (DOCX)';
  readonly mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  readonly extension = 'docx';
  readonly options = WORD_NOTE_EXPORT_OPTIONS;
  readonly optionsSchema = optionsSchemaFor(WORD_NOTE_EXPORT_OPTIONS);

  constructor(
    private readonly registry: NoteExporterRegistry,
    @Optional() @Inject(KVOX_BRAND) private readonly brand: KvoxBrand = DEFAULT_KVOX_BRAND,
  ) {}

  /** Registers the exporter with the registry. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  async render(doc: NoteExportDocument, options: ExportOptions, out: Writable): Promise<void> {
    try {
      const document = buildWordDocument(doc, options.includePageNumbers !== false, this.brand.appName);
      const stream = await Packer.toStream(document);

      await new Promise<void>((resolve, reject) => {
        out.once('finish', resolve);
        out.once('error', reject);
        stream.once('error', reject);
        stream.pipe(out);
      });
    } catch (error) {
      failStream(out, error);

      throw error;
    }

    this.logger.debug(`Rendered note ${doc.noteId} v${doc.version} to DOCX`);
  }
}

// =============================================================================
// The document
// =============================================================================

/** A child of the body, a header cell or a quote: a paragraph or a table. */
type Block = Paragraph | Table;

/** The whole document: title block, provenance, then the body. */
export function buildWordDocument(
  doc: NoteExportDocument,
  pageNumbers: boolean,
  appName: string = DEFAULT_KVOX_BRAND.appName,
): Document {
  const ctx = newContext();
  const body = renderBlocks(parseBody(doc.body, doc.bodyFormat), 0, ctx);

  const children: Block[] = [
    ...titleBlock(doc),
    provenanceCard(doc),
    spacer(200),
    ...body,
    // A section must end in a paragraph; a trailing table would otherwise be last.
    ...(body[body.length - 1] instanceof Table ? [spacer(0)] : []),
  ];

  const footer = pageNumbers ? new Footer({ children: [footerParagraph(doc, appName)] }) : undefined;

  return new Document({
    creator: appName,
    title: doc.title,
    subject: `Note version ${doc.version}`,
    description: `Version ${doc.version}`,
    ...(doc.templateName ? { keywords: doc.templateName } : {}),
    styles: documentStyles(),
    numbering: { config: [bulletConfig(), ...ctx.numbering.configs()] },
    sections: [
      {
        properties: {
          titlePage: true,
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: {
              top: MARGIN_TOP,
              bottom: MARGIN_BOTTOM,
              left: MARGIN_SIDE,
              right: MARGIN_SIDE,
              header: HEADER_DISTANCE,
              footer: FOOTER_DISTANCE,
            },
          },
        },
        headers: {
          first: new Header({ children: mastheadBlocks(doc, appName) }),
          default: new Header({ children: [runningHeader(doc, appName)] }),
        },
        footers: footer
          ? {
              first: footer,
              default: new Footer({ children: [footerParagraph(doc, appName)] }),
            }
          : undefined,
        children,
      },
    ],
  });
}

// =============================================================================
// Styles
// =============================================================================

type StyleBorder = { style: (typeof BorderStyle)[keyof typeof BorderStyle]; size: number; color: string; space: number };

const codeBorder = (space: number): StyleBorder => ({
  style: BorderStyle.SINGLE,
  size: 4,
  color: C.divider,
  space,
});

function documentStyles() {
  const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) => ({
    run: {
      font: FONT_BODY,
      bold: true,
      size: hp(NOTE_TYPE[`h${level}` as const]),
      color: docxColor(headingColor(level)),
    },
    paragraph: {
      keepNext: true,
      keepLines: true,
      outlineLevel: level - 1,
      spacing: {
        before: tw(NOTE_SPACING.headingBefore[level]),
        after: tw(NOTE_SPACING.headingAfter),
        line: 264,
        lineRule: LineRuleType.AUTO,
      },
      ...(headingRule(level)
        ? { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.divider, space: 3 } } }
        : {}),
    },
  });

  return {
    default: {
      document: {
        run: { font: FONT_BODY, size: hp(NOTE_TYPE.body), color: C.ink },
        paragraph: {
          spacing: { after: tw(NOTE_SPACING.paragraphAfter), line: LINE, lineRule: LineRuleType.AUTO },
        },
      },
      title: {
        run: { font: FONT_BODY, bold: true, size: hp(NOTE_TYPE.title), color: C.ink },
        paragraph: {
          keepNext: true,
          spacing: { before: 0, after: 100, line: 252, lineRule: LineRuleType.AUTO },
        },
      },
      heading1: heading(1),
      heading2: heading(2),
      heading3: heading(3),
      heading4: heading(4),
      heading5: heading(5),
      heading6: heading(6),
      hyperlink: {
        run: { color: C.primary, underline: { type: 'single' as const } },
      },
    },
    paragraphStyles: [
      {
        id: 'Code',
        name: 'Code',
        quickFormat: true,
        run: { font: FONT_CODE, size: hp(NOTE_TYPE.code), color: C.ink },
        paragraph: {
          keepLines: true,
          spacing: { before: 0, after: 0, line: 276, lineRule: LineRuleType.AUTO },
          shading: { type: ShadingType.CLEAR, fill: C.surface, color: 'auto' },
          border: {
            top: codeBorder(4),
            bottom: codeBorder(4),
            left: codeBorder(6),
            right: codeBorder(6),
          },
        },
      },
      {
        id: 'Quote',
        name: 'Quote',
        quickFormat: true,
        run: { italics: true, color: C.muted },
        paragraph: {
          indent: { left: tw(NOTE_SPACING.quoteIndent) },
          spacing: { before: 0, after: tw(NOTE_SPACING.paragraphAfter) },
          shading: { type: ShadingType.CLEAR, fill: C.primaryTint, color: 'auto' },
          border: {
            left: { style: BorderStyle.SINGLE, size: 24, color: C.primary, space: 8 },
          },
        },
      },
      {
        id: 'TableText',
        name: 'Table Text',
        run: { size: hp(NOTE_TYPE.table) },
        paragraph: { spacing: { before: 0, after: 0, line: 259, lineRule: LineRuleType.AUTO } },
      },
      {
        id: 'Header',
        name: 'header',
        run: { size: hp(NOTE_TYPE.header), color: C.muted },
        paragraph: { spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO } },
      },
      {
        id: 'Footer',
        name: 'footer',
        run: { size: hp(NOTE_TYPE.footer), color: C.muted },
        paragraph: { spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO } },
      },
    ],
    characterStyles: [
      {
        id: 'InlineCode',
        name: 'Inline Code',
        run: {
          font: FONT_CODE,
          size: hp(NOTE_TYPE.body - 1),
          color: C.primaryDark,
          shading: { type: ShadingType.CLEAR, fill: C.surface, color: 'auto' },
        },
      },
    ],
  };
}

// =============================================================================
// Masthead, running header, footer
// =============================================================================

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' } as const;
const NO_BORDERS = {
  top: NO_BORDER,
  bottom: NO_BORDER,
  left: NO_BORDER,
  right: NO_BORDER,
};

function logo(px: number, appName: string): ImageRun {
  return new ImageRun({
    type: 'svg',
    data: brandMarkSvgBuffer(),
    fallback: { type: 'png', data: brandMarkPng(256) },
    transformation: { width: px, height: px },
    altText: { name: 'logo', title: appName, description: `${appName} logo` },
  });
}

/** An empty paragraph of a fixed tiny height: separates blocks without a visible gap. */
function spacer(afterTwips: number): Paragraph {
  return new Paragraph({
    spacing: { before: 0, after: afterTwips, line: 20, lineRule: LineRuleType.EXACT },
    run: { size: 2 },
    children: [],
  });
}

/** The first page's header: a borderless two-cell table under a primary rule. */
function mastheadBlocks(doc: NoteExportDocument, appName: string): Block[] {
  const left = 6200;
  const right = CONTENT_WIDTH - left;
  const cell = (width: number, paragraph: Paragraph) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      verticalAlign: VerticalAlignTable.CENTER,
      borders: NO_BORDERS,
      margins: { top: 0, bottom: 100, left: 0, right: 0 },
      children: [paragraph],
    });

  return [
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [left, right],
      layout: TableLayoutType.FIXED,
      borders: {
        ...NO_BORDERS,
        bottom: { style: BorderStyle.SINGLE, size: 18, color: C.primary },
        insideHorizontal: NO_BORDER,
        insideVertical: NO_BORDER,
      },
      rows: [
        new TableRow({
          cantSplit: true,
          children: [
            cell(
              left,
              new Paragraph({
                style: 'Header',
                children: [
                  logo(30, appName),
                  new TextRun({
                    text: `  ${appName}`,
                    bold: true,
                    size: hp(NOTE_TYPE.brand),
                    color: C.primary,
                  }),
                ],
              }),
            ),
            cell(
              right,
              new Paragraph({
                style: 'Header',
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: exportedLabel(doc), color: C.muted })],
              }),
            ),
          ],
        }),
      ],
    }),
    spacer(0),
  ];
}

/** Pages 2+: a slim header with the small logo, the product and the note title. */
function runningHeader(doc: NoteExportDocument, appName: string): Paragraph {
  const title = doc.title.length > 80 ? `${doc.title.slice(0, 79)}…` : doc.title;

  return new Paragraph({
    style: 'Header',
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.divider, space: 4 } },
    children: [
      logo(14, appName),
      new TextRun({ text: `  ${appName}`, bold: true, color: C.primary }),
      new TextRun({ children: [new Tab()] }),
      new TextRun({ text: title, color: C.muted }),
    ],
  });
}

/**
 * ⚠ FIELD CODES, NOT A COUNTED NUMBER. Word recomputes PAGE and NUMPAGES on open and on print,
 * so a document a reader edits keeps correct page numbers, which a baked-in "Page 3 of 7"
 * would not.
 */
function footerParagraph(doc: NoteExportDocument, appName: string): Paragraph {
  return new Paragraph({
    style: 'Footer',
    alignment: AlignmentType.CENTER,
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.divider, space: 6 } },
    children: [
      new TextRun({ text: 'Page ' }),
      new TextRun({ children: [PageNumber.CURRENT] }),
      new TextRun({ text: ' of ' }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
      new TextRun({ text: ` · Version ${doc.version} · Exported from ${appName}` }),
    ],
  });
}

// =============================================================================
// Title block and provenance card
// =============================================================================

function titleBlock(doc: NoteExportDocument): Paragraph[] {
  return [
    new Paragraph({
      keepNext: true,
      spacing: { before: 0, after: 80 },
      children: [
        new TextRun({
          text: kickerText(doc),
          bold: true,
          color: C.primary,
          size: hp(NOTE_TYPE.label),
          characterSpacing: 20,
        }),
      ],
    }),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: doc.title })] }),
    // The accent bar: an empty paragraph with a thick amber bottom border whose right indent
    // leaves a half-inch stub. Borders follow paragraph indents in Word, LibreOffice and
    // Google Docs alike, so it renders the same everywhere (a 1x1 table would not).
    new Paragraph({
      keepNext: true,
      indent: { right: CONTENT_WIDTH - 720 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: C.accent, space: 0 } },
      spacing: { before: 0, after: 240, line: 20, lineRule: LineRuleType.EXACT },
      run: { size: 2 },
      children: [],
    }),
  ];
}

/** The provenance block: a tinted label/value card with a primary rule on its left edge. */
function provenanceCard(doc: NoteExportDocument): Table {
  const entries = provenanceEntries(doc);
  const labelWidth = 1900;
  const valueWidth = CONTENT_WIDTH - labelWidth;
  const shading = { type: ShadingType.CLEAR, fill: C.primaryTint, color: 'auto' } as const;

  const rows = entries.map((entry, index) => {
    const first = index === 0;
    const last = index === entries.length - 1;
    const margins = {
      top: first ? 160 : 60,
      bottom: last ? 160 : 60,
      left: 200,
      right: 200,
    };

    return new TableRow({
      cantSplit: true,
      children: [
        new TableCell({
          width: { size: labelWidth, type: WidthType.DXA },
          shading,
          margins,
          borders: NO_BORDERS,
          children: [
            new Paragraph({
              keepNext: !last,
              spacing: { before: 0, after: 0 },
              children: [
                new TextRun({
                  text: entry.label,
                  bold: true,
                  allCaps: true,
                  color: C.muted,
                  size: hp(NOTE_TYPE.label),
                  characterSpacing: 10,
                }),
              ],
            }),
          ],
        }),
        new TableCell({
          width: { size: valueWidth, type: WidthType.DXA },
          shading,
          margins,
          borders: NO_BORDERS,
          children: [
            new Paragraph({
              keepNext: !last,
              spacing: { before: 0, after: 0 },
              children: [new TextRun({ text: entry.value, color: C.ink, size: hp(NOTE_TYPE.meta) })],
            }),
          ],
        }),
      ],
    });
  });

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [labelWidth, valueWidth],
    layout: TableLayoutType.FIXED,
    borders: {
      top: NO_BORDER,
      bottom: NO_BORDER,
      right: NO_BORDER,
      left: { style: BorderStyle.SINGLE, size: 24, color: C.primary },
      insideHorizontal: NO_BORDER,
      insideVertical: NO_BORDER,
    },
    rows,
  });
}

// =============================================================================
// Body blocks
// =============================================================================

/** State threaded through the recursion. */
interface RenderContext {
  readonly numbering: NumberingRegistry;
  /** Text inside a completed task renders muted. */
  readonly muted?: boolean;
}

function newContext(): RenderContext {
  return { numbering: new NumberingRegistry() };
}

/** Lay out a block list at one list depth. Recursive, like the PDF renderer. */
export function renderBlocks(
  blocks: readonly MdBlock[],
  depth: number,
  ctx: RenderContext = newContext(),
): Block[] {
  const out: Block[] = [];
  const base: RunBase = ctx.muted ? { color: C.muted } : {};

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        out.push(para({ heading: HEADINGS[block.level], children: runs(block.spans, base) }));
        break;
      }

      case 'paragraph': {
        out.push(para({ children: runs(block.spans, base) }));
        break;
      }

      case 'list': {
        // Each list is its own numbering instance, restarting at its own start.
        const numbering = block.ordered ? ctx.numbering.next(block.start) : null;
        const lastIndex = block.items.length - 1;

        block.items.forEach((item, itemIndex) => {
          const task = block.tasks?.[itemIndex] ?? null;
          const rendered = renderBlocks(item, depth + 1, task === true ? { ...ctx, muted: true } : ctx);
          const level = Math.min(depth, MAX_LIST_LEVEL);
          let numberedFirst = false;

          rendered.forEach((entry, index) => {
            if (!(entry instanceof Paragraph)) {
              out.push(entry);
              return;
            }

            const options = PARAGRAPH_OPTIONS.get(entry);
            const isLeadParagraph = index === 0 && !options?.numbering && !numberedFirst;

            if (isLeadParagraph) {
              numberedFirst = true;
              out.push(leadParagraph(entry, level, numbering, task));
            } else if (options?.numbering) {
              // A nested list's own paragraph: already numbered and indented.
              out.push(entry);
            } else {
              out.push(indented(entry, (level + 1) * LIST_INDENT));
            }
          });

          if (depth === 0 && itemIndex === lastIndex) {
            const tail = out[out.length - 1];

            if (tail instanceof Paragraph) {
              out[out.length - 1] = clone(tail, {
                spacing: { ...PARAGRAPH_OPTIONS.get(tail)?.spacing, after: tw(NOTE_SPACING.blockAfter) },
              });
            }
          }
        });
        break;
      }

      case 'quote': {
        for (const entry of renderBlocks(block.blocks, depth, ctx)) {
          out.push(entry instanceof Paragraph ? quoted(entry) : entry);
        }
        break;
      }

      case 'code': {
        out.push(...codeParagraphs(block));
        break;
      }

      case 'table': {
        out.push(...tableBlocks(block, depth * LIST_INDENT));
        break;
      }

      case 'rule': {
        out.push(
          para({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.divider, space: 1 } },
            spacing: { before: 160, after: 200 },
            children: [],
          }),
        );
        break;
      }
    }
  }

  return out;
}

/** One paragraph per line, in the Code style, so consecutive lines merge into ONE box. */
function codeParagraphs(block: Extract<MdBlock, { type: 'code' }>): Paragraph[] {
  const lines = block.text.length > 0 ? block.text.split('\n') : [''];
  const out: Paragraph[] = [];
  const label = codeLanguageLabel(block.language);
  const indent = { left: 140, right: 140 };

  if (label) {
    out.push(
      para({
        style: 'Code',
        alignment: AlignmentType.RIGHT,
        indent,
        spacing: { before: 60 },
        keepNext: true,
        children: [
          new TextRun({
            text: label,
            bold: true,
            color: C.faint,
            size: hp(NOTE_TYPE.label),
            characterSpacing: 10,
          }),
        ],
      }),
    );
  }

  lines.forEach((line, index) => {
    out.push(
      para({
        style: 'Code',
        indent,
        // Spacing around the box rides on the first and last paragraph only.
        spacing: {
          before: index === 0 && !label ? 60 : 0,
          after: index === lines.length - 1 ? tw(NOTE_SPACING.blockAfter) : 0,
        },
        children: [new TextRun({ text: line })],
      }),
    );
  });

  return out;
}

/** Markdown heading level → Word's own outline levels. */
const HEADINGS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

// =============================================================================
// Inline runs
// =============================================================================

/** Direct formatting applied to every run of a paragraph (table headers, completed tasks). */
interface RunBase {
  color?: string;
  bold?: boolean;
  size?: number;
}

type Inline = TextRun | ExternalHyperlink;

/** Spans → Word runs, with a hyperlink wrapper where one is called for. */
function runs(spans: readonly MdSpan[], base: RunBase = {}): Inline[] {
  return spans.flatMap((span): Inline[] => {
    const marks: IRunOptions = {
      ...(base.bold || span.bold ? { bold: true } : {}),
      ...(span.italic ? { italics: true } : {}),
      ...(span.strike ? { strike: true } : {}),
      ...(base.color ? { color: base.color } : {}),
      ...(base.size ? { size: base.size } : {}),
      ...(span.href
        ? { style: 'Hyperlink', ...(span.code ? { font: FONT_CODE } : {}) }
        : span.code
          ? { style: 'InlineCode' }
          : {}),
    };

    // A `\n` inside a span is a line break the body meant (a plain-text paragraph keeps its
    // single line breaks, #334). Word ignores a newline inside a run's text, so each line after
    // the first becomes its own run carrying a `break`.
    const built = span.text
      .split('\n')
      .map((line, index) => new TextRun({ text: line, ...marks, ...(index > 0 ? { break: 1 } : {}) }));

    const wrapped: Inline[] = span.href
      ? [new ExternalHyperlink({ children: built, link: span.href })]
      : built;

    // An image can't be embedded from a URL at export time: mark it and link the alt text.
    return span.image
      ? [new TextRun({ text: '[image] ', color: C.muted, italics: true }), ...wrapped]
      : wrapped;
  });
}

// =============================================================================
// Paragraph bookkeeping
// =============================================================================

/**
 * Build a paragraph AND remember what it was built from.
 *
 * ⚠ EVERY PARAGRAPH `renderBlocks` PRODUCES MUST GO THROUGH THIS. `clone` below re-creates a
 * paragraph to add numbering or an indent, and it can only do that from the options.
 */
function para(options: IParagraphOptions): Paragraph {
  return remember(new Paragraph(options), options);
}

/** Re-create a paragraph with extra options. `docx` paragraphs are immutable. */
function clone(paragraph: Paragraph, extra: Partial<IParagraphOptions>): Paragraph {
  const options = PARAGRAPH_OPTIONS.get(paragraph) ?? {};
  const merged = { ...options, ...extra };

  return remember(new Paragraph(merged), merged);
}

/**
 * The options each paragraph was built from. `docx` exposes no way to read a `Paragraph` back,
 * and the list path has to ADD numbering to a paragraph the recursive call already built.
 */
const PARAGRAPH_OPTIONS = new WeakMap<Paragraph, IParagraphOptions>();

function remember(paragraph: Paragraph, options: IParagraphOptions): Paragraph {
  PARAGRAPH_OPTIONS.set(paragraph, options);

  return paragraph;
}

/**
 * The first paragraph of a list item: it alone carries the bullet or number. A second paragraph
 * under one bullet is continuation prose, and numbering it would turn a three-step list with
 * commentary into a six-step list. A task item carries a checkbox glyph instead of a marker.
 */
function leadParagraph(
  paragraph: Paragraph,
  level: number,
  numbering: { reference: string; instance: number } | null,
  task: boolean | null,
): Paragraph {
  const options = PARAGRAPH_OPTIONS.get(paragraph) ?? {};
  const spacing = { ...options.spacing, after: tw(NOTE_SPACING.listItemAfter) };

  if (task !== null) {
    return clone(paragraph, {
      spacing,
      indent: { left: (level + 1) * LIST_INDENT, hanging: MARKER_WIDTH },
      children: [
        new TextRun({
          text: task ? TASK_GLYPH.done : TASK_GLYPH.open,
          font: FONT_SYMBOL,
          color: C.primary,
        }),
        new TextRun({ children: [new Tab()] }),
        ...(options.children ?? []),
      ],
    });
  }

  return clone(paragraph, {
    spacing,
    numbering: numbering
      ? { reference: numbering.reference, level, instance: numbering.instance }
      : { reference: BULLET_REFERENCE, level },
  });
}

function indented(paragraph: Paragraph, left: number): Paragraph {
  const options = PARAGRAPH_OPTIONS.get(paragraph) ?? {};
  const existing = options.indent?.left;

  return clone(paragraph, {
    indent: {
      ...options.indent,
      left: (typeof existing === 'number' ? existing : 0) + left,
    },
  });
}

/** A block inside a blockquote: Quote style for prose, a left rule for everything else. */
function quoted(paragraph: Paragraph): Paragraph {
  const options = PARAGRAPH_OPTIONS.get(paragraph) ?? {};

  if (options.style === 'Code') return paragraph;

  if (options.numbering || options.heading || options.indent) {
    return clone(paragraph, {
      border: { ...options.border, left: { style: BorderStyle.SINGLE, size: 24, color: C.primary, space: 8 } },
      shading: { type: ShadingType.CLEAR, fill: C.primaryTint, color: 'auto' },
    });
  }

  return clone(paragraph, { style: 'Quote' });
}

// =============================================================================
// Lists: numbering configuration
// =============================================================================

/**
 * Hands out numbering instances and remembers one numbering config per distinct start value.
 *
 * ⚠ Word restarts numbering only for a distinct `w:num` (a "numbering instance"). One shared
 * reference would make a second ordered list continue the first, so every list takes `next()`.
 * The start value lives on the abstract definition's levels, so a list that begins at 5 uses a
 * config whose levels start at 5; configs are created on demand and deduplicated by start.
 */
class NumberingRegistry {
  private readonly byStart = new Map<number, string>();
  private instance = 0;

  next(start: number): { reference: string; instance: number } {
    const safe = Number.isFinite(start) ? Math.min(Math.max(Math.trunc(start), 0), 99999) : 1;

    if (!this.byStart.has(safe)) this.byStart.set(safe, `note-numbers-${safe}`);
    this.instance += 1;

    return { reference: this.byStart.get(safe) as string, instance: this.instance };
  }

  configs() {
    return [...this.byStart.entries()].map(([start, reference]) => orderedConfig(reference, start));
  }
}

const NUMBER_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN] as const;

/** Six levels of bullets, glyphs from the shared style, coloured with the brand. */
function bulletConfig() {
  return {
    reference: BULLET_REFERENCE,
    levels: Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
      level,
      format: LevelFormat.BULLET,
      text: bulletGlyph(level),
      alignment: AlignmentType.LEFT,
      style: {
        run: { color: C.primary, ...(level > 0 ? { font: FONT_SYMBOL } : {}) },
        paragraph: { indent: { left: (level + 1) * LIST_INDENT, hanging: MARKER_WIDTH } },
      },
    })),
  };
}

/** Six levels of numbers (1. / a. / i. cycling), bold and brand-coloured. */
function orderedConfig(reference: string, start: number) {
  return {
    reference,
    levels: Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
      level,
      format: NUMBER_FORMATS[level % 3],
      text: `%${level + 1}.`,
      start,
      alignment: AlignmentType.LEFT,
      style: {
        run: { bold: true, color: C.primary },
        paragraph: { indent: { left: (level + 1) * LIST_INDENT, hanging: MARKER_WIDTH } },
      },
    })),
  };
}

// =============================================================================
// Tables
// =============================================================================

const TABLE_RULE = { style: BorderStyle.SINGLE, size: 4, color: C.divider } as const;

/**
 * A markdown table → a fixed-layout Word table (+ a spacer paragraph after it, which also stops
 * Word fusing two neighbouring tables). Every row has the same number of cells and every cell
 * holds at least one paragraph, because Word refuses a table that breaks either rule.
 */
function tableBlocks(block: Extract<MdBlock, { type: 'table' }>, indentTwips: number): Block[] {
  const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 0);

  if (columns === 0) return [];

  const available = Math.max(CONTENT_WIDTH - indentTwips, columns * 240);
  const weights = tableColumnWeights(block);
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(240, Math.floor((weights[index] ?? 1 / columns) * available)),
  );
  // Absorb rounding in the last column so the grid sums to the table width exactly.
  widths[columns - 1] = Math.max(
    240,
    (widths[columns - 1] as number) + available - widths.reduce((a, b) => a + b, 0),
  );
  const total = widths.reduce((a, b) => a + b, 0);

  const cell = (spans: readonly MdSpan[] | undefined, column: number, fill: string, header: boolean) =>
    new TableCell({
      width: { size: widths[column] as number, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
      verticalAlign: VerticalAlignTable.CENTER,
      margins: {
        top: tw(NOTE_SPACING.tableCellPadY),
        bottom: tw(NOTE_SPACING.tableCellPadY),
        left: tw(NOTE_SPACING.tableCellPadX),
        right: tw(NOTE_SPACING.tableCellPadX),
      },
      children: [
        new Paragraph({
          style: 'TableText',
          alignment: ALIGNMENTS[tableAlignment(block.align[column] ?? null)],
          keepNext: header,
          children: runs(spans ?? [], header ? { color: C.onPrimary, bold: true } : {}),
        }),
      ],
    });

  const rows = [
    new TableRow({
      tableHeader: true,
      cantSplit: true,
      children: Array.from({ length: columns }, (_, c) => cell(block.header[c], c, C.primary, true)),
    }),
    ...block.rows.map(
      (row, index) =>
        new TableRow({
          cantSplit: true,
          children: Array.from({ length: columns }, (_, c) =>
            cell(row[c], c, index % 2 === 0 ? C.paper : C.surface, false),
          ),
        }),
    ),
  ];

  return [
    new Table({
      width: { size: total, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      ...(indentTwips > 0 ? { indent: { size: indentTwips, type: WidthType.DXA } } : {}),
      borders: {
        top: TABLE_RULE,
        bottom: TABLE_RULE,
        left: TABLE_RULE,
        right: TABLE_RULE,
        insideHorizontal: TABLE_RULE,
        insideVertical: TABLE_RULE,
      },
      rows,
    }),
    spacer(tw(NOTE_SPACING.blockAfter)),
  ];
}

const ALIGNMENTS = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
} as const;
