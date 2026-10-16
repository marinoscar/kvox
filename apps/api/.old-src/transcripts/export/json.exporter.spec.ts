import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { ORDINAL_GAP } from '../editing';
import { buildExportDocument } from './export-document';
import { JsonTranscriptExporter, KVOX_TRANSCRIPT_SCHEMA_ID } from './json.exporter';
import { TranscriptExporterRegistry } from './transcript-exporter.interface';
import { fixtureDocument, fixtureSegment, fixtureSpeaker } from './__fixtures__/document';
import { renderToString } from './__fixtures__/collect';

// =============================================================================
// `kvox.transcript/v1` (issue #28, epic #19, spec §8.2)
// =============================================================================
//
// THE POINT OF THIS FILE IS THE FIRST TEST. Issue #28's acceptance list says
// "JSON output validates against the published `kvox.transcript/v1` schema",
// and the only honest way to prove that is to load
// `docs/specs/transcript-export.v1.schema.json` — the file published to the
// outside world — and validate real exporter output against it. A hand-written
// expectation of the shape would drift from the published contract silently,
// which is the exact failure the contract exists to prevent.
//
// ⚠ THE SCHEMA IS `additionalProperties: false` AT EVERY LEVEL, so this suite
// also catches the opposite mistake: a field ADDED to the output is a
// validation failure here, not a silent widening of a published contract.
//
// `ajv` is resolved from the workspace root, where it is hoisted as a
// transitive dependency of the Nest toolchain. It is not declared in
// apps/api/package.json because nothing in the application uses it — only this
// test does, and only to read a file the repository already ships.
// =============================================================================

const SCHEMA_PATH = resolve(__dirname, '../../../../../docs/specs/transcript-export.v1.schema.json');

function validator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });

  addFormats(ajv);

  return ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object);
}

function exporter(): JsonTranscriptExporter {
  const instance = new JsonTranscriptExporter(new TranscriptExporterRegistry());

  instance.onModuleInit();

  return instance;
}

describe('JsonTranscriptExporter', () => {
  it('declares itself to the registry', () => {
    const registry = new TranscriptExporterRegistry();

    new JsonTranscriptExporter(registry).onModuleInit();

    expect(registry.get('json')?.extension).toBe('json');
    expect(registry.get('json')?.mimeType).toBe('application/json');
  });

  it('validates against the PUBLISHED schema, words included', async () => {
    const validate = validator();
    const output = await renderToString(exporter(), fixtureDocument(), { includeWords: true });
    const parsed = JSON.parse(output) as unknown;

    expect(validate(parsed)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('validates against the published schema with words omitted', async () => {
    const validate = validator();
    const parsed = JSON.parse(await renderToString(exporter(), fixtureDocument())) as unknown;

    expect(validate(parsed)).toBe(true);
  });

  it('validates for a transcript with no author and no provider model', async () => {
    const validate = validator();
    const doc = fixtureDocument({ author: null, language: null, provider: null });
    const parsed = JSON.parse(await renderToString(exporter(), doc)) as unknown;

    expect(validate(parsed)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('carries the literal schema identifier a consumer switches on', async () => {
    const parsed = JSON.parse(await renderToString(exporter(), fixtureDocument())) as {
      schema: string;
    };

    expect(parsed.schema).toBe('kvox.transcript/v1');
    expect(KVOX_TRANSCRIPT_SCHEMA_ID).toBe('kvox.transcript/v1');
  });

  it('omits words entirely by default — they are the largest thing in the schema', async () => {
    const parsed = JSON.parse(await renderToString(exporter(), fixtureDocument())) as {
      transcript: { segments: Array<Record<string, unknown>> };
    };

    for (const segment of parsed.transcript.segments) {
      expect(segment).not.toHaveProperty('words');
    }
  });

  it('publishes only the schema\'s speaker fields, never colorIndex or label', async () => {
    const parsed = JSON.parse(await renderToString(exporter(), fixtureDocument())) as {
      transcript: { speakers: Array<Record<string, unknown>> };
    };

    expect(Object.keys(parsed.transcript.speakers[0]).sort()).toEqual([
      'displayName',
      'id',
      'talkTimeMs',
    ]);
  });

  it('publishes only the schema\'s segment fields, never ordinal, rev or origin', async () => {
    const parsed = JSON.parse(await renderToString(exporter(), fixtureDocument())) as {
      transcript: { segments: Array<Record<string, unknown>> };
    };

    expect(Object.keys(parsed.transcript.segments[0]).sort()).toEqual([
      'confidence',
      'endMs',
      'id',
      'speakerId',
      'startMs',
      'text',
      'wordsAlignment',
    ]);
  });

  it('rounds fractional word timings, which the schema requires to be integers', async () => {
    const validate = validator();
    const doc = buildExportDocument({
      transcriptId: 't',
      title: 'Interpolated',
      language: 'en',
      durationMs: 1_000,
      version: 2,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      exportedAt: new Date('2026-01-02T00:00:00.000Z'),
      author: null,
      provider: null,
      state: {
        speakers: [fixtureSpeaker('a', 'A', 0)],
        segments: [
          {
            ...fixtureSegment('s1', 'a', 'one two three', 0, 1_000, ORDINAL_GAP),
            // What an interpolated re-alignment across an edit produces (§3.5).
            words: [
              { t: 'one', s: 0, e: 333.3333, c: 0.5 },
              { t: 'two', s: 333.3333, e: 666.6667, c: null },
              { t: 'three', s: 666.6667, e: 1_000, c: 1.4 },
            ],
            wordsAlignment: 'interpolated' as const,
          },
        ],
      },
    });

    const parsed = JSON.parse(await renderToString(exporter(), doc, { includeWords: true })) as {
      transcript: { segments: Array<{ words: Array<{ endMs: number; confidence: number | null }> }> };
    };

    expect(validate(parsed)).toBe(true);
    expect(parsed.transcript.segments[0].words[0].endMs).toBe(333);
    // Confidence is clamped to the schema's 0..1, not published as 1.4.
    expect(parsed.transcript.segments[0].words[2].confidence).toBe(1);
    expect(parsed.transcript.segments[0].words[1].confidence).toBeNull();
  });

  it('produces valid JSON for a transcript with no segments at all', async () => {
    const validate = validator();
    const doc = fixtureDocument({ segments: [] });
    const output = await renderToString(exporter(), doc);

    expect(() => JSON.parse(output) as unknown).not.toThrow();
    expect(validate(JSON.parse(output) as unknown)).toBe(true);
  });

  it('reports dates as ISO-8601 instants', async () => {
    const parsed = JSON.parse(await renderToString(exporter(), fixtureDocument())) as {
      transcript: { createdAt: string; exportedAt: string };
    };

    expect(parsed.transcript.createdAt).toBe('2026-09-10T15:04:22.000Z');
    expect(parsed.transcript.exportedAt).toBe('2026-09-14T12:00:00.000Z');
  });
});
