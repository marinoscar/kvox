import {
  TRANSCRIPT_IMPORT_MAX_ISSUES,
  type TranscriptDocumentV1,
} from '@marinoscar/kvox-contract/transcripts';

import { ORDINAL_GAP } from '../../../src/transcripts/editing/ordinals.js';
import {
  TRANSCRIPT_IMPORT_MAX_OFFSET_MS,
  parseTranscriptImport,
  planTranscriptImport,
  type TranscriptImportParseResult,
} from '../../../src/transcripts/import/transcript-import.js';
import { importFixtureDocument } from '../../../src/transcripts/testing/import-fixtures.js';

// =============================================================================
// The JSON import's pure half (issue #571): every 400 reason, and the mapping of a
// valid file onto rows (speakers and identities, ordinals, words, recordedAt).
// =============================================================================

const NOW = new Date('2026-10-01T00:00:00.000Z');

function parse(value: unknown): TranscriptImportParseResult {
  return parseTranscriptImport(typeof value === 'string' ? value : JSON.stringify(value), { now: NOW });
}

function reasonOf(value: unknown): string | undefined {
  const result = parse(value);

  return result.ok ? undefined : result.reason;
}

function accepted(value: unknown): TranscriptDocumentV1 {
  const result = parse(value);

  if (!result.ok) throw new Error(`refused: ${result.reason} ${JSON.stringify(result.issues)}`);

  return result.document;
}

/** A document with `edit` applied to its (mutable) JSON form. */
function edited(edit: (doc: any) => void): unknown {
  const doc = JSON.parse(JSON.stringify(importFixtureDocument())) as any;

  edit(doc);

  return doc;
}

describe('parseTranscriptImport', () => {
  it('accepts the fixture, as bytes and as text, with or without a BOM', () => {
    const json = JSON.stringify(importFixtureDocument());

    expect(parseTranscriptImport(Buffer.from(json), { now: NOW }).ok).toBe(true);
    expect(parseTranscriptImport(json, { now: NOW }).ok).toBe(true);
    expect(parseTranscriptImport(`﻿${json}`, { now: NOW }).ok).toBe(true);
  });

  describe('not_json', () => {
    it.each([
      ['garbage', 'this is not json'],
      ['an empty file', ''],
      ['truncated JSON', '{"schema": "kvox.transcript/v1", "transcript": {'],
    ])('refuses %s', (_name, body) => {
      expect(reasonOf(body)).toBe('not_json');
    });

    it('refuses bytes that are not UTF-8', () => {
      const result = parseTranscriptImport(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { now: NOW });

      expect(result.ok ? undefined : result.reason).toBe('not_json');
    });
  });

  describe('unsupported_schema', () => {
    it.each([
      ['an array', []],
      ['a number', 42],
      ['null', null],
      ['an object with no schema field (a foreign export)', { nodes: [], edges: [] }],
    ])('refuses %s', (_name, value) => {
      expect(reasonOf(value)).toBe('unsupported_schema');
    });

    it('refuses a later version before looking at its shape, and echoes the identifier', () => {
      const result = parse({ schema: 'kvox.transcript/v2', anything: true });

      expect(result).toMatchObject({ ok: false, reason: 'unsupported_schema', schema: 'kvox.transcript/v2' });
    });
  });

  describe('invalid_document', () => {
    it.each([
      ['an extra top-level property', (d: any) => (d.extra = true)],
      ['an extra transcript property', (d: any) => (d.transcript.colorIndex = 1)],
      ['an extra speaker property', (d: any) => (d.transcript.speakers[0].label = 'A')],
      ['an extra segment property', (d: any) => (d.transcript.segments[0].ordinal = 1000)],
      ['an extra word property', (d: any) => (d.transcript.segments[0].words[0].x = 1)],
      ['a missing required field', (d: any) => delete d.transcript.title],
      ['a fractional offset', (d: any) => (d.transcript.segments[1].startMs = 1.5)],
      ['a negative offset', (d: any) => (d.transcript.segments[1].startMs = -1)],
      ['a confidence above 1', (d: any) => (d.transcript.segments[0].confidence = 2)],
      ['an unknown alignment', (d: any) => (d.transcript.segments[0].wordsAlignment = 'roughly')],
      ['an offset past what the column holds', (d: any) => (d.transcript.segments[2].endMs = TRANSCRIPT_IMPORT_MAX_OFFSET_MS + 1)],
      ['a duration past what the column holds', (d: any) => (d.transcript.durationMs = TRANSCRIPT_IMPORT_MAX_OFFSET_MS + 1)],
      ['a segment that ends before it starts', (d: any) => (d.transcript.segments[1].endMs = 2_000)],
      ['a recording date in the future', (d: any) => (d.transcript.recordedAt = '2027-01-01T00:00:00.000Z')],
      ['a recording date before 1970', (d: any) => (d.transcript.recordedAt = '1969-12-31T23:59:59.000Z')],
      ['a speaker name too long to rename', (d: any) => (d.transcript.speakers[0].displayName = 'x'.repeat(121))],
    ])('refuses %s', (_name, edit) => {
      expect(reasonOf(edited(edit))).toBe('invalid_document');
    });

    it('names where each problem is, bounded', () => {
      const result = parse(
        edited((d) => {
          d.transcript.segments = Array.from({ length: 50 }, (_, i) => ({
            id: `s${i}`,
            speakerId: 'spk_1',
            startMs: -1,
            endMs: 0,
            text: '',
          }));
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.issues?.length).toBe(TRANSCRIPT_IMPORT_MAX_ISSUES);
      expect(result.issues?.[0]).toEqual({ path: 'transcript.segments.0.startMs', message: expect.any(String) });
    });
  });

  it('refuses two speakers, or two segments, with one id (duplicate_id)', () => {
    expect(reasonOf(edited((d) => (d.transcript.speakers[1].id = 'spk_1')))).toBe('duplicate_id');

    const result = parse(edited((d) => (d.transcript.segments[2].id = 'seg_1')));

    expect(result).toMatchObject({
      ok: false,
      reason: 'duplicate_id',
      issues: [{ path: 'transcript.segments.2.id', message: expect.any(String) }],
    });
  });

  it('refuses a segment naming an undeclared speaker (unknown_speaker)', () => {
    const result = parse(edited((d) => (d.transcript.segments[1].speakerId = 'spk_9')));

    expect(result).toMatchObject({
      ok: false,
      reason: 'unknown_speaker',
      issues: [{ path: 'transcript.segments.1.speakerId', message: expect.any(String) }],
    });
  });

  it('refuses a document with no segments (empty_transcript)', () => {
    expect(reasonOf(edited((d) => (d.transcript.segments = [])))).toBe('empty_transcript');
  });
});

describe('planTranscriptImport', () => {
  it('maps the transcript columns: title, language, duration, counts', () => {
    const plan = planTranscriptImport(accepted(importFixtureDocument()));

    expect(plan).toMatchObject({
      title: 'Planning sync',
      language: 'en',
      // The last segment ends at 9.5 s, past the file's 9 s duration.
      durationMs: 9_500,
      speakerCount: 2,
      // Three timed words, then four and four tokens.
      wordCount: 11,
      importedFrom: {
        schema: 'kvox.transcript/v1',
        sourceTranscriptId: 'tr_source_1',
        sourceVersion: 3,
        sourceProvider: { id: 'assemblyai', model: 'best' },
      },
    });
  });

  it('falls back to a default title and a null language', () => {
    const plan = planTranscriptImport(
      accepted(edited((d) => ((d.transcript.title = '   '), (d.transcript.language = null)))),
    );

    expect(plan.title).toBe('Imported transcript');
    expect(plan.language).toBeNull();
  });

  it('takes recordedAt from the file', () => {
    const plan = planTranscriptImport(accepted(importFixtureDocument()));

    expect(plan.recordedAt.toISOString()).toBe('2026-09-10T14:00:00.000Z');
  });

  it('falls back to createdAt for a file exported before recordedAt existed', () => {
    const plan = planTranscriptImport(accepted(edited((d) => delete d.transcript.recordedAt)));

    expect(plan.recordedAt.toISOString()).toBe('2026-09-10T15:00:00.000Z');
  });

  it('labels a placeholder speaker by its own label and a named one with a free letter and an identity', () => {
    const plan = planTranscriptImport(accepted(importFixtureDocument()));

    expect(plan.speakers).toEqual([
      { key: 'spk_1', label: 'A', displayName: 'Dana Example', colorIndex: 0, identity: 'Dana Example' },
      { key: 'spk_2', label: 'B', displayName: 'Speaker B', colorIndex: 1, identity: null },
    ]);
  });

  it('never gives two speakers one label, and keeps a blank or duplicated placeholder unnamed', () => {
    const plan = planTranscriptImport(
      accepted(
        edited((d) => {
          d.transcript.speakers = [
            { id: 'a', displayName: 'Speaker A' },
            { id: 'b', displayName: 'Speaker A' },
            { id: 'c', displayName: '  ' },
            { id: 'd', displayName: 'Speaker Alpha' },
          ];
          d.transcript.segments[0].speakerId = 'a';
          d.transcript.segments[1].speakerId = 'b';
          d.transcript.segments[2].speakerId = 'c';
        }),
      ),
    );

    expect(plan.speakers.map(({ label, displayName, identity }) => ({ label, displayName, identity }))).toEqual([
      { label: 'A', displayName: 'Speaker A', identity: null },
      { label: 'B', displayName: 'Speaker B', identity: null },
      { label: 'C', displayName: 'Speaker C', identity: null },
      { label: 'Alpha', displayName: 'Speaker Alpha', identity: null },
    ]);
    expect(new Set(plan.speakers.map((s) => s.label)).size).toBe(4);
  });

  it('gives segments gap-based ordinals in file order', () => {
    const plan = planTranscriptImport(accepted(importFixtureDocument()));

    expect(plan.segments.map((s) => s.ordinal)).toEqual([ORDINAL_GAP, 2 * ORDINAL_GAP, 3 * ORDINAL_GAP]);
    expect(plan.segments.map((s) => s.speakerKey)).toEqual(['spk_1', 'spk_2', 'spk_1']);
    expect(plan.segments.every((s) => s.origin === 'ai')).toBe(true);
  });

  it('stores the file\'s words in the column\'s terse shape, with the file\'s alignment', () => {
    const [first] = planTranscriptImport(accepted(importFixtureDocument())).segments;

    expect(first.words).toEqual([
      { t: 'Good', s: 0, e: 500, c: 0.9 },
      { t: 'morning,', s: 600, e: 1_400, c: 0.95 },
      { t: 'everyone.', s: 1_500, e: 3_000, c: null },
    ]);
    expect(first.wordsAlignment).toBe('exact');
    expect(first.confidence).toBe(0.9);
  });

  it('stores no words when the file has none: its alignment if it says one, else none', () => {
    const [, second, third] = planTranscriptImport(accepted(importFixtureDocument())).segments;

    expect(second).toMatchObject({ words: [], wordsAlignment: 'none', confidence: null });
    expect(third).toMatchObject({ words: [], wordsAlignment: 'interpolated' });
  });

  it('defaults to exact when the file has words but names no alignment', () => {
    const plan = planTranscriptImport(accepted(edited((d) => delete d.transcript.segments[0].wordsAlignment)));

    expect(plan.segments[0].wordsAlignment).toBe('exact');
  });
});
