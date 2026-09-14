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
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  TextRun,
  type IParagraphOptions,
} from 'docx';
import type { Writable } from 'node:stream';
import { APP_NAME } from '@app/shared';

import {
  optionsSchemaFor,
  type ExportOptionField,
  type ExportOptions,
} from '../../export/export-options';
import { parseMarkdown, type MdBlock, type MdSpan } from './markdown-ast';
import {
  provenanceEntries,
  type NoteExportDocument,
} from './note-export-document';
import { NoteExporterRegistry, type NoteExporter } from './note-exporter.registry';

/** Twips per inch. Word measures everything in twentieths of a point. */
const TWIP = 1440;

/** The numbering definition both list kinds reference. */
const BULLET_REFERENCE = 'note-bullets';
const ORDERED_REFERENCE = 'note-numbers';

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

@Injectable()
export class WordNoteExporter implements NoteExporter, OnModuleInit {
  private readonly logger = new Logger(WordNoteExporter.name);

  readonly format = 'docx';
  readonly label = 'Word (DOCX)';
  readonly mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  readonly extension = 'docx';
  readonly options = WORD_NOTE_EXPORT_OPTIONS;
  readonly optionsSchema = optionsSchemaFor(WORD_NOTE_EXPORT_OPTIONS);

  constructor(private readonly registry: NoteExporterRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async render(doc: NoteExportDocument, options: ExportOptions, out: Writable): Promise<void> {
    try {
      const document = buildWordDocument(doc, options.includePageNumbers !== false);
      const stream = await Packer.toStream(document);

      await new Promise<void>((resolve, reject) => {
        out.once('finish', resolve);
        out.once('error', reject);
        stream.once('error', reject);
        stream.pipe(out);
      });
    } catch (error) {
      out.destroy(error instanceof Error ? error : new Error(String(error)));

      throw error;
    }

    this.logger.debug(`Rendered note ${doc.noteId} v${doc.version} to DOCX`);
  }
}

/** The whole document: title block, provenance, then the body. */
export function buildWordDocument(doc: NoteExportDocument, pageNumbers: boolean): Document {
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: 160 },
      children: [new TextRun({ text: doc.title, bold: true, size: 44 })],
    }),
    ...provenanceParagraphs(doc),
    new Paragraph({
      // The rule under the provenance block: a bottom border on an empty
      // paragraph, which is how Word itself draws a horizontal rule.
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'DDDDDD', space: 1 } },
      spacing: { after: 240 },
      children: [],
    }),
    ...renderBlocks(parseMarkdown(doc.body), 0),
  ];

  return new Document({
    creator: APP_NAME,
    title: doc.title,
    description: `Version ${doc.version}`,
    numbering: { config: [bulletConfig(), orderedConfig()] },
    sections: [
      {
        properties: {
          page: {
            margin: { top: TWIP, bottom: TWIP, left: TWIP, right: TWIP },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [new TextRun({ text: doc.title, size: 16, color: '666666' })],
              }),
            ],
          }),
        },
        footers: pageNumbers
          ? {
              default: new Footer({
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({ text: 'Page ', size: 16, color: '666666' }),
                      // ⚠ FIELD CODES, NOT A COUNTED NUMBER. Word recomputes
                      // these on open and on print, so a document a reader
                      // edits keeps correct page numbers — which a baked-in
                      // "Page 3 of 7" would not.
                      new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '666666' }),
                      new TextRun({ text: ' of ', size: 16, color: '666666' }),
                      new TextRun({
                        children: [PageNumber.TOTAL_PAGES],
                        size: 16,
                        color: '666666',
                      }),
                      new TextRun({
                        text: ` · Version ${doc.version} · Exported from ${APP_NAME}`,
                        size: 16,
                        color: '666666',
                      }),
                    ],
                  }),
                ],
              }),
            }
          : undefined,
        children,
      },
    ],
  });
}

/** The provenance block: one `Label: value` line each, label in bold. */
function provenanceParagraphs(doc: NoteExportDocument): Paragraph[] {
  return provenanceEntries(doc).map(
    (entry) =>
      new Paragraph({
        spacing: { after: 40 },
        children: [
          new TextRun({ text: `${entry.label}: `, bold: true, size: 18, color: '666666' }),
          new TextRun({ text: entry.value, size: 18 }),
        ],
      }),
  );
}

/** Lay out a block list at one list depth. Recursive, like the PDF renderer. */
export function renderBlocks(blocks: readonly MdBlock[], depth: number): Paragraph[] {
  const out: Paragraph[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        out.push(
          para({
            heading: HEADINGS[block.level],
            spacing: { before: 240, after: 80 },
            children: runs(block.spans),
          }),
        );
        break;
      }

      case 'paragraph': {
        out.push(para({ spacing: { after: 120 }, children: runs(block.spans) }));
        break;
      }

      case 'list': {
        for (const item of block.items) {
          const rendered = renderBlocks(item, depth + 1);

          // ⚠ ONLY THE ITEM'S FIRST PARAGRAPH CARRIES THE BULLET. A second
          // paragraph under one bullet is continuation prose, and numbering it
          // too would turn a three-step list with commentary into a six-step
          // list.
          rendered.forEach((paragraph, index) => {
            out.push(
              index === 0
                ? withNumbering(paragraph, block.ordered, depth)
                : indented(paragraph, depth + 1),
            );
          });
        }
        break;
      }

      case 'quote': {
        for (const paragraph of renderBlocks(block.blocks, depth)) {
          out.push(
            clone(paragraph, {
              indent: { left: (depth + 1) * 360 },
              border: {
                left: { style: BorderStyle.SINGLE, size: 12, color: 'DDDDDD', space: 8 },
              },
            }),
          );
        }
        break;
      }

      case 'code': {
        // One paragraph per line, so a long sample wraps at its own line breaks
        // rather than becoming a single run Word reflows into prose.
        const lines = block.text.length > 0 ? block.text.split('\n') : [''];

        lines.forEach((line, index) => {
          out.push(
            para({
              spacing: { after: index === lines.length - 1 ? 120 : 0 },
              indent: { left: 240 },
              shading: { type: ShadingType.CLEAR, fill: 'F4F4F5' },
              children: [new TextRun({ text: line, font: 'Courier New', size: 18 })],
            }),
          );
        });
        break;
      }

      case 'rule': {
        out.push(
          para({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'DDDDDD', space: 1 } },
            spacing: { before: 120, after: 200 },
            children: [],
          }),
        );
        break;
      }
    }
  }

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

/** Spans → Word runs, with a hyperlink wrapper where one is called for. */
function runs(spans: readonly MdSpan[]): (TextRun | ExternalHyperlink)[] {
  return spans.map((span) => {
    const run = new TextRun({
      text: span.text,
      bold: span.bold === true,
      italics: span.italic === true,
      strike: span.strike === true,
      ...(span.code === true ? { font: 'Courier New' } : {}),
      ...(span.href ? { style: 'Hyperlink' } : {}),
    });

    return span.href ? new ExternalHyperlink({ children: [run], link: span.href }) : run;
  });
}

/**
 * Build a paragraph AND remember what it was built from.
 *
 * ⚠ EVERY PARAGRAPH `renderBlocks` PRODUCES MUST GO THROUGH THIS. `clone`
 * below re-creates a paragraph to add numbering or an indent, and it can only
 * do that from the options — so a paragraph built with a bare `new Paragraph`
 * would silently lose its heading level, spacing and runs the moment it
 * appeared inside a list item.
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

function withNumbering(paragraph: Paragraph, ordered: boolean, depth: number): Paragraph {
  return clone(paragraph, {
    numbering: {
      reference: ordered ? ORDERED_REFERENCE : BULLET_REFERENCE,
      level: Math.min(depth, 3),
    },
  });
}

function indented(paragraph: Paragraph, depth: number): Paragraph {
  return clone(paragraph, { indent: { left: depth * 360 } });
}

/**
 * The options each paragraph was built from.
 *
 * `docx` exposes no way to read a `Paragraph` back, and the list path has to
 * ADD numbering to a paragraph the recursive call already built. A WeakMap
 * keyed on the paragraph is the cheapest honest answer: it keeps the recursion
 * (which is what makes nested lists and code-inside-a-step work) without
 * either duplicating the block switch or reaching into the library's internals.
 */
const PARAGRAPH_OPTIONS = new WeakMap<Paragraph, IParagraphOptions>();

function remember(paragraph: Paragraph, options: IParagraphOptions): Paragraph {
  PARAGRAPH_OPTIONS.set(paragraph, options);

  return paragraph;
}

/** Four levels of bullets, indented consistently with the PDF. */
function bulletConfig() {
  return {
    reference: BULLET_REFERENCE,
    levels: [0, 1, 2, 3].map((level) => ({
      level,
      format: LevelFormat.BULLET,
      text: ['•', '◦', '▪', '·'][level] ?? '•',
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
    })),
  };
}

/** Four levels of numbers: 1. / a. / i. / 1. */
function orderedConfig() {
  return {
    reference: ORDERED_REFERENCE,
    levels: [0, 1, 2, 3].map((level) => ({
      level,
      format: [
        LevelFormat.DECIMAL,
        LevelFormat.LOWER_LETTER,
        LevelFormat.LOWER_ROMAN,
        LevelFormat.DECIMAL,
      ][level],
      text: `%${level + 1}.`,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
    })),
  };
}
