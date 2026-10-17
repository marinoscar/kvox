import { z } from 'zod';

import { noteResponseSchema } from './note.js';

// =============================================================================
// Note import: reading a KVox note Markdown export back (issue #585)
// =============================================================================
//
// `POST /api/notes/import` takes the file the Markdown note exporter writes and
// creates the same note again: same title, same body. The reading lives here,
// pure and dependency-free, so the API slice and every host that needs to know
// "is this a KVox note export?" (KVox Desktop routes a dropped file by it)
// share ONE definition of the format instead of each growing a parser.
//
// THE FORMAT, as the exporter writes it (`markdown.exporter.ts`):
//
//   ---                                  ┐
//   schema: "kvox.note/v1"               │ YAML front matter, optional
//   title: "Q3 planning"                 │ (`includeFrontMatter: false` leaves
//   bodyFormat: "markdown"               │ it out). Every value double-quoted,
//   noteId: "…"                          │ `null`, or a bare number; `source`
//   …                                    │ and `generatedBy` nest one level.
//   source:                              │
//     type: "transcript"                 │
//   ---                                  ┘
//   # Q3 planning                        ← the title as a heading
//
//   > **Source:** …                      ← the human provenance block
//   > **Template:** …
//
//   <the body, byte-faithful, one trailing newline>
//
// WHAT IS LENIENT AND WHAT IS NOT:
//   - A file with no front matter is still importable: any Markdown or text
//     becomes a note whose title is its leading `# heading` (else the file
//     name). That keeps exports written before `schema` existed, and exports
//     without front matter, importable as plain-body notes.
//   - Front matter that is OPENED but never closed, or has a line that is not
//     `key: value`, is refused (`invalid_front_matter`): guessing where it ends
//     would import half a YAML block as the note's first paragraph.
//   - A `schema` naming a later version (`kvox.note/v2`) is refused
//     (`unsupported_note_format`) rather than read as v1.
//   - The provenance block is stripped ONLY right after the title heading, and
//     only when its first line is the exporter's `> **Source:**`: a note whose
//     own body opens with a quote keeps it.
// =============================================================================

/**
 * The format identifier the Markdown note export writes in its front matter (`schema:`).
 * Permanent: a v2 is a new identifier, never this one renumbered.
 *
 * @stability experimental
 */
export const NOTE_MARKDOWN_EXPORT_SCHEMA = 'kvox.note/v1';

/**
 * `details.reason` on a 400 from `POST /api/notes/import`. Every value is in the error
 * catalogue (`@marinoscar/kvox-contract/errors`). Append-only.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_FAILURE_REASONS = {
  /** The file is not UTF-8 text (a binary file, or another encoding). */
  NOT_TEXT: 'not_text',
  /** The file opens a front matter block that is not closed or not `key: value` lines. */
  INVALID_FRONT_MATTER: 'invalid_front_matter',
  /** The front matter names a note format this version cannot read (`kvox.note/v2`, or another `schema`). */
  UNSUPPORTED_NOTE_FORMAT: 'unsupported_note_format',
  /** Nothing is left once the front matter, title and provenance are read: the note would be empty. */
  EMPTY_NOTE: 'empty_note',
} as const;

/**
 * A value of {@link NOTE_IMPORT_FAILURE_REASONS}.
 *
 * @stability experimental
 */
export type NoteImportFailureReason =
  (typeof NOTE_IMPORT_FAILURE_REASONS)[keyof typeof NOTE_IMPORT_FAILURE_REASONS];

/**
 * The source an exported note names in its front matter (provenance only: an import never
 * links to it, since the id belongs to another deployment).
 *
 * @stability experimental
 */
export interface NoteImportSourceRef {
  /** `transcript`, `note` or `document`, as the export wrote it. */
  type: string | null;
  /** The source's id in the deployment that exported the note. */
  id: string | null;
  /** The source's title or file name. */
  title: string | null;
  /** When the source was recorded or created, as an ISO string. */
  date: string | null;
}

/**
 * What {@link parseNoteMarkdownExport} read from a file.
 *
 * @stability experimental
 */
export interface ParsedNoteImport {
  /** The note's title: the front matter's, else the leading heading's, else the fallback. */
  title: string;
  /** The body, trailing whitespace removed (the exporter normalises it the same way). */
  body: string;
  /** How the body is written. `markdown` unless the front matter says `plain_text`. */
  bodyFormat: 'markdown' | 'plain_text';
  /** True when the file carries KVox front matter (a `schema`, or the exporter's `noteId` and `exportedAt`). */
  kvoxExport: boolean;
  /** Provenance from the front matter, when present. */
  provenance: {
    noteId: string | null;
    version: number | null;
    versionSavedAt: string | null;
    exportedAt: string | null;
    templateName: string | null;
    source: NoteImportSourceRef | null;
  };
}

/**
 * A refused file.
 *
 * @stability experimental
 */
export interface NoteImportFailure {
  ok: false;
  reason: NoteImportFailureReason;
  /** A sentence a person can read. */
  message: string;
  /** The foreign `schema` value, for `unsupported_note_format`. */
  schema?: string;
  /** The 1-based line of the front matter that could not be read, for `invalid_front_matter`. */
  line?: number;
}

/**
 * The outcome of {@link parseNoteMarkdownExport}.
 *
 * @stability experimental
 */
export type NoteImportParseResult = { ok: true; note: ParsedNoteImport } | NoteImportFailure;

/** The longest title an import keeps (the notes table's limit for a title a person types). */
const MAX_IMPORTED_TITLE_CHARS = 200;

type FrontMatterValue = string | number | null | { [key: string]: string | number | null };

/** Reads one scalar the exporter writes: `"quoted"`, `null`, a number, or a bare word. */
function scalar(raw: string): string | number | null {
  const value = raw.trim();
  if (value === 'null' || value === '~' || value === '') return null;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:\s(.*))?$/;

/** The front matter's lines, as a one-level-nested map, or the 0-based index of a bad line. */
function readFrontMatter(lines: readonly string[]): { ok: true; map: Map<string, FrontMatterValue> } | { ok: false; index: number } {
  const map = new Map<string, FrontMatterValue>();
  let parent: { [key: string]: string | number | null } | null = null;

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    if (/^\s+/.test(line)) {
      const nested = KEY_LINE.exec(line.trim());
      if (!nested || parent === null) return { ok: false, index };
      parent[nested[1]] = scalar(nested[2] ?? '');
      continue;
    }

    const match = KEY_LINE.exec(line);
    if (!match) return { ok: false, index };

    const rest = match[2]?.trim() ?? '';
    if (rest === '') {
      parent = {};
      map.set(match[1], parent);
    } else {
      parent = null;
      map.set(match[1], scalar(rest));
    }
  }

  return { ok: true, map };
}

function text(value: FrontMatterValue | undefined): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** Splits `text` into lines, accepting `\r\n`. */
function splitLines(content: string): string[] {
  return content.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * The title a file name gives a note when the file names none: the name without its
 * extension, or `Imported note`.
 *
 * @param filename - the uploaded file's name.
 * @returns a non-empty title.
 * @stability experimental
 */
export function titleFromFilename(filename: string | null | undefined): string {
  const base = (filename ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '').trim();
  return stem.length > 0 ? stem.slice(0, MAX_IMPORTED_TITLE_CHARS) : 'Imported note';
}

/**
 * Reads a KVox note Markdown export (or any Markdown or text file) into the note it
 * describes. Pure and total: every input gets an answer.
 *
 * @param content - the file, decoded as UTF-8.
 * @param options - `filename`, the fallback for the title when the file names none.
 * @returns the note, or a typed refusal.
 * @stability experimental
 */
export function parseNoteMarkdownExport(
  content: string,
  options: { filename?: string } = {},
): NoteImportParseResult {
  let lines = splitLines(content.replace(/^\uFEFF/, ''));
  let fields = new Map<string, FrontMatterValue>();

  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && (line.trim() === '---' || line.trim() === '...'));
    if (close === -1) {
      return {
        ok: false,
        reason: NOTE_IMPORT_FAILURE_REASONS.INVALID_FRONT_MATTER,
        message: 'The file opens a front matter block (---) that is never closed.',
        line: 1,
      };
    }
    const read = readFrontMatter(lines.slice(1, close));
    if (!read.ok) {
      return {
        ok: false,
        reason: NOTE_IMPORT_FAILURE_REASONS.INVALID_FRONT_MATTER,
        message: `Line ${read.index + 2} of the front matter is not a "key: value" line.`,
        line: read.index + 2,
      };
    }
    fields = read.map;
    lines = lines.slice(close + 1);
  }

  const schema = text(fields.get('schema'));
  if (schema !== null && schema !== NOTE_MARKDOWN_EXPORT_SCHEMA) {
    return {
      ok: false,
      reason: NOTE_IMPORT_FAILURE_REASONS.UNSUPPORTED_NOTE_FORMAT,
      message: `This file is a "${schema}" note, which this version of KVox cannot read (it reads "${NOTE_MARKDOWN_EXPORT_SCHEMA}").`,
      schema,
    };
  }
  const kvoxExport = schema !== null || (fields.has('noteId') && fields.has('exportedAt'));

  // The title heading, then the provenance block, each followed by blank lines.
  let cursor = 0;
  const skipBlank = () => {
    while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
  };
  skipBlank();
  let headingTitle: string | null = null;
  const heading = /^#\s+(.+?)\s*#*\s*$/.exec(lines[cursor] ?? '');
  if (heading) {
    headingTitle = heading[1];
    cursor += 1;
    skipBlank();
    if (/^>\s*\*\*Source:\*\*/.test(lines[cursor] ?? '')) {
      while (cursor < lines.length && lines[cursor].startsWith('>')) cursor += 1;
      skipBlank();
    }
  }

  const body = lines.slice(cursor).join('\n').replace(/\s+$/, '');
  if (body.length === 0) {
    return {
      ok: false,
      reason: NOTE_IMPORT_FAILURE_REASONS.EMPTY_NOTE,
      message: 'The file holds no note text once its title and header are read.',
    };
  }

  const frontTitle = text(fields.get('title'))?.trim() || null;
  const title = (frontTitle ?? headingTitle?.trim() ?? titleFromFilename(options.filename)).slice(0, MAX_IMPORTED_TITLE_CHARS);
  const source = fields.get('source');
  const sourceRef =
    source !== null && typeof source === 'object'
      ? { type: text(source.type), id: text(source.id), title: text(source.title), date: text(source.date) }
      : null;
  const version = fields.get('version');

  return {
    ok: true,
    note: {
      title: title.length > 0 ? title : titleFromFilename(options.filename),
      body,
      bodyFormat: text(fields.get('bodyFormat')) === 'plain_text' ? 'plain_text' : 'markdown',
      kvoxExport,
      provenance: {
        noteId: text(fields.get('noteId')),
        version: typeof version === 'number' && Number.isInteger(version) ? version : null,
        versionSavedAt: text(fields.get('versionSavedAt')),
        exportedAt: text(fields.get('exportedAt')),
        templateName: text(fields.get('template')),
        source: sourceRef,
      },
    },
  };
}

/**
 * The answer of `POST /api/notes/import` (inside the `{ data }` envelope): the new note
 * exactly as `GET /api/notes/:id` returns it.
 *
 * @stability experimental
 */
export const noteImportResponseSchema = noteResponseSchema;

/**
 * The parsed shape of {@link noteImportResponseSchema}.
 *
 * @stability experimental
 */
export type NoteImportResponse = z.infer<typeof noteImportResponseSchema>;

// =============================================================================
// Which import a file is: content first, the name only to break a tie
// =============================================================================

/**
 * What a local file is, as an import: which route takes it and the media type to send it as.
 *
 * - `transcript_json`: JSON (a `kvox.transcript/v1` export, or any JSON, which the
 *   transcript import refuses with its own typed 400).
 * - `note_markdown`: a KVox note Markdown export (front matter with `schema: kvox.note/v1`,
 *   or the exporter's `noteId` and `exportedAt`).
 * - `document_pdf`, `document_text`: a note source document (PDF, Markdown or text).
 * - `unsupported`: anything else (audio, video, an image); sent to the document route
 *   as `application/octet-stream`, which refuses it with the accepted list.
 *
 * @stability experimental
 */
export type KvoxImportKind = 'transcript_json' | 'note_markdown' | 'document_pdf' | 'document_text' | 'unsupported';

/**
 * The route each import kind is sent to (relative to `/api`), multipart with one `file`
 * part. No host keeps its own copy of this table.
 *
 * @stability experimental
 */
export const KVOX_IMPORT_ROUTES: Readonly<Record<KvoxImportKind, string>> = {
  transcript_json: '/transcripts/imports',
  note_markdown: '/notes/import',
  document_pdf: '/notes/sources/documents',
  document_text: '/notes/sources/documents',
  unsupported: '/notes/sources/documents',
};

/**
 * How a host should send one file.
 *
 * @stability experimental
 */
export interface KvoxImportTarget {
  kind: KvoxImportKind;
  /** The route, relative to `/api` (see {@link KVOX_IMPORT_ROUTES}). */
  route: string;
  /** The media type to declare on the multipart part. */
  mimeType: string;
}

/**
 * How many leading bytes {@link detectKvoxImport} needs to decide.
 *
 * @stability experimental
 */
export const KVOX_IMPORT_SNIFF_BYTES = 4096;

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'text']);

/** True when the bytes read as UTF-8 text: no NUL, no invalid sequence except a cut-off last character. */
function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head);
    return true;
  } catch {
    // The sniff window may cut a multi-byte character in two: retry without the last 3 bytes.
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 3)));
      return head.length > 3;
    } catch {
      return false;
    }
  }
}

/**
 * Decides which import a local file is, from its first bytes (at least
 * {@link KVOX_IMPORT_SNIFF_BYTES}, or the whole file when shorter) and its name. The
 * content decides; the extension only separates Markdown from plain text.
 *
 * @param input - `filename` and `head`, the file's leading bytes.
 * @returns the route and media type to send the file with.
 * @stability experimental
 */
export function detectKvoxImport(input: { filename: string; head: Uint8Array }): KvoxImportTarget {
  const { head } = input;
  const extension = /\.([^./\\]+)$/.exec(input.filename)?.[1]?.toLowerCase() ?? '';
  const target = (kind: KvoxImportKind, mimeType: string): KvoxImportTarget => ({ kind, route: KVOX_IMPORT_ROUTES[kind], mimeType });

  if (head.length >= 5 && String.fromCharCode(...head.subarray(0, 5)) === '%PDF-') {
    return target('document_pdf', 'application/pdf');
  }
  if (!looksLikeText(head)) return target('unsupported', 'application/octet-stream');

  const content = new TextDecoder('utf-8').decode(head).replace(/^\uFEFF/, '');
  const trimmed = content.trimStart();

  if (trimmed.startsWith('{') || trimmed.startsWith('[') || extension === 'json') {
    return target('transcript_json', 'application/json');
  }

  if (/^---\r?\n/.test(content)) {
    const close = /\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(content.slice(3));
    const frontMatter = close ? content.slice(3, 3 + close.index) : content.slice(3);
    const schema = /^schema:\s*["']?([^"'\r\n]+)/m.exec(frontMatter)?.[1]?.trim();
    const exporterKeys = /^noteId:/m.test(frontMatter) && /^exportedAt:/m.test(frontMatter);
    if ((schema !== undefined && schema.startsWith('kvox.note/')) || (schema === undefined && exporterKeys)) {
      return target('note_markdown', 'text/markdown');
    }
  }

  if (extension === 'md' || extension === 'markdown') return target('document_text', 'text/markdown');
  if (TEXT_EXTENSIONS.has(extension) || extension === '') return target('document_text', 'text/plain');
  // Text with another extension (`.csv`, `.log`, `.vtt`): a plain-text source.
  return target('document_text', 'text/plain');
}
