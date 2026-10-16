// =============================================================================
// The Markdown note export (issue #54, docs/specs/notes.md §8.3)
// =============================================================================
//
// Close to a literal passthrough, and that is the point: a note's body is
// ALREADY markdown (spec §4.5), so this exporter's whole job is to put the
// provenance block in front of it and get out of the way. It is also the format
// that makes the note usable in another tool immediately — an Obsidian vault, a
// pull request description, a wiki — which is why it exists even though PDF and
// Word are the formats a colleague is more likely to ask for.
//
// ⚠ THE BODY IS NEVER RE-SERIALISED FROM THE AST. `markdown-ast.ts` exists for
// the PDF and DOCX renderers, which have to lay markdown out; running the body
// through a parse-and-print round trip here would mean this exporter's output
// silently drifting every time that parser gained a feature, and a user's own
// careful formatting (a table, a footnote, an HTML block, anything the subset
// does not model) being rewritten into something they did not type. A markdown
// export that is not byte-faithful to the stored body is a bug, not a
// normalisation.
//
// -----------------------------------------------------------------------------
// TWO HEADERS, AND WHY BOTH
// -----------------------------------------------------------------------------
//
// The YAML front matter is MACHINE-readable provenance: a static-site
// generator, a vault, or a script reads it as structured fields. The `>` quoted
// block underneath is HUMAN-readable provenance and is NOT optional — see
// `note-export-document.ts`'s header for why no exporter may switch it off. A
// reader who pastes the body into an email keeps the second; a tool ingesting
// the file keeps the first.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Writable } from 'node:stream';

import {
  optionsSchemaFor,
  type ExportOptionField,
  type ExportOptions,
} from '../../export/export-options';
import { endStream, writeChunk } from '../../export/export-stream';
import {
  provenanceEntries,
  type NoteExportDocument,
} from './note-export-document';
import { NoteExporterRegistry, type NoteExporter } from './note-exporter.registry';

export const MARKDOWN_NOTE_EXPORT_OPTIONS: readonly ExportOptionField[] = [
  {
    key: 'includeFrontMatter',
    label: 'Include YAML front matter',
    description:
      'A machine-readable header naming the source, template, version and export time, for ' +
      'tools that index markdown files. The human-readable provenance block is always ' +
      'included either way.',
    type: 'boolean',
    default: true,
  },
];

@Injectable()
export class MarkdownNoteExporter implements NoteExporter, OnModuleInit {
  private readonly logger = new Logger(MarkdownNoteExporter.name);

  readonly format = 'markdown';
  readonly label = 'Markdown';
  readonly mimeType = 'text/markdown; charset=utf-8';
  readonly extension = 'md';
  readonly options = MARKDOWN_NOTE_EXPORT_OPTIONS;
  readonly optionsSchema = optionsSchemaFor(MARKDOWN_NOTE_EXPORT_OPTIONS);

  constructor(private readonly registry: NoteExporterRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async render(doc: NoteExportDocument, options: ExportOptions, out: Writable): Promise<void> {
    try {
      if (options.includeFrontMatter !== false) {
        await writeChunk(out, renderFrontMatter(doc));
      }

      await writeChunk(out, `# ${doc.title}\n\n`);
      await writeChunk(out, renderProvenanceBlock(doc));

      // ⚠ TRAILING NEWLINE NORMALISED, CONTENT UNTOUCHED. Exactly one newline
      // terminates the file regardless of how many the stored body carries, so
      // two exports of a note somebody edited only by pressing Enter at the end
      // are the same file. Nothing else about the body is altered.
      await writeChunk(out, `${doc.body.replace(/\s+$/, '')}\n`);
    } catch (error) {
      out.destroy(error instanceof Error ? error : new Error(String(error)));

      throw error;
    }

    await endStream(out);

    this.logger.debug(`Rendered note ${doc.noteId} v${doc.version} to Markdown`);
  }
}

/**
 * The YAML front matter block.
 *
 * ⚠ EVERY VALUE IS QUOTED AND ESCAPED. A note titled `Q3: the plan` written
 * unquoted would make the whole document fail to parse in any YAML reader,
 * which is a far worse outcome than a pair of redundant quotes on a value that
 * did not need them.
 */
export function renderFrontMatter(doc: NoteExportDocument): string {
  const lines = [
    '---',
    `title: ${yaml(doc.title)}`,
    `noteId: ${yaml(doc.noteId)}`,
    `version: ${doc.version}`,
    `versionSavedAt: ${yaml(doc.createdAt.toISOString())}`,
    `exportedAt: ${yaml(doc.exportedAt.toISOString())}`,
    `template: ${doc.templateName === null ? 'null' : yaml(doc.templateName)}`,
    'source:',
    `  type: ${yaml(doc.source.type)}`,
    `  id: ${yaml(doc.source.id)}`,
    `  title: ${yaml(doc.source.title)}`,
    `  date: ${doc.source.date === null ? 'null' : yaml(doc.source.date.toISOString())}`,
  ];

  if (doc.provider) {
    lines.push('generatedBy:', `  provider: ${yaml(doc.provider.id)}`);

    if (doc.provider.model) lines.push(`  model: ${yaml(doc.provider.model)}`);
  }

  if (doc.author) lines.push(`editedBy: ${yaml(doc.author.displayName)}`);

  lines.push('---', '');

  return `${lines.join('\n')}\n`;
}

/** The human-readable provenance block, as a markdown blockquote. */
export function renderProvenanceBlock(doc: NoteExportDocument): string {
  const lines = provenanceEntries(doc).map((entry) => `> **${entry.label}:** ${entry.value}`);

  return `${lines.join('\n')}\n\n`;
}

/** A double-quoted YAML scalar. */
function yaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}
