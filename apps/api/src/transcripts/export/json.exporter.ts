// =============================================================================
// `kvox.transcript/v1` — the public JSON export (issue #28, epic #19, §8.2)
// =============================================================================
//
// THIS FILE IMPLEMENTS A PUBLISHED CONTRACT, not "whatever the JSON exporter
// currently emits". The contract is
// `docs/specs/transcript-export.v1.schema.json` (JSON Schema draft 2020-12),
// it ships in the repository beside the spec so that automation and other AI
// systems can validate against it without reading this source, and
// `json.exporter.spec.ts` validates real output against that exact file.
//
// ⚠ THE SCHEMA IS `additionalProperties: false` AT EVERY LEVEL. That is the
// single most important thing to know before editing this file: adding a field
// to the output — `ordinal`, `rev`, `origin`, `colorIndex`, all of which the
// document carries and all of which are tempting — makes previously-valid
// output INVALID against the published schema. A field is added by publishing
// a new schema version first, never by emitting it and updating the schema
// afterwards.
//
// The permanence rule from §8.2, restated where somebody editing would see it:
// a field is added, never removed or repurposed. A breaking change is
// `kvox.transcript/v2` with its own `$id` and its own exporter class, coexisting
// with this one for as long as anything depends on the old shape — exactly the
// "rows outlive the handler that produced them" posture the job queue takes for
// a `type` string.
//
// -----------------------------------------------------------------------------
// THE INTEGER COERCIONS ARE REQUIRED BY THE SCHEMA, NOT DEFENSIVE TIDYING
// -----------------------------------------------------------------------------
//
// `startMs`/`endMs` on a WORD are `type: integer` in the published schema, and
// a provider's word timings arrive as floats often enough that this is the
// ordinary case rather than an edge one — AssemblyAI reports milliseconds as
// integers, but nothing in `NormalizedTranscript` requires it and an
// interpolated re-alignment across an edit (§3.5) produces fractions by
// arithmetic. `Math.round` here is what keeps this exporter's own published
// contract true; dropping it produces output that validates on most
// transcripts and fails on the ones somebody edited.
//
// `confidence` is clamped to 0..1 for the same reason and no other.
//
// -----------------------------------------------------------------------------
// IT STREAMS, SEGMENT BY SEGMENT
// -----------------------------------------------------------------------------
//
// `JSON.stringify(wholeDocument)` would be four lines shorter and would hold a
// ten-hour transcript's word index — hundreds of megabytes — in one string, and
// then in a second copy as a Buffer. The envelope is written by hand and each
// segment is stringified on its own, so peak memory is one segment. The output
// is still pretty-printed: each segment's own JSON is re-indented as it goes,
// which costs one `split`/`join` per segment and keeps the file readable by the
// human who opens it to see what they got.
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Writable } from 'node:stream';

import type { ExportDocument, ExportSegment } from './export-document';
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

/** The literal every consumer switches on. Never computed, never templated. */
export const KVOX_TRANSCRIPT_SCHEMA_ID = 'kvox.transcript/v1';

/**
 * ONE OPTION, and it is off by default.
 *
 * Word timings are the single largest thing in this schema (§3.3) — a ten-hour
 * transcript's are hundreds of megabytes — and the overwhelming majority of
 * "give me the JSON" requests want the text for another system to read. Somebody
 * who needs per-word timings knows they need them; nobody who does not need them
 * wants to download them by accident.
 */
export const JSON_EXPORT_OPTIONS: readonly ExportOptionField[] = [
  {
    key: 'includeWords',
    label: 'Include word timings',
    description:
      'Adds per-word start, end and confidence to every segment. Much larger, and only ' +
      'useful to something that lines the text up against the audio.',
    type: 'boolean',
    default: false,
  },
];

@Injectable()
export class JsonTranscriptExporter implements TranscriptExporter, OnModuleInit {
  readonly format = 'json';
  readonly label = 'JSON';
  readonly mimeType = 'application/json';
  readonly extension = 'json';
  readonly options = JSON_EXPORT_OPTIONS;
  readonly optionsSchema = optionsSchemaFor(JSON_EXPORT_OPTIONS);

  constructor(private readonly registry: TranscriptExporterRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async render(doc: ExportDocument, options: ExportOptions, out: Writable): Promise<void> {
    const includeWords = options.includeWords === true;

    await writeChunk(out, '{\n  "schema": ' + JSON.stringify(KVOX_TRANSCRIPT_SCHEMA_ID) + ',\n');
    await writeChunk(out, '  "transcript": {\n');

    // The scalar head. Written as one chunk because it is bounded and small,
    // unlike the two arrays below.
    const head: Array<[string, unknown]> = [
      ['id', doc.transcriptId],
      ['title', doc.title],
      ['language', doc.language],
      ['durationMs', Math.max(0, Math.round(doc.durationMs))],
      ['version', doc.version],
      ['author', doc.author],
      ['createdAt', doc.createdAt.toISOString()],
      ['exportedAt', doc.exportedAt.toISOString()],
      ['provider', doc.provider],
    ];

    for (const [key, value] of head) {
      await writeChunk(out, `    ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`);
    }

    // ⚠ ONLY `id`, `displayName` AND `talkTimeMs`. `colorIndex` and `label` are
    // on the document and are NOT in the published schema — see the header.
    const speakers = doc.speakers.map((speaker) => ({
      id: speaker.id,
      displayName: speaker.displayName,
      talkTimeMs: Math.max(0, Math.round(speaker.talkTimeMs)),
    }));

    await writeChunk(out, `    "speakers": ${indent(JSON.stringify(speakers, null, 2), 4)},\n`);
    await writeChunk(out, '    "segments": [');

    let first = true;

    for (const segment of doc.segments) {
      await writeChunk(out, first ? '\n' : ',\n');
      first = false;
      await writeChunk(
        out,
        `      ${indent(JSON.stringify(publicSegment(segment, includeWords), null, 2), 6)}`,
      );
    }

    await writeChunk(out, first ? ']\n' : '\n    ]\n');
    await writeChunk(out, '  }\n}\n');

    await endStream(out);
  }
}

/**
 * One segment, reduced to exactly the published schema's properties.
 *
 * Built as an explicit object literal rather than by deleting keys from the
 * document's segment: an allow-list cannot be widened by a future field being
 * added to `ExportSegment`, whereas a deny-list silently can.
 */
export function publicSegment(
  segment: ExportSegment,
  includeWords: boolean,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: segment.id,
    speakerId: segment.speakerId,
    startMs: nonNegativeInteger(segment.startMs),
    endMs: nonNegativeInteger(segment.endMs),
    text: segment.text,
    confidence: clampConfidence(segment.confidence),
    wordsAlignment: segment.wordsAlignment,
  };

  if (includeWords) {
    row.words = segment.words.map((word) => ({
      text: word.text,
      startMs: nonNegativeInteger(word.startMs),
      endMs: nonNegativeInteger(word.endMs),
      confidence: clampConfidence(word.confidence),
    }));
  }

  return row;
}

/** `minimum: 0`, `type: integer` — the schema's shape for every offset. */
function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** `minimum: 0, maximum: 1` or null, as the schema declares confidence. */
function clampConfidence(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;

  return Math.min(1, Math.max(0, value));
}

/** Re-indent an already pretty-printed JSON value to sit at `spaces`. */
function indent(json: string, spaces: number): string {
  return json.split('\n').join('\n' + ' '.repeat(spaces));
}
