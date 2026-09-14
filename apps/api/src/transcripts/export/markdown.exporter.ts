// =============================================================================
// The Markdown export (issue #28, epic #19, spec §8.3)
// =============================================================================
//
// YAML front matter (title, date, duration, speakers, version) followed by one
// paragraph per segment: `**Speaker Name** · 00:01:23`, then the text.
//
// -----------------------------------------------------------------------------
// EVERY INTERPOLATED VALUE IS ESCAPED, AND THIS IS THE POINT OF THE FILE
// -----------------------------------------------------------------------------
//
// A speaker's `display_name` and a segment's `text` are user- or AI-originated
// TEXT, never markup. Spec §8.3 is explicit about the failure: an unescaped `*`
// in somebody's spoken words must not start emphasis that swallows the rest of
// the paragraph, and a segment beginning with `"# "` — which is exactly what a
// transcript of somebody saying "hash tag" or dictating a heading produces —
// must not become a heading in the rendered document.
//
// Two different escapes are needed, because Markdown has two different kinds of
// special character and they are special in different places:
//
//   * INLINE specials (`\ ` `` ` `` `*` `_` `[` `]` `<` `>` `|` `~`) are
//     special ANYWHERE in a line, so they are backslash-escaped everywhere.
//   * BLOCK specials (`#`, `>`, `-`, `+`, `=`, and `1.` / `1)`) are special
//     only at the START of a line. They are escaped there and left alone
//     elsewhere, because escaping every hyphen and full stop in running speech
//     produces a file that is technically correct and unreadable as plain text
//     — and plain-text readability is half of why anybody exports Markdown.
//
// The backslash goes FIRST in the inline pass. Escaping it after the others
// would double-escape the backslashes those others just inserted.
//
// -----------------------------------------------------------------------------
// THE FRONT MATTER IS YAML, WHICH IS NOT MARKDOWN
// -----------------------------------------------------------------------------
//
// Values in the front matter are double-quoted YAML scalars and escaped for
// YAML (`\` and `"`), NOT for Markdown: a `*` in a title is meaningless inside
// a quoted YAML string, whereas a backslash-escaped `\*` there would be read
// literally by every YAML parser and the title would grow visible backslashes
// in whatever tool imported the file. Two different contexts, two different
// escapes, and mixing them up is the mistake this paragraph exists to prevent.
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Writable } from 'node:stream';

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
import { endStream, writeChunk } from './export-stream';
import {
  TranscriptExporterRegistry,
  type TranscriptExporter,
} from './transcript-exporter.interface';

export const MARKDOWN_EXPORT_OPTIONS: readonly ExportOptionField[] = [
  {
    key: 'includeTimestamps',
    label: 'Include timestamps',
    description: 'Puts the media position (00:01:23) beside each speaker turn.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'mergeConsecutive',
    label: 'Merge consecutive turns',
    description:
      'Joins neighbouring segments from the same speaker into one paragraph, for a more ' +
      'prose-like read. The timestamp shown is the start of the first segment in the run.',
    type: 'boolean',
    default: false,
  },
];

/** Markdown characters that are special anywhere in a line. See the header. */
const INLINE_SPECIALS = /[\\`*_[\]<>|~]/g;

/** A line opening that would start a block. See the header. */
const BLOCK_OPENING = /^(\s*)([#>+=-]|\d+[.)])/;

@Injectable()
export class MarkdownTranscriptExporter implements TranscriptExporter, OnModuleInit {
  readonly format = 'markdown';
  readonly label = 'Markdown';
  readonly mimeType = 'text/markdown; charset=utf-8';
  readonly extension = 'md';
  readonly options = MARKDOWN_EXPORT_OPTIONS;
  readonly optionsSchema = optionsSchemaFor(MARKDOWN_EXPORT_OPTIONS);

  constructor(private readonly registry: TranscriptExporterRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async render(doc: ExportDocument, options: ExportOptions, out: Writable): Promise<void> {
    const includeTimestamps = options.includeTimestamps !== false;
    const merge = options.mergeConsecutive === true;
    const speakers = speakerIndex(doc);

    await writeChunk(out, renderFrontMatter(doc));
    await writeChunk(out, `# ${escapeMarkdown(doc.title)}\n\n`);

    for (const turn of groupTurns(doc, merge)) {
      const name = speakers.get(turn.speakerId)?.displayName ?? 'Unknown speaker';
      const heading = includeTimestamps
        ? `**${escapeMarkdown(name)}** · ${formatTimestamp(turn.startMs)}`
        : `**${escapeMarkdown(name)}**`;

      await writeChunk(out, `${heading}\n\n${escapeMarkdown(turn.text)}\n\n`);
    }

    await endStream(out);
  }
}

/** One speaker turn: a segment, or a run of them when merging. */
export interface MarkdownTurn {
  speakerId: string;
  startMs: number;
  text: string;
}

/**
 * The document's segments as turns.
 *
 * With `merge` off this is one turn per segment. With it on, CONSECUTIVE
 * segments sharing a speaker collapse into one paragraph whose timestamp is the
 * FIRST segment's — which is the only defensible choice: a merged paragraph
 * spans a range, and labelling it with the last segment's start would put a
 * timestamp on the page that points at the middle of the text beside it.
 *
 * Segment texts are joined with a single space rather than a newline: inside a
 * Markdown paragraph a single newline is not a line break anyway, so the space
 * is what the rendered output would show either way, and it keeps the raw file
 * honest about being one paragraph.
 */
export function groupTurns(doc: ExportDocument, merge: boolean): MarkdownTurn[] {
  const turns: MarkdownTurn[] = [];

  for (const segment of doc.segments) {
    const previous = turns[turns.length - 1];

    if (merge && previous && previous.speakerId === segment.speakerId) {
      previous.text = `${previous.text} ${segment.text}`.trim();

      continue;
    }

    turns.push({
      speakerId: segment.speakerId,
      startMs: segment.startMs,
      text: segment.text.trim(),
    });
  }

  return turns;
}

/** The YAML block, including its `---` fences and a trailing blank line. */
export function renderFrontMatter(doc: ExportDocument): string {
  const lines = [
    '---',
    `title: ${yamlString(doc.title)}`,
    `date: ${yamlString(doc.createdAt.toISOString())}`,
    `duration: ${yamlString(formatDuration(doc.durationMs))}`,
    `durationMs: ${doc.durationMs}`,
    `version: ${doc.version}`,
  ];

  if (doc.language !== null) lines.push(`language: ${yamlString(doc.language)}`);

  if (doc.author) lines.push(`author: ${yamlString(doc.author.displayName)}`);

  lines.push('speakers:');

  for (const speaker of doc.speakers) {
    lines.push(`  - ${yamlString(speaker.displayName)}`);
  }

  lines.push(`exportedAt: ${yamlString(doc.exportedAt.toISOString())}`);
  lines.push('---', '');

  return `${lines.join('\n')}\n`;
}

/**
 * A YAML double-quoted scalar.
 *
 * Quoted ALWAYS, even for a value that would be a legal plain scalar. A title
 * of `yes`, `null`, `2026-01-01` or `12:30` is read by a YAML parser as a
 * boolean, a null, a date and a sexagesimal integer respectively — and every
 * one of those is a real thing somebody names a recording. Quoting
 * unconditionally removes the whole class rather than the members of it
 * somebody thought to enumerate.
 */
export function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * Escape user text for Markdown. See the file header for the two passes.
 *
 * Total over multi-line input: each line gets the block-opening treatment on
 * its own, because "start of a line" is a per-line property and a segment whose
 * text contains a newline is legal.
 */
export function escapeMarkdown(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(INLINE_SPECIALS, (match) => `\\${match}`))
    .map((line) => line.replace(BLOCK_OPENING, (_match, space: string, token: string) => `${space}\\${token}`))
    .join('\n');
}
