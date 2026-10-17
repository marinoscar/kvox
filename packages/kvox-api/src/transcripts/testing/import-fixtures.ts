import type { TranscriptDocumentV1 } from '@marinoscar/kvox-contract/transcripts';

import type { KvoxTranscriptsDb } from '../data/transcripts-db.js';

// =============================================================================
// Import fixtures (issue #571)
// =============================================================================
//
// A synthetic `kvox.transcript/v1` document (no real person in it) and the smallest
// in-memory database the import path writes through, for the conformance kit and the
// package's specs.
// =============================================================================

/**
 * A valid `kvox.transcript/v1` document: one named speaker ("Dana Example"), one still on
 * its placeholder ("Speaker B"), three segments, word timings on the first.
 *
 * @param overrides - fields of `transcript` to replace.
 * @returns a fresh document (safe to mutate).
 * @stability experimental
 */
export function importFixtureDocument(
  overrides: Partial<TranscriptDocumentV1['transcript']> = {},
): TranscriptDocumentV1 {
  return {
    schema: 'kvox.transcript/v1',
    transcript: {
      id: 'tr_source_1',
      title: 'Planning sync',
      language: 'en',
      durationMs: 9_000,
      version: 3,
      author: null,
      createdAt: '2026-09-10T15:00:00.000Z',
      exportedAt: '2026-09-12T09:00:00.000Z',
      recordedAt: '2026-09-10T14:00:00.000Z',
      provider: { id: 'assemblyai', model: 'best' },
      speakers: [
        { id: 'spk_1', displayName: 'Dana Example', talkTimeMs: 6_000 },
        { id: 'spk_2', displayName: 'Speaker B', talkTimeMs: 3_000 },
      ],
      segments: [
        {
          id: 'seg_1',
          speakerId: 'spk_1',
          startMs: 0,
          endMs: 3_000,
          text: 'Good morning, everyone.',
          confidence: 0.9,
          wordsAlignment: 'exact',
          words: [
            { text: 'Good', startMs: 0, endMs: 500, confidence: 0.9 },
            { text: 'morning,', startMs: 600, endMs: 1_400, confidence: 0.95 },
            { text: 'everyone.', startMs: 1_500, endMs: 3_000, confidence: null },
          ],
        },
        { id: 'seg_2', speakerId: 'spk_2', startMs: 3_000, endMs: 6_000, text: 'Morning. Shall we start?' },
        {
          id: 'seg_3',
          speakerId: 'spk_1',
          startMs: 6_000,
          endMs: 9_500,
          text: 'Yes, the budget first.',
          confidence: null,
          wordsAlignment: 'interpolated',
        },
      ],
      ...overrides,
    },
  };
}

/**
 * What {@link createImportRecordingDb} has recorded.
 *
 * @stability experimental
 */
export interface ImportRecordingDb {
  /** The client to hand the import service. */
  db: KvoxTranscriptsDb;
  /** `transcripts` rows by id, as created and then updated. */
  transcripts: Map<string, Record<string, any>>;
  /** `transcript_speakers` rows, in creation order. */
  speakers: Array<Record<string, any>>;
  /** `transcript_segments` rows, in creation order. */
  segments: Array<Record<string, any>>;
  /** `transcript_versions` rows, in creation order. */
  versions: Array<Record<string, any>>;
}

/**
 * The smallest in-memory database the import path writes through: `transcripts`
 * create and update, `transcript_speakers` create, `transcript_segments` createMany,
 * `transcript_versions` create, the default organization and `$transaction`. Any other
 * call throws, so a new write the import starts making is noticed.
 *
 * @param options - `failOn` makes the named write throw (to exercise the rollback path).
 * @returns the client and what it recorded.
 * @stability experimental
 */
export function createImportRecordingDb(
  options: { failOn?: 'transcript' | 'speaker' | 'segments' | 'version' } = {},
): ImportRecordingDb {
  const transcripts = new Map<string, Record<string, any>>();
  const speakers: Array<Record<string, any>> = [];
  const segments: Array<Record<string, any>> = [];
  const versions: Array<Record<string, any>> = [];
  let sequence = 0;

  const guard = (what: NonNullable<typeof options.failOn>): void => {
    if (options.failOn === what) throw new Error(`import recording db: ${what} write refused`);
  };

  const delegates = {
    organization: {
      findFirst: async () => ({ id: '00000000-0000-4000-8000-0000000000aa' }),
    },
    transcript: {
      create: async ({ data }: { data: Record<string, any> }) => {
        guard('transcript');
        const row = { speakerIdentities: {}, ...data };

        transcripts.set(String(data.id), row);

        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const row = transcripts.get(where.id);

        if (!row) throw new Error(`import recording db: no transcript ${where.id}`);

        Object.assign(row, data);

        return row;
      },
    },
    transcriptSpeaker: {
      create: async ({ data }: { data: Record<string, any> }) => {
        guard('speaker');
        sequence += 1;
        const row = { id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, rev: 1, ...data };

        speakers.push(row);

        return { id: row.id };
      },
    },
    transcriptSegment: {
      createMany: async ({ data }: { data: Array<Record<string, any>> }) => {
        guard('segments');
        segments.push(...data);

        return { count: data.length };
      },
    },
    transcriptVersion: {
      create: async ({ data }: { data: Record<string, any> }) => {
        guard('version');
        versions.push(data);

        return data;
      },
    },
  };

  const db = {
    ...delegates,
    // Not atomic: a refused write leaves what came before it, which is what lets a spec
    // see that the caller compensated rather than trusting a rollback it cannot observe.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(delegates),
  };

  return { db: db as unknown as KvoxTranscriptsDb, transcripts, speakers, segments, versions };
}
