import { describe, expect, it } from 'vitest';

import {
  KVOX_IMPORT_ROUTES,
  NOTE_IMPORT_FAILURE_REASONS,
  NOTE_MARKDOWN_EXPORT_SCHEMA,
  detectKvoxImport,
  parseNoteMarkdownExport,
  titleFromFilename,
} from '../src/notes/index.js';

// =============================================================================
// Reading a note Markdown export back, and sniffing an import (issue #585)
// =============================================================================

/** What the Markdown exporter writes (markdown.exporter.ts), synthetic content. */
const EXPORT = [
  '---',
  `schema: "${NOTE_MARKDOWN_EXPORT_SCHEMA}"`,
  'title: "Q3: the \\"big\\" plan"',
  'bodyFormat: "markdown"',
  'noteId: "0b7e7d4c-1111-4111-8111-111111111111"',
  'version: 3',
  'versionSavedAt: "2026-09-12T10:00:00.000Z"',
  'exportedAt: "2026-09-14T04:37:11.000Z"',
  'template: "Concise Meeting Notes"',
  'source:',
  '  type: "transcript"',
  '  id: "tr_1"',
  '  title: "Weekly Sync"',
  '  date: null',
  'generatedBy:',
  '  provider: "openai"',
  '---',
  '',
  '# Q3: the "big" plan',
  '',
  '> **Source:** Weekly Sync (transcript)',
  '> **Template:** Concise Meeting Notes',
  '> **Exported:** 2026-09-14T04:37:11.000Z',
  '',
  '## Decisions',
  '',
  '> A quote the author wrote.',
  '',
  '- Ship it',
  '',
].join('\n');

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('parseNoteMarkdownExport', () => {
  it('reads the title, the body and the provenance of an export, without the header', () => {
    const result = parseNoteMarkdownExport(EXPORT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note).toEqual({
      title: 'Q3: the "big" plan',
      body: '## Decisions\n\n> A quote the author wrote.\n\n- Ship it',
      bodyFormat: 'markdown',
      kvoxExport: true,
      provenance: {
        noteId: '0b7e7d4c-1111-4111-8111-111111111111',
        version: 3,
        versionSavedAt: '2026-09-12T10:00:00.000Z',
        exportedAt: '2026-09-14T04:37:11.000Z',
        templateName: 'Concise Meeting Notes',
        source: { type: 'transcript', id: 'tr_1', title: 'Weekly Sync', date: null },
      },
    });
  });

  it('accepts CRLF line endings and a byte-order mark', () => {
    const result = parseNoteMarkdownExport(`\uFEFF${EXPORT.replace(/\n/g, '\r\n')}`);

    expect(result.ok && result.note.title).toBe('Q3: the "big" plan');
    expect(result.ok && result.note.body).toBe('## Decisions\r\n\r\n> A quote the author wrote.\r\n\r\n- Ship it'.replace(/\r/g, ''));
  });

  it('reads an export written before the schema line as a KVox export', () => {
    const result = parseNoteMarkdownExport(EXPORT.replace(/^schema: .*\n/m, '').replace(/^bodyFormat: .*\n/m, ''));

    expect(result.ok && result.note.kvoxExport).toBe(true);
    expect(result.ok && result.note.bodyFormat).toBe('markdown');
  });

  it('reads an export without front matter as a plain-body note titled by its heading', () => {
    const withoutFront = EXPORT.slice(EXPORT.indexOf('# Q3'));
    const result = parseNoteMarkdownExport(withoutFront);

    expect(result.ok && result.note).toMatchObject({
      title: 'Q3: the "big" plan',
      body: '## Decisions\n\n> A quote the author wrote.\n\n- Ship it',
      kvoxExport: false,
    });
  });

  it('titles a file with no heading after its name, and keeps its whole text', () => {
    const result = parseNoteMarkdownExport('Just a line.\n\nAnother.\n', { filename: 'C:\\notes\\stand-up.txt' });

    expect(result.ok && result.note).toMatchObject({ title: 'stand-up', body: 'Just a line.\n\nAnother.' });
  });

  it('keeps a quote that opens the body when it is not the exporter provenance', () => {
    const result = parseNoteMarkdownExport('# Title\n\n> Quoted first line\n\nText\n');

    expect(result.ok && result.note.body).toBe('> Quoted first line\n\nText');
  });

  it('reads bodyFormat plain_text', () => {
    const result = parseNoteMarkdownExport(EXPORT.replace('bodyFormat: "markdown"', 'bodyFormat: "plain_text"'));

    expect(result.ok && result.note.bodyFormat).toBe('plain_text');
  });

  it('refuses front matter that is never closed', () => {
    expect(parseNoteMarkdownExport('---\ntitle: "x"\n\nbody')).toMatchObject({
      ok: false,
      reason: NOTE_IMPORT_FAILURE_REASONS.INVALID_FRONT_MATTER,
      line: 1,
    });
  });

  it('refuses a front matter line that is not key: value, naming the line', () => {
    expect(parseNoteMarkdownExport('---\ntitle: "x"\nthis is not yaml\n---\nbody')).toMatchObject({
      ok: false,
      reason: NOTE_IMPORT_FAILURE_REASONS.INVALID_FRONT_MATTER,
      line: 3,
    });
  });

  it('refuses a later note format', () => {
    expect(parseNoteMarkdownExport(EXPORT.replace('kvox.note/v1', 'kvox.note/v2'))).toMatchObject({
      ok: false,
      reason: NOTE_IMPORT_FAILURE_REASONS.UNSUPPORTED_NOTE_FORMAT,
      schema: 'kvox.note/v2',
    });
  });

  it('refuses a file with no note text', () => {
    expect(parseNoteMarkdownExport('---\ntitle: "x"\n---\n# x\n\n> **Source:** y\n')).toMatchObject({
      ok: false,
      reason: NOTE_IMPORT_FAILURE_REASONS.EMPTY_NOTE,
    });
    expect(parseNoteMarkdownExport('  \n\n')).toMatchObject({ ok: false, reason: 'empty_note' });
  });

  it('falls back to a generic title for a nameless file', () => {
    expect(titleFromFilename('')).toBe('Imported note');
    expect(titleFromFilename('/tmp/.md')).toBe('Imported note');
    expect(titleFromFilename('a/b/report.final.md')).toBe('report.final');
  });
});

describe('detectKvoxImport', () => {
  it('routes a PDF by its magic bytes, whatever its name', () => {
    expect(detectKvoxImport({ filename: 'transcript.txt', head: bytes('%PDF-1.7\n%âãÏÓ') })).toEqual({
      kind: 'document_pdf',
      route: '/notes/sources/documents',
      mimeType: 'application/pdf',
    });
  });

  it('routes JSON to the transcript import, a v1 export or not', () => {
    const v1 = bytes('  {"schema": "kvox.transcript/v1", "transcript": {');
    expect(detectKvoxImport({ filename: 'export.json', head: v1 })).toEqual({
      kind: 'transcript_json',
      route: '/transcripts/imports',
      mimeType: 'application/json',
    });
    expect(detectKvoxImport({ filename: 'foreign.dat', head: bytes('{"nodes": []}') }).kind).toBe('transcript_json');
  });

  it('routes a note export by its front matter, even named .txt', () => {
    expect(detectKvoxImport({ filename: 'note.txt', head: bytes(EXPORT) })).toEqual({
      kind: 'note_markdown',
      route: '/notes/import',
      mimeType: 'text/markdown',
    });
    const legacy = EXPORT.replace(/^schema: .*\n/m, '');
    expect(detectKvoxImport({ filename: 'note.md', head: bytes(legacy) }).kind).toBe('note_markdown');
  });

  it('routes Markdown with foreign front matter, and plain text, as a note source', () => {
    expect(detectKvoxImport({ filename: 'post.md', head: bytes('---\nlayout: post\n---\n# Hi\n') })).toEqual({
      kind: 'document_text',
      route: '/notes/sources/documents',
      mimeType: 'text/markdown',
    });
    expect(detectKvoxImport({ filename: 'minutes.txt', head: bytes('Minutes\n') }).mimeType).toBe('text/plain');
    expect(detectKvoxImport({ filename: 'README', head: bytes('Hello') }).mimeType).toBe('text/plain');
  });

  it('sends binary files to the document route as octet-stream, which refuses them', () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
    expect(detectKvoxImport({ filename: 'meeting.mp3', head: audio })).toEqual({
      kind: 'unsupported',
      route: KVOX_IMPORT_ROUTES.unsupported,
      mimeType: 'application/octet-stream',
    });
  });

  it('accepts a sniff window that cuts a multi-byte character in two', () => {
    const text = bytes('Café notes ü');
    expect(detectKvoxImport({ filename: 'a.md', head: text.subarray(0, text.length - 1) }).kind).toBe('document_text');
  });
});
