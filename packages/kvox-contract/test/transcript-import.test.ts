import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  TRANSCRIPT_DOCUMENT_V1_SCHEMA,
  transcriptDocumentBodySchema,
  transcriptDocumentSegmentSchema,
  transcriptDocumentSpeakerSchema,
  transcriptDocumentV1Schema,
  transcriptDocumentWordSchema,
} from '../src/transcripts/index.js';

// The Zod twin of the published `kvox.transcript/v1` JSON Schema (issue #571) must agree
// with it: same properties, same required lists, strict at every level. A field the JSON
// Schema gains without the Zod schema (or the reverse) fails here.

const SCHEMA_URL = new URL('../schemas/transcript-export.v1.schema.json', import.meta.url);

interface JsonSchemaNode {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  additionalProperties?: boolean;
  const?: string;
}

const jsonSchema = JSON.parse(readFileSync(SCHEMA_URL, 'utf8')) as JsonSchemaNode & {
  examples: unknown[];
};

const transcriptNode = jsonSchema.properties!.transcript!;
const speakerNode = transcriptNode.properties!.speakers!.items!;
const segmentNode = transcriptNode.properties!.segments!.items!;
const wordNode = segmentNode.properties!.words!.items!;

function example(): Record<string, any> {
  return JSON.parse(JSON.stringify(jsonSchema.examples[0])) as Record<string, any>;
}

function requiredKeys(schema: z.ZodObject): string[] {
  return Object.entries(schema.shape)
    .filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success)
    .map(([key]) => key)
    .sort();
}

const LEVELS: ReadonlyArray<readonly [string, JsonSchemaNode, z.ZodObject]> = [
  ['the document', jsonSchema, transcriptDocumentV1Schema],
  ['transcript', transcriptNode, transcriptDocumentBodySchema],
  ['a speaker', speakerNode, transcriptDocumentSpeakerSchema],
  ['a segment', segmentNode, transcriptDocumentSegmentSchema],
  ['a word', wordNode, transcriptDocumentWordSchema],
];

describe('transcriptDocumentV1Schema against the published JSON Schema', () => {
  it('pins the format identifier the JSON Schema declares', () => {
    expect(jsonSchema.properties!.schema!.const).toBe(TRANSCRIPT_DOCUMENT_V1_SCHEMA);
  });

  it('accepts the JSON Schema\'s own example', () => {
    const parsed = transcriptDocumentV1Schema.safeParse(example());

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it.each(LEVELS)('declares the same properties at %s', (_name, node, schema) => {
    expect(Object.keys(schema.shape).sort()).toEqual(Object.keys(node.properties ?? {}).sort());
  });

  it.each(LEVELS)('requires the same properties at %s', (_name, node, schema) => {
    expect(requiredKeys(schema)).toEqual([...(node.required ?? [])].sort());
  });

  it.each(LEVELS)('is closed at %s, as the JSON Schema is', (_name, node) => {
    expect(node.additionalProperties).toBe(false);
  });

  it('refuses an extra property at every level', () => {
    const places: Array<(doc: Record<string, any>) => void> = [
      (doc) => (doc.extra = 1),
      (doc) => (doc.transcript.extra = 1),
      (doc) => (doc.transcript.author.extra = 1),
      (doc) => (doc.transcript.provider.extra = 1),
      (doc) => (doc.transcript.speakers[0].extra = 1),
      (doc) => (doc.transcript.segments[0].extra = 1),
      (doc) => (doc.transcript.segments[0].words[0].extra = 1),
    ];

    for (const place of places) {
      const doc = example();

      place(doc);

      expect(transcriptDocumentV1Schema.safeParse(doc).success).toBe(false);
    }
  });

  it('refuses another schema identifier', () => {
    const doc = example();

    doc.schema = 'kvox.transcript/v2';

    expect(transcriptDocumentV1Schema.safeParse(doc).success).toBe(false);
  });

  it('holds the integer, range and enum constraints', () => {
    const mutations: Array<(doc: Record<string, any>) => void> = [
      (doc) => (doc.transcript.durationMs = 1.5),
      (doc) => (doc.transcript.durationMs = -1),
      (doc) => (doc.transcript.version = 0),
      (doc) => (doc.transcript.segments[0].startMs = -5),
      (doc) => (doc.transcript.segments[0].confidence = 1.2),
      (doc) => (doc.transcript.segments[0].wordsAlignment = 'guessed'),
      (doc) => (doc.transcript.segments[0].words[0].endMs = 3.25),
      (doc) => (doc.transcript.createdAt = 'yesterday'),
      (doc) => (doc.transcript.recordedAt = '2026-09-10'),
    ];

    for (const mutate of mutations) {
      const doc = example();

      mutate(doc);

      expect(transcriptDocumentV1Schema.safeParse(doc).success).toBe(false);
    }
  });

  it('accepts a minimal document: no author, provider, recordedAt, words or alignment', () => {
    const doc = example();

    delete doc.transcript.author;
    delete doc.transcript.provider;
    delete doc.transcript.recordedAt;
    delete doc.transcript.segments[0].words;
    delete doc.transcript.segments[0].wordsAlignment;
    delete doc.transcript.segments[0].confidence;
    delete doc.transcript.speakers[0].talkTimeMs;
    doc.transcript.language = null;

    expect(transcriptDocumentV1Schema.safeParse(doc).success).toBe(true);
  });
});
